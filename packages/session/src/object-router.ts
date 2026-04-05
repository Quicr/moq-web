// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Object Router
 *
 * Routes received objects (from streams and datagrams) to the
 * appropriate subscriptions.
 */

import { Logger, ObjectCodec, ObjectStatus, IS_DRAFT_16 } from '@web-moq/core';
import type { SubscriptionManager, InternalSubscription } from './subscription-manager.js';

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
 * Routes objects to subscriptions
 */
export class ObjectRouter {
  constructor(
    private subscriptionManager: SubscriptionManager,
    private onObject?: ObjectCallback
  ) {}

  /**
   * Set the object callback
   */
  setCallback(callback: ObjectCallback): void {
    this.onObject = callback;
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
    try {
      const reader = stream.getReader();

      let buffer = new Uint8Array(0);
      let bufferOffset = 0;
      let headerParsed = false;
      let subgroupHeader: { trackAlias: number | bigint; groupId: number; subgroupId: number } | null = null;
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
          if (IS_DRAFT_16) {
            // Draft-16: Stream starts with Type (0x10-0x3D range)
            log.info('Incoming stream first bytes (draft-16)', {
              viewLength,
              preview: Array.from(bufferView.slice(0, Math.min(20, viewLength))).map(b => b.toString(16).padStart(2, '0')).join(' '),
            });

            try {
              [subgroupHeader, headerBytes, endOfGroup, hasExtensions] = ObjectCodec.decodeSubgroupHeader(bufferView);
              headerParsed = true;

              log.info('Decoded subgroup header (draft-16)', {
                trackAlias: subgroupHeader.trackAlias,
                groupId: subgroupHeader.groupId,
                subgroupId: subgroupHeader.subgroupId,
                endOfGroup,
                hasExtensions,
              });

              bufferOffset += headerBytes;
            } catch (decodeErr) {
              log.warn('Failed to decode subgroup header (draft-16)', {
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
          while (bufferOffset < buffer.length) {
            try {
              const view = buffer.subarray(bufferOffset);
              const [objectId, payload, status, bytesConsumed] = ObjectCodec.decodeStreamObject(view, 0, hasExtensions, false, previousObjectId);
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
                this.deliverObject(subscription, payload, subgroupHeader.groupId, objectId, timestamp);

                log.trace('Processed stream object', {
                  groupId: subgroupHeader.groupId,
                  objectId,
                  payloadSize: payload.length,
                });
              } else {
                log.warn('Received stream object for unknown track alias', {
                  receivedTrackAlias: subgroupHeader.trackAlias.toString(),
                  knownAliases: this.subscriptionManager.getKnownAliases(),
                });
              }

              bufferOffset += bytesConsumed;
            } catch {
              break;
            }
          }
        }

        if (done) {
          log.info('Stream ended', {
            totalBytesReceived,
            totalReads: readCount,
            objectCount,
            headerParsed,
            trackAlias: subgroupHeader?.trackAlias?.toString(),
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
      if (errorMessage.includes('session is closed') ||
          errorMessage.includes('stream is closed') ||
          errorMessage.includes('aborted')) {
        log.debug('Stream closed during read (disconnect)', { error: errorMessage });
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
}
