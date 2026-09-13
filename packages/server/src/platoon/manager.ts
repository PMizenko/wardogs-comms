import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SQUADS,
  isSquadId,
  type PlatoonState,
  type PlayerState,
  type SquadId,
  type UserIdentity,
} from '@wardogs/shared';
import { config } from '../config.js';

export class PlatoonError extends Error {
  constructor(
    readonly code:
      | 'platoon_not_found'
      | 'platoon_full'
      | 'squad_full'
      | 'leader_taken'
      | 'not_in_platoon'
      | 'forbidden'
      | 'bad_request',
    message: string,
  ) {
    super(message);
    this.name = 'PlatoonError';
  }
}

/** Ambiguous glyphs removed - these codes get read aloud over voice comms. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(taken: (code: string) => boolean): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!taken(code)) return code;
  }
  throw new Error('Could not allocate a free platoon code');
}

/**
 * In-memory home of every live platoon.
 *
 * A platoon is a match-scoped object: it exists while people are in it and is
 * reaped when the last player drops. Nothing here needs to survive a restart,
 * which is why there is no database - the cost of a server restart is that
 * everyone re-types a join code.
 */
export class PlatoonManager extends EventEmitter {
  private readonly platoons = new Map<string, PlatoonState>();
  private readonly byCode = new Map<string, string>();
  /** playerId -> platoonId */
  private readonly membership = new Map<string, string>();
  /** playerId -> pending removal after a dropped connection */
  private readonly reapTimers = new Map<string, NodeJS.Timeout>();

  // --- lookup -------------------------------------------------------------

  get(platoonId: string): PlatoonState | undefined {
    return this.platoons.get(platoonId);
  }

  platoonOf(playerId: string): PlatoonState | undefined {
    const id = this.membership.get(playerId);
    return id ? this.platoons.get(id) : undefined;
  }

  playerIn(platoon: PlatoonState, playerId: string): PlayerState | undefined {
    return platoon.players.find((p) => p.id === playerId);
  }

  /** Throws unless the player is currently in a platoon. */
  private require(playerId: string): { platoon: PlatoonState; player: PlayerState } {
    const platoon = this.platoonOf(playerId);
    const player = platoon && this.playerIn(platoon, playerId);
    if (!platoon || !player) {
      throw new PlatoonError('not_in_platoon', 'You are not in a platoon');
    }
    return { platoon, player };
  }

  private requireLeader(playerId: string): { platoon: PlatoonState; player: PlayerState } {
    const ctx = this.require(playerId);
    if (ctx.player.role !== 'platoon_leader') {
      throw new PlatoonError('forbidden', 'Only the platoon leader can do that');
    }
    return ctx;
  }

  private changed(platoon: PlatoonState): void {
    this.emit('changed', platoon.id);
  }

  // --- lifecycle ----------------------------------------------------------

  create(user: UserIdentity, name: string): PlatoonState {
    this.leave(user.id);

    const id = randomUUID();
    const code = generateCode((c) => this.byCode.has(c));
    const platoon: PlatoonState = {
      id,
      code,
      name: name.trim().slice(0, 40) || `${user.name}'s platoon`,
      leaderId: user.id,
      squads: DEFAULT_SQUADS.map((s) => ({ ...s })),
      players: [
        {
          id: user.id,
          name: user.name,
          avatarUrl: user.avatarUrl,
          squadId: null,
          role: 'platoon_leader',
          online: true,
          micMuted: false,
          deafened: false,
        },
      ],
      createdAt: Date.now(),
    };

    this.platoons.set(id, platoon);
    this.byCode.set(code, id);
    this.membership.set(user.id, id);
    this.changed(platoon);
    return platoon;
  }

