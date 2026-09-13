import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { registerDiscordAuth } from './auth/discord.js';
import { registerDevAuth } from './auth/dev.js';
import { registerGateway, connectedPlayers } from './ws/gateway.js';
import { platoons } from './platoon/manager.js';

/**
 * Wardogs VOIP control server.
 *
 * It owns identity, the platoon roster and the permission model. Voice media
 * never passes through here - clients take the tokens this server mints and
 * connect straight to the LiveKit SFU.
 */
async function main(): Promise<void> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV === 'production'
          ? undefined
          : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
    },
  });

  await app.register(cors, { origin: true });
  await app.register(websocket, {
    options: { maxPayload: 64 * 1024 },
  });

  await registerDiscordAuth(app);
  await registerDevAuth(app);
  await registerGateway(app);

  /** What sign-in methods this server offers; read by the desktop client. */
  app.get('/config', async () => ({
    discord: config.discord.enabled,
    devLogin: config.allowDevLogin,
    livekitUrl: config.livekit.url,
  }));

  app.get('/health', async () => ({
    ok: true,
    ...platoons.stats(),
    sockets: connectedPlayers(),
    livekit: config.livekit.url,
  }));

  /** Landing page so a browser hitting the server sees something useful. */
  app.get('/', async (_req, reply) =>
    reply.type('text/html').send(
      `<!doctype html><html lang="cs"><head><meta charset="utf-8">
       <title>Wardogs VOIP</title><style>
       :root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;
       background:#0c0d10;color:#e7e7ea;font:16px/1.6 system-ui,sans-serif;text-align:center}
       h1{color:#e0b13a;letter-spacing:.08em;text-transform:uppercase;font-size:1.2rem}
       code{background:#1b1c21;padding:.15rem .4rem;border-radius:4px}</style></head>
       <body><div><h1>Wardogs VOIP</h1>
       <p>Ridici server bezi. Pripoj se desktopovou aplikaci.</p>
       <p><code>GET /health</code></p></div></body></html>`,
    ),
  );

  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(
    { publicUrl: config.publicUrl, livekit: config.livekit.url },
    'wardogs voip control server ready',
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      app.log.info(`${signal} received, shutting down`);
      void app.close().then(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error('[wardogs] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
