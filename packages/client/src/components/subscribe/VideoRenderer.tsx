// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Video Renderer Component
 *
 * Canvas-based renderer for WebCodecs VideoFrames.
 * Uses a frame queue and requestAnimationFrame for smooth playback.
 *
 * Key features for smooth VOD playback:
 * - Frame queue prevents frame drops when multiple frames arrive between RAF ticks
 * - One frame rendered per RAF tick (no batching)
 * - Timestamp-based ordering ensures correct playback sequence
 * - Diagnostic metrics for debugging playback issues
 */

import React, { useRef, useEffect, useCallback, useState } from 'react';

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
}

/**
 * VideoRenderer Component
 *
 * Renders WebCodecs VideoFrames to a canvas element using requestAnimationFrame
 * for smooth playback. Uses a frame queue to handle bursty frame delivery.
 */
export const VideoRenderer: React.FC<VideoRendererProps> = ({
  frame,
  width,
  height: _height,
  className = '',
  enableDiagnostics = false,
  onMetricsUpdate,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const frameQueueRef = useRef<VideoFrame[]>([]);
  const lastRenderedFrameRef = useRef<VideoFrame | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const isRenderingRef = useRef<boolean>(false);
  const hasInitialBufferRef = useRef<boolean>(false);
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
  });
  const lastRenderTimeRef = useRef<number>(0);
  const renderIntervalsRef = useRef<number[]>([]);
  const lastFrameTimestampRef = useRef<number>(0);

  // Maximum queue depth to prevent memory issues
  const MAX_QUEUE_DEPTH = 30;
  // Minimum frames to buffer before INITIAL render (allows reordering window)
  const INITIAL_BUFFER_SIZE = 8;
  const FRAME_JUMP_THRESHOLD_MS = 100000; // 100ms in microseconds - detect jumps

  // Insert frame into queue in sorted order by timestamp
  const insertFrameSorted = useCallback((queue: VideoFrame[], newFrame: VideoFrame, diagnostics: boolean): boolean => {
    const newTs = newFrame.timestamp;
    let reordered = false;

    // Handle invalid timestamps - append to end and track
    if (newTs <= 0) {
      metricsRef.current.framesWithoutTimestamp++;
      if (diagnostics && metricsRef.current.framesWithoutTimestamp <= 5) {
        console.warn('[VideoRenderer] Frame has invalid timestamp, appending to end', { timestamp: newTs });
      }
      queue.push(newFrame);
      return false;
    }

    // Find insertion point (binary search for efficiency)
    let low = 0;
    let high = queue.length;

    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const midTs = queue[mid].timestamp;
      // Skip invalid timestamps in queue during search
      if (midTs <= 0 || midTs < newTs) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    // If not inserting at end, we're reordering
    if (low < queue.length) {
      reordered = true;
      if (diagnostics && metricsRef.current.framesReordered < 10) {
        // Log first few reorders for debugging
        console.log('[VideoRenderer] Reordering frame', {
          newTs,
          insertPosition: low,
          queueLength: queue.length,
          headTs: queue[0]?.timestamp,
          tailTs: queue[queue.length - 1]?.timestamp,
        });
      }
    }

    // Insert at sorted position
    queue.splice(low, 0, newFrame);
    return reordered;
  }, []);

  // Update metrics and optionally report
  const updateMetrics = useCallback((updates: Partial<VideoRendererMetrics>) => {
    Object.assign(metricsRef.current, updates);
    metricsRef.current.framesQueued = frameQueueRef.current.length;

    if (enableDiagnostics && onMetricsUpdate) {
      onMetricsUpdate({ ...metricsRef.current });
    }
  }, [enableDiagnostics, onMetricsUpdate]);

  // Render loop that processes one frame per RAF tick
  const renderLoop = useCallback(() => {
    const canvas = canvasRef.current;
    const queue = frameQueueRef.current;

    // Initial buffering: wait for enough frames to allow reordering
    if (!hasInitialBufferRef.current) {
      if (queue.length < INITIAL_BUFFER_SIZE) {
        rafIdRef.current = requestAnimationFrame(renderLoop);
        return;
      }
      hasInitialBufferRef.current = true;
      console.log('[VideoRenderer] Initial buffer filled, starting playback', { queueDepth: queue.length });
    }

    // Get next frame from queue (now sorted by timestamp)
    // Skip closed/invalid frames
    let currentFrame: VideoFrame | undefined;
    while (queue.length > 0) {
      const candidate = queue.shift();
      if (candidate) {
        // Check if frame is still valid (not closed)
        try {
          // Accessing codedWidth on a closed frame throws
          void candidate.codedWidth;
          currentFrame = candidate;
          break;
        } catch {
          // Frame was closed by upstream, skip it
          metricsRef.current.framesDropped++;
        }
      }
    }

    if (!canvas || !currentFrame) {
      // No valid frame to render, keep loop running if queue has frames
      if (queue.length > 0) {
        rafIdRef.current = requestAnimationFrame(renderLoop);
      } else {
        isRenderingRef.current = false;
        rafIdRef.current = null;
      }
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      // Close frame since we can't render it
      try { currentFrame.close(); } catch { /* ignore */ }
      rafIdRef.current = requestAnimationFrame(renderLoop);
      return;
    }

    // Update canvas size to match frame if needed
    const frameWidth = currentFrame.displayWidth || currentFrame.codedWidth;
    const frameHeight = currentFrame.displayHeight || currentFrame.codedHeight;

    if (canvas.width !== frameWidth || canvas.height !== frameHeight) {
      canvas.width = frameWidth;
      canvas.height = frameHeight;
      setCanvasDimensions({ width: frameWidth, height: frameHeight });
    }

    // Draw the frame
    try {
      ctx.drawImage(currentFrame, 0, 0);
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
      const frameTs = currentFrame.timestamp;
      if (lastFrameTimestampRef.current > 0 && frameTs > 0) {
        const tsDiff = frameTs - lastFrameTimestampRef.current;
        // Detect backwards jumps or large forward jumps
        if (tsDiff < 0) {
          metricsRef.current.frameJumps++;
          metricsRef.current.backwardJumps++;
          if (enableDiagnostics && metricsRef.current.backwardJumps <= 5) {
            console.warn('[VideoRenderer] BACKWARD jump', {
              previousTs: lastFrameTimestampRef.current,
              currentTs: frameTs,
              diff: tsDiff / 1000, // Show in ms
            });
          }
        } else if (tsDiff > FRAME_JUMP_THRESHOLD_MS) {
          metricsRef.current.frameJumps++;
          metricsRef.current.forwardJumps++;
          if (enableDiagnostics && metricsRef.current.forwardJumps <= 5) {
            console.warn('[VideoRenderer] FORWARD jump (>100ms)', {
              previousTs: lastFrameTimestampRef.current,
              currentTs: frameTs,
              diff: tsDiff / 1000, // Show in ms
            });
          }
        }
      }
      lastFrameTimestampRef.current = frameTs;
      metricsRef.current.lastFrameTimestamp = frameTs;

      // Mark that we've received at least one frame
      if (!hasReceivedFrame) {
        setHasReceivedFrame(true);
      }

      // Close the previous frame AFTER successfully drawing the new one
      if (lastRenderedFrameRef.current && lastRenderedFrameRef.current !== currentFrame) {
        try {
          lastRenderedFrameRef.current.close();
        } catch {
          // Frame may already be closed
        }
      }
      lastRenderedFrameRef.current = currentFrame;

      // Log stats every 30 frames
      if (metricsRef.current.framesRendered % 30 === 0) {
        console.log('[VideoRenderer] Rendering stats', {
          framesRendered: metricsRef.current.framesRendered,
          framesDropped: metricsRef.current.framesDropped,
          frameJumps: metricsRef.current.frameJumps,
          frameWidth,
          frameHeight,
          timestamp: currentFrame.timestamp,
          queueDepth: queue.length,
          avgRenderInterval: metricsRef.current.avgRenderInterval.toFixed(2) + 'ms',
        });
      }

      updateMetrics({});
    } catch (err) {
      console.error('[VideoRenderer] Error drawing frame', err);
      // Try to close the frame
      try { currentFrame.close(); } catch { /* ignore */ }
    }

    // Continue render loop if more frames in queue, otherwise wait for new frames
    if (queue.length > 0) {
      rafIdRef.current = requestAnimationFrame(renderLoop);
    } else {
      isRenderingRef.current = false;
      rafIdRef.current = null;
    }
  }, [enableDiagnostics, hasReceivedFrame, updateMetrics]);

  // Start render loop if not already running
  const ensureRenderLoop = useCallback(() => {
    if (!isRenderingRef.current && frameQueueRef.current.length > 0) {
      isRenderingRef.current = true;
      rafIdRef.current = requestAnimationFrame(renderLoop);
    }
  }, [renderLoop]);

  // Add frame to queue when frame prop changes
  useEffect(() => {
    if (frame) {
      const queue = frameQueueRef.current;

      // If queue is too deep, drop oldest frames to prevent memory buildup
      while (queue.length >= MAX_QUEUE_DEPTH) {
        const droppedFrame = queue.shift();
        if (droppedFrame) {
          try { droppedFrame.close(); } catch { /* ignore */ }
          metricsRef.current.framesDropped++;
          if (enableDiagnostics) {
            console.warn('[VideoRenderer] Dropped frame due to queue overflow', {
              queueDepth: queue.length,
              totalDropped: metricsRef.current.framesDropped,
            });
          }
        }
      }

      // Add new frame to queue in sorted order by timestamp
      const wasReordered = insertFrameSorted(queue, frame, enableDiagnostics);
      if (wasReordered) {
        metricsRef.current.framesReordered++;
        if (enableDiagnostics) {
          console.log('[VideoRenderer] Frame reordered into correct position', {
            frameTs: frame.timestamp,
            queueDepth: queue.length,
            totalReordered: metricsRef.current.framesReordered,
          });
        }
      }

      // Ensure render loop is running
      ensureRenderLoop();
    }
  }, [frame, ensureRenderLoop, enableDiagnostics]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
      // Close all queued frames
      for (const queuedFrame of frameQueueRef.current) {
        try { queuedFrame.close(); } catch { /* ignore */ }
      }
      frameQueueRef.current = [];
      // Close the last rendered frame
      if (lastRenderedFrameRef.current) {
        try { lastRenderedFrameRef.current.close(); } catch { /* ignore */ }
      }
      // Reset initial buffer state for next mount
      hasInitialBufferRef.current = false;
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