  join(user: UserIdentity, code: string): PlatoonState {
    const platoonId = this.byCode.get(code.trim().toUpperCase());
    const platoon = platoonId ? this.platoons.get(platoonId) : undefined;
    if (!platoon) throw new PlatoonError('platoon_not_found', 'No platoon with that code');

    const existing = this.playerIn(platoon, user.id);
    if (existing) {
      // Reconnect into the slot they already hold, keeping squad and rank.
      this.cancelReap(user.id);
      existing.online = true;
      existing.name = user.name;
      existing.avatarUrl = user.avatarUrl;
      this.membership.set(user.id, platoon.id);
      this.changed(platoon);
      return platoon;
    }

    if (platoon.players.length >= config.limits.platoonSize) {
      throw new PlatoonError('platoon_full', 'This platoon is full');
    }

    this.leave(user.id);
    platoon.players.push({
      id: user.id,
      name: user.name,
      avatarUrl: user.avatarUrl,
      squadId: null,
      role: 'member',
      online: true,
      micMuted: false,
      deafened: false,
    });
    this.membership.set(user.id, platoon.id);
    this.changed(platoon);
    return platoon;
  }

  leave(playerId: string): void {
    const platoon = this.platoonOf(playerId);
    if (!platoon) return;

    this.cancelReap(playerId);
    platoon.players = platoon.players.filter((p) => p.id !== playerId);
    this.membership.delete(playerId);

    if (platoon.players.length === 0) {
      this.platoons.delete(platoon.id);
      this.byCode.delete(platoon.code);
      this.emit('closed', platoon.id);
      return;
    }

    if (platoon.leaderId === playerId) this.transferCommand(platoon);
    this.changed(platoon);
  }

  /**
   * Hand the platoon over when its leader drops. A sitting squad leader is the
   * natural successor - they are already on the command net.
   */
  private transferCommand(platoon: PlatoonState): void {
    const successor =
      platoon.players.find((p) => p.role === 'squad_leader' && p.online) ??
      platoon.players.find((p) => p.online) ??
      platoon.players[0];
    if (!successor) return;
    successor.role = 'platoon_leader';
    platoon.leaderId = successor.id;
  }

  // --- connection state ---------------------------------------------------

  /**
   * A dropped socket does not immediately cost the player their squad slot -
   * a crash-to-desktop mid-match would otherwise hand their leader slot away.
   */
  markOffline(playerId: string): void {
    const platoon = this.platoonOf(playerId);
    const player = platoon && this.playerIn(platoon, playerId);
    if (!platoon || !player) return;

    player.online = false;
    this.changed(platoon);

    this.cancelReap(playerId);
    const timer = setTimeout(() => {
      this.reapTimers.delete(playerId);
      const still = this.platoonOf(playerId);
      const p = still && this.playerIn(still, playerId);
      if (p && !p.online) this.leave(playerId);
    }, config.limits.reconnectGraceMs);
    timer.unref?.();
    this.reapTimers.set(playerId, timer);
  }

  markOnline(user: UserIdentity): PlatoonState | undefined {
    const platoon = this.platoonOf(user.id);
    const player = platoon && this.playerIn(platoon, user.id);
    if (!platoon || !player) return undefined;

    this.cancelReap(user.id);
    player.online = true;
    player.name = user.name;
    player.avatarUrl = user.avatarUrl;
    this.changed(platoon);
    return platoon;
  }

