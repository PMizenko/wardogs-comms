import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// The .env lives at the repo root so server and tooling share one file.
for (const candidate of ['.env', '../.env', '../../.env', '../../../.env']) {
  const path = resolve(process.cwd(), candidate);
  if (existsSync(path)) {
    loadEnv({ path });
    break;
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function optional(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

const publicUrl = optional('PUBLIC_URL', 'http://localhost:4000').replace(/\/$/, '');

/**
 * Local testing escape hatch: mints a session for any typed name, so the whole
 * platoon flow can be driven from several windows on one machine without four
 * Discord accounts. Opt-in only, and hard-disabled in production - it is an
 * authentication bypass by definition.
 */
const allowDevLogin =
  optional('ALLOW_DEV_LOGIN').toLowerCase() === 'true' && process.env.NODE_ENV !== 'production';

const discordClientId = optional('DISCORD_CLIENT_ID');
const discordClientSecret = optional('DISCORD_CLIENT_SECRET');

if (!allowDevLogin && (!discordClientId || !discordClientSecret)) {
  const askedForDevLogin = process.env['ALLOW_DEV_LOGIN']?.trim().toLowerCase() === 'true';
  throw new Error(
    askedForDevLogin
      ? 'Discord OAuth is not configured, and ALLOW_DEV_LOGIN is ignored when ' +
        'NODE_ENV=production - it lets anyone sign in as anyone. Set ' +
        'DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in .env.'
      : 'Discord OAuth is not configured. Set DISCORD_CLIENT_ID and ' +
        'DISCORD_CLIENT_SECRET in .env, or set ALLOW_DEV_LOGIN=true for local ' +
        'testing without Discord.',
  );
}

export const config = {
  port: Number(optional('PORT', '4000')),
  publicUrl,

  allowDevLogin,

  discord: {
    enabled: Boolean(discordClientId && discordClientSecret),
    clientId: discordClientId,
    clientSecret: discordClientSecret,
    redirectUri: `${publicUrl}/auth/discord/callback`,
    /** When set, sign-in is restricted to members of this guild. */
    requiredGuildId: optional('DISCORD_REQUIRED_GUILD_ID'),
  },

  jwtSecret: required('JWT_SECRET'),

  livekit: {
    url: optional('LIVEKIT_URL', 'ws://localhost:7880'),
    apiKey: required('LIVEKIT_API_KEY'),
    apiSecret: required('LIVEKIT_API_SECRET'),
  },

  /** Custom protocol the desktop app registers, used to hand back the token. */
  desktopProtocol: optional('DESKTOP_PROTOCOL', 'wardogs-voip'),

  limits: {
    /** Hard ceiling per squad. Four squads of nine is a full platoon. */
    squadSize: 9,
    platoonSize: 40,
    /** How long a dropped player keeps their slot before being reaped. */
    reconnectGraceMs: 45_000,
    /**
     * The same grace, but for players restored from a snapshot after a restart.
     * Longer, because a deploy plus the client's reconnect backoff eats more
     * than a dropped wifi does.
     */
    restoreGraceMs: 180_000,
  },

  /**
   * Where live platoons are parked across a restart. Without this every deploy
   * ends whatever match is in progress.
   */
  stateFile: optional('STATE_FILE', 'data/platoons.json'),
  /** A snapshot older than this is stale; nobody wants last night's platoon. */
  stateMaxAgeMs: 15 * 60_000,
  /**
   * How often the roster is parked while running. A clean shutdown saves too,
   * but a crash or a `kill -9` gets no chance to - and on Windows a terminated
   * process never sees the signal at all.
   */
  stateSaveIntervalMs: Number(optional('STATE_SAVE_INTERVAL_MS', '30000')),
} as const;

export type Config = typeof config;
