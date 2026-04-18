// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Video Renderer Component
 *
 * Canvas-based renderer for WebCodecs VideoFrames.
 * Renders frames immediately when they arrive.
 */

import React, { useRef, useEffect, useState } from 'react';

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
 * Renders WebCodecs VideoFrames to a canvas element.
 * Frame lifecycle is managed by the parent component.
 */
export const VideoRenderer: React.FC<VideoRendererProps> = ({
  frame,
  width,
  height: _height,
  className = '',
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const frameCountRef = useRef<number>(0);
  const [hasReceivedFrame, setHasReceivedFrame] = useState(false);
  const [canvasDimensions, setCanvasDimensions] = useState({ width: 1280, height: 720 });

  // Render frame immediately when it changes
  useEffect(() => {
    if (!frame) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    // Mark that we've received at least one frame
    if (!hasReceivedFrame) {
      setHasReceivedFrame(true);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Get frame dimensions
    const frameWidth = frame.displayWidth || frame.codedWidth;
    const frameHeight = frame.displayHeight || frame.codedHeight;

    // Update canvas size if needed
    if (canvas.width !== frameWidth || canvas.height !== frameHeight) {
      canvas.width = frameWidth;
      canvas.height = frameHeight;
      setCanvasDimensions({ width: frameWidth, height: frameHeight });
    }

    // Draw the frame immediately
    try {
      ctx.drawImage(frame, 0, 0);
      frameCountRef.current++;

      // Log stats every 60 frames
      if (frameCountRef.current % 60 === 0) {
        console.log('[VideoRenderer] Rendering stats', {
          framesRendered: frameCountRef.current,
          frameWidth,
          frameHeight,
          timestamp: frame.timestamp,
        });
      }
    } catch (err) {
      // Frame may have been closed - this is expected during fast scrubbing
      // Parent component manages frame lifecycle
    }
  }, [frame, hasReceivedFrame]);

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
