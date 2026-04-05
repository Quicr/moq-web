// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Video Renderer Component
 *
 * Canvas-based renderer for WebCodecs VideoFrames.
 * Uses requestAnimationFrame for smooth playback instead of React state.
 */

import React, { useRef, useEffect, useCallback } from 'react';

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
 * for smooth playback. Frames are rendered immediately when received.
 */
export const VideoRenderer: React.FC<VideoRendererProps> = ({
  frame,
  width,
  height: _height,
  className = '',
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<VideoFrame | null>(null);
  const prevFrameRef = useRef<VideoFrame | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const frameCountRef = useRef<number>(0);

  // Render function that draws the current frame
  const renderFrame = useCallback(() => {
    const canvas = canvasRef.current;
    const currentFrame = frameRef.current;

    if (!canvas || !currentFrame) {
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
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
      // This avoids race conditions where frames are closed before rendering
      if (prevFrameRef.current && prevFrameRef.current !== currentFrame) {
        try {
          prevFrameRef.current.close();
        } catch {
          // Frame may already be closed
        }
      }
      prevFrameRef.current = currentFrame;

      // Log stats every 30 frames (roughly once per second at 30fps)
      if (frameCountRef.current % 30 === 0) {
        console.log('[VideoRenderer] Rendering stats', {
          framesRendered: frameCountRef.current,
          frameWidth,
          frameHeight,
          timestamp: currentFrame.timestamp,
        });
      }
    } catch (err) {
      // Frame might have been closed
      console.error('[VideoRenderer] Error drawing frame', err);
    }
  }, []);

  // Update frameRef when frame prop changes and trigger immediate render
  useEffect(() => {
    if (frame) {
      // If we have a pending RAF that hasn't rendered yet, the old frame
      // will be skipped - close it to avoid GC warning
      if (rafIdRef.current && frameRef.current && frameRef.current !== prevFrameRef.current) {
        try {
          frameRef.current.close();
        } catch {
          // Frame may already be closed
        }
        cancelAnimationFrame(rafIdRef.current);
      }

      // Store the new frame
      frameRef.current = frame;

      // Render immediately using requestAnimationFrame for proper timing
      rafIdRef.current = requestAnimationFrame(() => {
        renderFrame();
        rafIdRef.current = null;
      });
    }
  }, [frame, renderFrame]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
      // Close any remaining frames to prevent GC warnings
      // Close frameRef if it's different from prevFrameRef (hasn't been rendered yet)
      if (frameRef.current && frameRef.current !== prevFrameRef.current) {
        try {
          frameRef.current.close();
        } catch {
          // Frame may already be closed
        }
      }
      // Close the last rendered frame
      if (prevFrameRef.current) {
        try {
          prevFrameRef.current.close();
        } catch {
          // Frame may already be closed
        }
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
      {frame ? (
        <canvas
          ref={canvasRef}
          style={{
            display: 'block',
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
          }}
        />
      ) : (
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
