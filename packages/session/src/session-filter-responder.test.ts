// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The subscriber's Location filter as a publisher (draft-22 §3.3.1, draft-18
 * §5.1.2): "A publisher MUST NOT send objects from outside the requested
 * range." A filter is resolved against the Largest Object when the SUBSCRIBE,
 * PUBLISH_OK or REQUEST_UPDATE carrying it is processed. Draft-18 SHOULD
 * answer a range whose End Group is fully published with INVALID_RANGE;
 * draft-22 says a filter is always valid.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  LocationFilterTypeDraft22,
  MessageTypeDraft18,
  RequestErrorCodeDraft18,
  SubscriptionFilterDraft18,
  type Location,
} from '@moq-web/core';

import { announce, makeSession, openIncoming, tick, type Draft, type SessionInternals } from './__tests__/incoming-peer.js';
import type { MOQTSession } from './session.js';

const SEED_REQUEST_ID = 1n;
const SUBSCRIBE_ID = 3n;
const UPDATE_ID = 5n;
const NAMESPACE = ['ns'];
const TRACK = 't';
const LARGEST: Location = { group: 5n, object: 2n };
const PAYLOAD = new Uint8Array([1]);

type Filter = 'next-group' | 'next-object' | 'absolute' | 'range';

/** A filter in the wire shape of the draft, `start` and `endGroup` being absolute */
function filterFields(draft: Draft, filter: Filter, start: Location = { group: 0n, object: 0n }, endGroup = 0n) {
  if (draft === 'draft-18') {
    const fields = {
      'next-group': { filter: SubscriptionFilterDraft18.NEXT_GROUP_START },
      'next-object': { filter: SubscriptionFilterDraft18.LARGEST_OBJECT },
      absolute: { filter: SubscriptionFilterDraft18.ABSOLUTE_START, startLocation: start },
      range: { filter: SubscriptionFilterDraft18.ABSOLUTE_RANGE, startLocation: start, endGroupDelta: endGroup - start.group },
    };

    return fields[filter];
  }

  const fields = {
    'next-group': { type: LocationFilterTypeDraft22.RELATIVE_START, startLocation: { group: 0n, object: 0n } },
    'next-object': { type: LocationFilterTypeDraft22.NEXT_OBJECT },
    absolute: { type: LocationFilterTypeDraft22.ABSOLUTE_START, startLocation: start },
    range: { type: LocationFilterTypeDraft22.ABSOLUTE_START_GROUP_END, startLocation: start, endGroupDelta: endGroup - start.group },
  };

  return { locationFilter: fields[filter] };
}

function subscribe(draft: Draft, requestId: bigint, fields: object) {
  return {
    type: MessageTypeDraft18.SUBSCRIBE,
    requestId,
    trackNamespace: NAMESPACE,
    trackName: TRACK,
    forwardState: true,
    ...(draft === 'draft-18' ? { filter: SubscriptionFilterDraft18.ABSOLUTE_START } : {}),
    ...fields,
  };
}

/** A session whose track has published up to LARGEST, with no subscriber left. */
async function harness(draft: Draft) {
  const { session, internals } = makeSession(draft);
  announce(internals, NAMESPACE);
  const seed = openIncoming(internals, subscribe(draft, SEED_REQUEST_ID, {}));
  await seed.opened;
  const alias = internals.publicationManager.getByRequestId(SEED_REQUEST_ID)!.trackAlias as bigint;
  internals.publicationManager.updateLatest(alias, LARGEST.group, LARGEST.object);
  (internals.publicationManager as unknown as { remove: (a: bigint) => void }).remove(alias);
  const sent = vi.fn().mockResolvedValue(undefined);
  (session as unknown as { sendSubgroupObject: unknown }).sendSubgroupObject = sent;

  return { session, internals, sent };
}

async function subscribed(internals: SessionInternals, draft: Draft, fields: object) {
  const peer = openIncoming(internals, subscribe(draft, SUBSCRIBE_ID, fields));
  await peer.opened;
  const alias = internals.publicationManager.getByRequestId(SUBSCRIBE_ID)?.trackAlias as bigint | undefined;

  return { peer, alias };
}

/** The Locations, out of the ones tried, that were sent to the subscriber */
async function delivered(session: MOQTSession, alias: bigint, tried: Array<[bigint, bigint]>): Promise<Array<[bigint, bigint]>> {
  const sent = (session as unknown as { sendSubgroupObject: ReturnType<typeof vi.fn> }).sendSubgroupObject;
  sent.mockClear();
  for (const [group, object] of tried) {
    await session.sendObject(alias, PAYLOAD, { groupId: Number(group), objectId: Number(object), type: 'data' });
  }

  return sent.mock.calls.map(([, , metadata]) => [BigInt(metadata.groupId), BigInt(metadata.objectId)]);
}

const AROUND_LARGEST: Array<[bigint, bigint]> = [[5n, 2n], [5n, 3n], [6n, 0n], [7n, 0n]];

