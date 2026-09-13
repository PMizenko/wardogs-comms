import { app } from 'electron';
import type { UpdateState } from '../common/ipc.js';

/**
 * In-app updates from GitHub Releases.
 *
 * Download is deliberately manual: nobody wants 80 MB pulled down mid-match on
 * a metered connection, and the install needs the app to quit. So a check tells
 * you what is out there, you decide when to fetch it, and it installs on the
 * next restart.
 *
 * Two builds cannot update themselves and say so rather than failing oddly:
 * a dev run (no app-update.yml) and the portable exe (no installer to hand to).
 */

type Updater = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  logger: unknown;
  on(event: string, cb: (payload: never) => void): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, forceRunAfter?: boolean): void;
};

let updater: Updater | null = null;
let state: UpdateState = { phase: 'idle' };
let broadcast: (state: UpdateState) => void = () => {};
/** Resolves the promise the renderer is awaiting on a check. */
let pendingCheck: ((state: UpdateState) => void) | null = null;

function setState(next: UpdateState): void {
  state = next;
  broadcast(next);

  // A check is finished once it reaches any of these; resolve the caller.
  if (
    pendingCheck &&
    (next.phase === 'available' ||
      next.phase === 'current' ||
      next.phase === 'error' ||
      next.phase === 'unsupported')
  ) {
    pendingCheck(next);
    pendingCheck = null;
  }
}

/** Why this build cannot update itself, or null if it can. */
function unsupportedReason(): string | null {
  if (!app.isPackaged) {
    return 'Vývojový build se neaktualizuje.';
  }
  if (process.env['PORTABLE_EXECUTABLE_DIR']) {
    return 'Přenosná verze se neumí aktualizovat sama — stáhni si novou ručně, nebo použij instalátor.';
  }
  return null;
}

export function getUpdateState(): UpdateState {
  return state;
}

export async function initUpdater(send: (state: UpdateState) => void): Promise<void> {
  broadcast = send;

  const reason = unsupportedReason();
  if (reason) {
    state = { phase: 'unsupported', reason };
    return;
  }

  try {
    const mod = (await import('electron-updater')) as unknown as {
      autoUpdater: Updater;
      default?: { autoUpdater: Updater };
    };
    updater = mod.autoUpdater ?? mod.default?.autoUpdater ?? null;
    if (!updater) throw new Error('electron-updater exposed no autoUpdater');
  } catch (err) {
    state = {
      phase: 'unsupported',
      reason: `Aktualizace nejsou k dispozici: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
    return;
  }

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;

  updater.on('checking-for-update', () => setState({ phase: 'checking' }));

  updater.on('update-available', (info: { version: string; releaseNotes?: unknown }) => {
    setState({
      phase: 'available',
      version: info.version,
      notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
    });
  });

  updater.on('update-not-available', () =>
    setState({ phase: 'current', version: app.getVersion() }),
  );

  updater.on('download-progress', (progress: { percent: number; bytesPerSecond: number }) =>
    setState({
      phase: 'downloading',
      percent: Math.round(progress.percent),
      bytesPerSecond: Math.round(progress.bytesPerSecond),
    }),
  );

  updater.on('update-downloaded', (info: { version: string }) =>
    setState({ phase: 'ready', version: info.version }),
  );

  updater.on('error', (err: Error) => {
    setState({
      phase: 'error',
      message: friendlyError(err),
    });
  });
}

/**
 * Network and configuration failures are the common case here, and the raw
 * messages are unhelpful. Translate the ones players will actually hit.
 */
function friendlyError(err: Error): string {
  const raw = err?.message ?? String(err);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH/i.test(raw)) {
    return 'Nepodařilo se spojit se serverem aktualizací. Zkontroluj připojení.';
  }
  if (/404/.test(raw)) {
    return 'Server aktualizací nic nevrátil — možná ještě není vydaná žádná verze.';
  }
  if (/latest\.yml|app-update\.yml/i.test(raw)) {
    return 'Tenhle build nemá nastavený zdroj aktualizací.';
  }
  return raw;
}

export async function checkForUpdates(): Promise<UpdateState> {
  const reason = unsupportedReason();
  if (reason || !updater) {
    const next: UpdateState = { phase: 'unsupported', reason: reason ?? 'Aktualizace nejsou k dispozici.' };
    setState(next);
    return next;
  }
  if (state.phase === 'downloading' || state.phase === 'ready') return state;

  const settled = new Promise<UpdateState>((resolve) => {
    pendingCheck = resolve;
  });

  setState({ phase: 'checking' });
  try {
    await updater.checkForUpdates();
  } catch (err) {
    // The error event usually fires too, but not on every failure path.
    const next: UpdateState = {
      phase: 'error',
      message: friendlyError(err instanceof Error ? err : new Error(String(err))),
    };
    setState(next);
    return next;
  }
  return settled;
}

export async function downloadUpdate(): Promise<void> {
  if (!updater || state.phase !== 'available') return;
  try {
    setState({ phase: 'downloading', percent: 0, bytesPerSecond: 0 });
    await updater.downloadUpdate();
  } catch (err) {
    setState({
      phase: 'error',
      message: friendlyError(err instanceof Error ? err : new Error(String(err))),
    });
  }
}

export function installUpdate(): void {
  if (!updater || state.phase !== 'ready') return;
  // isSilent = false so the player sees the installer; forceRunAfter so the app
  // comes back up on its own.
  updater.quitAndInstall(false, true);
}
