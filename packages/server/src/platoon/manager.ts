import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_SQUADS,
  hasSquad,
  isSquadId,
  MAX_SQUADS,
  MIN_SQUADS,
  SQUAD_PALETTE,
  SQUAD_SIZE_DEFAULT,
  SQUAD_SIZE_MAX,
  SQUAD_SIZE_MIN,
  type PlatoonState,
  type PlatoonSummary,
  type PlayerState,
  type SquadId,
  type UserIdentity,
} from '@wardogs/shared';
import { config } from '../config.js';

/**
 * Join passwords, kept out of PlatoonState so they cannot ride along in a
 * roster broadcast. Hashed rather than stored: these get reused from people's
 * other accounts however often you ask them not to.
 */
interface PasswordRecord {
  salt: Buffer;
  hash: Buffer;
}

function hashPassword(password: string, salt = randomBytes(16)): PasswordRecord {
  return { salt, hash: scryptSync(password, salt, 32) };
}

function passwordMatches(record: PasswordRecord, attempt: string): boolean {
  const candidate = scryptSync(attempt, record.salt, 32);
  return timingSafeEqual(record.hash, candidate);
}

/** On-disk shape for surviving a restart. */
export interface PlatoonSnapshot {
  savedAt: number;
  platoons: PlatoonState[];
  passwords: Array<{ id: string; salt: string; hash: string }>;
}

export class PlatoonError extends Error {
  constructor(
    readonly code:
      | 'platoon_not_found'
      | 'platoon_full'
      | 'squad_full'
      | 'leader_taken'
      | 'not_in_platoon'
      | 'forbidden'
      | 'bad_password'
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
  /** platoonId -> hashed join password, for the ones that have one. */
  private readonly passwords = new Map<string, PasswordRecord>();
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

  create(
    user: UserIdentity,
    name: string,
    options: { password?: string; listed?: boolean } = {},
  ): PlatoonState {
    this.leave(user.id);

    const id = randomUUID();
    const code = generateCode((c) => this.byCode.has(c));
    const password = options.password?.trim() ?? '';

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
      squadSize: SQUAD_SIZE_DEFAULT,
      hasPassword: password.length > 0,
      listed: options.listed !== false,
    };

    if (password) this.passwords.set(id, hashPassword(password));

    this.platoons.set(id, platoon);
    this.byCode.set(code, id);
    this.membership.set(user.id, id);
    this.changed(platoon);
    return platoon;
  }

  /**
   * Join by code, or by id when the player picked one out of the browser.
   *
   * The password is only demanded of newcomers: someone reconnecting into a
   * slot they already hold has already proved themselves once, and a dropped
   * connection mid-match is the wrong moment to ask again.
   */
  join(
    user: UserIdentity,
    by: { code?: string; platoonId?: string; password?: string },
  ): PlatoonState {
    const platoonId = by.platoonId ?? this.byCode.get((by.code ?? '').trim().toUpperCase());
    const platoon = platoonId ? this.platoons.get(platoonId) : undefined;
    if (!platoon) throw new PlatoonError('platoon_not_found', 'No platoon with that code');

    const existing = this.playerIn(platoon, user.id);

    if (!existing) {
      const record = this.passwords.get(platoon.id);
      if (record && !passwordMatches(record, by.password ?? '')) {
        throw new PlatoonError('bad_password', 'Wrong password');
      }
    }

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
      this.passwords.delete(platoon.id);
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
    this.armReap(playerId, config.limits.reconnectGraceMs);
  }

