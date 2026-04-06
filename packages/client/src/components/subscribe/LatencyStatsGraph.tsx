// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Latency Stats Graph Component
 *
 * Displays end-to-end processing delay and jitter buffer depth.
 * Uses canvas with requestAnimationFrame for efficient rendering.
 */

import React, { useRef, useEffect, useCallback } from 'react';

interface LatencyStatsSample {
  processingDelay: number;
  bufferDepth: number;
  bufferDelay: number;
  framesDropped?: number;
  framesDroppedBeforeKeyframe?: number;
  framesOutOfOrder?: number;
}

interface LatencyStatsGraphProps {
  /** Subscription ID for this graph */
  subscriptionId: number;
  /** Handler to register for latency stats */
  onLatencyStats: (handler: (data: { subscriptionId: number; stats: LatencyStatsSample }) => void) => () => void;
  /** Target latency from experience profile (used for color thresholds) */
  targetLatency?: number;
}

/** Number of samples to display */
const MAX_SAMPLES = 60;
/** Graph height in pixels */
const GRAPH_HEIGHT = 50;
/** Bar width in pixels */
const BAR_WIDTH = 3;
/** Gap between bars */
const BAR_GAP = 1;

export const LatencyStatsGraph: React.FC<LatencyStatsGraphProps> = ({ subscriptionId, onLatencyStats, targetLatency = 100 }) => {
  // Color thresholds based on target latency
  const greenThreshold = targetLatency;
  const yellowThreshold = targetLatency * 2;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const delaySamplesRef = useRef<number[]>([]);
  const depthSamplesRef = useRef<number[]>([]);
  const droppedRef = useRef<{ total: number; beforeKeyframe: number; outOfOrder: number }>({ total: 0, beforeKeyframe: 0, outOfOrder: 0 });
  const rafIdRef = useRef<number | null>(null);
  const needsDrawRef = useRef(false);

  const canvasWidth = MAX_SAMPLES * (BAR_WIDTH + BAR_GAP);

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

    const delays = delaySamplesRef.current;
    const depths = depthSamplesRef.current;

    // Clear canvas
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(0, 0, canvasWidth, GRAPH_HEIGHT);

    if (delays.length === 0) {
      rafIdRef.current = requestAnimationFrame(draw);
      needsDrawRef.current = false;
      return;
    }

    // Draw delay bars (main metric - in ms)
    const maxDelay = Math.min(500, Math.max(...delays, 50));
    const startX = canvasWidth - delays.length * (BAR_WIDTH + BAR_GAP);

    delays.forEach((value, i) => {
      const barHeight = Math.max(2, (value / maxDelay) * (GRAPH_HEIGHT - 8));
      const x = startX + i * (BAR_WIDTH + BAR_GAP);
      const y = GRAPH_HEIGHT - barHeight - 2;

      // Color based on delay relative to target latency
      if (value <= greenThreshold) {
        ctx.fillStyle = '#22c55e'; // green - within target
      } else if (value <= yellowThreshold) {
        ctx.fillStyle = '#eab308'; // yellow - up to 2x target
      } else {
        ctx.fillStyle = '#ef4444'; // red - exceeds 2x target
      }

      ctx.fillRect(x, y, BAR_WIDTH, barHeight);
    });

    // Draw buffer depth line overlay (scale to fit)
    if (depths.length > 1) {
      const maxDepth = Math.max(...depths, 5);
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 1.5;
      ctx.beginPath();

      depths.forEach((depth, i) => {
        const x = startX + i * (BAR_WIDTH + BAR_GAP) + BAR_WIDTH / 2;
        const y = GRAPH_HEIGHT - 4 - (depth / maxDepth) * (GRAPH_HEIGHT - 12);
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });

      ctx.stroke();
    }

    // Draw reference line at target latency
    const lineY = GRAPH_HEIGHT - (greenThreshold / maxDelay) * (GRAPH_HEIGHT - 8) - 2;
    if (lineY > 0 && lineY < GRAPH_HEIGHT) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.setLineDash([2, 2]);
      ctx.lineWidth = 1;
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

  // Subscribe to latency stats
  useEffect(() => {
    const unsubscribe = onLatencyStats((data) => {
      if (data.subscriptionId !== subscriptionId) return;

      delaySamplesRef.current.push(data.stats.processingDelay);
      depthSamplesRef.current.push(data.stats.bufferDepth);

      // Track dropped/out-of-order frames (these are cumulative totals)
      if (data.stats.framesDropped !== undefined) {
        droppedRef.current.total = data.stats.framesDropped;
      }
      if (data.stats.framesDroppedBeforeKeyframe !== undefined) {
        droppedRef.current.beforeKeyframe = data.stats.framesDroppedBeforeKeyframe;
      }
      if (data.stats.framesOutOfOrder !== undefined) {
        droppedRef.current.outOfOrder = data.stats.framesOutOfOrder;
      }

      if (delaySamplesRef.current.length > MAX_SAMPLES) {
        delaySamplesRef.current.shift();
        depthSamplesRef.current.shift();
      }

      needsDrawRef.current = true;
    });

    return unsubscribe;
  }, [subscriptionId, onLatencyStats]);

  // Get latest stats for display
  const delays = delaySamplesRef.current;
  const depths = depthSamplesRef.current;
  const latestDelay = delays.length > 0 ? delays[delays.length - 1] : 0;
  const latestDepth = depths.length > 0 ? depths[depths.length - 1] : 0;
  const avgDelay = delays.length > 0 ? delays.reduce((a, b) => a + b, 0) / delays.length : 0;
  const dropped = droppedRef.current;
  const totalDropped = dropped.total + dropped.beforeKeyframe;

  return (
    <div className="bg-gray-800 rounded p-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-400">E2E Delay</span>
        <span className="text-xs font-mono">
          <span className={`${latestDelay <= greenThreshold ? 'text-green-400' : latestDelay <= yellowThreshold ? 'text-yellow-400' : 'text-red-400'}`}>
            {latestDelay.toFixed(0)}ms
          </span>
          <span className="text-gray-500 ml-2">avg: {avgDelay.toFixed(0)}ms</span>
          <span className="text-blue-400 ml-2">buf: {latestDepth}</span>
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
        <span>Bars: delay</span>
        <div>
          <span className="text-blue-400">Line: buf depth</span>
          {totalDropped > 0 && (
            <span className="text-red-400 ml-2" title={`Late: ${dropped.total}, Before KF: ${dropped.beforeKeyframe}`}>
              drop: {totalDropped}
            </span>
          )}
          {dropped.outOfOrder > 0 && (
            <span className="text-orange-400 ml-2" title="Frames decoded out of sequence order">
              ooo: {dropped.outOfOrder}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
