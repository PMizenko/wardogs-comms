import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import {
  isSquadId,
  parseClientMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type PlatoonState,
  type ServerMessage,
  type UserIdentity,
  type VoiceGrants,
} from '@wardogs/shared';
import { config } from '../config.js';
import { verifySession } from '../auth/jwt.js';
import { issueGrants } from '../livekit/tokens.js';
import { platoons, PlatoonError } from '../platoon/manager.js';

interface Connection {
  socket: WebSocket;
  user: UserIdentity;
  /**
   * Fingerprint of the channel set this client was last granted. Tokens are
   * only re-minted when it changes, so a teammate toggling their mic does not
   * churn everyone's LiveKit credentials.
   */
  grantKey: string;
  grants: VoiceGrants;
  alive: boolean;
}

const connections = new Map<string, Connection>();

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function fail(socket: WebSocket, err: unknown): void {
  if (err instanceof PlatoonError) {
    send(socket, { t: 'error', code: err.code, message: err.message });
  } else {
    send(socket, { t: 'error', code: 'internal', message: 'Something went wrong' });
  }
}

/** Identifies which nets a player is entitled to right now. */
function grantKeyFor(platoon: PlatoonState, playerId: string): string {
  const player = platoon.players.find((p) => p.id === playerId);
  if (!player) return 'none';
  const command = player.role === 'squad_leader' || player.role === 'platoon_leader';
  return `${platoon.id}:${player.squadId ?? '-'}:${command ? 'cmd' : '-'}`;
}

async function pushState(conn: Connection, platoon: PlatoonState): Promise<void> {
  const player = platoon.players.find((p) => p.id === conn.user.id);
  if (!player) {
    conn.grantKey = 'none';
    conn.grants = { squad: null, command: null };
    send(conn.socket, { t: 'platoon:none' });
    return;
  }

  const key = grantKeyFor(platoon, conn.user.id);
  if (key !== conn.grantKey) {
    conn.grants = await issueGrants(platoon.id, player);
    conn.grantKey = key;
  }
  send(conn.socket, { t: 'platoon:state', platoon, grants: conn.grants });
}

/** Fan a roster change out to everyone standing in that platoon. */
async function broadcast(platoonId: string): Promise<void> {
  const platoon = platoons.get(platoonId);
  if (!platoon) return;
  await Promise.all(
    platoon.players.map(async (p) => {
      const conn = connections.get(p.id);
      if (conn) await pushState(conn, platoon);
    }),
  );
}

async function handleMessage(conn: Connection, msg: ClientMessage): Promise<void> {
  const userId = conn.user.id;

  switch (msg.t) {
    case 'ping':
      send(conn.socket, { t: 'pong' });
      return;

    case 'platoon:create':
      platoons.create(conn.user, typeof msg.name === 'string' ? msg.name : '', {
        password: typeof msg.password === 'string' ? msg.password : '',
        listed: msg.listed !== false,
      });
      return;

    case 'platoon:join': {
      const byCode = typeof msg.code === 'string' && msg.code.trim().length === 6;
      const byId = typeof msg.platoonId === 'string' && msg.platoonId.length > 0;
      if (!byCode && !byId) {
        throw new PlatoonError('bad_request', 'A join code is six characters');
      }
      platoons.join(conn.user, {
        code: byCode ? msg.code : undefined,
        platoonId: byId ? msg.platoonId : undefined,
        password: typeof msg.password === 'string' ? msg.password : '',
      });
      return;
    }

    case 'platoon:list':
      send(conn.socket, { t: 'platoon:browser', platoons: platoons.list() });
      return;

    case 'platoon:leave': {
      const platoon = platoons.platoonOf(userId);
      platoons.leave(userId);
      send(conn.socket, { t: 'platoon:none' });
      if (platoon) await broadcast(platoon.id);
      return;
    }

    case 'squad:join':
      if (!isSquadId(msg.squadId)) throw new PlatoonError('bad_request', 'Unknown squad');
      platoons.joinSquad(userId, msg.squadId, msg.asLeader === true);
      return;

    case 'squad:leave':
      platoons.leaveSquad(userId);
      return;

    case 'leader:claim':
      if (!isSquadId(msg.squadId)) throw new PlatoonError('bad_request', 'Unknown squad');
      platoons.claimLeader(userId, msg.squadId);
      return;

    case 'leader:release':
      platoons.releaseLeader(userId);
      return;

    case 'admin:move':
      platoons.move(userId, msg.playerId, msg.squadId === null ? null : msg.squadId);
      return;

    case 'admin:promote':
      platoons.promote(userId, msg.playerId);
      return;

    case 'admin:kick':
      platoons.kick(userId, msg.playerId);
      return;

    case 'admin:rename-squad':
      if (!isSquadId(msg.squadId)) throw new PlatoonError('bad_request', 'Unknown squad');
      platoons.renameSquad(userId, msg.squadId, String(msg.role ?? ''));
      return;

    case 'admin:squad-size':
      platoons.setSquadSize(userId, Number(msg.size));
      return;

    case 'admin:password':
      platoons.setPassword(userId, String(msg.password ?? ''));
      return;

    case 'admin:listed':
      platoons.setListed(userId, msg.listed === true);
      return;

    case 'state:mic':
      platoons.setMicState(userId, msg.micMuted === true, msg.deafened === true);
      return;

    case 'state:transmit': {
      // Relayed, not stored: it is a transient "this net is hot" indicator so
      // the whole platoon can see activity on channels they cannot hear.
      const platoon = platoons.platoonOf(userId);
      if (!platoon) return;
      for (const p of platoon.players) {
        if (p.id === userId) continue;
        const peer = connections.get(p.id);
        if (peer) {
          send(peer.socket, {
            t: 'player:transmit',
            playerId: userId,
            channel: msg.channel,
            active: msg.active === true,
          });
        }
      }
      return;
    }

    default:
      throw new PlatoonError('bad_request', 'Unknown message');
  }
}

