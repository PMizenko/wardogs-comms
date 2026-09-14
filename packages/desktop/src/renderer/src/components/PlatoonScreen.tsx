import { useMemo, useState, type CSSProperties } from 'react';
import {
  COMMAND_CHANNEL,
  MAX_SQUADS,
  MIN_SQUADS,
  playersInSquad,
  unassignedPlayers,
  type PlayerState,
} from '@wardogs/shared';
import { selectMe, selectVoiceHealth, useApp } from '../state/store.js';
import { SquadCard } from './SquadCard.js';
import { PlayerRow } from './PlayerRow.js';
import { PlatoonAdminBar } from './PlatoonAdminBar.js';
import { CopyIcon, ExitIcon, LockIcon } from './Icons.js';

export function PlatoonScreen() {
  const platoon = useApp((s) => s.platoon);
  const me = useApp(selectMe);
  const speaking = useApp((s) => s.speaking);
  const remoteTransmit = useApp((s) => s.remoteTransmit);
  const leavePlatoon = useApp((s) => s.leavePlatoon);
  const movePlayer = useApp((s) => s.movePlayer);
  const addSquad = useApp((s) => s.addSquad);
  const commandGrant = useApp((s) => s.grants.command);
  const squadHotkey = useApp((s) => s.settings.hotkeys.squad);
  const commandHotkey = useApp((s) => s.settings.hotkeys.command);
  const allcallHotkey = useApp((s) => s.settings.hotkeys.allcall);
  const allcallGrant = useApp((s) => s.grants.allcall);
  const openSettings = useApp((s) => s.openSettings);
  const voice = useApp(selectVoiceHealth);

  const [copied, setCopied] = useState(false);

  const speakingIds = useMemo(() => new Set(speaking.map((s) => s.id)), [speaking]);

  if (!platoon) return null;

  const canAdmin = me?.role === 'platoon_leader';
  // Four across is as many as stays readable; more squads wrap to a second row.
  const columns = Math.min(Math.max(platoon.squads.length, 1), 4);
  const bench = unassignedPlayers(platoon);

  // The command net: the platoon leader plus whoever holds each squad's slot.
  const onCommand: PlayerState[] = platoon.players
    .filter((p) => p.role === 'platoon_leader' || p.role === 'squad_leader')
    .sort((a, b) => {
      if (a.role === 'platoon_leader') return -1;
      if (b.role === 'platoon_leader') return 1;
      return (a.squadId ?? 9) - (b.squadId ?? 9);
    });

  const commandHot = onCommand.some(
    (p) => speakingIds.has(p.id) || remoteTransmit[p.id] === COMMAND_CHANNEL,
  );

  function copyCode() {
    void navigator.clipboard.writeText(platoon!.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <>
      <div className="platoon-head">
        <div style={{ minWidth: 0 }}>
          <h1 className="platoon-head__name">{platoon.name}</h1>
          <div className="platoon-head__meta">
            <span>{platoon.players.length} hráčů</span>
            <span>·</span>
            <span>{onCommand.length} na velitelském kanálu</span>
          </div>
        </div>

        <div style={{ flex: 1 }} />

        {platoon.hasPassword && (
          <span className="lock-chip" title="Platoon je chráněný heslem">
            <LockIcon size={12} />
          </span>
        )}

        <button className="code-chip" onClick={copyCode} title="Zkopírovat kód">
          {platoon.code}
          <CopyIcon size={13} />
        </button>
        {copied && <span style={{ fontSize: 11, color: 'var(--ok)' }}>Zkopírováno</span>}

        <button className="btn btn--ghost btn--danger btn--sm" onClick={leavePlatoon}>
          <ExitIcon size={13} />
          Opustit
        </button>
      </div>

      {voice === 'down' && (
        <div className="alarm">
          <strong>Nejsi připojený k hlasovému serveru.</strong> Roster vidíš, ale
          nikdo tě neslyší a ty neslyšíš nikoho. Zkouším se připojit dál — pokud to
          nepřestane, je mimo hlasový server, ne ty.
        </div>
      )}

      {canAdmin && <PlatoonAdminBar platoon={platoon} />}

      <section className={`command${commandHot ? ' command--hot' : ''}`}>
        <header className="command__head">
          <span className="dot" style={{ color: 'var(--gold)' }} />
          <span className="command__title">Platoon / Command</span>
          <div style={{ flex: 1 }} />
          <span className="command__sub">Squad leaders only</span>
        </header>

        {onCommand.length === 0 ? (
          <div className="command__empty">
            Zatím tu nikdo není. Velitelé squadů se sem připojí automaticky.
          </div>
        ) : (
          onCommand.map((player) => (
            <PlayerRow
              key={player.id}
              player={player}
              isMe={player.id === me?.id}
              speaking={speakingIds.has(player.id)}
              transmitting={remoteTransmit[player.id] === COMMAND_CHANNEL}
              canAdmin={false}
            />
          ))
        )}

        {allcallGrant?.canPublish && (
          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-faint)' }}>
            {allcallHotkey ? (
              <>
                Všem najednou: <b style={{ color: 'var(--danger)' }}>{allcallHotkey.label}</b>
              </>
            ) : (
              <button className="btn btn--sm" onClick={() => openSettings(true)}>
                Nastav klávesu pro all-call
              </button>
            )}
          </div>
        )}

        {commandGrant && (
          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-faint)' }}>
            {commandHotkey ? (
              <>
                Velitelský kanál: <b style={{ color: 'var(--gold)' }}>{commandHotkey.label}</b>
              </>
            ) : (
              <button className="btn btn--sm" onClick={() => openSettings(true)}>
                Nastav klávesu pro velitelský kanál
              </button>
            )}
          </div>
        )}
      </section>

      <div className="net-tree" aria-hidden="true">
        {/* One line per squad on the first row; a wrapped second row would put
            them nowhere near their cards. */}
        {Array.from({ length: Math.min(platoon.squads.length, columns) }, (_, i) => (
          <span
            key={i}
            className="net-tree__line"
            style={{ left: `${((i + 0.5) / columns) * 100}%` }}
          />
        ))}
      </div>

      <div className="squads" style={{ '--cols': columns } as CSSProperties}>
        {platoon.squads.map((squad) => {
          const members = playersInSquad(platoon, squad.id);
          return (
            <SquadCard
              key={squad.id}
              squad={squad}
              players={members}
              me={me}
              speakingIds={speakingIds}
              remoteTransmit={remoteTransmit}
              canAdmin={!!canAdmin}
              capacity={platoon.squadSize}
              removable={canAdmin && platoon.squads.length > MIN_SQUADS}
              full={members.length >= platoon.squadSize && me?.squadId !== squad.id}
            />
          );
        })}

        {canAdmin && platoon.squads.length < MAX_SQUADS && (
          <button
            className="squad squad--add"
            onClick={addSquad}
            title="Otevřít další squad kanál"
          >
            <span className="squad__add-mark">+</span>
            Přidat squad
          </button>
        )}
      </div>

      {bench.length > 0 && (
        <div className="bench">
          <span className="eyebrow">Bez squadu ({bench.length})</span>
          <div className="bench__list">
            {bench.map((player) => (
              <span className="bench__chip" key={player.id}>
                <span className="player__avatar" style={{ width: 22, height: 22 }}>
                  {player.avatarUrl ? (
                    <img src={player.avatarUrl} alt="" />
                  ) : (
                    player.name.slice(0, 2).toUpperCase()
                  )}
                </span>
                {player.name}
                {player.id === me?.id && <b style={{ color: 'var(--gold)' }}>TY</b>}
                {canAdmin && (
                  <span className="bench__assign" title="Přiřadit do squadu">
                    {platoon.squads.map((squad) => (
                      <button
                        key={squad.id}
                        className="icon-btn"
                        style={{ color: squad.color }}
                        title={`Do ${squad.name} — ${squad.role}`}
                        onClick={() => movePlayer(player.id, squad.id)}
                      >
                        {squad.id}
                      </button>
                    ))}
                  </span>
                )}
              </span>
            ))}
          </div>
          {me?.squadId === null && (
            <p style={{ fontSize: 11, color: 'var(--text-faint)', margin: '10px 0 0' }}>
              Vyber si squad výše — dokud nejsi v žádném, nikoho neslyšíš.
            </p>
          )}
        </div>
      )}

      {!squadHotkey && me?.squadId !== null && (
        <div className="hint-box" style={{ marginTop: 16 }}>
          Nemáš nastavenou klávesu pro push-to-talk. Bez ní se nikam nedovoláš —{' '}
          <button
            className="btn btn--sm"
            style={{ marginLeft: 6 }}
            onClick={() => openSettings(true)}
          >
            nastavit teď
          </button>
        </div>
      )}
    </>
  );
}
