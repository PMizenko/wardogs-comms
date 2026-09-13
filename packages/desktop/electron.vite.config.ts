import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * The control server a build points at.
 *
 * Baked in at build time so a player installs and signs in - nobody should have
 * to be told a URL. Resolution order:
 *
 *   1. WARDOGS_SERVER_URL in the environment
 *   2. WARDOGS_SERVER_URL in the repo-root .env
 *   3. http://localhost:4000
 *
 * The chosen value is printed on every build, because silently shipping an
 * installer that points at localhost is the one mistake nobody notices until
 * players start reporting that nothing connects.
 */
function resolveServerUrl(): string {
  const fromEnv = process.env['WARDOGS_SERVER_URL']?.trim();
  if (fromEnv) return fromEnv;

  try {
    const env = readFileSync(resolve(__dirname, '../../.env'), 'utf8');
    const match = env.match(/^\s*WARDOGS_SERVER_URL\s*=\s*(.+)$/m);
    const value = match?.[1]?.trim().replace(/^["']|["']$/g, '');
    if (value) return value;
  } catch {
    // No .env - fall through to the development default.
  }
  return 'http://localhost:4000';
}

const SERVER_URL = resolveServerUrl().replace(/\/$/, '');
const isLocal = /localhost|127\.0\.0\.1/.test(SERVER_URL);

console.log(
  `\n  wardogs: build points at ${SERVER_URL}` +
    (isLocal
      ? '\n  \x1b[33m^ local address - fine for development, but do not hand this build to players.\n' +
        '    Set WARDOGS_SERVER_URL before building a release.\x1b[0m\n'
      : '\n'),
);

const define = {
  __WARDOGS_SERVER_URL__: JSON.stringify(SERVER_URL),
};

export default defineConfig({
  main: {
    define,
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    define,
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    define,
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: { '@': resolve(__dirname, 'src/renderer/src') },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        // Two windows, two entry points: the control panel and the in-game HUD.
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html'),
        },
      },
    },
  },
});
