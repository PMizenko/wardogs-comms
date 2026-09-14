import { create } from 'zustand';
import {
  ALLCALL_CHANNEL,
  COMMAND_CHANNEL,
  DEFAULT_SQUADS,
  type ChannelId,
  type PlatoonState,
  type PlatoonSummary,
  type PlayerState,
  type ServerMessage,
  type SquadId,
  type UserIdentity,
  type VoiceGrants,
} from '@wardogs/shared';
import type { Binding, HotkeyAction, Settings } from '../../../common/settings.js';
import { DEFAULT_SETTINGS } from '../../../common/settings.js';
import type { NetId, OverlayState, SpeakerBadge } from '../../../common/ipc.js';
import { ControlSocket, type SocketStatus } from '../net/socket.js';
import { VoiceEngine, type NetConnection, type SpeakingEntry } from '../voice/engine.js';
import { playTone, setToneOutput } from '../voice/tones.js';

export type Screen = 'signin' | 'lobby' | 'platoon';

export interface AudioDevices {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
}

interface AppState {
  ready: boolean;
  settings: Settings;
  hotkeysAvailable: boolean;

  user: UserIdentity | null;
  status: SocketStatus;

  platoon: PlatoonState | null;
  grants: VoiceGrants;

  netState: Record<NetId, NetConnection>;
  speaking: SpeakingEntry[];
  transmitting: NetId | null;
  /** playerId -> net they are currently keyed into, relayed by the server. */
  remoteTransmit: Record<string, ChannelId>;

  micMuted: boolean;
  deafened: boolean;

  devices: AudioDevices;
  /** Public platoon browser, refreshed on demand from the lobby. */
  browser: PlatoonSummary[];
  browserLoading: boolean;
  notice: { kind: 'error' | 'info'; text: string } | null;
  settingsOpen: boolean;
  busy: boolean;

  // actions
  boot(): Promise<void>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  createPlatoon(name: string, options?: { password?: string; listed?: boolean }): void;
  joinPlatoon(code: string, password?: string): void;
  joinPlatoonById(platoonId: string, password?: string): void;
  refreshBrowser(): void;
  leavePlatoon(): void;
  joinSquad(squadId: SquadId, asLeader: boolean): void;
  leaveSquad(): void;
  claimLeader(squadId: SquadId): void;
  releaseLeader(): void;
  movePlayer(playerId: string, squadId: SquadId | null): void;
  promotePlayer(playerId: string): void;
  kickPlayer(playerId: string): void;
  renameSquad(squadId: SquadId, role: string): void;
  recolourSquad(squadId: SquadId, color: string): void;
  addSquad(): void;
  removeSquad(squadId: SquadId): void;
  setSquadSize(size: number): void;
  setPlatoonPassword(password: string): void;
  setPlatoonListed(listed: boolean): void;
  /** Local playback trim for one teammate, 0..1. */
  setPlayerVolume(playerId: string, volume: number): Promise<void>;
  /** Flip the squad net between push-to-talk and open mic. */
  toggleSquadPtt(): Promise<void>;
  toggleMute(): void;
  toggleDeafen(): void;
  patchSettings(patch: Parameters<Window['wardogs']['updateSettings']>[0]): Promise<void>;
  /** Point the app at a different control server; drops the current session. */
  setServerUrl(url: string): Promise<void>;
  bindHotkey(action: HotkeyAction): Promise<void>;
  clearHotkey(action: HotkeyAction): Promise<void>;
  refreshDevices(): Promise<void>;
  openSettings(open: boolean): void;
  dismissNotice(): void;
}

let socket: ControlSocket | null = null;
let engine: VoiceEngine | null = null;

/** The player's own row in the roster, or null when not in a platoon. */
export function selectMe(state: AppState): PlayerState | null {
  if (!state.user || !state.platoon) return null;
  return state.platoon.players.find((p) => p.id === state.user!.id) ?? null;
}

/**
 * Whether voice actually works right now.
 *
 * The control socket being up says nothing about the media path: LiveKit can be
 * unreachable while the roster updates perfectly. That combination is the worst
 * possible failure, because the app looks connected and you are inaudible, so
 * it gets surfaced loudly rather than inferred from a quiet icon.
 */
export type VoiceHealth = 'idle' | 'connecting' | 'ok' | 'down';

