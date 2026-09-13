/**
 * Channel layout of a platoon.
 *
 * The shape mirrors the doctrine the app exists to support: four squad nets
 * that are acoustically isolated from each other, plus one command net that
 * only squad leaders are allowed onto. Everything downstream - token grants,
 * UI colours, overlay badges - derives from these constants, so this file is
 * the single place to change if a platoon ever grows a fifth squad.
 */

export const SQUAD_IDS = [1, 2, 3, 4] as const;
export type SquadId = (typeof SQUAD_IDS)[number];

export const COMMAND_CHANNEL = 'command' as const;

/**
 * The all-call net: the platoon leader talking to everybody at once.
 *
 * It exists because "everyone regroup" otherwise has to be relayed by four
 * squad leaders in turn, and by the time the fourth has said it the situation
 * has moved. Everyone subscribes; only the platoon leader may transmit, which
 * is enforced by who gets a publishing token.
 */
export const ALLCALL_CHANNEL = 'allcall' as const;

/** A channel is one of the four squad nets, the command net, or the all-call. */
export type ChannelId = SquadId | typeof COMMAND_CHANNEL | typeof ALLCALL_CHANNEL;

export interface SquadDefinition {
  id: SquadId;
  /** Short label shown on the card, e.g. "SQUAD 1". */
  name: string;
  /** Doctrinal role, e.g. "Infantry". Editable by the platoon leader. */
  role: string;
  /** Accent colour driving the card border, headset icon and overlay dot. */
  color: string;
}

/** Defaults taken from the Wardogs platoon-VOIP layout. */
export const DEFAULT_SQUADS: readonly SquadDefinition[] = [
  { id: 1, name: 'Squad 1', role: 'Infantry', color: '#ef4444' },
  { id: 2, name: 'Squad 2', role: 'Assault', color: '#3b82f6' },
  { id: 3, name: 'Squad 3', role: 'Logistics / FOB', color: '#22c55e' },
  { id: 4, name: 'Squad 4', role: 'Vehicles', color: '#a855f7' },
] as const;

export const COMMAND_COLOR = '#e0b13a';

export function isSquadId(value: unknown): value is SquadId {
  return typeof value === 'number' && (SQUAD_IDS as readonly number[]).includes(value);
}

/**
 * LiveKit room name for a channel. Rooms are namespaced per platoon so two
 * concurrent platoons never share a voice bus.
 */
export function roomName(platoonId: string, channel: ChannelId): string {
  if (channel === COMMAND_CHANNEL) return `wd_${platoonId}_command`;
  if (channel === ALLCALL_CHANNEL) return `wd_${platoonId}_allcall`;
  return `wd_${platoonId}_squad${channel}`;
}
