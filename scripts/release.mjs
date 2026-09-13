/**
 * Builds the installer you hand to players.
 *
 * The one mistake that matters here is shipping a build that still points at
 * localhost: it installs fine, looks fine, and nobody can connect. So this
 * refuses to produce a release build with a local address unless you say so
 * explicitly, and prints the baked address before and after.
 *
 * Run:  npm run dist:release -- https://voip.wardogs.gg
 *   or: set WARDOGS_SERVER_URL in .env and run npm run dist:release
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const allowLocal = args.includes('--allow-local');
const urlArg = args.find((a) => !a.startsWith('--'));

function fromDotEnv() {
  const path = join(root, '.env');
  if (!existsSync(path)) return null;
  const match = readFileSync(path, 'utf8').match(/^\s*WARDOGS_SERVER_URL\s*=\s*(.+)$/m);
  return match?.[1]?.trim().replace(/^["']|["']$/g, '') || null;
}

const serverUrl = (urlArg ?? process.env.WARDOGS_SERVER_URL ?? fromDotEnv() ?? '').trim();

if (!serverUrl) {
  console.error(
    '\nNo server address.\n' +
      '  npm run dist:release -- https://voip.wardogs.gg\n' +
      '  or set WARDOGS_SERVER_URL in .env\n',
  );
  process.exit(1);
}

try {
  const parsed = new URL(serverUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol');
} catch {
  console.error(`\n"${serverUrl}" is not a valid http(s) address.\n`);
  process.exit(1);
}

const isLocal = /localhost|127\.0\.0\.1|::1/.test(serverUrl);
if (isLocal && !allowLocal) {
  console.error(
    `\nRefusing to build a release pointing at ${serverUrl}.\n` +
      'Players on other machines cannot reach your localhost, so the app would\n' +
      'install and then fail to connect with no obvious cause.\n\n' +
      '  npm run dist:release -- https://your-server\n' +
      '  npm run dist:release -- --allow-local   (only for testing on this machine)\n',
  );
  process.exit(1);
}

if (serverUrl.startsWith('http://') && !isLocal) {
  console.warn(
    `\n  Warning: ${serverUrl} is plain HTTP. Sign-in tokens will cross the network\n` +
      '  in the clear. Put the server behind HTTPS before a real release.\n',
  );
}

console.log(`\nBuilding release for ${serverUrl}\n`);

// One command string rather than an args array: npm is a .cmd shim on Windows
// and Node refuses to spawn those without a shell, while passing an args array
// *through* a shell is deprecated. A single string satisfies both.
const result = spawnSync('npm run dist', {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, WARDOGS_SERVER_URL: serverUrl },
});

if (result.error || result.status !== 0) {
  // Say why: a bare "build failed" with the real cause swallowed is worse than
  // no message at all.
  console.error(`\nBuild failed: ${result.error?.message ?? `exit code ${result.status}`}\n`);
  process.exit(result.status ?? 1);
}

const releaseDir = join(root, 'packages/desktop/release');
const artifacts = readdirSync(releaseDir)
  .filter((f) => f.endsWith('.exe'))
  .map((f) => ({ name: f, size: statSync(join(releaseDir, f)).size }))
  .sort((a, b) => a.name.localeCompare(b.name));

console.log(`\n\x1b[1mReady — pointing at ${serverUrl}\x1b[0m\n`);
for (const artifact of artifacts) {
  console.log(`  ${artifact.name.padEnd(36)} ${(artifact.size / 1048576).toFixed(1)} MB`);
}
console.log(`\n  ${releaseDir}\n`);
console.log(
  '  Setup   — the normal installer: shortcuts, uninstall entry, wardogs-voip:// links.\n' +
    '  Portable — single exe, no install. Handy for a quick try.\n\n' +
    '  The build is unsigned, so Windows SmartScreen will warn on first run.\n' +
    '  Players click "More info" then "Run anyway". See README for signing.\n',
);
