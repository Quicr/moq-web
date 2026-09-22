// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Pure helpers extracted from session.ts
 *
 * These have no dependency on `MOQTSession` instance state, so they live in a
 * separate module for readability and unit-testability. Keep this file free of
 * side effects and free of `MOQTSession` imports.
 */

import {
  BufferWriter,
  ConnectionStateMachine as _ConnectionStateMachine,
  MOQTVarInt,
  RequestParameterDraft18,
  SubscriptionFilterDraft18,
  TrackPropertyDraft18,
  type ConnectionState,
  type ControlMessageDraft18,
  type IProtocolCodec,
} from '@moq-web/core';
import { base64urlDecode, coseSign1Encode } from '@moq-web/cat';
import type { SessionState } from './types.js';

/** Draft-18 subscription filter shape used by the SUBSCRIBE builder. */
export type Location = { group: bigint; object: bigint };

/**
 * Narrow a bigint to a JS `number`, throwing when the value overflows
 * `Number.MAX_SAFE_INTEGER`. Used sparingly at points where downstream code
 * cannot yet accept bigint (media pipeline group/object arithmetic).
 */
export function narrowBigIntToNumber(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `${field}=${value.toString()} exceeds Number.MAX_SAFE_INTEGER; ` +
        `session cannot represent this value in the bounded-number plane.`,
    );
  }
  return Number(value);
}

/**
 * Draft-18 §10.2 subscriber-side delivery timeouts on SUBSCRIBE/FETCH.
 * Each is an even-key MOQT varint; a value of 0 or undefined omits it.
 */
export function addDeliveryTimeoutParams(
  parameters: Map<number, Uint8Array>,
  options?: {
    subgroupDeliveryTimeout?: number;
    objectDeliveryTimeout?: number;
    fillTimeout?: number;
    rendezvousTimeout?: number;
  },
): void {
  if (!options) return;
  const set = (key: number, ms: number | undefined) => {
    if (!ms || ms <= 0) return;
    parameters.set(key, MOQTVarInt.encode(BigInt(ms)));
  };
  set(RequestParameterDraft18.SUBGROUP_DELIVERY_TIMEOUT, options.subgroupDeliveryTimeout);
  set(RequestParameterDraft18.OBJECT_DELIVERY_TIMEOUT, options.objectDeliveryTimeout);
  set(RequestParameterDraft18.FILL_TIMEOUT, options.fillTimeout);
  set(RequestParameterDraft18.RENDEZVOUS_TIMEOUT, options.rendezvousTimeout);
}

/**
 * Draft-18 §10.2.9 SUBSCRIPTION_FILTER mapping.
 *
 * Translates the string-form `SubscribeOptions.filterType` (plus its start/end
 * hints) into a `SubscriptionFilterDraft18` variant with the ranges the
 * SUBSCRIBE codec expects. Unknown / omitted values default to
 * `NEXT_GROUP_START`, matching draft-18's default filter and the pre-change
 * session behaviour.
 */
export function mapSubscribeFilter(options: {
  filterType?: 'latest' | 'absolute' | 'next-group' | 'largest-object' | 'absolute-start' | 'absolute-range';
  startGroup?: number;
  startObject?: number;
  endGroup?: number;
} | undefined): {
  filter: SubscriptionFilterDraft18;
  startLocation?: Location;
  endGroupDelta?: bigint;
} {
  const startGroup = BigInt(options?.startGroup ?? 0);
  const startObject = BigInt(options?.startObject ?? 0);
  const kind = options?.filterType;

  switch (kind) {
    case 'largest-object':
      return { filter: SubscriptionFilterDraft18.LARGEST_OBJECT };
    case 'absolute':
    case 'absolute-start':
      return {
        filter: SubscriptionFilterDraft18.ABSOLUTE_START,
        startLocation: { group: startGroup, object: startObject },
      };
    case 'absolute-range': {
      const endGroup = BigInt(options?.endGroup ?? options?.startGroup ?? 0);
      const delta = endGroup >= startGroup ? endGroup - startGroup : 0n;
      return {
        filter: SubscriptionFilterDraft18.ABSOLUTE_RANGE,
        startLocation: { group: startGroup, object: startObject },
        endGroupDelta: delta,
      };
    }
    case 'latest':
    case 'next-group':
    case undefined:
    default:
      return { filter: SubscriptionFilterDraft18.NEXT_GROUP_START };
  }
}