export function selectVoiceHealth(state: AppState): VoiceHealth {
  const nets: NetId[] = [];
  if (state.grants.squad) nets.push('squad');
  if (state.grants.command) nets.push('command');
  if (state.grants.allcall) nets.push('allcall');
  if (nets.length === 0) return 'idle';

  const states = nets.map((net) => state.netState[net]);
  if (states.every((s) => s === 'live')) return 'ok';
  if (states.some((s) => s === 'connecting')) return 'connecting';
  return 'down';
}

export function selectScreen(state: AppState): Screen {
  if (!state.settings.sessionToken || state.status === 'unauthorised') return 'signin';
  return state.platoon ? 'platoon' : 'lobby';
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  settings: DEFAULT_SETTINGS,
  hotkeysAvailable: false,

  user: null,
  status: 'offline',

  platoon: null,
  grants: { squad: null, command: null, allcall: null },

  netState: { squad: 'idle', command: 'idle', allcall: 'idle' },
  speaking: [],
  transmitting: null,
  remoteTransmit: {},

  micMuted: false,
  deafened: false,

  devices: { inputs: [], outputs: [] },
  browser: [],
  browserLoading: false,
  notice: null,
  settingsOpen: false,
  busy: false,

  // --- boot ---------------------------------------------------------------

  async boot() {
    const bridge = window.wardogs;
    const settings = await bridge.getSettings();
    const info = await bridge.appInfo();

    engine = new VoiceEngine(settings, {
      onNetState: (net, state) =>
        set((s) => ({ netState: { ...s.netState, [net]: state } })),
      onSpeaking: (speaking) => set({ speaking }),
      onTransmit: (net) => {
        const previous = get().transmitting;
        set({ transmitting: net });
        if (get().settings.audio.keyTones && net !== previous) {
          playTone(net ? 'open' : 'close');
        }
        announceTransmit(net);
      },
      onError: (text) => set({ notice: { kind: 'error', text } }),
      onMicError: (text) => set({ notice: { kind: 'error', text } }),
    });

    socket = new ControlSocket({
      onStatus: (status) => {
        set({ status });
        if (status === 'unauthorised') {
          set({ platoon: null, grants: { squad: null, command: null, allcall: null } });
          void bridge.signOut();
        }
      },
      onMessage: (message) => handleServerMessage(message, set, get),
    });

    set({ settings, hotkeysAvailable: info.hotkeysAvailable, ready: true });
    setToneOutput(settings.audio.outputDeviceId, settings.audio.outputVolume);

    bridge.onSettingsChanged((next) => {
      set({ settings: next });
      engine?.setSettings(next);
      setToneOutput(next.audio.outputDeviceId, next.audio.outputVolume);
    });

    bridge.onSessionToken((token) => {
      set({ settings: { ...get().settings, sessionToken: token }, status: 'connecting' });
      socket?.connect(get().settings.serverUrl, token);
    });

    bridge.onHotkey(({ action, pressed }) => {
      if (action === 'squad' || action === 'command' || action === 'allcall') {
        engine?.setHeld(action, pressed);
        return;
      }
      if (!pressed) return;
      if (action === 'muteToggle') get().toggleMute();
      if (action === 'deafenToggle') get().toggleDeafen();
    });

    if (settings.sessionToken) socket.connect(settings.serverUrl, settings.sessionToken);
    void get().refreshDevices();
    navigator.mediaDevices?.addEventListener('devicechange', () => void get().refreshDevices());
  },

  // --- identity -----------------------------------------------------------

  async signIn() {
    set({ busy: true, notice: null });
    try {
      await window.wardogs.startSignIn();
    } finally {
      set({ busy: false });
    }
  },

  async signOut() {
    socket?.disconnect();
    await engine?.applyGrants({ squad: null, command: null, allcall: null });
    await window.wardogs.signOut();
    set({
      user: null,
      platoon: null,
      grants: { squad: null, command: null, allcall: null },
      status: 'offline',
      settings: { ...get().settings, sessionToken: null },
    });
  },

  // --- platoon ------------------------------------------------------------

  createPlatoon(name, options = {}) {
    socket?.send({
      t: 'platoon:create',
      name,
      password: options.password ?? '',
      listed: options.listed !== false,
    });
  },
  joinPlatoon(code, password) {
    socket?.send({ t: 'platoon:join', code: code.trim().toUpperCase(), password: password ?? '' });
  },
  joinPlatoonById(platoonId, password) {
    socket?.send({ t: 'platoon:join', platoonId, password: password ?? '' });
  },
  refreshBrowser() {
    set({ browserLoading: true });
    socket?.send({ t: 'platoon:list' });
    // The answer clears the flag; this only stops it spinning forever if the
    // socket is down.
    setTimeout(() => set({ browserLoading: false }), 4000);
  },
  leavePlatoon() {
    socket?.send({ t: 'platoon:leave' });
  },
  joinSquad(squadId, asLeader) {
    socket?.send({ t: 'squad:join', squadId, asLeader });
  },
  leaveSquad() {
    socket?.send({ t: 'squad:leave' });
  },
  claimLeader(squadId) {
    socket?.send({ t: 'leader:claim', squadId });
  },
  releaseLeader() {
    socket?.send({ t: 'leader:release' });
  },
  movePlayer(playerId, squadId) {
    socket?.send({ t: 'admin:move', playerId, squadId });
  },
  promotePlayer(playerId) {
    socket?.send({ t: 'admin:promote', playerId });
  },
  kickPlayer(playerId) {
    socket?.send({ t: 'admin:kick', playerId });
  },
  renameSquad(squadId, role) {
    socket?.send({ t: 'admin:rename-squad', squadId, role });
  },
  recolourSquad(squadId, color) {
    socket?.send({ t: 'admin:rename-squad', squadId, color });
  },
  addSquad() {
    socket?.send({ t: 'admin:squad-add' });
  },
  removeSquad(squadId) {
    socket?.send({ t: 'admin:squad-remove', squadId });
  },
  setSquadSize(size) {
    socket?.send({ t: 'admin:squad-size', size });
  },
  setPlatoonPassword(password) {
    socket?.send({ t: 'admin:password', password });
  },
  setPlatoonListed(listed) {
    socket?.send({ t: 'admin:listed', listed });
  },

  async setPlayerVolume(playerId, volume) {
    const clamped = Math.min(1, Math.max(0, volume));
    const playerVolumes = { ...get().settings.audio.playerVolumes };
    // Drop entries that are back at the default rather than accumulating them.
    if (Math.abs(clamped - 1) < 0.001) delete playerVolumes[playerId];
    else playerVolumes[playerId] = clamped;
    await get().patchSettings({ audio: { playerVolumes } });
  },

  async toggleSquadPtt() {
    const current = get().settings.transmit.squad;
    await get().patchSettings({
      transmit: {
        squad: current === 'ptt' ? 'open' : 'ptt',
        // Only one net may sit open, or you would be on the air twice.
        command: current === 'ptt' ? 'ptt' : get().settings.transmit.command,
      },
    });
  },

  // --- local audio state --------------------------------------------------

  toggleMute() {
    const micMuted = !get().micMuted;
    set({ micMuted });
    engine?.setMicMuted(micMuted);
    socket?.send({ t: 'state:mic', micMuted, deafened: get().deafened });
  },

  toggleDeafen() {
    const deafened = !get().deafened;
    // Deafening implies muting: if you cannot hear the reply, do not transmit.
    const micMuted = deafened ? true : get().micMuted;
    set({ deafened, micMuted });
    engine?.setDeafened(deafened);
    engine?.setMicMuted(micMuted);
    socket?.send({ t: 'state:mic', micMuted, deafened });
  },

  // --- settings -----------------------------------------------------------

  async patchSettings(patch) {
    const next = await window.wardogs.updateSettings(patch);
    set({ settings: next });
    engine?.setSettings(next);
  },

  async setServerUrl(url) {
    const next = url.trim().replace(/\/$/, '');
    if (!next || next === get().settings.serverUrl) return;
    // A session token is only valid on the server that issued it.
    await get().signOut();
    await get().patchSettings({ serverUrl: next });
  },

  async bindHotkey(action) {
    const binding: Binding | null = await window.wardogs.captureBinding();
    if (!binding) return;
    await get().patchSettings({ hotkeys: { [action]: binding } });
  },

  async clearHotkey(action) {
    // The main process persists this and echoes the new settings back over
    // `settings:changed`, so there is nothing to write here.
    await window.wardogs.clearBinding(action);
  },

  async refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      set({
        devices: {
          inputs: all.filter((d) => d.kind === 'audioinput'),
          outputs: all.filter((d) => d.kind === 'audiooutput'),
        },
      });
    } catch {
      // Device labels stay empty until the mic permission is granted; harmless.
    }
  },

  openSettings(open) {
    set({ settingsOpen: open });
  },
  dismissNotice() {
    set({ notice: null });
  },
}));

