// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Unit + asymptotic tests for PresentationReorderBuffer
 *
 * Focus: verify O(log n) insertion (binary-search insert) preserves sort
 * order and release semantics across in-order, out-of-order, and duplicate
 * timestamps, and that the sort cost does not grow super-linearly with
 * buffer size.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PresentationReorderBuffer } from './presentation-reorder-buffer.js';

// The media test setup registers a global MockVideoFrame under the name
// `VideoFrame`. We only need a minimal shape here — a `timestamp` and a
// callable `close()`.
function makeFrame(timestamp: number): VideoFrame {
  return {
    timestamp,
    close() { /* no-op for tests */ },
  } as unknown as VideoFrame;
}

describe('PresentationReorderBuffer', () => {
  let released: number[];
  let buf: PresentationReorderBuffer;

  beforeEach(() => {
    released = [];
    buf = new PresentationReorderBuffer(
      (frame) => { released.push(frame.timestamp); },
      { bufferDepth: 4, maxHoldTimeMs: 1_000_000, debug: false },
    );
  });

  it('releases in-order frames sorted by timestamp', () => {
    for (const ts of [10, 20, 30, 40, 50, 60, 70]) {
      buf.push(makeFrame(ts));
    }
    buf.flush();
    expect(released).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  it('sorts out-of-order frames by presentation timestamp', () => {
    // Simulate B-frame reordering: decode order [I, P, B, B, P, B, B]
    // has PTS [0, 40, 10, 20, 80, 50, 70] for example
    for (const ts of [0, 40, 10, 20, 80, 50, 70]) {
      buf.push(makeFrame(ts));
    }
    buf.flush();
    expect(released).toEqual([0, 10, 20, 40, 50, 70, 80]);
  });

  it('preserves FIFO order for equal timestamps', () => {
    // Tag equal-timestamp frames so we can verify insertion order.
    const tagged: Array<{ frame: VideoFrame; tag: string }> = [
      { frame: makeFrame(100), tag: 'a' },
      { frame: makeFrame(100), tag: 'b' },
      { frame: makeFrame(50),  tag: 'c' },
      { frame: makeFrame(100), tag: 'd' },
    ];
    const releaseOrder: string[] = [];
    const buf2 = new PresentationReorderBuffer(
      (frame) => {
        const hit = tagged.find(t => t.frame === frame);
        if (hit) releaseOrder.push(hit.tag);
      },
      { bufferDepth: 8, maxHoldTimeMs: 1_000_000, debug: false },
    );
    for (const { frame } of tagged) buf2.push(frame);
    buf2.flush();
    // 50 must come first, then the three PTS=100 frames in arrival order.
    expect(releaseOrder).toEqual(['c', 'a', 'b', 'd']);
  });

  it('does not release frames while buffer is under bufferDepth', () => {
    for (const ts of [10, 20, 30]) {
      buf.push(makeFrame(ts));
    }
    // bufferDepth=4, so only 3 frames means nothing has been released yet.
    expect(released).toEqual([]);
    buf.push(makeFrame(40));
    expect(released).toEqual([]);
    buf.push(makeFrame(50)); // now length > depth → releases oldest
    expect(released).toEqual([10]);
  });

  it('handles a large sorted stream in near-linear time (O(n log n) total)', () => {
    // Sanity check that push scales sensibly. We are not asserting absolute
    // times (too flaky), but that the ratio of work per element stays roughly
    // constant across a 4x growth in n — which is what O(log n) insertion
    // gives us (plus O(n) splice, which dominates but does not scale worse
    // than the old sort-per-push behaviour).
    const timePush = (n: number) => {
      const b = new PresentationReorderBuffer(() => { /* discard */ }, {
        bufferDepth: n + 1,
        maxHoldTimeMs: 1_000_000,
        debug: false,
      });
      // Adversarial-ish order: reverse timestamps force worst-case splice.
      const start = performance.now();
      for (let i = n; i >= 0; i--) b.push(makeFrame(i));
      return performance.now() - start;
    };

    const nSmall = 500;
    const nLarge = 2_000;
    const tSmall = timePush(nSmall) || 0.001;
    const tLarge = timePush(nLarge) || 0.001;
    // For O(n log n) the ratio should be ~ (nL/nS) * (log(nL)/log(nS)).
    // With nS=500, nL=2000 that's 4 * (log2 2000 / log2 500) ≈ 4 * 1.22 ≈ 4.9.
    // Give plenty of headroom for CI noise — assert we're well under an
    // O(n^2) trend (which would be 16x for a 4x n increase).
    const ratio = tLarge / tSmall;
    expect(ratio).toBeLessThan(12);
  });
});
