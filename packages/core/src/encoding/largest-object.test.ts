// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * LARGEST_OBJECT (draft-22 §9.20.17, draft-18 §10.2.11): present once Objects
 * have been published, omitted before. Object {0, 0} is a real location, so
 * the codecs carry "absent" as undefined rather than as {0, 0}.
 */

import { describe, it, expect } from 'vitest';
import { Draft18MessageCodec } from './draft18-message-codec';
import { Draft22MessageCodec } from './draft22-message-codec';
import {
  MessageTypeDraft18,
  type PublishMessageDraft18,
  type SubscribeOkMessageDraft18,
} from '../messages/types';

const FIRST_OBJECT = { group: 0n, object: 0n };

const codecs = [
  ['draft-18', Draft18MessageCodec],
  ['draft-22', Draft22MessageCodec],
] as const;

describe.each(codecs)('LARGEST_OBJECT (%s)', (_draft, codec) => {
  const subscribeOk = (largestLocation?: { group: bigint; object: bigint }): SubscribeOkMessageDraft18 => ({
    type: MessageTypeDraft18.SUBSCRIBE_OK,
    requestId: 1n,
    trackAlias: 7n,
    largestLocation,
  });

  it('carries {0, 0} in SUBSCRIBE_OK as the first Object', () => {
    const [decoded] = codec.decode(codec.encode(subscribeOk(FIRST_OBJECT)));

    expect((decoded as SubscribeOkMessageDraft18).largestLocation).toEqual(FIRST_OBJECT);
  });

  it('leaves it out of SUBSCRIBE_OK when no Object was published', () => {
    const [decoded] = codec.decode(codec.encode(subscribeOk()));

    expect((decoded as SubscribeOkMessageDraft18).largestLocation).toBeUndefined();
  });

  it('carries a location in PUBLISH, {0, 0} included', () => {
    const publish: PublishMessageDraft18 = {
      type: MessageTypeDraft18.PUBLISH,
      requestId: 1n,
      trackAlias: 7n,
      trackNamespace: ['ns'],
      trackName: 't',
      forwardState: true,
      largestLocation: FIRST_OBJECT,
    };

    const [decoded] = codec.decode(codec.encode(publish as never));
    const [absent] = codec.decode(codec.encode({ ...publish, largestLocation: undefined } as never));

    expect((decoded as PublishMessageDraft18).largestLocation).toEqual(FIRST_OBJECT);
    expect((absent as PublishMessageDraft18).largestLocation).toBeUndefined();
  });
});
