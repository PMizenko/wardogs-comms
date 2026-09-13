/**
 * Priority ducking decision table.
 *
 * Small surface, nasty failure mode: get the comparison backwards and the app
 * silences the person giving the order instead of the chatter over it. Worth
 * pinning down.
 *
 * Run:  npm run test:ducking
 */
import { topSpeakingRank, shouldDuck, RANK } from '../packages/desktop/src/renderer/src/voice/priority.ts';

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  \x1b[32mok\x1b[0m   ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label} — expected ${expected}, got ${actual}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

// A platoon leader, two squad leaders and two ordinary members.
const ranks = new Map([
  ['pl', RANK.platoonLeader],
  ['sl1', RANK.squadLeader],
  ['sl2', RANK.squadLeader],
  ['rifleman', RANK.member],
  ['medic', RANK.member],
]);

const duckedWhenSpeaking = (speakers, listener) =>
  shouldDuck(ranks.get(listener) ?? 0, topSpeakingRank(speakers, ranks));

console.log('\n\x1b[1mWardogs VOIP — priority ducking\x1b[0m');

section('Nobody senior is talking');
check('quiet net ducks nobody', duckedWhenSpeaking([], 'rifleman'), false);
check('a member talking ducks nobody', duckedWhenSpeaking(['rifleman'], 'medic'), false);
check('two members talking duck nobody', duckedWhenSpeaking(['rifleman', 'medic'], 'medic'), false);

section('A squad leader gives an order');
check('chatter ducks', duckedWhenSpeaking(['sl1'], 'rifleman'), true);
check('the squad leader is not ducked by themselves', duckedWhenSpeaking(['sl1'], 'sl1'), false);
check('another squad leader is not ducked', duckedWhenSpeaking(['sl1'], 'sl2'), false);
check('the platoon leader is never ducked', duckedWhenSpeaking(['sl1'], 'pl'), false);

section('The platoon leader speaks');
check('chatter ducks', duckedWhenSpeaking(['pl'], 'rifleman'), true);
check('squad leaders duck too', duckedWhenSpeaking(['pl'], 'sl1'), true);
check('the platoon leader is not ducked', duckedWhenSpeaking(['pl'], 'pl'), false);

section('Both talk at once — the senior one wins');
check('members duck', duckedWhenSpeaking(['pl', 'sl1'], 'rifleman'), true);
check('the squad leader ducks under the platoon leader', duckedWhenSpeaking(['pl', 'sl1'], 'sl1'), true);
check('the platoon leader stays clear', duckedWhenSpeaking(['pl', 'sl1'], 'pl'), false);

section('Across nets');
// A squad leader hears their squad *and* command. An order on command must
// duck the squad net, which is the whole point of the feature.
check(
  'command order ducks squad chatter',
  duckedWhenSpeaking(['pl', 'rifleman'], 'rifleman'),
  true,
);
check(
  'squad chatter does not duck the command net',
  duckedWhenSpeaking(['rifleman'], 'pl'),
  false,
);

section('Unknown speakers');
check('an unranked speaker ducks nobody', duckedWhenSpeaking(['ghost'], 'rifleman'), false);
check('top rank of an empty net is 0', topSpeakingRank([], ranks), 0);
check('top rank picks the highest', topSpeakingRank(['rifleman', 'pl', 'sl1'], ranks), 2);

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
