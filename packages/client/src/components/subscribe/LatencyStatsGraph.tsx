// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Latency Stats Graph Component
 *
 * Displays queuing delay (bars), jitter (orange line), and baseline reference.
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
  queuingDelay?: number;
  baselineDelay?: number;
  jitter?: number;
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
const GRAPH_HEIGHT = 60;
/** Bar width in pixels */
const BAR_WIDTH = 3;
/** Gap between bars */
const BAR_GAP = 1;

export const LatencyStatsGraph: React.FC<LatencyStatsGraphProps> = ({ subscriptionId, onLatencyStats, targetLatency = 100 }) => {
  const greenThreshold = targetLatency;
  const yellowThreshold = targetLatency * 2;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const queuingSamplesRef = useRef<number[]>([]);
  const jitterSamplesRef = useRef<number[]>([]);
  const baselineRef = useRef<number | null>(null);
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

    const queuing = queuingSamplesRef.current;
    const jitters = jitterSamplesRef.current;
    const baseline = baselineRef.current;

    // Clear canvas
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(0, 0, canvasWidth, GRAPH_HEIGHT);

    if (queuing.length === 0) {
      rafIdRef.current = requestAnimationFrame(draw);
      needsDrawRef.current = false;
      return;
    }

    // Compute max for scaling (consider both queuing and jitter)
    const maxQueuing = Math.max(...queuing, 50);
    const maxJitter = jitters.length > 0 ? Math.max(...jitters, 20) : 20;
    const maxValue = Math.min(500, Math.max(maxQueuing, maxJitter));
    const startX = canvasWidth - queuing.length * (BAR_WIDTH + BAR_GAP);

    // Draw queuing delay bars
    queuing.forEach((value, i) => {
      const barHeight = Math.max(2, (value / maxValue) * (GRAPH_HEIGHT - 12));
      const x = startX + i * (BAR_WIDTH + BAR_GAP);
      const y = GRAPH_HEIGHT - barHeight - 2;

      if (value <= greenThreshold) {
        ctx.fillStyle = '#22c55e'; // green
      } else if (value <= yellowThreshold) {
        ctx.fillStyle = '#eab308'; // yellow
      } else {
        ctx.fillStyle = '#ef4444'; // red
      }

      ctx.fillRect(x, y, BAR_WIDTH, barHeight);
    });

    // Draw jitter line overlay (orange)
    if (jitters.length > 1) {
      ctx.strokeStyle = '#f97316'; // orange
      ctx.lineWidth = 1.5;
      ctx.beginPath();

      jitters.forEach((jitter, i) => {
        const x = startX + i * (BAR_WIDTH + BAR_GAP) + BAR_WIDTH / 2;
        const y = GRAPH_HEIGHT - 4 - (jitter / maxValue) * (GRAPH_HEIGHT - 12);
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });

      ctx.stroke();
    }

    // Draw baseline reference line (dashed white) at bottom with label
    if (baseline !== null) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.font = '9px monospace';
      ctx.fillText(`baseline: ${baseline.toFixed(0)}ms`, 4, 10);
    }

    // Draw target threshold line
    const thresholdY = GRAPH_HEIGHT - (greenThreshold / maxValue) * (GRAPH_HEIGHT - 12) - 2;
    if (thresholdY > 12 && thresholdY < GRAPH_HEIGHT - 2) {
      ctx.strokeStyle = 'rgba(34, 197, 94, 0.3)';
      ctx.setLineDash([2, 2]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, thresholdY);
      ctx.lineTo(canvasWidth, thresholdY);
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

      // Track queuing delay
      if (data.stats.queuingDelay !== undefined) {
        queuingSamplesRef.current.push(data.stats.queuingDelay);
      } else {
        queuingSamplesRef.current.push(data.stats.processingDelay);
      }

      // Track jitter
      if (data.stats.jitter !== undefined) {
        jitterSamplesRef.current.push(data.stats.jitter);
      } else {
        jitterSamplesRef.current.push(0);
      }

      // Track baseline
      if (data.stats.baselineDelay !== undefined) {
        baselineRef.current = data.stats.baselineDelay;
      }

      // Track dropped/out-of-order frames
      if (data.stats.framesDropped !== undefined) {
        droppedRef.current.total = data.stats.framesDropped;
      }
      if (data.stats.framesDroppedBeforeKeyframe !== undefined) {
        droppedRef.current.beforeKeyframe = data.stats.framesDroppedBeforeKeyframe;
      }
      if (data.stats.framesOutOfOrder !== undefined) {
        droppedRef.current.outOfOrder = data.stats.framesOutOfOrder;
      }

      if (queuingSamplesRef.current.length > MAX_SAMPLES) {
        queuingSamplesRef.current.shift();
        jitterSamplesRef.current.shift();
      }

      needsDrawRef.current = true;
    });

    return unsubscribe;
  }, [subscriptionId, onLatencyStats]);

  // Get latest stats for display
  const queuing = queuingSamplesRef.current;
  const jitters = jitterSamplesRef.current;
  const baseline = baselineRef.current;
  const latestQueuing = queuing.length > 0 ? queuing[queuing.length - 1] : 0;
  const latestJitter = jitters.length > 0 ? jitters[jitters.length - 1] : 0;
  const avgQueuing = queuing.length > 0 ? queuing.reduce((a, b) => a + b, 0) / queuing.length : 0;
  const dropped = droppedRef.current;
  const totalDropped = dropped.total + dropped.beforeKeyframe;

  return (
    <div className="bg-gray-800 rounded p-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-400" title="Queuing delay above baseline (clock-skew corrected)">
          Queuing Delay
        </span>
        <span className="text-xs font-mono">
          <span className={`${latestQueuing <= greenThreshold ? 'text-green-400' : latestQueuing <= yellowThreshold ? 'text-yellow-400' : 'text-red-400'}`}>
            {latestQueuing.toFixed(0)}ms
          </span>
          <span className="text-gray-500 ml-2">avg: {avgQueuing.toFixed(0)}ms</span>
          <span className="text-orange-400 ml-2" title="Inter-frame jitter">j: {latestJitter.toFixed(0)}ms</span>
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
          <span className="text-green-400">Bars</span>: queuing
          <span className="text-orange-400 ml-2">Line</span>: jitter
        </span>
        <div>
          {baseline !== null && (
            <span className="text-gray-400 mr-2" title="Minimum observed delay (includes clock offset)">
              base: {baseline.toFixed(0)}ms
            </span>
          )}
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
