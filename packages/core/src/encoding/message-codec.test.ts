// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MessageCodec and ObjectCodec Tests
 */

import { describe, it, expect } from 'vitest';
import { MessageCodec, ObjectCodec, MessageCodecError } from './message-codec';
import { IS_DRAFT_16 } from '../version/constants';
import {
  MessageType,
  DataStreamType,
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
          maxRequestId: 12345,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.MAX_REQUEST_ID);
        expect((decoded as MaxRequestIdMessage).maxRequestId).toBe(12345);
      });

      it('roundtrips REQUESTS_BLOCKED message', () => {
        const message: RequestsBlockedMessage = {
          type: MessageType.REQUESTS_BLOCKED,
          blockedRequestId: 999,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.REQUESTS_BLOCKED);
        expect((decoded as RequestsBlockedMessage).blockedRequestId).toBe(999);
      });
    });

    describe('Subscribe Messages', () => {
      it('roundtrips SUBSCRIBE message with LATEST_GROUP filter', () => {
        const message: SubscribeMessage = {
          type: MessageType.SUBSCRIBE,
          requestId: 1,
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
        expect(decodedSub.requestId).toBe(1);
        expect(decodedSub.fullTrackName.namespace).toEqual(['conference', 'room-1']);
        expect(decodedSub.fullTrackName.trackName).toBe('video');
        expect(decodedSub.subscriberPriority).toBe(128);
        expect(decodedSub.groupOrder).toBe(GroupOrder.ASCENDING);
        expect(decodedSub.filterType).toBe(FilterType.LATEST_GROUP);
      });

      it.skipIf(IS_DRAFT_16)('roundtrips SUBSCRIBE message with ABSOLUTE_START filter', () => {
        const message: SubscribeMessage = {
          type: MessageType.SUBSCRIBE,
          requestId: 2,
          fullTrackName: {
            namespace: ['media'],
            trackName: 'audio',
          },
          subscriberPriority: 64,
          groupOrder: GroupOrder.DESCENDING,
          filterType: FilterType.ABSOLUTE_START,
          startGroup: 10,
          startObject: 5,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.SUBSCRIBE);
        const decodedSub = decoded as SubscribeMessage;
        expect(decodedSub.filterType).toBe(FilterType.ABSOLUTE_START);
        expect(decodedSub.startGroup).toBe(10);
        expect(decodedSub.startObject).toBe(5);
      });

      it.skipIf(IS_DRAFT_16)('roundtrips SUBSCRIBE message with ABSOLUTE_RANGE filter', () => {
        const message: SubscribeMessage = {
          type: MessageType.SUBSCRIBE,
          requestId: 3,
          fullTrackName: {
            namespace: ['test'],
            trackName: 'data',
          },
          subscriberPriority: 255,
          groupOrder: GroupOrder.ASCENDING,
          filterType: FilterType.ABSOLUTE_RANGE,
          startGroup: 0,
          startObject: 0,
          endGroup: 100,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.SUBSCRIBE);
        const decodedSub = decoded as SubscribeMessage;
        expect(decodedSub.filterType).toBe(FilterType.ABSOLUTE_RANGE);
        expect(decodedSub.startGroup).toBe(0);
        expect(decodedSub.startObject).toBe(0);
        expect(decodedSub.endGroup).toBe(100);
      });

      it('roundtrips SUBSCRIBE_UPDATE message', () => {
        const message: SubscribeUpdateMessage = {
          type: MessageType.SUBSCRIBE_UPDATE,
          requestId: 10,
          subscriptionRequestId: 1,
          startLocation: { groupId: 5, objectId: 10 },
          endGroup: 20,
          subscriberPriority: 200,
          forward: 1,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.SUBSCRIBE_UPDATE);
        const decodedUpdate = decoded as SubscribeUpdateMessage;
        expect(decodedUpdate.requestId).toBe(10);
        expect(decodedUpdate.subscriptionRequestId).toBe(1);
        expect(decodedUpdate.startLocation).toEqual({ groupId: 5, objectId: 10 });
        expect(decodedUpdate.endGroup).toBe(20);
        expect(decodedUpdate.subscriberPriority).toBe(200);
        expect(decodedUpdate.forward).toBe(1);
      });

      it.skipIf(IS_DRAFT_16)('roundtrips SUBSCRIBE_OK message without content', () => {
        const message: SubscribeOkMessage = {
          type: MessageType.SUBSCRIBE_OK,
          requestId: 1,
          trackAlias: 12345,
          expires: 3600,
          groupOrder: GroupOrder.ASCENDING,
          contentExists: false,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.SUBSCRIBE_OK);
        const decodedOk = decoded as SubscribeOkMessage;
        expect(decodedOk.requestId).toBe(1);
        expect(BigInt(decodedOk.trackAlias)).toBe(BigInt(12345));
        expect(decodedOk.expires).toBe(3600);
        expect(decodedOk.groupOrder).toBe(GroupOrder.ASCENDING);
        expect(decodedOk.contentExists).toBe(false);
      });

      it.skipIf(IS_DRAFT_16)('roundtrips SUBSCRIBE_OK message with content', () => {
        const message: SubscribeOkMessage = {
          type: MessageType.SUBSCRIBE_OK,
          requestId: 2,
          trackAlias: BigInt('4611686018427387903'), // Max valid 62-bit varint value
          expires: 0,
          groupOrder: GroupOrder.DESCENDING,
          contentExists: true,
          largestGroupId: 100,
          largestObjectId: 50,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.SUBSCRIBE_OK);
        const decodedOk = decoded as SubscribeOkMessage;
        expect(decodedOk.trackAlias).toBe(BigInt('4611686018427387903'));
        expect(decodedOk.contentExists).toBe(true);
        expect(decodedOk.largestGroupId).toBe(100);
        expect(decodedOk.largestObjectId).toBe(50);
      });

      it('roundtrips SUBSCRIBE_ERROR message', () => {
        const message: SubscribeErrorMessage = {
          type: MessageType.SUBSCRIBE_ERROR,
          requestId: 1,
          errorCode: RequestErrorCode.TRACK_NOT_FOUND,
          reasonPhrase: 'Track does not exist',
          trackAlias: 0,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.SUBSCRIBE_ERROR);
        const decodedError = decoded as SubscribeErrorMessage;
        expect(decodedError.requestId).toBe(1);
        expect(decodedError.errorCode).toBe(RequestErrorCode.TRACK_NOT_FOUND);
        expect(decodedError.reasonPhrase).toBe('Track does not exist');
      });

      it('roundtrips UNSUBSCRIBE message', () => {
        const message: UnsubscribeMessage = {
          type: MessageType.UNSUBSCRIBE,
          requestId: 5,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.UNSUBSCRIBE);
        expect((decoded as UnsubscribeMessage).requestId).toBe(5);
      });
    });

    describe('Publish Messages', () => {
      it('roundtrips PUBLISH message without content', () => {
        const message: PublishMessage = {
          type: MessageType.PUBLISH,
          requestId: 1,
          fullTrackName: {
            namespace: ['conference', 'room-1'],
            trackName: 'video',
          },
          trackAlias: 100,
          groupOrder: GroupOrder.ASCENDING,
          contentExists: false,
          forward: 1,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.PUBLISH);
        const decodedPub = decoded as PublishMessage;
        expect(decodedPub.requestId).toBe(1);
        expect(decodedPub.fullTrackName.namespace).toEqual(['conference', 'room-1']);
        expect(decodedPub.fullTrackName.trackName).toBe('video');
        expect(decodedPub.trackAlias).toBe(100);
        expect(decodedPub.groupOrder).toBe(GroupOrder.ASCENDING);
        expect(decodedPub.contentExists).toBe(false);
      });

      it('roundtrips PUBLISH message with content', () => {
        const message: PublishMessage = {
          type: MessageType.PUBLISH,
          requestId: 2,
          fullTrackName: {
            namespace: ['media'],
            trackName: 'audio',
          },
          trackAlias: 200,
          groupOrder: GroupOrder.DESCENDING,
          contentExists: true,
          largestLocation: { groupId: 50, objectId: 25 },
          forward: 0,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.PUBLISH);
        const decodedPub = decoded as PublishMessage;
        expect(decodedPub.contentExists).toBe(true);
        expect(decodedPub.largestLocation).toEqual({ groupId: 50, objectId: 25 });
      });

      it('roundtrips PUBLISH_OK message', () => {
        const message: PublishOkMessage = {
          type: MessageType.PUBLISH_OK,
          requestId: 1,
          forward: 1,
          subscriberPriority: 128,
          groupOrder: GroupOrder.ASCENDING,
          filterType: FilterType.LATEST_GROUP,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.PUBLISH_OK);
        const decodedOk = decoded as PublishOkMessage;
        expect(decodedOk.requestId).toBe(1);
        expect(decodedOk.forward).toBe(1);
        expect(decodedOk.subscriberPriority).toBe(128);
        expect(decodedOk.groupOrder).toBe(GroupOrder.ASCENDING);
        expect(decodedOk.filterType).toBe(FilterType.LATEST_GROUP);
      });

      it('roundtrips PUBLISH_ERROR message', () => {
        const message: PublishErrorMessage = {
          type: MessageType.PUBLISH_ERROR,
          requestId: 1,
          errorCode: RequestErrorCode.UNAUTHORIZED,
          reasonPhrase: 'Not authorized to publish',
          trackAlias: 100,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.PUBLISH_ERROR);
        const decodedError = decoded as PublishErrorMessage;
        expect(decodedError.requestId).toBe(1);
        expect(decodedError.errorCode).toBe(RequestErrorCode.UNAUTHORIZED);
        expect(decodedError.reasonPhrase).toBe('Not authorized to publish');
        expect(decodedError.trackAlias).toBe(100);
      });

      it.skipIf(IS_DRAFT_16)('roundtrips PUBLISH_DONE message without content', () => {
        const message: PublishDoneMessage = {
          type: MessageType.PUBLISH_DONE,
          requestId: 1,
          statusCode: RequestErrorCode.INTERNAL_ERROR,
          reasonPhrase: 'Completed successfully',
          contentExists: false,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.PUBLISH_DONE);
        const decodedDone = decoded as PublishDoneMessage;
        expect(decodedDone.requestId).toBe(1);
        expect(decodedDone.statusCode).toBe(RequestErrorCode.INTERNAL_ERROR);
        expect(decodedDone.reasonPhrase).toBe('Completed successfully');
        expect(decodedDone.contentExists).toBe(false);
      });

      it.skipIf(IS_DRAFT_16)('roundtrips PUBLISH_DONE message with content', () => {
        const message: PublishDoneMessage = {
          type: MessageType.PUBLISH_DONE,
          requestId: 2,
          statusCode: RequestErrorCode.INTERNAL_ERROR,
          reasonPhrase: '',
          contentExists: true,
          finalGroupId: 100,
          finalObjectId: 50,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.PUBLISH_DONE);
        const decodedDone = decoded as PublishDoneMessage;
        expect(decodedDone.contentExists).toBe(true);
        expect(decodedDone.finalGroupId).toBe(100);
        expect(decodedDone.finalObjectId).toBe(50);
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

      it.skipIf(IS_DRAFT_16)('roundtrips PUBLISH_NAMESPACE_OK message', () => {
        const message: PublishNamespaceOkMessage = {
          type: MessageType.PUBLISH_NAMESPACE_OK,
          namespace: ['conference', 'room-1'],
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.PUBLISH_NAMESPACE_OK);
        expect((decoded as PublishNamespaceOkMessage).namespace).toEqual(['conference', 'room-1']);
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

      it.skipIf(IS_DRAFT_16)('roundtrips SUBSCRIBE_NAMESPACE_OK message', () => {
        const message: SubscribeNamespaceOkMessage = {
          type: MessageType.SUBSCRIBE_NAMESPACE_OK,
          namespacePrefix: ['conference'],
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.SUBSCRIBE_NAMESPACE_OK);
        expect((decoded as SubscribeNamespaceOkMessage).namespacePrefix).toEqual(['conference']);
      });

      it.skipIf(IS_DRAFT_16)('roundtrips SUBSCRIBE_NAMESPACE_ERROR message', () => {
        const message: SubscribeNamespaceErrorMessage = {
          type: MessageType.SUBSCRIBE_NAMESPACE_ERROR,
          namespacePrefix: ['media'],
          errorCode: 1,
          reasonPhrase: 'Access denied',
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.SUBSCRIBE_NAMESPACE_ERROR);
        const decodedError = decoded as SubscribeNamespaceErrorMessage;
        expect(decodedError.namespacePrefix).toEqual(['media']);
        expect(decodedError.errorCode).toBe(1);
        expect(decodedError.reasonPhrase).toBe('Access denied');
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
          requestId: 1,
          fullTrackName: {
            namespace: ['conference', 'room-1'],
            trackName: 'video',
          },
          subscriberPriority: 128,
          groupOrder: GroupOrder.ASCENDING,
          startGroup: 0,
          startObject: 0,
          endGroup: 10,
          endObject: 100,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.FETCH);
        const decodedFetch = decoded as FetchMessage;
        expect(decodedFetch.requestId).toBe(1);
        expect(decodedFetch.fullTrackName.namespace).toEqual(['conference', 'room-1']);
        expect(decodedFetch.fullTrackName.trackName).toBe('video');
        expect(decodedFetch.subscriberPriority).toBe(128);
        expect(decodedFetch.groupOrder).toBe(GroupOrder.ASCENDING);
        expect(decodedFetch.startGroup).toBe(0);
        expect(decodedFetch.startObject).toBe(0);
        expect(decodedFetch.endGroup).toBe(10);
        expect(decodedFetch.endObject).toBe(100);
      });

      it('roundtrips FETCH_OK message', () => {
        const message: FetchOkMessage = {
          type: MessageType.FETCH_OK,
          requestId: 1,
          groupOrder: GroupOrder.DESCENDING,
          endOfTrack: true,
          largestGroupId: 50,
          largestObjectId: 25,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.FETCH_OK);
        const decodedOk = decoded as FetchOkMessage;
        expect(decodedOk.requestId).toBe(1);
        expect(decodedOk.groupOrder).toBe(GroupOrder.DESCENDING);
        expect(decodedOk.endOfTrack).toBe(true);
        expect(decodedOk.largestGroupId).toBe(50);
        expect(decodedOk.largestObjectId).toBe(25);
      });

      it('roundtrips FETCH_ERROR message', () => {
        const message: FetchErrorMessage = {
          type: MessageType.FETCH_ERROR,
          requestId: 1,
          errorCode: RequestErrorCode.TRACK_NOT_FOUND,
          reasonPhrase: 'Track not found',
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.FETCH_ERROR);
        const decodedError = decoded as FetchErrorMessage;
        expect(decodedError.requestId).toBe(1);
        expect(decodedError.errorCode).toBe(RequestErrorCode.TRACK_NOT_FOUND);
        expect(decodedError.reasonPhrase).toBe('Track not found');
      });

      it('roundtrips FETCH_CANCEL message', () => {
        const message: FetchCancelMessage = {
          type: MessageType.FETCH_CANCEL,
          requestId: 5,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.FETCH_CANCEL);
        expect((decoded as FetchCancelMessage).requestId).toBe(5);
      });
    });

    describe('Track Status Messages', () => {
      it('roundtrips TRACK_STATUS message', () => {
        const message: TrackStatusMessage = {
          type: MessageType.TRACK_STATUS,
          requestId: 1,
          fullTrackName: {
            namespace: ['conference'],
            trackName: 'video',
          },
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.TRACK_STATUS);
        const decodedStatus = decoded as TrackStatusMessage;
        expect(decodedStatus.requestId).toBe(1);
        expect(decodedStatus.fullTrackName.namespace).toEqual(['conference']);
        expect(decodedStatus.fullTrackName.trackName).toBe('video');
      });

      it('roundtrips TRACK_STATUS_OK message without location', () => {
        const message: TrackStatusOkMessage = {
          type: MessageType.TRACK_STATUS_OK,
          requestId: 1,
          statusCode: TrackStatusCode.NOT_YET_BEGUN,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.TRACK_STATUS_OK);
        const decodedOk = decoded as TrackStatusOkMessage;
        expect(decodedOk.requestId).toBe(1);
        expect(decodedOk.statusCode).toBe(TrackStatusCode.NOT_YET_BEGUN);
      });

      it('roundtrips TRACK_STATUS_OK message with location (IN_PROGRESS)', () => {
        const message: TrackStatusOkMessage = {
          type: MessageType.TRACK_STATUS_OK,
          requestId: 2,
          statusCode: TrackStatusCode.IN_PROGRESS,
          lastGroupId: 10,
          lastObjectId: 5,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.TRACK_STATUS_OK);
        const decodedOk = decoded as TrackStatusOkMessage;
        expect(decodedOk.statusCode).toBe(TrackStatusCode.IN_PROGRESS);
        expect(decodedOk.lastGroupId).toBe(10);
        expect(decodedOk.lastObjectId).toBe(5);
      });

      it('roundtrips TRACK_STATUS_OK message with location (FINISHED)', () => {
        const message: TrackStatusOkMessage = {
          type: MessageType.TRACK_STATUS_OK,
          requestId: 3,
          statusCode: TrackStatusCode.FINISHED,
          lastGroupId: 100,
          lastObjectId: 50,
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.TRACK_STATUS_OK);
        const decodedOk = decoded as TrackStatusOkMessage;
        expect(decodedOk.statusCode).toBe(TrackStatusCode.FINISHED);
        expect(decodedOk.lastGroupId).toBe(100);
        expect(decodedOk.lastObjectId).toBe(50);
      });

      it('roundtrips TRACK_STATUS_ERROR message', () => {
        const message: TrackStatusErrorMessage = {
          type: MessageType.TRACK_STATUS_ERROR,
          requestId: 1,
          errorCode: RequestErrorCode.TRACK_NOT_FOUND,
          reasonPhrase: 'Track does not exist',
        };

        const encoded = MessageCodec.encode(message);
        const [decoded] = MessageCodec.decode(encoded);

        expect(decoded.type).toBe(MessageType.TRACK_STATUS_ERROR);
        const decodedError = decoded as TrackStatusErrorMessage;
        expect(decodedError.requestId).toBe(1);
        expect(decodedError.errorCode).toBe(RequestErrorCode.TRACK_NOT_FOUND);
        expect(decodedError.reasonPhrase).toBe('Track does not exist');
      });
    });
  });

  describe('decode returns bytes consumed', () => {
    it('returns correct bytes consumed for simple message', () => {
      const message: UnsubscribeMessage = {
        type: MessageType.UNSUBSCRIBE,
        requestId: 42,
      };

      const encoded = MessageCodec.encode(message);
      const [, bytesConsumed] = MessageCodec.decode(encoded);

      expect(bytesConsumed).toBe(encoded.length);
    });

    it('decodes at specified offset', () => {
      const message: MaxRequestIdMessage = {
        type: MessageType.MAX_REQUEST_ID,
        maxRequestId: 100,
      };

      const encoded = MessageCodec.encode(message);
      // Prepend some bytes
      const withPrefix = new Uint8Array(5 + encoded.length);
      withPrefix.set([0xff, 0xfe, 0xfd, 0xfc, 0xfb]);
      withPrefix.set(encoded, 5);

      const [decoded, bytesConsumed] = MessageCodec.decode(withPrefix, 5);

      expect(decoded.type).toBe(MessageType.MAX_REQUEST_ID);
      expect((decoded as MaxRequestIdMessage).maxRequestId).toBe(100);
      expect(bytesConsumed).toBe(encoded.length);
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

    it.skipIf(IS_DRAFT_16)('roundtrips datagram header with large 62-bit track alias', () => {
      const largeAlias = BigInt('4611686018427387903'); // Close to max 62-bit value
      const header: ObjectHeader = {
        trackAlias: largeAlias,
        groupId: 1000000,
        subgroupId: 100,
        objectId: 50000,
        publisherPriority: 255,
        objectStatus: ObjectStatus.END_OF_GROUP,
      };

      const encoded = ObjectCodec.encodeDatagramHeader(header);
      const [decoded] = ObjectCodec.decodeDatagramHeader(encoded);

      expect(decoded.trackAlias).toBe(largeAlias);
      expect(decoded.groupId).toBe(1000000);
      expect(decoded.subgroupId).toBe(100);
      expect(decoded.objectId).toBe(50000);
      expect(decoded.publisherPriority).toBe(255);
      expect(decoded.objectStatus).toBe(ObjectStatus.END_OF_GROUP);
    });

    it('throws error for wrong stream type', () => {
      // Create buffer with wrong stream type (0x04 = SUBGROUP_HEADER instead of 0x01)
      const invalidBuffer = new Uint8Array([0x04, 0x01, 0x00, 0x00, 0x00, 0x80, 0x00]);

      expect(() => ObjectCodec.decodeDatagramHeader(invalidBuffer)).toThrow(MessageCodecError);
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

      const encoded = ObjectCodec.encodeSubgroupHeader(header);
      const [decoded, bytesConsumed] = ObjectCodec.decodeSubgroupHeader(encoded);

      expect(decoded.trackAlias).toBe(BigInt(100));
      expect(decoded.groupId).toBe(5);
      expect(decoded.subgroupId).toBe(0);
      expect(decoded.publisherPriority).toBe(200);
      expect(bytesConsumed).toBe(encoded.length);
    });

    it('decodes standard MOQT subgroup header (0x04)', () => {
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

    it.skipIf(IS_DRAFT_16)('throws error for invalid stream type', () => {
      // Create buffer with invalid stream type
      const invalidBuffer = new Uint8Array([0x99, 0x01, 0x00, 0x00]);

      expect(() => ObjectCodec.decodeSubgroupHeader(invalidBuffer)).toThrow(MessageCodecError);
    });
  });

  describe('fetch header encoding/decoding', () => {
    it('roundtrips fetch header', () => {
      const header: FetchHeader = {
        requestId: 12345,
      };

      const encoded = ObjectCodec.encodeFetchHeader(header);
      const [decoded, bytesConsumed] = ObjectCodec.decodeFetchHeader(encoded);

      expect(decoded.requestId).toBe(12345);
      expect(bytesConsumed).toBe(encoded.length);
    });

    it('throws error for wrong stream type', () => {
      // Create buffer with wrong stream type
      const invalidBuffer = new Uint8Array([0x01, 0x00, 0x01]); // OBJECT_DATAGRAM type

      expect(() => ObjectCodec.decodeFetchHeader(invalidBuffer)).toThrow(MessageCodecError);
    });
  });

  describe('stream object encoding/decoding', () => {
    it.skipIf(IS_DRAFT_16)('roundtrips stream object with payload', () => {
      const payload = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
      const encoded = ObjectCodec.encodeStreamObject(42, payload, ObjectStatus.NORMAL);

      const [objectId, decodedPayload, status, bytesConsumed] = ObjectCodec.decodeStreamObject(
        encoded,
        0,
        true, // hasExtensions
        false // useRemainingAsPayload
      );

      expect(objectId).toBe(42);
      expect(Array.from(decodedPayload)).toEqual([0xDE, 0xAD, 0xBE, 0xEF]);
      expect(status).toBe(ObjectStatus.NORMAL);
      expect(bytesConsumed).toBe(encoded.length);
    });

    it.skipIf(IS_DRAFT_16)('roundtrips stream object with empty payload and status', () => {
      const encoded = ObjectCodec.encodeStreamObject(0, new Uint8Array(0), ObjectStatus.END_OF_TRACK);

      const [objectId, decodedPayload, status] = ObjectCodec.decodeStreamObject(
        encoded,
        0,
        true,
        false
      );

      expect(objectId).toBe(0);
      expect(decodedPayload.length).toBe(0);
      expect(status).toBe(ObjectStatus.END_OF_TRACK);
    });

    it.skipIf(IS_DRAFT_16)('decodes stream object at offset', () => {
      const payload = new Uint8Array([0x01, 0x02, 0x03]);
      const encoded = ObjectCodec.encodeStreamObject(10, payload);

      // Prepend some bytes
      const withPrefix = new Uint8Array(3 + encoded.length);
      withPrefix.set([0xff, 0xfe, 0xfd]);
      withPrefix.set(encoded, 3);

      const [objectId, decodedPayload, , bytesConsumed] = ObjectCodec.decodeStreamObject(
        withPrefix,
        3,
        true,
        false
      );

      expect(objectId).toBe(10);
      expect(Array.from(decodedPayload)).toEqual([0x01, 0x02, 0x03]);
      expect(bytesConsumed).toBe(encoded.length);
    });
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
