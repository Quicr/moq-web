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
 */

import React, { useRef, useEffect, useCallback, useState } from 'react';

interface VideoRendererProps {
  /** The VideoFrame to render */
  frame: VideoFrame | null;
  /** Optional width override */
  width?: number;
  /** Optional height override */
  height?: number;
  /** Optional className for styling */
  className?: string;
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
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const frameQueueRef = useRef<VideoFrame[]>([]);
  const lastRenderedFrameRef = useRef<VideoFrame | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const frameCountRef = useRef<number>(0);
  const isRenderingRef = useRef<boolean>(false);
  const droppedFramesRef = useRef<number>(0);
  const [hasReceivedFrame, setHasReceivedFrame] = useState(false);

  // Maximum queue depth to prevent memory issues
  const MAX_QUEUE_DEPTH = 10;

  // Render loop that processes one frame per RAF tick
  const renderLoop = useCallback(() => {
    const canvas = canvasRef.current;
    const queue = frameQueueRef.current;

    // Get next frame from queue
    const currentFrame = queue.shift();

    if (!canvas || !currentFrame) {
      // No frame to render, but keep the loop running if queue has frames
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
    }

    // Draw the frame
    try {
      ctx.drawImage(currentFrame, 0, 0);
      frameCountRef.current++;

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
      if (frameCountRef.current % 30 === 0) {
        console.log('[VideoRenderer] Rendering stats', {
          framesRendered: frameCountRef.current,
          frameWidth,
          frameHeight,
          timestamp: currentFrame.timestamp,
          queueDepth: queue.length,
          droppedFrames: droppedFramesRef.current,
        });
      }
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
  }, []);

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
      if (!hasReceivedFrame) {
        setHasReceivedFrame(true);
      }
      const queue = frameQueueRef.current;

      // If queue is too deep, drop oldest frames to prevent memory buildup
      while (queue.length >= MAX_QUEUE_DEPTH) {
        const droppedFrame = queue.shift();
        if (droppedFrame) {
          try { droppedFrame.close(); } catch { /* ignore */ }
          droppedFramesRef.current++;
        }
      }

      // Add new frame to queue
      queue.push(frame);

      // Ensure render loop is running
      ensureRenderLoop();
    }
  }, [frame, ensureRenderLoop, hasReceivedFrame]);

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
    };
  }, []);

  // Calculate dimensions for responsive sizing
  const frameWidth = frame?.displayWidth || frame?.codedWidth || 1280;
  const frameHeight = frame?.displayHeight || frame?.codedHeight || 720;
  const aspectRatio = frameWidth / frameHeight;

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
