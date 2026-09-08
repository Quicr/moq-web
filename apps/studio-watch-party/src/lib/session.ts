import { MOQTransport } from '@moq-web/core';
import { MOQTSession } from '@moq-web/session';
import { MediaSession } from '@moq-web/media';

export const DEFAULT_RELAY_URL =
  'https://moqx-main.ci.openmoq.org:4433/moq-relay';

export const APP_NAMESPACE_PREFIX = ['msf-demo', 'studio-watch-party'];

export const VIDEO_TRACK_NAME = 'video-main';
export const AUDIO_TRACK_NAME = 'audio-main';

export const VIDEO_CONFIG = {
  videoBitrate: 2_000_000,
  audioBitrate: 0,
  videoResolution: '720p' as const,
  videoEnabled: true,
  audioEnabled: false,
  deliveryMode: 'stream' as const,
  audioDeliveryMode: 'stream' as const,
};

export const AUDIO_CONFIG = {
  videoBitrate: 0,
  audioBitrate: 64_000,
  videoResolution: '480p' as const,
  videoEnabled: false,
  audioEnabled: true,
  deliveryMode: 'datagram' as const,
  audioDeliveryMode: 'datagram' as const,
};

export interface RoomConnection {
  transport: MOQTransport;
  session: MOQTSession;
  media: MediaSession;
  namespace: string[];
}

export async function connectToRelay(
  relayUrl: string,
  roomId: string
): Promise<RoomConnection> {
  const transport = new MOQTransport();
  await transport.connect(relayUrl);

  const session = new MOQTSession(transport);
  await session.setup();

  const media = new MediaSession({ session });
  const namespace = [...APP_NAMESPACE_PREFIX, roomId];
  return { transport, session, media, namespace };
}

export async function closeConnection(conn: RoomConnection): Promise<void> {
  try {
    await conn.media.close();
  } catch {
    // no-op
  }
  try {
    await conn.session.close();
  } catch {
    // no-op
  }
}
