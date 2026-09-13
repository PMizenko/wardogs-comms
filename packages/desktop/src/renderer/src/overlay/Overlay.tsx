import { useEffect, useState } from 'react';
import { EMPTY_OVERLAY_STATE, type OverlayState } from '../../../common/ipc.js';
import { DEFAULT_SETTINGS, type Settings } from '../../../common/settings.js';

/**
 * The in-game HUD.
 *
 * Read at a glance, mid-firefight: the net you are keyed into, who is talking,
 * and anything that means your comms are not working. Nothing is interactive -
 * the window is click-through - so everything here is colour, size and position.
 */
export function Overlay() {
  const [state, setState] = useState<OverlayState>(EMPTY_OVERLAY_STATE);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    const offState = window.wardogs.onOverlayState(setState);
    const offSettings = window.wardogs.onSettingsChanged(setSettings);
    void window.wardogs.getSettings().then(setSettings);
    return () => {
      offState();
      offSettings();
    };
  }, []);

  /** Dropped the control link while in a platoon - comms are effectively dead. */
  const lostComms = state.inPlatoon && !state.connected;
  /**
   * "Hide when idle" must never hide a problem. Silence is the normal case and
   * worth hiding; a muted mic or a dropped link is exactly what you need to see
   * when nobody is talking.
   */
  const quiet =
    !state.transmitting &&
    state.speakers.length === 0 &&
    !state.micMuted &&
    !state.deafened &&
    !lostComms;

  if (settings.overlay.hideWhenIdle && quiet) return null;

  const transmitColor = state.transmitting === 'command' ? '#e0b13a' : state.squadColor;
  const showSquad = state.squadLabel && (!settings.overlay.hideWhenIdle || !!state.transmitting);

  return (
    <div className="hud" style={{ fontSize: `${13 * settings.overlay.scale}px` }}>
      {state.transmitting && (
        <div className="hud__onair" style={{ background: transmitColor }}>
          <span className="hud__pulse" />
          {state.transmitting === 'command' ? 'COMMAND' : 'SQUAD'}
        </div>
      )}

      {showSquad && (
        <div className="hud__squad" style={{ color: state.squadColor }}>
          <span className="hud__dot" style={{ background: state.squadColor }} />
          <span className="hud__name">{state.squadLabel}</span>
          {state.hasCommand && <span className="hud__tag">CMD</span>}
        </div>
      )}

      {lostComms && <div className="hud__warn hud__warn--red">BEZ SPOJENÍ</div>}

      {(state.micMuted || state.deafened) && (
        <div className="hud__warn">{state.deafened ? 'ZVUK VYPNUT' : 'MIKROFON VYPNUT'}</div>
      )}

      <div className="hud__speakers">
        {state.speakers.map((speaker) => (
          <div className="hud__speaker" key={`${speaker.net}:${speaker.id}`}>
            <span className="hud__dot" style={{ background: speaker.color }} />
            <span className="hud__name">{speaker.name}</span>
            {speaker.net === 'command' && <span className="hud__tag">CMD</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
