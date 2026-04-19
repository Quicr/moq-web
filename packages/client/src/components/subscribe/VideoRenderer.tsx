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
  enableDiagnostics = false,
  onMetricsUpdate,
  framerate = 30,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastRenderedFrameRef = useRef<VideoFrame | null>(null);
  const [hasReceivedFrame, setHasReceivedFrame] = useState(false);
  const [canvasDimensions, setCanvasDimensions] = useState({ width: 1280, height: 720 });

  // B-frame reorder buffer - sort frames by timestamp before rendering
  const reorderBufferRef = useRef<VideoFrame[]>([]);
  const REORDER_BUFFER_SIZE = 3; // Buffer 3 frames to allow B-frame reordering

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

  // Render frame with B-frame reordering
  useEffect(() => {
    if (!frame) return;

    // Check if frame is valid
    try {
      void frame.codedWidth;
    } catch {
      metricsRef.current.framesDropped++;
      return;
    }

    // Add to reorder buffer
    const buffer = reorderBufferRef.current;
    buffer.push(frame);

    // Sort buffer by timestamp (presentation order)
    buffer.sort((a, b) => a.timestamp - b.timestamp);

    // Only render when buffer has enough frames
    if (buffer.length < REORDER_BUFFER_SIZE) {
      return;
    }

    // Take the oldest frame (lowest timestamp)
    const frameToRender = buffer.shift()!;

    const canvas = canvasRef.current;
    if (!canvas) {
      try { frameToRender.close(); } catch { /* ignore */ }
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      try { frameToRender.close(); } catch { /* ignore */ }
      return;
    }

    // Update canvas size to match frame if needed
    const frameWidth = frameToRender.displayWidth || frameToRender.codedWidth;
    const frameHeight = frameToRender.displayHeight || frameToRender.codedHeight;

    if (canvas.width !== frameWidth || canvas.height !== frameHeight) {
      canvas.width = frameWidth;
      canvas.height = frameHeight;
      setCanvasDimensions({ width: frameWidth, height: frameHeight });
    }

    // Draw the frame
    try {
      ctx.drawImage(frameToRender, 0, 0);
      metricsRef.current.framesRendered++;
      metricsRef.current.framesQueued = buffer.length;

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
      const frameTs = frameToRender.timestamp;
      if (lastFrameTimestampRef.current > 0 && frameTs > 0) {
        const tsDiff = frameTs - lastFrameTimestampRef.current;
        if (tsDiff < 0) {
          metricsRef.current.frameJumps++;
          metricsRef.current.backwardJumps++;
          if (enableDiagnostics && metricsRef.current.backwardJumps <= 5) {
            console.warn('[VideoRenderer] BACKWARD jump', {
              previousTs: lastFrameTimestampRef.current,
              currentTs: frameTs,
              diff: tsDiff / 1000,
            });
          }
        } else if (tsDiff > FRAME_JUMP_THRESHOLD_MS) {
          metricsRef.current.frameJumps++;
          metricsRef.current.forwardJumps++;
          if (enableDiagnostics && metricsRef.current.forwardJumps <= 5) {
            console.warn('[VideoRenderer] FORWARD jump (>100ms)', {
              previousTs: lastFrameTimestampRef.current,
              currentTs: frameTs,
              diff: tsDiff / 1000,
            });
          }
        }
      }
      lastFrameTimestampRef.current = frameTs;
      metricsRef.current.lastFrameTimestamp = frameTs;
      metricsRef.current.targetFps = framerate;

      if (!hasReceivedFrame) {
        setHasReceivedFrame(true);
      }

      // Close the previous frame AFTER successfully drawing the new one
      if (lastRenderedFrameRef.current && lastRenderedFrameRef.current !== frameToRender) {
        try {
          lastRenderedFrameRef.current.close();
        } catch {
          // Frame may already be closed
        }
      }
      lastRenderedFrameRef.current = frameToRender;

      // Log stats every 30 frames
      if (enableDiagnostics && metricsRef.current.framesRendered % 30 === 0) {
        console.log('[VideoRenderer] Stats', {
          rendered: metricsRef.current.framesRendered,
          dropped: metricsRef.current.framesDropped,
          jumps: `${metricsRef.current.backwardJumps}↓ ${metricsRef.current.forwardJumps}↑`,
          avgInterval: metricsRef.current.avgRenderInterval.toFixed(1) + 'ms',
          targetInterval: (1000 / framerate).toFixed(1) + 'ms',
          timestamp: frameTs,
          reorderBuffer: buffer.length,
        });
      }

      // Report metrics
      if (onMetricsUpdate) {
        onMetricsUpdate({ ...metricsRef.current });
      }
    } catch (err) {
      console.error('[VideoRenderer] Error drawing frame', err);
      try { frameToRender.close(); } catch { /* ignore */ }
    }
  }, [frame, enableDiagnostics, onMetricsUpdate, framerate, hasReceivedFrame]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (lastRenderedFrameRef.current) {
        try { lastRenderedFrameRef.current.close(); } catch { /* ignore */ }
      }
      // Clean up reorder buffer
      for (const f of reorderBufferRef.current) {
        try { f.close(); } catch { /* ignore */ }
      }
      reorderBufferRef.current = [];
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