describe.each(['draft-18', 'draft-22'] as const)('publisher honours the subscription filter (%s)', (draft) => {
  it('starts a Next Group filter at the group after the Largest Object', async () => {
    const { session, internals } = await harness(draft);
    const { alias } = await subscribed(internals, draft, filterFields(draft, 'next-group'));

    expect(await delivered(session, alias!, AROUND_LARGEST)).toEqual([[6n, 0n], [7n, 0n]]);
  });

  it('starts a Next Object filter at the Object after the Largest Object', async () => {
    const { session, internals } = await harness(draft);
    const { alias } = await subscribed(internals, draft, filterFields(draft, 'next-object'));

    expect(await delivered(session, alias!, AROUND_LARGEST)).toEqual([[5n, 3n], [6n, 0n], [7n, 0n]]);
  });

  it('starts an absolute filter where it says, even before the Largest Object', async () => {
    const { session, internals } = await harness(draft);
    const { alias } = await subscribed(internals, draft, filterFields(draft, 'absolute', { group: 5n, object: 2n }));

    expect(await delivered(session, alias!, [[5n, 1n], ...AROUND_LARGEST])).toEqual(AROUND_LARGEST);
  });

  it('stops after the last Object of the End Group', async () => {
    const { session, internals } = await harness(draft);
    const { alias } = await subscribed(internals, draft, filterFields(draft, 'range', { group: 5n, object: 0n }, 6n));

    expect(await delivered(session, alias!, AROUND_LARGEST)).toEqual([[5n, 2n], [5n, 3n], [6n, 0n]]);
  });

  it('sends everything to an unfiltered subscription', async () => {
    const { session, internals } = await harness(draft);
    const { alias } = await subscribed(internals, draft, {});

    expect(await delivered(session, alias!, AROUND_LARGEST)).toEqual(AROUND_LARGEST);
  });

  it('applies the filter of a REQUEST_UPDATE from then on', async () => {
    const { session, internals } = await harness(draft);
    const { peer, alias } = await subscribed(internals, draft, {});

    peer.send({
      type: MessageTypeDraft18.REQUEST_UPDATE,
      requestId: UPDATE_ID,
      ...filterFields(draft, 'next-group'),
    });
    await tick();

    expect(await delivered(session, alias!, AROUND_LARGEST)).toEqual([[6n, 0n], [7n, 0n]]);
    expect(peer.written()[1].type).toBe(MessageTypeDraft18.REQUEST_OK);
  });

  it('leaves the filter alone when a REQUEST_UPDATE omits it', async () => {
    const { session, internals } = await harness(draft);
    const { peer, alias } = await subscribed(internals, draft, filterFields(draft, 'next-group'));

    peer.send({ type: MessageTypeDraft18.REQUEST_UPDATE, requestId: UPDATE_ID, forwardState: true });
    await tick();

    expect(await delivered(session, alias!, AROUND_LARGEST)).toEqual([[6n, 0n], [7n, 0n]]);
  });
});

describe('a range whose End Group is published', () => {
  const endedAtGroup3 = (draft: Draft) => filterFields(draft, 'range', { group: 1n, object: 0n }, 3n);

  it('draft-18 refuses a SUBSCRIBE with INVALID_RANGE', async () => {
    const { internals } = await harness('draft-18');

    const peer = openIncoming(internals, subscribe('draft-18', SUBSCRIBE_ID, endedAtGroup3('draft-18')));
    await peer.opened;

    expect(peer.written()).toEqual([
      expect.objectContaining({ type: MessageTypeDraft18.REQUEST_ERROR, errorCode: RequestErrorCodeDraft18.INVALID_RANGE }),
    ]);
    expect(peer.closed()).toBe(true);
  });

  it('draft-22 accepts it, as a filter is always valid', async () => {
    const { internals } = await harness('draft-22');

    const peer = openIncoming(internals, subscribe('draft-22', SUBSCRIBE_ID, endedAtGroup3('draft-22')));
    await peer.opened;

    expect(peer.written()[0].type).toBe(MessageTypeDraft18.SUBSCRIBE_OK);
  });
});

describe('the filter of a PUBLISH_OK (draft-18)', () => {
  it('limits what we publish', async () => {
    const { session } = makeSession('draft-18');
    const sent = vi.fn().mockResolvedValue(undefined);
    (session as unknown as { sendSubgroupObject: unknown }).sendSubgroupObject = sent;
    (session as unknown as { sendRequestAndWaitResponse: unknown }).sendRequestAndWaitResponse = async () => ({
      type: MessageTypeDraft18.REQUEST_OK,
      requestId: 0n,
      ...filterFields('draft-18', 'absolute', { group: 4n, object: 0n }),
    });

    const alias = await session.publish(NAMESPACE, TRACK);

    expect(await delivered(session, alias, [[3n, 9n], [4n, 0n]])).toEqual([[4n, 0n]]);
  });
});
