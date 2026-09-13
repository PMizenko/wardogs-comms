import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';
import { platoons, type PlatoonSnapshot } from './manager.js';

/**
 * Parking live platoons across a restart.
 *
 * Without this, every deploy ends whatever match is in progress: the roster is
 * in memory, so a restart scatters everyone back to the lobby to re-type a join
 * code mid-firefight. The snapshot is deliberately short-lived - it exists to
 * survive a thirty-second restart, not to be a database.
 */

const file = resolve(process.cwd(), config.stateFile);

export function saveState(log: (message: string) => void): void {
  const snapshot = platoons.snapshot();
  if (snapshot.platoons.length === 0) {
    // Nothing to come back to; clear any older file so a restart later does not
    // resurrect a platoon from hours ago.
    try {
      rmSync(file, { force: true });
    } catch {
      // Not being able to delete it is not worth failing a shutdown over.
    }
    return;
  }

  try {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(snapshot), 'utf8');
    renameSync(temp, file);
    log(`parked ${snapshot.platoons.length} platoon(s) in ${config.stateFile}`);
  } catch (err) {
    log(`could not park platoon state: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function loadState(log: (message: string) => void): void {
  let snapshot: PlatoonSnapshot;
  try {
    snapshot = JSON.parse(readFileSync(file, 'utf8')) as PlatoonSnapshot;
  } catch {
    // No file, or unreadable. Either way there is nothing to restore.
    return;
  }

  // Always consume it: a snapshot replayed twice would resurrect players who
  // have since left.
  try {
    rmSync(file, { force: true });
  } catch {
    // Best effort.
  }

  const age = Date.now() - (snapshot.savedAt ?? 0);
  if (!Array.isArray(snapshot.platoons) || age > config.stateMaxAgeMs) {
    log(`ignoring a stale snapshot (${Math.round(age / 60000)} min old)`);
    return;
  }

  const restored = platoons.restore(snapshot);
  if (restored.players > 0) {
    log(
      `restored ${restored.platoons} platoon(s) with ${restored.players} player(s); ` +
        'they have a few minutes to reconnect before their slots are released',
    );
  }
}
