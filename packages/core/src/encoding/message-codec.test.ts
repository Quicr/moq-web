// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MessageCodec and ObjectCodec Tests
 */

import { describe, it, expect } from 'vitest';
import { MessageCodec, ObjectCodec, MessageCodecError } from './message-codec';
import { DEFAULT_DRAFT } from '../version/constants';
import { BufferReader } from './varint';
import {
  MessageType,
  Version,
  SetupParameter,
  GroupOrder,
  FilterType,
  ObjectStatus,
  RequestErrorCode,
  NamespaceErrorCode,
  TrackStatusCode,
  ClientSetupMessage,
  ServerSetupMessage,
  GoAwayMessage,
  MaxRequestIdMessage,
  RequestsBlockedMessage,
  SubscribeMessage,
  SubscribeUpdateMessage,
  SubscribeOkMessage,
  SubscribeErrorMessage,
  UnsubscribeMessage,
  PublishDoneMessage,
  PublishMessage,
  PublishOkMessage,
  PublishErrorMessage,
  PublishNamespaceMessage,
  PublishNamespaceOkMessage,
  PublishNamespaceErrorMessage,
  PublishNamespaceDoneMessage,
  PublishNamespaceCancelMessage,
  SubscribeNamespaceMessage,
  SubscribeNamespaceOkMessage,
  SubscribeNamespaceErrorMessage,
  UnsubscribeNamespaceMessage,
  FetchMessage,
  FetchOkMessage,
  FetchErrorMessage,
  FetchCancelMessage,
  TrackStatusMessage,
  TrackStatusOkMessage,
  TrackStatusErrorMessage,
  ObjectHeader,
  MOQTObject,
  SubgroupHeader,
  FetchHeader,
} from '../messages/types';

