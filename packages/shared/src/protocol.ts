import type { ChannelId, SquadId } from './squads.js';
import type { PlatoonState, PlatoonSummary, UserIdentity, VoiceGrants } from './types.js';

/**
 * Control-plane protocol.
 *
 * Voice itself never travels here - LiveKit owns the media path. This socket
 * carries only roster state: who is in which squad, who holds a leader slot,
 * and the short-lived tokens that authorise a client to open a LiveKit room.
 */

export const PROTOCOL_VERSION = 2;

// --- client -> server -----------------------------------------------------

export type ClientMessage =
  | { t: 'ping' }
  | { t: 'platoon:create'; name: string; password?: string; listed?: boolean }
  /** Join by code, or by id when picked out of the browser. */
  | { t: 'platoon:join'; code?: string; platoonId?: string; password?: string }
  | { t: 'platoon:leave' }
  /** Ask for the public browser listing. */
  | { t: 'platoon:list' }
  /** Take a slot in a squad. `asLeader` claims the leader slot if it is free. */
  | { t: 'squad:join'; squadId: SquadId; asLeader: boolean }
  /** Drop back to the lobby without leaving the platoon. */
  | { t: 'squad:leave' }
  /** Claim or release the leader slot of the squad you are already in. */
  | { t: 'leader:claim'; squadId: SquadId }
  | { t: 'leader:release' }
  /** Platoon-leader only: move someone else. */
  | { t: 'admin:move'; playerId: string; squadId: SquadId | null }
  | { t: 'admin:promote'; playerId: string }
  | { t: 'admin:kick'; playerId: string }
  | { t: 'admin:rename-squad'; squadId: SquadId; role: string }
  /** Platoon-leader only: how many players fit in one squad. */
  | { t: 'admin:squad-size'; size: number }
  /** Platoon-leader only: set or clear the join password (empty string clears). */
  | { t: 'admin:password'; password: string }
  /** Platoon-leader only: show or hide the platoon in the public browser. */
  | { t: 'admin:listed'; listed: boolean }
  /** Mic/deafen state, mirrored to the roster so others see the icons. */
  | { t: 'state:mic'; micMuted: boolean; deafened: boolean }
  /** Throttled radio-activity beacon so the whole platoon sees live nets. */
  | { t: 'state:transmit'; channel: ChannelId; active: boolean };

// --- server -> client -----------------------------------------------------

export type ServerErrorCode =
  | 'not_authenticated'
  | 'platoon_not_found'
  | 'platoon_full'
  | 'squad_full'
  | 'leader_taken'
  | 'not_in_platoon'
  | 'forbidden'
  | 'bad_password'
  | 'rate_limited'
  | 'bad_request'
  | 'internal';

export type ServerMessage =
  | { t: 'pong' }
  /** Sent immediately after the socket authenticates. */
  | { t: 'hello'; user: UserIdentity; protocol: number; livekitUrl: string }
  /** Full roster snapshot plus the grants this client is entitled to now. */
  | { t: 'platoon:state'; platoon: PlatoonState; grants: VoiceGrants }
  /** Sent when the client is no longer in any platoon. */
  | { t: 'platoon:none' }
  /** Answer to `platoon:list`. */
  | { t: 'platoon:browser'; platoons: PlatoonSummary[] }
  | { t: 'player:transmit'; playerId: string; channel: ChannelId; active: boolean }
  | { t: 'kicked'; reason: string }
  | { t: 'error'; code: ServerErrorCode; message: string };

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    if (typeof (value as { t?: unknown }).t !== 'string') return null;
    return value as ClientMessage;
  } catch {
    return null;
  }
}
