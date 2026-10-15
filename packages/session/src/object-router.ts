// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Object Router
 *
 * Routes received objects (from streams and datagrams) to the
 * appropriate subscriptions.
 */

import {
  Logger,
  ObjectCodec,
  ObjectStatus,
  ObjectStatusDraft18,
  DEFAULT_DRAFT,
  versionEnumFor,
  getProtocolCodecForVersion,
  DataStreamType,
  GroupOrder,
  BufferReader,
  MOQTVarInt,
  Draft18StreamCodec,
  Draft18CodecError,
  Draft18StreamCodecError,
  StreamTypeDraft18,
  DatagramTypeDraft18,
  NoopMetricsSink,
  StreamResetErrorCodeDraft18,
  normalizeStreamResetErrorCode,
  type DraftVersion,
  type IProtocolCodec,
  type MetricsSink,
  type Version,
} from '@moq-web/core';
import type { FetchDecoderState, FetchObjectDraft18, SubgroupHeaderDraft18 } from '@moq-web/core';
import { FetchSubgroupMode, FetchObjectEndOfRange } from '@moq-web/core';
import type { SubscriptionManager, InternalSubscription } from './subscription-manager.js';
import { narrowBigIntToNumber } from './session-helpers.js';
import { streamResetReason } from './stream-reset-reason.js';

/**
 * High-resolution timestamp for decode-duration histograms. Falls back to
 * `Date.now()` where `performance` is unavailable (matches the pattern used by
 * `protocol-codec.ts`).
 */
function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Classify a decode-time throw into a stable `reason` label for the
 * `moq.codec.decode.errors` counter. Mirrors the classifier in
 * `packages/core/src/encoding/protocol-codec.ts` so router-level emissions
 * agree with codec-level ones on the `bounds-exceeded` tag (B2 SEC).
 */
function classifyRouterDecodeError(err: unknown): string {
  if (err instanceof Draft18CodecError || err instanceof Draft18StreamCodecError) {
    if (err.code === 'bounds-exceeded') return 'bounds-exceeded';
    if (err.code) return err.code;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('Incomplete')) return 'truncated';
  if (msg.includes('Buffer underflow')) return 'truncated';
  if (msg.includes('Unknown message type')) return 'wrong-type';
  return 'unknown';
}

const log = Logger.create('moqt:session:object-router');

/**
 * A data-plane protocol violation: the receiver MUST close the session
 * (d22 §6.4.1, §11; d18 §3.4, §11).
 */
class DataPlaneViolation extends Error {}

/** True when `err` only says more bytes are needed, not that the encoding is malformed. */
function isTruncation(err: unknown): boolean {
  return /underflow|incomplete/i.test(err instanceof Error ? err.message : '');
}

/** Stream types are at most one byte for subgroup headers (0b0XX1XXXX, d22 §11.3.1) */
const MAX_SUBGROUP_STREAM_TYPE = 0x7f;

/** Cap on cancelled FETCH ids awaiting a stream that may never arrive */
const MAX_CANCELLED_FETCHES = 256;

/** FETCH_HEADER's stream type (0x05) is a single byte in every draft */
const FETCH_HEADER_TYPE_BYTES = 1;

/**
 * Callback for received objects
 */
export type ObjectCallback = (
  subscription: InternalSubscription,
  data: Uint8Array,
  groupId: number,
  objectId: number,
  timestamp: number
) => void;

/**
 * Callback for received FETCH objects.
 *
 * NOTE: `requestId` is a 62-bit varint (bigint). `groupId`/`objectId` are
 * kept as `number` because the delta-encoded fetch stream codec, media
 * pipeline, and JSON logging paths perform arithmetic in `number`. Codec
 * sites assert wire values fit in `number` via `readVarIntNumber()`.
 */
export type FetchObjectCallback = (
  requestId: bigint,
  data: Uint8Array,
  groupId: number,
  objectId: number
) => void;

/**
 * Callback for a FETCH data stream that ended (FIN, reset or cancelled),
 * with the Request ID from its FETCH_HEADER and the last Group ID received,
 * if any object arrived (bounded-number; see the FetchObjectCallback note).
 */
export type FetchStreamCloseCallback = (requestId: bigint, lastGroupId?: number) => void;

/**
 * Callback fired on a data-plane protocol violation, with the reason. The
 * session closes with PROTOCOL_VIOLATION.
 */
export type ViolationCallback = (reason: string) => void;

/**
 * Callback fired when a subgroup stream is reset by the peer (draft-18
 * §11.4.3). WebTransport surfaces the QUIC RESET_STREAM as a
 * `WebTransportError` with `streamErrorCode`; we forward that raw code so the
 * session layer can emit a typed `stream-reset` event distinct from
 * §8 delivery-timeouts.
 */
export type StreamResetCallback = (
  subscription: InternalSubscription | undefined,
  code: number,
  reason: string,
  detail: { groupId?: number; subgroupId?: number; trackAlias?: bigint },
) => void;

/**
 * Routes objects to subscriptions
 */
export class ObjectRouter {
  private onFetchObject?: FetchObjectCallback;
  private onFetchStreamClose?: FetchStreamCloseCallback;
  private onStreamReset?: StreamResetCallback;
  private onViolation?: ViolationCallback;

  private readonly _draft: DraftVersion;
  /** Decodes with the session's draft, not the build-time default */
  private readonly codec: IProtocolCodec;
  private get isDraft18(): boolean {
    return this._draft === 'draft-18' || this._draft === 'draft-22';
  }
  private get isDraft22(): boolean {
    return this._draft === 'draft-22';
  }
  private get isDraft16(): boolean {
    return this._draft === 'draft-16' || this._draft === 'draft-17';
  }

  /**
   * Group order per in-flight draft-22 FETCH (§11.4.1.1 needs it to apply
   * Group ID Delta). Absent means ascending; cleared when the stream ends.
   */
  private fetchGroupOrders = new Map<bigint, GroupOrder>();

  /**
   * Readers of FETCH data streams being decoded, so a cancel can STOP_SENDING
   * them (§3.2.4). Cleared when the stream ends.
   */
  private fetchReaders = new Map<bigint, ReadableStreamDefaultReader<Uint8Array>>();

  /**
   * Readers of subgroup streams being decoded, by Track Alias, so deleting a
   * subscription can STOP_SENDING them (draft-22 §9.9). Cleared when each
   * stream ends.
   */
  private subgroupReaders = new Map<string, Set<ReadableStreamDefaultReader<Uint8Array>>>();

  /**
   * FETCH request IDs cancelled by the subscriber. Stops delivery for an
   * in-flight stream and cancels one that arrives late. Entries go when the
   * stream ends; the cap bounds ones whose stream never arrives.
   */
  private cancelledFetches = new Set<bigint>();

  /** Group ID of the last object received on each in-flight FETCH stream */
  private fetchLastGroups = new Map<bigint, number>();

