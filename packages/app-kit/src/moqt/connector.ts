// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Shared session bootstrap used by every demo app.
 *
 * Wraps `@moq-web/core` + `@moq-web/session` with the app-kit TransportConfig
 * and a relay-list failover loop so each app just calls `connectMoqtSession(cfg)`
 * without hard-coding a relay or draft.
 */

import { MOQTransport, Logger } from '@moq-web/core';
import { MOQTSession } from '@moq-web/session';
import type { TransportConfig } from '../transport/state.js';
import { getAuthAdapter } from '../auth/index.js';
import type { AuthOperation } from '../auth/index.js';

const log = Logger.create('app-kit:moqt:connector');

export interface ConnectedSession {
  session: MOQTSession;
  transport: MOQTransport;
  relayUrl: string;
}

export interface ConnectMoqtOptions {
  transport: TransportConfig;
  /** Optional CAT/authorization token bytes for CLIENT_SETUP. */
  authToken?: { raw: string; type: number };
  /** Optional signal so React effects can cancel a slow connect. */
  signal?: AbortSignal;
  /** Optional client extensions (draft-18 CLIENT_SETUP kvps). */
  clientExtensions?: Map<number, import('@moq-web/core').SetupExtensionValue>;
  /** Optional MOQT_IMPLEMENTATION string to advertise (draft-18 §13.8). */
  implementationString?: string;
  /**
   * What the caller intends to do on this session. When a relay-vendor auth
   * adapter is selected in transport config, the connector mints a token
   * with matching capability and attaches it per the adapter (Cloudflare =
   * `?jwt=<token>` on the URL). When no adapter is selected this hint is
   * ignored and the connect path is unchanged.
   */
  auth?: { operations: AuthOperation[] };
}

function assertRelayList(urls: string[]): asserts urls is string[] {
  if (!urls || urls.length === 0) {
    throw new Error('No relays configured. Add at least one relay in the transport panel.');
  }
}

/**
 * Try each configured relay in order. First one that establishes the
 * WebTransport handshake wins; the rest are only touched if that one fails.
 * Aborts if `signal` fires.
 */
export async function connectMoqtSession(opts: ConnectMoqtOptions): Promise<ConnectedSession> {
  const { transport: cfg, authToken, signal, clientExtensions, implementationString, auth } = opts;
  assertRelayList(cfg.relay.relays);

  // Resolve the selected auth adapter once. If none is configured, the loop
  // below sees `adapter === null` and behaves like before this change.
  const adapter = getAuthAdapter(cfg.auth?.providerId);
  const requestedOps = auth?.operations;

  const errors: Array<{ url: string; err: unknown }> = [];
  for (const url of cfg.relay.relays) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

    let connectUrl = url;
    if (adapter && requestedOps && requestedOps.length > 0) {
      try {
        const token = await adapter.mintToken({
          relayUrl: url,
          operations: requestedOps,
          state: cfg.auth?.providerState ?? {},
          signal,
        });
        connectUrl = adapter.applyToUrl(url, token);
      } catch (err) {
        log.warn('Auth adapter mint failed, trying next relay', {
          url,
          adapter: adapter.id,
          err,
        });
        errors.push({ url, err });
        continue;
      }
    }

    log.info('Connecting to relay', { url, draft: cfg.relay.draft });
    const transport = new MOQTransport({ draft: cfg.relay.draft });
    try {
      await transport.connect(connectUrl);
      if (signal?.aborted) {
        try { await transport.close(); } catch { /* noop */ }
        throw new DOMException('aborted', 'AbortError');
      }
      const session = new MOQTSession(transport);
      if (clientExtensions) session.setClientExtensions(clientExtensions);
      if (implementationString) session.setImplementationString(implementationString);
      if (authToken) session.setAuthToken(authToken.raw, authToken.type);
      if (cfg.relay.keepAliveMs > 0) {
        session.configureIdle({ keepaliveIntervalMs: cfg.relay.keepAliveMs });
      }
      await session.setup();
      log.info('MoQT session ready', { url });
      return { session, transport, relayUrl: url };
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') throw err;
      log.warn('Relay failed, trying next', { url, err });
      errors.push({ url, err });
      try { await transport.close(); } catch { /* noop */ }
    }
  }

  const summary = errors
    .map(({ url, err }) => `${url}: ${(err as Error)?.message ?? String(err)}`)
    .join('; ');
  throw new Error(`All relays failed: ${summary}`);
}
