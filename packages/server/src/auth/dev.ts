import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { signSession } from './jwt.js';

/**
 * Local testing sign-in.
 *
 * Hands out a session for whatever name is typed, so one machine can run four
 * clients and exercise the real platoon flow - squads, leader slots, both nets -
 * without four Discord accounts.
 *
 * This is an authentication bypass. It only mounts when ALLOW_DEV_LOGIN=true
 * and never in production; see config.ts.
 */
export async function registerDevAuth(app: FastifyInstance): Promise<void> {
  if (!config.allowDevLogin) return;

  app.log.warn(
    'ALLOW_DEV_LOGIN is on - anyone who can reach this server can sign in as any name. ' +
      'Never run this on a public address.',
  );

  app.get<{ Querystring: { state?: string; name?: string } }>(
    '/auth/dev/start',
    async (req, reply) => {
      const state = req.query.state?.trim();
      const name = (req.query.name ?? '').trim().slice(0, 24);

      if (!state || !name) {
        return reply.code(400).send({ error: 'state and name are required' });
      }

      // Stable synthetic id, so reconnecting as the same name keeps your slot.
      const id = `dev-${createHash('sha1').update(name.toLowerCase()).digest('hex').slice(0, 16)}`;
      const token = await signSession({ id, name, avatarUrl: null });

      const deepLink =
        `${config.desktopProtocol}://auth` +
        `?token=${encodeURIComponent(token)}&state=${encodeURIComponent(state)}`;

      app.log.info({ id, name }, 'dev sign-in issued');
      return reply.redirect(deepLink);
    },
  );

  /** Used by the smoke test to get a token without a browser round-trip. */
  app.get<{ Querystring: { name?: string } }>('/auth/dev/token', async (req, reply) => {
    const name = (req.query.name ?? '').trim().slice(0, 24);
    if (!name) return reply.code(400).send({ error: 'name is required' });

    const id = `dev-${createHash('sha1').update(name.toLowerCase()).digest('hex').slice(0, 16)}`;
    return { token: await signSession({ id, name, avatarUrl: null }), id, name };
  });
}