describe('MessageCodec', () => {
  describe('encode and decode roundtrip', () => {
    describe('Session Messages', () => {
      it('roundtrips CLIENT_SETUP message', () => {
        // Draft-16: version negotiation via ALPN, only one version in message
        const message: ClientSetupMessage = {
          type: MessageType.CLIENT_SETUP,
          supportedVersions: [Version.DRAFT_16],
          parameters: new Map([
            [SetupParameter.PATH, '/moq'],
            [SetupParameter.MAX_REQUEST_ID, 100],
          ]),
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.CLIENT_SETUP);
        const decodedSetup = decoded as ClientSetupMessage;
        expect(decodedSetup.supportedVersions).toEqual([Version.DRAFT_16]);
        expect(decodedSetup.parameters.get(SetupParameter.PATH)).toBe('/moq');
        expect(decodedSetup.parameters.get(SetupParameter.MAX_REQUEST_ID)).toBe(100);
      });

      it('roundtrips SERVER_SETUP message', () => {
        const message: ServerSetupMessage = {
          type: MessageType.SERVER_SETUP,
          selectedVersion: Version.DRAFT_16,
          parameters: new Map([
            [SetupParameter.MAX_REQUEST_ID, 50],
          ]),
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.SERVER_SETUP);
        const decodedSetup = decoded as ServerSetupMessage;
        expect(decodedSetup.selectedVersion).toBe(Version.DRAFT_16);
        expect(decodedSetup.parameters.get(SetupParameter.MAX_REQUEST_ID)).toBe(50);
      });

      it('roundtrips GOAWAY message', () => {
        const message: GoAwayMessage = {
          type: MessageType.GOAWAY,
          newSessionUri: 'https://example.com/new-session',
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.GOAWAY);
        expect((decoded as GoAwayMessage).newSessionUri).toBe('https://example.com/new-session');
      });

      it('roundtrips GOAWAY message without URI', () => {
        const message: GoAwayMessage = {
          type: MessageType.GOAWAY,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.GOAWAY);
        expect((decoded as GoAwayMessage).newSessionUri).toBeUndefined();
      });

      it('roundtrips MAX_REQUEST_ID message', () => {
        const message: MaxRequestIdMessage = {
          type: MessageType.MAX_REQUEST_ID,
          maxRequestId: 12345n,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.MAX_REQUEST_ID);
        expect((decoded as MaxRequestIdMessage).maxRequestId).toBe(12345n);
      });

      it('roundtrips REQUESTS_BLOCKED message', () => {
        const message: RequestsBlockedMessage = {
          type: MessageType.REQUESTS_BLOCKED,
          blockedRequestId: 999n,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.REQUESTS_BLOCKED);
        expect((decoded as RequestsBlockedMessage).blockedRequestId).toBe(999n);
      });
    });

    describe('Subscribe Messages', () => {
      it('roundtrips SUBSCRIBE message with LATEST_GROUP filter', () => {
        const message: SubscribeMessage = {
          type: MessageType.SUBSCRIBE,
          requestId: 1n,
          fullTrackName: {
            namespace: ['conference', 'room-1'],
            trackName: 'video',
          },
          subscriberPriority: 128,
          groupOrder: GroupOrder.ASCENDING,
          filterType: FilterType.LATEST_GROUP,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.SUBSCRIBE);
        const decodedSub = decoded as SubscribeMessage;
        expect(decodedSub.requestId).toBe(1n);
        expect(decodedSub.fullTrackName.namespace).toEqual(['conference', 'room-1']);
        expect(decodedSub.fullTrackName.trackName).toBe('video');
        expect(decodedSub.subscriberPriority).toBe(128);
        expect(decodedSub.groupOrder).toBe(GroupOrder.ASCENDING);
        expect(decodedSub.filterType).toBe(FilterType.LATEST_GROUP);
      });

      it('roundtrips SUBSCRIBE_UPDATE message', () => {
        const message: SubscribeUpdateMessage = {
          type: MessageType.SUBSCRIBE_UPDATE,
          requestId: 10n,
          subscriptionRequestId: 1n,
          startLocation: { groupId: 5n, objectId: 10n },
          endGroup: 20n,
          subscriberPriority: 200,
          forward: 1,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.SUBSCRIBE_UPDATE);
        const decodedUpdate = decoded as SubscribeUpdateMessage;
        expect(decodedUpdate.requestId).toBe(10n);
        expect(decodedUpdate.subscriptionRequestId).toBe(1n);
        expect(decodedUpdate.startLocation).toEqual({ groupId: 5n, objectId: 10n });
        expect(decodedUpdate.endGroup).toBe(20n);
        expect(decodedUpdate.subscriberPriority).toBe(200);
        expect(decodedUpdate.forward).toBe(1);
      });

      it('roundtrips SUBSCRIBE_ERROR message', () => {
        const message: SubscribeErrorMessage = {
          type: MessageType.SUBSCRIBE_ERROR,
          requestId: 1n,
          errorCode: RequestErrorCode.TRACK_NOT_FOUND,
          reasonPhrase: 'Track does not exist',
          trackAlias: 0n,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.SUBSCRIBE_ERROR);
        const decodedError = decoded as SubscribeErrorMessage;
        expect(decodedError.requestId).toBe(1n);
        expect(decodedError.errorCode).toBe(RequestErrorCode.TRACK_NOT_FOUND);
        expect(decodedError.reasonPhrase).toBe('Track does not exist');
      });

      it('roundtrips UNSUBSCRIBE message', () => {
        const message: UnsubscribeMessage = {
          type: MessageType.UNSUBSCRIBE,
          requestId: 5n,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.UNSUBSCRIBE);
        expect((decoded as UnsubscribeMessage).requestId).toBe(5n);
      });
    });

    describe('Publish Messages', () => {
      it('roundtrips PUBLISH message without content', () => {
        const message: PublishMessage = {
          type: MessageType.PUBLISH,
          requestId: 1n,
          fullTrackName: {
            namespace: ['conference', 'room-1'],
            trackName: 'video',
          },
          trackAlias: 100n,
          groupOrder: GroupOrder.ASCENDING,
          contentExists: false,
          forward: 1,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.PUBLISH);
        const decodedPub = decoded as PublishMessage;
        expect(decodedPub.requestId).toBe(1n);
        expect(decodedPub.fullTrackName.namespace).toEqual(['conference', 'room-1']);
        expect(decodedPub.fullTrackName.trackName).toBe('video');
        expect(decodedPub.trackAlias).toBe(100n);
        expect(decodedPub.groupOrder).toBe(GroupOrder.ASCENDING);
        expect(decodedPub.contentExists).toBe(false);
      });

      it('roundtrips PUBLISH message with content', () => {
        const message: PublishMessage = {
          type: MessageType.PUBLISH,
          requestId: 2n,
          fullTrackName: {
            namespace: ['media'],
            trackName: 'audio',
          },
          trackAlias: 200n,
          groupOrder: GroupOrder.DESCENDING,
          contentExists: true,
          largestLocation: { groupId: 50n, objectId: 25n },
          forward: 0,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.PUBLISH);
        const decodedPub = decoded as PublishMessage;
        expect(decodedPub.contentExists).toBe(true);
        expect(decodedPub.largestLocation).toEqual({ groupId: 50n, objectId: 25n });
      });

      it('roundtrips PUBLISH_OK message', () => {
        const message: PublishOkMessage = {
          type: MessageType.PUBLISH_OK,
          requestId: 1n,
          forward: 1,
          subscriberPriority: 128,
          groupOrder: GroupOrder.ASCENDING,
          filterType: FilterType.LATEST_GROUP,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.PUBLISH_OK);
        const decodedOk = decoded as PublishOkMessage;
        expect(decodedOk.requestId).toBe(1n);
        expect(decodedOk.forward).toBe(1);
        expect(decodedOk.subscriberPriority).toBe(128);
        expect(decodedOk.groupOrder).toBe(GroupOrder.ASCENDING);
        expect(decodedOk.filterType).toBe(FilterType.LATEST_GROUP);
      });

      it('roundtrips PUBLISH_ERROR message', () => {
        const message: PublishErrorMessage = {
          type: MessageType.PUBLISH_ERROR,
          requestId: 1n,
          errorCode: RequestErrorCode.UNAUTHORIZED,
          reasonPhrase: 'Not authorized to publish',
          trackAlias: 100n,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.PUBLISH_ERROR);
        const decodedError = decoded as PublishErrorMessage;
        expect(decodedError.requestId).toBe(1n);
        expect(decodedError.errorCode).toBe(RequestErrorCode.UNAUTHORIZED);
        expect(decodedError.reasonPhrase).toBe('Not authorized to publish');
        expect(decodedError.trackAlias).toBe(100n);
      });

    });

    describe('Namespace Publishing Messages', () => {
      it('roundtrips PUBLISH_NAMESPACE message', () => {
        const message: PublishNamespaceMessage = {
          type: MessageType.PUBLISH_NAMESPACE,
          namespace: ['conference', 'room-1', 'media'],
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.PUBLISH_NAMESPACE);
        expect((decoded as PublishNamespaceMessage).namespace).toEqual(['conference', 'room-1', 'media']);
      });

      it('roundtrips PUBLISH_NAMESPACE_ERROR message', () => {
        const message: PublishNamespaceErrorMessage = {
          type: MessageType.PUBLISH_NAMESPACE_ERROR,
          namespace: ['conference'],
          errorCode: NamespaceErrorCode.NAMESPACE_NOT_SUPPORTED,
          reasonPhrase: 'Namespace does not exist',
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.PUBLISH_NAMESPACE_ERROR);
        const decodedError = decoded as PublishNamespaceErrorMessage;
        expect(decodedError.namespace).toEqual(['conference']);
        expect(decodedError.errorCode).toBe(NamespaceErrorCode.NAMESPACE_NOT_SUPPORTED);
        expect(decodedError.reasonPhrase).toBe('Namespace does not exist');
      });

      it('roundtrips PUBLISH_NAMESPACE_DONE message', () => {
        const message: PublishNamespaceDoneMessage = {
          type: MessageType.PUBLISH_NAMESPACE_DONE,
          namespace: ['media', 'video'],
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.PUBLISH_NAMESPACE_DONE);
        expect((decoded as PublishNamespaceDoneMessage).namespace).toEqual(['media', 'video']);
      });

      it('roundtrips PUBLISH_NAMESPACE_CANCEL message', () => {
        const message: PublishNamespaceCancelMessage = {
          type: MessageType.PUBLISH_NAMESPACE_CANCEL,
          namespace: ['media'],
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.PUBLISH_NAMESPACE_CANCEL);
        expect((decoded as PublishNamespaceCancelMessage).namespace).toEqual(['media']);
      });
    });

    describe('Namespace Subscription Messages', () => {
      it('roundtrips SUBSCRIBE_NAMESPACE message', () => {
        const message: SubscribeNamespaceMessage = {
          type: MessageType.SUBSCRIBE_NAMESPACE,
          namespacePrefix: ['conference', 'room-1'],
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.SUBSCRIBE_NAMESPACE);
        expect((decoded as SubscribeNamespaceMessage).namespacePrefix).toEqual(['conference', 'room-1']);
      });

      it('roundtrips UNSUBSCRIBE_NAMESPACE message', () => {
        const message: UnsubscribeNamespaceMessage = {
          type: MessageType.UNSUBSCRIBE_NAMESPACE,
          namespacePrefix: ['conference', 'room-1'],
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.UNSUBSCRIBE_NAMESPACE);
        expect((decoded as UnsubscribeNamespaceMessage).namespacePrefix).toEqual(['conference', 'room-1']);
      });
    });

    describe('Fetch Messages', () => {
      it('roundtrips FETCH message', () => {
        const message: FetchMessage = {
          type: MessageType.FETCH,
          requestId: 1n,
          fullTrackName: {
            namespace: ['conference', 'room-1'],
            trackName: 'video',
          },
          subscriberPriority: 128,
          groupOrder: GroupOrder.ASCENDING,
          startGroup: 0n,
          startObject: 0n,
          endGroup: 10n,
          endObject: 100n,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.FETCH);
        const decodedFetch = decoded as FetchMessage;
        expect(decodedFetch.requestId).toBe(1n);
        expect(decodedFetch.fullTrackName.namespace).toEqual(['conference', 'room-1']);
        expect(decodedFetch.fullTrackName.trackName).toBe('video');
        expect(decodedFetch.subscriberPriority).toBe(128);
        expect(decodedFetch.groupOrder).toBe(GroupOrder.ASCENDING);
        expect(decodedFetch.startGroup).toBe(0n);
        expect(decodedFetch.startObject).toBe(0n);
        expect(decodedFetch.endGroup).toBe(10n);
        expect(decodedFetch.endObject).toBe(100n);
      });

      it('roundtrips FETCH_OK message', () => {
        // Draft-16/18 drop groupOrder from FETCH_OK wire; codec hardcodes ASCENDING.
        // Encode with ASCENDING so the roundtrip is stable across all supported drafts.
        const message: FetchOkMessage = {
          type: MessageType.FETCH_OK,
          requestId: 1n,
          groupOrder: GroupOrder.ASCENDING,
          endOfTrack: true,
          largestGroupId: 50n,
          largestObjectId: 25n,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.FETCH_OK);
        const decodedOk = decoded as FetchOkMessage;
        expect(decodedOk.requestId).toBe(1n);
        expect(decodedOk.groupOrder).toBe(GroupOrder.ASCENDING);
        expect(decodedOk.endOfTrack).toBe(true);
        expect(decodedOk.largestGroupId).toBe(50n);
        expect(decodedOk.largestObjectId).toBe(25n);
      });

      it('roundtrips FETCH_ERROR message', () => {
        const message: FetchErrorMessage = {
          type: MessageType.FETCH_ERROR,
          requestId: 1n,
          errorCode: RequestErrorCode.TRACK_NOT_FOUND,
          reasonPhrase: 'Track not found',
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.FETCH_ERROR);
        const decodedError = decoded as FetchErrorMessage;
        expect(decodedError.requestId).toBe(1n);
        expect(decodedError.errorCode).toBe(RequestErrorCode.TRACK_NOT_FOUND);
        expect(decodedError.reasonPhrase).toBe('Track not found');
      });

      it('roundtrips FETCH_CANCEL message', () => {
        const message: FetchCancelMessage = {
          type: MessageType.FETCH_CANCEL,
          requestId: 5n,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.FETCH_CANCEL);
        expect((decoded as FetchCancelMessage).requestId).toBe(5n);
      });
    });

    describe('Track Status Messages', () => {
      it('roundtrips TRACK_STATUS message', () => {
        const message: TrackStatusMessage = {
          type: MessageType.TRACK_STATUS,
          requestId: 1n,
          fullTrackName: {
            namespace: ['conference'],
            trackName: 'video',
          },
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.TRACK_STATUS);
        const decodedStatus = decoded as TrackStatusMessage;
        expect(decodedStatus.requestId).toBe(1n);
        expect(decodedStatus.fullTrackName.namespace).toEqual(['conference']);
        expect(decodedStatus.fullTrackName.trackName).toBe('video');
      });

      it('roundtrips TRACK_STATUS_OK message without location', () => {
        const message: TrackStatusOkMessage = {
          type: MessageType.TRACK_STATUS_OK,
          requestId: 1n,
          statusCode: TrackStatusCode.NOT_YET_BEGUN,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.TRACK_STATUS_OK);
        const decodedOk = decoded as TrackStatusOkMessage;
        expect(decodedOk.requestId).toBe(1n);
        expect(decodedOk.statusCode).toBe(TrackStatusCode.NOT_YET_BEGUN);
      });

      it('roundtrips TRACK_STATUS_OK message with location (IN_PROGRESS)', () => {
        const message: TrackStatusOkMessage = {
          type: MessageType.TRACK_STATUS_OK,
          requestId: 2n,
          statusCode: TrackStatusCode.IN_PROGRESS,
          lastGroupId: 10n,
          lastObjectId: 5n,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.TRACK_STATUS_OK);
        const decodedOk = decoded as TrackStatusOkMessage;
        expect(decodedOk.statusCode).toBe(TrackStatusCode.IN_PROGRESS);
        expect(decodedOk.lastGroupId).toBe(10n);
        expect(decodedOk.lastObjectId).toBe(5n);
      });

      it('roundtrips TRACK_STATUS_OK message with location (FINISHED)', () => {
        const message: TrackStatusOkMessage = {
          type: MessageType.TRACK_STATUS_OK,
          requestId: 3n,
          statusCode: TrackStatusCode.FINISHED,
          lastGroupId: 100n,
          lastObjectId: 50n,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.TRACK_STATUS_OK);
        const decodedOk = decoded as TrackStatusOkMessage;
        expect(decodedOk.statusCode).toBe(TrackStatusCode.FINISHED);
        expect(decodedOk.lastGroupId).toBe(100n);
        expect(decodedOk.lastObjectId).toBe(50n);
      });

      it('roundtrips TRACK_STATUS_ERROR message', () => {
        const message: TrackStatusErrorMessage = {
          type: MessageType.TRACK_STATUS_ERROR,
          requestId: 1n,
          errorCode: RequestErrorCode.TRACK_NOT_FOUND,
          reasonPhrase: 'Track does not exist',
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.TRACK_STATUS_ERROR);
        const decodedError = decoded as TrackStatusErrorMessage;
        expect(decodedError.requestId).toBe(1n);
        expect(decodedError.errorCode).toBe(RequestErrorCode.TRACK_NOT_FOUND);
        expect(decodedError.reasonPhrase).toBe('Track does not exist');
      });
    });
  });

  describe('decode returns bytes consumed', () => {
    it('returns correct bytes consumed for simple message', () => {
      const message: UnsubscribeMessage = {
        type: MessageType.UNSUBSCRIBE,
        requestId: 42n,
      };

      const encoded = MessageCodec.encode(message);
      const [, bytesConsumed] = MessageCodec.decode(encoded);

      expect(bytesConsumed).toBe(encoded.length);
    });

    it('decodes at specified offset', () => {
      const message: MaxRequestIdMessage = {
        type: MessageType.MAX_REQUEST_ID,
        maxRequestId: 100n,
      };

      const encoded = MessageCodec.encode(message);
      // Prepend some bytes
      const withPrefix = new Uint8Array(5 + encoded.length);
      withPrefix.set([0xff, 0xfe, 0xfd, 0xfc, 0xfb]);
      withPrefix.set(encoded, 5);

      const [decoded, bytesConsumed] = MessageCodec.decode(withPrefix, 5);

      expect(decoded.type).toBe(MessageType.MAX_REQUEST_ID);
      expect((decoded as MaxRequestIdMessage).maxRequestId).toBe(100n);
      expect(bytesConsumed).toBe(encoded.length);
    });
  });

  describe('62-bit varint precision (Wave 2 Track F)', () => {
    // QUIC varints (RFC 9000 §16) can carry up to 2^62 - 1 = 4611686018427387903.
    // JavaScript Number can only represent integers precisely up to 2^53 - 1
    // (Number.MAX_SAFE_INTEGER = 9007199254740991), so any request ID above that
    // MUST survive the round-trip through the codec as a bigint. Losing precision
    // here would silently corrupt request ID matching on session state.
    it('roundtrips a SUBSCRIBE request ID above 2^53 without precision loss', () => {
      // 2^53 + 1 - exactly one greater than Number.MAX_SAFE_INTEGER
      const largeRequestId = (1n << 53n) + 1n;
      expect(largeRequestId).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));

      const message: SubscribeMessage = {
        type: MessageType.SUBSCRIBE,
        requestId: largeRequestId,
        fullTrackName: {
          namespace: ['large-request-ids'],
          trackName: 'video',
        },
        subscriberPriority: 128,
        groupOrder: GroupOrder.ASCENDING,
        filterType: FilterType.LATEST_GROUP,
      };

      const encoded = MessageCodec.encode(message);
      const [decoded] = MessageCodec.decode(encoded);

      const decodedSub = decoded as SubscribeMessage;
      // Exact bigint equality - Number() coercion would drop the low bit
      expect(decodedSub.requestId).toBe(largeRequestId);
      // Confirm precision loss detection: forcing through Number would collapse
      // to the same value as 2^53 (i.e. 9007199254740992).
      expect(Number(decodedSub.requestId)).not.toBe(Number(largeRequestId + 1n));
    });

    it('roundtrips a FETCH range with 62-bit group / object IDs', () => {
      // Near the 62-bit varint ceiling (2^62 - 1).
      const nearMax = (1n << 62n) - 1n;
      const message: FetchMessage = {
        type: MessageType.FETCH,
        requestId: (1n << 53n) + 42n,
        fullTrackName: { namespace: ['huge'], trackName: 'video' },
        subscriberPriority: 128,
        groupOrder: GroupOrder.ASCENDING,
        startGroup: nearMax - 10n,
        startObject: 0n,
        endGroup: nearMax,
        endObject: 0n,
      };

      const encoded = MessageCodec.encode(message);
      const [decoded] = MessageCodec.decode(encoded);
      const decodedFetch = decoded as FetchMessage;

      expect(decodedFetch.requestId).toBe(message.requestId);
      expect(decodedFetch.startGroup).toBe(message.startGroup);
      expect(decodedFetch.endGroup).toBe(message.endGroup);
    });

    it('roundtrips MAX_REQUEST_ID above Number.MAX_SAFE_INTEGER', () => {
      // Chosen to require the full 8-byte varint form.
      const huge = 1n << 60n;
      const message: MaxRequestIdMessage = {
        type: MessageType.MAX_REQUEST_ID,
        maxRequestId: huge,
      };

      const encoded = MessageCodec.encode(message);
      const [decoded] = MessageCodec.decode(encoded);

      expect((decoded as MaxRequestIdMessage).maxRequestId).toBe(huge);
    });
  });

  describe('error handling', () => {
    it('throws MessageCodecError for unknown message type on decode', () => {
      // Create a buffer with a valid varint for message type (0x60 = 96, not a known type)
      // followed by 16-bit length (0x00, 0x01 = 1 byte payload) and a dummy byte
      // This ensures the decoder reaches the message type check before running out of buffer
      const invalidBuffer = new Uint8Array([0x60, 0x00, 0x01, 0x00]);

      expect(() => MessageCodec.decode(invalidBuffer)).toThrow(MessageCodecError);
    });

    it('throws error for malformed buffer', () => {
      // Very short buffer that causes buffer underflow
      const shortBuffer = new Uint8Array([0x03]);

      expect(() => MessageCodec.decode(shortBuffer)).toThrow();
    });
  });
});