/**
 * Draft-18 §3.2.1 — a Track Namespace whose first tuple field begins with
 * '.' (0x2e) is reserved. Refuse to originate outbound requests under any
 * reserved namespace by default; this endpoint has no IANA-registered
 * definition to justify use of one.
 */
export function assertNotReservedNamespace(namespace: string[], action: string): void {
  const first = namespace[0];
  if (first === undefined || first.length === 0 || first.charCodeAt(0) !== 0x2e) return;
  throw new Error(
    `Draft-18 §3.2.1: refusing to ${action} under reserved namespace ` +
      `starting with '.': ${JSON.stringify(namespace)}`,
  );
}

/**
 * Draft-18 §10.2.14 TRACK_NAMESPACE_PREFIX serializer. Encodes a namespace
 * tuple as `varint(count) [varint(len) utf8(field)]*`, matching what the wire
 * codec produces.
 */
export function encodeTrackNamespaceBytes(namespace: string[]): Uint8Array {
  const writer = new BufferWriter();
  writer.writeVarInt(BigInt(namespace.length));
  const encoder = new TextEncoder();
  for (const field of namespace) {
    const bytes = encoder.encode(field);
    writer.writeVarInt(BigInt(bytes.length));
    writer.writeBytes(bytes);
  }
  return writer.toUint8Array();
}

/**
 * Inverse of {@link encodeTrackNamespaceBytes}. Returns `undefined` for
 * malformed input rather than throwing — the caller (parameter parser) treats
 * a malformed prefix as best-effort ignored.
 */
