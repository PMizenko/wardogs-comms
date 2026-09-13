/**
 * Who gets heard when two people talk at once.
 *
 * Kept apart from the engine and free of dependencies: it is pure policy, it is
 * the part that is easy to get backwards, and separating it means it can be
 * tested without a browser or an SFU. See scripts/test-ducking.mjs.
 */

/** Rank values fed in from the roster. Higher outranks lower. */
export const RANK = { member: 0, squadLeader: 1, platoonLeader: 2 } as const;

/**
 * The highest rank currently on the air. 0 means nobody senior is speaking, so
 * nothing should duck.
 */
export function topSpeakingRank(
  speakers: Iterable<string>,
  ranks: ReadonlyMap<string, number>,
): number {
  let top = 0;
  for (const id of speakers) top = Math.max(top, ranks.get(id) ?? 0);
  return top;
}

/**
 * Whether a voice of `rank` should be ducked while `topRank` is on the air.
 *
 * Strictly lower ranks duck. Equals do not, so two squad leaders can hold a
 * normal conversation on the command net, and the platoon leader is never
 * ducked by anyone.
 */
export function shouldDuck(rank: number, topRank: number): boolean {
  return topRank > 0 && rank < topRank;
}
