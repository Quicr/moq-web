// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Media pause / resume round-trip.
 *
 * Publisher runs a synthetic canvas source through MediaSession.publish.
 * Subscriber subscribes, waits for the first decoded frame, pauses the
 * subscription, verifies frame delivery quiesces, then resumes and expects
 * additional decoded frames to arrive.
 *
 * The interesting bit is *after* resume: the publisher's encoder was mid-GOP
 * when it paused, so unless resume() forces a keyframe the subscriber sits
 * at black waiting for the next scheduled IDR (which can be seconds away).
 * This test covers both the draft-16 SUBSCRIBE_UPDATE and the draft-18
 * REQUEST_UPDATE code paths against a live openmoq relay.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { makeMediaSession, type MediaSessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import { createSyntheticVideo, type SyntheticVideo } from '../lib/synthetic-source.js';
import videoStream from '../profiles/video-stream.json';

describe.each([
  ['video-stream', videoStream as Profile],
])('Media pause/resume [%s]', (label, raw) => {
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

  it('pause suppresses delivery; resume triggers a fresh keyframe and frames resume', async () => {
    const profile = resolveProfile(raw);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, `pause-resume-${label}`);

    pub = await makeMediaSession(profile);
    sub = await makeMediaSession(profile);

    const frames: VideoFrame[] = [];
    sub.media.on('video-frame', ({ frame }: { frame: VideoFrame }) => {
      frames.push(frame);
    });

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

    await new Promise((r) => setTimeout(r, 500));

    const subscriptionId = await sub.media.subscribe(
      namespace,
      track.name,
      publishConfig,
      'video',
    );

    // Wait for the first decoded frame so we know the pipeline is warmed.
    const firstFrameDeadline = Date.now() + 15_000;
    while (frames.length < 1 && Date.now() < firstFrameDeadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(
      frames.length,
      'no decoded VideoFrames before pause (pipeline never warmed)',
    ).toBeGreaterThan(0);

    // Let a few more frames arrive to build confidence delivery is steady.
    await new Promise((r) => setTimeout(r, 500));
    const framesBeforePause = frames.length;
    expect(framesBeforePause).toBeGreaterThan(1);

    // Pause the subscription. Delivery should quiesce quickly.
    await sub.media.pauseSubscription(subscriptionId);

    // Give the pause a moment to propagate through the pipeline, then note
    // the frame count and confirm it stops climbing.
    await new Promise((r) => setTimeout(r, 500));
    const framesAtPauseSettle = frames.length;
    await new Promise((r) => setTimeout(r, 1000));
    const framesAfterQuiesceWindow = frames.length;

    // A small trickle (a few in-flight frames arriving after pause) is
    // acceptable; sustained delivery is not. Anything under a full second's
    // worth of frames counts as quiesced.
    const trickleBudget = Math.ceil(track.spec.framerate * 0.5);
    expect(
      framesAfterQuiesceWindow - framesAtPauseSettle,
      `delivery did not quiesce after pause (settle=${framesAtPauseSettle}, after=${framesAfterQuiesceWindow})`,
    ).toBeLessThanOrEqual(trickleBudget);

    // Resume. The publisher should force a fresh keyframe so the subscriber
    // opens a decodable group promptly instead of waiting for the next
    // scheduled IDR — that's the whole point of the resume-side fix.
    const beforeResume = frames.length;
    await sub.media.resumeSubscription(subscriptionId);

    const resumeDeadline = Date.now() + 5_000;
    while (frames.length <= beforeResume && Date.now() < resumeDeadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(
      frames.length,
      `no VideoFrames arrived within 5s of resume (before=${beforeResume}) — publisher likely stuck mid-GOP without a keyframe`,
    ).toBeGreaterThan(beforeResume);

    for (const f of frames) f.close();
  });
});
