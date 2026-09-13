import { useState } from 'react';
import type { PlayerState } from '@wardogs/shared';
import { useApp } from '../state/store.js';
import {
  HeadsetOffIcon,
  MicOffIcon,
  RadioIcon,
  StarIcon,
  UserMinusIcon,
  VolumeIcon,
  VolumeOffIcon,
} from './Icons.js';

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
  const volume = useApp((s) => s.settings.audio.playerVolumes[player.id] ?? 1);
  const setPlayerVolume = useApp((s) => s.setPlayerVolume);

  const [tuning, setTuning] = useState(false);

  const initials = player.name.slice(0, 2).toUpperCase();
  const trimmed = Math.abs(volume - 1) > 0.001;

  const classes = [
    'player',
    speaking || transmitting ? 'player--speaking' : '',
    player.online ? '' : 'player--offline',
  ]
    .filter(Boolean)
    .join(' ');

  // The slider takes over the row rather than floating above it: a popover
  // inside a scrolling squad card clips, and there is no room for one anyway.
  if (tuning) {
    return (
      <div className="player player--tuning">
        <button
          className="icon-btn"
          title={volume === 0 ? 'Zapnout' : 'Ztlumit úplně'}
          onClick={() => void setPlayerVolume(player.id, volume === 0 ? 1 : 0)}
        >
          {volume === 0 ? <VolumeOffIcon size={13} /> : <VolumeIcon size={13} />}
        </button>
        <input
          className="player__volume"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          autoFocus
          aria-label={`Hlasitost — ${player.name}`}
          onChange={(e) => void setPlayerVolume(player.id, Number(e.target.value))}
          onBlur={() => setTuning(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') setTuning(false);
          }}
        />
        <span className="player__volume-value">{Math.round(volume * 100)} %</span>
      </div>
    );
  }

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

      {/* Your own voice is never played back to you, so there is nothing to trim. */}
      {!isMe && (
        <button
          className={`icon-btn player__volume-btn${trimmed ? ' is-trimmed' : ''}`}
          title={
            trimmed
              ? `Hlasitost ${Math.round(volume * 100)} % — klikni pro úpravu`
              : 'Upravit hlasitost'
          }
          onClick={() => setTuning(true)}
        >
          {volume === 0 ? <VolumeOffIcon size={13} /> : <VolumeIcon size={13} />}
        </button>
      )}

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
