import type { Settings } from '../../../common/settings.js';

/**
 * Microphone check for the settings panel.
 *
 * "Can you hear me?" is the single most common thing said on a voice server,
 * and it is almost always the wrong input device. This opens the selected
 * microphone, reports a live level, and can play it straight back, so the
 * question gets answered before anyone joins a squad.
 *
 * Deliberately separate from the voice engine: it runs only while the panel is
 * open, and a bug here must never be able to disturb a live net.
 */
export class MicCheck {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private frame: number | null = null;
  private monitor: HTMLAudioElement | null = null;
  private onLevel: ((level: number) => void) | null = null;
  /** Decays between peaks so the bar falls smoothly instead of flickering. */
  private smoothed = 0;

  get active(): boolean {
    return this.stream !== null;
  }

  async start(settings: Settings, onLevel: (level: number) => void): Promise<string | null> {
    this.stop();
    this.onLevel = onLevel;

    const { audio } = settings;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: audio.inputDeviceId === 'default' ? undefined : { exact: audio.inputDeviceId },
          noiseSuppression: audio.noiseSuppression,
          echoCancellation: audio.echoCancellation,
          autoGainControl: audio.autoGainControl,
          channelCount: 1,
        },
        video: false,
      });
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }

    this.context = new AudioContext();
    const source = this.context.createMediaStreamSource(this.stream);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.3;
    source.connect(this.analyser);

    const samples = new Float32Array(this.analyser.fftSize);
    const tick = (): void => {
      if (!this.analyser) return;
      this.analyser.getFloatTimeDomainData(samples);

      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const rms = Math.sqrt(sum / samples.length);
      // Speech sits well below full scale; scale so normal talking lands
      // around two thirds of the bar rather than barely moving it.
      const level = Math.min(1, rms * 4);

      this.smoothed = level > this.smoothed ? level : this.smoothed * 0.85 + level * 0.15;
      this.onLevel?.(this.smoothed);
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
    return null;
  }

  /**
   * Play the microphone back. Only safe on headphones - on speakers this is a
   * feedback loop, which is why the UI says so next to the switch.
   */
  async setMonitor(on: boolean, outputDeviceId: string, volume: number): Promise<void> {
    if (!on) {
      this.monitor?.pause();
      this.monitor = null;
      return;
    }
    if (!this.stream) return;

    const el = new Audio();
    el.srcObject = this.stream;
    el.volume = Math.min(1, Math.max(0, volume));
    if (outputDeviceId && outputDeviceId !== 'default') {
      const sinkable = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      try {
        await sinkable.setSinkId?.(outputDeviceId);
      } catch {
        // Fall back to the system default rather than staying silent.
      }
    }
    this.monitor = el;
    await el.play().catch(() => undefined);
  }

  stop(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;

    this.monitor?.pause();
    this.monitor = null;

    this.analyser = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;

    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;

    this.smoothed = 0;
    this.onLevel?.(0);
    this.onLevel = null;
  }
}
