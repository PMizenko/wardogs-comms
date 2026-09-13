/**
 * Cuts a release: bumps the version, builds, and uploads to GitHub Releases.
 *
 * Installed copies find it through app-update.yml, which electron-builder
 * writes into the package from the `publish` block in electron-builder.yml.
 *
 * Run:  npm run publish:release -- 0.2.0
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = join(root, 'packages/desktop');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const version = args.find((a) => !a.startsWith('--'));

function die(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function run(command, options = {}) {
  return spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', ...options });
}

// --- what are we publishing, and where ------------------------------------

if (!version) {
  die(
    'Which version?\n' +
      '  npm run publish:release -- 0.2.0\n\n' +
      'Use a higher number than the last release, or installed copies will not\n' +
      'see it as an update.',
  );
}
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  die(`"${version}" is not a version number. Expected something like 0.2.0.`);
}

/**
 * Pull owner/repo out of the publish block. A regex rather than a YAML parser:
 * it is two fixed keys, and this script should not need a dependency to run.
 */
const builderYml = readFileSync(join(desktopDir, 'electron-builder.yml'), 'utf8');
const owner = builderYml.match(/^\s{2}owner:\s*(\S+)/m)?.[1];
const repo = builderYml.match(/^\s{2}repo:\s*(\S+)/m)?.[1];
if (!owner || !repo) {
  die('electron-builder.yml has no publish.owner / publish.repo.');
}
const slug = `${owner}/${repo}`;

/**
 * A client configured for draft releases hunts for drafts, which needs a token
 * no player will ever have. Catch it here rather than in the field.
 */
if (/^\s{2}releaseType:\s*draft/m.test(builderYml)) {
  die(
    'publish.releaseType is "draft" in electron-builder.yml.\n' +
      'That value is copied into app-update.yml inside the app, so every client\n' +
      'built from it would look for draft releases and find nothing.\n' +
      'Set it to "release".',
  );
}

const serverUrl = (() => {
  if (process.env.WARDOGS_SERVER_URL) return process.env.WARDOGS_SERVER_URL.trim();
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) return '';
  const match = readFileSync(envPath, 'utf8').match(/^\s*WARDOGS_SERVER_URL\s*=\s*(.+)$/m);
  return match?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
})();

if (!serverUrl) die('No WARDOGS_SERVER_URL. Set it in .env before publishing.');
if (/localhost|127\.0\.0\.1/.test(serverUrl)) {
  die(
    `Refusing to publish a build pointing at ${serverUrl}.\n` +
      'Nobody but you could connect to it.',
  );
}

// --- preflight -------------------------------------------------------------

const token =
  process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? run('gh auth token').stdout?.trim();
if (!token) {
  die('No GitHub token. Sign in with `gh auth login`, or set GH_TOKEN.');
}

const repoCheck = run(`gh repo view ${slug} --json name`, { stdio: 'pipe' });
if (repoCheck.status !== 0) {
  die(
    `Repository ${slug} is not reachable.\n` +
      `Create it first:\n  gh repo create ${slug} --public --source . --push`,
  );
}

const existing = run(`gh release view v${version} --repo ${slug} --json tagName`, {
  stdio: 'pipe',
});
if (existing.status === 0) {
  die(
    `Release v${version} already exists in ${slug}.\n` +
      'Pick a higher version - re-uploading over a published release breaks\n' +
      'clients that already downloaded it.',
  );
}

const dirty = run('git status --porcelain', { stdio: 'pipe' }).stdout?.trim();
if (dirty) {
  console.warn(
    '\n  Warning: uncommitted changes. The build uses your working tree, so\n' +
      '  whatever is on disk right now is what ships.\n',
  );
}

// --- bump ------------------------------------------------------------------

const manifestPath = join(desktopDir, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const previous = manifest.version;

console.log(`\n\x1b[1mPublishing ${slug} v${version}\x1b[0m`);
console.log(`  server:  ${serverUrl}`);
console.log(`  version: ${previous} -> ${version}`);
if (dryRun) {
  console.log('\n  --dry-run: stopping before build.\n');
  process.exit(0);
}

manifest.version = version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const result = spawnSync('npm run build:shared && npm run publish -w @wardogs/desktop', {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    WARDOGS_SERVER_URL: serverUrl,
    GH_TOKEN: token,
  },
});

if (result.error || result.status !== 0) {
  // Put the version back so a failed run does not leave a half-bumped tree.
  manifest.version = previous;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  die(`Build failed: ${result.error?.message ?? `exit code ${result.status}`}`);
}

// A run interrupted mid-upload can leave the release as a draft. Installed
// copies ignore drafts, so one left behind reaches nobody.
const draftCheck = run(`gh release view v${version} --repo ${slug} --json isDraft -q .isDraft`, {
  stdio: 'pipe',
});
if (draftCheck.stdout?.trim() === 'true') {
  const published = run(`gh release edit v${version} --repo ${slug} --draft=false`, {
    stdio: 'pipe',
  });
  if (published.status !== 0) {
    console.warn(
      '\n  Uploaded, but the release is still a draft and could not be published:\n' +
        `  ${published.stderr?.trim()}\n\n` +
        '  Publish it by hand, or nobody will see the update:\n' +
        `    gh release edit v${version} --repo ${slug} --draft=false\n`,
    );
  }
}

console.log(
  `\n\x1b[32mPublished v${version}\x1b[0m\n\n` +
    `  https://github.com/${slug}/releases/tag/v${version}\n\n` +
    '  Installed copies will find it on their next check.\n',
);

console.log(
  '  Record it in git:\n' +
    `    git commit -am "Release v${version}" && git tag v${version} && git push --follow-tags\n`,
);
