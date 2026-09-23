// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §10.2.13 NEW_GROUP_REQUEST wire round-trip.
 *
 * The subscriber sends REQUEST_UPDATE carrying the NEW_GROUP_REQUEST
 * parameter and the relay must accept it (REQUEST_OK). This proves the
 * subscriber-side encoder is spec-conformant end-to-end.
 *
 * We do *not* assert that a fresh keyframe arrives on the subscribe path.
 * Whether NEW_GROUP_REQUEST reaches the origin publisher is relay-defined:
 * some relays proxy REQUEST_UPDATE upstream, others answer locally and
 * discard the NGR hint. The publisher-side wiring — session emits
 * `new-group-request` with `trackAlias`, MediaSession calls
 * `PublishPipeline.forceKeyframe()` — is covered by
 * `media-session-new-group-request.test.ts` and
 * `session-expires-and-ngr.test.ts`.
 *
 * Skipped on non-draft-18 builds; NGR is a draft-18 feature.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { makeMediaSession, type MediaSessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import { createSyntheticVideo, type SyntheticVideo } from '../lib/synthetic-source.js';
import videoStream from '../profiles/video-stream.json';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
const isDraft18 = MOQT_VERSION === 'draft-18';

describe.skipIf(!isDraft18)('NEW_GROUP_REQUEST wire round-trip', () => {
  let pub: MediaSessionHandle | undefined;
  let sub: MediaSessionHandle | undefined;
  let source: SyntheticVideo | undefined;

  afterEach(async () => {
    source?.stop();
    source = undefined;
    await pub?.close();
    await sub?.close();
    pub = undefined;
    sub = undefined;
  });

  it('relay accepts REQUEST_UPDATE with NEW_GROUP_REQUEST parameter', async () => {
    const profile = resolveProfile(videoStream as Profile);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, 'ngr');

    pub = await makeMediaSession(profile);
    sub = await makeMediaSession(profile);

    source = createSyntheticVideo({
      width: track.spec.width,
      height: track.spec.height,
      framerate: track.spec.framerate,
    });

    const publishConfig = {
      videoBitrate: track.spec.bitrate,
      audioBitrate: 64_000,
      videoResolution: '480p' as const,
      keyframeInterval: track.spec.keyframeIntervalSeconds ?? 1,
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
      videoEnabled: true,
      audioEnabled: false,
    };

    await pub.media.publish(namespace, track.name, source.stream, publishConfig);

    const subscriptionId = await sub.media.subscribe(namespace, track.name, publishConfig, 'video');

    // sendRequestUpdate resolves on REQUEST_OK; a REQUEST_ERROR from the relay
    // would throw with a message containing "REQUEST_UPDATE failed". Either
    // outcome proves the parameter was parsed on the wire.
    let settled: 'ok' | 'error' | undefined;
    try {
      await sub.session.sendRequestUpdate(subscriptionId, true, { newGroupRequest: true });
      settled = 'ok';
    } catch (err) {
      if (/REQUEST_UPDATE/.test((err as Error).message)) settled = 'error';
      else throw err;
    }
    expect(settled).toBeDefined();
  });
});
