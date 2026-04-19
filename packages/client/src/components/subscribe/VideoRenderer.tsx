// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Video Renderer Component
 *
 * Simple canvas-based renderer for WebCodecs VideoFrames.
 * Renders frames immediately as they arrive - trusts upstream (PlayoutBuffer)
 * for ordering and pacing.
 */

import React, { useRef, useEffect, useState } from 'react';

/** Diagnostic metrics for frame rendering */
export interface VideoRendererMetrics {
  framesRendered: number;
  framesDropped: number;
  framesQueued: number;
  framesReordered: number;
  framesWithoutTimestamp: number;
  avgRenderInterval: number;
  lastFrameTimestamp: number;
  frameJumps: number;
  backwardJumps: number;
  forwardJumps: number;
  targetFps: number;
}

interface VideoRendererProps {
  /** The VideoFrame to render */
  frame: VideoFrame | null;
  /** Optional width override */
  width?: number;
  /** Optional height override */
  height?: number;
  /** Optional className for styling */
  className?: string;
  /** Enable diagnostic logging */
  enableDiagnostics?: boolean;
  /** Callback for metrics updates */
  onMetricsUpdate?: (metrics: VideoRendererMetrics) => void;
  /** Framerate from catalog for diagnostics (default: 30) */
  framerate?: number;
}

/**
 * VideoRenderer Component
 *
 * Simple renderer that draws frames immediately as they arrive.
 * Upstream PlayoutBuffer handles ordering and pacing.
 */
export const VideoRenderer: React.FC<VideoRendererProps> = ({
  frame,
  width,
  height: _height,
  className = '',
  enableDiagnostics: _enableDiagnostics = false,
  onMetricsUpdate,
  framerate = 30,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastRenderedFrameRef = useRef<VideoFrame | null>(null);
  const [hasReceivedFrame, setHasReceivedFrame] = useState(false);
  const [canvasDimensions, setCanvasDimensions] = useState({ width: 1280, height: 720 });

  // Diagnostic metrics refs
  const metricsRef = useRef<VideoRendererMetrics>({
    framesRendered: 0,
    framesDropped: 0,
    framesQueued: 0,
    framesReordered: 0,
    framesWithoutTimestamp: 0,
    avgRenderInterval: 0,
    lastFrameTimestamp: 0,
    frameJumps: 0,
    backwardJumps: 0,
    forwardJumps: 0,
    targetFps: framerate,
  });
  const lastRenderTimeRef = useRef<number>(0);
  const renderIntervalsRef = useRef<number[]>([]);
  const lastFrameTimestampRef = useRef<number>(0);

  const FRAME_JUMP_THRESHOLD_MS = 100000; // 100ms in microseconds

  // Render frame immediately when it arrives
  useEffect(() => {
    if (!frame) return;

    const canvas = canvasRef.current;
    if (!canvas) {
      try { frame.close(); } catch { /* ignore */ }
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      try { frame.close(); } catch { /* ignore */ }
      return;
    }

    // Check if frame is valid
    try {
      void frame.codedWidth;
    } catch {
      metricsRef.current.framesDropped++;
      return;
    }

    // Update canvas size to match frame if needed
    const frameWidth = frame.displayWidth || frame.codedWidth;
    const frameHeight = frame.displayHeight || frame.codedHeight;

    if (canvas.width !== frameWidth || canvas.height !== frameHeight) {
      canvas.width = frameWidth;
      canvas.height = frameHeight;
      setCanvasDimensions({ width: frameWidth, height: frameHeight });
    }

    // Draw the frame
    try {
      ctx.drawImage(frame, 0, 0);
      metricsRef.current.framesRendered++;

      // Track render intervals for diagnostics
      const now = performance.now();
      if (lastRenderTimeRef.current > 0) {
        const interval = now - lastRenderTimeRef.current;
        renderIntervalsRef.current.push(interval);
        if (renderIntervalsRef.current.length > 30) {
          renderIntervalsRef.current.shift();
        }
        const avgInterval = renderIntervalsRef.current.reduce((a, b) => a + b, 0) / renderIntervalsRef.current.length;
        metricsRef.current.avgRenderInterval = avgInterval;
      }
      lastRenderTimeRef.current = now;

      // Detect frame jumps (non-sequential timestamps)
      const frameTs = frame.timestamp;
      if (lastFrameTimestampRef.current > 0 && frameTs > 0) {
        const tsDiff = frameTs - lastFrameTimestampRef.current;
        if (tsDiff < 0) {
          metricsRef.current.frameJumps++;
          metricsRef.current.backwardJumps++;
        } else if (tsDiff > FRAME_JUMP_THRESHOLD_MS) {
          metricsRef.current.frameJumps++;
          metricsRef.current.forwardJumps++;
        }
      }
      lastFrameTimestampRef.current = frameTs;
      metricsRef.current.lastFrameTimestamp = frameTs;
      metricsRef.current.targetFps = framerate;

      if (!hasReceivedFrame) {
        setHasReceivedFrame(true);
      }

      // Close the previous frame AFTER successfully drawing the new one
      if (lastRenderedFrameRef.current && lastRenderedFrameRef.current !== frame) {
        try {
          lastRenderedFrameRef.current.close();
        } catch {
          // Frame may already be closed
        }
      }
      lastRenderedFrameRef.current = frame;

      // Report metrics
      if (onMetricsUpdate) {
        onMetricsUpdate({ ...metricsRef.current });
      }
    } catch (err) {
      console.error('[VideoRenderer] Error drawing frame', err);
      try { frame.close(); } catch { /* ignore */ }
    }
  }, [frame, onMetricsUpdate, framerate, hasReceivedFrame]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (lastRenderedFrameRef.current) {
        try { lastRenderedFrameRef.current.close(); } catch { /* ignore */ }
      }
    };
  }, []);

  // Calculate dimensions for responsive sizing
  const aspectRatio = canvasDimensions.width / canvasDimensions.height;

  return (
    <div
      ref={containerRef}
      className={`video-container relative overflow-hidden bg-gray-100 dark:bg-gray-800 rounded-lg ${className}`}
      style={{
        width: width || '100%',
        paddingBottom: `${(1 / aspectRatio) * 100}%`,
        position: 'relative',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: hasReceivedFrame ? 'block' : 'none',
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
        }}
      />
      {!hasReceivedFrame && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center text-gray-400">
            <svg
              className="w-12 h-12 mx-auto mb-2 animate-pulse"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <p className="text-sm">Waiting for video...</p>
          </div>
        </div>
      )}
    </div>
  );
};