export function decodeTrackNamespaceBytes(bytes: Uint8Array): string[] | undefined {
  try {
    const [count, offset0] = MOQTVarInt.decode(bytes);
    let offset = offset0;
    const out: string[] = [];
    const decoder = new TextDecoder();
    for (let i = 0; i < Number(count); i++) {
      const [len, next] = MOQTVarInt.decode(bytes.subarray(offset));
      offset += next;
      const l = Number(len);
      out.push(decoder.decode(bytes.subarray(offset, offset + l)));
      offset += l;
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Draft-18 §12 publisher-side track properties advertised on PUBLISH. Each
 * key is an even-key MOQT varint; 0/undefined omits it. Returns `undefined`
 * when no properties are set so the caller can skip the parameter entirely.
 */
export function buildTrackProperties(options?: {
  subgroupDeliveryTimeout?: number;
  objectDeliveryTimeout?: number;
  maxCacheDuration?: number;
  priority?: number;
  groupOrder?: number;
  priorGroupIdGap?: number;
  priorObjectIdGap?: number;
}): Map<number, Uint8Array> | undefined {
  if (!options) return undefined;
  const props = new Map<number, Uint8Array>();
  const setMs = (key: number, ms: number | undefined) => {
    if (!ms || ms <= 0) return;
    props.set(key, MOQTVarInt.encode(BigInt(ms)));
  };
  const setNonNegative = (key: number, n: number | undefined) => {
    if (n === undefined || n < 0) return;
    props.set(key, MOQTVarInt.encode(BigInt(Math.floor(n))));
  };
  setMs(TrackPropertyDraft18.SUBGROUP_DELIVERY_TIMEOUT, options.subgroupDeliveryTimeout);
  setMs(TrackPropertyDraft18.OBJECT_DELIVERY_TIMEOUT, options.objectDeliveryTimeout);
  setMs(TrackPropertyDraft18.MAX_CACHE_DURATION, options.maxCacheDuration);
  if (options.priority !== undefined) {
    props.set(
      TrackPropertyDraft18.DEFAULT_PUBLISHER_PRIORITY,
      MOQTVarInt.encode(BigInt(options.priority)),
    );
  }
  if (options.groupOrder !== undefined) {
    props.set(
      TrackPropertyDraft18.DEFAULT_PUBLISHER_GROUP_ORDER,
      MOQTVarInt.encode(BigInt(options.groupOrder)),
    );
  }
  setNonNegative(TrackPropertyDraft18.PRIOR_GROUP_ID_GAP, options.priorGroupIdGap);
  setNonNegative(TrackPropertyDraft18.PRIOR_OBJECT_ID_GAP, options.priorObjectIdGap);
  return props.size > 0 ? props : undefined;
}

/**
 * Map the session's coarse-grained state to a
 * {@link ConnectionStateMachine} state. Returns `undefined` when there is no
 * direct mapping (caller should skip).
 */
export function sessionStateToConnectionState(state: SessionState): ConnectionState | undefined {
  switch (state) {
    case 'none':
      return 'disconnected';
    case 'setup':
      return 'setup_sent';
    case 'ready':
      return 'connected';
    case 'closing':
      return 'closing';
    case 'error':
      return 'error';
    default:
      return undefined;
  }
}

/**
 * Generate a random 16-char hex session identifier. Prefers
 * `crypto.randomUUID()`, then `getRandomValues`, then Math.random as a last
 * resort for stripped-down worker hosts.
 */
export function generateSessionId(): string {
  if (typeof crypto !== 'undefined') {
    const c: unknown = crypto;
    if (typeof (c as { randomUUID?: () => string }).randomUUID === 'function') {
      return (c as { randomUUID: () => string }).randomUUID().replace(/-/g, '').slice(0, 16);
    }
    if (typeof (c as { getRandomValues?: (arr: Uint8Array) => Uint8Array }).getRandomValues === 'function') {
      const bytes = new Uint8Array(8);
      (c as { getRandomValues: (arr: Uint8Array) => Uint8Array }).getRandomValues(bytes);
      let out = '';
      for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
      return out;
    }
  }
  let out = '';
  for (let i = 0; i < 16; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

/**
 * Convert a legacy dot-separated token to COSE_Sign1 CBOR bytes.
 * Format: base64url(protectedHeader).base64url(payload).base64url(signature).
 * Falls back to raw-UTF8 bytes if the input is not a 3-segment JWT-shape.
 */
export function dotTokenToCoseSign1Bytes(token: string): Uint8Array {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return new TextEncoder().encode(token);
  }
  const protectedHeader = base64urlDecode(parts[0]);
  const payload = base64urlDecode(parts[1]);
  const signature = base64urlDecode(parts[2]);

  return coseSign1Encode({
    protectedHeader,
    unprotectedHeader: new Map(),
    payload,
    signature,
  });
}

/**
 * Long-lived per-request bidi stream (draft-18 §3.3, §10.9).
 *
 * Each MOQT request (SUBSCRIBE, PUBLISH, FETCH, TRACK_STATUS, SUBSCRIBE_TRACKS,
 * PUBLISH_NAMESPACE, SUBSCRIBE_NAMESPACE, ...) travels on its own bidirectional
 * stream. The initiating peer sends the request as the first message; the
 * responder replies with REQUEST_OK/REQUEST_ERROR (or the request-specific
 * response). Follow-up REQUEST_UPDATE messages MUST be sent on the same stream
 * (§10.9), so the writer stays open for the lifetime of the request.
 */
export class Draft18RequestStream {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writeFn: (data: Uint8Array, closeAfter?: boolean) => void | Promise<void>;
  private readonly closeFn: () => void | Promise<void>;
  private readonly codec: IProtocolCodec;
  private pending: Uint8Array = new Uint8Array(0);
  private eof = false;

  constructor(
    codec: IProtocolCodec,
    readable: ReadableStream<Uint8Array>,
    writeFn: (data: Uint8Array, closeAfter?: boolean) => void | Promise<void>,
    closeFn: () => void | Promise<void>,
  ) {
    this.codec = codec;
    this.reader = readable.getReader();
    this.writeFn = writeFn;
    this.closeFn = closeFn;
  }

  async write(data: Uint8Array): Promise<void> {
    await this.writeFn(data, false);
  }

  /**
   * Read the next complete control message from this stream. Buffers any
   * bytes that arrive after the message so subsequent reads see them.
   */
  async readMessage(): Promise<ControlMessageDraft18> {
    for (;;) {
      if (this.pending.length > 0) {
        try {
          const [message, bytesRead] = this.codec.decodeControlMessage(this.pending);
          this.pending = this.pending.subarray(bytesRead);
          return message as ControlMessageDraft18;
        } catch (err) {
          const msg = (err as Error).message ?? '';
          if (!msg.includes('Incomplete') && !msg.includes('buffer')) {
            throw err;
          }
        }
      }

      if (this.eof) {
        throw new Error('Request stream closed before a full control message was received');
      }

      const { value, done } = await this.reader.read();
      if (done) {
        this.eof = true;
        continue;
      }
      if (value && value.length > 0) {
        if (this.pending.length === 0) {
          this.pending = value;
        } else {
          const merged = new Uint8Array(this.pending.length + value.length);
          merged.set(this.pending, 0);
          merged.set(value, this.pending.length);
          this.pending = merged;
        }
      }
    }
  }

  async close(): Promise<void> {
    try {
      this.reader.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      await this.closeFn();
    } catch {
      /* ignore */
    }
  }
}