// --- server message handling ----------------------------------------------

type Setter = (partial: Partial<AppState>) => void;

function handleServerMessage(
  message: ServerMessage,
  set: Setter,
  get: () => AppState,
): void {
  switch (message.t) {
    case 'hello':
      set({ user: message.user });
      return;

    case 'platoon:state': {
      set({ platoon: message.platoon, grants: message.grants });
      // Ranks drive priority ducking; LiveKit only knows identities.
      engine?.setRoster(get().user?.id ?? '', rankMap(message.platoon));
      void engine?.applyGrants(message.grants);
      return;
    }

    case 'platoon:browser':
      set({ browser: message.platoons, browserLoading: false });
      return;

    case 'platoon:none':
      set({ platoon: null, grants: { squad: null, command: null, allcall: null }, remoteTransmit: {} });
      engine?.setRoster('', new Map());
      void engine?.applyGrants({ squad: null, command: null, allcall: null });
      return;

    case 'player:transmit': {
      const next = { ...get().remoteTransmit };
      if (message.active) next[message.playerId] = message.channel;
      else delete next[message.playerId];
      set({ remoteTransmit: next });
      return;
    }

    case 'kicked':
      set({ notice: { kind: 'info', text: message.reason } });
      return;

    case 'error':
      set({ notice: { kind: 'error', text: translateError(message.code, message.message) } });
      return;

    default:
      return;
  }
}

