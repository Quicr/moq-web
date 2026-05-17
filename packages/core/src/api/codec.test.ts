// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import { IS_DRAFT_18, IS_DRAFT_16 } from '../version/constants.js';
import {
  capabilities,
  currentVersion,
  subscribeRequestToWire,
  subscribeResponseFromWire,
  publishRequestToWire,
  fetchRequestToWire,
  fetchResponseFromWire,
  subscribeNamespaceRequestToWire,
  publishNamespaceRequestToWire,
  errorFromWire,
  filterFromWireV14,
  filterFromWireV18,
} from './codec.js';
import {
  Version,
  SubscriptionFilter,
  GroupOrder,
  NamespaceSubscribeMode,
  type SubscribeRequest,
  type PublishRequest,
  type FetchRequest,
  type SubscribeNamespaceRequest,
  type PublishNamespaceRequest,
} from './types.js';

describe('Unified Codec', () => {
  describe('capabilities', () => {
    it('should report correct capabilities for current version', () => {
      expect(capabilities).toBeDefined();
      expect(typeof capabilities.perRequestStreams).toBe('boolean');
      expect(typeof capabilities.subscribeTracks).toBe('boolean');
      expect(typeof capabilities.moqtVarInt).toBe('boolean');
      expect(typeof capabilities.unifiedErrors).toBe('boolean');

      if (IS_DRAFT_18) {
        expect(capabilities.perRequestStreams).toBe(true);
        expect(capabilities.subscribeTracks).toBe(true);
        expect(capabilities.moqtVarInt).toBe(true);
      } else {
        expect(capabilities.perRequestStreams).toBe(false);
        expect(capabilities.subscribeTracks).toBe(false);
        expect(capabilities.moqtVarInt).toBe(false);
      }

      if (IS_DRAFT_16 || IS_DRAFT_18) {
        expect(capabilities.unifiedErrors).toBe(true);
      }
    });

    it('should report correct current version', () => {
      if (IS_DRAFT_18) {
        expect(currentVersion).toBe(Version.DRAFT_18);
      } else if (IS_DRAFT_16) {
        expect(currentVersion).toBe(Version.DRAFT_16);
      } else {
        expect(currentVersion).toBe(Version.DRAFT_14);
      }
    });
  });

  describe('filter conversions', () => {
    it('should convert filters from v14 wire format', () => {
      expect(filterFromWireV14(0x01)).toBe(SubscriptionFilter.LATEST_GROUP);
      expect(filterFromWireV14(0x02)).toBe(SubscriptionFilter.LATEST_OBJECT);
      expect(filterFromWireV14(0x03)).toBe(SubscriptionFilter.ABSOLUTE_START);
      expect(filterFromWireV14(0x04)).toBe(SubscriptionFilter.ABSOLUTE_RANGE);
      expect(filterFromWireV14(0xff)).toBe(SubscriptionFilter.LATEST_GROUP); // Unknown defaults
    });

    it('should convert filters from v18 wire format', () => {
      expect(filterFromWireV18(0x01)).toBe(SubscriptionFilter.LATEST_GROUP);
      expect(filterFromWireV18(0x02)).toBe(SubscriptionFilter.LATEST_OBJECT);
      expect(filterFromWireV18(0x03)).toBe(SubscriptionFilter.ABSOLUTE_START);
      expect(filterFromWireV18(0x04)).toBe(SubscriptionFilter.ABSOLUTE_RANGE);
      expect(filterFromWireV18(0xff)).toBe(SubscriptionFilter.LATEST_GROUP); // Unknown defaults
    });
  });

  describe('subscribeRequestToWire', () => {
    it('should convert basic subscribe request', () => {
      const req: SubscribeRequest = {
        trackNamespace: ['conference', 'room-1'],
        trackName: 'video',
        filter: SubscriptionFilter.LATEST_GROUP,
      };

      const wire = subscribeRequestToWire(req, 1n);
      expect(wire).toBeDefined();
      expect(wire.type).toBe(0x03); // SUBSCRIBE type in both versions

      if (IS_DRAFT_18) {
        expect((wire as any).requestId).toBe(1n);
        expect((wire as any).forwardState).toBe(true);
      } else {
        expect((wire as any).requestId).toBe(1);
        expect((wire as any).trackAlias).toBe(0);
      }
    });

    it('should convert subscribe request with start location', () => {
      const req: SubscribeRequest = {
        trackNamespace: ['ns'],
        trackName: 'track',
        filter: SubscriptionFilter.ABSOLUTE_START,
        startLocation: { group: 10n, object: 5n },
      };

      const wire = subscribeRequestToWire(req, 2n);

      if (IS_DRAFT_18) {
        expect((wire as any).startLocation).toEqual({ group: 10n, object: 5n });
      } else {
        expect((wire as any).startGroup).toBe(10);
        expect((wire as any).startObject).toBe(5);
      }
    });

    it('should convert subscribe request with priority and order', () => {
      const req: SubscribeRequest = {
        trackNamespace: ['ns'],
        trackName: 'track',
        filter: SubscriptionFilter.LATEST_OBJECT,
        subscriberPriority: 200,
        groupOrder: GroupOrder.DESCENDING,
      };

      const wire = subscribeRequestToWire(req, 3n);

      if (!IS_DRAFT_18) {
        expect((wire as any).subscriberPriority).toBe(200);
        expect((wire as any).groupOrder).toBe(2); // DESCENDING
      }
    });

    it('should convert subscribe request with end group', () => {
      const req: SubscribeRequest = {
        trackNamespace: ['ns'],
        trackName: 'track',
        filter: SubscriptionFilter.ABSOLUTE_RANGE,
        startLocation: { group: 1n, object: 0n },
        endGroup: 10n,
      };

      const wire = subscribeRequestToWire(req, 4n);

      if (IS_DRAFT_18) {
        expect((wire as any).endGroupDelta).toBe(10n);
      } else {
        expect((wire as any).endGroup).toBe(10);
      }
    });
  });

  describe('subscribeResponseFromWire', () => {
    it('should convert v14 subscribe ok response', () => {
      const wireV14 = {
        type: 0x04,
        requestId: 1,
        trackAlias: 42,
        expires: 3600,
        groupOrder: 1,
        contentExists: 1,
        largestGroupId: 100,
        largestObjectId: 50,
      };

      const resp = subscribeResponseFromWire(wireV14 as any);
      expect(resp.requestId).toBe(1n);
      expect(resp.contentExists).toBe(true);
      expect(resp.groupOrder).toBe(GroupOrder.ASCENDING);
      expect(resp.expires).toBe(3600n);
      expect(resp.largestLocation).toEqual({ group: 100n, object: 50n });
    });

    it('should convert v14 subscribe ok with no content', () => {
      const wireV14 = {
        type: 0x04,
        requestId: 2,
        trackAlias: 43,
        expires: 0,
        groupOrder: 0,
        contentExists: 0,
      };

      const resp = subscribeResponseFromWire(wireV14 as any);
      expect(resp.requestId).toBe(2n);
      expect(resp.contentExists).toBe(false);
      expect(resp.largestLocation).toBeUndefined();
    });

    it('should convert v18 subscribe ok response', () => {
      const wireV18 = {
        type: 0x04,
        requestId: 5n,
        largestLocation: { group: 200n, object: 100n },
        trackProperties: new Map([[1, new Uint8Array([1, 2, 3])]]),
      };

      const resp = subscribeResponseFromWire(wireV18 as any);
      expect(resp.requestId).toBe(5n);
      expect(resp.contentExists).toBe(true);
      expect(resp.largestLocation).toEqual({ group: 200n, object: 100n });
      expect(resp.trackProperties).toEqual(wireV18.trackProperties);
    });
  });

  describe('publishRequestToWire', () => {
    it('should convert publish request', () => {
      const req: PublishRequest = {
        trackNamespace: ['pub', 'ns'],
        trackName: 'video',
        groupOrder: GroupOrder.ASCENDING,
      };

      const wire = publishRequestToWire(req, 10n, 99n);
      expect(wire).toBeDefined();

      if (IS_DRAFT_18) {
        expect(wire.type).toBe(0x05);
        expect((wire as any).requestId).toBe(10n);
        expect((wire as any).trackAlias).toBe(99n);
      } else {
        expect(wire.type).toBe(0x1d);
        expect((wire as any).requestId).toBe(10);
        expect((wire as any).trackAlias).toBe(99);
      }
    });
  });

  describe('fetchRequestToWire', () => {
    it('should convert fetch request', () => {
      const req: FetchRequest = {
        trackNamespace: ['fetch', 'ns'],
        trackName: 'audio',
        subscriberPriority: 100,
        groupOrder: GroupOrder.DESCENDING,
        startLocation: { group: 5n, object: 0n },
        endLocation: { group: 10n, object: 999n },
      };

      const wire = fetchRequestToWire(req, 20n);
      expect(wire).toBeDefined();

      if (IS_DRAFT_18) {
        expect(wire.type).toBe(0x0d);
        expect((wire as any).startLocation).toEqual({ group: 5n, object: 0n });
        expect((wire as any).endLocation).toEqual({ group: 10n, object: 999n });
      } else {
        expect(wire.type).toBe(0x16);
        expect((wire as any).startGroup).toBe(5);
        expect((wire as any).endGroup).toBe(10);
      }
    });
  });

  describe('fetchResponseFromWire', () => {
    it('should convert v14 fetch ok response', () => {
      const wireV14 = {
        type: 0x18,
        requestId: 20,
        groupOrder: 2,
        largestGroupId: 50,
        largestObjectId: 25,
      };

      const resp = fetchResponseFromWire(wireV14 as any, 20n);
      expect(resp.requestId).toBe(20n);
      expect(resp.endOfTrack).toBe(false);
      expect(resp.endLocation).toEqual({ group: 50n, object: 25n });
    });

    it('should convert v18 fetch ok response', () => {
      const wireV18 = {
        type: 0x0e,
        requestId: 30n,
        endOfTrack: true,
        endLocation: { group: 100n, object: 50n },
        trackProperties: new Map(),
      };

      const resp = fetchResponseFromWire(wireV18 as any, 30n);
      expect(resp.requestId).toBe(30n);
      expect(resp.endOfTrack).toBe(true);
      expect(resp.endLocation).toEqual({ group: 100n, object: 50n });
    });
  });

  describe('subscribeNamespaceRequestToWire', () => {
    it('should convert discover mode request', () => {
      const req: SubscribeNamespaceRequest = {
        trackNamespacePrefix: ['conference'],
        mode: NamespaceSubscribeMode.DISCOVER,
      };

      const { namespaceWire, tracksWire } = subscribeNamespaceRequestToWire(req, 100n);

      expect(namespaceWire).toBeDefined();
      expect(namespaceWire.type).toBe(0x11);

      if (IS_DRAFT_18) {
        // v18: DISCOVER mode only sends SUBSCRIBE_NAMESPACE
        expect(tracksWire).toBeUndefined();
      } else {
        // v14/16: subscribeOptions should be NAMESPACE (1)
        expect((namespaceWire as any).subscribeOptions).toBe(1);
      }
    });

    it('should convert subscribe mode request', () => {
      const req: SubscribeNamespaceRequest = {
        trackNamespacePrefix: ['conference'],
        mode: NamespaceSubscribeMode.SUBSCRIBE,
        filter: SubscriptionFilter.LATEST_GROUP,
      };

      const { namespaceWire, tracksWire } = subscribeNamespaceRequestToWire(req, 100n);

      if (IS_DRAFT_18) {
        // v18: SUBSCRIBE mode sends both SUBSCRIBE_NAMESPACE and SUBSCRIBE_TRACKS
        expect(namespaceWire).toBeDefined();
        expect(tracksWire).toBeDefined();
        expect(tracksWire!.type).toBe(0x14);
      } else {
        // v14/16: subscribeOptions should be PUBLISH (0)
        expect((namespaceWire as any).subscribeOptions).toBe(0);
      }
    });

    it('should convert both mode request', () => {
      const req: SubscribeNamespaceRequest = {
        trackNamespacePrefix: ['conference', 'room-1'],
        mode: NamespaceSubscribeMode.BOTH,
        filter: SubscriptionFilter.ABSOLUTE_START,
        startLocation: { group: 1n, object: 0n },
      };

      const { namespaceWire, tracksWire } = subscribeNamespaceRequestToWire(req, 200n);

      if (IS_DRAFT_18) {
        // v18: BOTH mode sends both messages
        expect(namespaceWire).toBeDefined();
        expect(tracksWire).toBeDefined();
        expect(tracksWire!.requestId).toBe(201n); // Next request ID
        expect((tracksWire as any).startLocation).toEqual({ group: 1n, object: 0n });
      } else {
        // v14/16: subscribeOptions should be BOTH (2)
        expect((namespaceWire as any).subscribeOptions).toBe(2);
      }
    });

    it('should include track name pattern in v18', () => {
      const req: SubscribeNamespaceRequest = {
        trackNamespacePrefix: ['conference'],
        mode: NamespaceSubscribeMode.SUBSCRIBE,
        trackNamePattern: 'video-*',
        filter: SubscriptionFilter.LATEST_OBJECT,
      };

      const { tracksWire } = subscribeNamespaceRequestToWire(req, 300n);

      if (IS_DRAFT_18) {
        expect(tracksWire).toBeDefined();
        expect((tracksWire as any).trackNamePattern).toBe('video-*');
      }
    });
  });

  describe('publishNamespaceRequestToWire', () => {
    it('should convert publish namespace request', () => {
      const req: PublishNamespaceRequest = {
        trackNamespacePrefix: ['publisher', 'media'],
        parameters: new Map([[1, new Uint8Array([0x01])]]),
      };

      const wire = publishNamespaceRequestToWire(req, 400n);
      expect(wire).toBeDefined();
      expect(wire.type).toBe(IS_DRAFT_18 ? 0x10 : 0x06);

      if (IS_DRAFT_18) {
        expect((wire as any).trackNamespacePrefix).toEqual(['publisher', 'media']);
      } else {
        expect((wire as any).namespace).toEqual(['publisher', 'media']);
      }
    });
  });

  describe('errorFromWire', () => {
    it('should convert v14 subscribe error', () => {
      const wireV14 = {
        type: 0x05,
        requestId: 50,
        errorCode: 1,
        reasonPhrase: 'Track not found',
        trackAlias: 0,
      };

      const err = errorFromWire(wireV14 as any);
      expect(err.requestId).toBe(50n);
      expect(err.errorCode).toBe(1);
      expect(err.reasonPhrase).toBe('Track not found');
    });

    it('should convert v18 request error', () => {
      const wireV18 = {
        type: 0x08,
        requestId: 60n,
        errorCode: 2n,
        reasonPhrase: 'Unauthorized',
      };

      const err = errorFromWire(wireV18 as any);
      expect(err.requestId).toBe(60n);
      expect(err.errorCode).toBe(2);
      expect(err.reasonPhrase).toBe('Unauthorized');
    });
  });
});
