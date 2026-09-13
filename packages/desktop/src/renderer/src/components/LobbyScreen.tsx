import { useEffect, useState } from 'react';
import type { PlatoonSummary } from '@wardogs/shared';
import { useApp } from '../state/store.js';
import { ArrowIcon, LockIcon, RadioIcon, RefreshIcon } from './Icons.js';

const holdKeys = {
  onFocus: () => window.wardogs.pauseHotkeys(true),
  onBlur: () => window.wardogs.pauseHotkeys(false),
};

function age(createdAt: number): string {
  const minutes = Math.floor((Date.now() - createdAt) / 60000);
  if (minutes < 1) return 'právě teď';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h`;
}

/** One platoon in the browser. A locked one asks for the password in place. */
function BrowserRow({ platoon, offline }: { platoon: PlatoonSummary; offline: boolean }) {
  const joinById = useApp((s) => s.joinPlatoonById);
  const [unlocking, setUnlocking] = useState(false);
  const [password, setPassword] = useState('');

  const full = platoon.players >= platoon.capacity;

  function join() {
    joinById(platoon.id, password);
    setPassword('');
    setUnlocking(false);
  }

  return (
    <div className="browser__row">
      <div className="browser__main">
        <div className="browser__name">
          {platoon.hasPassword && <LockIcon size={12} />}
          {platoon.name}
        </div>
        <div className="browser__meta">
          {platoon.leaderName} · {platoon.players}/{platoon.capacity} · {age(platoon.createdAt)}
        </div>
      </div>

      {unlocking ? (
        <>
          <input
            className="input browser__password"
            type="password"
            placeholder="Heslo"
            value={password}
            autoFocus
            {...holdKeys}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && password) join();
              if (e.key === 'Escape') setUnlocking(false);
            }}
          />
          <button className="btn btn--sm" disabled={!password || offline} onClick={join}>
            Vstoupit
          </button>
        </>
      ) : (
        <button
          className="btn btn--sm"
          disabled={offline || full}
          onClick={() => (platoon.hasPassword ? setUnlocking(true) : join())}
        >
          {full ? 'Plno' : platoon.hasPassword ? 'Odemknout' : 'Připojit'}
        </button>
      )}
    </div>
  );
}

/**
 * Where a player lands after signing in: browse what is running, join with a
 * code, or open a platoon of their own.
 */
export function LobbyScreen() {
  const user = useApp((s) => s.user);
  const status = useApp((s) => s.status);
  const createPlatoon = useApp((s) => s.createPlatoon);
  const joinPlatoon = useApp((s) => s.joinPlatoon);
  const browser = useApp((s) => s.browser);
  const browserLoading = useApp((s) => s.browserLoading);
  const refreshBrowser = useApp((s) => s.refreshBrowser);

  const [name, setName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [listed, setListed] = useState(true);
  const [code, setCode] = useState('');
  const [joinPassword, setJoinPassword] = useState('');

  const offline = status !== 'online';

  // Refresh on arrival, then keep it current while the lobby is open - people
  // open platoons while you are looking at the list.
  useEffect(() => {
    if (offline) return;
    refreshBrowser();
    const timer = setInterval(refreshBrowser, 15000);
    return () => clearInterval(timer);
  }, [offline, refreshBrowser]);

  return (
    <div className="lobby">
      <div className="lobby__head">
        <p className="eyebrow">{user ? `Přihlášen jako ${user.name}` : 'Připojuji…'}</p>
        <h1 className="hero__logo" style={{ fontSize: 22, margin: '4px 0 0' }}>
          Připrav <b>platoon</b>
        </h1>
      </div>

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
                if (e.key === 'Enter' && !offline) {
                  createPlatoon(name, { password: newPassword, listed });
                }
              }}
            />
          </div>

          <div className="field" style={{ marginTop: 10 }}>
            <label className="field__label" htmlFor="platoon-password">
              Heslo — nepovinné
            </label>
            <input
              id="platoon-password"
              className="input"
              type="password"
              placeholder="Bez hesla se připojí kdokoli"
              value={newPassword}
              maxLength={64}
              {...holdKeys}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>

          <label className="lobby__switch">
            <button
              className="switch"
              data-on={listed}
              role="switch"
              aria-checked={listed}
              onClick={() => setListed((v) => !v)}
            />
            <span>
              Ve veřejném seznamu
              <small>{listed ? 'Ostatní tě uvidí v přehledu' : 'Jen pro ty, komu dáš kód'}</small>
            </span>
          </label>

          <button
            className="btn btn--primary"
            style={{ width: '100%', marginTop: 14 }}
            disabled={offline}
            onClick={() => createPlatoon(name, { password: newPassword, listed })}
          >
            <RadioIcon size={15} />
            Otevřít platoon
          </button>
        </div>

        <div className="card">
          <h2 className="card__title">Připojit se kódem</h2>
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
                if (e.key === 'Enter' && code.length === 6 && !offline) {
                  joinPlatoon(code, joinPassword);
                }
              }}
            />
          </div>

          <div className="field" style={{ marginTop: 10 }}>
            <label className="field__label" htmlFor="join-password">
              Heslo — jen když ho platoon má
            </label>
            <input
              id="join-password"
              className="input"
              type="password"
              placeholder="Nech prázdné, pokud není"
              value={joinPassword}
              maxLength={64}
              {...holdKeys}
              onChange={(e) => setJoinPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && code.length === 6 && !offline) {
                  joinPlatoon(code, joinPassword);
                }
              }}
            />
          </div>

          <button
            className="btn"
            style={{ width: '100%', marginTop: 14 }}
            disabled={code.length !== 6 || offline}
            onClick={() => joinPlatoon(code, joinPassword)}
          >
            <ArrowIcon size={15} />
            Připojit
          </button>
        </div>
      </div>

      <div className="browser">
        <div className="browser__head">
          <span className="eyebrow">Aktivní platoony ({browser.length})</span>
          <div style={{ flex: 1 }} />
          <button
            className="btn btn--ghost btn--sm"
            disabled={offline || browserLoading}
            onClick={refreshBrowser}
            title="Obnovit"
          >
            <RefreshIcon size={13} />
            {browserLoading ? 'Načítám…' : 'Obnovit'}
          </button>
        </div>

        {browser.length === 0 ? (
          <p className="browser__empty">
            {offline
              ? 'Bez spojení se serverem.'
              : 'Zatím nikdo nic neotevřel. Založ platoon a ostatní ho uvidí tady.'}
          </p>
        ) : (
          <div className="browser__list">
            {browser.map((platoon) => (
              <BrowserRow key={platoon.id} platoon={platoon} offline={offline} />
            ))}
          </div>
        )}
      </div>

      {offline && (
        <p style={{ color: 'var(--danger)', fontSize: 12, textAlign: 'center' }}>
          Není spojení s řídicím serverem — zkouším znovu…
        </p>
      )}
    </div>
  );
}
