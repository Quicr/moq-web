// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §11.5 padding streams & datagrams — end-to-end against a live relay.
 *
 * Sends padding through the wire and confirms:
 *   • sendPaddingStream() completes without error (relay accepts the reserved
 *     0x132B3E28 stream type and does not echo it as an object).
 *   • sendPaddingDatagram() completes without error (relay accepts the
 *     reserved 0x132B3E29 datagram type). Since datagrams are usually not
 *     forwarded to other subscribers by relays, we only assert the send
 *     side succeeds; if a peer *does* receive it, our datagram-manager
 *     drops it silently — validated in the unit tests.
 *   • Interleaving padding with a real published object still delivers the
 *     real object to a subscriber (padding does not clog the pipeline).
 */

import { isDraftAtLeast, type DraftVersion } from '@moq-web/core';
import { afterEach, describe, it } from 'vitest';

import { failOn } from '../lib/flow.js';
import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import { generateChat } from '../lib/chat-generator.js';
import chatStream from '../profiles/chat-stream.json';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
/** Draft-18 and later share these messages; draft-22 and draft-23 inherit them */
const isDraft18 = isDraftAtLeast(MOQT_VERSION as DraftVersion, 18);

describe.skipIf(!isDraft18)('padding streams & datagrams (§11.5)', () => {
  let pub: SessionHandle | undefined;
  let sub: SessionHandle | undefined;

  afterEach(async () => {
    try { await pub?.close(); } catch { /* ignore */ }
    try { await sub?.close(); } catch { /* ignore */ }
    pub = undefined;
    sub = undefined;
  });

  it('sendPaddingStream + sendPaddingDatagram do not disrupt normal object delivery', async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, 'padding');
    record(task, {
      flow: [
        `Pub: PUBLISH ${namespace.join('/')}/${track.name}`,
        'Sub: SUBSCRIBE the track; wait 250 ms',
        'Pub: padding stream (64 bytes) and padding datagram (32 bytes) (§11.5)',
        'Pub: 2 real objects',
        'Pub: empty padding stream and empty padding datagram',
        'Wait 500 ms',
        'Check: the subscriber got at least the 2 real objects and no all-zero (padding) payload',
      ],
      expected: 'With padding streams and datagrams interleaved, the subscriber still gets both real objects and no all-zero padding',
      inputs: { namespace: namespace.join('/'), track: track.name, realObjects: 2, paddingStreams: [64, 0], paddingDatagrams: [32, 0] },
    });

    pub = await makeSession(profile);
    sub = await makeSession(profile);

    const trackAlias = await pub.session.publish(namespace, track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
      skipForwardWait: true,
    });

    // A relay that cannot handle padding may drop the connection; then a send
    // never settles. Each step races the drop so the failure names the step.
    let lastStep = 'the SUBSCRIBE';
    let dropped: string | undefined;
    const lost = new Promise<never>((_, reject) => {
      for (const [who, handle] of [['publisher', pub], ['subscriber', sub]] as const) {
        handle!.session.on('session-terminated', (evt) => {
          dropped ??= `the relay dropped the ${who}'s connection after ${lastStep} (${evt.reason || `code ${evt.code}`})`;
          reject(new Error(dropped));
        });
      }
    });
    lost.catch(() => undefined);
    const step = async <T>(label: string, op: Promise<T>): Promise<T> => {
      const result = await Promise.race([op, lost]);
      lastStep = label;
      return result;
    };

    const received: Uint8Array[] = [];
    await sub.session.subscribe(namespace, track.name, undefined, (data) => {
      received.push(new Uint8Array(data));
    });
    await new Promise((r) => setTimeout(r, 250));

    try {
      // Interleave padding with real objects.
      await step('the 64-byte padding stream', pub.session.sendPaddingStream(64));
      await step('the 32-byte padding datagram', pub.session.sendPaddingDatagram(32));

      let sent = 0;
      for (const msg of generateChat(track.payload)) {
        await step(`real object ${sent + 1}`, pub.session.sendObject(trackAlias, msg.bytes, {
          groupId: msg.groupId,
          objectId: msg.objectId,
        }));
        if (++sent >= 2) break;
      }

      await step('the empty padding stream', pub.session.sendPaddingStream(0));
      await step('the empty padding datagram', pub.session.sendPaddingDatagram(0));

      // Give the relay a moment to forward the real objects.
      await step('the last send', new Promise((r) => setTimeout(r, 500)));
    } catch (err) {
      record(task, { observed: { received: received.length, dropped: dropped ?? (err as Error).message } });
      failOn([dropped ?? `Sending failed after ${lastStep}: ${(err as Error).message}`]);
    }

    // We must have received *at least* the two real objects, and nothing
    // extra that looks like padding (padding never surfaces as an object).
    // Real chat payloads are non-empty and non-zero; padding would arrive as
    // all-zero bytes if it ever leaked through.
    const allZero = received.filter((buf) => buf.every((b) => b === 0)).length;
    record(task, { observed: { received: received.length, allZeroObjects: allZero } });
    failOn([
      received.length < 2 && `The subscriber got ${received.length} of the 2 real objects sent between the padding`,
      allZero > 0 && `${allZero} all-zero object(s) reached the subscriber: padding leaked through as objects`,
    ]);
  });
});
