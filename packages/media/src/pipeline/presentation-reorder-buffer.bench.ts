// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Micro-benchmarks for the presentation reorder buffer's
 * hot path (`push()`).  Baseline for detecting regressions in the
 * binary-search insertion introduced during the audit hardening.
 *
 * Run: `pnpm --filter @moq-web/media exec vitest bench --run
 * src/pipeline/presentation-reorder-buffer.bench.ts`.
 */

import { bench, describe } from 'vitest';
import { PresentationReorderBuffer } from './presentation-reorder-buffer.js';

function makeFrame(timestamp: number): VideoFrame {
  return {
    timestamp,
    close() { /* no-op */ },
  } as unknown as VideoFrame;
}

function newBuf(depth: number): PresentationReorderBuffer {
  return new PresentationReorderBuffer(
    () => { /* discard */ },
    { bufferDepth: depth, maxHoldTimeMs: 1_000_000, debug: false },
  );
}

describe('reorder buffer push (in-order arrival)', () => {
  bench('push 100 in-order frames (depth=4)', () => {
    const b = newBuf(4);
    for (let i = 0; i < 100; i++) b.push(makeFrame(i));
  });

  bench('push 1000 in-order frames (depth=4)', () => {
    const b = newBuf(4);
    for (let i = 0; i < 1000; i++) b.push(makeFrame(i));
  });
});

describe('reorder buffer push (adversarial reverse order)', () => {
  // Reverse-order pushes trigger worst-case O(n) splice on every insert —
  // this is the regression baseline for the binary-search insert.
  bench('push 100 reverse-order frames (depth=200)', () => {
    const b = newBuf(200);
    for (let i = 100; i >= 0; i--) b.push(makeFrame(i));
  });

  bench('push 500 reverse-order frames (depth=1000)', () => {
    const b = newBuf(1000);
    for (let i = 500; i >= 0; i--) b.push(makeFrame(i));
  });
});

describe('reorder buffer push (B-frame reorder pattern)', () => {
  // Realistic H.264 B-frame decode order — a small local reorder window
  // (typically 2-4 frames) with mostly forward progress.
  bench('push 1000 B-frame-reordered frames (depth=4)', () => {
    const b = newBuf(4);
    // Emit decode-order [I,P,B,B,P,B,B,...] with local reordering.
    for (let i = 0; i < 1000; i += 4) {
      b.push(makeFrame(i));       // I/P
      b.push(makeFrame(i + 3));   // next P (ahead in PTS)
      b.push(makeFrame(i + 1));   // B (behind)
      b.push(makeFrame(i + 2));   // B (behind)
    }
  });
});
