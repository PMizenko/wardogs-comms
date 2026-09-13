import type { FastifyInstance } from 'fastify';
import type { UserIdentity } from '@wardogs/shared';
import { config } from '../config.js';
import { signSession } from './jwt.js';

const DISCORD_API = 'https://discord.com/api/v10';

/**
 * Pending sign-in attempts, keyed by the nonce the desktop app generated.
 * They live only long enough to complete one browser round-trip, which is why
 * an in-memory map is sufficient - a server restart just means signing in again.
 */
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

function sweepStates(): void {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [state, createdAt] of pendingStates) {
    if (createdAt < cutoff) pendingStates.delete(state);
  }
}

interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

function avatarUrl(user: DiscordUser): string | null {
  return user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
    : null;
}

async function exchangeCode(code: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: config.discord.clientId,
    client_secret: config.discord.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.discord.redirectUri,
  });

  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`Discord token exchange failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('Discord token exchange returned no access_token');
  return json.access_token;
}

async function fetchIdentity(accessToken: string): Promise<UserIdentity> {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Discord /users/@me failed (${res.status})`);
  const user = (await res.json()) as DiscordUser;
  return {
    id: user.id,
    name: user.global_name || user.username,
    avatarUrl: avatarUrl(user),
  };
}

async function isGuildMember(accessToken: string, guildId: string): Promise<boolean> {
  const res = await fetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return false;
  const guilds = (await res.json()) as Array<{ id: string }>;
  return guilds.some((g) => g.id === guildId);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string,
  );
}

function resultPage(opts: {
  ok: boolean;
  title: string;
  detail: string;
  deepLink?: string;
}): string {
  const accent = opts.ok ? '#e0b13a' : '#ef4444';
  const redirect = opts.deepLink
    ? `<script>setTimeout(function(){location.href=${JSON.stringify(opts.deepLink)}},400)</script>
       <p class="hint">Pokud se aplikace neotevrela, <a href="${escapeHtml(opts.deepLink)}">klikni sem</a>.</p>`
    : '';
  return `<!doctype html>
<html lang="cs"><head><meta charset="utf-8"><title>Wardogs VOIP</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#0c0d10; color:#e7e7ea;
         font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  .card { max-width:30rem; padding:2.5rem; text-align:center;
          border:1px solid #24262d; border-radius:14px; background:#131418; }
  h1 { margin:0 0 .5rem; font-size:1.35rem; letter-spacing:.06em;
       text-transform:uppercase; color:${accent}; }
  p { margin:.4rem 0; color:#a2a5ae; }
  .hint { font-size:.85rem; margin-top:1.4rem; }
  a { color:${accent}; }
</style></head>
<body><div class="card"><h1>${escapeHtml(opts.title)}</h1><p>${escapeHtml(
    opts.detail,
  )}</p>${redirect}</div></body></html>`;
}

export async function registerDiscordAuth(app: FastifyInstance): Promise<void> {
  if (!config.discord.enabled) {
    app.log.warn('Discord OAuth is not configured - /auth/discord/* is not mounted');
    return;
  }

  /**
   * Step 1 - the desktop app opens this in the system browser with a nonce it
   * generated. Using the system browser (not an embedded view) keeps the user's
   * existing Discord session and password manager available, and means this app
   * never handles their credentials.
   */
  app.get<{ Querystring: { state?: string } }>('/auth/discord/start', async (req, reply) => {
    const state = req.query.state?.trim();
    if (!state || state.length < 16 || state.length > 128) {
      return reply
        .code(400)
        .type('text/html')
        .send(
          resultPage({
            ok: false,
            title: 'Neplatny pozadavek',
            detail: 'Chybi nebo je vadny parametr state.',
          }),
        );
    }
    sweepStates();
    pendingStates.set(state, Date.now());

    const scopes = config.discord.requiredGuildId ? 'identify guilds' : 'identify';
    const url = new URL(`${DISCORD_API}/oauth2/authorize`);
    url.searchParams.set('client_id', config.discord.clientId);
    url.searchParams.set('redirect_uri', config.discord.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scopes);
    url.searchParams.set('state', state);
    return reply.redirect(url.toString());
  });

  /** Step 2 - Discord bounces the browser back here with an auth code. */
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/discord/callback',
    async (req, reply) => {
      const { code, state, error } = req.query;

      if (error) {
        return reply.type('text/html').send(
          resultPage({
            ok: false,
            title: 'Prihlaseni zruseno',
            detail: `Discord vratil: ${error}`,
          }),
        );
      }
      if (!code || !state || !pendingStates.has(state)) {
        return reply
          .code(400)
          .type('text/html')
          .send(
            resultPage({
              ok: false,
              title: 'Neplatna odpoved',
              detail:
                'Prihlasovaci pozadavek vyprsel nebo nebyl rozpoznan. Zkus to v aplikaci znovu.',
            }),
          );
      }
      pendingStates.delete(state);

      try {
        const accessToken = await exchangeCode(code);

        if (config.discord.requiredGuildId) {
          const member = await isGuildMember(accessToken, config.discord.requiredGuildId);
          if (!member) {
            return reply
              .code(403)
              .type('text/html')
              .send(
                resultPage({
                  ok: false,
                  title: 'Pristup odepren',
                  detail: 'Tvuj Discord ucet neni clenem povoleneho serveru.',
                }),
              );
          }
        }

        const identity = await fetchIdentity(accessToken);
        const sessionToken = await signSession(identity);
        const deepLink =
          `${config.desktopProtocol}://auth` +
          `?token=${encodeURIComponent(sessionToken)}&state=${encodeURIComponent(state)}`;

        app.log.info({ userId: identity.id, name: identity.name }, 'discord sign-in ok');
        return reply.type('text/html').send(
          resultPage({
            ok: true,
            title: `Vitej, ${identity.name}`,
            detail:
              'Prihlaseni probehlo. Vracim te do aplikace Wardogs VOIP - tohle okno muzes zavrit.',
            deepLink,
          }),
        );
      } catch (err) {
        app.log.error({ err }, 'discord sign-in failed');
        return reply
          .code(502)
          .type('text/html')
          .send(
            resultPage({
              ok: false,
              title: 'Prihlaseni selhalo',
              detail: 'Nepodarilo se overit ucet u Discordu. Zkus to prosim znovu.',
            }),
          );
      }
    },
  );
}
