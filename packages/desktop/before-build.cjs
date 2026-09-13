// @ts-check
'use strict';

const { cpSync, existsSync, mkdirSync, readFileSync, rmSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { createRequire } = require('node:module');

/**
 * Stages runtime dependencies into the app directory, then tells
 * electron-builder not to install anything itself.
 *
 * Why: electron-builder's own "install production dependencies" step runs an
 * npm install inside this package. In an npm workspace npm treats that as a
 * workspace-wide operation and prunes the hoisted root node_modules - which
 * deletes electron-builder itself, mid-build. Returning false from this hook
 * skips that step, so we hand it a ready-made node_modules instead.
 *
 * Only packages that must exist as real files at runtime belong here: the
 * native key hook, and the updater (which reads app-update.yml and spawns the
 * installer, so it does not survive bundling). Everything else is bundled into
 * out/ by electron-vite and never looked up on disk.
 */
const RUNTIME_PACKAGES = ['uiohook-napi', 'electron-updater'];

/** Walks `dependencies` so a staged package arrives with everything it needs. */
function collect(name, require_, seen) {
  if (seen.has(name)) return;

  let packageJsonPath;
  try {
    packageJsonPath = require_.resolve(`${name}/package.json`);
  } catch (err) {
    // Some packages hide package.json behind an export map; fall back to the
    // directory the main entry lives in.
    try {
      packageJsonPath = join(dirname(require_.resolve(name)), 'package.json');
    } catch {
      throw new Error(
        `Cannot stage dependency "${name}": ${err.message}\n` +
          'Run npm install at the repo root first.',
      );
    }
  }

  seen.set(name, dirname(packageJsonPath));

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return;
  }
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    collect(dependency, require_, seen);
  }
}

module.exports = async function beforeBuild(context) {
  const appDir = context.appDir;
  const target = join(appDir, 'node_modules');
  const require_ = createRequire(join(appDir, 'noop.js'));

  /** @type {Map<string, string>} package name -> source directory */
  const packages = new Map();
  for (const name of RUNTIME_PACKAGES) collect(name, require_, packages);

  for (const [name, source] of packages) {
    const destination = join(target, name);
    if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
    mkdirSync(dirname(destination), { recursive: true });
    // Skip nested node_modules: every dependency is staged flat alongside.
    cpSync(source, destination, {
      recursive: true,
      dereference: true,
      filter: (src) => !src.includes(`${destination}${require('node:path').sep}node_modules`),
    });
  }

  console.log(`  • staged runtime dependencies  count=${packages.size}`);

  // false => electron-builder skips dependency installation entirely.
  return false;
};
