// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import { Draft18MessageCodec } from './draft18-message-codec';
import {
  MessageTypeDraft18,
  Version,
  GroupOrder,
  SubscriptionFilterDraft18,
  type ClientSetupMessageDraft18,
  type ServerSetupMessageDraft18,
  type SubscribeMessageDraft18,
  type SubscribeOkMessageDraft18,
  type PublishMessageDraft18,
  type PublishDoneMessageDraft18,
  type RequestErrorMessageDraft18,
  type RequestOkMessageDraft18,
  type RequestUpdateMessageDraft18,
  type FetchMessageDraft18,
  type FetchOkMessageDraft18,
  type GoAwayMessageDraft18,
  type TrackStatusMessageDraft18,
  type PublishNamespaceMessageDraft18,
  type SubscribeNamespaceMessageDraft18,
  type NamespaceMessageDraft18,
  type NamespaceDoneMessageDraft18,
  type SubscribeTracksMessageDraft18,
  type PublishBlockedMessageDraft18,
} from '../messages/types';

describe('Draft18MessageCodec', () => {
  describe('SETUP', () => {
    it('roundtrips empty SETUP (WebTransport, no options)', () => {
      const message: ClientSetupMessageDraft18 = {
        type: MessageTypeDraft18.CLIENT_SETUP,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded, bytesRead] = Draft18MessageCodec.decode(encoded);

      expect(decoded.type).toBe(MessageTypeDraft18.SERVER_SETUP);
      expect(bytesRead).toBe(encoded.length);
    });

    it('roundtrips SETUP with options', () => {
      const message: ClientSetupMessageDraft18 = {
        type: MessageTypeDraft18.CLIENT_SETUP,
        path: '/moq',
        authority: 'relay.example.com',
        maxAuthTokenCacheSize: 100,
        authToken: new Uint8Array([1, 2, 3, 4]),
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded, bytesRead] = Draft18MessageCodec.decode(encoded);

      const d = decoded as ServerSetupMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.SERVER_SETUP);
      expect(d.path).toBe('/moq');
      expect(d.authority).toBe('relay.example.com');
      expect(d.maxAuthTokenCacheSize).toBe(100);
      expect(bytesRead).toBe(encoded.length);
    });
  });

  describe('SETUP decode', () => {
    it('decodes SETUP with path option', () => {
      const message: ClientSetupMessageDraft18 = {
        type: MessageTypeDraft18.CLIENT_SETUP,
        path: '/test',
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as ServerSetupMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.SERVER_SETUP);
      expect(d.selectedVersion).toBe(Version.DRAFT_18);
      expect(d.path).toBe('/test');
    });
  });

  describe('SUBSCRIBE', () => {
    it('roundtrips basic SUBSCRIBE', () => {
      const message: SubscribeMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE,
        requestId: 1n,
        trackNamespace: ['conference', 'room-123'],
        trackName: 'video',
        forwardState: true,
        filter: SubscriptionFilterDraft18.NEXT_GROUP_START,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as SubscribeMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.SUBSCRIBE);
      expect(d.requestId).toBe(1n);
      expect(d.trackNamespace).toEqual(['conference', 'room-123']);
      expect(d.trackName).toBe('video');
      expect(d.forwardState).toBe(true);
      expect(d.filter).toBe(SubscriptionFilterDraft18.NEXT_GROUP_START);
    });

    it('roundtrips SUBSCRIBE with ABSOLUTE_RANGE filter', () => {
      const message: SubscribeMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE,
        requestId: 42n,
        trackNamespace: ['ns'],
        trackName: 'track',
        forwardState: false,
        filter: SubscriptionFilterDraft18.ABSOLUTE_RANGE,
        startLocation: { group: 10n, object: 5n },
        endGroupDelta: 100n,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as SubscribeMessageDraft18;
      expect(d.filter).toBe(SubscriptionFilterDraft18.ABSOLUTE_RANGE);
      expect(d.startLocation).toEqual({ group: 10n, object: 5n });
      expect(d.endGroupDelta).toBe(100n);
    });
  });

  describe('SUBSCRIBE_OK', () => {
    it('roundtrips SUBSCRIBE_OK', () => {
      const message: SubscribeOkMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE_OK,
        requestId: 1n,
        largestLocation: { group: 100n, object: 50n },
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as SubscribeOkMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.SUBSCRIBE_OK);
      expect(d.requestId).toBe(1n);
      expect(d.largestLocation).toEqual({ group: 100n, object: 50n });
    });
  });

  describe('PUBLISH', () => {
    it('roundtrips PUBLISH', () => {
      const message: PublishMessageDraft18 = {
        type: MessageTypeDraft18.PUBLISH,
        requestId: 5n,
        trackAlias: 12345n,
        trackNamespace: ['pub', 'ns'],
        trackName: 'audio',
        forwardState: true,
        largestLocation: { group: 0n, object: 0n },
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as PublishMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.PUBLISH);
      expect(d.requestId).toBe(5n);
      expect(d.trackAlias).toBe(12345n);
      expect(d.trackNamespace).toEqual(['pub', 'ns']);
      expect(d.trackName).toBe('audio');
      expect(d.forwardState).toBe(true);
    });
  });

  describe('REQUEST_ERROR', () => {
    it('roundtrips REQUEST_ERROR', () => {
      const message: RequestErrorMessageDraft18 = {
        type: MessageTypeDraft18.REQUEST_ERROR,
        requestId: 10n,
        errorCode: 3,
        reasonPhrase: 'Track not found',
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as RequestErrorMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.REQUEST_ERROR);
      expect(d.requestId).toBe(10n);
      expect(d.errorCode).toBe(3);
      expect(d.reasonPhrase).toBe('Track not found');
    });
  });

  describe('REQUEST_OK', () => {
    it('roundtrips REQUEST_OK without expires', () => {
      const message: RequestOkMessageDraft18 = {
        type: MessageTypeDraft18.REQUEST_OK,
        requestId: 7n,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as RequestOkMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.REQUEST_OK);
      expect(d.requestId).toBe(7n);
    });

    it('roundtrips REQUEST_OK with expires', () => {
      const message: RequestOkMessageDraft18 = {
        type: MessageTypeDraft18.REQUEST_OK,
        requestId: 7n,
        expires: 3600n,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as RequestOkMessageDraft18;
      expect(d.expires).toBe(3600n);
    });
  });

  describe('FETCH', () => {
    it('roundtrips FETCH with track name', () => {
      const message: FetchMessageDraft18 = {
        type: MessageTypeDraft18.FETCH,
        requestId: 20n,
        joiningFlag: false,
        trackNamespace: ['fetch', 'ns'],
        trackName: 'history',
        subscriberPriority: 128,
        groupOrder: GroupOrder.ASCENDING,
        startLocation: { group: 0n, object: 0n },
        endLocation: { group: 100n, object: 50n },
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as FetchMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.FETCH);
      expect(d.joiningFlag).toBe(false);
      expect(d.trackNamespace).toEqual(['fetch', 'ns']);
      expect(d.trackName).toBe('history');
      expect(d.startLocation).toEqual({ group: 0n, object: 0n });
      expect(d.endLocation).toEqual({ group: 100n, object: 50n });
    });

    it('roundtrips FETCH with joining flag', () => {
      const message: FetchMessageDraft18 = {
        type: MessageTypeDraft18.FETCH,
        requestId: 21n,
        joiningFlag: true,
        subscribeRequestId: 5n,
        subscriberPriority: 64,
        groupOrder: GroupOrder.DESCENDING,
        startLocation: { group: 50n, object: 0n },
        endLocation: { group: 100n, object: 0n },
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as FetchMessageDraft18;
      expect(d.joiningFlag).toBe(true);
      expect(d.subscribeRequestId).toBe(5n);
      expect(d.trackNamespace).toBeUndefined();
    });
  });

  describe('FETCH_OK', () => {
    it('roundtrips FETCH_OK', () => {
      const message: FetchOkMessageDraft18 = {
        type: MessageTypeDraft18.FETCH_OK,
        requestId: 20n,
        endOfTrack: true,
        endLocation: { group: 100n, object: 50n },
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as FetchOkMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.FETCH_OK);
      expect(d.endOfTrack).toBe(true);
      expect(d.endLocation).toEqual({ group: 100n, object: 50n });
    });
  });

  describe('GOAWAY', () => {
    it('roundtrips GOAWAY without URI', () => {
      const message: GoAwayMessageDraft18 = {
        type: MessageTypeDraft18.GOAWAY,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      expect(decoded.type).toBe(MessageTypeDraft18.GOAWAY);
      expect((decoded as GoAwayMessageDraft18).newSessionUri).toBeUndefined();
    });

    it('roundtrips GOAWAY with URI', () => {
      const message: GoAwayMessageDraft18 = {
        type: MessageTypeDraft18.GOAWAY,
        newSessionUri: 'moqt://new-relay.example.com/moq',
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      expect((decoded as GoAwayMessageDraft18).newSessionUri).toBe('moqt://new-relay.example.com/moq');
    });
  });

  describe('TRACK_STATUS', () => {
    it('roundtrips TRACK_STATUS', () => {
      const message: TrackStatusMessageDraft18 = {
        type: MessageTypeDraft18.TRACK_STATUS,
        requestId: 30n,
        trackNamespace: ['status', 'ns'],
        trackName: 'check',
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as TrackStatusMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.TRACK_STATUS);
      expect(d.requestId).toBe(30n);
      expect(d.trackNamespace).toEqual(['status', 'ns']);
      expect(d.trackName).toBe('check');
    });
  });

  describe('large values', () => {
    it('handles large request IDs', () => {
      const message: SubscribeMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE,
        requestId: 0xFFFFFFFFFFFFFFFFn, // Max uint64
        trackNamespace: ['ns'],
        trackName: 'track',
        forwardState: true,
        filter: SubscriptionFilterDraft18.NEXT_GROUP_START,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      expect((decoded as SubscribeMessageDraft18).requestId).toBe(0xFFFFFFFFFFFFFFFFn);
    });

    it('handles large track aliases', () => {
      const message: PublishMessageDraft18 = {
        type: MessageTypeDraft18.PUBLISH,
        requestId: 1n,
        trackAlias: 0x123456789ABCDEFn,
        trackNamespace: ['ns'],
        trackName: 'track',
        forwardState: true,
        largestLocation: { group: 0n, object: 0n },
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      expect((decoded as PublishMessageDraft18).trackAlias).toBe(0x123456789ABCDEFn);
    });
  });

  describe('unicode', () => {
    it('handles unicode track names', () => {
      const message: SubscribeMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE,
        requestId: 1n,
        trackNamespace: ['会议', '房间-123'],
        trackName: '视频轨道',
        forwardState: true,
        filter: SubscriptionFilterDraft18.NEXT_GROUP_START,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as SubscribeMessageDraft18;
      expect(d.trackNamespace).toEqual(['会议', '房间-123']);
      expect(d.trackName).toBe('视频轨道');
    });
  });

  describe('PUBLISH_DONE', () => {
    it('roundtrips basic PUBLISH_DONE', () => {
      const message: PublishDoneMessageDraft18 = {
        type: MessageTypeDraft18.PUBLISH_DONE,
        requestId: 42n,
        finalLocation: { group: 100n, object: 50n },
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as PublishDoneMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.PUBLISH_DONE);
      expect(d.requestId).toBe(42n);
      expect(d.finalLocation.group).toBe(100n);
      expect(d.finalLocation.object).toBe(50n);
      expect(d.reasonPhrase).toBeUndefined();
    });

    it('roundtrips PUBLISH_DONE with reason', () => {
      const message: PublishDoneMessageDraft18 = {
        type: MessageTypeDraft18.PUBLISH_DONE,
        requestId: 1n,
        finalLocation: { group: 0n, object: 0n },
        reasonPhrase: 'End of stream',
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as PublishDoneMessageDraft18;
      expect(d.reasonPhrase).toBe('End of stream');
    });
  });

  describe('REQUEST_UPDATE', () => {
    it('roundtrips basic REQUEST_UPDATE', () => {
      const message: RequestUpdateMessageDraft18 = {
        type: MessageTypeDraft18.REQUEST_UPDATE,
        requestId: 10n,
        forwardState: true,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as RequestUpdateMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.REQUEST_UPDATE);
      expect(d.requestId).toBe(10n);
      expect(d.forwardState).toBe(true);
      expect(d.parameters).toBeUndefined();
    });

    it('roundtrips REQUEST_UPDATE with parameters', () => {
      const params = new Map<number, Uint8Array>();
      params.set(0x01, new Uint8Array([1, 2, 3]));

      const message: RequestUpdateMessageDraft18 = {
        type: MessageTypeDraft18.REQUEST_UPDATE,
        requestId: 5n,
        forwardState: false,
        parameters: params,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as RequestUpdateMessageDraft18;
      expect(d.forwardState).toBe(false);
      expect(d.parameters).toBeDefined();
      expect(d.parameters!.has(0x01)).toBe(true);
    });
  });

  describe('PUBLISH_NAMESPACE', () => {
    it('roundtrips basic PUBLISH_NAMESPACE', () => {
      const message: PublishNamespaceMessageDraft18 = {
        type: MessageTypeDraft18.PUBLISH_NAMESPACE,
        requestId: 1n,
        trackNamespacePrefix: ['conference', 'room-123'],
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as PublishNamespaceMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.PUBLISH_NAMESPACE);
      expect(d.requestId).toBe(1n);
      expect(d.trackNamespacePrefix).toEqual(['conference', 'room-123']);
    });

    it('roundtrips PUBLISH_NAMESPACE with parameters', () => {
      const params = new Map<number, Uint8Array>();
      params.set(0x02, new Uint8Array([10]));

      const message: PublishNamespaceMessageDraft18 = {
        type: MessageTypeDraft18.PUBLISH_NAMESPACE,
        requestId: 2n,
        trackNamespacePrefix: ['ns'],
        parameters: params,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as PublishNamespaceMessageDraft18;
      expect(d.parameters).toBeDefined();
    });
  });

  describe('SUBSCRIBE_NAMESPACE', () => {
    it('roundtrips basic SUBSCRIBE_NAMESPACE', () => {
      const message: SubscribeNamespaceMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE_NAMESPACE,
        requestId: 3n,
        trackNamespacePrefix: ['media'],
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as SubscribeNamespaceMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.SUBSCRIBE_NAMESPACE);
      expect(d.requestId).toBe(3n);
      expect(d.trackNamespacePrefix).toEqual(['media']);
    });
  });

  describe('NAMESPACE', () => {
    it('roundtrips basic NAMESPACE', () => {
      const message: NamespaceMessageDraft18 = {
        type: MessageTypeDraft18.NAMESPACE,
        trackNamespace: ['conference', 'room-456', 'video'],
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as NamespaceMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.NAMESPACE);
      expect(d.trackNamespace).toEqual(['conference', 'room-456', 'video']);
    });

    it('roundtrips NAMESPACE with parameters', () => {
      const params = new Map<number, Uint8Array>();
      params.set(0x00, new Uint8Array([5]));

      const message: NamespaceMessageDraft18 = {
        type: MessageTypeDraft18.NAMESPACE,
        trackNamespace: ['ns'],
        trackNamespaceParameters: params,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as NamespaceMessageDraft18;
      expect(d.trackNamespaceParameters).toBeDefined();
    });
  });

  describe('NAMESPACE_DONE', () => {
    it('roundtrips NAMESPACE_DONE', () => {
      const message: NamespaceDoneMessageDraft18 = {
        type: MessageTypeDraft18.NAMESPACE_DONE,
        finalNamespace: ['conference', 'room-789'],
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as NamespaceDoneMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.NAMESPACE_DONE);
      expect(d.finalNamespace).toEqual(['conference', 'room-789']);
    });
  });

  describe('SUBSCRIBE_TRACKS', () => {
    it('roundtrips basic SUBSCRIBE_TRACKS', () => {
      const message: SubscribeTracksMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE_TRACKS,
        requestId: 5n,
        trackNamespacePrefix: ['media', 'video'],
        forwardState: true,
        filter: SubscriptionFilterDraft18.NEXT_GROUP_START,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as SubscribeTracksMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.SUBSCRIBE_TRACKS);
      expect(d.requestId).toBe(5n);
      expect(d.trackNamespacePrefix).toEqual(['media', 'video']);
      expect(d.forwardState).toBe(true);
      expect(d.filter).toBe(SubscriptionFilterDraft18.NEXT_GROUP_START);
    });

    it('roundtrips SUBSCRIBE_TRACKS with pattern and range filter', () => {
      const message: SubscribeTracksMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE_TRACKS,
        requestId: 6n,
        trackNamespacePrefix: ['conference'],
        trackNamePattern: 'video-*',
        forwardState: false,
        filter: SubscriptionFilterDraft18.ABSOLUTE_RANGE,
        startLocation: { group: 10n, object: 0n },
        endGroupDelta: 5n,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as SubscribeTracksMessageDraft18;
      expect(d.trackNamePattern).toBe('video-*');
      expect(d.filter).toBe(SubscriptionFilterDraft18.ABSOLUTE_RANGE);
      expect(d.startLocation?.group).toBe(10n);
      expect(d.endGroupDelta).toBe(5n);
    });
  });

  describe('PUBLISH_BLOCKED', () => {
    it('roundtrips PUBLISH_BLOCKED', () => {
      const message: PublishBlockedMessageDraft18 = {
        type: MessageTypeDraft18.PUBLISH_BLOCKED,
        trackAlias: 999n,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as PublishBlockedMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.PUBLISH_BLOCKED);
      expect(d.trackAlias).toBe(999n);
    });
  });
});
