import { useEffect, useState } from 'react';
import { SQUAD_SIZE_MAX, SQUAD_SIZE_MIN, type PlatoonState } from '@wardogs/shared';
import { useApp } from '../state/store.js';
import { LockIcon } from './Icons.js';

/**
 * Platoon-leader controls, shown only to them.
 *
 * Everything here changes how other people can get in, so it sits in the open
 * next to the join code rather than behind a settings drawer.
 */
export function PlatoonAdminBar({ platoon }: { platoon: PlatoonState }) {
  const setSquadSize = useApp((s) => s.setSquadSize);
  const setPlatoonPassword = useApp((s) => s.setPlatoonPassword);
  const setPlatoonListed = useApp((s) => s.setPlatoonListed);

  const [size, setSize] = useState(String(platoon.squadSize));
  const [editingPassword, setEditingPassword] = useState(false);
  const [password, setPassword] = useState('');

  // Follow the server, which is the authority - somebody else may be leader now.
  useEffect(() => setSize(String(platoon.squadSize)), [platoon.squadSize]);

  const holdKeys = {
    onFocus: () => window.wardogs.pauseHotkeys(true),
    onBlur: () => window.wardogs.pauseHotkeys(false),
  };

  function commitSize(raw: string) {
    const next = Number(raw);
    if (!Number.isInteger(next) || next < SQUAD_SIZE_MIN || next > SQUAD_SIZE_MAX) {
      setSize(String(platoon.squadSize));
      return;
    }
    if (next !== platoon.squadSize) setSquadSize(next);
  }

  return (
    <div className="admin-bar">
      <span className="eyebrow">Velitel platoonu</span>

      <label className="admin-bar__item">
        <span>Lidí ve squadu</span>
        <input
          className="input admin-bar__number"
          type="number"
          min={SQUAD_SIZE_MIN}
          max={SQUAD_SIZE_MAX}
          value={size}
          {...holdKeys}
          onChange={(e) => setSize(e.target.value)}
          onBlur={(e) => {
            commitSize(e.target.value);
            window.wardogs.pauseHotkeys(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitSize((e.target as HTMLInputElement).value);
          }}
        />
        <span className="admin-bar__hint">
          max {SQUAD_SIZE_MAX} · zmenšení nikoho nevyhodí
        </span>
      </label>

      <div className="admin-bar__item">
        <span>Heslo</span>
        {editingPassword ? (
          <>
            <input
              className="input admin-bar__password"
              type="password"
              placeholder="Nové heslo"
              value={password}
              autoFocus
              maxLength={64}
              {...holdKeys}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setEditingPassword(false);
                  setPassword('');
                }
                if (e.key === 'Enter' && password.trim()) {
                  setPlatoonPassword(password.trim());
                  setEditingPassword(false);
                  setPassword('');
                }
              }}
            />
            <button
              className="btn btn--sm"
              disabled={!password.trim()}
              onClick={() => {
                setPlatoonPassword(password.trim());
                setEditingPassword(false);
                setPassword('');
              }}
            >
              Nastavit
            </button>
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setEditingPassword(false);
                setPassword('');
              }}
            >
              Zrušit
            </button>
          </>
        ) : (
          <>
            <span className={`admin-bar__state${platoon.hasPassword ? ' is-on' : ''}`}>
              {platoon.hasPassword ? (
                <>
                  <LockIcon size={12} /> zamčeno
                </>
              ) : (
                'bez hesla'
              )}
            </span>
            <button className="btn btn--sm" onClick={() => setEditingPassword(true)}>
              {platoon.hasPassword ? 'Změnit' : 'Nastavit'}
            </button>
            {platoon.hasPassword && (
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => setPlatoonPassword('')}
              >
                Odemknout
              </button>
            )}
          </>
        )}
      </div>

      <label className="admin-bar__item">
        <span>Ve veřejném seznamu</span>
        <button
          className="switch"
          data-on={platoon.listed}
          role="switch"
          aria-checked={platoon.listed}
          onClick={() => setPlatoonListed(!platoon.listed)}
        />
        <span className="admin-bar__hint">
          {platoon.listed ? 'Kdokoli tě najde' : 'Jen přes kód'}
        </span>
      </label>
    </div>
  );
}
