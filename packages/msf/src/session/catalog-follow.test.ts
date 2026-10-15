// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Late joiners get the current catalog: a catalog subscription asks for a
 * fill of the current group (draft-22 §3.4, §3.5), and a subscription a
 * relay pushed can be followed the same way.
 */

import { describe, it, expect, vi } from 'vitest';
import type { MOQTSession } from '@moq-web/session';

import { createCatalog, serializeCatalogToBytes } from '../catalog/index.js';
import { createDelta } from '../catalog/delta.js';
import type { FullCatalog } from '../schemas/index.js';
import { MSFSession } from './msf-session.js';

const SUBSCRIPTION_ID = 5;
const NAMESPACE = ['room', 'peer'];
const CURRENT_GROUP_FILL = { lastGroups: 1 };
const GROUP_ID = 7;
const TIMESTAMP = 0;

type ObjectCallback = (data: Uint8Array, groupId: number, objectId: number, timestamp: number) => void;

function makeFakeSession(draft = 'draft-22') {
  const callbacks = new Map<number, ObjectCallback>();
  const session = {
    subscribe: vi.fn(async (_ns: string[], _name: string, _options?: unknown, onObject?: ObjectCallback) => {
      if (onObject) {
        callbacks.set(SUBSCRIPTION_ID, onObject);
      }

      return SUBSCRIPTION_ID;
    }),
    setSubscriptionCallback: vi.fn((id: number, cb: ObjectCallback) => {
      callbacks.set(id, cb);
    }),
    requestFill: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
    on: vi.fn(() => () => {}),
    draft: draft,
  };

  return {
    session,
    moqt: session as unknown as MOQTSession,
    deliver: (data: Uint8Array, objectId: number) => callbacks.get(SUBSCRIPTION_ID)?.(data, GROUP_ID, objectId, TIMESTAMP),
  };
}

function fullCatalogBytes(): Uint8Array {
  return serializeCatalogToBytes(
    createCatalog().addVideoTrack({ name: 'video', codec: 'avc1', width: 640, height: 360, framerate: 30, isLive: true }).build(),
  );
}

function deltaBytes(): Uint8Array {
  return serializeCatalogToBytes(createDelta().remove('video').build());
}

describe('catalog subscribe asks for a fill of the current group', () => {
  it('passes SubscribeOptions.fill for the current group', async () => {
    const { session, moqt } = makeFakeSession();
    const msf = new MSFSession(moqt, NAMESPACE);

    await msf.subscribeCatalog(() => {});

    expect(session.subscribe).toHaveBeenCalledWith(
      NAMESPACE,
      'catalog',
      { fill: CURRENT_GROUP_FILL },
      expect.any(Function),
    );
  });
});

describe('draft-18 catalog fill', () => {
  it('requests no fill (a Joining FETCH tears down some relays)', async () => {
    const { session, moqt } = makeFakeSession('draft-18');
    const msf = new MSFSession(moqt, NAMESPACE);

    await msf.subscribeCatalog(() => {});
    await new MSFSession(moqt, NAMESPACE).followCatalog(SUBSCRIPTION_ID, () => {});

    expect(session.subscribe).toHaveBeenCalledWith(NAMESPACE, 'catalog', { fill: undefined }, expect.any(Function));
    expect(session.requestFill).not.toHaveBeenCalled();
  });
});

describe('MSFSession.followCatalog', () => {
  it('routes the subscription to the catalog parser and fills the current group', async () => {
    const { session, moqt, deliver } = makeFakeSession();
    const msf = new MSFSession(moqt, NAMESPACE);
    const seen: Array<[FullCatalog, boolean]> = [];

    await msf.followCatalog(SUBSCRIPTION_ID, (catalog, isIndependent) => seen.push([catalog, isIndependent]));
    deliver(fullCatalogBytes(), 0);

    expect(session.setSubscriptionCallback).toHaveBeenCalledWith(SUBSCRIPTION_ID, expect.any(Function));
    expect(session.requestFill).toHaveBeenCalledWith(SUBSCRIPTION_ID, CURRENT_GROUP_FILL);
    expect(seen).toHaveLength(1);
    expect(seen[0][0].tracks.map((t) => t.name)).toEqual(['video']);
    expect(seen[0][1]).toBe(true);
  });

  it('sets the callback before asking for the fill', async () => {
    const { session, moqt } = makeFakeSession();
    const msf = new MSFSession(moqt, NAMESPACE);

    await msf.followCatalog(SUBSCRIPTION_ID, () => {});

    const [callbackOrder] = session.setSubscriptionCallback.mock.invocationCallOrder;
    const [fillOrder] = session.requestFill.mock.invocationCallOrder;
    expect(callbackOrder).toBeLessThan(fillOrder);
  });

  it('applies deltas to the followed catalog', async () => {
    const { moqt, deliver } = makeFakeSession();
    const msf = new MSFSession(moqt, NAMESPACE);
    const seen: FullCatalog[] = [];

    const follower = await msf.followCatalog(SUBSCRIPTION_ID, (catalog) => seen.push(catalog));
    deliver(fullCatalogBytes(), 0);
    deliver(deltaBytes(), 1);

    expect(seen).toHaveLength(2);
    expect(seen[1].tracks).toHaveLength(0);
    expect(follower.getCatalog()?.tracks).toHaveLength(0);
  });

  it('skips a live delta that beats the fill to the full catalog', async () => {
    const { moqt, deliver } = makeFakeSession();
    const msf = new MSFSession(moqt, NAMESPACE);
    const seen: FullCatalog[] = [];
    const onError = vi.fn();

    await msf.followCatalog(SUBSCRIPTION_ID, (catalog) => seen.push(catalog), onError);
    deliver(deltaBytes(), 2);
    deliver(fullCatalogBytes(), 0);

    expect(onError).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
  });

  it('reports a failed fill request', async () => {
    const { session, moqt } = makeFakeSession();
    session.requestFill.mockRejectedValueOnce(new Error('paused'));
    const msf = new MSFSession(moqt, NAMESPACE);

    await expect(msf.followCatalog(SUBSCRIPTION_ID, () => {})).rejects.toThrow(/paused/);
  });
});
