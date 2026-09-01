// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Video round-trip via MediaSession.
 *
 * Publisher creates a synthetic canvas MediaStream and calls
 * MediaSession.publish(). A second session subscribes to the same
 * namespace/track and we assert that decoded VideoFrames arrive within
 * a deadline. We only require *some* frames — the point is to prove
 * the end-to-end pipeline (WebCodecs encode → LOC → MOQT → LOC decode →
 * WebCodecs decode) works against a live relay.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { makeMediaSession, type MediaSessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import { createSyntheticVideo, type SyntheticVideo } from '../lib/synthetic-source.js';
import videoStream from '../profiles/video-stream.json';

describe.each([
  ['video-stream', videoStream as Profile],
])('Video round-trip [%s]', (label, raw) => {
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

  it('subscriber decodes VideoFrames published from a synthetic canvas', async () => {
    const profile = resolveProfile(raw);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, `video-${label}`);

    pub = await makeMediaSession(profile);
    sub = await makeMediaSession(profile);

    // Subscriber wires up frame collection before subscribe() so we don't
    // race against early deliveries.
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

    // Small settle before subscribing so the relay has registered the
    // publication.
    await new Promise((r) => setTimeout(r, 500));

    await sub.media.subscribe(namespace, track.name, publishConfig, 'video');

    // Wait for the first decoded frame; the exact latency depends on
    // encoder warmup + relay round-trip. We give it plenty of room.
    const deadline = Date.now() + 15_000;
    while (frames.length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(
      frames.length,
      `no decoded VideoFrames arrived within 15s (published ${track.spec.durationSeconds}s @ ${track.spec.framerate}fps)`,
    ).toBeGreaterThan(0);

    // Sanity-check the first frame is actually decodable and matches the
    // canvas geometry.
    const first = frames[0]!;
    expect(first.codedWidth).toBe(track.spec.width);
    expect(first.codedHeight).toBe(track.spec.height);

    // Release the VideoFrames — they hold GPU-backed resources.
    for (const f of frames) f.close();
  });
});
