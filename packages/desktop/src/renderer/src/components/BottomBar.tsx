import type { CSSProperties } from 'react';
import { COMMAND_COLOR } from '@wardogs/shared';
import { selectMe, selectVoiceHealth, useApp } from '../state/store.js';
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
  const squadMode = useApp((s) => s.settings.transmit.squad);
  const toggleSquadPtt = useApp((s) => s.toggleSquadPtt);

  const voice = useApp(selectVoiceHealth);

  const openMic = squadMode === 'open';
  const squadKey = hotkeys.squad;

  const squad = me?.squadId != null ? platoon?.squads.find((s) => s.id === me.squadId) : undefined;
  const squadColor = squad?.color ?? COMMAND_COLOR;

  const live = transmitting !== null;
  // Red for the all-call: it reaches everybody, and it should look like it.
  const accent =
    transmitting === 'allcall'
      ? 'var(--danger)'
      : transmitting === 'command'
        ? 'var(--gold)'
        : squadColor;

  // Voice trouble outranks everything else this readout could say: being told
  // you are "ready" while the media path is down is how you end up talking to
  // nobody for a whole firefight.
  const onAirLabel =
    voice === 'down'
      ? 'HLAS NEJEDE'
      : voice === 'connecting'
        ? 'Připojuji hlas…'
        : live
          ? transmitting === 'allcall'
            ? 'Vysíláš — VŠEM'
            : transmitting === 'command'
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
        className={`onair${live ? ' onair--live' : ''}${voice === 'down' ? ' onair--down' : ''}`}
        style={live && voice !== 'down' ? ({ '--accent': accent } as CSSProperties) : undefined}
        title={
          voice === 'down'
            ? 'Nepřipojeno k hlasovému serveru — nikdo tě neslyší.'
            : undefined
        }
      >
        <span className="dot" />
        {onAirLabel}
      </div>

      <div className="bottombar__spacer" />

      <button
        className={`ptt-toggle${openMic ? ' ptt-toggle--open' : ''}`}
        onClick={() => void toggleSquadPtt()}
        title={
          openMic
            ? 'Otevřený mikrofon — slyší tě squad pořád. Klikni pro push-to-talk.'
            : `Push-to-talk${squadKey ? ` (${squadKey.label})` : ' — klávesa nenastavena'}. Klikni pro otevřený mikrofon.`
        }
      >
        {openMic ? 'OTEVŘENÝ MIK' : 'PUSH-TO-TALK'}
      </button>

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
