/**
 * Verifies the media side is reachable and correctly keyed.
 *
 * The two things that actually break here are the SFU not running and the API
 * key/secret in .env not matching the ones the SFU was started with. Both look
 * identical from the client - voice simply never connects - so this checks them
 * directly against the LiveKit admin API.
 *
 * Run:  node scripts/check-livekit.mjs
 */
import { config as loadEnv } from 'dotenv';
import { RoomServiceClient } from 'livekit-server-sdk';

loadEnv();

const wsUrl = process.env.LIVEKIT_URL ?? 'ws://localhost:7880';
const apiKey = process.env.LIVEKIT_API_KEY ?? '';
const apiSecret = process.env.LIVEKIT_API_SECRET ?? '';
const httpUrl = wsUrl.replace(/^ws/, 'http');

function fail(message, hint) {
  console.log(`\x1b[31m  ✗ ${message}\x1b[0m`);
  if (hint) console.log(`    ${hint}`);
  process.exit(1);
}

console.log('\n\x1b[1mLiveKit check\x1b[0m');
console.log(`  url: ${wsUrl}\n`);

if (!apiKey || !apiSecret) {
  fail('LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not set', 'Copy .env.example to .env.');
}

// 1. Is anything listening?
try {
  const res = await fetch(httpUrl, { signal: AbortSignal.timeout(4000) });
  console.log(`\x1b[32m  ✓\x1b[0m SFU is reachable (HTTP ${res.status})`);
} catch (err) {
  fail(
    `nothing answering at ${httpUrl}`,
    'Start it with:  npm run livekit    (needs Docker Desktop running)',
  );
}

// 2. Do our credentials actually open the admin API?
const client = new RoomServiceClient(httpUrl, apiKey, apiSecret);
let rooms;
try {
  rooms = await client.listRooms();
} catch (err) {
  fail(
    'the SFU rejected our API credentials',
    'LIVEKIT_API_KEY / LIVEKIT_API_SECRET in .env must match the keys in livekit.yaml.',
  );
}
console.log(`\x1b[32m  ✓\x1b[0m API key "${apiKey}" is accepted`);

// 3. Report what is live, which is a quick way to see a match in progress.
const wardogsRooms = rooms.filter((r) => r.name.startsWith('wd_'));
if (wardogsRooms.length === 0) {
  console.log('  · no platoon channels open right now');
} else {
  console.log(`  · ${wardogsRooms.length} platoon channel(s) open:`);
  for (const room of wardogsRooms) {
    const kind = room.name.endsWith('_command') ? 'command' : room.name.split('_').pop();
    console.log(`      ${kind.padEnd(8)} ${room.numParticipants} participant(s)`);
  }
}

console.log('\n\x1b[32mMedia path is ready.\x1b[0m\n');
