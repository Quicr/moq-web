// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Synthetic MediaStream source: a canvas painted at a fixed framerate.
 *
 * Each frame draws a color that ramps through the palette so subscribers
 * can, in principle, sanity-check that frames arrive in order. The primary
 * job here is producing a real MediaStreamTrack that MediaSession.publish
 * can consume — we don't need real content.
 */

export interface SyntheticVideoOptions {
  width: number;
  height: number;
  framerate: number;
}

export interface SyntheticVideo {
  stream: MediaStream;
  canvas: HTMLCanvasElement;
  /** Stop drawing and end the MediaStream track. */
  stop(): void;
}

const PALETTE = [
  '#e57373', '#f06292', '#ba68c8', '#9575cd',
  '#7986cb', '#64b5f6', '#4fc3f7', '#4dd0e1',
  '#4db6ac', '#81c784', '#aed581', '#dce775',
  '#fff176', '#ffd54f', '#ffb74d', '#ff8a65',
];

export function createSyntheticVideo(opts: SyntheticVideoOptions): SyntheticVideo {
  const canvas = document.createElement('canvas');
  canvas.width = opts.width;
  canvas.height = opts.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('failed to acquire 2d canvas context');

  let frameIndex = 0;
  let stopped = false;

  const draw = () => {
    if (stopped) return;
    ctx.fillStyle = PALETTE[frameIndex % PALETTE.length]!;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    ctx.font = `${Math.floor(canvas.height / 6)}px sans-serif`;
    ctx.fillText(String(frameIndex), 20, canvas.height / 2);
    frameIndex++;
  };

  draw();
  const interval = setInterval(draw, Math.max(1, Math.round(1000 / opts.framerate)));

  const stream = (canvas as HTMLCanvasElement & { captureStream: (fps?: number) => MediaStream }).captureStream(opts.framerate);

  return {
    stream,
    canvas,
    stop() {
      stopped = true;
      clearInterval(interval);
      for (const t of stream.getTracks()) {
        t.stop();
      }
    },
  };
}