describe('ObjectCodec', () => {
  describe('datagram header encoding/decoding', () => {
    it('roundtrips datagram header with small track alias', () => {
      const header: ObjectHeader = {
        trackAlias: BigInt(1),
        groupId: 10,
        subgroupId: 0,
        objectId: 5,
        publisherPriority: 128,
        objectStatus: ObjectStatus.NORMAL,
      };

      const encoded = ObjectCodec.encodeDatagramHeader(header);
      const [decoded, bytesConsumed] = ObjectCodec.decodeDatagramHeader(encoded);

      expect(decoded.trackAlias).toBe(BigInt(1));
      expect(decoded.groupId).toBe(10);
      expect(decoded.subgroupId).toBe(0);
      expect(decoded.objectId).toBe(5);
      expect(decoded.publisherPriority).toBe(128);
      expect(decoded.objectStatus).toBe(ObjectStatus.NORMAL);
      expect(bytesConsumed).toBe(encoded.length);
    });

  });

  describe('datagram object encoding/decoding', () => {
    it('roundtrips complete datagram object', () => {
      const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
      const object: MOQTObject = {
        header: {
          trackAlias: BigInt(42),
          groupId: 1,
          subgroupId: 0,
          objectId: 0,
          publisherPriority: 128,
          objectStatus: ObjectStatus.NORMAL,
        },
        payload,
        payloadLength: payload.length,
      };

      const encoded = ObjectCodec.encodeDatagramObject(object);
      const decoded = ObjectCodec.decodeDatagramObject(encoded);

      expect(decoded.header.trackAlias).toBe(BigInt(42));
      expect(decoded.header.groupId).toBe(1);
      expect(decoded.header.objectId).toBe(0);
      expect(Array.from(decoded.payload)).toEqual([0x01, 0x02, 0x03, 0x04, 0x05]);
      expect(decoded.payloadLength).toBe(5);
    });

    it('handles empty payload', () => {
      const object: MOQTObject = {
        header: {
          trackAlias: BigInt(1),
          groupId: 0,
          subgroupId: 0,
          objectId: 0,
          publisherPriority: 0,
          objectStatus: ObjectStatus.END_OF_TRACK,
        },
        payload: new Uint8Array(0),
        payloadLength: 0,
      };

      const encoded = ObjectCodec.encodeDatagramObject(object);
      const decoded = ObjectCodec.decodeDatagramObject(encoded);

      expect(decoded.payload.length).toBe(0);
      expect(decoded.payloadLength).toBe(0);
    });
  });

  describe('subgroup header encoding/decoding', () => {
    it('roundtrips subgroup header (LAPS format)', () => {
      const header: SubgroupHeader = {
        trackAlias: BigInt(100),
        groupId: 5,
        subgroupId: 0, // LAPS format implies subgroupId = 0
        publisherPriority: 200,
      };

      const [encoded] = ObjectCodec.encodeSubgroupHeader(header);
      const [decoded, bytesConsumed] = ObjectCodec.decodeSubgroupHeader(encoded);

      expect(decoded.trackAlias).toBe(BigInt(100));
      expect(decoded.groupId).toBe(5);
      expect(decoded.subgroupId).toBe(0);
      expect(decoded.publisherPriority).toBe(200);
      expect(bytesConsumed).toBe(encoded.length);
    });

    it.skipIf(DEFAULT_DRAFT === 'draft-18')('decodes standard MOQT subgroup header (0x04)', () => {
      // Manually construct a standard MOQT subgroup header
      // Standard MOQT format: type(varint) + trackAlias(varint) + groupId(varint) + subgroupId(varint) + publisherPriority(varint)
      const buffer = new Uint8Array([
        0x04, // SUBGROUP_HEADER type (1-byte varint)
        0x40, 0x64, // trackAlias = 100 (2-byte varint: 0x40 | high, low)
        0x05, // groupId = 5 (1-byte varint)
        0x02, // subgroupId = 2 (1-byte varint)
        0x80, // publisherPriority = 128 (single byte, not varint)
      ]);

      const [decoded] = ObjectCodec.decodeSubgroupHeader(buffer);

      expect(decoded.trackAlias).toBe(BigInt(100));
      expect(decoded.groupId).toBe(5);
      expect(decoded.subgroupId).toBe(2);
      expect(decoded.publisherPriority).toBe(128);
    });

  });

  describe('fetch header encoding/decoding', () => {
    it('roundtrips fetch header', () => {
      const header: FetchHeader = {
        requestId: 12345n,
      };

      const encoded = ObjectCodec.encodeFetchHeader(header);
      const [decoded, bytesConsumed] = ObjectCodec.decodeFetchHeader(encoded);

      expect(decoded.requestId).toBe(12345n);
      expect(bytesConsumed).toBe(encoded.length);
    });

    it('throws error for wrong stream type', () => {
      // Create buffer with wrong stream type
      const invalidBuffer = new Uint8Array([0x01, 0x00, 0x01]); // OBJECT_DATAGRAM type

      expect(() => ObjectCodec.decodeFetchHeader(invalidBuffer)).toThrow(MessageCodecError);
    });
  });

  describe('stream object encoding/decoding', () => {
    it('roundtrips stream object with payload', () => {
      const payload = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
      const encoded = ObjectCodec.encodeStreamObject(42, payload, ObjectStatus.NORMAL);

      const [objectId, decodedPayload, status, bytesConsumed] = ObjectCodec.decodeStreamObject(
        encoded,
        0,
        false, // hasExtensions/hasProperties - encode doesn't write properties
      );

      expect(objectId).toBe(42);
      expect(Array.from(decodedPayload)).toEqual([0xDE, 0xAD, 0xBE, 0xEF]);
      expect(status).toBe(ObjectStatus.NORMAL);
      expect(bytesConsumed).toBe(encoded.length);
    });

    it('decodes stream object at offset', () => {
      const payload = new Uint8Array([0x01, 0x02, 0x03]);
      const encoded = ObjectCodec.encodeStreamObject(10, payload);

      // Prepend some bytes
      const withPrefix = new Uint8Array(3 + encoded.length);
      withPrefix.set([0xff, 0xfe, 0xfd]);
      withPrefix.set(encoded, 3);

      const [objectId, decodedPayload, , bytesConsumed] = ObjectCodec.decodeStreamObject(
        withPrefix,
        3,
        false,
      );

      expect(objectId).toBe(10);
      expect(Array.from(decodedPayload)).toEqual([0x01, 0x02, 0x03]);
      expect(bytesConsumed).toBe(encoded.length);
    });
  });

  describe('FETCH object encoding (draft-15/16)', () => {
    it('encodes first object with group, subgroup, and object ID', () => {
      const state = ObjectCodec.createFetchEncoderState();
      const payload = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);

      const encoded = ObjectCodec.encodeFetchObject(
        100, // groupId
        0, // subgroupId
        0, // objectId
        payload,
        state
      );

      // First object should have (moqx/moxygen bit layout):
      // flags = 0x08 (GROUP_ID) | 0x04 (OBJECT_ID) | 0x10 (PRIORITY) | 0x00 (subgroup mode 0 in bits 0-1)
      // = 0x1C (28 decimal, fits in 1-byte varint)
      const expectedFlags = 0x1C;
      expect(encoded[0]).toBe(expectedFlags);

      // Verify state was updated
      expect(state.previousGroupId).toBe(100);
      expect(state.previousSubgroupId).toBe(0);
      expect(state.previousObjectId).toBe(0);
    });

    it('encodes subsequent object in same group without group ID', () => {
      const state = ObjectCodec.createFetchEncoderState();
      const payload = new Uint8Array([0x01, 0x02]);

      // First object sets up state
      ObjectCodec.encodeFetchObject(100, 0, 0, payload, state);

      // Second object in same group
      const encoded = ObjectCodec.encodeFetchObject(100, 0, 1, payload, state);

      // Should NOT have GROUP_ID flag, but should have OBJECT_ID
      // moqx bit layout: subgroup mode 1 in bits 0-1 | 0x04 (OBJECT_ID)
      // = 0x01 | 0x04 = 0x05
      const expectedFlags = 0x05;
      const reader = new BufferReader(encoded);
      const actualFlags = reader.readVarIntNumber();
      expect(actualFlags).toBe(expectedFlags);
    });

    it('encodes object in new group with group ID', () => {
      const state = ObjectCodec.createFetchEncoderState();
      const payload = new Uint8Array([0x01]);

      // First object in group 100
      ObjectCodec.encodeFetchObject(100, 0, 0, payload, state);

      // First object in group 101
      const encoded = ObjectCodec.encodeFetchObject(101, 0, 0, payload, state);

      // Should have GROUP_ID flag for new group
      // moqx bit layout: GROUP_ID_PRESENT = 0x08 (bit 3)
      const reader = new BufferReader(encoded);
      const flags = reader.readVarIntNumber();
      const hasGroupFlag = (flags & 0x08) !== 0;
      expect(hasGroupFlag).toBe(true);
    });

    it('includes payload in encoded output', () => {
      const state = ObjectCodec.createFetchEncoderState();
      const payload = new Uint8Array([0xCA, 0xFE, 0xBA, 0xBE]);

      const encoded = ObjectCodec.encodeFetchObject(0, 0, 0, payload, state);

      // Payload should be at the end
      const lastFourBytes = encoded.slice(-4);
      expect(Array.from(lastFourBytes)).toEqual([0xCA, 0xFE, 0xBA, 0xBE]);
    });
  });
});

