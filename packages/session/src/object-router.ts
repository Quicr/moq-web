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
  IS_DRAFT_16,
  IS_DRAFT_18,
  DataStreamType,
  BufferReader,
  Draft18StreamCodec,
  StreamResetErrorCodeDraft18,
} from '@moq-web/core';
import type { FetchDecoderState, FetchObjectDraft18 } from '@moq-web/core';
import { FetchSubgroupMode, FetchObjectEndOfRange } from '@moq-web/core';
import type { SubscriptionManager, InternalSubscription } from './subscription-manager.js';
import { DeliveryTimeoutTracker, type DeliveryTimeoutReason } from './delivery-timeout.js';

const log = Logger.create('moqt:session:object-router');

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
 * Callback for received FETCH objects
 */
export type FetchObjectCallback = (
  requestId: number,
  data: Uint8Array,
  groupId: number,
  objectId: number
) => void;

/**
 * Callback for FETCH stream end-of-group
 */
export type FetchEndOfGroupCallback = (
  requestId: number,
  groupId: number
) => void;

/**
 * Extract the track-alias string from a §8 timer key. Keys are shaped
 * `sg:${alias}:...` or `obj:${alias}:...`.
 */
function parseAliasFromTimerKey(key: string): string | undefined {
  const parts = key.split(':');
  if (parts.length < 2) return undefined;
  return parts[1];
}

/**
 * Callback fired when a §8 subscriber-side delivery deadline elapses. Carries
 * the subscription that owns the stream, the reason (`subgroup`/`object`),
 * and the §15.10.4 reset code the peer expects. The router cancels the
 * underlying stream reader itself; consumers use this hook to surface the
 * event to the UI (or unwind an application-layer decoder).
 */
