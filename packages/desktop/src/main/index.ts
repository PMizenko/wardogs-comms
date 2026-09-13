import { app, BrowserWindow, ipcMain, Menu, nativeImage, session, shell, Tray } from 'electron';
import { join } from 'node:path';
import { IPC, type HotkeyEvent, type OverlayState } from '../common/ipc.js';
import type { HotkeyAction } from '../common/settings.js';
import { settings } from './settings.js';
import { hotkeys } from './hotkeys.js';
import { applyOverlaySettings, createOverlay, destroyOverlay, push } from './overlay.js';
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  initUpdater,
  installUpdate,
} from './updater.js';
import {
  deepLinkFromArgv,
  handleDeepLink,
  onToken,
  registerProtocol,
  signOut,
  startDevSignIn,
  startSignIn,
} from './auth.js';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** Set by the tray/menu "Quit" so closing the window can mean "hide" otherwise. */
let quitting = false;

/**
 * Keep the OS login item in step with the setting.
 *
 * Only for packaged builds: doing this in development would register the bare
 * Electron binary, which then starts something meaningless on every login.
 */
function syncLoginItem(): void {
  if (!app.isPackaged || process.platform === 'linux') return;
  const { launchAtLogin, startMinimised } = settings.get();
  try {
    app.setLoginItemSettings({
      openAtLogin: launchAtLogin,
      // Launching straight into the tray is the point of starting with Windows.
      args: startMinimised ? ['--hidden'] : [],
    });
  } catch (err) {
    console.error('[wardogs] could not update the login item:', err);
  }
}

function resourcePath(file: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, file)
    : join(__dirname, '../../resources', file);
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 620,
    show: false,
    frame: false,
    backgroundColor: '#0c0d10',
    icon: resourcePath('tray.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Audio must keep flowing while the window sits behind the game.
      backgroundThrottling: false,
    },
  });

  window.on('ready-to-show', () => {
    const hidden = settings.get().startMinimised || process.argv.includes('--hidden');
    if (!hidden) window.show();
  });

  window.on('close', (event) => {
    // Closing parks the app in the tray - dropping off comms mid-match because
    // somebody hit the X would be worse than a surprising window.
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });

  window.on('closed', () => {
    mainWindow = null;
  });

  // Anything that is not our own UI opens in the real browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void window.loadURL(devUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}

function createTray(): void {
  const icon = nativeImage.createFromPath(resourcePath('tray.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Wardogs VOIP');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Otevřít Wardogs VOIP', click: () => showMainWindow() },
      { type: 'separator' },
      {
        label: 'Overlay ve hře',
        type: 'checkbox',
        checked: settings.get().overlay.enabled,
        click: (item) => {
          settings.update({ overlay: { enabled: item.checked } });
          applyOverlaySettings();
        },
      },
      { type: 'separator' },
      {
        label: 'Ukončit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => showMainWindow());
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function wireIpc(): void {
  ipcMain.handle(IPC.settingsGet, () => settings.get());

  ipcMain.handle(IPC.settingsUpdate, (_event, patch) => {
    const next = settings.update(patch ?? {});
    applyOverlaySettings();
    syncLoginItem();
    return next;
  });

  ipcMain.handle(IPC.authStart, async () => {
    await startSignIn();
  });

  ipcMain.handle(IPC.authStartDev, async (_event, name: string) => {
    await startDevSignIn(String(name ?? '').slice(0, 24));
  });

  ipcMain.handle(IPC.authSignOut, () => {
    signOut();
  });

  ipcMain.handle(IPC.hotkeyCapture, () => hotkeys.captureNext());
  ipcMain.handle(IPC.hotkeyCaptureCancel, () => hotkeys.cancelCapture());
  ipcMain.handle(IPC.hotkeyAvailable, () => hotkeys.available);
  ipcMain.on(IPC.hotkeyPause, (_event, paused: boolean) => hotkeys.setPaused(paused === true));

  ipcMain.handle(IPC.hotkeyClear, (_event, action: HotkeyAction) => {
    settings.update({ hotkeys: { [action]: null } });
  });

  ipcMain.handle(IPC.updateCheck, () => checkForUpdates());
  ipcMain.handle(IPC.updateDownload, () => downloadUpdate());
  ipcMain.handle(IPC.updateInstall, () => {
    // The window close handler parks the app in the tray unless we are really
    // quitting; the installer needs a genuine quit.
    quitting = true;
    installUpdate();
  });

  ipcMain.on(IPC.overlayPush, (_event, state: OverlayState) => push(state));

  ipcMain.on(IPC.windowMinimise, () => mainWindow?.minimize());
  ipcMain.on(IPC.windowClose, () => mainWindow?.hide());

  ipcMain.handle(IPC.appInfo, () => ({
    version: app.getVersion(),
    platform: process.platform,
    hotkeysAvailable: hotkeys.available,
  }));

  // Settings written from anywhere are echoed to every window.
  settings.onChange((next) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.settingsChanged, next);
    }
  });

  onToken((token) => {
    showMainWindow();
    mainWindow?.webContents.send(IPC.authToken, token);
  });
}

/** Windows/Linux deliver deep links as an extra process launch. */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const link = deepLinkFromArgv(argv);
    if (link) handleDeepLink(link);
    showMainWindow();
  });

  // macOS delivers them as an event instead.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.whenReady().then(async () => {
    registerProtocol();

    // The renderer needs the microphone; nothing else is granted.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media');
    });

    wireIpc();
    syncLoginItem();
    mainWindow = createMainWindow();
    createTray();
    if (settings.get().overlay.enabled) createOverlay();

    await hotkeys.start((event: HotkeyEvent) => {
      mainWindow?.webContents.send(IPC.hotkeyEvent, event);
    });

    await initUpdater((updateState) => {
      mainWindow?.webContents.send(IPC.updateState, updateState);
    });
    // Hand the current state to a window that opens after this point.
    mainWindow?.webContents.once('did-finish-load', () => {
      mainWindow?.webContents.send(IPC.updateState, getUpdateState());
    });

    // One quiet check shortly after launch: no dialog, no download, it just
    // means the answer is already there when somebody opens Settings.
    const firstCheck = setTimeout(() => void checkForUpdates(), 12_000);
    firstCheck.unref?.();

    // A link that launched the app arrives in our own argv.
    const link = deepLinkFromArgv(process.argv);
    if (link) handleDeepLink(link);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
      else showMainWindow();
    });
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('will-quit', () => {
    hotkeys.stop();
    destroyOverlay();
    tray?.destroy();
  });

  // Living in the tray is the point; do not exit when the last window closes.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && quitting) app.quit();
  });
}