  private armReap(playerId: string, graceMs: number): void {
    this.cancelReap(playerId);
    const timer = setTimeout(() => {
      this.reapTimers.delete(playerId);
      const still = this.platoonOf(playerId);
      const p = still && this.playerIn(still, playerId);
      if (p && !p.online) this.leave(playerId);
    }, graceMs);
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
    const { platoon, player } = this.require(playerId);
    if (!isSquadId(squadId) || !hasSquad(platoon, squadId)) {
      throw new PlatoonError('bad_request', 'Unknown squad');
    }

    const occupants = platoon.players.filter((p) => p.squadId === squadId && p.id !== playerId);
    if (occupants.length >= platoon.squadSize) {
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
      if (!isSquadId(squadId) || !hasSquad(platoon, squadId)) {
        throw new PlatoonError('bad_request', 'Unknown squad');
      }
      const size = platoon.players.filter((p) => p.squadId === squadId && p.id !== targetId).length;
      if (size >= platoon.squadSize) throw new PlatoonError('squad_full', 'That squad is full');
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

  /** Rename a squad, recolour it, or both. */
  restyleSquad(
    actorId: string,
    squadId: SquadId,
    style: { role?: string; color?: string },
  ): void {
    const { platoon } = this.requireLeader(actorId);
    const squad = platoon.squads.find((s) => s.id === squadId);
    if (!squad) throw new PlatoonError('bad_request', 'Unknown squad');

    if (typeof style.role === 'string') {
      squad.role = style.role.trim().slice(0, 24) || squad.role;
    }
    if (typeof style.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(style.color)) {
      squad.color = style.color.toLowerCase();
    }
    this.changed(platoon);
  }

  /**
   * Open another squad channel.
   *
   * Ids are never reused while a squad lives and never renumbered: room names
   * are built from them, so shuffling would move people between voice channels
   * mid-match.
   */
  addSquad(actorId: string): SquadId {
    const { platoon } = this.requireLeader(actorId);
    if (platoon.squads.length >= MAX_SQUADS) {
      throw new PlatoonError('bad_request', `A platoon holds at most ${MAX_SQUADS} squads`);
    }

    const taken = new Set(platoon.squads.map((s) => s.id));
    let id = 1;
    while (taken.has(id)) id += 1;

    const usedColours = new Set(platoon.squads.map((s) => s.color.toLowerCase()));
    const color =
      SQUAD_PALETTE.find((candidate) => !usedColours.has(candidate)) ??
      SQUAD_PALETTE[platoon.squads.length % SQUAD_PALETTE.length] ??
      '#9aa0aa';

    platoon.squads.push({ id, name: `Squad ${id}`, role: 'Nezařazeno', color });
    platoon.squads.sort((a, b) => a.id - b.id);
    this.changed(platoon);
    return id;
  }

  /**
   * Close a squad channel. Anyone standing in it is moved to the bench rather
   * than thrown out of the platoon, and its leader loses the rank along with
   * the command net - the server simply stops minting them those tokens.
   */
  removeSquad(actorId: string, squadId: SquadId): void {
    const { platoon } = this.requireLeader(actorId);
    if (!hasSquad(platoon, squadId)) throw new PlatoonError('bad_request', 'Unknown squad');
    if (platoon.squads.length <= MIN_SQUADS) {
      throw new PlatoonError('bad_request', 'A platoon needs at least one squad');
    }

    for (const player of platoon.players) {
      if (player.squadId !== squadId) continue;
      player.squadId = null;
      if (player.role === 'squad_leader') player.role = 'member';
    }

    platoon.squads = platoon.squads.filter((squad) => squad.id !== squadId);
    this.changed(platoon);
  }

  /**
   * Resize squads. Shrinking below what a squad already holds is allowed and
   * nobody is thrown out - the limit only gates new arrivals, so a leader can
   * tighten things up without ejecting half the platoon mid-match.
   */
  setSquadSize(actorId: string, size: number): void {
    const { platoon } = this.requireLeader(actorId);
    if (!Number.isInteger(size) || size < SQUAD_SIZE_MIN || size > SQUAD_SIZE_MAX) {
      throw new PlatoonError(
        'bad_request',
        `Squad size must be between ${SQUAD_SIZE_MIN} and ${SQUAD_SIZE_MAX}`,
      );
    }
    if (platoon.squadSize === size) return;
    platoon.squadSize = size;
    this.changed(platoon);
  }

  /** An empty password clears it. */
  setPassword(actorId: string, password: string): void {
    const { platoon } = this.requireLeader(actorId);
    const next = password.trim();

    if (next.length === 0) {
      this.passwords.delete(platoon.id);
      platoon.hasPassword = false;
    } else {
      if (next.length > 64) throw new PlatoonError('bad_request', 'Password is too long');
      this.passwords.set(platoon.id, hashPassword(next));
      platoon.hasPassword = true;
    }
    this.changed(platoon);
  }

  setListed(actorId: string, listed: boolean): void {
    const { platoon } = this.requireLeader(actorId);
    if (platoon.listed === listed) return;
    platoon.listed = listed;
    this.changed(platoon);
  }

  /**
   * The public browser.
   *
   * Carries no join code and no roster: a locked platoon must stay locked even
   * though anyone can see that it exists.
   */
  list(): PlatoonSummary[] {
    const summaries: PlatoonSummary[] = [];
    for (const platoon of this.platoons.values()) {
      if (!platoon.listed) continue;
      const leader = platoon.players.find((p) => p.id === platoon.leaderId);
      summaries.push({
        id: platoon.id,
        name: platoon.name,
        leaderName: leader?.name ?? 'Unknown',
        players: platoon.players.length,
        capacity: Math.min(platoon.squadSize * platoon.squads.length, config.limits.platoonSize),
        hasPassword: platoon.hasPassword,
        createdAt: platoon.createdAt,
      });
    }
    // Busiest first: an empty platoon is rarely the one you meant to join.
    return summaries.sort((a, b) => b.players - a.players || a.createdAt - b.createdAt);
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

  // --- surviving a restart -------------------------------------------------

  /** Everything needed to rebuild the live state, including password hashes. */
  snapshot(): PlatoonSnapshot {
    return {
      savedAt: Date.now(),
      platoons: [...this.platoons.values()],
      passwords: [...this.passwords.entries()].map(([id, record]) => ({
        id,
        salt: record.salt.toString('base64'),
        hash: record.hash.toString('base64'),
      })),
    };
  }

  /**
   * Rebuild from a snapshot. Everyone comes back marked offline with a reap
   * timer running, so the existing reconnect path does the rest: clients
   * reconnect on their own within seconds and drop straight back into their
   * squad and rank. Anyone who does not come back is cleaned up as usual.
   */
  restore(snapshot: PlatoonSnapshot): { platoons: number; players: number } {
    let players = 0;

    for (const platoon of snapshot.platoons) {
      if (platoon.players.length === 0) continue;
      this.platoons.set(platoon.id, platoon);
      this.byCode.set(platoon.code, platoon.id);

      for (const player of platoon.players) {
        player.online = false;
        this.membership.set(player.id, platoon.id);
        this.armReap(player.id, config.limits.restoreGraceMs);
        players += 1;
      }
    }

    for (const entry of snapshot.passwords) {
      if (!this.platoons.has(entry.id)) continue;
      this.passwords.set(entry.id, {
        salt: Buffer.from(entry.salt, 'base64'),
        hash: Buffer.from(entry.hash, 'base64'),
      });
    }

    return { platoons: this.platoons.size, players };
  }

  stats(): { platoons: number; players: number } {
    let players = 0;
    for (const p of this.platoons.values()) players += p.players.length;
    return { platoons: this.platoons.size, players };
  }
}

export const platoons = new PlatoonManager();
