import { useEffect, useState } from 'react';
import { useApp } from '../state/store.js';
import { DiscordIcon } from './Icons.js';

interface ServerConfig {
  discord: boolean;
  devLogin: boolean;
}

export function SignInScreen() {
  const signIn = useApp((s) => s.signIn);
  const busy = useApp((s) => s.busy);
  const serverUrl = useApp((s) => s.settings.serverUrl);
  const patchSettings = useApp((s) => s.patchSettings);

  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [showServer, setShowServer] = useState(false);
  const [draft, setDraft] = useState(serverUrl);
  const [devName, setDevName] = useState('');

  // Ask the server which sign-in methods it offers, so the UI never advertises
  // a button that is going to fail.
  useEffect(() => {
    let cancelled = false;
    setReachable(null);
    fetch(`${serverUrl.replace(/\/$/, '')}/config`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((value: ServerConfig) => {
        if (cancelled) return;
        setConfig(value);
        setReachable(true);
      })
      .catch(() => {
        if (cancelled) return;
        setConfig(null);
        setReachable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serverUrl]);

  const holdKeys = {
    onFocus: () => window.wardogs.pauseHotkeys(true),
    onBlur: () => window.wardogs.pauseHotkeys(false),
  };

  return (
    <div className="centered">
      <div className="hero">
        <h1 className="hero__logo">
          <b>Wardogs</b> VOIP
        </h1>
        <p className="hero__tag">Same team. Better coordination. More game.</p>

        <div className="card" style={{ textAlign: 'center' }}>
          {reachable === false && (
            <div className="hint-box" style={{ marginBottom: 16, textAlign: 'left' }}>
              Server <b>{serverUrl}</b> neodpovídá. Zkontroluj, že běží, nebo níže nastav jinou
              adresu.
            </div>
          )}

          <p style={{ margin: '0 0 18px', color: 'var(--text-dim)' }}>
            Přihlas se Discordem. Aplikace otevře tvůj prohlížeč — heslo zadáváš jen Discordu,
            sem se vrátí pouze potvrzená identita.
          </p>

          <button
            className="btn btn--primary"
            onClick={() => void signIn()}
            disabled={busy || config?.discord === false}
            title={
              config?.discord === false ? 'Server nemá nakonfigurovaný Discord OAuth' : undefined
            }
          >
            <DiscordIcon size={16} />
            {busy ? 'Otevírám prohlížeč…' : 'Přihlásit se přes Discord'}
          </button>

          {config?.devLogin && (
            <div
              style={{
                marginTop: 22,
                paddingTop: 18,
                borderTop: '1px solid var(--line-soft)',
                textAlign: 'left',
              }}
            >
              <span className="eyebrow">Testovací režim serveru</span>
              <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: '6px 0 10px' }}>
                Server běží s <code>ALLOW_DEV_LOGIN</code>. Přihlas se jménem bez ověření — jen
                pro lokální testování.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="input"
                  placeholder="Přezdívka"
                  value={devName}
                  maxLength={24}
                  {...holdKeys}
                  onChange={(e) => setDevName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && devName.trim()) {
                      void window.wardogs.startDevSignIn(devName.trim());
                    }
                  }}
                />
                <button
                  className="btn"
                  disabled={!devName.trim()}
                  onClick={() => void window.wardogs.startDevSignIn(devName.trim())}
                >
                  Vstoupit
                </button>
              </div>
            </div>
          )}

          <div style={{ marginTop: 22 }}>
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setDraft(serverUrl);
                setShowServer((v) => !v);
              }}
            >
              {showServer ? 'Skrýt nastavení serveru' : 'Připojit k jinému serveru'}
            </button>
          </div>

          {showServer && (
            <div className="field" style={{ marginTop: 14, textAlign: 'left' }}>
              <label className="field__label" htmlFor="server-url">
                Adresa řídicího serveru
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  id="server-url"
                  className="input"
                  value={draft}
                  spellCheck={false}
                  placeholder="https://voip.wardogs.gg"
                  {...holdKeys}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <button
                  className="btn"
                  disabled={!draft.trim() || draft.trim() === serverUrl}
                  onClick={() => void patchSettings({ serverUrl: draft.trim() })}
                >
                  Uložit
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
