// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview E2E Latency Graph Component
 *
 * Displays end-to-end latency (capture to display) as a line graph.
 * Shows both raw E2E (blue) and corrected E2E (green) when clock offset is available.
 *
 * Raw E2E = now_subscriber - captureTime_publisher (includes clock skew)
 * Corrected E2E = rawE2E - clockOffset (octoping-corrected, accurate)
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
  clockOffset?: number;
  correctedE2e?: number;
}

interface E2ELatencyGraphProps {
  subscriptionId: number;
  onLatencyStats: (handler: (data: { subscriptionId: number; stats: LatencyStatsSample }) => void) => () => void;
  targetLatency?: number;
}

const MAX_SAMPLES = 60;
const GRAPH_HEIGHT = 60;

export const E2ELatencyGraph: React.FC<E2ELatencyGraphProps> = ({ subscriptionId, onLatencyStats, targetLatency = 100 }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rawE2eSamplesRef = useRef<number[]>([]);
  const correctedE2eSamplesRef = useRef<(number | null)[]>([]);
  const clockOffsetRef = useRef<number | null>(null);
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

    const rawSamples = rawE2eSamplesRef.current;
    const correctedSamples = correctedE2eSamplesRef.current;

    // Clear canvas
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(0, 0, displayWidth, displayHeight);

    if (rawSamples.length === 0) {
      rafIdRef.current = requestAnimationFrame(draw);
      needsDrawRef.current = false;
      return;
    }

    // Compute max for scaling (consider both raw and corrected)
    const allValues = [...rawSamples, ...correctedSamples.filter((v): v is number => v !== null)];
    const maxValue = Math.max(Math.max(...allValues), targetLatency * 2, 100);
    const pointGap = displayWidth / MAX_SAMPLES;
    const startX = displayWidth - rawSamples.length * pointGap;

    // Draw target latency threshold line
    const thresholdY = displayHeight - (targetLatency / maxValue) * (displayHeight - 16) - 4;
    if (thresholdY > 12 && thresholdY < displayHeight - 4) {
      ctx.strokeStyle = 'rgba(34, 197, 94, 0.3)';
      ctx.setLineDash([2, 2]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, thresholdY);
      ctx.lineTo(displayWidth, thresholdY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw raw E2E latency line (blue, dashed if corrected available)
    const hasCorrected = correctedSamples.some(v => v !== null);
    ctx.strokeStyle = hasCorrected ? 'rgba(59, 130, 246, 0.5)' : '#3b82f6';
    ctx.lineWidth = hasCorrected ? 1 : 1.5;
    if (hasCorrected) ctx.setLineDash([3, 3]);
    ctx.beginPath();

    rawSamples.forEach((value, i) => {
      const x = startX + i * pointGap;
      const y = displayHeight - 4 - (value / maxValue) * (displayHeight - 16);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw corrected E2E latency line (green, solid) if available
    if (hasCorrected) {
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 1.5;
      ctx.beginPath();

      let started = false;
      correctedSamples.forEach((value, i) => {
        if (value === null) return;
        const x = startX + i * pointGap;
        const y = displayHeight - 4 - (value / maxValue) * (displayHeight - 16);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();

      // Draw dots on corrected line
      ctx.fillStyle = '#22c55e';
      correctedSamples.forEach((value, i) => {
        if (value === null) return;
        const x = startX + i * pointGap;
        const y = displayHeight - 4 - (value / maxValue) * (displayHeight - 16);
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
      });
    } else {
      // Draw dots on raw line when no corrected data
      ctx.fillStyle = '#3b82f6';
      rawSamples.forEach((value, i) => {
        const x = startX + i * pointGap;
        const y = displayHeight - 4 - (value / maxValue) * (displayHeight - 16);
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // Draw current value label
    const latestRaw = rawSamples[rawSamples.length - 1];
    const latestCorrected = correctedSamples[correctedSamples.length - 1];
    ctx.font = '10px monospace';
    if (latestCorrected !== null) {
      ctx.fillStyle = '#22c55e';
      ctx.fillText(`${latestCorrected.toFixed(0)}ms`, 4, 12);
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.fillText(`${latestRaw.toFixed(0)}ms`, 4, 12);
    }

    needsDrawRef.current = false;
    rafIdRef.current = requestAnimationFrame(draw);
  }, [targetLatency]);

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

      // Raw E2E = queuing + baseline (reconstructed from min-delay heuristic)
      if (data.stats.queuingDelay !== undefined && data.stats.baselineDelay !== undefined) {
        const rawE2e = data.stats.queuingDelay + data.stats.baselineDelay;
        rawE2eSamplesRef.current.push(rawE2e);

        // Corrected E2E from octoping clock offset (if available)
        if (data.stats.correctedE2e !== undefined) {
          correctedE2eSamplesRef.current.push(data.stats.correctedE2e);
        } else {
          correctedE2eSamplesRef.current.push(null);
        }

        // Track clock offset
        if (data.stats.clockOffset !== undefined) {
          clockOffsetRef.current = data.stats.clockOffset;
        }

        if (rawE2eSamplesRef.current.length > MAX_SAMPLES) {
          rawE2eSamplesRef.current.shift();
          correctedE2eSamplesRef.current.shift();
        }

        needsDrawRef.current = true;
      }
    });

    return unsubscribe;
  }, [subscriptionId, onLatencyStats]);

  // Get latest stats for display
  const rawSamples = rawE2eSamplesRef.current;
  const correctedSamples = correctedE2eSamplesRef.current;
  const clockOffset = clockOffsetRef.current;
  const latestRaw = rawSamples.length > 0 ? rawSamples[rawSamples.length - 1] : 0;
  const latestCorrected = correctedSamples.length > 0 ? correctedSamples[correctedSamples.length - 1] : null;
  const hasCorrected = latestCorrected !== null;
  const displayValue = hasCorrected ? latestCorrected : latestRaw;
  const avgRaw = rawSamples.length > 0 ? rawSamples.reduce((a, b) => a + b, 0) / rawSamples.length : 0;
  const validCorrected = correctedSamples.filter((v): v is number => v !== null);
  const avgCorrected = validCorrected.length > 0 ? validCorrected.reduce((a, b) => a + b, 0) / validCorrected.length : null;
  const minRaw = rawSamples.length > 0 ? Math.min(...rawSamples) : 0;
  const maxRaw = rawSamples.length > 0 ? Math.max(...rawSamples) : 0;

  return (
    <div className="bg-gray-800 rounded p-2">
      <div className="flex items-center justify-between mb-1">
        <span
          className="text-xs text-gray-400 cursor-help"
          title={hasCorrected
            ? "Corrected E2E = rawE2E - clockOffset (octoping). Green line shows accurate latency."
            : "Raw E2E = t_display - t_capture. Includes clock skew between machines."
          }
        >
          E2E Latency
          {hasCorrected ? (
            <span className="text-green-500 ml-1">(corrected)</span>
          ) : (
            <span className="text-gray-500 ml-1">(raw)</span>
          )}
        </span>
        <span className="text-xs font-mono">
          <span className={`${displayValue <= targetLatency ? 'text-green-400' : displayValue <= targetLatency * 2 ? 'text-yellow-400' : 'text-red-400'}`}>
            {displayValue.toFixed(0)}ms
          </span>
          <span className="text-gray-500 ml-2">
            avg: {(avgCorrected ?? avgRaw).toFixed(0)}ms
          </span>
        </span>
      </div>
      <canvas
        ref={canvasRef}
        className="w-full rounded"
        style={{ height: GRAPH_HEIGHT }}
      />
      <div className="flex items-center justify-between mt-1 text-xs text-gray-500">
        <span>min: {minRaw.toFixed(0)}ms / max: {maxRaw.toFixed(0)}ms</span>
        {clockOffset !== null ? (
          <span
            className="text-green-500 cursor-help"
            title={`Clock offset computed via octoping: subscriber clock is ${clockOffset > 0 ? 'ahead' : 'behind'} by ${Math.abs(clockOffset)}ms`}
          >
            skew: {clockOffset > 0 ? '+' : ''}{clockOffset}ms
          </span>
        ) : (
          <span
            className="text-yellow-500 cursor-help"
            title="No clock offset in LOC header. Showing raw E2E which includes clock skew."
          >
            *uncorrected
          </span>
        )}
      </div>
    </div>
  );
};
