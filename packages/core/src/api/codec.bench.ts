// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { bench, describe } from 'vitest';
import {
  subscribeRequestToWire,
  subscribeResponseFromWire,
  publishRequestToWire,
  fetchRequestToWire,
  subscribeNamespaceRequestToWire,
  errorFromWire,
} from './codec.js';
import { SubscriptionFilter, GroupOrder, NamespaceSubscribeMode } from './types.js';
import { IS_DRAFT_18 } from '../version/constants.js';

describe('Unified Codec Benchmarks', () => {
  describe('subscribeRequestToWire', () => {
    const simpleRequest = {
      trackNamespace: ['conference', 'room-1'],
      trackName: 'video',
      filter: SubscriptionFilter.LATEST_GROUP,
    };

    const complexRequest = {
      trackNamespace: ['conference', 'room-1', 'participant-42', 'media'],
      trackName: 'video-h264-1080p',
      filter: SubscriptionFilter.ABSOLUTE_RANGE,
      startLocation: { group: 100n, object: 50n },
      endGroup: 200n,
      subscriberPriority: 200,
      groupOrder: GroupOrder.DESCENDING,
      parameters: new Map([
        [1, new Uint8Array([1, 2, 3, 4, 5])],
        [2, new Uint8Array([10, 20, 30])],
      ]),
    };

    bench('simple request', () => {
      subscribeRequestToWire(simpleRequest, 1n);
    });

    bench('complex request with all fields', () => {
      subscribeRequestToWire(complexRequest, 1000n);
    });
  });

  describe('subscribeResponseFromWire', () => {
    const v14Response = {
      type: 0x04,
      requestId: 1,
      trackAlias: 42,
      expires: 3600,
      groupOrder: 1,
      contentExists: 1,
      largestGroupId: 100,
      largestObjectId: 50,
    };

    const v18Response = {
      type: 0x04,
      requestId: 1n,
      largestLocation: { group: 100n, object: 50n },
      trackProperties: new Map([[1, new Uint8Array([1, 2, 3])]]),
    };

    bench('v14/v16 response', () => {
      subscribeResponseFromWire(v14Response as any);
    });

    bench('v18 response', () => {
      subscribeResponseFromWire(v18Response as any);
    });
  });

  describe('publishRequestToWire', () => {
    const request = {
      trackNamespace: ['publisher', 'media'],
      trackName: 'audio-opus',
      groupOrder: GroupOrder.ASCENDING,
      trackProperties: new Map([[1, new Uint8Array([0x01, 0x02])]]),
    };

    bench('publish request', () => {
      publishRequestToWire(request, 100n, 999n);
    });
  });

  describe('fetchRequestToWire', () => {
    const request = {
      trackNamespace: ['archive', 'recordings'],
      trackName: 'session-123',
      subscriberPriority: 100,
      groupOrder: GroupOrder.ASCENDING,
      startLocation: { group: 0n, object: 0n },
      endLocation: { group: 1000n, object: 9999n },
    };

    bench('fetch request', () => {
      fetchRequestToWire(request, 500n);
    });
  });

  describe('subscribeNamespaceRequestToWire', () => {
    const discoverRequest = {
      trackNamespacePrefix: ['conference'],
      mode: NamespaceSubscribeMode.DISCOVER,
    };

    const bothRequest = {
      trackNamespacePrefix: ['conference', 'room-1'],
      mode: NamespaceSubscribeMode.BOTH,
      trackNamePattern: 'video-*',
      filter: SubscriptionFilter.LATEST_GROUP,
      startLocation: { group: 1n, object: 0n },
    };

    bench('discover mode', () => {
      subscribeNamespaceRequestToWire(discoverRequest, 1n);
    });

    bench('both mode (complex)', () => {
      subscribeNamespaceRequestToWire(bothRequest, 100n);
    });
  });

  describe('errorFromWire', () => {
    const v14Error = {
      type: 0x05,
      requestId: 50,
      errorCode: 1,
      reasonPhrase: 'Track not found - the requested track does not exist',
      trackAlias: 0,
    };

    const v18Error = {
      type: 0x08,
      requestId: 60n,
      errorCode: 2n,
      reasonPhrase: 'Unauthorized - authentication required',
    };

    bench('v14/v16 error', () => {
      errorFromWire(v14Error as any);
    });

    bench('v18 error', () => {
      errorFromWire(v18Error as any);
    });
  });
});

describe('Comparison: Direct vs Unified Codec', () => {
  const request = {
    trackNamespace: ['conference', 'room-1'],
    trackName: 'video',
    filter: SubscriptionFilter.LATEST_GROUP,
    subscriberPriority: 128,
    groupOrder: GroupOrder.DEFAULT,
  };

  bench('unified codec adapter', () => {
    subscribeRequestToWire(request, 1n);
  });

  // Baseline: direct object construction (no codec overhead)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let baselineWire: unknown;
  if (!IS_DRAFT_18) {
    bench('direct v14 wire type construction', () => {
      baselineWire = {
        type: 0x03,
        requestId: 1,
        trackAlias: 0,
        trackNamespace: request.trackNamespace,
        trackName: request.trackName,
        subscriberPriority: request.subscriberPriority,
        groupOrder: request.groupOrder,
        filterType: 0x01,
        parameters: new Map(),
      };
    });
  } else {
    bench('direct v18 wire type construction', () => {
      baselineWire = {
        type: 0x03,
        requestId: 1n,
        trackNamespace: request.trackNamespace,
        trackName: request.trackName,
        forwardState: true,
        filter: 0x01,
        parameters: new Map(),
      };
    });
  }
});
