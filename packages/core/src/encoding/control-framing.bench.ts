// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Control-message encode/decode, draft-22 (16-bit length) vs
 * draft-23 (vi64 length, PAUSED, counted FILL_PARAMETERS). Draft-23 shares
 * the draft-22 bodies, so the two should be within noise of each other.
 *
 * Run: `pnpm --filter @moq-web/core exec vitest bench --run src/encoding/control-framing.bench.ts`
 */

import { bench, describe } from 'vitest';
import { Draft22MessageCodec } from './draft22-message-codec.js';
import { Draft23MessageCodec } from './draft23-message-codec.js';
import { LocationFilterTypeDraft22, MessageTypeDraft22, type SubscribeMessageDraft22 } from '../messages/types.js';

const subscribe: SubscribeMessageDraft22 = {
  type: MessageTypeDraft22.SUBSCRIBE,
  requestId: 42n,
  trackNamespace: ['conference', 'room-1', 'participant-42'],
  trackName: 'video-h264-1080p',
  forwardState: false,
  locationFilter: { type: LocationFilterTypeDraft22.ABSOLUTE_START, startLocation: { group: 100n, object: 0n } },
  fill: { subscriberPriority: 10, fillTimeoutMs: 500n },
};

const encoded22 = Draft22MessageCodec.encode(subscribe);
const encoded23 = Draft23MessageCodec.encode(subscribe);

describe('SUBSCRIBE encode', () => {
  bench('draft-22', () => {
    Draft22MessageCodec.encode(subscribe);
  });
  bench('draft-23', () => {
    Draft23MessageCodec.encode(subscribe);
  });
});

describe('SUBSCRIBE decode', () => {
  bench('draft-22', () => {
    Draft22MessageCodec.decode(encoded22);
  });
  bench('draft-23', () => {
    Draft23MessageCodec.decode(encoded23);
  });
});
