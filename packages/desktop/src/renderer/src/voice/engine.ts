import {
  AudioPresets,
  LocalAudioTrack,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteAudioTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client';
import type { ChannelGrant, VoiceGrants } from '@wardogs/shared';
import type { NetId } from '../../../common/ipc.js';
import type { Settings, TransmitMode } from '../../../common/settings.js';
import { shouldDuck, topSpeakingRank } from './priority.js';

/**
 * The voice engine.
 *
 * A squad leader is on two nets at once, so the client holds two independent
 * LiveKit connections - one for their squad, one for command. Both publish a
 * clone of the same microphone capture, which is what makes it possible to key
 * one net without the other hearing a word.
 *
 * Transmit is exclusive by design: you can only say one thing at a time, so a
 * held command key takes the squad net off the air for its duration. That also
 * sidesteps the only case where a listener on both nets could hear one speaker
 * twice.
 */

export type NetConnection = 'idle' | 'connecting' | 'live' | 'failed';

export interface SpeakingEntry {
  id: string;
  name: string;
  net: NetId;
}

export interface EngineEvents {
  onNetState(net: NetId, state: NetConnection): void;
  onSpeaking(entries: SpeakingEntry[]): void;
  onTransmit(net: NetId | null): void;
  onError(message: string): void;
  /** Raised when the microphone itself cannot be opened. */
  onMicError(message: string): void;
}

interface NetHandle {
  room: Room;
  grantToken: string;
  track: LocalAudioTrack | null;
  speaking: SpeakingEntry[];
}

const NETS: NetId[] = ['squad', 'command', 'allcall'];

const NET_LABELS: Record<NetId, string> = {
  squad: 'squad',
  command: 'velitelský',
  allcall: 'all-call',
};

export class VoiceEngine {
  private readonly nets = new Map<NetId, NetHandle>();
  /** The single real capture; each net publishes an independent clone of it. */
  private source: MediaStreamTrack | null = null;
  private sourceKey = '';

  /** Remote playback elements, keyed `net:trackSid`. */
  private readonly players = new Map<string, HTMLAudioElement>();

  private settings: Settings;
  private held: Record<NetId, boolean> = { squad: false, command: false, allcall: false };
  private micMuted = false;
  private deafened = false;
  private transmitting: NetId | null = null;
  private disposed = false;

  /**
   * Rank per participant, for priority ducking: platoon leader 2, squad leader
   * 1, everyone else 0. Fed from the roster, because LiveKit only knows
   * identities - it has no idea who is in charge.
   */
  private ranks = new Map<string, number>();
  private selfId = '';
  /** In-flight volume ramps, so a new one can cancel the old. */
  private readonly ramps = new Map<HTMLAudioElement, ReturnType<typeof setInterval>>();

  constructor(
    settings: Settings,
    private readonly events: EngineEvents,
  ) {
    this.settings = settings;
  }

  // --- connection ---------------------------------------------------------

  /**
   * Reconcile live connections against the grants the server last issued.
   * Re-issued tokens for the same net reconnect; a withdrawn grant (demoted
   * from squad leader, say) drops that net immediately.
   */
  async applyGrants(grants: VoiceGrants): Promise<void> {
    if (this.disposed) return;
    await Promise.all(NETS.map((net) => this.reconcileNet(net, grants[net])));
    await this.applyTransmitState();
  }

  private async reconcileNet(net: NetId, grant: ChannelGrant | null): Promise<void> {
    const current = this.nets.get(net);

    if (!grant) {
      if (current) await this.closeNet(net);
      return;
    }
    if (current && current.grantToken === grant.token) return;
    if (current) await this.closeNet(net);

    this.events.onNetState(net, 'connecting');

    const room = new Room({
      // Voice only: no simulcast machinery, no adaptive video plumbing.
      adaptiveStream: false,
      dynacast: false,
      disconnectOnPageLeave: true,
      stopLocalTrackOnUnpublish: false,
    });
    const handle: NetHandle = { room, grantToken: grant.token, track: null, speaking: [] };
    this.nets.set(net, handle);
    this.bindRoomEvents(net, room);

    try {
      await room.connect(grant.url, grant.token, { autoSubscribe: true });
      if (this.disposed || this.nets.get(net) !== handle) {
        await room.disconnect();
        return;
      }
      if (grant.canPublish) await this.publishTo(net, handle);
      this.events.onNetState(net, 'live');
    } catch (err) {
      this.nets.delete(net);
      this.events.onNetState(net, 'failed');
      this.events.onError(
        `Nepodařilo se připojit na ${NET_LABELS[net]} kanál: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async closeNet(net: NetId): Promise<void> {
    const handle = this.nets.get(net);
    if (!handle) return;
    this.nets.delete(net);

    for (const [key, el] of this.players) {
      if (key.startsWith(`${net}:`)) {
        this.stopRamp(el);
        el.pause();
        el.srcObject = null;
        el.remove();
        this.players.delete(key);
      }
    }

    handle.track?.stop();
    handle.track = null;
    try {
      await handle.room.disconnect();
    } catch {
      // Already gone.
    }
    this.events.onNetState(net, 'idle');
    this.emitSpeaking();
  }

  private bindRoomEvents(net: NetId, room: Room): void {
    room
      .on(
        RoomEvent.TrackSubscribed,
        (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
          if (track.kind !== Track.Kind.Audio) return;
          this.attachRemote(net, track as RemoteAudioTrack, pub.trackSid, participant);
        },
      )
      .on(RoomEvent.TrackUnsubscribed, (_track: RemoteTrack, pub: RemoteTrackPublication) => {
        const key = `${net}:${pub.trackSid}`;
        const el = this.players.get(key);
        if (el) {
          this.stopRamp(el);
          el.pause();
          el.srcObject = null;
          el.remove();
          this.players.delete(key);
        }
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        const handle = this.nets.get(net);
        if (!handle) return;
        handle.speaking = speakers
          // Our own transmissions are shown from local state, not echoed back.
          .filter((p) => p.identity !== room.localParticipant.identity)
          .map((p) => ({ id: p.identity, name: p.name || p.identity, net }));
        this.emitSpeaking();
        // Who is talking decides who gets ducked.
        this.applyGain();
      })
      .on(RoomEvent.Disconnected, () => {
        if (this.nets.get(net)?.room === room) this.events.onNetState(net, 'failed');
      })
      .on(RoomEvent.Reconnecting, () => this.events.onNetState(net, 'connecting'))
      .on(RoomEvent.Reconnected, () => this.events.onNetState(net, 'live'));
  }

  private attachRemote(
    net: NetId,
    track: RemoteAudioTrack,
    trackSid: string,
    participant: RemoteParticipant,
  ): void {
    const el = track.attach() as HTMLAudioElement;
    el.dataset['participant'] = participant.identity;
    el.autoplay = true;
    // Start at the level the current situation calls for; applyGain() below
    // corrects it once the element is registered.
    el.volume = this.deafened ? 0 : this.settings.audio.outputVolume;
    // Keeping the element in the DOM is what keeps playback alive in Chromium.
    el.style.display = 'none';
    document.body.appendChild(el);
    this.players.set(`${net}:${trackSid}`, el);
    this.applyGain();

    void this.routeToOutput(el);
    el.play().catch(() => {
      // Autoplay can be blocked until the window has seen a gesture; the UI
      // calls resumePlayback() on the first click.
    });
  }

  private async routeToOutput(el: HTMLAudioElement): Promise<void> {
    const deviceId = this.settings.audio.outputDeviceId;
    if (!deviceId || deviceId === 'default') return;
    const sinkable = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    try {
      await sinkable.setSinkId?.(deviceId);
    } catch {
      // Device vanished; stay on the system default rather than going silent.
    }
  }

  /** Chromium may hold playback until the page has seen a user gesture. */
  async resumePlayback(): Promise<void> {
    for (const el of this.players.values()) {
      if (el.paused) await el.play().catch(() => undefined);
    }
    for (const handle of this.nets.values()) {
      if (!handle.room.canPlaybackAudio) await handle.room.startAudio().catch(() => undefined);
    }
  }

  // --- microphone ---------------------------------------------------------

  /**
   * Opens the microphone once and publishes a clone to each live net. Clones
   * share the capture but carry their own enabled flag, which is what lets the
   * two nets be keyed independently.
   */
  private async ensureSource(): Promise<MediaStreamTrack | null> {
    const { audio } = this.settings;
    const key = [
      audio.inputDeviceId,
      audio.noiseSuppression,
      audio.echoCancellation,
      audio.autoGainControl,
    ].join('|');

    if (this.source && this.source.readyState === 'live' && this.sourceKey === key) {
      return this.source;
    }

    this.source?.stop();
    this.source = null;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: audio.inputDeviceId === 'default' ? undefined : { exact: audio.inputDeviceId },
          noiseSuppression: audio.noiseSuppression,
          echoCancellation: audio.echoCancellation,
          autoGainControl: audio.autoGainControl,
          channelCount: 1,
        },
        video: false,
      });
      this.source = stream.getAudioTracks()[0] ?? null;
      this.sourceKey = key;
      if (!this.source) throw new Error('Zařízení nevrátilo žádnou audio stopu');
      return this.source;
    } catch (err) {
      this.events.onMicError(
        `Mikrofon se nepodařilo otevřít: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async publishTo(net: NetId, handle: NetHandle): Promise<void> {
    const source = await this.ensureSource();
    if (!source) return;

    const clone = source.clone();
    // Start silent: nothing goes out until a PTT key is held or open mic is on.
    clone.enabled = false;

    const track = new LocalAudioTrack(clone, undefined, /* userProvidedTrack */ true);
    await track.mute();
    await handle.room.localParticipant.publishTrack(track, {
      source: Track.Source.Microphone,
      audioPreset: AudioPresets.speech,
      dtx: true,
      red: true,
    });
    handle.track = track;
  }

  /** Re-open the capture after a device or processing change. */
  async refreshCapture(): Promise<void> {
    this.source?.stop();
    this.source = null;
    this.sourceKey = '';

    for (const [net, handle] of this.nets) {
      if (handle.track) {
        try {
          await handle.room.localParticipant.unpublishTrack(handle.track, true);
        } catch {
          // Room may already be gone.
        }
        handle.track = null;
      }
      await this.publishTo(net, handle);
    }
    await this.applyTransmitState();
  }

  // --- transmit gating ----------------------------------------------------

  setSettings(settings: Settings): void {
    const previous = this.settings;
    this.settings = settings;

    if (
      previous.audio.outputVolume !== settings.audio.outputVolume ||
      previous.audio.duckOnCommand !== settings.audio.duckOnCommand ||
      previous.audio.duckLevel !== settings.audio.duckLevel ||
      previous.audio.playerVolumes !== settings.audio.playerVolumes
    ) {
      this.applyGain();
    }
    if (previous.audio.outputDeviceId !== settings.audio.outputDeviceId) {
      for (const el of this.players.values()) void this.routeToOutput(el);
    }
    const captureChanged =
      previous.audio.inputDeviceId !== settings.audio.inputDeviceId ||
      previous.audio.noiseSuppression !== settings.audio.noiseSuppression ||
      previous.audio.echoCancellation !== settings.audio.echoCancellation ||
      previous.audio.autoGainControl !== settings.audio.autoGainControl;
    if (captureChanged) void this.refreshCapture();

    if (
      previous.transmit.squad !== settings.transmit.squad ||
      previous.transmit.command !== settings.transmit.command
    ) {
      void this.applyTransmitState();
    }
  }

  setHeld(net: NetId, held: boolean): void {
    if (this.held[net] === held) return;
    this.held[net] = held;
    void this.applyTransmitState();
  }

  setMicMuted(muted: boolean): void {
    this.micMuted = muted;
    void this.applyTransmitState();
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    this.applyGain();
    void this.applyTransmitState();
  }

  /**
   * Tell the engine who outranks whom. Called whenever the roster changes.
   */
  setRoster(selfId: string, ranks: Map<string, number>): void {
    this.selfId = selfId;
    this.ranks = ranks;
    this.applyGain();
  }

  /** Everyone audible right now, plus yourself if you are the one talking. */
  private currentSpeakers(): Set<string> {
    const speaking = new Set<string>();
    for (const handle of this.nets.values()) {
      for (const entry of handle.speaking) speaking.add(entry.id);
    }
    // Your own transmission is never played back to you, but it still outranks
    // the people you are talking over.
    if (this.transmitting && this.selfId) speaking.add(this.selfId);
    return speaking;
  }

  /**
   * Set playback levels, applying priority ducking.
   *
   * While anyone senior is on the air, everyone below them drops to the duck
   * level - across nets, so a squad leader hearing an order on command stops
   * losing it under their own squad's chatter. Equal ranks do not duck each
   * other, so two squad leaders can still talk on command normally.
   */
  private applyGain(): void {
    const base = this.deafened ? 0 : this.settings.audio.outputVolume;
    const { duckOnCommand, duckLevel } = this.settings.audio;

    const topRank =
      duckOnCommand && base > 0 ? topSpeakingRank(this.currentSpeakers(), this.ranks) : 0;

    for (const el of this.players.values()) {
      const identity = el.dataset['participant'] ?? '';
      const rank = this.ranks.get(identity) ?? 0;
      const level = shouldDuck(rank, topRank) ? base * duckLevel : base;
      // Per-player trim, set locally by whoever is listening.
      this.rampTo(el, level * (this.settings.audio.playerVolumes[identity] ?? 1));
    }
  }

  /**
   * Slide the volume rather than stepping it. A hard jump mid-syllable clicks,
   * and ducking fires exactly when someone is already mid-sentence.
   */
  private rampTo(el: HTMLAudioElement, target: number): void {
    const clamped = Math.min(1, Math.max(0, target));
    const existing = this.ramps.get(el);
    if (existing) {
      clearInterval(existing);
      this.ramps.delete(el);
    }
    if (Math.abs(el.volume - clamped) < 0.01) {
      el.volume = clamped;
      return;
    }

    const steps = 6;
    const delta = (clamped - el.volume) / steps;
    let step = 0;
    const timer = setInterval(() => {
      step += 1;
      el.volume = Math.min(1, Math.max(0, step >= steps ? clamped : el.volume + delta));
      if (step >= steps) {
        clearInterval(timer);
        this.ramps.delete(el);
      }
    }, 20);
    this.ramps.set(el, timer);
  }

  /**
   * Decide which single net is on the air, then bring the tracks in line.
   *
   * Priority: a held command key beats a held squad key, and either beats an
   * open mic. Mute and deafen close everything.
   */
  private async applyTransmitState(): Promise<void> {
    // The all-call has no mode of its own - it is push-to-talk, always.
    const mode: Pick<Record<NetId, TransmitMode>, 'squad' | 'command'> = {
      squad: this.settings.transmit.squad,
      command: this.settings.transmit.command,
    };

    let live: NetId | null = null;
    if (!this.micMuted && !this.deafened) {
      // The all-call is always push-to-talk: an open mic reaching forty people
      // is not something anyone should be able to leave switched on.
      const commandHeld = this.held.command && mode.command === 'ptt';
      const squadHeld = this.held.squad && mode.squad === 'ptt';

      if (this.held.allcall) live = 'allcall';
      else if (commandHeld) live = 'command';
      else if (squadHeld) live = 'squad';
      else if (mode.command === 'open' && this.nets.has('command')) live = 'command';
      else if (mode.squad === 'open') live = 'squad';
    }
    // Holding a key for a net you may only listen on must not read as "on air".
    if (live && !this.nets.get(live)?.track) live = null;

    await Promise.all(
      NETS.map(async (net) => {
        const handle = this.nets.get(net);
        if (!handle?.track) return;
        const shouldSend = live === net;
        if (handle.track.isMuted === !shouldSend) return;
        try {
          if (shouldSend) await handle.track.unmute();
          else await handle.track.mute();
        } catch {
          // Track torn down underneath us; the next reconcile will fix it.
        }
      }),
    );

    if (this.transmitting !== live) {
      this.transmitting = live;
      this.applyGain();
      this.events.onTransmit(live);
    }
  }

  private stopRamp(el: HTMLAudioElement): void {
    const timer = this.ramps.get(el);
    if (timer) {
      clearInterval(timer);
      this.ramps.delete(el);
    }
  }

  private emitSpeaking(): void {
    const merged: SpeakingEntry[] = [];
    for (const handle of this.nets.values()) merged.push(...handle.speaking);
    this.events.onSpeaking(merged);
  }

  // --- teardown -----------------------------------------------------------

  async destroy(): Promise<void> {
    this.disposed = true;
    for (const timer of this.ramps.values()) clearInterval(timer);
    this.ramps.clear();
    await Promise.all(NETS.map((net) => this.closeNet(net)));
    this.source?.stop();
    this.source = null;
  }
}
