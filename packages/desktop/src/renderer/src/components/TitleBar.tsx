import { useApp } from '../state/store.js';
import { MinusIcon, SettingsIcon, XIcon } from './Icons.js';

export function TitleBar() {
  const openSettings = useApp((s) => s.openSettings);

  return (
    <div className="titlebar">
      <div className="titlebar__mark">
        <b>Wardogs</b>
        <span>VOIP</span>
      </div>
      <div className="titlebar__spacer" />
      <button
        className="titlebar__btn"
        onClick={() => openSettings(true)}
        title="Nastavení"
        aria-label="Nastavení"
      >
        <SettingsIcon size={15} />
      </button>
      <button
        className="titlebar__btn"
        onClick={() => window.wardogs.minimise()}
        title="Minimalizovat"
        aria-label="Minimalizovat"
      >
        <MinusIcon size={15} />
      </button>
      <button
        className="titlebar__btn titlebar__btn--close"
        onClick={() => window.wardogs.close()}
        title="Schovat do lišty"
        aria-label="Zavřít"
      >
        <XIcon size={15} />
      </button>
    </div>
  );
}
