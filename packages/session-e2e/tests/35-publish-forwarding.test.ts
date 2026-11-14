// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Relay forwards a PUBLISH to a matching namespace subscriber.
 *
 * Draft-18 §6.1 splits discovery in two: SUBSCRIBE_NAMESPACE asks for
 * NAMESPACE messages only, and SUBSCRIBE_TRACKS asks for a PUBLISH for every
 * existing and future track under the prefix (§10.19, §8). Each case opens a
 * publisher and a subscriber session, has the publisher PUBLISH one track and
 * send an object every 100 ms, and watches the subscriber for 5 s: did a
 * PUBLISH arrive (fwdPublish), did its objects follow within 2 s (objects),
 * and did a NAMESPACE arrive (nsMsg). A plain SUBSCRIBE from a third session
 * is the control: if it gets objects and the forwarding check fails, the relay
 * did not forward; if it gets none, the publisher was unreachable and the
 * case is inconclusive. Each case prints its control-message trace.
 *
 * MOQ_RELAY_KNOWN_NO_PUBLISH_FWD=1 reports a missing forward without failing,
 * for a relay with a known gap.
 */

import { isDraftAtLeast, type DraftVersion } from '@moq-web/core';
import type { MOQTSession } from '@moq-web/session';
import { afterEach, describe, expect, it } from 'vitest';

import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const ENV = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
const MOQT_VERSION = ENV.VITE_MOQT_VERSION ?? 'draft-18';
/** SUBSCRIBE_TRACKS is draft-18 and later */
const isDraft18 = isDraftAtLeast(MOQT_VERSION as DraftVersion, 18);
const KNOWN_NO_PUBLISH_FWD = ENV.VITE_MOQ_RELAY_KNOWN_NO_PUBLISH_FWD === '1';

const TRACK = 't';
const OK_TIMEOUT_MS = 5_000;
const WATCH_MS = 5_000;
const OBJECTS_MS = 2_000;
const SEND_EVERY_MS = 100;

/** Session events worth a line in the trace */
const TRACED = [
  'message-sent', 'message-received', 'request-ok', 'namespace-acknowledged', 'namespace-announced',
  'namespace-done', 'namespace-error', 'incoming-publish', 'publish-done', 'subscribe-ok', 'subscribe-error',
  'subscription-cancelled', 'stream-reset', 'forward-state-change', 'goaway', 'session-terminated', 'error',
] as const;
/** Events that mean something went wrong on the session */
const UNEXPECTED = new Set(['namespace-error', 'subscribe-error', 'subscription-cancelled', 'stream-reset', 'session-terminated', 'error']);

type Watch = 'subscribe-namespace' | 'subscribe-tracks';

interface Case {
  id: string;
  title: string;
  watch: Watch;
  publishFirst: boolean;
  announce: boolean;
}

const CASES: Case[] = [
  { id: 'case1', title: 'SUBSCRIBE_NAMESPACE, then PUBLISH', watch: 'subscribe-namespace', publishFirst: false, announce: false },
  { id: 'case2', title: 'PUBLISH, then SUBSCRIBE_NAMESPACE', watch: 'subscribe-namespace', publishFirst: true, announce: false },
  { id: 'case3', title: 'SUBSCRIBE_NAMESPACE, then PUBLISH and PUBLISH_NAMESPACE', watch: 'subscribe-namespace', publishFirst: false, announce: true },
  { id: 'case4', title: 'SUBSCRIBE_TRACKS, then PUBLISH', watch: 'subscribe-tracks', publishFirst: false, announce: false },
  { id: 'case5', title: 'PUBLISH, then SUBSCRIBE_TRACKS', watch: 'subscribe-tracks', publishFirst: true, announce: false },
];

class Trace {
  readonly lines: string[] = [];
  readonly unexpected: string[] = [];
  private readonly start = Date.now();
  tearingDown = false;

  note(who: string, text: string): void {
    this.lines.push(`+${String(Date.now() - this.start).padStart(5)}ms ${who} ${text}`);
  }

  attach(who: string, session: MOQTSession): void {
    for (const event of TRACED) {
      (session.on as (e: string, h: (data: unknown) => void) => void)(event, (data) => {
        const text = describeEvent(event, data);
        this.note(who, text);
        // A publisher-side reset is our own: the relay set forward=0 while no one subscribes
        const ownReset = event === 'stream-reset' && (data as { side?: string } | undefined)?.side === 'publisher';
        if (UNEXPECTED.has(event) && !ownReset && !this.tearingDown) {
          this.unexpected.push(`${who} ${text}`);
        }
      });
    }
  }
}

