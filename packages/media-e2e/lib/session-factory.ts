// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { MOQTransport } from '@moq-web/core';
import { MOQTSession } from '@moq-web/session';
import { MediaSession } from '@moq-web/media';

import type { ResolvedProfile } from './profile.js';

export interface MediaSessionHandle {
  session: MOQTSession;
  media: MediaSession;
  transport: MOQTransport;
  close(): Promise<void>;
}

/**
 * Connect + set up a MOQTSession, then wrap it with a MediaSession. The
 * MediaSession is created in "session mode" (reusing our already-connected
 * MOQTSession) so the setup handshake goes through the same code path
 * session-e2e exercises.
 */
export async function makeMediaSession(profile: ResolvedProfile): Promise<MediaSessionHandle> {
  const transport = new MOQTransport();
  await transport.connect(profile.relayUrl);

  const session = new MOQTSession(transport);

  if (profile.authToken && profile.auth?.scope !== 'per-request') {
    const tokenType =
      typeof profile.auth?.tokenType === 'number' ? profile.auth.tokenType : undefined;
    session.setAuthToken(profile.authToken, tokenType);
  }

  await session.setup();

  const media = new MediaSession({ session });

  return {
    session,
    media,
    transport,
    async close() {
      try {
        await session.close();
      } catch {
        // best-effort
      }
      try {
        await transport.close();
      } catch {
        // best-effort
      }
    },
  };
}
