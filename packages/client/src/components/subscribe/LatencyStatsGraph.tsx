// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Latency Stats Graph Component
 *
 * Displays queuing delay (bars), jitter (orange line), and baseline reference.
 * Formula: queuingDelay = rawE2E - baseline
 * Where baseline = minimum observed E2E (approximates clock_skew + min_network_delay)
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
  subscriptionId: number;
  onLatencyStats: (handler: (data: { subscriptionId: number; stats: LatencyStatsSample }) => void) => () => void;
  targetLatency?: number;
}

const MAX_SAMPLES = 60;
const GRAPH_HEIGHT = 60;

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

    // Get actual display size from CSS layout
    const rect = canvas.getBoundingClientRect();
    const displayWidth = rect.width;
    const displayHeight = GRAPH_HEIGHT;
    const dpr = window.devicePixelRatio || 1;

    // Set canvas buffer size for sharp rendering
    const bufferWidth = Math.round(displayWidth * dpr);
    const bufferHeight = Math.round(displayHeight * dpr);
    if (canvas.width !== bufferWidth || canvas.height !== bufferHeight) {
      canvas.width = bufferWidth;
      canvas.height = bufferHeight;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const queuing = queuingSamplesRef.current;
    const jitters = jitterSamplesRef.current;
    const baseline = baselineRef.current;

    // Clear canvas
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(0, 0, displayWidth, displayHeight);

    if (queuing.length === 0) {
      rafIdRef.current = requestAnimationFrame(draw);
      needsDrawRef.current = false;
      return;
    }

    // Compute scaling
    const maxQueuing = Math.max(...queuing, 50);
    const maxJitter = jitters.length > 0 ? Math.max(...jitters, 20) : 20;
    const maxValue = Math.min(500, Math.max(maxQueuing, maxJitter));

    const barWidth = (displayWidth / MAX_SAMPLES) * 0.75;
    const barGap = (displayWidth / MAX_SAMPLES) * 0.25;
    const startX = displayWidth - queuing.length * (barWidth + barGap);

    // Draw queuing delay bars
    queuing.forEach((value, i) => {
      const barHeight = Math.max(2, (value / maxValue) * (displayHeight - 12));
      const x = startX + i * (barWidth + barGap);
      const y = displayHeight - barHeight - 2;

      if (value <= greenThreshold) {
        ctx.fillStyle = '#22c55e';
      } else if (value <= yellowThreshold) {
        ctx.fillStyle = '#eab308';
      } else {
        ctx.fillStyle = '#ef4444';
      }

      ctx.fillRect(x, y, barWidth, barHeight);
    });

    // Draw jitter line overlay (orange)
    if (jitters.length > 1) {
      ctx.strokeStyle = '#f97316';
      ctx.lineWidth = 1.5;
      ctx.beginPath();

      jitters.forEach((jitter, i) => {
        const x = startX + i * (barWidth + barGap) + barWidth / 2;
        const y = displayHeight - 4 - (jitter / maxValue) * (displayHeight - 12);
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });

      ctx.stroke();
    }

    // Draw baseline reference
    if (baseline !== null) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.font = '10px monospace';
      ctx.fillText(`baseline: ${baseline.toFixed(0)}ms`, 4, 12);
    }

    // Draw target threshold line
    const thresholdY = displayHeight - (greenThreshold / maxValue) * (displayHeight - 12) - 2;
    if (thresholdY > 12 && thresholdY < displayHeight - 2) {
      ctx.strokeStyle = 'rgba(34, 197, 94, 0.3)';
      ctx.setLineDash([2, 2]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, thresholdY);
      ctx.lineTo(displayWidth, thresholdY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    needsDrawRef.current = false;
    rafIdRef.current = requestAnimationFrame(draw);
  }, [greenThreshold, yellowThreshold]);

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

      if (data.stats.queuingDelay !== undefined) {
        queuingSamplesRef.current.push(data.stats.queuingDelay);
      } else {
        queuingSamplesRef.current.push(data.stats.processingDelay);
      }

      if (data.stats.jitter !== undefined) {
        jitterSamplesRef.current.push(data.stats.jitter);
      } else {
        jitterSamplesRef.current.push(0);
      }

      if (data.stats.baselineDelay !== undefined) {
        baselineRef.current = data.stats.baselineDelay;
      }

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
        <span
          className="text-xs text-gray-400 cursor-help"
          title="Queuing delay = E2E - baseline. Baseline = min(E2E) observed, which approximates clock_skew + min_network_delay. This cancels out clock skew, showing only variable delay (congestion, jitter buffer, etc)."
        >
          Queuing Delay <span className="text-gray-500">(e2e - min_e2e)</span>
        </span>
        <span className="text-xs font-mono">
          <span className={`${latestQueuing <= greenThreshold ? 'text-green-400' : latestQueuing <= yellowThreshold ? 'text-yellow-400' : 'text-red-400'}`}>
            {latestQueuing.toFixed(0)}ms
          </span>
          <span className="text-gray-500 ml-2">avg: {avgQueuing.toFixed(0)}ms</span>
          <span className="text-orange-400 ml-2" title="Inter-frame jitter: |e2e[n] - e2e[n-1]|">j: {latestJitter.toFixed(0)}ms</span>
        </span>
      </div>
      <canvas
        ref={canvasRef}
        className="w-full rounded"
        style={{ height: GRAPH_HEIGHT }}
      />
      <div className="flex items-center justify-between mt-1 text-xs text-gray-500">
        <span>
          <span className="text-green-400">Bars</span>: queuing
          <span className="text-orange-400 ml-2">Line</span>: jitter
        </span>
        <div>
          {baseline !== null && (
            <span
              className="text-gray-400 mr-2 cursor-help"
              title="Baseline = minimum E2E observed. Includes clock_skew + min_network_delay. Subtracted from E2E to get clock-corrected queuing delay."
            >
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
