/// <reference types="vite/client" />
import type { DesktopBridge } from '../../common/ipc.js';

declare global {
  interface Window {
    /** Injected by the preload script; the renderer's only route to the OS. */
    wardogs: DesktopBridge;
  }
}

export {};
