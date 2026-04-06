// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Jitter Graph Component
 *
 * Lightweight scrolling bar graph showing network jitter.
 * Uses canvas with requestAnimationFrame for efficient rendering
 * without blocking media playback.
 */

import React, { useRef, useEffect, useCallback } from 'react';

interface JitterSample {
  interArrivalTimes: number[];
  avgJitter: number;
  maxJitter: number;
}

interface JitterGraphProps {
  /** Subscription ID for this graph */
  subscriptionId: number;
  /** Handler to register for jitter samples */
  onJitterSample: (handler: (data: { subscriptionId: number; sample: JitterSample }) => void) => () => void;
  /** Target latency from experience profile (used for color thresholds) */
  targetLatency?: number;
}

/** Number of samples to display in the graph */
const MAX_SAMPLES = 60;
/** Graph height in pixels */
const GRAPH_HEIGHT = 40;
/** Bar width in pixels */
const BAR_WIDTH = 3;
/** Gap between bars */
const BAR_GAP = 1;

export const JitterGraph: React.FC<JitterGraphProps> = ({ subscriptionId, onJitterSample, targetLatency = 100 }) => {
  // Color thresholds based on target latency (20% and 50% of target, with minimums)
  const greenThreshold = Math.max(10, targetLatency * 0.2);
  const yellowThreshold = Math.max(25, targetLatency * 0.5);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const samplesRef = useRef<number[]>([]);
  const rafIdRef = useRef<number | null>(null);
  const needsDrawRef = useRef(false);

  // Calculate canvas width based on max samples
  const canvasWidth = MAX_SAMPLES * (BAR_WIDTH + BAR_GAP);

  // Draw function using requestAnimationFrame
  const draw = useCallback(() => {
    if (!needsDrawRef.current) {
      rafIdRef.current = requestAnimationFrame(draw);
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      rafIdRef.current = requestAnimationFrame(draw);
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      rafIdRef.current = requestAnimationFrame(draw);
      return;
    }

    const samples = samplesRef.current;

    // Clear canvas
    ctx.fillStyle = '#1f2937'; // dark gray background
    ctx.fillRect(0, 0, canvasWidth, GRAPH_HEIGHT);

    if (samples.length === 0) {
      rafIdRef.current = requestAnimationFrame(draw);
      needsDrawRef.current = false;
      return;
    }

    // Find max for scaling (cap at 100ms for reasonable display)
    const maxVal = Math.min(100, Math.max(...samples, 10));

    // Draw bars from right to left (newest on right)
    const startX = canvasWidth - samples.length * (BAR_WIDTH + BAR_GAP);
    samples.forEach((value, i) => {
      const barHeight = Math.max(2, (value / maxVal) * (GRAPH_HEIGHT - 4));
      const x = startX + i * (BAR_WIDTH + BAR_GAP);
      const y = GRAPH_HEIGHT - barHeight - 2;

      // Color based on value relative to target latency
      if (value <= greenThreshold) {
        ctx.fillStyle = '#22c55e'; // green - low jitter
      } else if (value <= yellowThreshold) {
        ctx.fillStyle = '#eab308'; // yellow - moderate jitter
      } else {
        ctx.fillStyle = '#ef4444'; // red - high jitter
      }

      ctx.fillRect(x, y, BAR_WIDTH, barHeight);
    });

    // Draw scale line at yellow threshold
    const lineY = GRAPH_HEIGHT - (yellowThreshold / maxVal) * (GRAPH_HEIGHT - 4) - 2;
    if (lineY > 0 && lineY < GRAPH_HEIGHT) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(0, lineY);
      ctx.lineTo(canvasWidth, lineY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    needsDrawRef.current = false;
    rafIdRef.current = requestAnimationFrame(draw);
  }, [canvasWidth, greenThreshold, yellowThreshold]);

  // Start draw loop
  useEffect(() => {
    rafIdRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, [draw]);

  // Subscribe to jitter samples
  useEffect(() => {
    const unsubscribe = onJitterSample((data) => {
      if (data.subscriptionId !== subscriptionId) return;

      // Add new average jitter sample
      samplesRef.current.push(data.sample.avgJitter);

      // Keep only last MAX_SAMPLES
      if (samplesRef.current.length > MAX_SAMPLES) {
        samplesRef.current.shift();
      }

      // Mark for redraw
      needsDrawRef.current = true;
    });

    return unsubscribe;
  }, [subscriptionId, onJitterSample]);

  // Get latest stats for display
  const samples = samplesRef.current;
  const latestAvg = samples.length > 0 ? samples[samples.length - 1] : 0;
  const maxJitter = samples.length > 0 ? Math.max(...samples) : 0;

  return (
    <div className="bg-gray-800 rounded p-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-400">Jitter</span>
        <span className="text-xs font-mono">
          <span className={`${latestAvg <= greenThreshold ? 'text-green-400' : latestAvg <= yellowThreshold ? 'text-yellow-400' : 'text-red-400'}`}>
            {latestAvg.toFixed(1)}ms
          </span>
          <span className="text-gray-500 ml-2">max: {maxJitter.toFixed(1)}ms</span>
        </span>
      </div>
      <canvas
        ref={canvasRef}
        width={canvasWidth}
        height={GRAPH_HEIGHT}
        className="w-full rounded"
        style={{ imageRendering: 'pixelated' }}
      />
    </div>
  );
};