export type DeliveryTimeoutCallback = (
  subscription: InternalSubscription,
  reason: DeliveryTimeoutReason,
  resetCode: StreamResetErrorCodeDraft18,
  detail: { groupId?: number; subgroupId?: number; objectId?: number },
) => void;

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
  private onFetchEndOfGroup?: FetchEndOfGroupCallback;
  private onDeliveryTimeout?: DeliveryTimeoutCallback;
  private onStreamReset?: StreamResetCallback;

  /**
   * §8 delivery-timeout tracker. Keys look like
   * `sg:${trackAlias}:${groupId}:${subgroupId}` for subgroups and
   * `obj:${trackAlias}:${groupId}:${subgroupId}:${objectId}` for individual
   * objects. On expiry we mark the key in `pendingExpirations` so the
   * reader loop can bail at the next boundary, and — critically — cancel
   * the associated active reader so a stalled `reader.read()` wakes up.
   */
  private timeoutTracker = new DeliveryTimeoutTracker((key, reason, resetCode) => {
    this.pendingExpirations.set(key, { reason, resetCode });
    const trackAliasKey = parseAliasFromTimerKey(key);
    if (trackAliasKey === undefined) return;
    const reader = this.activeReaders.get(trackAliasKey);
    if (reader) {
      // Detach mapping first so a re-entrant cancel doesn't loop.
      this.activeReaders.delete(trackAliasKey);
      try { void reader.cancel('DELIVERY_TIMEOUT'); } catch { /* ignore */ }
    }
    // Fire the consumer callback synchronously — the pending-expirations
    // path is a belt-and-braces safety net for readers that are already
    // mid-decode when the deadline fires.
    const sub = this.subscriptionManager.getByAlias(trackAliasKey);
    if (sub && this.onDeliveryTimeout) {
      const [, aliasStr, gStr, sgStr, oStr] = key.split(':');
      const detail: { groupId?: number; subgroupId?: number; objectId?: number } = {};
      if (gStr !== undefined) detail.groupId = Number(gStr);
      if (sgStr !== undefined) detail.subgroupId = Number(sgStr);
      if (oStr !== undefined) detail.objectId = Number(oStr);
      void aliasStr; // alias is already resolved via subscription
      this.onDeliveryTimeout(sub, reason, resetCode, detail);
    }
  });
  private pendingExpirations = new Map<
    string,
    { reason: DeliveryTimeoutReason; resetCode: StreamResetErrorCodeDraft18 }
  >();
  /**
   * Active stream readers keyed by track alias so the timeout tracker can
   * cancel them when a deadline elapses. Populated by handleIncomingStream
   * once the subgroup header is decoded (before that we don't know which
   * subscription owns the stream).
   */
  private activeReaders = new Map<string, ReadableStreamDefaultReader<Uint8Array>>();

  constructor(
    private subscriptionManager: SubscriptionManager,
    private onObject?: ObjectCallback
  ) {}

  /** Register the callback fired when a §8 delivery deadline elapses. */
  setDeliveryTimeoutCallback(cb: DeliveryTimeoutCallback): void {
    this.onDeliveryTimeout = cb;
  }

  /**
   * Register the callback fired when a peer resets an incoming subgroup
   * stream (draft-18 §11.4.3 / §15.10.4). §8 deadline-driven resets are
   * routed through {@link setDeliveryTimeoutCallback} instead, so this hook
   * only fires for peer-initiated aborts.
   */
  setStreamResetCallback(cb: StreamResetCallback): void {
    this.onStreamReset = cb;
  }

  /** Test-only accessor for the internal tracker. */
  get deliveryTimeoutTracker(): DeliveryTimeoutTracker {
    return this.timeoutTracker;
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
   * Set the FETCH end-of-group callback
   */
  setFetchEndOfGroupCallback(callback: FetchEndOfGroupCallback): void {
    this.onFetchEndOfGroup = callback;
  }

  /**
   * Handle incoming datagram
   */
  handleDatagram(data: Uint8Array): void {
    log.trace('Received datagram', { size: data.length });

    // Check first byte to filter out misrouted stream data
    if (data.length > 0) {
      const firstByte = data[0];
      // OBJECT_DATAGRAM = 0x01, SUBGROUP types = 0x04, 0x10, 0x11, 0x12
      if (firstByte !== 0x01 && (firstByte === 0x04 || (firstByte >= 0x10 && firstByte <= 0x12))) {
        log.trace('Ignoring datagram with stream format', { firstByte: `0x${firstByte.toString(16)}` });
        return;
      }
    }

    try {
      const object = ObjectCodec.decodeDatagramObject(data);
      const { header, payload } = object;

      log.trace('Decoded datagram object', {
        trackAlias: header.trackAlias,
        groupId: header.groupId,
        objectId: header.objectId,
        payloadSize: payload.length,
      });

      // Route to subscription
      const subscription = this.subscriptionManager.getByAlias(header.trackAlias);

      if (subscription) {
        const timestamp = performance.now() * 1000; // microseconds
        this.deliverObject(subscription, payload, header.groupId, header.objectId, timestamp);
      } else {
        log.warn('Received datagram for unknown track alias', {
          receivedTrackAlias: header.trackAlias.toString(),
          knownAliases: this.subscriptionManager.getKnownAliases(),
        });
      }
    } catch (err) {
      log.trace('Error parsing datagram', { error: (err as Error).message });
    }
  }

  /**
   * Handle incoming unidirectional stream
   */
  async handleIncomingStream(stream: ReadableStream<Uint8Array>): Promise<void> {
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
          if (IS_DRAFT_18 || IS_DRAFT_16) {
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

            try {
              [subgroupHeader, headerBytes, endOfGroup, hasExtensions] = ObjectCodec.decodeSubgroupHeader(bufferView);
              headerParsed = true;

              log.info('Decoded subgroup header', {
                trackAlias: subgroupHeader.trackAlias,
                groupId: subgroupHeader.groupId,
                subgroupId: subgroupHeader.subgroupId,
                endOfGroup,
                hasExtensions,
              });

              // Arm §8 subgroup-delivery timer if the subscription requested one.
              this.armSubgroupTimer(subgroupHeader);
              // Register the reader so an expiring timer can cancel it if
              // it's blocked in reader.read().
              this.activeReaders.set(subgroupHeader.trackAlias.toString(), reader);

              bufferOffset += headerBytes;
            } catch (decodeErr) {
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

            try {
              [subgroupHeader, headerBytes, endOfGroup, hasExtensions] = ObjectCodec.decodeSubgroupHeader(bufferView);
              headerParsed = true;

              log.info('Decoded subgroup header', {
                streamType: `0x${streamType.toString(16)}`,
                trackAlias: subgroupHeader.trackAlias,
                groupId: subgroupHeader.groupId,
                subgroupId: subgroupHeader.subgroupId,
              });

              bufferOffset += headerBytes;
            } catch {
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
            // §8 delivery-timeout: if the subgroup or object deadline expired
            // while we were waiting for bytes, bail out before decoding.
            if (this.consumeExpiredTimer(subgroupHeader, previousObjectId)) {
              try { await reader.cancel('DELIVERY_TIMEOUT'); } catch { /* ignore */ }
              return;
            }
            try {
              const view = buffer.subarray(bufferOffset);
              const [objectId, payload, status, bytesConsumed] = ObjectCodec.decodeStreamObject(view, 0, hasExtensions, previousObjectId);
              // §8: this object arrived — cancel its per-object timer, then
              // arm the next one before we do delivery.
              this.disarmObjectTimer(subgroupHeader, objectId);
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

              // Arm the *next* object's per-object timer now that we've
              // delivered objectId. Speculative — the next object may never
              // arrive if this was the last one in the subgroup; it'll be
              // cleared when the stream closes.
              this.armObjectTimer(subgroupHeader, objectId + 1);

              bufferOffset += bytesConsumed;
            } catch (decodeErr) {
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
          // §8: subgroup finished cleanly — cancel its pending timers so a
          // leftover per-object deadline can't fire spuriously.
          if (subgroupHeader) {
            this.disarmSubgroupTimers(subgroupHeader, previousObjectId);
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
        this.onStreamReset(subscription, streamErrorCode, errorMessage, detail);
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
  }

  /**
   * Handle legacy/datagram-style stream data
   */
  private async handleLegacyStreamData(data: Uint8Array): Promise<void> {
    const streamType = data[0] & 0x3f;

    if (streamType === 0x01) {
      const object = ObjectCodec.decodeDatagramObject(data);
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
    initialDone: boolean
  ): Promise<void> {
    const buffer = initialBuffer;
    const done = initialDone;

    // Parse FETCH_HEADER: stream type (already consumed) + request ID
    const headerReader = new BufferReader(buffer);
    headerReader.skip(1); // Skip stream type byte (0x05)

    let requestId: number;
    let bufferOffset: number;
    try {
      requestId = headerReader.readVarIntNumber();
      bufferOffset = headerReader.offset;
    } catch {
      log.error('Failed to decode FETCH request ID');
      return;
    }

    log.info('Handling FETCH stream', {
      requestId,
      initialBufferSize: buffer.length,
      draft: IS_DRAFT_18 ? 'draft-18' : 'draft-16',
    });

    if (IS_DRAFT_18) {
      return this.handleFetchStreamDraft18(reader, buffer, bufferOffset, done, requestId);
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
    requestId: number,
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

      // Check if we have data to process
      if (bufferOffset >= buffer.length) {
        if (done) {
          log.info('FETCH stream complete', { requestId, objectCount, totalBytesReceived });
          // Notify end of last group if we received any objects
          if (objectCount > 0 && this.onFetchEndOfGroup && decoderState.previousGroupId >= 0) {
            this.onFetchEndOfGroup(requestId, decoderState.previousGroupId);
          }
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

      try {
        const result = ObjectCodec.decodeFetchObject(remaining, decoderState);
        objectCount++;
        bufferOffset += result.bytesConsumed;

        log.info('Decoded FETCH object', {
          requestId,
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
        // May need more data
        if (done) {
          log.warn('Failed to decode FETCH object at end of stream', {
            requestId,
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
   * (spec §11.4.4.1). Special flag values 0x8C / 0x10C encode End-of-Range
   * markers (§11.4.4.2) and MUST NOT update the prior-object context.
   */
  private async handleFetchStreamDraft18(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    initialBuffer: Uint8Array,
    initialOffset: number,
    initialDone: boolean,
    requestId: number,
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
    let lastGroupIdEmitted: bigint | undefined;

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
        if (done) {
          log.warn('Failed to decode draft-18 FETCH object header at end of stream', {
            requestId,
            error: (err as Error).message,
            remainingBytes: buffer.length - startOffset,
          });
          break;
        }
        await ensureBytes();
        continue;
      }

      // End-of-Range marker: two varints follow the special flag; MUST NOT
      // update prior state (spec §11.4.4.2).
      if (decoded.endOfRange !== undefined) {
        bufferOffset = startOffset + headerBytes;
        log.info('Draft-18 FETCH end-of-range marker', {
          requestId,
          kind: decoded.endOfRange === FetchObjectEndOfRange.NON_EXISTENT ? 'non-existent' : 'unknown',
          groupIdDelta: decoded.groupIdDelta?.toString(),
          objectIdDelta: decoded.objectIdDelta?.toString(),
        });
        continue;
      }

      // Resolve inherited/absolute Group ID.
      const isFirst = prevGroupId === undefined;
      let groupId: bigint;
      if (decoded.groupIdDelta !== undefined) {
        // Present-on-wire: draft-18 encodes as absolute for the first object,
        // and moqtail/reference decoders treat later Group ID Delta fields as
        // absolute values (there is no arithmetic delta — the flag bit merely
        // signals presence; when absent the value inherits from the prior).
        groupId = decoded.groupIdDelta;
      } else {
        if (isFirst) {
          throw new Error('Draft-18 FETCH: first object missing Group ID (spec §11.4.4)');
        }
        groupId = prevGroupId!;
      }

      // Resolve Object ID: present-on-wire ⇒ absolute; absent ⇒ prev + 1.
      let objectId: bigint;
      if (decoded.objectIdDelta !== undefined) {
        objectId = decoded.objectIdDelta;
      } else {
        if (isFirst) {
          throw new Error('Draft-18 FETCH: first object missing Object ID (spec §11.4.4)');
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
              throw new Error('Draft-18 FETCH: PRIOR subgroup mode on first object (spec §11.4.4)');
            }
            subgroupId = prevSubgroupId;
            break;
          case FetchSubgroupMode.PRIOR_PLUS_ONE:
            if (prevSubgroupId === undefined) {
              throw new Error('Draft-18 FETCH: PRIOR_PLUS_ONE subgroup mode on first object (spec §11.4.4)');
            }
            subgroupId = prevSubgroupId + 1n;
            break;
          case FetchSubgroupMode.EXPLICIT:
            if (decoded.subgroupId === undefined) {
              throw new Error('Draft-18 FETCH: EXPLICIT subgroup mode missing subgroupId (spec §11.4.4)');
            }
            subgroupId = decoded.subgroupId;
            break;
          default:
            throw new Error(`Draft-18 FETCH: invalid subgroupMode ${decoded.subgroupMode}`);
        }
      }

      // Priority: present ⇒ use it, absent ⇒ inherit.
      let priority: number;
      if (decoded.publisherPriority !== undefined) {
        priority = decoded.publisherPriority;
      } else {
        if (prevPriority === undefined) {
          throw new Error('Draft-18 FETCH: first object missing publisherPriority (spec §11.4.4)');
        }
        priority = prevPriority;
      }

      // Payload length is the varint just before the payload. Buffer may need
      // to grow to cover the full payload; loop until we have enough bytes.
      const payloadLenN = Number(decoded.payloadLength ?? 0n);
      if (!Number.isSafeInteger(payloadLenN) || payloadLenN < 0) {
        throw new Error(`Draft-18 FETCH: invalid payload length ${decoded.payloadLength}`);
      }
      const totalObjectBytes = headerBytes + payloadLenN;
      while (buffer.length - startOffset < totalObjectBytes) {
        if (done) {
          log.warn('Draft-18 FETCH stream truncated mid-payload', {
            requestId,
            needed: totalObjectBytes,
            haveRemaining: buffer.length - startOffset,
          });
          return;
        }
        await ensureBytes();
      }

      const payloadStart = startOffset + headerBytes;
      const payload = buffer.slice(payloadStart, payloadStart + payloadLenN);
      bufferOffset = payloadStart + payloadLenN;

      objectCount++;
      const groupIdN = Number(groupId);
      const objectIdN = Number(objectId);

      // Emit end-of-group when the group changes (but not on the very first
      // object). We track the last-emitted group so we don't re-signal.
      if (lastGroupIdEmitted !== undefined && groupId !== lastGroupIdEmitted && this.onFetchEndOfGroup) {
        this.onFetchEndOfGroup(requestId, Number(lastGroupIdEmitted));
      }
      lastGroupIdEmitted = groupId;

      log.info('Decoded draft-18 FETCH object', {
        requestId,
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

    log.info('Draft-18 FETCH stream complete', { requestId, objectCount, totalBytesReceived });
    if (objectCount > 0 && this.onFetchEndOfGroup && lastGroupIdEmitted !== undefined) {
      this.onFetchEndOfGroup(requestId, Number(lastGroupIdEmitted));
    }
  }

  // ─── §8 delivery-timeout helpers ────────────────────────────────────────

  private subgroupKey(h: { trackAlias: number | bigint; groupId: number; subgroupId: number }): string {
    return `sg:${h.trackAlias.toString()}:${h.groupId}:${h.subgroupId}`;
  }

  private objectKey(
    h: { trackAlias: number | bigint; groupId: number; subgroupId: number },
    objectId: number,
  ): string {
    return `obj:${h.trackAlias.toString()}:${h.groupId}:${h.subgroupId}:${objectId}`;
  }

  private armSubgroupTimer(h: { trackAlias: number | bigint; groupId: number; subgroupId: number }): void {
    const sub = this.subscriptionManager.getByAlias(h.trackAlias);
    if (!sub) return;
    const ms = sub.subgroupDeliveryTimeoutMs;
    if (!ms || ms <= 0) return;
    this.timeoutTracker.arm(this.subgroupKey(h), 'subgroup', ms);
    // Also arm the first-object deadline speculatively (objectId = 0). If
    // objects arrive in a different order we correct in the object branch.
    this.armObjectTimer(h, 0);
  }

  private armObjectTimer(
    h: { trackAlias: number | bigint; groupId: number; subgroupId: number },
    objectId: number,
  ): void {
    const sub = this.subscriptionManager.getByAlias(h.trackAlias);
    if (!sub) return;
    const ms = sub.objectDeliveryTimeoutMs;
    if (!ms || ms <= 0) return;
    this.timeoutTracker.arm(this.objectKey(h, objectId), 'object', ms);
  }

  private disarmObjectTimer(
    h: { trackAlias: number | bigint; groupId: number; subgroupId: number },
    objectId: number,
  ): void {
    this.timeoutTracker.disarm(this.objectKey(h, objectId));
  }

  private disarmSubgroupTimers(
    h: { trackAlias: number | bigint; groupId: number; subgroupId: number },
    lastObjectId: number,
  ): void {
    this.timeoutTracker.disarm(this.subgroupKey(h));
    // Objects we know about — leave a small window of speculative timers to
    // disarm as well (we armed obj = lastObjectId + 1 speculatively).
    for (let i = 0; i <= lastObjectId + 1; i++) {
      this.timeoutTracker.disarm(this.objectKey(h, i));
    }
    this.activeReaders.delete(h.trackAlias.toString());
  }

  /**
   * Consume any expiration marker that landed while we were awaiting data.
   * The tracker callback already invokes `onDeliveryTimeout` and cancels the
   * reader; this helper just clears the marker so a downstream re-decode
   * doesn't observe a stale flag.
   */
  private consumeExpiredTimer(
    h: { trackAlias: number | bigint; groupId: number; subgroupId: number },
    previousObjectId: number,
  ): boolean {
    if (this.pendingExpirations.size === 0) return false;
    const sgKey = this.subgroupKey(h);
    const objKey = this.objectKey(h, previousObjectId + 1);
    const hit = this.pendingExpirations.has(sgKey) || this.pendingExpirations.has(objKey);
    if (!hit) return false;
    this.pendingExpirations.delete(sgKey);
    this.pendingExpirations.delete(objKey);
    return true;
  }

  /** Cancel every pending §8 timer (e.g. on session close). */
  clearDeliveryTimeouts(): void {
    this.timeoutTracker.clear();
    this.pendingExpirations.clear();
  }
}
