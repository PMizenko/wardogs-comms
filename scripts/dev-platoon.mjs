/**
 * Spins up a populated platoon on a dev server and holds it open.
 *
 * Useful when working on the UI: instead of opening eight clients to see what a
 * full platoon looks like, run this and sign in to the seat it reserves for you.
 * It prints a session token for that seat, so the desktop app can drop straight
 * into a platoon that already has squads, leaders and a bench.
 *
 * Requires ALLOW_DEV_LOGIN=true.
 * Run:  node scripts/dev-platoon.mjs [name] [http://localhost:4000]
 */
import WebSocket from 'ws';

const SEAT = process.argv[2] ?? 'Velitel';
const BASE = process.argv[3] ?? 'http://localhost:4000';
const WS_BASE = BASE.replace(/^http/, 'ws');

/** The bots that fill out the roster. */
const BOTS = [
  { name: 'Kolar', squad: 1, leader: false },
  { name: 'Beneš', squad: 1, leader: false },
  { name: 'Dvořák', squad: 2, leader: true },
  { name: 'Horák', squad: 2, leader: false },
  { name: 'Marek', squad: 3, leader: true },
  { name: 'Sedlák', squad: 3, leader: false },
  { name: 'Urban', squad: 4, leader: true },
  { name: 'Fiala', squad: 4, leader: false },
  { name: 'Novotný', squad: null, leader: false },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function token(name) {
  const res = await fetch(`${BASE}/auth/dev/token?name=${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`dev login refused (${res.status}) - is ALLOW_DEV_LOGIN on?`);
  return res.json();
}

function connect(session, onMessage) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(session.token)}`);
    socket.on('message', (raw) => onMessage?.(JSON.parse(raw.toString())));
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
  });
}

async function main() {
  const host = await token(SEAT);
  let code = null;

  const hostSocket = await connect(host, (m) => {
    if (m.t === 'platoon:state') code = m.platoon.code;
  });

  hostSocket.send(JSON.stringify({ t: 'platoon:create', name: 'Sobotní zápas' }));
  for (let i = 0; i < 40 && !code; i++) await sleep(50);
  if (!code) throw new Error('platoon was not created');

  hostSocket.send(JSON.stringify({ t: 'squad:join', squadId: 1, asLeader: true }));
  await sleep(150);

  const sockets = [hostSocket];
  for (const bot of BOTS) {
    const session = await token(bot.name);
    const socket = await connect(session);
    socket.send(JSON.stringify({ t: 'platoon:join', code }));
    await sleep(90);
    if (bot.squad !== null) {
      socket.send(
        JSON.stringify({ t: 'squad:join', squadId: bot.squad, asLeader: bot.leader }),
      );
      await sleep(60);
    }
    sockets.push(socket);
  }

  console.log('\n  platoon code : %s', code);
  console.log('  your seat    : %s (velitel platoonu, squad 1)', SEAT);
  console.log('  players      : %d', BOTS.length + 1);
  console.log('\n  session token for the desktop app:\n');
  console.log(host.token);
  console.log(
    '\n  Signing in as "%s" in the app takes over this seat. Ctrl+C ends the platoon.\n',
    SEAT,
  );

  // The bots exist only as long as their sockets do.
  process.on('SIGINT', () => {
    for (const socket of sockets) socket.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});
