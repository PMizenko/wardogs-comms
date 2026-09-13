/**
 * Does the server survive being restarted, and does it shrug off flooding?
 *
 * Both matter only in production and neither shows up in ordinary use, which is
 * exactly why they need a test. This one owns its server: it starts one on a
 * spare port, kills it mid-match, starts it again, and checks that everybody's
 * squad and rank came back.
 *
 * Run:  npm run test:resilience
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4123;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE_FILE = join(root, 'data/test-resilience.json');

let passed = 0;
let failed = 0;

const check = (label, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  \x1b[32mok\x1b[0m   ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
};
const section = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- server under test -----------------------------------------------------

function startServer() {
  const child = spawn(process.execPath, ['packages/server/dist/index.js'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(PORT),
      PUBLIC_URL: BASE,
      ALLOW_DEV_LOGIN: 'true',
      JWT_SECRET: 'resilience-test-secret-0123456789abcdef',
      LIVEKIT_URL: 'ws://localhost:7880',
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'devsecretdevsecretdevsecretdevsecret',
      STATE_FILE: 'data/test-resilience.json',
      // Park the roster often so the test does not have to wait 30s.
      STATE_SAVE_INTERVAL_MS: '500',
    },
  });
  // Quiet unless something goes wrong, in which case the reason matters more
  // than the noise.
  const remember = (chunk) => {
    lastServerOutput += chunk.toString();
    if (lastServerOutput.length > 4000) lastServerOutput = lastServerOutput.slice(-4000);
  };
  child.stderr.on('data', remember);
  child.stdout.on('data', remember);
  child.on('error', (err) => remember(`spawn failed: ${err.message}
`));
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGKILL') remember(`server exited: code=${code} signal=${signal}
`);
  });
  return child;
}

async function waitUntilUp(attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${BASE}/config`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {
      // Still binding.
    }
    await sleep(250);
  }
  return false;
}

async function token(name) {
  const res = await fetch(`${BASE}/auth/dev/token?name=${encodeURIComponent(name)}`);
  return res.json();
}

function open(session, onMessage) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `${BASE.replace('http', 'ws')}/ws?token=${encodeURIComponent(session.token)}`,
    );
    socket.on('message', (raw) => onMessage(JSON.parse(raw.toString())));
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
  });
}

// --- the run ---------------------------------------------------------------

let server;
let lastServerOutput = '';

async function main() {
  console.log('\n\x1b[1mWardogs VOIP — resilience\x1b[0m');
  rmSync(STATE_FILE, { force: true });

  server = startServer();
  if (!(await waitUntilUp())) {
    throw new Error(`the server never came up:
${lastServerOutput}`);
  }

  const alpha = await token('Alpha-res');
  const bravo = await token('Bravo-res');

  let alphaState = null;
  const alphaSocket = await open(alpha, (m) => {
    if (m.t === 'platoon:state') alphaState = m;
  });
  let bravoState = null;
  const bravoSocket = await open(bravo, (m) => {
    if (m.t === 'platoon:state') bravoState = m;
  });

  alphaSocket.send(JSON.stringify({ t: 'platoon:create', name: 'Restart Test', password: 'pw' }));
  for (let i = 0; i < 40 && !alphaState; i++) await sleep(50);
  const code = alphaState.platoon.code;
  const platoonId = alphaState.platoon.id;

  alphaSocket.send(JSON.stringify({ t: 'squad:join', squadId: 2, asLeader: true }));
  bravoSocket.send(JSON.stringify({ t: 'platoon:join', code, password: 'pw' }));
  await sleep(250);
  bravoSocket.send(JSON.stringify({ t: 'squad:join', squadId: 2, asLeader: false }));
  await sleep(400);

  section('Rate limiting');
  let limited = null;
  const flooder = await open(alpha, () => undefined);
  const floodSocket = await open(await token('Flood-res'), (m) => {
    if (m.t === 'error' && m.code === 'rate_limited') limited = m;
  });
  for (let i = 0; i < 80; i++) floodSocket.send(JSON.stringify({ t: 'platoon:list' }));
  await sleep(600);
  check('a flood of requests is refused', limited !== null, limited?.code ?? 'never refused');
  check('the refusal says why', typeof limited?.message === 'string' && limited.message.length > 0);

  // An honest client carries on working while somebody else floods.
  let honest = null;
  const honestSocket = await open(await token('Honest-res'), (m) => {
    if (m.t === 'platoon:browser') honest = m;
  });
  honestSocket.send(JSON.stringify({ t: 'platoon:list' }));
  await sleep(400);
  check('a normal client is unaffected', honest !== null);
  floodSocket.close();
  honestSocket.close();
  flooder.close();

  section('Surviving a restart');
  await sleep(800); // let the autosave land
  check('the roster is parked on disk', existsSync(STATE_FILE));

  // Kill it the way a crash would, with no chance to clean up.
  server.kill('SIGKILL');
  await sleep(500);
  alphaSocket.close();
  bravoSocket.close();

  const restartedAt = Date.now();
  server = startServer();
  if (!(await waitUntilUp())) {
    throw new Error(`the server did not come back:
${lastServerOutput}`);
  }

  let restored = null;
  const alphaAgain = await open(alpha, (m) => {
    if (m.t === 'platoon:state') restored = m;
  });
  for (let i = 0; i < 40 && !restored; i++) await sleep(100);

  check('a reconnecting player lands back in the platoon', restored !== null);
  check('it is the same platoon', restored?.platoon.id === platoonId, restored?.platoon.id);
  const me = restored?.platoon.players.find((p) => p.id === alpha.id);
  check('their squad survived', me?.squadId === 2, `squadId=${me?.squadId}`);
  check('their rank survived', me?.role === 'platoon_leader', me?.role);
  check('their voice grants are reissued', restored?.grants.squad !== null);
  check(
    'teammates who have not reconnected are held as offline',
    restored?.platoon.players.find((p) => p.id === bravo.id)?.online === false,
  );
  check('the password survived', restored?.platoon.hasPassword === true);

  // A locked platoon must still be locked after the restart.
  let rejected = null;
  const stranger = await open(await token('Stranger-res'), (m) => {
    if (m.t === 'error') rejected = m;
  });
  stranger.send(JSON.stringify({ t: 'platoon:join', code, password: 'wrong' }));
  await sleep(400);
  check('the restored password still guards the door', rejected?.code === 'bad_password', rejected?.code);
  stranger.close();

  // The snapshot is deleted as it is read, but the running server parks the
  // roster again straight away - so the property worth checking is not that the
  // file is gone, it is that nobody was restored twice.
  const ids = restored?.platoon.players.map((p) => p.id) ?? [];
  check('the snapshot was consumed, not replayed', new Set(ids).size === ids.length, ids.join(','));

  let parkedAgain = null;
  try {
    parkedAgain = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    // Fine - it just means the autosave has not come round yet.
  }
  check(
    'the file on disk is a fresh save, not the one we restored from',
    parkedAgain === null || parkedAgain.savedAt >= restartedAt,
    parkedAgain ? `savedAt=${parkedAgain.savedAt} restart=${restartedAt}` : 'no file yet',
  );
  alphaAgain.close();
}

main()
  .then(() => {
    console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m\n`);
    server?.kill('SIGKILL');
    rmSync(STATE_FILE, { force: true });
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error('\n\x1b[31mtest run crashed:\x1b[0m', err.message);
    server?.kill('SIGKILL');
    rmSync(STATE_FILE, { force: true });
    process.exit(1);
  });
