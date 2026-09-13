/**
 * Radio key tones.
 *
 * A short blip when a net opens and a lower one when it closes, so you know you
 * are on the air without looking away from the game. Real radios do this for
 * the same reason.
 *
 * Synthesised into a WAV data URI and played through an <audio> element rather
 * than WebAudio, so the tone follows the same output-device selection as
 * everyone's voices - a confirmation blip landing in the wrong headset would be
 * worse than none.
 */

const SAMPLE_RATE = 16000;

/** Builds a mono 16-bit WAV of a decaying sine, returned as a data URI. */
function tone(frequency: number, durationMs: number, peak: number): string {
  const samples = Math.round((SAMPLE_RATE * durationMs) / 1000);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);

  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    // Short attack so it does not click, then an exponential tail.
    const attack = Math.min(1, i / (SAMPLE_RATE * 0.004));
    const decay = Math.exp((-5 * i) / samples);
    const value = Math.sin(2 * Math.PI * frequency * t) * peak * attack * decay;
    view.setInt16(44 + i * 2, Math.round(value * 32767), true);
  }

  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

// Up when the net opens, down when it closes - the direction alone tells you
// which happened, even at a volume you barely notice.
const SOURCES = {
  open: tone(1046, 70, 0.5),
  close: tone(660, 90, 0.4),
} as const;

export type ToneName = keyof typeof SOURCES;

const elements = new Map<ToneName, HTMLAudioElement>();
let outputDeviceId = 'default';
let volume = 0.35;

function elementFor(name: ToneName): HTMLAudioElement {
  let el = elements.get(name);
  if (!el) {
    el = new Audio(SOURCES[name]);
    el.preload = 'auto';
    elements.set(name, el);
    void routeTone(el);
  }
  return el;
}

async function routeTone(el: HTMLAudioElement): Promise<void> {
  if (!outputDeviceId || outputDeviceId === 'default') return;
  const sinkable = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  try {
    await sinkable.setSinkId?.(outputDeviceId);
  } catch {
    // Device gone; the system default is a fine place for a blip.
  }
}

/** Follow the headset the player picked for voices. */
export function setToneOutput(deviceId: string, playbackVolume: number): void {
  const changed = deviceId !== outputDeviceId;
  outputDeviceId = deviceId;
  // Tones sit under the voices - they are a cue, not content.
  volume = Math.min(1, Math.max(0, playbackVolume)) * 0.35;
  if (changed) for (const el of elements.values()) void routeTone(el);
}

export function playTone(name: ToneName): void {
  const el = elementFor(name);
  el.volume = volume;
  el.currentTime = 0;
  el.play().catch(() => {
    // Autoplay not unlocked yet, or the device vanished. Never worth surfacing.
  });
}
