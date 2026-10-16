// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * REQUEST_OK ends with Track Properties (draft-22 §9.3, draft-18 §10.5): the
 * remaining length of the message after the Parameters. A TRACK_STATUS_OK
 * carries those the SUBSCRIBE_OK would.
 */

import { describe, it, expect } from 'vitest';
import { Draft18MessageCodec } from './draft18-message-codec';
import { Draft22MessageCodec } from './draft22-message-codec';
import { MOQTVarInt } from './moqt-varint';
import { MessageTypeDraft18, TrackPropertyDraft18, type RequestOkMessageDraft18 } from '../messages/types';

const codecs = [
  ['draft-18', Draft18MessageCodec],
  ['draft-22', Draft22MessageCodec],
] as const;

describe.each(codecs)('REQUEST_OK Track Properties (%s)', (_draft, codec) => {
  const message: RequestOkMessageDraft18 = {
    type: MessageTypeDraft18.REQUEST_OK,
    requestId: 0n,
    largestLocation: { group: 4n, object: 1n },
    trackProperties: new Map([[TrackPropertyDraft18.MAX_CACHE_DURATION, MOQTVarInt.encode(15_000n)]]),
  };

  it('roundtrips them after the Parameters', () => {
    const [decoded] = codec.decode(codec.encode(message as never));

    expect(decoded).toMatchObject({
      largestLocation: { group: 4n, object: 1n },
      trackProperties: message.trackProperties,
    });
  });

  it('has none when the message ends with the Parameters', () => {
    const [decoded] = codec.decode(codec.encode({ ...message, trackProperties: undefined } as never));

    expect((decoded as RequestOkMessageDraft18).trackProperties).toBeUndefined();
  });
});
