// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview E2E Latency Graph Component
 *
 * Displays raw end-to-end latency (capture to display) as a line graph.
 * Note: This value includes clock skew between publisher and subscriber.
 * For clock-skew corrected delay, see LatencyStatsGraph (queuing delay).
 */

import React, { useRef, useEffect, useCallback } from 'react';

interface LatencyStatsSample {
  processingDelay: number;
  bufferDepth: number;
  bufferDelay: number;
  framesDropped?: number;
  framesDroppedBeforeKeyframe?: number;
  framesOutOfOrder?: number;
  queuingDelay?: number;
  baselineDelay?: number;
  jitter?: number;
}

interface E2ELatencyGraphProps {
  subscriptionId: number;
  onLatencyStats: (handler: (data: { subscriptionId: number; stats: LatencyStatsSample }) => void) => () => void;
  targetLatency?: number;
}

const MAX_SAMPLES = 60;
const GRAPH_HEIGHT = 60;
const POINT_GAP = 4;

export const E2ELatencyGraph: React.FC<E2ELatencyGraphProps> = ({ subscriptionId, onLatencyStats, targetLatency = 100 }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const e2eSamplesRef = useRef<number[]>([]);
  const rafIdRef = useRef<number | null>(null);
  const needsDrawRef = useRef(false);

  const canvasWidth = MAX_SAMPLES * POINT_GAP;

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

    const samples = e2eSamplesRef.current;

    // Clear canvas
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(0, 0, canvasWidth, GRAPH_HEIGHT);

    if (samples.length === 0) {
      rafIdRef.current = requestAnimationFrame(draw);
      needsDrawRef.current = false;
      return;
    }

    // Compute max for scaling
    const maxValue = Math.max(Math.max(...samples), targetLatency * 2, 100);
    const startX = canvasWidth - samples.length * POINT_GAP;

    // Draw target latency threshold line
    const thresholdY = GRAPH_HEIGHT - (targetLatency / maxValue) * (GRAPH_HEIGHT - 16) - 4;
    if (thresholdY > 12 && thresholdY < GRAPH_HEIGHT - 4) {
      ctx.strokeStyle = 'rgba(34, 197, 94, 0.3)';
      ctx.setLineDash([2, 2]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, thresholdY);
      ctx.lineTo(canvasWidth, thresholdY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw E2E latency line
    ctx.strokeStyle = '#3b82f6'; // blue
    ctx.lineWidth = 2;
    ctx.beginPath();

    samples.forEach((value, i) => {
      const x = startX + i * POINT_GAP;
      const y = GRAPH_HEIGHT - 4 - (value / maxValue) * (GRAPH_HEIGHT - 16);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });

    ctx.stroke();

    // Draw dots at each point
    ctx.fillStyle = '#3b82f6';
    samples.forEach((value, i) => {
      const x = startX + i * POINT_GAP;
      const y = GRAPH_HEIGHT - 4 - (value / maxValue) * (GRAPH_HEIGHT - 16);
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
    });

    // Draw current value label
    const latest = samples[samples.length - 1];
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.font = '9px monospace';
    ctx.fillText(`${latest.toFixed(0)}ms`, 4, 10);

    needsDrawRef.current = false;
    rafIdRef.current = requestAnimationFrame(draw);
  }, [canvasWidth, targetLatency]);

  // Start draw loop
  useEffect(() => {
    rafIdRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, [draw]);

  // Subscribe to latency stats
  useEffect(() => {
    const unsubscribe = onLatencyStats((data) => {
      if (data.subscriptionId !== subscriptionId) return;

      // Raw E2E = queuing + baseline (reconstructed)
      if (data.stats.queuingDelay !== undefined && data.stats.baselineDelay !== undefined) {
        const rawE2e = data.stats.queuingDelay + data.stats.baselineDelay;
        e2eSamplesRef.current.push(rawE2e);

        if (e2eSamplesRef.current.length > MAX_SAMPLES) {
          e2eSamplesRef.current.shift();
        }

        needsDrawRef.current = true;
      }
    });

    return unsubscribe;
  }, [subscriptionId, onLatencyStats]);

  // Get latest stats for display
  const samples = e2eSamplesRef.current;
  const latest = samples.length > 0 ? samples[samples.length - 1] : 0;
  const avg = samples.length > 0 ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
  const min = samples.length > 0 ? Math.min(...samples) : 0;
  const max = samples.length > 0 ? Math.max(...samples) : 0;

  return (
    <div className="bg-gray-800 rounded p-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-400" title="Raw end-to-end delay (capture to display). Includes clock skew between publisher and subscriber.">
          E2E Latency
          <span className="text-yellow-500 ml-1" title="Includes clock offset between machines">*</span>
        </span>
        <span className="text-xs font-mono">
          <span className={`${latest <= targetLatency ? 'text-green-400' : latest <= targetLatency * 2 ? 'text-yellow-400' : 'text-red-400'}`}>
            {latest.toFixed(0)}ms
          </span>
          <span className="text-gray-500 ml-2">avg: {avg.toFixed(0)}ms</span>
        </span>
      </div>
      <canvas
        ref={canvasRef}
        width={canvasWidth}
        height={GRAPH_HEIGHT}
        className="w-full rounded"
        style={{ imageRendering: 'pixelated' }}
      />
      <div className="flex items-center justify-between mt-1 text-xs text-gray-500">
        <span>
          min: {min.toFixed(0)}ms / max: {max.toFixed(0)}ms
        </span>
        <span className="text-yellow-500" title="Value includes clock skew between publisher and subscriber clocks">
          *uncorrected
        </span>
      </div>
    </div>
  );
};