describe('AuthorizationToken', () => {
  describe('encodeAuthorizationToken / decodeAuthorizationToken', () => {
    it('round-trips USE_VALUE (aliasType 3)', () => {
      const tokenValue = new Uint8Array([0x84, 0x43, 0xa1, 0x01, 0x26, 0xa0, 0x44, 0x01, 0x02, 0x03, 0x04, 0x58, 0x40, ...new Array(64).fill(0xab)]);
      const token = {
        aliasType: 3,
        tokenType: 0x63346d,
        tokenValue,
      };

      const encoded = MessageCodec.encodeAuthorizationToken(token);
      const decoded = MessageCodec.decodeAuthorizationToken(encoded);

      expect(decoded.aliasType).toBe(3);
      expect(decoded.tokenType).toBe(0x63346d);
      expect(decoded.tokenValue).toEqual(tokenValue);
    });

    it('round-trips full token (aliasType 0)', () => {
      const tokenValue = new Uint8Array([1, 2, 3, 4, 5]);
      const token = {
        aliasType: 0,
        tokenType: 0x0002,
        tokenValue,
      };

      const encoded = MessageCodec.encodeAuthorizationToken(token);
      const decoded = MessageCodec.decodeAuthorizationToken(encoded);

      expect(decoded.aliasType).toBe(0);
      expect(decoded.tokenType).toBe(0x0002);
      expect(decoded.tokenValue).toEqual(tokenValue);
    });

    it('round-trips define alias (aliasType 1)', () => {
      const tokenValue = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      const token = {
        aliasType: 1,
        tokenAlias: 42,
        tokenType: 0x63346d,
        tokenValue,
      };

      const encoded = MessageCodec.encodeAuthorizationToken(token);
      const decoded = MessageCodec.decodeAuthorizationToken(encoded);

      expect(decoded.aliasType).toBe(1);
      expect(decoded.tokenAlias).toBe(42);
      expect(decoded.tokenType).toBe(0x63346d);
      expect(decoded.tokenValue).toEqual(tokenValue);
    });

    it('round-trips use alias (aliasType 2)', () => {
      const token = {
        aliasType: 2,
        tokenAlias: 42,
      };

      const encoded = MessageCodec.encodeAuthorizationToken(token);
      const decoded = MessageCodec.decodeAuthorizationToken(encoded);

      expect(decoded.aliasType).toBe(2);
      expect(decoded.tokenAlias).toBe(42);
      expect(decoded.tokenType).toBeUndefined();
      expect(decoded.tokenValue).toBeUndefined();
    });

    it('throws on unknown aliasType', () => {
      expect(() => MessageCodec.encodeAuthorizationToken({
        aliasType: 99,
      })).toThrow(MessageCodecError);
    });
  });

  it('CLIENT_SETUP with binary AUTHORIZATION_TOKEN preserves bytes', () => {
    // Build a CLIENT_SETUP with binary auth token
    const authTokenBytes = new Uint8Array(80);
    crypto.getRandomValues(authTokenBytes);

    const message: ClientSetupMessage = {
      type: MessageType.CLIENT_SETUP,
      supportedVersions: [Version.DRAFT_16],
      parameters: new Map([
        [SetupParameter.MAX_REQUEST_ID, 100],
        [SetupParameter.AUTHORIZATION_TOKEN, authTokenBytes],
      ]),
    };

    const encoded = MessageCodec.encode(message);
    const [decoded] = MessageCodec.decode(encoded);

    const decodedSetup = decoded as ClientSetupMessage;
    const decodedToken = decodedSetup.parameters.get(SetupParameter.AUTHORIZATION_TOKEN);

    // Critical: binary data must NOT be corrupted by TextDecoder
    expect(decodedToken).toBeInstanceOf(Uint8Array);
    expect(decodedToken).toEqual(authTokenBytes);
  });
});

describe('MessageCodecError', () => {
  it('creates error with message', () => {
    const error = new MessageCodecError('Test error');

    expect(error.name).toBe('MessageCodecError');
    expect(error.message).toBe('Test error');
    expect(error.messageType).toBeUndefined();
  });

  it('creates error with message type', () => {
    const error = new MessageCodecError('Invalid message', MessageType.SUBSCRIBE);

    expect(error.name).toBe('MessageCodecError');
    expect(error.message).toBe('Invalid message');
    expect(error.messageType).toBe(MessageType.SUBSCRIBE);
  });
});
