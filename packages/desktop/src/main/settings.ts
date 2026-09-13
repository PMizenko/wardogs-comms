import { app } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mergeSettings, type Settings } from '../common/settings.js';
import type { DeepPartial } from '../common/ipc.js';

/**
 * Settings live in a single JSON file under the user-data directory.
 *
 * A hand-rolled store rather than a dependency: the payload is tiny, and the
 * one thing that genuinely matters - not corrupting the file if the machine
 * dies mid-write - is a three-line atomic rename.
 */
class SettingsStore {
  private readonly file = join(app.getPath('userData'), 'settings.json');
  private cache: Settings | null = null;
  private readonly listeners = new Set<(s: Settings) => void>();

  get(): Settings {
    if (this.cache) return this.cache;
    try {
      this.cache = mergeSettings(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      // Missing or unreadable file simply means first run.
      this.cache = mergeSettings(null);
    }
    return this.cache;
  }

  update(patch: DeepPartial<Settings>): Settings {
    const current = this.get();
    const next: Settings = {
      ...current,
      ...patch,
      audio: { ...current.audio, ...(patch.audio ?? {}) },
      hotkeys: { ...current.hotkeys, ...(patch.hotkeys ?? {}) },
      transmit: { ...current.transmit, ...(patch.transmit ?? {}) },
      overlay: { ...current.overlay, ...(patch.overlay ?? {}) },
    } as Settings;

    this.cache = next;
    this.persist(next);
    for (const listener of this.listeners) listener(next);
    return next;
  }

  onChange(listener: (s: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private persist(settings: Settings): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
      renameSync(tmp, this.file);
    } catch (err) {
      console.error('[wardogs] could not save settings:', err);
    }
  }
}

export const settings = new SettingsStore();