  private cancelReap(playerId: string): void {
    const timer = this.reapTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      this.reapTimers.delete(playerId);
    }
  }

  // --- squad assignment ---------------------------------------------------

  joinSquad(playerId: string, squadId: SquadId, asLeader: boolean): void {
    if (!isSquadId(squadId)) throw new PlatoonError('bad_request', 'Unknown squad');
    const { platoon, player } = this.require(playerId);

    const occupants = platoon.players.filter((p) => p.squadId === squadId && p.id !== playerId);
    if (occupants.length >= config.limits.squadSize) {
      throw new PlatoonError('squad_full', 'That squad is full');
    }

    const wasPlatoonLeader = player.role === 'platoon_leader';
    player.squadId = squadId;

    if (asLeader) {
      const taken = occupants.some((p) => p.role === 'squad_leader');
      if (taken) throw new PlatoonError('leader_taken', 'That squad already has a leader');
      // The platoon leader keeps their rank; they are on the command net either way.
      if (!wasPlatoonLeader) player.role = 'squad_leader';
    } else if (!wasPlatoonLeader) {
      player.role = 'member';
    }

    this.changed(platoon);
  }

  leaveSquad(playerId: string): void {
    const { platoon, player } = this.require(playerId);
    player.squadId = null;
    if (player.role === 'squad_leader') player.role = 'member';
    this.changed(platoon);
  }

  /** Take the leader slot of the squad you are already standing in. */
  claimLeader(playerId: string, squadId: SquadId): void {
    const { platoon, player } = this.require(playerId);
    if (player.squadId !== squadId) {
      throw new PlatoonError('bad_request', 'Join the squad before claiming its leader slot');
    }
    const taken = platoon.players.some(
      (p) => p.squadId === squadId && p.role === 'squad_leader' && p.id !== playerId,
    );
    if (taken) throw new PlatoonError('leader_taken', 'That squad already has a leader');

    if (player.role !== 'platoon_leader') player.role = 'squad_leader';
    this.changed(platoon);
  }

  releaseLeader(playerId: string): void {
    const { platoon, player } = this.require(playerId);
    if (player.role === 'squad_leader') {
      player.role = 'member';
      this.changed(platoon);
    }
  }

  // --- platoon-leader controls -------------------------------------------

  move(actorId: string, targetId: string, squadId: SquadId | null): void {
    const { platoon } = this.requireLeader(actorId);
    const target = this.playerIn(platoon, targetId);
    if (!target) throw new PlatoonError('bad_request', 'No such player in this platoon');

    if (squadId !== null) {
      if (!isSquadId(squadId)) throw new PlatoonError('bad_request', 'Unknown squad');
      const size = platoon.players.filter((p) => p.squadId === squadId && p.id !== targetId).length;
      if (size >= config.limits.squadSize) throw new PlatoonError('squad_full', 'That squad is full');
    }

    target.squadId = squadId;
    if (target.role === 'squad_leader') {
      const clash = platoon.players.some(
        (p) => p.squadId === squadId && p.role === 'squad_leader' && p.id !== targetId,
      );
      // Moving a leader into a squad that already has one demotes them.
      if (squadId === null || clash) target.role = 'member';
    }
    this.changed(platoon);
  }

  promote(actorId: string, targetId: string): void {
    const { platoon } = this.requireLeader(actorId);
    const target = this.playerIn(platoon, targetId);
    if (!target) throw new PlatoonError('bad_request', 'No such player in this platoon');
    if (target.squadId === null) {
      throw new PlatoonError('bad_request', 'Assign them to a squad first');
    }

    // One leader per squad: demote the incumbent as part of the same change.
    for (const p of platoon.players) {
      if (p.squadId === target.squadId && p.role === 'squad_leader' && p.id !== targetId) {
        p.role = 'member';
      }
    }
    if (target.role !== 'platoon_leader') target.role = 'squad_leader';
    this.changed(platoon);
  }

  kick(actorId: string, targetId: string): void {
    const { platoon } = this.requireLeader(actorId);
    if (actorId === targetId) throw new PlatoonError('bad_request', 'You cannot kick yourself');
    if (!this.playerIn(platoon, targetId)) {
      throw new PlatoonError('bad_request', 'No such player in this platoon');
    }
    this.emit('kicked', targetId, platoon.id);
    this.leave(targetId);
  }

  renameSquad(actorId: string, squadId: SquadId, role: string): void {
    const { platoon } = this.requireLeader(actorId);
    const squad = platoon.squads.find((s) => s.id === squadId);
    if (!squad) throw new PlatoonError('bad_request', 'Unknown squad');
    squad.role = role.trim().slice(0, 24) || squad.role;
    this.changed(platoon);
  }

  // --- per-player flags ---------------------------------------------------

  setMicState(playerId: string, micMuted: boolean, deafened: boolean): void {
    const platoon = this.platoonOf(playerId);
    const player = platoon && this.playerIn(platoon, playerId);
    if (!platoon || !player) return;
    if (player.micMuted === micMuted && player.deafened === deafened) return;
    player.micMuted = micMuted;
    player.deafened = deafened;
    this.changed(platoon);
  }

  stats(): { platoons: number; players: number } {
    let players = 0;
    for (const p of this.platoons.values()) players += p.players.length;
    return { platoons: this.platoons.size, players };
  }
}

export const platoons = new PlatoonManager();
