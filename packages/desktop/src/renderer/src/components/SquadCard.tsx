import { useState, type CSSProperties } from 'react';
import { SQUAD_PALETTE, type ChannelId, type PlayerState, type SquadDefinition } from '@wardogs/shared';
import { useApp } from '../state/store.js';
import { PlayerRow } from './PlayerRow.js';
import { StarIcon, XIcon } from './Icons.js';

interface Props {
  squad: SquadDefinition;
  players: PlayerState[];
  me: PlayerState | null;
  /** Ids audible right now (only for nets this client is actually on). */
  speakingIds: Set<string>;
  remoteTransmit: Record<string, ChannelId>;
  canAdmin: boolean;
  full: boolean;
  /** Players allowed in this squad, set by the platoon leader. */
  capacity: number;
  /** Whether the leader may close this channel - never the last one. */
  removable: boolean;
}

export function SquadCard({
  squad,
  players,
  me,
  speakingIds,
  remoteTransmit,
  canAdmin,
  full,
  capacity,
  removable,
}: Props) {
  const joinSquad = useApp((s) => s.joinSquad);
  const leaveSquad = useApp((s) => s.leaveSquad);
  const claimLeader = useApp((s) => s.claimLeader);
  const releaseLeader = useApp((s) => s.releaseLeader);
  const renameSquad = useApp((s) => s.renameSquad);
  const recolourSquad = useApp((s) => s.recolourSquad);
  const removeSquad = useApp((s) => s.removeSquad);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(squad.role);

  const isMine = me?.squadId === squad.id;
  /** The squad-leader slot proper - what someone can claim. */
  const slotFree = !players.some((p) => p.role === 'squad_leader');
  /**
   * Whether anyone in this squad can reach the command net. The platoon leader
   * counts: they are on command wherever they stand, so a squad they are in is
   * not cut off even with its leader slot empty.
   */
  const hasCommandLink = players.some(
    (p) => p.role === 'squad_leader' || p.role === 'platoon_leader',
  );
  const iAmLeaderHere = isMine && me?.role === 'squad_leader';
  /** The platoon leader is already on command; offering them the slot is a no-op. */
  const canClaimSlot = slotFree && me?.role !== 'platoon_leader';

  // Any radio activity inside this squad lights the card, even for players on
  // other nets who cannot hear it.
  const hot = players.some(
    (p) => speakingIds.has(p.id) || remoteTransmit[p.id] === squad.id,
  );

  const classes = ['squad', isMine ? 'squad--mine' : '', hot ? 'squad--hot' : '']
    .filter(Boolean)
    .join(' ');

  function commitRename() {
    setEditing(false);
    window.wardogs.pauseHotkeys(false);
    const next = draft.trim();
    if (next && next !== squad.role) renameSquad(squad.id, next);
    else setDraft(squad.role);
  }

  return (
    <section className={classes} style={{ '--accent': squad.color } as CSSProperties}>
      <header className="squad__head">
        <span className="squad__count">
          {removable && (
            <button
              className="icon-btn icon-btn--danger squad__close"
              title={
                players.length > 0
                  ? `Zavřít kanál — ${players.length} lidí půjde na lavičku`
                  : 'Zavřít kanál'
              }
              onClick={() => removeSquad(squad.id)}
            >
              <XIcon size={12} />
            </button>
          )}
          {players.length}/{capacity}
        </span>
        <div className="squad__name">{squad.name}</div>

        {editing ? (
          <>
            <input
              className="input"
              style={{ marginTop: 4, padding: '4px 8px', fontSize: 12 }}
              value={draft}
              autoFocus
              maxLength={24}
              onFocus={() => window.wardogs.pauseHotkeys(true)}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') {
                  setDraft(squad.role);
                  setEditing(false);
                  window.wardogs.pauseHotkeys(false);
                }
              }}
            />
            {/* mousedown, not click: the input's blur would close the editor first */}
            <div className="squad__swatches">
              {SQUAD_PALETTE.map((color) => (
                <button
                  key={color}
                  className={`swatch${color === squad.color ? ' swatch--on' : ''}`}
                  style={{ background: color }}
                  title={`Barva ${color}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    recolourSquad(squad.id, color);
                  }}
                />
              ))}
            </div>
          </>
        ) : (
          <button
            className="squad__role"
            data-editable={canAdmin}
            title={canAdmin ? 'Klikni pro přejmenování role' : undefined}
            onClick={() => canAdmin && setEditing(true)}
          >
            {squad.role}
          </button>
        )}
      </header>

      {!hasCommandLink && players.length > 0 && (
        <div className="leader-slot">
          <span>Bez spojení na command</span>
          {isMine && canClaimSlot && (
            <button className="btn btn--sm" onClick={() => claimLeader(squad.id)}>
              Převzít
            </button>
          )}
        </div>
      )}

      <div className="squad__body">
        {players.length === 0 ? (
          <div className="squad__empty">
            Prázdný squad.
            <br />
            {!isMine && !full && 'Připoj se níže.'}
          </div>
        ) : (
          players.map((player) => (
            <PlayerRow
              key={player.id}
              player={player}
              isMe={player.id === me?.id}
              speaking={speakingIds.has(player.id)}
              transmitting={remoteTransmit[player.id] !== undefined}
              canAdmin={canAdmin}
            />
          ))
        )}
      </div>

      <footer className="squad__foot">
        {isMine ? (
          <>
            <button className="btn btn--ghost btn--sm" onClick={leaveSquad}>
              Opustit
            </button>
            {iAmLeaderHere ? (
              <button className="btn btn--ghost btn--sm" onClick={releaseLeader}>
                Předat velení
              </button>
            ) : (
              canClaimSlot && (
                <button className="btn btn--sm" onClick={() => claimLeader(squad.id)}>
                  <StarIcon size={11} />
                  Velet
                </button>
              )
            )}
          </>
        ) : (
          <>
            <button
              className="btn btn--sm"
              disabled={full}
              onClick={() => joinSquad(squad.id, false)}
            >
              {full ? 'Plno' : 'Připojit se'}
            </button>
            {slotFree && !full && me?.role !== 'platoon_leader' && (
              <button
                className="btn btn--sm"
                title="Připojit se a rovnou převzít velení"
                onClick={() => joinSquad(squad.id, true)}
              >
                <StarIcon size={11} />
                Jako velitel
              </button>
            )}
          </>
        )}
      </footer>
    </section>
  );
}
