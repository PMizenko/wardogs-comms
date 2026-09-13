import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { IPC, type OverlayState } from '../common/ipc.js';
import type { OverlayCorner } from '../common/settings.js';
import { settings } from './settings.js';

/**
 * The in-game HUD.
 *
 * A frameless, transparent, click-through window pinned above everything else,
 * so a player can see who is talking and which net they are keyed into without
 * leaving the game. It is deliberately inert: no input, no focus stealing, and
 * it never touches the network - the control window feeds it state over IPC.
 *
 * Windows caveat: an overlay can only draw over a game running in windowed or
 * borderless-fullscreen mode. Exclusive fullscreen bypasses the compositor and
 * nothing can be drawn on top of it.
 */

const BASE_WIDTH = 320;
const BASE_HEIGHT = 260;
const MARGIN = 24;

let window: BrowserWindow | null = null;
let lastState: OverlayState | null = null;

function cornerPosition(corner: OverlayCorner, width: number, height: number) {
  const { workArea } = screen.getPrimaryDisplay();
  const left = workArea.x + MARGIN;
  const top = workArea.y + MARGIN;
  const right = workArea.x + workArea.width - width - MARGIN;
  const bottom = workArea.y + workArea.height - height - MARGIN;

  switch (corner) {
    case 'tr':
      return { x: right, y: top };
    case 'bl':
      return { x: left, y: bottom };
    case 'br':
      return { x: right, y: bottom };
    case 'tl':
    default:
      return { x: left, y: top };
  }
}

export function createOverlay(): BrowserWindow {
  if (window && !window.isDestroyed()) return window;

  const { overlay } = settings.get();
  const width = Math.round(BASE_WIDTH * overlay.scale);
  const height = Math.round(BASE_HEIGHT * overlay.scale);
  const { x, y } = cornerPosition(overlay.corner, width, height);

  window = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    hasShadow: false,
    alwaysOnTop: true,
    // Keep it out of screen shares and recordings by default? No - streamers
    // usually want it visible, and it carries nothing sensitive.
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // 'screen-saver' is the highest level that still sits below system UI; it is
  // what puts the HUD above a borderless-fullscreen game.
  window.setAlwaysOnTop(true, 'screen-saver');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setIgnoreMouseEvents(true, { forward: false });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void window.loadURL(`${devUrl}/overlay.html`);
  } else {
    void window.loadFile(join(__dirname, '../renderer/overlay.html'));
  }

  window.once('ready-to-show', () => {
    if (settings.get().overlay.enabled) window?.showInactive();
    if (lastState) push(lastState);
  });

  window.on('closed', () => {
    window = null;
  });

  return window;
}

export function push(state: OverlayState): void {
  lastState = state;
  if (window && !window.isDestroyed() && window.webContents) {
    window.webContents.send(IPC.overlayState, state);
  }
}

/** Re-reads settings: toggles visibility, re-scales and re-anchors the HUD. */
export function applyOverlaySettings(): void {
  const { overlay } = settings.get();

  if (!overlay.enabled) {
    window?.hide();
    return;
  }
  if (!window || window.isDestroyed()) {
    createOverlay();
    return;
  }

  const width = Math.round(BASE_WIDTH * overlay.scale);
  const height = Math.round(BASE_HEIGHT * overlay.scale);
  const { x, y } = cornerPosition(overlay.corner, width, height);
  window.setBounds({ x, y, width, height });
  if (!window.isVisible()) window.showInactive();
}

export function destroyOverlay(): void {
  if (window && !window.isDestroyed()) window.destroy();
  window = null;
}
