import type { ChannelId, SquadDefinition, SquadId } from './squads.js';

/** Identity handed out after a successful Discord sign-in. */
export interface UserIdentity {
  /** Discord snowflake - stable across sessions, used as the participant id. */
  id: string;
  /** Discord global display name, falling back to the username. */
  name: string;
  avatarUrl: string | null;
}

/**
 * Rank inside a platoon.
 *
 * `platoon_leader` is the player who opened the platoon. They hold the command
 * net and the roster controls. `squad_leader` is one player per squad who is
 * additionally patched into the command net - the whole point of the app.
 */
export type PlatoonRole = 'platoon_leader' | 'squad_leader' | 'member';

export interface PlayerState {
  id: string;
  name: string;
  avatarUrl: string | null;
  /** `null` while the player sits in the lobby without a squad assignment. */
  squadId: SquadId | null;
  role: PlatoonRole;
  /** False between a dropped socket and the reconnect grace period expiring. */
  online: boolean;
  /** Self-muted microphone: transmits nothing on any net. */
  micMuted: boolean;
  /** Deafened: hears nothing and transmits nothing. */
  deafened: boolean;
}

export interface PlatoonState {
  id: string;
  /** Six-character code teammates type to join. */
  code: string;
  name: string;
  /** Player id of the platoon leader. */
  leaderId: string;
  squads: SquadDefinition[];
  players: PlayerState[];
  createdAt: number;
  /** Players allowed per squad. Set by the platoon leader. */
  squadSize: number;
  /** Whether joining needs a password. The password itself never leaves the server. */
  hasPassword: boolean;
  /** Whether this platoon shows up in the public browser. */
  listed: boolean;
}

/**
 * A platoon as seen from the outside, before joining.
 *
 * Deliberately thin: no join code and no roster, so the browser cannot be used
 * to walk into a platoon that has a password on it.
 */
export interface PlatoonSummary {
  id: string;
  name: string;
  leaderName: string;
  players: number;
  capacity: number;
  hasPassword: boolean;
  createdAt: number;
}

export const SQUAD_SIZE_MIN = 1;
/** Ceiling the server will accept for a squad. */
export const SQUAD_SIZE_MAX = 30;
export const SQUAD_SIZE_DEFAULT = 9;

/** Everything a client needs to open one LiveKit room. */
export interface ChannelGrant {
  channel: ChannelId;
  room: string;
  token: string;
  url: string;
  /** False for a member listening in on a net they may not transmit on. */
  canPublish: boolean;
}

/**
 * The set of nets a player is currently entitled to. Members get one squad
 * grant; squad leaders and the platoon leader get a command grant on top.
 */
export interface VoiceGrants {
  squad: ChannelGrant | null;
  command: ChannelGrant | null;
  /** Everyone holds this; only the platoon leader may transmit on it. */
  allcall: ChannelGrant | null;
}

export function isLeader(role: PlatoonRole): boolean {
  return role === 'platoon_leader' || role === 'squad_leader';
}

/** Which player currently leads a given squad, if any. */
export function squadLeaderOf(platoon: PlatoonState, squadId: SquadId): PlayerState | undefined {
  return platoon.players.find((p) => p.squadId === squadId && p.role === 'squad_leader');
}

export function playersInSquad(platoon: PlatoonState, squadId: SquadId): PlayerState[] {
  return platoon.players
    .filter((p) => p.squadId === squadId)
    .sort((a, b) => {
      // Leader pinned to the top of the card, then alphabetical.
      if (a.role === 'squad_leader' && b.role !== 'squad_leader') return -1;
      if (b.role === 'squad_leader' && a.role !== 'squad_leader') return 1;
      return a.name.localeCompare(b.name);
    });
}

export function unassignedPlayers(platoon: PlatoonState): PlayerState[] {
  return platoon.players
    .filter((p) => p.squadId === null)
    .sort((a, b) => a.name.localeCompare(b.name));
}
