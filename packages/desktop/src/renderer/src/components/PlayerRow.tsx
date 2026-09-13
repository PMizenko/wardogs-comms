import type { PlayerState } from '@wardogs/shared';
import { useApp } from '../state/store.js';
import { HeadsetOffIcon, MicOffIcon, RadioIcon, StarIcon, UserMinusIcon } from './Icons.js';

interface Props {
  player: PlayerState;
  isMe: boolean;
  /** Audible right now on a net this client is also on. */
  speaking: boolean;
  /** Keyed into some net, as relayed by the server (works across nets). */
  transmitting: boolean;
  /** Show the platoon-leader controls on hover. */
  canAdmin: boolean;
}

export function PlayerRow({ player, isMe, speaking, transmitting, canAdmin }: Props) {
  const promote = useApp((s) => s.promotePlayer);
  const move = useApp((s) => s.movePlayer);
  const kick = useApp((s) => s.kickPlayer);

  const initials = player.name.slice(0, 2).toUpperCase();
  const classes = [
    'player',
    speaking || transmitting ? 'player--speaking' : '',
    player.online ? '' : 'player--offline',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} title={player.online ? player.name : `${player.name} — odpojen`}>
      <div className="player__avatar">
        {player.avatarUrl ? <img src={player.avatarUrl} alt="" /> : initials}
      </div>

      <span className="player__name">{player.name}</span>

      {player.role === 'platoon_leader' && (
        <span className="player__badge badge--pl" title="Velitel platoonu">
          PL
        </span>
      )}
      {player.role === 'squad_leader' && (
        <span className="player__badge badge--sl" title="Velitel squadu">
          SL
        </span>
      )}
      {isMe && <span className="player__badge badge--you">TY</span>}

      <span className="player__icons">
        {transmitting && !speaking && <RadioIcon size={13} />}
        {player.micMuted && <MicOffIcon size={13} className="is-danger" />}
        {player.deafened && <HeadsetOffIcon size={13} className="is-danger" />}
      </span>

      {canAdmin && !isMe && (
        <span className="player__admin">
          {player.role !== 'squad_leader' && player.squadId !== null && (
            <button
              className="icon-btn"
              title="Povýšit na velitele squadu"
              onClick={() => promote(player.id)}
            >
              <StarIcon size={12} />
            </button>
          )}
          {player.squadId !== null && (
            <button
              className="icon-btn"
              title="Odebrat ze squadu"
              onClick={() => move(player.id, null)}
            >
              <UserMinusIcon size={12} />
            </button>
          )}
          <button
            className="icon-btn icon-btn--danger"
            title="Vyhodit z platoonu"
            onClick={() => kick(player.id)}
          >
            ✕
          </button>
        </span>
      )}
    </div>
  );
}
