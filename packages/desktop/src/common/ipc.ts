import type { Binding, HotkeyAction, Settings } from './settings.js';

/** Nets as the client thinks of them: your squad net and the command net. */
export type NetId = 'squad' | 'command';

/** One person currently audible, and on which net. */
export interface SpeakerBadge {
  id: string;
  name: string;
  net: NetId;
  color: string;
}

/**
 * Everything the in-game HUD draws. The control window computes this and pipes
 * it through the main process, because the overlay is a separate window that
 * never talks to the server itself.
 */
export interface OverlayState {
  connected: boolean;
  /** True once in a platoon - a lost link only matters when you were on one. */
  inPlatoon: boolean;
  /** Net this player is transmitting on right now, if any. */
  transmitting: NetId | null;
  speakers: SpeakerBadge[];
  /** Label and colour of the squad the player is standing in. */
  squadLabel: string | null;
  squadColor: string;
  micMuted: boolean;
  deafened: boolean;
  /** True once the player holds a command-net grant. */
  hasCommand: boolean;
}

export const EMPTY_OVERLAY_STATE: OverlayState = {
  connected: false,
  inPlatoon: false,
  transmitting: null,
  speakers: [],
  squadLabel: null,
  squadColor: '#e0b13a',
  micMuted: false,
  deafened: false,
  hasCommand: false,
};

/**
 * Where an update check has got to.
 *
 * `unsupported` covers the two builds that cannot update themselves: a dev run,
 * and the portable exe (it has no installer to hand over to).
 */
export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'unsupported'; reason: string }
  | { phase: 'checking' }
  | { phase: 'current'; version: string }
  | { phase: 'available'; version: string; notes: string | null }
  | { phase: 'downloading'; percent: number; bytesPerSecond: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string };

/** Fired by the global key hook, consumed by the voice engine. */
export interface HotkeyEvent {
  action: HotkeyAction;
  pressed: boolean;
}

/** The surface `window.wardogs` exposes to the renderer. */
export interface DesktopBridge {
  getSettings(): Promise<Settings>;
  updateSettings(patch: DeepPartial<Settings>): Promise<Settings>;
  onSettingsChanged(cb: (settings: Settings) => void): () => void;

  /** Opens the system browser at the Discord consent screen. */
  startSignIn(): Promise<void>;
  /** Local-testing sign-in; only works when the server allows it. */
  startDevSignIn(name: string): Promise<void>;
  signOut(): Promise<void>;
  onSessionToken(cb: (token: string) => void): () => void;

  onHotkey(cb: (event: HotkeyEvent) => void): () => void;
  /** Grabs the next key or mouse button pressed and returns it as a binding. */
  captureBinding(): Promise<Binding | null>;
  cancelCapture(): Promise<void>;
  clearBinding(action: HotkeyAction): Promise<void>;
  /** True when the native key hook is running; false means in-app keys only. */
  hotkeysAvailable(): Promise<boolean>;
  /** Suspend push-to-talk while a text field has focus. */
  pauseHotkeys(paused: boolean): void;

  /** Ask the update server what is out there. Resolves with the outcome. */
  checkForUpdates(): Promise<UpdateState>;
  /** Pull down an update that a check found. */
  downloadUpdate(): Promise<void>;
  /** Quit and run the downloaded installer. */
  installUpdate(): Promise<void>;
  onUpdateState(cb: (state: UpdateState) => void): () => void;

  pushOverlayState(state: OverlayState): void;
  onOverlayState(cb: (state: OverlayState) => void): () => void;

  minimise(): void;
  close(): void;
  appInfo(): Promise<{ version: string; platform: string; hotkeysAvailable: boolean }>;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export const IPC = {
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsChanged: 'settings:changed',

  authStart: 'auth:start',
  authStartDev: 'auth:start-dev',
  authSignOut: 'auth:sign-out',
  authToken: 'auth:token',

  hotkeyEvent: 'hotkey:event',
  hotkeyCapture: 'hotkey:capture',
  hotkeyCaptureCancel: 'hotkey:capture-cancel',
  hotkeyClear: 'hotkey:clear',
  hotkeyAvailable: 'hotkey:available',
  hotkeyPause: 'hotkey:pause',

  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateState: 'update:state',

  overlayPush: 'overlay:push',
  overlayState: 'overlay:state',

  windowMinimise: 'window:minimise',
  windowClose: 'window:close',
  appInfo: 'app:info',
} as const;
