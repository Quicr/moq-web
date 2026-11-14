// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Requests the relay cannot serve get a REQUEST_ERROR, not silence.
 *
 * SUBSCRIBE, FETCH and TRACK_STATUS for a track nobody publishes. Each must be answered within 5 s with
 * the error code the draft names (DOES_NOT_EXIST, or TIMEOUT once a SUBSCRIBE's
 * rendezvous timeout runs out), and the session must stay usable afterwards.
 * A FETCH that starts after the Largest Object, or for a track with no
 * Objects yet, gets INVALID_RANGE. Draft-22 and later.
 */

import { RequestErrorCodeDraft18 } from '@moq-web/core';
import { RequestRejectedError } from '@moq-web/session';
import { afterEach, describe, expect, it } from 'vitest';

import { isDraft22, publishGroups, requestErrorName, sleep, within } from '../lib/flow.js';
import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const ANSWER_MS = 5_000;

/** The error code of a rejected request, or how it failed otherwise */
function outcomeOf(err: unknown): { code?: number; text: string } {
  if (err instanceof RequestRejectedError) return { code: err.errorCode, text: `${requestErrorName(err.errorCode)} "${err.reasonPhrase}"` };
  return { text: (err as Error).message };
}

describe.skipIf(!isDraft22)('Requests the relay cannot serve', () => {
  let handles: SessionHandle[] = [];

  afterEach(async () => {
    for (const h of handles) await h.close();
    handles = [];
  });

  it('SUBSCRIBE for an unknown track is refused once its rendezvous timeout runs out', async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    const namespace = makeNamespace(profile, 'err-subscribe');
    record(task, {
      flow: [
        'No publisher for the track',
        `Sub: SUBSCRIBE ${namespace.join('/')}/nobody, rendezvous timeout 1 s`,
        `Relay → Sub: REQUEST_ERROR within ${ANSWER_MS / 1000} s`,
        'Check: the code is DOES_NOT_EXIST or TIMEOUT',
        'Check: the session stays ready',
      ],
      expected: 'REQUEST_ERROR DOES_NOT_EXIST or TIMEOUT within 5 s (rendezvous timeout 1 s), and the session stays ready',
      inputs: { track: `${namespace.join('/')}/nobody`, rendezvousTimeoutMs: 1000 },
    });
    const sub = await makeSession(profile);
    handles.push(sub);

    let outcome: { code?: number; text: string } = { text: 'accepted' };
    try {
      await within(sub.session.subscribe(namespace, 'nobody', { rendezvousTimeout: 1000 }, () => undefined), ANSWER_MS, 'SUBSCRIBE');
    } catch (err) {
      outcome = outcomeOf(err);
    }
    record(task, { observed: { outcome: outcome.text, state: sub.session.state } });

    expect(outcome.code, outcome.text).toBeDefined();
    expect([RequestErrorCodeDraft18.DOES_NOT_EXIST, RequestErrorCodeDraft18.TIMEOUT]).toContain(outcome.code);
    expect(sub.session.state).toBe('ready');
  });

  it('FETCH for an unknown track is refused with DOES_NOT_EXIST', async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    const namespace = makeNamespace(profile, 'err-fetch');
    const range = { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 };
    record(task, {
      flow: [
        'No publisher for the track',
        `Sub: FETCH ${namespace.join('/')}/nobody 0/0..1/0`,
        `Relay → Sub: REQUEST_ERROR within ${ANSWER_MS / 1000} s`,
        'Check: the code is DOES_NOT_EXIST',
        'Check: the session stays ready',
      ],
      expected: 'REQUEST_ERROR DOES_NOT_EXIST within 5 s, and the session stays ready',
      inputs: { track: `${namespace.join('/')}/nobody`, range },
    });
    const sub = await makeSession(profile);
    handles.push(sub);

    const failed = new Promise<{ code?: number; text: string }>((resolve) => {
      sub.session.on('fetch-error', (evt) => resolve({ code: evt.errorCode, text: `${requestErrorName(evt.errorCode)} "${evt.reason}"` }));
    });
    let outcome: { code?: number; text: string };
    try {
      await sub.session.fetch(namespace, 'nobody', range, {}, () => undefined);
      outcome = await within(failed, ANSWER_MS, 'FETCH');
    } catch (err) {
      outcome = outcomeOf(err);
    }
    record(task, { observed: { outcome: outcome.text, state: sub.session.state } });

    expect(outcome.code, outcome.text).toBe(RequestErrorCodeDraft18.DOES_NOT_EXIST);
    expect(sub.session.state).toBe('ready');
  });

  it('TRACK_STATUS for an unknown track is refused with DOES_NOT_EXIST', async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    const namespace = makeNamespace(profile, 'err-status');
    record(task, {
      flow: [
        'No publisher for the track',
        `Sub: TRACK_STATUS ${namespace.join('/')}/nobody`,
        `Relay → Sub: REQUEST_ERROR within ${ANSWER_MS / 1000} s`,
        'Check: the code is DOES_NOT_EXIST',
        'Check: the session stays ready',
      ],
      expected: 'REQUEST_ERROR DOES_NOT_EXIST within 5 s, and the session stays ready',
      inputs: { track: `${namespace.join('/')}/nobody` },
    });
    const sub = await makeSession(profile);
    handles.push(sub);

    let outcome: { code?: number; text: string };
    try {
      const status = await within(sub.session.trackStatus(namespace, 'nobody'), ANSWER_MS, 'TRACK_STATUS');
      outcome = { text: `REQUEST_OK largest=${status.latestGroup ?? 'none'}/${status.latestObject ?? 'none'}` };
    } catch (err) {
      outcome = outcomeOf(err);
    }
    record(task, { observed: { outcome: outcome.text, state: sub.session.state } });

    expect(outcome.code, outcome.text).toBe(RequestErrorCodeDraft18.DOES_NOT_EXIST);
    expect(sub.session.state).toBe('ready');
  });

  it.for([
    { label: 'starts after the Largest Object', groups: 3, range: { startGroup: 10, startObject: 0, endGroup: 11, endObject: 0 } },
    { label: 'is for a track with no Objects yet', groups: 0, range: { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 } },
  ])('FETCH that $label is refused with INVALID_RANGE', async (c, { task }) => {
    const profile = resolveProfile(chatStream as Profile);
    const namespace = makeNamespace(profile, 'err-range');
    record(task, {
      flow: [
        `Pub: PUBLISH ${namespace.join('/')}/t, max cache 60 s`,
        'Sub: SUBSCRIBE t, filter Largest Object, so the relay holds the objects; wait 200 ms',
        c.groups ? `Pub: groups 0–${c.groups - 1}, 3 objects each; wait 300 ms` : 'Pub: sends nothing; wait 300 ms',
        `Sub: FETCH ${c.range.startGroup}/${c.range.startObject}..${c.range.endGroup}/${c.range.endObject}, which ${c.label}`,
        `Relay → Sub: REQUEST_ERROR within ${ANSWER_MS / 1000} s`,
        'Check: the code is INVALID_RANGE (draft-23 §9.16)',
        'Check: the session stays ready',
      ],
      expected: `REQUEST_ERROR INVALID_RANGE within 5 s: the FETCH ${c.label} (draft-23 §9.16)`,
      inputs: { track: `${namespace.join('/')}/t`, published: c.groups ? `groups 0..${c.groups - 1}, 3 objects each` : 'nothing', range: c.range },
    });
    const pub = await makeSession(profile);
    const sub = await makeSession(profile);
    handles.push(pub, sub);
    const alias = await pub.session.publish(namespace, 't', { deliveryMode: 'stream', skipForwardWait: true, maxCacheDuration: 60_000 });
    // Someone subscribed, so the relay holds the objects
    await sub.session.subscribe(namespace, 't', { filterType: 'latest' }, () => undefined);
    await sleep(200);
    if (c.groups) await publishGroups(pub.session, alias, { groups: c.groups, perGroup: 3 });
    await sleep(300);

    const failed = new Promise<{ code?: number; text: string }>((resolve) => {
      sub.session.on('fetch-error', (evt) => resolve({ code: evt.errorCode, text: `${requestErrorName(evt.errorCode)} "${evt.reason}"` }));
    });
    let outcome: { code?: number; text: string };
    try {
      await sub.session.fetch(namespace, 't', c.range, {}, () => undefined);
      outcome = await within(failed, ANSWER_MS, 'FETCH');
    } catch (err) {
      outcome = outcomeOf(err);
    }
    record(task, { observed: { outcome: outcome.text, state: sub.session.state } });

    expect(outcome.code, outcome.text).toBe(RequestErrorCodeDraft18.INVALID_RANGE);
    expect(sub.session.state).toBe('ready');
  });
});
