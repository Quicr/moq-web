// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { useCallback, useEffect, useRef, useState } from 'react';
import type { StatusState } from '../shell/StatusDot.js';
import { getTransportConfig, useTransportConfig } from '../transport/state.js';

/**
 * Headless MoQT session helper.
 *
 * This hook returns a lightweight state machine (`idle → connecting → ready → error`)
 * plus `connect/disconnect` handlers. The actual transport wiring is intentionally
 * delegated: consumers pass a `connect` function that returns a session-like
 * object with a `close()` method. That lets apps compose with either the raw
 * `MOQTSession` (from @moq-web/session) or the higher-level `MediaSession`
 * (from @moq-web/media) without app-kit taking a hard dependency on either
 * transport shape.
 */
export interface MoqtSessionHandle {
  close: () => Promise<void> | void;
}

export type MoqtConnector<T extends MoqtSessionHandle = MoqtSessionHandle> = (opts: {
  relayUrls: string[];
  draft: 'draft-16' | 'draft-18';
  keepAliveMs: number;
  signal: AbortSignal;
}) => Promise<T>;

export interface UseMoqtSessionResult<T extends MoqtSessionHandle> {
  session: T | null;
  status: StatusState;
  error: Error | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

export function useMoqtSession<T extends MoqtSessionHandle = MoqtSessionHandle>(
  connector: MoqtConnector<T>,
): UseMoqtSessionResult<T> {
  const cfg = useTransportConfig();
  const [session, setSession] = useState<T | null>(null);
  const [status, setStatus] = useState<StatusState>('idle');
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const disconnect = useCallback(async () => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (session) {
      try {
        await session.close();
      } catch {
        /* swallow */
      }
    }
    setSession(null);
    setStatus('idle');
  }, [session]);

  const connect = useCallback(async () => {
    setError(null);
    setStatus('connecting');
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const current = getTransportConfig();
      const s = await connector({
        relayUrls: current.relay.relays,
        draft: current.relay.draft,
        keepAliveMs: current.relay.keepAliveMs,
        signal: ac.signal,
      });
      if (ac.signal.aborted) {
        await s.close();
        return;
      }
      setSession(s);
      setStatus('ready');
    } catch (e) {
      setError(e as Error);
      setStatus('error');
    }
  }, [connector]);

  useEffect(() => () => {
    abortRef.current?.abort();
    session?.close();
  }, [session]);

  // Auto-reconnect: if user enabled it and status entered `error`, try again.
  useEffect(() => {
    if (status !== 'error') return;
    if (!cfg.relay.autoReconnect) return;
    const id = setTimeout(() => void connect(), 2000);
    return () => clearTimeout(id);
  }, [status, cfg.relay.autoReconnect, connect]);

  return { session, status, error, connect, disconnect };
}