/**
 * Rank per player for priority ducking. An order from the platoon leader
 * outranks a squad leader, and both outrank ordinary chatter.
 */
function rankMap(platoon: PlatoonState): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const player of platoon.players) {
    ranks.set(
      player.id,
      player.role === 'platoon_leader' ? 2 : player.role === 'squad_leader' ? 1 : 0,
    );
  }
  return ranks;
}

const ERROR_TEXT: Record<string, string> = {
  platoon_not_found: 'Platoon s tímto kódem neexistuje.',
  platoon_full: 'Platoon je plný.',
  squad_full: 'Tenhle squad je plný.',
  leader_taken: 'Squad už má svého velitele.',
  bad_password: 'Špatné heslo.',
  not_in_platoon: 'Nejsi v žádném platoonu.',
  forbidden: 'Na tohle nemáš oprávnění.',
  bad_request: 'Neplatný požadavek.',
  not_authenticated: 'Přihlášení vypršelo. Přihlas se znovu.',
  internal: 'Na serveru se něco pokazilo.',
};

function translateError(code: string, fallback: string): string {
  return ERROR_TEXT[code] ?? fallback;
}

/** Tell the platoon which net just went hot, so inactive squads see activity. */
function announceTransmit(net: NetId | null): void {
  const state = useApp.getState();
  const me = selectMe(state);
  const channelFor = (n: NetId): ChannelId | null => {
    if (n === 'command') return COMMAND_CHANNEL;
    if (n === 'allcall') return ALLCALL_CHANNEL;
    return me?.squadId ?? null;
  };

  const previous = lastAnnounced;
  if (previous && previous !== net) {
    const channel = channelFor(previous);
    if (channel !== null) socket?.send({ t: 'state:transmit', channel, active: false });
  }
  if (net) {
    const channel = channelFor(net);
    if (channel !== null) socket?.send({ t: 'state:transmit', channel, active: true });
  }
  lastAnnounced = net;
}

let lastAnnounced: NetId | null = null;

// --- overlay feed ----------------------------------------------------------

function buildOverlayState(state: AppState): OverlayState {
  const me = selectMe(state);
  const squad = me?.squadId != null
    ? (state.platoon?.squads.find((s) => s.id === me.squadId) ??
       DEFAULT_SQUADS.find((s) => s.id === me.squadId))
    : undefined;

  const badges: SpeakerBadge[] = state.speaking.map((entry) => ({
    id: entry.id,
    name: entry.name,
    net: entry.net,
    color: entry.net === 'command' ? '#e0b13a' : (squad?.color ?? '#9aa0aa'),
  }));

  return {
    connected: state.status === 'online',
    inPlatoon: state.platoon !== null,
    voiceDown: selectVoiceHealth(state) === 'down',
    transmitting: state.transmitting,
    speakers: badges,
    squadLabel: squad ? `${squad.name} · ${squad.role}` : null,
    squadColor: squad?.color ?? '#e0b13a',
    micMuted: state.micMuted,
    deafened: state.deafened,
    hasCommand: state.grants.command !== null,
  };
}

let lastOverlayJson = '';
useApp.subscribe((state) => {
  if (!state.ready) return;
  const next = buildOverlayState(state);
  const json = JSON.stringify(next);
  if (json === lastOverlayJson) return;
  lastOverlayJson = json;
  window.wardogs.pushOverlayState(next);
});

export function resumeAudioPlayback(): void {
  void engine?.resumePlayback();
}
