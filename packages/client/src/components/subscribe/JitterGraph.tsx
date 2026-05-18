// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Jitter Graph Component
 *
 * Lightweight scrolling bar graph showing network jitter.
 * Formula: jitter = avgVariation(interArrivalTimes)
 */

import React, { useRef, useEffect, useCallback } from 'react';

interface JitterSample {
  interArrivalTimes: number[];
  avgJitter: number;
  maxJitter: number;
}

interface JitterGraphProps {
  subscriptionId: number;
  onJitterSample: (handler: (data: { subscriptionId: number; sample: JitterSample }) => void) => () => void;
  targetLatency?: number;
}

const MAX_SAMPLES = 60;
const GRAPH_HEIGHT = 40;

export const JitterGraph: React.FC<JitterGraphProps> = ({ subscriptionId, onJitterSample, targetLatency = 100 }) => {
  const greenThreshold = Math.max(10, targetLatency * 0.2);
  const yellowThreshold = Math.max(25, targetLatency * 0.5);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const samplesRef = useRef<number[]>([]);
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

    const samples = samplesRef.current;

    // Clear canvas
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(0, 0, displayWidth, displayHeight);

    if (samples.length === 0) {
      rafIdRef.current = requestAnimationFrame(draw);
      needsDrawRef.current = false;
      return;
    }

    // Find max for scaling
    const maxVal = Math.min(100, Math.max(...samples, 10));

    const barWidth = (displayWidth / MAX_SAMPLES) * 0.75;
    const barGap = (displayWidth / MAX_SAMPLES) * 0.25;
    const startX = displayWidth - samples.length * (barWidth + barGap);

    // Draw bars from right to left
    samples.forEach((value, i) => {
      const barHeight = Math.max(2, (value / maxVal) * (displayHeight - 4));
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

    // Draw scale line at yellow threshold
    const lineY = displayHeight - (yellowThreshold / maxVal) * (displayHeight - 4) - 2;
    if (lineY > 0 && lineY < displayHeight) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.setLineDash([2, 2]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, lineY);
      ctx.lineTo(displayWidth, lineY);
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

  // Subscribe to jitter samples
  useEffect(() => {
    const unsubscribe = onJitterSample((data) => {
      if (data.subscriptionId !== subscriptionId) return;

      samplesRef.current.push(data.sample.avgJitter);

      if (samplesRef.current.length > MAX_SAMPLES) {
        samplesRef.current.shift();
      }

      needsDrawRef.current = true;
    });

    return unsubscribe;
  }, [subscriptionId, onJitterSample]);

  const samples = samplesRef.current;
  const latestAvg = samples.length > 0 ? samples[samples.length - 1] : 0;
  const maxJitter = samples.length > 0 ? Math.max(...samples) : 0;

  return (
    <div className="bg-gray-800 rounded p-2">
      <div className="flex items-center justify-between mb-1">
        <span
          className="text-xs text-gray-400 cursor-help"
          title="Network jitter: variation in packet inter-arrival times compared to expected interval"
        >
          Jitter <span className="text-gray-500">(arrival variance)</span>
        </span>
        <span className="text-xs font-mono">
          <span className={`${latestAvg <= greenThreshold ? 'text-green-400' : latestAvg <= yellowThreshold ? 'text-yellow-400' : 'text-red-400'}`}>
            {latestAvg.toFixed(1)}ms
          </span>
          <span className="text-gray-500 ml-2">max: {maxJitter.toFixed(1)}ms</span>
        </span>
      </div>
      <canvas
        ref={canvasRef}
        className="w-full rounded"
        style={{ height: GRAPH_HEIGHT }}
      />
    </div>
  );
};