  /**
   * Metrics sink for per-object decode observability (Wave 3 Track I).
   * Defaults to `NoopMetricsSink` so isolated router tests / callers that
   * don't wire a session pay no cost. `MOQTSession` passes its own
   * `InMemoryMetricsSink` in via the 4th constructor arg.
   *
   * The label taxonomy matches the codec-level emissions in
   * `protocol-codec.ts`:
   *   - `moq.codec.decode.errors{codec,reason}` on throw
   *   - `moq.codec.decode.duration{codec,messageType}` around each decode
   *   - `moq.object.<kind>.in` / `moq.object.subgroup.opened` on success
   */
  private readonly metrics: MetricsSink;
  /** Cached codec label so we don't rebuild the attribute record per event. */
  private readonly codecLabel: string;

  constructor(
    private subscriptionManager: SubscriptionManager,
    private onObject?: ObjectCallback,
    draft: DraftVersion = DEFAULT_DRAFT,
    metrics: MetricsSink = new NoopMetricsSink(),
  ) {
    this._draft = draft;
    this.codec = getProtocolCodecForVersion(versionEnumFor(draft) as Version);
    this.metrics = metrics;
    // Router-level metrics use `draft-18` as the umbrella label because the
    // shared `ObjectCodec` entrypoints delegate to `Draft18StreamCodec` under
    // draft-18. Legacy drafts still surface here but this is the only label
    // dimension that carries observability weight downstream.
    this.codecLabel = (draft === 'draft-18' || draft === 'draft-22') ? 'draft-18' : draft;
  }

  /**
   * Register the callback fired when a peer resets an incoming subgroup
   * stream (draft-18 §11.4.3 / §15.10.4).
   */
  setStreamResetCallback(cb: StreamResetCallback): void {
    this.onStreamReset = cb;
  }

  /**
   * Register the callback fired on a data-plane protocol violation. Without
   * one a violation is only logged.
   */
  setViolationCallback(cb: ViolationCallback): void {
    this.onViolation = cb;
  }

  private reportViolation(reason: string): void {
    log.error('Data-plane protocol violation', { reason });
    this.onViolation?.(reason);
  }

  /**
   * Set the object callback
   */
  setCallback(callback: ObjectCallback): void {
    this.onObject = callback;
  }

  /**
   * Set the FETCH object callback
   */
  setFetchObjectCallback(callback: FetchObjectCallback): void {
    this.onFetchObject = callback;
  }

  /**
   * Record the Group Order a draft-22 FETCH was sent with, before the FETCH
   * goes out, so its data stream decodes Group ID Delta in the right direction.
   */
  setFetchGroupOrder(requestId: bigint, order: GroupOrder): void {
    this.fetchGroupOrders.set(requestId, order);
  }

  /**
   * Drop a FETCH's Group Order when it ends without a data stream
   * (rejected or cancelled); stream teardown clears it otherwise.
   */
  clearFetchGroupOrder(requestId: bigint): void {
    this.fetchGroupOrders.delete(requestId);
  }

  /**
   * Cancel a FETCH's data stream (§3.2.4): stop delivering and STOP_SENDING
   * it now, or on sight if it hasn't arrived yet.
   */
  cancelFetchStream(requestId: bigint): void {
    this.cancelledFetches.add(requestId);
    if (this.cancelledFetches.size > MAX_CANCELLED_FETCHES) {
      this.cancelledFetches.delete(this.cancelledFetches.values().next().value as bigint);
    }

    const reader = this.fetchReaders.get(requestId);
    if (!reader) return;
    this.fetchReaders.delete(requestId);
    try { void reader.cancel(streamResetReason(StreamResetErrorCodeDraft18.CANCELLED)); } catch { /* ignore */ }
  }

  /**
   * STOP_SENDING every subgroup stream of a track still being read, when its
   * subscription state is deleted (draft-22 §9.9).
   */
  cancelSubgroupStreams(trackAlias: bigint): void {
    const readers = this.subgroupReaders.get(trackAlias.toString());
    if (!readers) return;
    this.subgroupReaders.delete(trackAlias.toString());
    for (const reader of readers) {
      try { void reader.cancel(streamResetReason(StreamResetErrorCodeDraft18.CANCELLED)); } catch { /* ignore */ }
    }
  }

  /**
   * Set the FETCH stream close callback
   */
  setFetchStreamCloseCallback(callback: FetchStreamCloseCallback): void {
    this.onFetchStreamClose = callback;
  }

  /**
   * Handle incoming datagram
   */
  handleDatagram(data: Uint8Array): void {
    log.trace('Received datagram', { size: data.length });

    // Check first byte to filter out misrouted stream data. Draft-18+ is
    // exempt: there 0x04 is the ZERO_OBJECT_ID Type Flags value (§11.2.1)
    // and the datagram decoder validates Type Flags itself.
    if (!this.isDraft18 && data.length > 0) {
      const firstByte = data[0];
      // OBJECT_DATAGRAM = 0x01, SUBGROUP types = 0x04, 0x10, 0x11, 0x12
      if (firstByte !== 0x01 && (firstByte === 0x04 || (firstByte >= 0x10 && firstByte <= 0x12))) {
        log.trace('Ignoring datagram with stream format', { firstByte: `0x${firstByte.toString(16)}` });
        return;
      }
    }

    // Padding datagrams are discarded (d22 §11.5.2)
    if (this.isDraft18 && this.isPaddingDatagram(data)) {
      return;
    }

    const decodeStart = nowMs();
    try {
      const { header, payload, status, endOfGroup } = this.decodeDatagram(data);
      this.metrics.histogram('moq.codec.decode.duration', nowMs() - decodeStart, {
        codec: this.codecLabel,
        messageType: 'object_datagram',
      });
      this.metrics.counter('moq.object.datagram.in', 1, { codec: this.codecLabel });

      log.trace('Decoded datagram object', {
        trackAlias: header.trackAlias,
        groupId: header.groupId,
        objectId: header.objectId,
        payloadSize: payload.length,
      });

      // Route to subscription
      const subscription = this.subscriptionManager.getByAlias(header.trackAlias);

      if (!subscription) {
        log.warn('Received datagram for unknown track alias', {
          receivedTrackAlias: header.trackAlias.toString(),
          knownAliases: this.subscriptionManager.getKnownAliases(),
        });
        return;
      }

      // A status object is a marker, not payload (d22 §11.1.1)
      if (this.isDraft18 && status !== ObjectStatusDraft18.NORMAL) {
        this.handleStatusObject(subscription, status, header.groupId, header.objectId);
        return;
      }

      const timestamp = performance.now() * 1000; // microseconds
      this.deliverObject(subscription, payload, header.groupId, header.objectId, timestamp);

      // END_OF_GROUP bit: no object after this one in the group (d22 §11.2.1)
      if (endOfGroup) {
        subscription.onEndOfGroup?.(header.groupId);
      }
    } catch (err) {
      this.metrics.counter('moq.codec.decode.errors', 1, {
        codec: this.codecLabel,
        reason: classifyRouterDecodeError(err),
      });
      log.trace('Error parsing datagram', { error: (err as Error).message });

      // A datagram is atomic, so any malformed one is a violation (d22 §11.2.1)
      const malformed = err instanceof DataPlaneViolation ||
        err instanceof Draft18StreamCodecError ||
        err instanceof Draft18CodecError ||
        isTruncation(err);
      if (this.isDraft18 && malformed) {
        this.reportViolation(`Invalid OBJECT_DATAGRAM: ${(err as Error).message}`);
      }
    }
  }

