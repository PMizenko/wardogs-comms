/**
 * Settings shared by the main process (which persists them and owns the key
 * hook) and the renderer (which owns audio). Kept in one file so the two can
 * never drift apart.
 */

/** A global input binding. Mouse side-buttons are as common as keys for PTT. */
export type Binding =
  | { kind: 'key'; code: number; label: string }
  | { kind: 'mouse'; button: number; label: string };

/** Which net a hotkey keys up. */
export type HotkeyAction = 'squad' | 'command' | 'muteToggle' | 'deafenToggle';

/**
 * How a net is keyed.
 * - `ptt`  transmit only while the binding is held (radio discipline, default)
 * - `open` always live, gated by the browser's own voice detection
 */
export type TransmitMode = 'ptt' | 'open';

export type OverlayCorner = 'tl' | 'tr' | 'bl' | 'br';

/**
 * Server address baked in at build time (see electron.vite.config.ts). A player
 * who installs a release should never have to type a URL; the fallback only
 * applies when this file is read outside a bundle, e.g. by a test.
 */
declare const __WARDOGS_SERVER_URL__: string;
export const DEFAULT_SERVER_URL =
  typeof __WARDOGS_SERVER_URL__ === 'string' ? __WARDOGS_SERVER_URL__ : 'http://localhost:4000';

export interface Settings {
  /** Base URL of the control server, e.g. http://localhost:4000 */
  serverUrl: string;
  /** Session JWT from the Discord sign-in. Null until the user signs in. */
  sessionToken: string | null;

  audio: {
    inputDeviceId: string;
    outputDeviceId: string;
    noiseSuppression: boolean;
    echoCancellation: boolean;
    autoGainControl: boolean;
    /** Master playback gain, 0..1. */
    outputVolume: number;
    /**
     * Duck everyone else while someone senior is on the air, so an order does
     * not get buried under squad chatter.
     */
    duckOnCommand: boolean;
    /** Level the ducked voices drop to, 0..1. */
    duckLevel: number;
    /** Play a short blip when a net opens or closes. */
    keyTones: boolean;
  };

  hotkeys: Record<HotkeyAction, Binding | null>;

  transmit: {
    squad: TransmitMode;
    command: TransmitMode;
  };

  overlay: {
    enabled: boolean;
    corner: OverlayCorner;
    /** 0.8 - 1.6, scales the whole HUD for high-DPI screens. */
    scale: number;
    /** Hide the HUD entirely when nothing is happening. */
    hideWhenIdle: boolean;
  };

  startMinimised: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: DEFAULT_SERVER_URL,
  sessionToken: null,
  audio: {
    inputDeviceId: 'default',
    outputDeviceId: 'default',
    // Headsets are the norm here; keep the processing chain conservative so
    // squad chatter is not gated away mid-sentence.
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
    outputVolume: 1,
    duckOnCommand: true,
    // Quiet enough to get out of the way, loud enough that you still know
    // someone is talking and can key back in.
    duckLevel: 0.2,
    keyTones: true,
  },
  hotkeys: {
    // Deliberately unbound. Any default we picked would collide with somebody's
    // game binds, so the UI asks for a key on first run instead.
    squad: null,
    command: null,
    muteToggle: null,
    deafenToggle: null,
  },
  transmit: {
    squad: 'ptt',
    command: 'ptt',
  },
  overlay: {
    enabled: true,
    corner: 'tl',
    scale: 1,
    hideWhenIdle: true,
  },
  startMinimised: false,
};

/** Merge persisted JSON over the defaults, tolerating older/partial files. */
export function mergeSettings(stored: unknown): Settings {
  if (typeof stored !== 'object' || stored === null) return structuredClone(DEFAULT_SETTINGS);
  const s = stored as Partial<Settings>;
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    audio: { ...DEFAULT_SETTINGS.audio, ...(s.audio ?? {}) },
    hotkeys: { ...DEFAULT_SETTINGS.hotkeys, ...(s.hotkeys ?? {}) },
    transmit: { ...DEFAULT_SETTINGS.transmit, ...(s.transmit ?? {}) },
    overlay: { ...DEFAULT_SETTINGS.overlay, ...(s.overlay ?? {}) },
  };
}
