import { useEffect, useState, type ReactNode } from 'react';
import type { HotkeyAction, OverlayCorner, TransmitMode } from '../../../common/settings.js';
import type { UpdateState } from '../../../common/ipc.js';
import { useApp } from '../state/store.js';
import { XIcon } from './Icons.js';

function Switch({ on, onChange }: { on: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      className="switch"
      data-on={on}
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
    />
  );
}

function Setting({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="setting">
      <div className="setting__label">
        <b>{title}</b>
        {hint && <span>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((option) => (
        <button
          key={option.value}
          data-on={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const HOTKEY_LABELS: Record<HotkeyAction, { title: string; hint: string }> = {
  squad: { title: 'Squad — push-to-talk', hint: 'Mluví jen tvůj squad.' },
  command: {
    title: 'Command — push-to-talk',
    hint: 'Jen pro velitele squadů. Má přednost před squad kanálem.',
  },
  muteToggle: { title: 'Přepnout mikrofon', hint: 'Rychlé ztlumení sebe sama.' },
  deafenToggle: { title: 'Přepnout zvuk', hint: 'Ztlumí i poslech.' },
};

function BindButton({ action }: { action: HotkeyAction }) {
  const binding = useApp((s) => s.settings.hotkeys[action]);
  const bindHotkey = useApp((s) => s.bindHotkey);
  const clearHotkey = useApp((s) => s.clearHotkey);
  const [listening, setListening] = useState(false);

  async function start() {
    setListening(true);
    try {
      await bindHotkey(action);
    } finally {
      setListening(false);
    }
  }

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 'none' }}>
      <button
        className={`btn btn--sm bind${listening ? ' bind--listening' : ''}${
          binding ? '' : ' bind--unset'
        }`}
        onClick={() => void start()}
      >
        {listening ? 'Stiskni klávesu…' : (binding?.label ?? 'Nenastaveno')}
      </button>
      {binding && !listening && (
        <button
          className="icon-btn"
          title="Zrušit"
          onClick={() => void clearHotkey(action)}
        >
          <XIcon size={12} />
        </button>
      )}
    </div>
  );
}

/**
 * Releases ship with a server address baked in, so this is here for the people
 * running their own - changing it signs you out, because the session token only
 * means something on the server that issued it.
 */
function ServerSetting() {
  const serverUrl = useApp((s) => s.settings.serverUrl);
  const setServerUrl = useApp((s) => s.setServerUrl);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(serverUrl);

  if (!editing) {
    return (
      <button
        className="btn btn--sm btn--ghost"
        onClick={() => {
          setDraft(serverUrl);
          setEditing(true);
        }}
      >
        Změnit
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 6, flex: 'none', width: 260 }}>
      <input
        className="input"
        style={{ padding: '6px 9px', fontSize: 12 }}
        value={draft}
        autoFocus
        spellCheck={false}
        onFocus={() => window.wardogs.pauseHotkeys(true)}
        onBlur={() => window.wardogs.pauseHotkeys(false)}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false);
          if (e.key === 'Enter') {
            void setServerUrl(draft);
            setEditing(false);
          }
        }}
      />
      <button
        className="btn btn--sm"
        onClick={() => {
          void setServerUrl(draft);
          setEditing(false);
        }}
      >
        OK
      </button>
    </div>
  );
}

