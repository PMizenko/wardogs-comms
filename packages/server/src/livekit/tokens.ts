import { AccessToken, TrackSource } from 'livekit-server-sdk';
import {
  ALLCALL_CHANNEL,
  COMMAND_CHANNEL,
  roomName,
  type ChannelGrant,
  type ChannelId,
  type PlayerState,
  type VoiceGrants,
} from '@wardogs/shared';
import { config } from '../config.js';

/**
 * A token is scoped to exactly one room. That is the enforcement point for the
 * whole permission model: a member physically cannot join the command net,
 * because the server never mints them a token for it. Nothing in the client can
 * talk its way onto a net it was not granted.
 */
const TOKEN_TTL = '4h';

async function mintGrant(
  platoonId: string,
  channel: ChannelId,
  player: PlayerState,
  canPublish: boolean,
): Promise<ChannelGrant> {
  const room = roomName(platoonId, channel);
  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: player.id,
    name: player.name,
    ttl: TOKEN_TTL,
  });
  at.addGrant({
    room,
    roomJoin: true,
    canPublish,
    canSubscribe: true,
    // Used for the lightweight radio-activity beacons between clients.
    canPublishData: true,
    // Voice only - no screen share, no camera, enforced server-side.
    canPublishSources: canPublish ? [TrackSource.MICROPHONE] : [],
  });

  return {
    channel,
    room,
    token: await at.toJwt(),
    url: config.livekit.url,
    canPublish,
  };
}

/**
 * Work out which nets a player may open, and mint one token per net.
 *
 * Squad members get their squad net. Squad leaders additionally get the command
 * net - that dual membership is the feature the whole app is built around. The
 * platoon leader holds the command net even while unassigned to a squad.
 */
export async function issueGrants(
  platoonId: string,
  player: PlayerState,
): Promise<VoiceGrants> {
  const wantsCommand = player.role === 'squad_leader' || player.role === 'platoon_leader';

  const [squad, command, allcall] = await Promise.all([
    player.squadId !== null ? mintGrant(platoonId, player.squadId, player, true) : null,
    wantsCommand ? mintGrant(platoonId, COMMAND_CHANNEL, player, true) : null,
    // Everybody listens on the all-call; only the platoon leader gets a token
    // that may publish there, which is what keeps it from becoming a free-for-all.
    mintGrant(platoonId, ALLCALL_CHANNEL, player, player.role === 'platoon_leader'),
  ]);

  return { squad, command, allcall };
}