export async function registerGateway(app: FastifyInstance): Promise<void> {
  platoons.on('changed', (platoonId: string) => {
    void broadcast(platoonId).catch((err) => app.log.error({ err }, 'broadcast failed'));
  });

  platoons.on('kicked', (playerId: string) => {
    const conn = connections.get(playerId);
    if (conn) {
      send(conn.socket, { t: 'kicked', reason: 'Removed by the platoon leader' });
      send(conn.socket, { t: 'platoon:none' });
    }
  });

  app.get<{ Querystring: { token?: string } }>(
    '/ws',
    { websocket: true },
    async (socket, req) => {
      const token = req.query.token;
      const user = token ? await verifySession(token) : null;

      if (!user) {
        send(socket, { t: 'error', code: 'not_authenticated', message: 'Sign in first' });
        socket.close(4401, 'not_authenticated');
        return;
      }

      // One live socket per player - a second window takes over the slot.
      const previous = connections.get(user.id);
      if (previous && previous.socket !== socket) {
        previous.socket.close(4409, 'replaced_by_new_session');
      }

      const conn: Connection = {
        socket,
        user,
        grantKey: 'none',
        grants: { squad: null, command: null },
        alive: true,
      };
      connections.set(user.id, conn);

      send(socket, {
        t: 'hello',
        user,
        protocol: PROTOCOL_VERSION,
        livekitUrl: config.livekit.url,
      });

      // Rejoin whatever they were in before the socket dropped.
      const existing = platoons.markOnline(user);
      if (existing) await pushState(conn, existing);
      else send(socket, { t: 'platoon:none' });

      socket.on('message', (raw: Buffer) => {
        const msg = parseClientMessage(raw.toString());
        if (!msg) {
          send(socket, { t: 'error', code: 'bad_request', message: 'Malformed message' });
          return;
        }
        handleMessage(conn, msg).catch((err) => {
          if (!(err instanceof PlatoonError)) {
            app.log.error({ err, msg: msg.t }, 'gateway handler failed');
          }
          fail(socket, err);
        });
      });

      socket.on('pong', () => {
        conn.alive = true;
      });

      socket.on('close', () => {
        // Only drop the registration if this socket is still the current one.
        if (connections.get(user.id) === conn) {
          connections.delete(user.id);
          platoons.markOffline(user.id);
        }
      });

      socket.on('error', (err: Error) => {
        app.log.warn({ err, userId: user.id }, 'socket error');
      });
    },
  );

  // Heartbeat: reap half-open sockets so a pulled ethernet cable is noticed.
  const heartbeat = setInterval(() => {
    for (const conn of connections.values()) {
      if (!conn.alive) {
        conn.socket.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.socket.ping();
      } catch {
        conn.socket.terminate();
      }
    }
  }, 20_000);
  heartbeat.unref?.();

  app.addHook('onClose', async () => clearInterval(heartbeat));
}

export function connectedPlayers(): number {
  return connections.size;
}
