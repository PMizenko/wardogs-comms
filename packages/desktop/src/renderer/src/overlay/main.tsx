import { createRoot } from 'react-dom/client';
import { Overlay } from './Overlay.js';
import '../styles/overlay.css';

const container = document.getElementById('overlay-root');
if (!container) throw new Error('Missing #overlay-root');

// No StrictMode here: the HUD subscribes to IPC and double-mounting in dev
// would leave a stray listener attached.
createRoot(container).render(<Overlay />);
