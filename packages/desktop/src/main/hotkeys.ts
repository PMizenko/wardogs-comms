import type { Binding, HotkeyAction } from '../common/settings.js';
import type { HotkeyEvent } from '../common/ipc.js';
import { settings } from './settings.js';

/**
 * Global push-to-talk.
 *
 * Electron's own globalShortcut only reports key *presses*, which is useless
 * for PTT - we need the release too. So this uses a native input hook that sees
 * key and mouse events system-wide, including while the game has focus.
 *
 * The hook is loaded lazily and every failure is survivable: if the native
 * module will not load, the app still runs and simply tells the user that
 * push-to-talk is unavailable.
 */

type HookEvent = { keycode?: number; button?: number };
interface Uiohook {
  on(event: string, cb: (e: HookEvent) => void): void;
  start(): void;
  stop(): void;
}

const ACTIONS: HotkeyAction[] = ['squad', 'command', 'muteToggle', 'deafenToggle'];

/** Mouse buttons 1-3 stay untouchable; rebinding left-click would be cruel. */
const MIN_BINDABLE_MOUSE_BUTTON = 4;

class HotkeyManager {
  private hook: Uiohook | null = null;
  private keyLabels = new Map<number, string>();
  private emit: ((e: HotkeyEvent) => void) | null = null;
  private capture: ((b: Binding | null) => void) | null = null;
  /** Set while a text field has focus so typing does not open the radio. */
  private paused = false;
  /** Debounces OS key-repeat into one press / one release per action. */
  private readonly held = new Set<HotkeyAction>();

  available = false;
  loadError: string | null = null;

  async start(emit: (e: HotkeyEvent) => void): Promise<void> {
    this.emit = emit;
    if (this.hook) return;

    try {
      const mod = (await import('uiohook-napi')) as unknown as {
        uIOhook: Uiohook;
        UiohookKey: Record<string, number>;
      };
      this.hook = mod.uIOhook;
      this.buildLabels(mod.UiohookKey);

      this.hook.on('keydown', (e) => this.onInput('key', e.keycode ?? -1, true));
      this.hook.on('keyup', (e) => this.onInput('key', e.keycode ?? -1, false));
      this.hook.on('mousedown', (e) => this.onInput('mouse', e.button ?? -1, true));
      this.hook.on('mouseup', (e) => this.onInput('mouse', e.button ?? -1, false));

      this.hook.start();
      this.available = true;
      console.log('[wardogs] global input hook running');
    } catch (err) {
      this.hook = null;
      this.available = false;
      this.loadError = err instanceof Error ? err.message : String(err);
      console.error('[wardogs] global input hook unavailable:', this.loadError);
    }
  }

  stop(): void {
    try {
      this.hook?.stop();
    } catch {
      // Shutting down anyway.
    }
    this.hook = null;
    this.available = false;
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    // Release anything still held, or the net would stay open while typing.
    if (paused) this.releaseAll();
  }

  /** Resolve with the next input the user produces, or null if cancelled. */
  captureNext(): Promise<Binding | null> {
    this.capture?.(null);
    this.releaseAll();
    return new Promise((resolve) => {
      this.capture = resolve;
    });
  }

  cancelCapture(): void {
    this.capture?.(null);
    this.capture = null;
  }

  private releaseAll(): void {
    for (const action of this.held) this.emit?.({ action, pressed: false });
    this.held.clear();
  }

  private onInput(kind: 'key' | 'mouse', code: number, pressed: boolean): void {
    if (code < 0) return;

    // --- binding capture ---------------------------------------------------
    if (this.capture && pressed) {
      const resolve = this.capture;
      this.capture = null;

      // Escape means "leave it unbound".
      if (kind === 'key' && this.keyLabels.get(code) === 'Escape') {
        resolve(null);
        return;
      }
      if (kind === 'mouse' && code < MIN_BINDABLE_MOUSE_BUTTON) {
        // Ignore ordinary clicks and keep waiting.
        this.capture = resolve;
        return;
      }
      resolve(
        kind === 'key'
          ? { kind: 'key', code, label: this.labelFor(code) }
          : { kind: 'mouse', button: code, label: `Mouse ${code}` },
      );
      return;
    }
    if (this.capture) return;
    if (this.paused) return;

    // --- normal dispatch ---------------------------------------------------
    const bindings = settings.get().hotkeys;
    for (const action of ACTIONS) {
      const binding = bindings[action];
      if (!binding) continue;
      const matches =
        binding.kind === kind &&
        (binding.kind === 'key' ? binding.code === code : binding.button === code);
      if (!matches) continue;

      if (pressed) {
        if (this.held.has(action)) return; // key-repeat, already transmitting
        this.held.add(action);
      } else {
        if (!this.held.delete(action)) return;
      }
      this.emit?.({ action, pressed });
      return;
    }
  }

  private buildLabels(keys: Record<string, number>): void {
    for (const [name, code] of Object.entries(keys)) {
      if (typeof code !== 'number') continue;
      // First name wins: UiohookKey lists aliases after the canonical name.
      if (!this.keyLabels.has(code)) this.keyLabels.set(code, prettifyKeyName(name));
    }
  }

  private labelFor(code: number): string {
    return this.keyLabels.get(code) ?? `Key ${code}`;
  }
}

/** `ArrowLeft` -> `Arrow Left`, `F5` -> `F5`, `Numpad0` -> `Numpad 0`. */
function prettifyKeyName(name: string): string {
  return name
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

export const hotkeys = new HotkeyManager();
