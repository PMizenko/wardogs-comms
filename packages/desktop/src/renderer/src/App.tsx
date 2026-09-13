import { useEffect } from 'react';
import { resumeAudioPlayback, selectScreen, useApp } from './state/store.js';
import { TitleBar } from './components/TitleBar.js';
import { SignInScreen } from './components/SignInScreen.js';
import { LobbyScreen } from './components/LobbyScreen.js';
import { PlatoonScreen } from './components/PlatoonScreen.js';
import { BottomBar } from './components/BottomBar.js';
import { SettingsDrawer } from './components/SettingsDrawer.js';
import { XIcon } from './components/Icons.js';

export function App() {
  const ready = useApp((s) => s.ready);
  const boot = useApp((s) => s.boot);
  const screen = useApp(selectScreen);
  const notice = useApp((s) => s.notice);
  const dismissNotice = useApp((s) => s.dismissNotice);

  useEffect(() => {
    void boot();
  }, [boot]);

  // Chromium holds audio playback until the page has seen a gesture; the first
  // click anywhere is enough, and there is always one before a match starts.
  useEffect(() => {
    const unlock = () => resumeAudioPlayback();
    window.addEventListener('pointerdown', unlock);
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(dismissNotice, 6000);
    return () => clearTimeout(timer);
  }, [notice, dismissNotice]);

  return (
    <div className="app">
      <TitleBar />

      <main className="main">
        {!ready ? null : screen === 'signin' ? (
          <SignInScreen />
        ) : screen === 'lobby' ? (
          <LobbyScreen />
        ) : (
          <PlatoonScreen />
        )}
      </main>

      {screen === 'signin' ? <div /> : <BottomBar />}

      {notice && (
        <div className={`notice${notice.kind === 'error' ? ' notice--error' : ''}`}>
          <span style={{ flex: 1 }}>{notice.text}</span>
          <button className="icon-btn" onClick={dismissNotice} aria-label="Zavřít">
            <XIcon size={13} />
          </button>
        </div>
      )}

      <SettingsDrawer />
    </div>
  );
}
