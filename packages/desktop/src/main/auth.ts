import { app, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { settings } from './settings.js';

export const PROTOCOL = 'wardogs-voip';

/**
 * Discord sign-in, run through the user's own browser.
 *
 * The app never sees a password: it opens the consent page externally, the
 * server completes the OAuth exchange, and the finished session token comes
 * back through a `wardogs-voip://auth` deep link. The nonce ties the link that
 * arrives to the request this process actually made, so a stray link cannot
 * inject somebody else's session.
 */

let pendingState: string | null = null;
const tokenListeners = new Set<(token: string) => void>();

export function registerProtocol(): void {
  if (process.defaultApp) {
    // In dev the executable is Electron itself, so the script path must ride along.
    const script = process.argv[1];
    if (script) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [resolve(script)]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

export async function startSignIn(): Promise<void> {
  const state = randomBytes(24).toString('hex');
  pendingState = state;

  const base = settings.get().serverUrl.replace(/\/$/, '');
  const url = `${base}/auth/discord/start?state=${encodeURIComponent(state)}`;
  await shell.openExternal(url);
}

/**
 * Local-testing sign-in. Goes through the same browser hand-off and deep link
 * as Discord, so the desktop side has exactly one code path for both. The
 * server refuses this unless ALLOW_DEV_LOGIN is on.
 */
export async function startDevSignIn(name: string): Promise<void> {
  const state = randomBytes(24).toString('hex');
  pendingState = state;

  const base = settings.get().serverUrl.replace(/\/$/, '');
  const url =
    `${base}/auth/dev/start?state=${encodeURIComponent(state)}` +
    `&name=${encodeURIComponent(name)}`;
  await shell.openExternal(url);
}

export function signOut(): void {
  pendingState = null;
  settings.update({ sessionToken: null });
}

export function onToken(cb: (token: string) => void): () => void {
  tokenListeners.add(cb);
  return () => tokenListeners.delete(cb);
}

/** Handles `wardogs-voip://auth?token=...&state=...`. Returns true if consumed. */
export function handleDeepLink(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== `${PROTOCOL}:`) return false;

  // Depending on the platform the path lands in `hostname` or `pathname`.
  const route = (url.hostname || url.pathname.replace(/^\/+/, '')).toLowerCase();
  if (route !== 'auth') return false;

  const token = url.searchParams.get('token');
  const state = url.searchParams.get('state');

  if (!token || !state || state !== pendingState) {
    console.warn('[wardogs] ignoring auth deep link with unexpected state');
    return true;
  }
  pendingState = null;

  settings.update({ sessionToken: token });
  for (const listener of tokenListeners) listener(token);
  return true;
}

/** Picks the deep link out of an argv array (Windows hands it over this way). */
export function deepLinkFromArgv(argv: string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${PROTOCOL}://`)) ?? null;
}