function describeEvent(event: string, data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>;
  if (event === 'message-sent' || event === 'message-received') {
    return `${event === 'message-sent' ? '→' : '←'} ${String(d.messageType)} ${String(d.summary ?? '')}`;
  }
  const fields = ['requestKind', 'requestId', 'namespace', 'trackName', 'trackAlias', 'forward', 'errorCode', 'reasonPhrase', 'code', 'reason', 'message']
    .filter((k) => d[k] !== undefined)
    .map((k) => `${k}=${Array.isArray(d[k]) ? (d[k] as unknown[]).join('/') : String(d[k])}`);

  return `[${event}] ${fields.join(' ')}`;
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms} ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!isDraft18)('Relay forwards PUBLISH to namespace subscribers', () => {
  let handles: SessionHandle[] = [];
  let stopSending: (() => void) | undefined;

  afterEach(async () => {
    stopSending?.();
    stopSending = undefined;
    for (const h of handles) {
      await h.close();
    }
    handles = [];
  });

  it.for(CASES)('$id: $title', async (c, { task }) => {
    const profile = resolveProfile(chatStream as Profile);
    // A fresh prefix per run, so nothing an earlier run left on the relay matches
    const prefix = makeNamespace(profile, 'e2e-fwd');
    const namespace = [...prefix, 'pub'];
    const trace = new Trace();

    const fwdRequired = c.watch === 'subscribe-tracks';
    const watchStep = c.watch === 'subscribe-tracks'
      ? `Sub: SUBSCRIBE_TRACKS ${prefix.join('/')}`
      : `Sub: SUBSCRIBE_NAMESPACE ${prefix.join('/')} (namespaces only, draft-18 §6.1)`;
    const publishSteps = [
      `Pub: PUBLISH ${namespace.join('/')}/${TRACK}`,
      ...(c.announce ? [`Pub: PUBLISH_NAMESPACE ${namespace.join('/')}`] : []),
      `Pub: one object every ${SEND_EVERY_MS} ms, a new group each`,
    ];
    record(task, {
      flow: [
        ...(c.publishFirst ? [...publishSteps, 'Wait 500 ms', watchStep] : [watchStep, 'Wait 200 ms', ...publishSteps]),
        fwdRequired
          ? `Relay → Sub: PUBLISH for the track (§8, §10.19), then its objects within ${OBJECTS_MS / 1000} s`
          : 'Relay → Sub: REQUEST_OK; a forwarded PUBLISH is reported but not required',
        ...(c.announce ? ['Relay → Sub: NAMESPACE for the suffix "pub"'] : []),
        `Watch Sub for ${WATCH_MS / 1000} s`,
        `Control: a third session SUBSCRIBEs ${namespace.join('/')}/${TRACK} by name, filter Largest Object; needs objects within ${OBJECTS_MS / 1000} s`,
        `Check: the control got objects (else inconclusive)${fwdRequired && !KNOWN_NO_PUBLISH_FWD ? '; Sub got the PUBLISH and objects in time' : ''}${c.announce ? '; Sub got the NAMESPACE' : ''}; no unexpected errors or resets`,
      ],
      expected: fwdRequired
        ? 'The relay sends Sub a PUBLISH for the track (draft-18 §8, §10.19) and objects follow within 2 s; the control SUBSCRIBE gets objects'
        : c.announce
          ? 'Sub gets a NAMESPACE for the suffix "pub"; a PUBLISH is not required (SUBSCRIBE_NAMESPACE asks for namespaces only, draft-18 §6.1); the control SUBSCRIBE gets objects'
          : 'SUBSCRIBE_NAMESPACE is answered; a PUBLISH is not required (namespaces only, draft-18 §6.1), and whether one came is reported; the control SUBSCRIBE gets objects',
      inputs: { draft: MOQT_VERSION, prefix: prefix.join('/'), track: `${namespace.join('/')}/${TRACK}`, watch: c.watch, publishFirst: c.publishFirst, announce: c.announce, knownNoPublishFwd: KNOWN_NO_PUBLISH_FWD },
    });

    const sub = await makeSession(profile);
    const pub = await makeSession(profile);
    handles.push(sub, pub);
    trace.attach('Sub', sub.session);
    trace.attach('Pub', pub.session);

    // What Sub sees
    let fwdPublish = false;
    let nsMsg = false;
    let firstObjectAt: number | undefined;
    let publishAt: number | undefined;
    let objects = 0;
    const onObject = (_data: Uint8Array, groupId: number) => {
      objects++;
      if (firstObjectAt === undefined) {
        firstObjectAt = Date.now();
        trace.note('Sub', `first object group=${groupId}`);
      }
    };
    sub.session.on('incoming-publish', (evt) => {
      if (evt.namespace.join('/') === namespace.join('/') && evt.trackName === TRACK) {
        fwdPublish = true;
        publishAt ??= Date.now();
      }
    });
    sub.session.on('namespace-announced', (evt) => {
      if (evt.namespace.join('/') === namespace.join('/') || evt.namespace.join('/') === 'pub') {
        nsMsg = true;
      }
    });

    const startPublishing = async () => {
      trace.note('Pub', `PUBLISH ${namespace.join('/')}/${TRACK}`);
      const alias = await within(pub.session.publish(namespace, TRACK, { deliveryMode: 'stream', skipForwardWait: true }), OK_TIMEOUT_MS, 'PUBLISH');
      trace.note('Pub', `PUBLISH_OK alias=${alias}`);
      if (c.announce) {
        trace.note('Pub', `PUBLISH_NAMESPACE ${namespace.join('/')}`);
        await within(pub.session.announceNamespace(namespace, { deliveryMode: 'stream' }), OK_TIMEOUT_MS, 'PUBLISH_NAMESPACE');
        trace.note('Pub', 'PUBLISH_NAMESPACE_OK');
      }
      let group = 0;
      const timer = setInterval(() => {
        const n = group++;
        pub.session.sendObject(alias, new TextEncoder().encode(`obj ${n}`), { groupId: n, objectId: 0 }).catch(() => {
          // Dropped while the relay has forward=0; the trace shows why
        });
      }, SEND_EVERY_MS);
      stopSending = () => clearInterval(timer);

      return alias;
    };

    const startWatching = async () => {
      if (c.watch === 'subscribe-tracks') {
        trace.note('Sub', `SUBSCRIBE_TRACKS ${prefix.join('/')} forward=1`);
        await within(sub.session.subscribeTracks(prefix, onObject), OK_TIMEOUT_MS, 'SUBSCRIBE_TRACKS');
        trace.note('Sub', 'SUBSCRIBE_TRACKS accepted');
        return;
      }
      // Draft-18 SUBSCRIBE_NAMESPACE has no option for what to receive: it is namespaces only
      trace.note('Sub', `SUBSCRIBE_NAMESPACE ${prefix.join('/')} (draft-18: namespaces only, no subscribe options)`);
      const accepted = new Promise<void>((resolve, reject) => {
        sub.session.on('request-ok', (evt) => {
          if (evt.requestKind === 'subscribe-namespace') resolve();
        });
        sub.session.on('namespace-error', (evt) => {
          if (evt.kind === 'subscribe-namespace') reject(new Error(`SUBSCRIBE_NAMESPACE refused: ${evt.errorCode} ${evt.reasonPhrase}`));
        });
      });
      await sub.session.subscribeNamespace(prefix, { onObject });
      await within(accepted, OK_TIMEOUT_MS, 'SUBSCRIBE_NAMESPACE');
      trace.note('Sub', 'SUBSCRIBE_NAMESPACE accepted');
    };

    let alias: bigint;
    if (c.publishFirst) {
      alias = await startPublishing();
      await sleep(500);
      await startWatching();
    } else {
      await startWatching();
      await sleep(200);
      alias = await startPublishing();
    }

    await sleep(WATCH_MS);
    const objectsInTime = fwdPublish && publishAt !== undefined && firstObjectAt !== undefined && firstObjectAt - publishAt <= OBJECTS_MS;

    // Control: a plain SUBSCRIBE by name, from its own session so it cannot collide with Sub's forwarded track
    const ctl = await makeSession(profile);
    handles.push(ctl);
    trace.attach('Ctl', ctl.session);
    let controlObjects = 0;
    let control = 'ok';
    try {
      trace.note('Ctl', `SUBSCRIBE ${namespace.join('/')}/${TRACK} filter=latest`);
      await within(ctl.session.subscribe(namespace, TRACK, { filterType: 'latest' }, () => { controlObjects++; }), OK_TIMEOUT_MS, 'control SUBSCRIBE');
      await sleep(OBJECTS_MS);
      if (controlObjects === 0) control = 'no objects';
    } catch (err) {
      control = (err as Error).message;
    }

    const verdict = control !== 'ok'
      ? 'inconclusive: publisher not reachable'
      : fwdRequired && !(fwdPublish && objectsInTime)
        ? 'relay does not forward'
        : 'ok';
    const line = `${c.id} fwdPublish=${fwdPublish} objects=${fwdPublish ? (objectsInTime ? objects : 'none in 2 s') : 'n/a'} nsMsg=${c.announce ? nsMsg : 'n/a'} control=${control} verdict=${verdict}`;

    // Teardown, then check nothing went wrong before it
    trace.tearingDown = true;
    stopSending?.();
    stopSending = undefined;
    await pub.session.unpublish(alias).catch(() => undefined);

    console.warn(line);
    console.warn(trace.lines.join('\n'));
    record(task, {
      observed: { summary: line, fwdPublish, objects, objectsInTime, nsMsg, control, controlObjects, verdict, unexpected: trace.unexpected, trace: trace.lines },
    });

    expect(control, 'control SUBSCRIBE: the publisher must be reachable for the result to mean anything').toBe('ok');
    if (fwdRequired && !KNOWN_NO_PUBLISH_FWD) {
      expect(fwdPublish, 'relay sent Sub a PUBLISH for the track').toBe(true);
      expect(objectsInTime, 'objects arrived within 2 s of the PUBLISH').toBe(true);
    }
    if (c.announce) {
      expect(nsMsg, 'Sub got a NAMESPACE for the announced namespace').toBe(true);
    }
    expect(trace.unexpected).toEqual([]);
  });
});
