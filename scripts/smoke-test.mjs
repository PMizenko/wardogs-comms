/**
 * End-to-end check of the control plane.
 *
 * Drives four simulated clients through a full platoon lifecycle and asserts
 * the thing that actually matters: that voice grants follow rank. A member must
 * never receive a token for the command room, and a demoted squad leader must
 * lose theirs. Those are enforced server-side by which tokens get minted, so
 * this test decodes the JWTs and checks the room claim itself.
 *
 * Requires ALLOW_DEV_LOGIN=true and a running control server.
 * Run:  node scripts/smoke-test.mjs [http://localhost:4000]
 */
import WebSocket from 'ws';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const WS_BASE = BASE.replace(/^http/, 'ws');

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mok\x1b[0m   ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/** Pull the LiveKit grant out of a participant token without verifying it. */
function decodeGrant(token) {
  const [, payload] = token.split('.');
  const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  return { room: json.video?.room, canPublish: json.video?.canPublish, identity: json.sub };
}

/**
 * Dev sign-in derives a stable id from the name, so every run uses fresh names.
 * Without this, a previous run's players would still be sitting in a platoon on
 * a long-running server and would be restored on connect.
 */
const RUN = Math.random().toString(36).slice(2, 7);

class Client {
  constructor(name) {
    this.name = `${name}-${RUN}`;
    this.messages = [];
    this.waiters = [];
  }

  async signIn() {
    const res = await fetch(`${BASE}/auth/dev/token?name=${encodeURIComponent(this.name)}`);
    if (!res.ok) throw new Error(`dev token failed for ${this.name}: ${res.status}`);
    const body = await res.json();
    this.token = body.token;
    this.id = body.id;
    return this;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(this.token)}`);
      this.socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        this.messages.push(message);
        for (const waiter of [...this.waiters]) {
          if (waiter.predicate(message)) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            clearTimeout(waiter.timer);
            waiter.resolve(message);
          }
        }
      });
      this.socket.on('open', () => resolve(this));
      this.socket.on('error', reject);
    });
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  /** Resolve with the next message matching `predicate`, or throw on timeout. */
  waitFor(predicate, label = 'message', timeout = 4000) {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`${this.name}: timed out waiting for ${label}`));
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  /**
   * Wait for a roster snapshot satisfying `predicate`.
   *
   * Scans messages already received as well as future ones, so call `clear()`
   * before the action that should produce the snapshot - otherwise a stale
   * state from an earlier step can satisfy a loose predicate.
   */
  waitForState(predicate, label, timeout = 4000) {
    return this.waitFor((m) => m.t === 'platoon:state' && predicate(m), label, timeout);
  }

  clear() {
    this.messages = [];
  }

  me(state) {
    return state.platoon.players.find((p) => p.id === this.id);
  }

  close() {
    this.socket?.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The server may still be binding when a script starts it and immediately runs
 * this, and on some setups `localhost` resolves to IPv6 first while the server
 * is on IPv4. Retry briefly rather than failing with a bare "fetch failed".
 */
async function waitForServer(attempts = 25) {
  const bases = [BASE, BASE.replace('//localhost', '//127.0.0.1')];
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    for (const base of bases) {
      try {
        const res = await fetch(`${base}/config`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return res.json();
      } catch (err) {
        lastError = err;
      }
    }
    await sleep(300);
  }
  console.error(
    `\nCannot reach the control server at ${BASE} ` +
      `(${lastError?.message ?? 'no response'}).\n` +
      'Start it with:  npm run dev:server\n',
  );
  process.exit(2);
}

async function main() {
  console.log(`\x1b[1mWardogs VOIP — control plane smoke test\x1b[0m`);
  console.log(`server: ${BASE}\n`);

  const config = await waitForServer();
  if (!config.devLogin) {
    console.error('ALLOW_DEV_LOGIN must be true on the server to run this test.');
    process.exit(2);
  }

  const alpha = await new Client('Alpha').signIn();
  const bravo = await new Client('Bravo').signIn();
  const charlie = await new Client('Charlie').signIn();
  const delta = await new Client('Delta').signIn();

  await Promise.all([alpha.connect(), bravo.connect(), charlie.connect(), delta.connect()]);

  section('Sign-in');
  const hello = await alpha.waitFor((m) => m.t === 'hello', 'hello');
  check('server greets an authenticated socket', hello.user.name === alpha.name);
  check('livekit url is advertised', typeof hello.livekitUrl === 'string' && hello.livekitUrl.length > 0);

  section('Opening a platoon');
  alpha.clear();
  alpha.send({ t: 'platoon:create', name: 'Smoke Test' });
  let state = await alpha.waitForState(() => true, 'platoon created');
  const code = state.platoon.code;
  const platoonId = state.platoon.id;
  check('creator becomes platoon leader', alpha.me(state).role === 'platoon_leader');
  check('join code is six characters', /^[A-Z0-9]{6}$/.test(code), code);
  check('four squads are laid out', state.platoon.squads.length === 4);
  check('platoon leader holds the command net', state.grants.command !== null);
  check('platoon leader has no squad net yet', state.grants.squad === null);
  check(
    'command room is namespaced to this platoon',
    decodeGrant(state.grants.command.token).room === `wd_${platoonId}_command`,
    state.grants.command.room,
  );

  section('Joining');
  bravo.clear();
  bravo.send({ t: 'platoon:join', code });
  state = await bravo.waitForState(() => true, 'bravo joined');
  check('joiner starts as a plain member', bravo.me(state).role === 'member');
  check('member without a squad gets no nets', !state.grants.squad && !state.grants.command);

  section('Squad leader holds two nets');
  bravo.clear();
  bravo.send({ t: 'squad:join', squadId: 1, asLeader: true });
  state = await bravo.waitForState((m) => bravo.me(m).role === 'squad_leader', 'bravo leads 1');
  check('claiming a free slot makes you squad leader', bravo.me(state).role === 'squad_leader');
  check('squad leader gets a squad net', state.grants.squad !== null);
  check('squad leader gets the command net too', state.grants.command !== null);
  check(
    'squad token points at squad 1',
    decodeGrant(state.grants.squad.token).room === `wd_${platoonId}_squad1`,
    state.grants.squad.room,
  );
  check('squad leader may transmit', decodeGrant(state.grants.squad.token).canPublish === true);

  section('Member is fenced out of command');
  charlie.clear();
  charlie.send({ t: 'platoon:join', code });
  await charlie.waitForState(() => true, 'charlie joined');
  charlie.clear();
  charlie.send({ t: 'squad:join', squadId: 1, asLeader: false });
  state = await charlie.waitForState((m) => charlie.me(m).squadId === 1, 'charlie in squad 1');
  check('member joins the squad', charlie.me(state).role === 'member');
  check('member gets exactly one net', state.grants.squad !== null && state.grants.command === null);
  check(
    'member token is scoped to the squad room only',
    decodeGrant(state.grants.squad.token).room === `wd_${platoonId}_squad1`,
  );

  charlie.clear();
  charlie.send({ t: 'leader:claim', squadId: 1 });
  const denied = await charlie.waitFor((m) => m.t === 'error', 'leader_taken error');
  check('a taken leader slot cannot be stolen', denied.code === 'leader_taken', denied.code);

  section('All-call');
  // Everyone hears it; only the platoon leader may key it. That split is the
  // whole guarantee, and it lives in which token can publish.
  check('the platoon leader holds an all-call grant', state.grants.allcall !== null);
  check(
    'the all-call room is namespaced to this platoon',
    decodeGrant(state.grants.allcall.token).room === `wd_${platoonId}_allcall`,
    state.grants.allcall.room,
  );
  check(
    'a member is on the all-call as a listener',
    state.grants.allcall.canPublish === false,
    `canPublish=${state.grants.allcall.canPublish}`,
  );

  const leaderState = await alpha.waitForState(() => true, 'alpha state');
  check('only the platoon leader may transmit on it', leaderState.grants.allcall?.canPublish === true);
  check(
    'the leader publishes into the same room everyone is listening on',
    decodeGrant(leaderState.grants.allcall.token).room ===
      decodeGrant(state.grants.allcall.token).room,
  );

  section('A second squad');
  delta.clear();
  delta.send({ t: 'platoon:join', code });
  await delta.waitForState(() => true, 'delta joined');
  delta.clear();
  delta.send({ t: 'squad:join', squadId: 2, asLeader: true });
  state = await delta.waitForState((m) => delta.me(m).role === 'squad_leader', 'delta leads 2');
  check(
    'second squad leader gets their own squad room',
    decodeGrant(state.grants.squad.token).room === `wd_${platoonId}_squad2`,
  );
  check(
    'both squad leaders share one command room',
    decodeGrant(state.grants.command.token).room === `wd_${platoonId}_command`,
  );

  section('Promotion moves the command grant');
  bravo.clear();
  charlie.clear();
  alpha.send({ t: 'admin:promote', playerId: charlie.id });

  const charliePromoted = await charlie.waitForState(
    (m) => charlie.me(m).role === 'squad_leader',
    'charlie promoted',
  );
  check('promoted member becomes squad leader', charlie.me(charliePromoted).role === 'squad_leader');
  check('promoted member gains the command net', charliePromoted.grants.command !== null);

  const bravoDemoted = await bravo.waitForState(
    (m) => bravo.me(m).role === 'member',
    'bravo demoted',
  );
  check('the previous leader is demoted', bravo.me(bravoDemoted).role === 'member');
  check('demoted leader loses the command net', bravoDemoted.grants.command === null);
  check('demoted leader keeps their squad net', bravoDemoted.grants.squad !== null);

  section('Platoon-leader controls');
  charlie.clear();
  charlie.send({ t: 'admin:kick', playerId: bravo.id });
  const forbidden = await charlie.waitFor((m) => m.t === 'error', 'forbidden error');
  check('a squad leader cannot kick', forbidden.code === 'forbidden', forbidden.code);

  alpha.clear();
  alpha.send({ t: 'admin:rename-squad', squadId: 3, role: 'Sniper Team' });
  state = await alpha.waitForState(
    (m) => m.platoon.squads.find((s) => s.id === 3)?.role === 'Sniper Team',
    'squad renamed',
  );
  check('platoon leader can rename a squad role', true);

  delta.clear();
  alpha.send({ t: 'admin:kick', playerId: delta.id });
  const kicked = await delta.waitFor((m) => m.t === 'kicked', 'kick notice');
  check('kicked player is told why', typeof kicked.reason === 'string');
  await delta.waitFor((m) => m.t === 'platoon:none', 'delta dropped');
  check('kicked player is out of the platoon', true);

  section('Reconnect keeps your slot');
  alpha.clear();
  charlie.close();
  await sleep(400);
  state = await alpha.waitForState(
    (m) => m.platoon.players.find((p) => p.id === charlie.id)?.online === false,
    'charlie marked offline',
  );
  check('a dropped socket shows as offline, not gone', true);

  const charlie2 = new Client('Charlie');
  charlie2.name = charlie.name;
  charlie2.token = charlie.token;
  charlie2.id = charlie.id;
  await charlie2.connect();
  const restored = await charlie2.waitForState(() => true, 'charlie restored');
  check('reconnect restores the squad', charlie2.me(restored).squadId === 1);
  check('reconnect restores the rank', charlie2.me(restored).role === 'squad_leader');
  check('reconnect restores the command net', restored.grants.command !== null);

  section('Squad size');
  const echo = await new Client('Echo').signIn();
  const foxtrot = await new Client('Foxtrot').signIn();
  const golf = await new Client('Golf').signIn();
  await Promise.all([echo.connect(), foxtrot.connect(), golf.connect()]);

  echo.clear();
  echo.send({ t: 'platoon:create', name: 'Size Test' });
  let sized = await echo.waitForState(() => true, 'size platoon');
  const sizeCode = sized.platoon.code;
  check('a new platoon starts at nine per squad', sized.platoon.squadSize === 9);

  echo.clear();
  echo.send({ t: 'admin:squad-size', size: 2 });
  sized = await echo.waitForState((m) => m.platoon.squadSize === 2, 'shrunk to 2');
  check('the leader can resize squads', sized.platoon.squadSize === 2);

  echo.clear();
  echo.send({ t: 'squad:join', squadId: 1, asLeader: false });
  await echo.waitForState((m) => echo.me(m).squadId === 1, 'echo in squad 1');

  foxtrot.clear();
  foxtrot.send({ t: 'platoon:join', code: sizeCode });
  await foxtrot.waitForState(() => true, 'foxtrot joined');
  foxtrot.clear();
  foxtrot.send({ t: 'squad:join', squadId: 1, asLeader: false });
  await foxtrot.waitForState((m) => foxtrot.me(m).squadId === 1, 'foxtrot in squad 1');

  golf.clear();
  golf.send({ t: 'platoon:join', code: sizeCode });
  await golf.waitForState(() => true, 'golf joined');
  golf.clear();
  golf.send({ t: 'squad:join', squadId: 1, asLeader: false });
  const squadFull = await golf.waitFor((m) => m.t === 'error', 'squad_full');
  check('the new limit is enforced', squadFull.code === 'squad_full', squadFull.code);

  echo.clear();
  echo.send({ t: 'admin:squad-size', size: 12 });
  await echo.waitForState((m) => m.platoon.squadSize === 12, 'raised to 12');
  golf.clear();
  golf.send({ t: 'squad:join', squadId: 1, asLeader: false });
  const golfIn = await golf.waitForState((m) => golf.me(m).squadId === 1, 'golf in squad 1');
  check('raising the limit lets more people in', golf.me(golfIn).squadId === 1);
  check(
    'a squad can hold more than the old nine',
    golfIn.platoon.squadSize === 12 && golfIn.platoon.players.filter((p) => p.squadId === 1).length === 3,
  );

  echo.clear();
  echo.send({ t: 'admin:squad-size', size: 999 });
  const absurd = await echo.waitFor((m) => m.t === 'error', 'size rejected');
  check('an out-of-range squad size is refused', absurd.code === 'bad_request', absurd.code);

  foxtrot.clear();
  foxtrot.send({ t: 'admin:squad-size', size: 5 });
  const notLeader = await foxtrot.waitFor((m) => m.t === 'error', 'forbidden');
  check('only the platoon leader may resize', notLeader.code === 'forbidden', notLeader.code);

  section('Password');
  const hotel = await new Client('Hotel').signIn();
  const india = await new Client('India').signIn();
  await Promise.all([hotel.connect(), india.connect()]);

  const SECRET = 'tajne-heslo-123';
  hotel.clear();
  hotel.send({ t: 'platoon:create', name: 'Locked', password: SECRET, listed: true });
  const locked = await hotel.waitForState(() => true, 'locked platoon');
  check('a platoon can be opened with a password', locked.platoon.hasPassword === true);
  check(
    'the password never travels in the roster',
    !JSON.stringify(locked.platoon).includes(SECRET),
  );

  india.clear();
  india.send({ t: 'platoon:join', code: locked.platoon.code });
  const noPassword = await india.waitFor((m) => m.t === 'error', 'bad_password');
  check('joining with no password is refused', noPassword.code === 'bad_password', noPassword.code);

  india.clear();
  india.send({ t: 'platoon:join', code: locked.platoon.code, password: 'wrong' });
  const wrongPassword = await india.waitFor((m) => m.t === 'error', 'bad_password');
  check('a wrong password is refused', wrongPassword.code === 'bad_password');

  india.clear();
  india.send({ t: 'platoon:join', code: locked.platoon.code, password: SECRET });
  const unlocked = await india.waitForState((m) => india.me(m) !== undefined, 'india joined');
  check('the right password gets you in', india.me(unlocked) !== undefined);

  hotel.clear();
  hotel.send({ t: 'admin:password', password: '' });
  const unlockedState = await hotel.waitForState(
    (m) => m.platoon.hasPassword === false,
    'password cleared',
  );
  check('the leader can take the password off', unlockedState.platoon.hasPassword === false);

  section('Platoon browser');
  hotel.clear();
  hotel.send({ t: 'platoon:list' });
  const browser = await hotel.waitFor((m) => m.t === 'platoon:browser', 'browser');
  const entry = browser.platoons.find((p) => p.id === locked.platoon.id);
  check('a listed platoon shows up', entry !== undefined);
  check('the browser reports occupancy', entry?.players === 2 && entry?.capacity > 0);
  check(
    'the browser never carries join codes',
    !JSON.stringify(browser.platoons).includes(locked.platoon.code),
  );
  check('the browser never carries the roster', !Array.isArray(entry?.players));

  // Joining straight out of the browser, without ever seeing a code.
  golf.clear();
  golf.send({ t: 'platoon:join', platoonId: locked.platoon.id });
  const viaBrowser = await golf.waitForState(
    (m) => m.platoon.id === locked.platoon.id,
    'golf joined by id',
  );
  check('you can join by id from the browser', viaBrowser.platoon.id === locked.platoon.id);

  hotel.clear();
  hotel.send({ t: 'admin:listed', listed: false });
  await hotel.waitForState((m) => m.platoon.listed === false, 'unlisted');
  hotel.clear();
  hotel.send({ t: 'platoon:list' });
  const browser2 = await hotel.waitFor((m) => m.t === 'platoon:browser', 'browser again');
  check(
    'an unlisted platoon is hidden from the browser',
    !browser2.platoons.some((p) => p.id === locked.platoon.id),
  );

  section('Bad input');
  alpha.clear();
  alpha.send({ t: 'platoon:join', code: 'XX' });
  const badCode = await alpha.waitFor((m) => m.t === 'error', 'bad_request');
  check('a malformed join code is rejected', badCode.code === 'bad_request', badCode.code);

  alpha.clear();
  alpha.send({ t: 'squad:join', squadId: 99, asLeader: false });
  const badSquad = await alpha.waitFor((m) => m.t === 'error', 'unknown squad');
  check('an unknown squad id is rejected', badSquad.code === 'bad_request', badSquad.code);

  for (const client of [alpha, bravo, charlie2, delta, echo, foxtrot, golf, hotel, india]) {
    client.close();
  }
  await sleep(200);

  console.log(
    `\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n\x1b[31mtest run crashed:\x1b[0m', err.message);
  process.exit(1);
});
