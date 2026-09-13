import type { CSSProperties } from 'react';
import { COMMAND_COLOR } from '@wardogs/shared';
import { selectMe, useApp } from '../state/store.js';
import {
  HeadsetIcon,
  HeadsetOffIcon,
  MicIcon,
  MicOffIcon,
  SettingsIcon,
} from './Icons.js';

const STATUS_TEXT: Record<string, string> = {
  online: 'Připojeno',
  connecting: 'Připojuji…',
  offline: 'Odpojeno',
  unauthorised: 'Přihlášení vypršelo',
};

/** Always-visible radio state: who you are, what is on the air, mic and ears. */
export function BottomBar() {
  const user = useApp((s) => s.user);
  const me = useApp(selectMe);
  const platoon = useApp((s) => s.platoon);
  const status = useApp((s) => s.status);
  const transmitting = useApp((s) => s.transmitting);
  const micMuted = useApp((s) => s.micMuted);
  const deafened = useApp((s) => s.deafened);
  const toggleMute = useApp((s) => s.toggleMute);
  const toggleDeafen = useApp((s) => s.toggleDeafen);
  const openSettings = useApp((s) => s.openSettings);
  const netState = useApp((s) => s.netState);
  const hotkeys = useApp((s) => s.settings.hotkeys);

  const squad = me?.squadId != null ? platoon?.squads.find((s) => s.id === me.squadId) : undefined;
  const squadColor = squad?.color ?? COMMAND_COLOR;

  const live = transmitting !== null;
  const accent = transmitting === 'command' ? 'var(--gold)' : squadColor;

  const onAirLabel = live
    ? transmitting === 'command'
      ? 'Vysíláš — COMMAND'
      : `Vysíláš — ${squad?.name ?? 'SQUAD'}`
    : micMuted
      ? 'Mikrofon vypnut'
      : hotkeys.squad || hotkeys.command
        ? 'Připraven'
        : 'Klávesa nenastavena';

  const statusClass =
    status === 'online' ? 'online' : status === 'connecting' ? 'connecting' : 'offline';

  return (
    <div className="bottombar">
      <div className="bottombar__me">
        <span className="player__avatar" style={{ width: 30, height: 30 }}>
          {user?.avatarUrl ? (
            <img src={user.avatarUrl} alt="" />
          ) : (
            (user?.name ?? '??').slice(0, 2).toUpperCase()
          )}
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="bottombar__name">{user?.name ?? 'Nepřihlášen'}</div>
          <div className="bottombar__status">
            <span className={`status-dot status-dot--${statusClass}`} />{' '}
            {STATUS_TEXT[status] ?? status}
            {netState.command === 'live' && ' · command'}
          </div>
        </div>
      </div>

      <div className="bottombar__spacer" />

      <div
        className={`onair${live ? ' onair--live' : ''}`}
        style={live ? ({ '--accent': accent } as CSSProperties) : undefined}
      >
        <span className="dot" />
        {onAirLabel}
      </div>

      <div className="bottombar__spacer" />

      <button
        className={`round-btn${micMuted ? ' round-btn--active' : ''}`}
        onClick={toggleMute}
        title={micMuted ? 'Zapnout mikrofon' : 'Vypnout mikrofon'}
      >
        {micMuted ? <MicOffIcon size={16} /> : <MicIcon size={16} />}
      </button>

      <button
        className={`round-btn${deafened ? ' round-btn--active' : ''}`}
        onClick={toggleDeafen}
        title={deafened ? 'Zapnout zvuk' : 'Ztlumit vše'}
      >
        {deafened ? <HeadsetOffIcon size={16} /> : <HeadsetIcon size={16} />}
      </button>

      <button
        className="round-btn"
        onClick={() => openSettings(true)}
        title="Nastavení"
      >
        <SettingsIcon size={16} />
      </button>
    </div>
  );
}
