import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  type DesktopBridge,
  type HotkeyEvent,
  type OverlayState,
  type UpdateState,
} from '../common/ipc.js';
import type { Binding, HotkeyAction, Settings } from '../common/settings.js';
import type { DeepPartial } from '../common/ipc.js';

/**
 * The only channel between the renderer and the OS.
 *
 * Node stays out of the renderer entirely; everything privileged - the key
 * hook, the browser hand-off for sign-in, settings on disk - is reached through
 * this fixed, hand-written surface.
 */

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: T): void => cb(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const bridge: DesktopBridge = {
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<Settings>,
  updateSettings: (patch: DeepPartial<Settings>) =>
    ipcRenderer.invoke(IPC.settingsUpdate, patch) as Promise<Settings>,
  onSettingsChanged: (cb) => subscribe<Settings>(IPC.settingsChanged, cb),

  startSignIn: () => ipcRenderer.invoke(IPC.authStart) as Promise<void>,
  startDevSignIn: (name: string) =>
    ipcRenderer.invoke(IPC.authStartDev, name) as Promise<void>,
  signOut: () => ipcRenderer.invoke(IPC.authSignOut) as Promise<void>,
  onSessionToken: (cb) => subscribe<string>(IPC.authToken, cb),

  onHotkey: (cb) => subscribe<HotkeyEvent>(IPC.hotkeyEvent, cb),
  captureBinding: () => ipcRenderer.invoke(IPC.hotkeyCapture) as Promise<Binding | null>,
  cancelCapture: () => ipcRenderer.invoke(IPC.hotkeyCaptureCancel) as Promise<void>,
  clearBinding: (action: HotkeyAction) =>
    ipcRenderer.invoke(IPC.hotkeyClear, action) as Promise<void>,
  hotkeysAvailable: () => ipcRenderer.invoke(IPC.hotkeyAvailable) as Promise<boolean>,
  pauseHotkeys: (paused: boolean) => ipcRenderer.send(IPC.hotkeyPause, paused),

  checkForUpdates: () => ipcRenderer.invoke(IPC.updateCheck) as Promise<UpdateState>,
  downloadUpdate: () => ipcRenderer.invoke(IPC.updateDownload) as Promise<void>,
  installUpdate: () => ipcRenderer.invoke(IPC.updateInstall) as Promise<void>,
  onUpdateState: (cb) => subscribe<UpdateState>(IPC.updateState, cb),

  pushOverlayState: (state: OverlayState) => ipcRenderer.send(IPC.overlayPush, state),
  onOverlayState: (cb) => subscribe<OverlayState>(IPC.overlayState, cb),

  minimise: () => ipcRenderer.send(IPC.windowMinimise),
  close: () => ipcRenderer.send(IPC.windowClose),
  appInfo: () =>
    ipcRenderer.invoke(IPC.appInfo) as Promise<{
      version: string;
      platform: string;
      hotkeysAvailable: boolean;
    }>,
};

contextBridge.exposeInMainWorld('wardogs', bridge);
