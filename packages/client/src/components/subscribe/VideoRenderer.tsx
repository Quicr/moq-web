// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Video Renderer Component
 *
 * Simple canvas-based renderer for WebCodecs VideoFrames.
 * Renders frames immediately as they arrive - trusts upstream (PlayoutBuffer)
 * for ordering and pacing.
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';

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
  /** The VideoFrame to render (legacy prop-based mode) */
  frame?: VideoFrame | null;
  /** Frame getter function for high-frequency updates (preferred for 60fps) */
  getFrame?: () => VideoFrame | null;
  /** Subscription ID for frame queue (used with useVideoFrameQueue) */
  subscriptionId?: number;
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
  /** Whether content is live (affects frame drain strategy) */
  isLive?: boolean;
}

/**
 * VideoRenderer Component
 *
 * Simple renderer that draws frames immediately as they arrive.
 * Upstream PlayoutBuffer handles ordering and pacing.
 */
export const VideoRenderer: React.FC<VideoRendererProps> = ({
  frame: frameProp,
  getFrame,
  subscriptionId: _subscriptionId,
  width,
  height: _height,
  className = '',
  enableDiagnostics: _enableDiagnostics = false,
  onMetricsUpdate,
  framerate = 30,
  isLive = true,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastRenderedFrameRef = useRef<VideoFrame | null>(null);
  const [hasReceivedFrame, setHasReceivedFrame] = useState(false);
  const [canvasDimensions, setCanvasDimensions] = useState({ width: 1280, height: 720 });
  const rafRef = useRef<number | null>(null);
  const isRafModeRef = useRef(false);
  const isLiveRef = useRef(isLive);

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

  // Canvas context ref — cached to avoid getContext() per frame
  const ctxRef = useRef<CanvasRenderingContext2D | ImageBitmapRenderingContext | null>(null);
  const useBitmapRenderer = useRef(false);

  // Shared render function for both modes
  const renderFrame = useCallback((frame: VideoFrame): boolean => {
    const canvas = canvasRef.current;
    if (!canvas) {
      try { frame.close(); } catch { /* ignore */ }
      return false;
    }

    // Check if frame is valid
    try {
      void frame.codedWidth;
    } catch {
      metricsRef.current.framesDropped++;
      return false;
    }

    const frameWidth = frame.displayWidth || frame.codedWidth;
    const frameHeight = frame.displayHeight || frame.codedHeight;

    // Set canvas to native frame size — CSS handles display scaling.
    // With bitmaprenderer, the GPU composites directly without CPU involvement.
    if (canvas.width !== frameWidth || canvas.height !== frameHeight) {
      canvas.width = frameWidth;
      canvas.height = frameHeight;
      setCanvasDimensions({ width: frameWidth, height: frameHeight });
      // Reset context ref on resize
      ctxRef.current = null;
    }

    // Initialize context (prefer bitmaprenderer for zero-copy GPU path)
    if (!ctxRef.current) {
      const bitmapCtx = canvas.getContext('bitmaprenderer');
      if (bitmapCtx) {
        ctxRef.current = bitmapCtx;
        useBitmapRenderer.current = true;
      } else {
        ctxRef.current = canvas.getContext('2d');
        useBitmapRenderer.current = false;
      }
    }

    if (!ctxRef.current) {
      try { frame.close(); } catch { /* ignore */ }
      return false;
    }

    try {
      if (useBitmapRenderer.current) {
        // Hardware-accelerated path: VideoFrame → ImageBitmap → GPU composite
        // createImageBitmap with a VideoFrame is a zero-copy GPU operation in
        // Chrome/Edge when the frame is hardware-decoded.
        createImageBitmap(frame).then((bitmap) => {
          const ctx = ctxRef.current as ImageBitmapRenderingContext;
          if (ctx) {
            ctx.transferFromImageBitmap(bitmap);
          }
        });
      } else {
        // Fallback: 2D canvas drawImage
        const ctx = ctxRef.current as CanvasRenderingContext2D;
        ctx.drawImage(frame, 0, 0);
      }

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

      // Report metrics at ~1fps to avoid per-frame callback overhead
      if (onMetricsUpdate && metricsRef.current.framesRendered % 60 === 0) {
        onMetricsUpdate({ ...metricsRef.current });
      }

      return true;
    } catch (err) {
      console.error('[VideoRenderer] Error drawing frame', err);
      try { frame.close(); } catch { /* ignore */ }
      return false;
    }
  }, [framerate, hasReceivedFrame, onMetricsUpdate]);

  // Store getFrame and isLive in refs so RAF loop doesn't restart when parent re-renders
  const getFrameRef = useRef(getFrame);
  useEffect(() => {
    getFrameRef.current = getFrame;
  }, [getFrame]);
  useEffect(() => {
    isLiveRef.current = isLive;
  }, [isLive]);

  // RAF-based render loop for getFrame mode (high-frequency 60fps)
  // Uses ref for getFrame to avoid restarting the loop on parent re-renders
  useEffect(() => {
    if (!getFrame) {
      isRafModeRef.current = false;
      return;
    }

    isRafModeRef.current = true;
    let running = true;

    const tick = () => {
      if (!running) return;

      // Use ref to always get latest getFrame without restarting RAF loop
      const currentGetFrame = getFrameRef.current;
      if (currentGetFrame) {
        if (isLiveRef.current) {
          // Live: drain all frames and render the latest (minimize latency)
          let frame = currentGetFrame();
          let frameToRender: VideoFrame | null = null;

          while (frame) {
            if (frameToRender && frameToRender !== lastRenderedFrameRef.current) {
              try {
                frameToRender.close();
              } catch {
                // Already closed
              }
              metricsRef.current.framesDropped++;
            }
            frameToRender = frame;
            frame = currentGetFrame();
          }

          if (frameToRender && frameToRender !== lastRenderedFrameRef.current) {
            renderFrame(frameToRender);
          }
        } else {
          // VOD: take exactly one frame per RAF tick for smooth sequential playback.
          // The upstream release policy and frame queue handle pacing; draining
          // multiple frames here causes skips and visible jitter.
          const frame = currentGetFrame();
          if (frame && frame !== lastRenderedFrameRef.current) {
            renderFrame(frame);
          }
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    // Start the RAF loop
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      running = false;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  // Only restart RAF loop if getFrame changes from defined to undefined or vice versa
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!getFrame, renderFrame]);

  // Legacy prop-based mode - render frame when it changes via React state
  useEffect(() => {
    // Skip if using RAF mode
    if (isRafModeRef.current || !frameProp) return;

    renderFrame(frameProp);
  }, [frameProp, renderFrame]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
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