function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return '';
  const mb = bytesPerSecond / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.round(bytesPerSecond / 1024)} kB/s`;
}

/**
 * Update check, download and install.
 *
 * Download is a separate click on purpose: 80 MB arriving unannounced during a
 * match is not a favour. Nothing restarts until the player says so.
 */
function UpdateSection({ version }: { version: string }) {
  const [state, setState] = useState<UpdateState>({ phase: 'idle' });

  useEffect(() => window.wardogs.onUpdateState(setState), []);

  const check = () => void window.wardogs.checkForUpdates().then(setState);

  return (
    <section>
      <h3 className="section__title">Aktualizace</h3>

      {state.phase === 'unsupported' ? (
        <div className="hint-box">{state.reason}</div>
      ) : (
        <>
          <Setting
            title="Verze"
            hint={
              state.phase === 'current'
                ? 'Máš nejnovější verzi.'
                : state.phase === 'available'
                  ? `K dispozici je ${state.version}.`
                  : state.phase === 'ready'
                    ? `Verze ${state.version} je stažená a čeká na restart.`
                    : state.phase === 'error'
                      ? state.message
                      : 'Wardogs VOIP'
            }
          >
            <span style={{ fontSize: 12, color: 'var(--text-faint)', flex: 'none' }}>
              v{version}
            </span>
          </Setting>

          {state.phase === 'downloading' && (
            <div style={{ padding: '10px 0' }}>
              <div
                style={{
                  height: 6,
                  borderRadius: 3,
                  background: 'var(--panel-3)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${state.percent}%`,
                    height: '100%',
                    background: 'var(--gold)',
                    transition: 'width 0.2s',
                  }}
                />
              </div>
              <div
                style={{
                  marginTop: 6,
                  fontSize: 11,
                  color: 'var(--text-faint)',
                  display: 'flex',
                  justifyContent: 'space-between',
                }}
              >
                <span>Stahuji… {state.percent} %</span>
                <span>{formatSpeed(state.bytesPerSecond)}</span>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, paddingTop: 10 }}>
            {state.phase === 'ready' ? (
              <button
                className="btn btn--primary btn--sm"
                onClick={() => void window.wardogs.installUpdate()}
              >
                Restartovat a nainstalovat
              </button>
            ) : state.phase === 'available' ? (
              <button
                className="btn btn--primary btn--sm"
                onClick={() => void window.wardogs.downloadUpdate()}
              >
                Stáhnout {state.version}
              </button>
            ) : (
              <button
                className="btn btn--sm"
                disabled={state.phase === 'checking' || state.phase === 'downloading'}
                onClick={check}
              >
                {state.phase === 'checking' ? 'Kontroluji…' : 'Zkontrolovat aktualizace'}
              </button>
            )}

            {(state.phase === 'available' || state.phase === 'error') && (
              <button className="btn btn--ghost btn--sm" onClick={check}>
                Zkusit znovu
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export function SettingsDrawer() {
  const open = useApp((s) => s.settingsOpen);
  const openSettings = useApp((s) => s.openSettings);
  const settings = useApp((s) => s.settings);
  const patch = useApp((s) => s.patchSettings);
  const devices = useApp((s) => s.devices);
  const refreshDevices = useApp((s) => s.refreshDevices);
  const hotkeysAvailable = useApp((s) => s.hotkeysAvailable);
  const signOut = useApp((s) => s.signOut);
  const user = useApp((s) => s.user);

  const [version, setVersion] = useState('');

  useEffect(() => {
    if (!open) return;
    void refreshDevices();
    void window.wardogs.appInfo().then((info) => setVersion(info.version));
  }, [open, refreshDevices]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') openSettings(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, openSettings]);

  if (!open) return null;

  const { audio, transmit, overlay } = settings;

  return (
    <div className="drawer-backdrop" onClick={() => openSettings(false)}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer__head">
          <h2 className="drawer__title">Nastavení</h2>
          <button className="icon-btn" onClick={() => openSettings(false)} aria-label="Zavřít">
            <XIcon size={16} />
          </button>
        </header>

        <div className="drawer__body">
          <section>
            <h3 className="section__title">Klávesy</h3>
            {!hotkeysAvailable && (
              <div className="hint-box" style={{ marginBottom: 12 }}>
                Nepodařilo se spustit systémový odchyt kláves. Push-to-talk bude fungovat jen
                když je okno aplikace aktivní — ve hře ne. Zkus aplikaci spustit znovu, na
                Linuxu je potřeba přístup k <code>/dev/input</code>.
              </div>
            )}
            {(Object.keys(HOTKEY_LABELS) as HotkeyAction[]).map((action) => (
              <Setting
                key={action}
                title={HOTKEY_LABELS[action].title}
                hint={HOTKEY_LABELS[action].hint}
              >
                <BindButton action={action} />
              </Setting>
            ))}
          </section>

          <section>
            <h3 className="section__title">Režim vysílání</h3>
            <Setting title="Squad kanál" hint="Otevřený mikrofon pustí do éteru vše.">
              <Segmented<TransmitMode>
                value={transmit.squad}
                options={[
                  { value: 'ptt', label: 'PTT' },
                  { value: 'open', label: 'Otevřený' },
                ]}
                onChange={(next) =>
                  void patch({
                    transmit: {
                      squad: next,
                      // Only one net can sit open; two open mics would put you
                      // on the air twice.
                      command: next === 'open' ? 'ptt' : transmit.command,
                    },
                  })
                }
              />
            </Setting>
            <Setting title="Command kanál" hint="Drženou klávesou přebije squad kanál.">
              <Segmented<TransmitMode>
                value={transmit.command}
                options={[
                  { value: 'ptt', label: 'PTT' },
                  { value: 'open', label: 'Otevřený' },
                ]}
                onChange={(next) =>
                  void patch({
                    transmit: {
                      command: next,
                      squad: next === 'open' ? 'ptt' : transmit.squad,
                    },
                  })
                }
              />
            </Setting>
          </section>

          <section>
            <h3 className="section__title">Zvuk</h3>
            <Setting title="Mikrofon">
              <select
                className="select"
                style={{ flex: 'none', width: 200 }}
                value={audio.inputDeviceId}
                onChange={(e) => void patch({ audio: { inputDeviceId: e.target.value } })}
              >
                <option value="default">Výchozí zařízení</option>
                {devices.inputs.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || 'Mikrofon'}
                  </option>
                ))}
              </select>
            </Setting>

            <Setting title="Sluchátka">
              <select
                className="select"
                style={{ flex: 'none', width: 200 }}
                value={audio.outputDeviceId}
                onChange={(e) => void patch({ audio: { outputDeviceId: e.target.value } })}
              >
                <option value="default">Výchozí zařízení</option>
                {devices.outputs.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || 'Výstup'}
                  </option>
                ))}
              </select>
            </Setting>

            <Setting title="Hlasitost poslechu">
              <input
                className="range"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={audio.outputVolume}
                onChange={(e) =>
                  void patch({ audio: { outputVolume: Number(e.target.value) } })
                }
              />
            </Setting>

            <Setting
              title="Přednost velitele"
              hint="Když mluví velitel squadu nebo platoonu, ostatní hlasy ztichnou."
            >
              <Switch
                on={audio.duckOnCommand}
                onChange={(on) => void patch({ audio: { duckOnCommand: on } })}
              />
            </Setting>

            {audio.duckOnCommand && (
              <Setting
                title="Na jak potichu"
                hint={`Ostatní klesnou na ${Math.round(audio.duckLevel * 100)} % — na nule je neuslyšíš vůbec.`}
              >
                <input
                  className="range"
                  type="range"
                  min={0}
                  max={0.6}
                  step={0.05}
                  value={audio.duckLevel}
                  onChange={(e) => void patch({ audio: { duckLevel: Number(e.target.value) } })}
                />
              </Setting>
            )}

            <Setting title="Potlačení šumu" hint="Ticho mezi větami, ale ukousne tiché hlasy.">
              <Switch
                on={audio.noiseSuppression}
                onChange={(on) => void patch({ audio: { noiseSuppression: on } })}
              />
            </Setting>
            <Setting title="Potlačení ozvěny" hint="Nech zapnuté, pokud hraješ na reproduktory.">
              <Switch
                on={audio.echoCancellation}
                onChange={(on) => void patch({ audio: { echoCancellation: on } })}
              />
            </Setting>
            <Setting title="Automatická hlasitost">
              <Switch
                on={audio.autoGainControl}
                onChange={(on) => void patch({ audio: { autoGainControl: on } })}
              />
            </Setting>
          </section>

          <section>
            <h3 className="section__title">Overlay ve hře</h3>
            <div className="hint-box" style={{ marginBottom: 12 }}>
              Overlay se kreslí jen přes hru v režimu okno nebo bez okrajů. V exkluzivním
              fullscreenu ho Windows nepustí nahoru.
            </div>
            <Setting title="Zobrazovat overlay">
              <Switch
                on={overlay.enabled}
                onChange={(on) => void patch({ overlay: { enabled: on } })}
              />
            </Setting>
            <Setting title="Roh obrazovky">
              <Segmented<OverlayCorner>
                value={overlay.corner}
                options={[
                  { value: 'tl', label: '↖' },
                  { value: 'tr', label: '↗' },
                  { value: 'bl', label: '↙' },
                  { value: 'br', label: '↘' },
                ]}
                onChange={(corner) => void patch({ overlay: { corner } })}
              />
            </Setting>
            <Setting title="Velikost">
              <input
                className="range"
                type="range"
                min={0.8}
                max={1.6}
                step={0.1}
                value={overlay.scale}
                onChange={(e) => void patch({ overlay: { scale: Number(e.target.value) } })}
              />
            </Setting>
            <Setting title="Skrýt, když je klid" hint="Objeví se až když někdo mluví.">
              <Switch
                on={overlay.hideWhenIdle}
                onChange={(on) => void patch({ overlay: { hideWhenIdle: on } })}
              />
            </Setting>
          </section>

          <section>
            <h3 className="section__title">Účet</h3>
            <Setting title="Přihlášen" hint={user?.name ?? '—'}>
              <button className="btn btn--sm btn--danger" onClick={() => void signOut()}>
                Odhlásit
              </button>
            </Setting>
            <Setting
              title="Server"
              hint={`${settings.serverUrl} — změna tě odhlásí`}
            >
              <ServerSetting />
            </Setting>
          </section>

          <UpdateSection version={version} />
        </div>
      </aside>
    </div>
  );
}
