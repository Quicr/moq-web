// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { MOQTransport } from '@moq-web/core';
import { MOQTSession } from '@moq-web/session';

import type { ResolvedProfile } from './profile.js';

export interface SessionHandle {
  session: MOQTSession;
  transport: MOQTransport;
  close(): Promise<void>;
}

/**
 * Connect to the relay and run CLIENT_SETUP. If the profile carries an
 * `auth.tokenEnv` and its scope includes 'setup', the token is attached
 * to CLIENT_SETUP via AUTHORIZATION_TOKEN.
 */
export async function makeSession(profile: ResolvedProfile): Promise<SessionHandle> {
  const transport = new MOQTransport();
  await transport.connect(profile.relayUrl);

  const session = new MOQTSession(transport);

  if (profile.authToken && profile.auth?.scope !== 'per-request') {
    const tokenType =
      typeof profile.auth?.tokenType === 'number' ? profile.auth.tokenType : undefined;
    session.setAuthToken(profile.authToken, tokenType);
  }

  await session.setup();

  return {
    session,
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