  private isPaddingDatagram(data: Uint8Array): boolean {
    try {
      return MOQTVarInt.decode(data)[0] === BigInt(DatagramTypeDraft18.PADDING);
    } catch {
      return false;
    }
  }

  /**
   * Decode a datagram. Draft-18+ reads it directly so Object Status and
   * END_OF_GROUP survive; the legacy header has nowhere to carry them.
   */
  private decodeDatagram(data: Uint8Array): {
    header: { trackAlias: number | bigint; groupId: number; objectId: number };
    payload: Uint8Array;
    status: number;
    endOfGroup: boolean;
  } {
    if (!this.isDraft18) {
      const { header, payload } = this.codec.decodeDatagramObject(data);
      return { header, payload, status: header.objectStatus, endOfGroup: false };
    }

    const [datagram] = Draft18StreamCodec.decodeObjectDatagram(data);
    return {
      header: {
        trackAlias: datagram.trackAlias,
        groupId: narrowBigIntToNumber(datagram.groupId, 'Group ID'),
        objectId: narrowBigIntToNumber(datagram.objectId ?? 0n, 'Object ID'),
      },
      payload: datagram.payload?.slice() ?? new Uint8Array(0),
      status: datagram.objectStatus ?? ObjectStatusDraft18.NORMAL,
      endOfGroup: datagram.endOfGroup === true,
    };
  }

  /**
   * Apply a non-Normal Object Status (d22 §11.1.1). End of Group closes the
   * group; End of Track carries no payload and has no consumer yet.
   */
  private handleStatusObject(
    subscription: InternalSubscription | undefined,
    status: number,
    groupId: number,
    objectId: number,
  ): void {
    if (status === ObjectStatusDraft18.END_OF_GROUP) {
      log.info('Received END_OF_GROUP', { groupId, objectId });
      subscription?.onEndOfGroup?.(groupId);
      return;
    }

    if (status !== ObjectStatusDraft18.END_OF_TRACK) {
      throw new DataPlaneViolation(`Invalid Object Status 0x${status.toString(16)} (d22 §11.1.1)`);
    }

    log.info('Received End of Track', { groupId, objectId });
  }

