import type { ClientMessage, ServerMessage } from '@wardogs/shared';

export type SocketStatus = 'offline' | 'connecting' | 'online' | 'unauthorised';

interface SocketEvents {
  onStatus(status: SocketStatus): void;
  onMessage(message: ServerMessage): void;
}

/**
 * Control socket.
 *
 * Reconnects on its own with a backoff, because a match is exactly the wrong
 * time to ask somebody to click "retry". The server holds a player's squad slot
 * through a short drop, so a quiet reconnect usually restores everything -
 * roster, rank and voice grants - without the player noticing.
 */
export class ControlSocket {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  private closedByUs = false;
  private url = '';
  private token = '';

  constructor(private readonly events: SocketEvents) {}

  connect(serverUrl: string, token: string): void {
    this.closedByUs = false;
    this.url = serverUrl;
    this.token = token;
    this.open();
  }

  private open(): void {
    this.clearTimers();
    if (!this.url || !this.token) return;

    let endpoint: string;
    try {
      const base = new URL(this.url);
      base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
      base.pathname = '/ws';
      base.search = `?token=${encodeURIComponent(this.token)}`;
      endpoint = base.toString();
    } catch {
      this.events.onStatus('offline');
      return;
    }

    this.events.onStatus('connecting');
    const socket = new WebSocket(endpoint);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.events.onStatus('online');
      this.heartbeat = setInterval(() => this.send({ t: 'ping' }), 25_000);
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      // A rejected session is terminal - reconnecting would just fail again.
      if (message.t === 'error' && message.code === 'not_authenticated') {
        this.closedByUs = true;
        this.events.onStatus('unauthorised');
      }
      this.events.onMessage(message);
    };

    socket.onclose = (event) => {
      this.clearTimers();
      this.socket = null;
      if (this.closedByUs) {
        this.events.onStatus('offline');
        return;
      }
      if (event.code === 4401) {
        this.events.onStatus('unauthorised');
        return;
      }
      this.events.onStatus('offline');
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose always follows; the retry is scheduled there.
    };
  }

  private scheduleReconnect(): void {
    this.attempt = Math.min(this.attempt + 1, 6);
    // 1s, 2s, 4s ... capped at 15s, with jitter so a server restart does not
    // bring the whole platoon back in one thundering herd.
    const backoff = Math.min(1000 * 2 ** (this.attempt - 1), 15_000);
    const delay = backoff + Math.random() * 500;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  disconnect(): void {
    this.closedByUs = true;
    this.clearTimers();
    this.socket?.close(1000, 'client_signed_out');
    this.socket = null;
    this.events.onStatus('offline');
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.reconnectTimer = null;
    this.heartbeat = null;
  }
}
