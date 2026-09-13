import { useState } from 'react';
import { useApp } from '../state/store.js';
import { ArrowIcon, RadioIcon } from './Icons.js';

/**
 * Where a player lands after signing in: open a platoon, or join one with the
 * six-character code somebody read out over comms.
 */
export function LobbyScreen() {
  const user = useApp((s) => s.user);
  const status = useApp((s) => s.status);
  const createPlatoon = useApp((s) => s.createPlatoon);
  const joinPlatoon = useApp((s) => s.joinPlatoon);

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const offline = status !== 'online';

  const holdKeys = {
    onFocus: () => window.wardogs.pauseHotkeys(true),
    onBlur: () => window.wardogs.pauseHotkeys(false),
  };

  return (
    <div className="centered">
      <div className="hero">
        <p className="eyebrow" style={{ marginBottom: 6 }}>
          {user ? `Přihlášen jako ${user.name}` : 'Připojuji…'}
        </p>
        <h1 className="hero__logo" style={{ fontSize: 24 }}>
          Připrav <b>platoon</b>
        </h1>
        <p className="hero__tag">Čtyři squady, jeden velitelský kanál.</p>

        <div className="lobby-grid">
          <div className="card">
            <h2 className="card__title">Založit platoon</h2>
            <div className="field">
              <label className="field__label" htmlFor="platoon-name">
                Název
              </label>
              <input
                id="platoon-name"
                className="input"
                placeholder="Např. Sobotní zápas"
                value={name}
                maxLength={40}
                {...holdKeys}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !offline) createPlatoon(name);
                }}
              />
            </div>
            <button
              className="btn btn--primary"
              style={{ width: '100%', marginTop: 14 }}
              disabled={offline}
              onClick={() => createPlatoon(name)}
            >
              <RadioIcon size={15} />
              Otevřít platoon
            </button>
            <p style={{ fontSize: 11, color: 'var(--text-faint)', margin: '10px 0 0' }}>
              Staneš se velitelem platoonu a dostaneš kód pro ostatní.
            </p>
          </div>

          <div className="card">
            <h2 className="card__title">Připojit se</h2>
            <div className="field">
              <label className="field__label" htmlFor="platoon-code">
                Kód platoonu
              </label>
              <input
                id="platoon-code"
                className="input code-input"
                placeholder="······"
                value={code}
                maxLength={6}
                spellCheck={false}
                {...holdKeys}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && code.length === 6 && !offline) joinPlatoon(code);
                }}
              />
            </div>
            <button
              className="btn"
              style={{ width: '100%', marginTop: 14 }}
              disabled={code.length !== 6 || offline}
              onClick={() => joinPlatoon(code)}
            >
              <ArrowIcon size={15} />
              Připojit
            </button>
            <p style={{ fontSize: 11, color: 'var(--text-faint)', margin: '10px 0 0' }}>
              Squad si vybereš hned po připojení.
            </p>
          </div>
        </div>

        {offline && (
          <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: 18 }}>
            Není spojení s řídicím serverem — zkouším znovu…
          </p>
        )}
      </div>
    </div>
  );
}