  /**
   * Handle incoming unidirectional stream
   */
  async handleIncomingStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    if (this.isDraft18) {
      await this.handleStreamDraft18(stream);
      return;
    }
    await this.handleStreamLegacy(stream);
  }

  /**
   * Draft-18/22 data stream: read the stream type (a vi64 that may arrive
   * split across reads), then take the stream as padding, FETCH or a
   * subgroup. Any other type, or a malformed header or object, closes the
   * session (d22 §6.4.1, §11.3.1).
   */
  private async handleStreamDraft18(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    // Hoisted so a peer RESET_STREAM caught below can still report which
    // subgroup was in flight.
    let subgroup: { trackAlias: number | bigint; groupId: number; subgroupId: number } | null = null;
    let aliasKey: string | undefined;

    let buffer = new Uint8Array(0);
    let offset = 0;
    let done = false;

    // Append the next chunk to the bytes not yet consumed
    const readMore = async (): Promise<void> => {
      const { value, done: readDone } = await reader.read();
      done = readDone;
      if (!value || value.length === 0) {
        return;
      }

      const rest = buffer.subarray(offset);
      const merged = new Uint8Array(rest.length + value.length);
      merged.set(rest);
      merged.set(value, rest.length);
      buffer = merged;
      offset = 0;
    };

    try {
      let type: [bigint, number] | undefined;
      while (!type) {
        try {
          type = MOQTVarInt.decode(buffer, offset);
        } catch {
          if (done) {
            return;
          }
          await readMore();
        }
      }
      const [streamType, typeBytes] = type;

      if (streamType === BigInt(StreamTypeDraft18.PADDING)) {
        // d22 §11.5.1: the receiver MUST discard everything on a padding stream
        while (!done) {
          await readMore();
        }
        return;
      }

      if (streamType === BigInt(StreamTypeDraft18.FETCH_HEADER)) {
        await this.handleFetchStream(reader, buffer.subarray(offset), done, typeBytes);
        return;
      }

      if (streamType > BigInt(MAX_SUBGROUP_STREAM_TYPE) || !Draft18StreamCodec.isSubgroupHeader(Number(streamType))) {
        throw new DataPlaneViolation(`Unknown stream type 0x${streamType.toString(16)} (d22 §6.4.1)`);
      }

      const headerStart = nowMs();
      let parsed: [SubgroupHeaderDraft18, number] | undefined;
      while (!parsed) {
        try {
          parsed = Draft18StreamCodec.decodeSubgroupHeader(buffer, offset);
        } catch (err) {
          if (!isTruncation(err)) {
            this.countDecodeError(err);
            throw new DataPlaneViolation(`Invalid SUBGROUP_HEADER: ${(err as Error).message}`);
          }
          if (done) {
            this.countDecodeError(err);
            log.warn('Stream ended inside its SUBGROUP_HEADER');
            return;
          }
          await readMore();
        }
      }
      const [header, headerBytes] = parsed;
      offset += headerBytes;
      this.metrics.histogram('moq.codec.decode.duration', nowMs() - headerStart, {
        codec: this.codecLabel,
        messageType: 'subgroup_header',
      });
      this.metrics.counter('moq.object.subgroup.opened', 1, { codec: this.codecLabel });

      subgroup = {
        trackAlias: header.trackAlias,
        groupId: narrowBigIntToNumber(header.groupId, 'Group ID'),
        subgroupId: narrowBigIntToNumber(header.subgroupId ?? 0n, 'Subgroup ID'),
      };
      log.info('Decoded subgroup header', { ...subgroup, endOfGroup: header.endOfGroup === true });
      aliasKey = header.trackAlias.toString();
      const readers = this.subgroupReaders.get(aliasKey) ?? new Set();
      readers.add(reader);
      this.subgroupReaders.set(aliasKey, readers);

      const hasProperties = header.hasProperties === true;
      let previousObjectId = -1;
      let objectCount = 0;
      while (true) {
        while (offset < buffer.length) {
          const decodeStart = nowMs();
          let decoded: [number, Uint8Array, ObjectStatus, number];
          try {
            decoded = this.codec.decodeStreamObject(buffer.subarray(offset), 0, hasProperties, previousObjectId);
          } catch (err) {
            if (isTruncation(err)) {
              break;
            }
            this.countDecodeError(err);
            throw new DataPlaneViolation(`Invalid subgroup object: ${(err as Error).message}`);
          }

          const [objectId, payload, status, bytesConsumed] = decoded;
          offset += bytesConsumed;
          this.metrics.histogram('moq.codec.decode.duration', nowMs() - decodeStart, {
            codec: this.codecLabel,
            messageType: 'stream_object',
          });
          this.metrics.counter('moq.object.stream.in', 1, { codec: this.codecLabel });
          previousObjectId = objectId;
          objectCount++;

          const subscription = this.subscriptionManager.getByAlias(subgroup.trackAlias);

          // Status objects are markers, never payload (d22 §11.1.1)
          if ((status as number) !== ObjectStatusDraft18.NORMAL) {
            this.handleStatusObject(subscription, status, subgroup.groupId, objectId);
            continue;
          }

          if (!subscription) {
            log.warn('Received stream object for unknown track alias', {
              receivedTrackAlias: subgroup.trackAlias.toString(),
              knownAliases: this.subscriptionManager.getKnownAliases(),
            });
            continue;
          }

          // Copy payload to avoid detaching the shared buffer when transferred via postMessage
          this.deliverObject(subscription, new Uint8Array(payload), subgroup.groupId, objectId, performance.now() * 1000);
        }

        if (done) {
          break;
        }
        await readMore();
      }

      if (offset < buffer.length) {
        log.warn('Stream ended inside an object', { remaining: buffer.length - offset });
      }

      // END_OF_GROUP in the header plus a FIN: no object follows the last one (d22 §11.3.1)
      if (header.endOfGroup === true) {
        this.subscriptionManager.getByAlias(subgroup.trackAlias)?.onEndOfGroup?.(subgroup.groupId);
      }
      log.info('Stream ended', { objectCount, trackAlias: subgroup.trackAlias.toString() });
    } catch (err) {
      if (err instanceof DataPlaneViolation) {
        void reader.cancel().catch(() => { /* session is closing */ });
        this.reportViolation(err.message);
        return;
      }
      this.reportStreamError(err, subgroup);
    } finally {
      if (aliasKey !== undefined) {
        this.subgroupReaders.get(aliasKey)?.delete(reader);
      }
    }
  }

  private countDecodeError(err: unknown): void {
    this.metrics.counter('moq.codec.decode.errors', 1, {
      codec: this.codecLabel,
      reason: classifyRouterDecodeError(err),
    });
  }

  /**
   * Surface a failed read of a subgroup stream: a peer RESET_STREAM through
   * the reset callback, anything else as a log line.
   */
  private reportStreamError(
    err: unknown,
    subgroupHeader: { trackAlias: number | bigint; groupId: number; subgroupId: number } | null,
  ): void {
    const errorMessage = (err as Error).message || '';
    // Draft-18 §11.4.3: a peer RESET_STREAM surfaces as a WebTransportError
    // with a numeric `streamErrorCode`. Surface it as a typed callback so
    // consumers can distinguish TOO_FAR_BEHIND / GOING_AWAY / application
    // resets from an ordinary disconnect (which has no code).
    const streamErrorCode = (err as { streamErrorCode?: number } | null)?.streamErrorCode;
    if (typeof streamErrorCode === 'number' && this.onStreamReset) {
      const subscription = subgroupHeader
        ? this.subscriptionManager.getByAlias(subgroupHeader.trackAlias)
        : undefined;
      const detail: { groupId?: number; subgroupId?: number; trackAlias?: bigint } = {};
      if (subgroupHeader) {
        detail.groupId = subgroupHeader.groupId;
        detail.subgroupId = subgroupHeader.subgroupId;
        detail.trackAlias = BigInt(subgroupHeader.trackAlias);
      }
      // §14 grease: unknown Stream Reset codes MUST be treated as
      // INTERNAL_ERROR for this registry. Draft-16 doesn't define grease so
      // we only normalize on draft-18.
      const normalizedCode = this.isDraft18
        ? normalizeStreamResetErrorCode(streamErrorCode)
        : streamErrorCode;
      this.onStreamReset(subscription, normalizedCode, errorMessage, detail);
    }
    if (errorMessage.includes('session is closed') ||
        errorMessage.includes('stream is closed') ||
        errorMessage.includes('aborted') ||
        errorMessage.includes('RESET_STREAM')) {
      log.debug('Stream closed during read (disconnect/reset)', { error: errorMessage, streamErrorCode });
    } else {
      log.error('Error handling incoming stream', err as Error);
    }
  }

  /**
   * Draft-14/16 data stream.
   */
  private async handleStreamLegacy(stream: ReadableStream<Uint8Array>): Promise<void> {
    log.info('Received incoming stream');
    // Hoisted so a peer RESET_STREAM caught below can still report which
    // subgroup was in flight.
    let subgroupHeader: { trackAlias: number | bigint; groupId: number; subgroupId: number } | null = null;
    try {
      const reader = stream.getReader();

      let buffer = new Uint8Array(0);
      let bufferOffset = 0;
      let headerParsed = false;
      let headerBytes = 0;
      let hasExtensions = false;
      let endOfGroup = false;
      let objectCount = 0;
      let previousObjectId = -1; // For delta decoding in draft-16 (-1 = first object)
      let totalBytesReceived = 0;
      let readCount = 0;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        readCount++;

        if (value) {
          totalBytesReceived += value.length;
          log.info('Stream read chunk', {
            readNumber: readCount,
            chunkSize: value.length,
            totalBytesReceived,
            done,
            firstBytes: Array.from(value.slice(0, Math.min(16, value.length))).map(b => b.toString(16).padStart(2, '0')).join(' '),
          });
          const remainingBytes = buffer.length - bufferOffset;
          if (remainingBytes === 0) {
            // No pending data, use incoming data directly
            buffer = new Uint8Array(value);
            bufferOffset = 0;
          } else if (bufferOffset > buffer.length / 2) {
            // Compact buffer if offset is past halfway
            const newBuffer = new Uint8Array(remainingBytes + value.length);
            newBuffer.set(buffer.slice(bufferOffset));
            newBuffer.set(value, remainingBytes);
            buffer = newBuffer;
            bufferOffset = 0;
          } else {
            // Append new data
            const newBuffer = new Uint8Array(buffer.length + value.length);
            newBuffer.set(buffer);
            newBuffer.set(value, buffer.length);
            buffer = newBuffer;
          }
        }

        const bufferView = buffer.subarray(bufferOffset);
        const viewLength = bufferView.length;

        // Parse header if not yet done
        if (!headerParsed && viewLength > 0) {
          if (this.isDraft16) {
            // Draft-16/18: Stream starts with Type (0x10-0x3D range for subgroups, 0x05 for FETCH)
            const firstByte = bufferView[0];
            const streamType = firstByte & 0x3f;

            log.info('Incoming stream first bytes (draft-16/18)', {
              streamType: `0x${streamType.toString(16)}`,
              viewLength,
              preview: Array.from(bufferView.slice(0, Math.min(20, viewLength))).map(b => b.toString(16).padStart(2, '0')).join(' '),
            });

            // Check if it's a FETCH stream (0x05)
            if (streamType === DataStreamType.FETCH_HEADER) {
              log.info('Detected FETCH stream (draft-16)', { streamType: `0x${streamType.toString(16)}` });
              await this.handleFetchStream(reader, bufferView, done);
              return; // FETCH stream handling is complete
            }

            const decodeStart = nowMs();
            try {
              [subgroupHeader, headerBytes, endOfGroup, hasExtensions] = this.codec.decodeSubgroupHeader(bufferView);
              this.metrics.histogram('moq.codec.decode.duration', nowMs() - decodeStart, {
                codec: this.codecLabel,
                messageType: 'subgroup_header',
              });
              this.metrics.counter('moq.object.subgroup.opened', 1, { codec: this.codecLabel });
              headerParsed = true;

              log.info('Decoded subgroup header', {
                trackAlias: subgroupHeader.trackAlias,
                groupId: subgroupHeader.groupId,
                subgroupId: subgroupHeader.subgroupId,
                endOfGroup,
                hasExtensions,
              });

              bufferOffset += headerBytes;
            } catch (decodeErr) {
              this.metrics.counter('moq.codec.decode.errors', 1, {
                codec: this.codecLabel,
                reason: classifyRouterDecodeError(decodeErr),
              });
              log.warn('Failed to decode subgroup header', {
                error: (decodeErr as Error).message,
                bufferLength: bufferView.length,
                totalBytesReceived,
                done,
              });
              if (done) break;
              continue;
            }
          } else {
            // Draft-14: Stream starts with stream type byte
            const firstByte = bufferView[0];
            const streamType = firstByte & 0x3f;
            const isSubgroupHeader = streamType === 0x04 ||
              (streamType >= 0x10 && streamType <= 0x1D);

            log.info('Incoming stream first bytes', {
              firstByte: `0x${firstByte.toString(16)}`,
              streamType: `0x${streamType.toString(16)}`,
              isSubgroupHeader,
              viewLength,
              preview: Array.from(bufferView.slice(0, Math.min(20, viewLength))).map(b => b.toString(16).padStart(2, '0')).join(' '),
            });

            if (!isSubgroupHeader) {
              // Check if it's a FETCH stream (0x05)
              if (streamType === DataStreamType.FETCH_HEADER) {
                log.info('Detected FETCH stream', { streamType: `0x${streamType.toString(16)}` });
                await this.handleFetchStream(reader, bufferView, done);
                return; // FETCH stream handling is complete
              }

              log.warn('Stream type not recognized as subgroup header', { streamType: `0x${streamType.toString(16)}` });
              if (done) {
                await this.handleLegacyStreamData(bufferView);
              }
              break;
            }

            const decodeStart = nowMs();
            try {
              [subgroupHeader, headerBytes, endOfGroup, hasExtensions] = this.codec.decodeSubgroupHeader(bufferView);
              this.metrics.histogram('moq.codec.decode.duration', nowMs() - decodeStart, {
                codec: this.codecLabel,
                messageType: 'subgroup_header',
              });
              this.metrics.counter('moq.object.subgroup.opened', 1, { codec: this.codecLabel });
              headerParsed = true;

              log.info('Decoded subgroup header', {
                streamType: `0x${streamType.toString(16)}`,
                trackAlias: subgroupHeader.trackAlias,
                groupId: subgroupHeader.groupId,
                subgroupId: subgroupHeader.subgroupId,
              });

              bufferOffset += headerBytes;
            } catch (decodeErr) {
              this.metrics.counter('moq.codec.decode.errors', 1, {
                codec: this.codecLabel,
                reason: classifyRouterDecodeError(decodeErr),
              });
              if (done) break;
              continue;
            }
          }
        }

        // Process objects
        if (headerParsed && subgroupHeader) {
          const remaining = buffer.length - bufferOffset;
          if (remaining > 0) {
            log.info('Attempting object decode', {
              bufferOffset,
              bufferLength: buffer.length,
              remaining,
              hasExtensions,
              previousObjectId,
              trackAlias: subgroupHeader.trackAlias.toString(),
              groupId: subgroupHeader.groupId,
              firstBytes: Array.from(buffer.subarray(bufferOffset, bufferOffset + Math.min(20, remaining))).map(b => b.toString(16).padStart(2, '0')).join(' '),
            });
          }
          while (bufferOffset < buffer.length) {
            const decodeStart = nowMs();
            try {
              const view = buffer.subarray(bufferOffset);
              const [objectId, payload, status, bytesConsumed] = this.codec.decodeStreamObject(view, 0, hasExtensions, previousObjectId);
              this.metrics.histogram('moq.codec.decode.duration', nowMs() - decodeStart, {
                codec: this.codecLabel,
                messageType: 'stream_object',
              });
              this.metrics.counter('moq.object.stream.in', 1, { codec: this.codecLabel });
              previousObjectId = objectId; // Update for next delta decode
              objectCount++;

              const subscription = this.subscriptionManager.getByAlias(subgroupHeader.trackAlias);

              // Check for alias collision (multiple subscriptions with same alias)
              const allMatches = this.subscriptionManager.getAllByAlias(subgroupHeader.trackAlias);
              if (allMatches.length > 1) {
                log.error('ALIAS COLLISION: Multiple subscriptions have same trackAlias - data may be routed incorrectly', {
                  trackAlias: subgroupHeader.trackAlias.toString(),
                  conflictingTracks: allMatches.map(s => ({
                    subscriptionId: s.subscriptionId,
                    trackName: s.trackName,
                    namespace: s.namespace.join('/'),
                  })),
                });
              }

              // Handle END_OF_GROUP signal
              if (status === ObjectStatus.END_OF_GROUP) {
                log.info('Received END_OF_GROUP', {
                  groupId: subgroupHeader.groupId,
                  objectId,
                  trackAlias: subgroupHeader.trackAlias.toString(),
                });
                if (subscription?.onEndOfGroup) {
                  subscription.onEndOfGroup(subgroupHeader.groupId);
                }
                bufferOffset += bytesConsumed;
                continue; // Don't deliver empty END_OF_GROUP marker as a regular object
              }

              log.debug('Looking up subscription by trackAlias', {
                lookupAlias: subgroupHeader.trackAlias.toString(),
                found: !!subscription,
                knownAliases: this.subscriptionManager.getKnownAliases(),
              });

              if (subscription) {
                const timestamp = performance.now() * 1000;
                // Copy payload to avoid detaching the shared buffer when transferred via postMessage
                const payloadCopy = new Uint8Array(payload);
                this.deliverObject(subscription, payloadCopy, subgroupHeader.groupId, objectId, timestamp);

                log.trace('Processed stream object', {
                  groupId: subgroupHeader.groupId,
                  objectId,
                  payloadSize: payloadCopy.length,
                });
              } else {
                log.warn('Received stream object for unknown track alias', {
                  receivedTrackAlias: subgroupHeader.trackAlias.toString(),
                  knownAliases: this.subscriptionManager.getKnownAliases(),
                });
              }

              bufferOffset += bytesConsumed;
            } catch (decodeErr) {
              this.metrics.counter('moq.codec.decode.errors', 1, {
                codec: this.codecLabel,
                reason: classifyRouterDecodeError(decodeErr),
              });
              // Not enough data for complete object - wait for more chunks
              log.info('Object decode pending (need more data)', {
                bufferOffset,
                bufferLength: buffer.length,
                remaining: buffer.length - bufferOffset,
                groupId: subgroupHeader.groupId,
                error: (decodeErr as Error).message,
              });
              break;
            }
          }
        }

        if (done) {
          // If header type signals END_OF_GROUP, notify subscription when stream closes
          if (endOfGroup && subgroupHeader) {
            const subscription = this.subscriptionManager.getByAlias(subgroupHeader.trackAlias);
            if (subscription?.onEndOfGroup) {
              log.info('Stream closed with END_OF_GROUP signal', {
                groupId: subgroupHeader.groupId,
                trackAlias: subgroupHeader.trackAlias.toString(),
              });
              subscription.onEndOfGroup(subgroupHeader.groupId);
            }
          }
          log.info('Stream ended', {
            totalBytesReceived,
            totalReads: readCount,
            objectCount,
            headerParsed,
            trackAlias: subgroupHeader?.trackAlias?.toString(),
            endOfGroup,
          });
          break;
        }
      }

      if (objectCount > 0) {
        log.debug('Finished processing stream', {
          objectCount,
          trackAlias: subgroupHeader?.trackAlias,
          groupId: subgroupHeader?.groupId,
        });
      }
    } catch (err) {
      this.reportStreamError(err, subgroupHeader);
    }
  }

  /**
   * Handle legacy/datagram-style stream data
   */
  private async handleLegacyStreamData(data: Uint8Array): Promise<void> {
    const streamType = data[0] & 0x3f;

    if (streamType === 0x01) {
      const object = this.codec.decodeDatagramObject(data);
      const { header, payload } = object;

      log.info('Decoded datagram-style stream object', {
        trackAlias: header.trackAlias,
        groupId: header.groupId,
        objectId: header.objectId,
        payloadSize: payload.length,
      });

      const subscription = this.subscriptionManager.getByAlias(header.trackAlias);
      if (subscription) {
        const timestamp = performance.now() * 1000;
        this.deliverObject(subscription, payload, header.groupId, header.objectId, timestamp);
      } else {
        log.warn('Received object for unknown track alias', {
          trackAlias: header.trackAlias.toString(),
          knownAliases: this.subscriptionManager.getKnownAliases(),
        });
      }
    } else {
      log.warn('Unknown stream type', { streamType: `0x${streamType.toString(16)}` });
    }
  }

  // Track last delivered object per subscription for gap detection
  private lastDelivered = new Map<number, { groupId: number; objectId: number }>();

  /**
   * Deliver object to subscription
   */
  private deliverObject(
    subscription: InternalSubscription,
    data: Uint8Array,
    groupId: number,
    objectId: number,
    timestamp: number
  ): void {
    // Detect gaps in object delivery
    const last = this.lastDelivered.get(subscription.subscriptionId);
    if (last) {
      if (groupId === last.groupId && objectId !== last.objectId + 1) {
        log.warn('Gap detected in object delivery', {
          subscriptionId: subscription.subscriptionId,
          lastGroupId: last.groupId,
          lastObjectId: last.objectId,
          currentGroupId: groupId,
          currentObjectId: objectId,
          missedObjects: objectId - last.objectId - 1,
        });
      } else if (groupId !== last.groupId) {
        log.info('New group started', {
          subscriptionId: subscription.subscriptionId,
          previousGroup: last.groupId,
          previousLastObject: last.objectId,
          newGroup: groupId,
          newFirstObject: objectId,
        });
      }
    }
    this.lastDelivered.set(subscription.subscriptionId, { groupId, objectId });

    // Log every object at info level for debugging
    log.info('Delivering object', {
      subscriptionId: subscription.subscriptionId,
      groupId,
      objectId,
      dataSize: data.length,
    });

    // Call subscription's object handler if set
    if (subscription.onObject) {
      subscription.onObject(data, groupId, objectId, timestamp);
    }

    // Call global callback
    if (this.onObject) {
      this.onObject(subscription, data, groupId, objectId, timestamp);
    }
  }

  /**
   * Handle incoming FETCH stream (stream type 0x05)
   *
   * FETCH streams use serialization flags format for objects:
   * FETCH_HEADER (0x05) | RequestID | [Object1] | [Object2] | ...
   *
   * Draft-16 and draft-18 share the header shape but use different per-object
   * flag layouts (§11.4.4). The two codepaths are split below.
   */
  private async handleFetchStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    initialBuffer: Uint8Array,
    initialDone: boolean,
    typeBytes: number = FETCH_HEADER_TYPE_BYTES,
  ): Promise<void> {
    let buffer = initialBuffer;
    let done = initialDone;

    // Parse FETCH_HEADER: stream type (already consumed) + request ID. The
    // Request ID can be split across reads, so keep reading until it decodes
    // or the stream ends. Draft-18+ encodes it as an MOQT vi64, not a QUIC
    // varint; the two differ for values of 64 and up.
    let requestId: bigint | undefined;
    let bufferOffset = 0;
    while (requestId === undefined) {
      try {
        if (this.isDraft18) {
          const [value, length] = MOQTVarInt.decode(buffer, typeBytes);
          requestId = value;
          bufferOffset = typeBytes + length;
        } else {
          const headerReader = new BufferReader(buffer);
          headerReader.skip(typeBytes);
          requestId = headerReader.readVarInt();
          bufferOffset = headerReader.offset;
        }
      } catch {
        if (done) {
          log.error('Failed to decode FETCH request ID');
          return;
        }

        const { value, done: readDone } = await reader.read();
        done = readDone;
        if (value && value.length > 0) {
          const merged = new Uint8Array(buffer.length + value.length);
          merged.set(buffer);
          merged.set(value, buffer.length);
          buffer = merged;
        }
      }
    }

    // Cancelled before the stream arrived: STOP_SENDING it on sight
    if (this.cancelledFetches.delete(requestId)) {
      log.info('Cancelling FETCH stream for cancelled request', { requestId: requestId.toString() });
      try { await reader.cancel(streamResetReason(StreamResetErrorCodeDraft18.CANCELLED)); } catch { /* ignore */ }
      this.onFetchStreamClose?.(requestId);
      return;
    }

    this.fetchReaders.set(requestId, reader);
    try {
      await this.decodeFetchStream(reader, buffer, bufferOffset, done, requestId);
    } finally {
      this.fetchReaders.delete(requestId);
      this.cancelledFetches.delete(requestId);
      const lastGroupId = this.fetchLastGroups.get(requestId);
      this.fetchLastGroups.delete(requestId);
      this.onFetchStreamClose?.(requestId, lastGroupId);
    }
  }

  private async decodeFetchStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    buffer: Uint8Array,
    bufferOffset: number,
    done: boolean,
    requestId: bigint,
  ): Promise<void> {
    log.info('Handling FETCH stream', {
      requestId: requestId.toString(),
      initialBufferSize: buffer.length,
      draft: this.isDraft18 ? 'draft-18' : 'draft-16',
    });

    if (this.isDraft18) {
      try {
        return await this.handleFetchStreamDraft18(reader, buffer, bufferOffset, done, requestId);
      } finally {
        this.fetchGroupOrders.delete(requestId);
      }
    }
    return this.handleFetchStreamLegacy(reader, buffer, bufferOffset, done, requestId);
  }

  /**
   * Legacy (draft-14 / draft-16) FETCH data-stream decode loop.
   */
  private async handleFetchStreamLegacy(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    initialBuffer: Uint8Array,
    initialOffset: number,
    initialDone: boolean,
    requestId: bigint,
  ): Promise<void> {
    let buffer = initialBuffer;
    let bufferOffset = initialOffset;
    let done = initialDone;

    // Create decoder state for delta decoding
    const decoderState: FetchDecoderState = ObjectCodec.createFetchDecoderState();
    let objectCount = 0;
    let totalBytesReceived = buffer.length;

    // Process stream
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Read more data if needed
      if (!done && bufferOffset >= buffer.length - 10) {
        const { value, done: readDone } = await reader.read();
        done = readDone;

        if (value) {
          totalBytesReceived += value.length;
          const remaining = buffer.length - bufferOffset;
          const newBuffer = new Uint8Array(remaining + value.length);
          if (remaining > 0) {
            newBuffer.set(buffer.subarray(bufferOffset));
          }
          newBuffer.set(value, remaining);
          buffer = newBuffer;
          bufferOffset = 0;
        }
      }

      // Cancelled (§3.2.4): the reader was cancelled, drop what's left
      if (this.cancelledFetches.has(requestId)) return;

      // Check if we have data to process
      if (bufferOffset >= buffer.length) {
        if (done) {
          log.info('FETCH stream complete', { requestId: requestId.toString(), objectCount, totalBytesReceived });
          break;
        }
        continue;
      }

      // Try to decode a FETCH object
      const remaining = buffer.subarray(bufferOffset);
      if (remaining.length === 0) {
        if (done) break;
        continue;
      }

      const decodeStart = nowMs();
      try {
        const result = ObjectCodec.decodeFetchObject(remaining, decoderState);
        this.metrics.histogram('moq.codec.decode.duration', nowMs() - decodeStart, {
          codec: this.codecLabel,
          messageType: 'fetch_object',
        });
        this.metrics.counter('moq.object.fetch.in', 1, { codec: this.codecLabel });
        objectCount++;
        bufferOffset += result.bytesConsumed;
        this.fetchLastGroups.set(requestId, result.groupId);

        log.info('Decoded FETCH object', {
          requestId: requestId.toString(),
          groupId: result.groupId,
          objectId: result.objectId,
          payloadSize: result.payload.length,
          objectCount,
        });

        // Call the FETCH object callback
        if (this.onFetchObject) {
          this.onFetchObject(requestId, result.payload, result.groupId, result.objectId);
        }
      } catch (err) {
        this.metrics.counter('moq.codec.decode.errors', 1, {
          codec: this.codecLabel,
          reason: classifyRouterDecodeError(err),
        });
        // May need more data
        if (done) {
          log.warn('Failed to decode FETCH object at end of stream', {
            requestId: requestId.toString(),
            error: (err as Error).message,
            remainingBytes: remaining.length,
          });
          break;
        }
        // Read more data and retry
        const { value, done: readDone } = await reader.read();
        done = readDone;

        if (value) {
          totalBytesReceived += value.length;
          const remainingLen = buffer.length - bufferOffset;
          const newBuffer = new Uint8Array(remainingLen + value.length);
          if (remainingLen > 0) {
            newBuffer.set(buffer.subarray(bufferOffset));
          }
          newBuffer.set(value, remainingLen);
          buffer = newBuffer;
          bufferOffset = 0;
        }
      }
    }
  }

  /**
   * Draft-18 FETCH data-stream decode loop (spec §11.4.4).
   *
   * Each object is prefixed with a serialization-flags varint. Group/Object
   * IDs are transmitted as deltas from the previous object's values (or
   * absolute for the first object on the stream); subgroup ID follows the
   * subgroupMode enum (ZERO/PRIOR/PRIOR_PLUS_ONE/EXPLICIT). Priority is
   * inherited when the PRIORITY bit is clear. Payload length is a varint
   * (spec §11.4.4.1). Special flag values 0x8C / 0x10C / 0x20C encode
   * End-of-Range markers (§11.4.4.2); their Group/Object ID become the prior
   * Group/Object ID of the next object.
   */
  private async handleFetchStreamDraft18(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    initialBuffer: Uint8Array,
    initialOffset: number,
    initialDone: boolean,
    requestId: bigint,
  ): Promise<void> {
    let buffer = initialBuffer;
    let bufferOffset = initialOffset;
    let done = initialDone;
    let totalBytesReceived = buffer.length;
    let objectCount = 0;

    // Prior-object context threaded across successive objects on this stream
    // (spec §11.4.4). Undefined until the first object arrives.
    let prevGroupId: bigint | undefined;
    let prevSubgroupId: bigint | undefined;
    let prevObjectId: bigint | undefined;
    let prevPriority: number | undefined;
    const groupOrder = this.fetchGroupOrders.get(requestId) ?? GroupOrder.ASCENDING;

    const ensureBytes = async (): Promise<boolean> => {
      while (!done) {
        const { value, done: readDone } = await reader.read();
        done = readDone;
        if (value && value.length > 0) {
          totalBytesReceived += value.length;
          const remaining = buffer.length - bufferOffset;
          const merged = new Uint8Array(remaining + value.length);
          if (remaining > 0) merged.set(buffer.subarray(bufferOffset));
          merged.set(value, remaining);
          buffer = merged;
          bufferOffset = 0;
          return true;
        }
      }
      return false;
    };

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Cancelled (§3.2.4): the reader was cancelled, drop what's left
      if (this.cancelledFetches.has(requestId)) return;

      if (bufferOffset >= buffer.length) {
        if (done) break;
        await ensureBytes();
        continue;
      }

      // Attempt to decode header. If we run out of bytes mid-header, read more
      // and retry from the same starting offset.
      const startOffset = bufferOffset;
      let decoded: FetchObjectDraft18;
      let headerBytes: number;
      try {
        const [obj, bytes] = Draft18StreamCodec.decodeFetchObject(buffer, startOffset);
        decoded = obj;
        headerBytes = bytes;
      } catch (err) {
        if (!isTruncation(err)) {
          throw new DataPlaneViolation(`Invalid FETCH object: ${(err as Error).message}`);
        }
        if (done) {
          log.warn('Failed to decode draft-18 FETCH object header at end of stream', {
            requestId: requestId.toString(),
            error: (err as Error).message,
            remainingBytes: buffer.length - startOffset,
          });
          break;
        }
        await ensureBytes();
        continue;
      }

      // End-of-Range marker: two varints follow the special flag. Its
      // Group/Object ID become the prior Group/Object ID for the next object
      // (d18 §11.4.4.2, d22 §11.4.1.2).
      if (decoded.endOfRange !== undefined) {
        if (decoded.endOfRange === FetchObjectEndOfRange.TIMED_OUT && !this.isDraft22) {
          throw new DataPlaneViolation('End of Timed-Out Range (0x20C) is not defined in draft-18 (§11.4.4.2)');
        }
        bufferOffset = startOffset + headerBytes;
        prevGroupId = decoded.groupIdDelta;
        prevObjectId = decoded.objectIdDelta;
        log.info('Draft-18 FETCH end-of-range marker', {
          requestId: requestId.toString(),
          kind: this.endOfRangeKind(decoded.endOfRange),
          groupIdDelta: decoded.groupIdDelta?.toString(),
          objectIdDelta: decoded.objectIdDelta?.toString(),
        });
        continue;
      }

      // Resolve inherited/absolute Group ID.
      const isFirst = prevGroupId === undefined;
      let groupId: bigint;
      if (decoded.groupIdDelta !== undefined) {
        // Absolute for the first object, a true delta from the prior one after
        // that (d18 §11.4.4.1, d22 §11.4.1.1).
        groupId = !isFirst
          ? this.applyGroupDelta(prevGroupId!, decoded.groupIdDelta, groupOrder)
          : decoded.groupIdDelta;
      } else {
        if (isFirst) {
          throw new DataPlaneViolation('Draft-18 FETCH: first object missing Group ID (spec §11.4.4)');
        }
        groupId = prevGroupId!;
      }

      // Resolve Object ID: present-on-wire ⇒ absolute; absent ⇒ prev + 1.
      let objectId: bigint;
      if (decoded.objectIdDelta !== undefined) {
        // Absolute alongside a Group ID Delta, else a delta from the prior
        // Object ID (d18 §11.4.4.1, d22 §11.4.1.1).
        const isRelative = !isFirst && decoded.groupIdDelta === undefined;
        objectId = isRelative ? prevObjectId! + decoded.objectIdDelta : decoded.objectIdDelta;
      } else {
        if (isFirst) {
          throw new DataPlaneViolation('Draft-18 FETCH: first object missing Object ID (spec §11.4.4)');
        }
        objectId = prevObjectId! + 1n;
      }

      // Resolve subgroup ID via subgroupMode.
      let subgroupId: bigint;
      if (decoded.datagramMode === true) {
        // Datagram-mode fetch objects have no subgroup; synthesise from objectId
        // to keep parity with reference implementations.
        subgroupId = objectId;
      } else {
        switch (decoded.subgroupMode) {
          case FetchSubgroupMode.ZERO:
            subgroupId = 0n;
            break;
          case FetchSubgroupMode.PRIOR:
            if (prevSubgroupId === undefined) {
              throw new DataPlaneViolation('Draft-18 FETCH: PRIOR subgroup mode on first object (spec §11.4.4)');
            }
            subgroupId = prevSubgroupId;
            break;
          case FetchSubgroupMode.PRIOR_PLUS_ONE:
            if (prevSubgroupId === undefined) {
              throw new DataPlaneViolation('Draft-18 FETCH: PRIOR_PLUS_ONE subgroup mode on first object (spec §11.4.4)');
            }
            subgroupId = prevSubgroupId + 1n;
            break;
          case FetchSubgroupMode.EXPLICIT:
            if (decoded.subgroupId === undefined) {
              throw new DataPlaneViolation('Draft-18 FETCH: EXPLICIT subgroup mode missing subgroupId (spec §11.4.4)');
            }
            subgroupId = decoded.subgroupId;
            break;
          default:
            throw new DataPlaneViolation(`Draft-18 FETCH: invalid subgroupMode ${decoded.subgroupMode}`);
        }
      }

      // Priority: present ⇒ use it, absent ⇒ inherit.
      let priority: number;
      if (decoded.publisherPriority !== undefined) {
        priority = decoded.publisherPriority;
      } else {
        if (prevPriority === undefined) {
          throw new DataPlaneViolation('Draft-18 FETCH: first object missing publisherPriority (spec §11.4.4)');
        }
        priority = prevPriority;
      }

      // Payload length is the varint just before the payload. Buffer may need
      // to grow to cover the full payload; loop until we have enough bytes.
      const payloadLenN = Number(decoded.payloadLength ?? 0n);
      if (!Number.isSafeInteger(payloadLenN) || payloadLenN < 0) {
        throw new DataPlaneViolation(`Draft-18 FETCH: invalid payload length ${decoded.payloadLength}`);
      }
      // ensureBytes() rebases the buffer so the unconsumed bytes start at 0;
      // bufferOffset tracks this object's start, startOffset goes stale.
      const totalObjectBytes = headerBytes + payloadLenN;
      while (buffer.length - bufferOffset < totalObjectBytes) {
        if (done) {
          log.warn('Draft-18 FETCH stream truncated mid-payload', {
            requestId: requestId.toString(),
            needed: totalObjectBytes,
            haveRemaining: buffer.length - bufferOffset,
          });
          return;
        }
        await ensureBytes();
      }

      const payloadStart = bufferOffset + headerBytes;
      const payload = buffer.slice(payloadStart, payloadStart + payloadLenN);
      bufferOffset = payloadStart + payloadLenN;

      objectCount++;
      // IDs are vi64; refuse values a number would round
      const groupIdN = narrowBigIntToNumber(groupId, 'FETCH Group ID');
      const objectIdN = narrowBigIntToNumber(objectId, 'FETCH Object ID');

      this.fetchLastGroups.set(requestId, groupIdN);

      log.info('Decoded draft-18 FETCH object', {
        requestId: requestId.toString(),
        groupId: groupIdN,
        subgroupId: subgroupId.toString(),
        objectId: objectIdN,
        priority,
        payloadSize: payload.length,
        objectCount,
      });

      if (this.onFetchObject) {
        this.onFetchObject(requestId, payload, groupIdN, objectIdN);
      }

      // Update prior-object context (spec §11.4.4).
      prevGroupId = groupId;
      prevSubgroupId = subgroupId;
      prevObjectId = objectId;
      prevPriority = priority;
    }

    log.info('Draft-18 FETCH stream complete', { requestId: requestId.toString(), objectCount, totalBytesReceived });
  }

  private endOfRangeKind(marker: FetchObjectEndOfRange): string {
    switch (marker) {
      case FetchObjectEndOfRange.NON_EXISTENT:
        return 'non-existent';
      case FetchObjectEndOfRange.TIMED_OUT:
        return 'timed-out';
      default:
        return 'unknown';
    }
  }

  /** d18 §11.4.4.1, d22 §11.4.1.1: Group ID = prior +/- (delta + 1) by Group Order. */
  private applyGroupDelta(prev: bigint, delta: bigint, order: GroupOrder): bigint {
    const groupId = order === GroupOrder.DESCENDING ? prev - (delta + 1n) : prev + delta + 1n;
    if (groupId < 0n) {
      throw new DataPlaneViolation('FETCH: Group ID Delta underflows below 0 (d18 §11.4.4.1, d22 §11.4.1.1, PROTOCOL_VIOLATION)');
    }
    return groupId;
  }
}
