// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview DVR Controls Component
 *
 * Timeline and seek controls for DVR/rewind functionality.
 * Allows scrubbing through VOD content and seeking to specific positions.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';

interface DVRControlsProps {
  /** Current playback time in milliseconds */
  currentTime: number;
  /** Total duration in milliseconds (0 if unknown/live) */
  duration: number;
  /** Buffered ranges as array of [start, end] in milliseconds */
  bufferedRanges?: Array<[number, number]>;
  /** Whether DVR is available for this track */
  dvrAvailable: boolean;
  /** Whether currently seeking */
  isSeeking: boolean;
  /** Callback when user seeks to a position */
  onSeek: (timeMs: number) => void;
  /** Callback when user starts dragging the scrubber */
  onSeekStart?: () => void;
  /** Callback when user stops dragging the scrubber */
  onSeekEnd?: () => void;
  /** Optional className for styling */
  className?: string;
}

/**
 * Format time in milliseconds to MM:SS or HH:MM:SS
 */
function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * DVR Controls Component
 *
 * Provides a timeline scrubber, time display, and seek functionality
 * for DVR/VOD content playback.
 */
export const DVRControls: React.FC<DVRControlsProps> = ({
  currentTime,
  duration,
  bufferedRanges = [],
  dvrAvailable,
  isSeeking,
  onSeek,
  onSeekStart,
  onSeekEnd,
  className = '',
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [dragTime, setDragTime] = useState<number | null>(null);
  const progressRef = useRef<HTMLDivElement>(null);

  // Calculate progress percentage
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const displayTime = isDragging && dragTime !== null ? dragTime : currentTime;

  // Handle mouse position to time conversion
  const getTimeFromMouseEvent = useCallback((e: React.MouseEvent | MouseEvent): number => {
    if (!progressRef.current || duration <= 0) return 0;

    const rect = progressRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const percentage = x / rect.width;
    return Math.floor(percentage * duration);
  }, [duration]);

  // Handle mouse down on progress bar
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!dvrAvailable || duration <= 0) return;

    setIsDragging(true);
    const time = getTimeFromMouseEvent(e);
    setDragTime(time);
    onSeekStart?.();
  }, [dvrAvailable, duration, getTimeFromMouseEvent, onSeekStart]);

  // Handle mouse move while dragging
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const time = getTimeFromMouseEvent(e);
      setDragTime(time);
    };

    const handleMouseUp = (e: MouseEvent) => {
      const time = getTimeFromMouseEvent(e);
      setIsDragging(false);
      setDragTime(null);
      onSeek(time);
      onSeekEnd?.();
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, getTimeFromMouseEvent, onSeek, onSeekEnd]);

  // Handle hover for time preview
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging || duration <= 0) return;
    const time = getTimeFromMouseEvent(e);
    setHoverTime(time);
  }, [isDragging, duration, getTimeFromMouseEvent]);

  const handleMouseLeave = useCallback(() => {
    if (!isDragging) {
      setHoverTime(null);
    }
  }, [isDragging]);

  // Handle click to seek directly
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!dvrAvailable || duration <= 0 || isDragging) return;

    const time = getTimeFromMouseEvent(e);
    onSeek(time);
  }, [dvrAvailable, duration, isDragging, getTimeFromMouseEvent, onSeek]);

  // If no DVR available, show minimal controls
  if (!dvrAvailable) {
    return (
      <div className={`dvr-controls ${className}`}>
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <span className="live-badge px-2 py-0.5 bg-red-500 text-white text-xs rounded">
            LIVE
          </span>
          <span>{formatTime(currentTime)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`dvr-controls ${className}`}>
      {/* Timeline container */}
      <div className="flex items-center gap-3">
        {/* Current time */}
        <span className="text-sm font-mono text-gray-600 dark:text-gray-300 min-w-[48px]">
          {formatTime(displayTime)}
        </span>

        {/* Progress bar */}
        <div
          ref={progressRef}
          className="flex-1 relative h-6 cursor-pointer group"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onClick={handleClick}
        >
          {/* Track background */}
          <div className="absolute top-1/2 -translate-y-1/2 w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            {/* Buffered ranges */}
            {bufferedRanges.map(([start, end], index) => {
              const startPct = (start / duration) * 100;
              const widthPct = ((end - start) / duration) * 100;
              return (
                <div
                  key={index}
                  className="absolute h-full bg-gray-300 dark:bg-gray-600"
                  style={{
                    left: `${startPct}%`,
                    width: `${widthPct}%`,
                  }}
                />
              );
            })}

            {/* Progress fill */}
            <div
              className="absolute h-full bg-primary-500 transition-all duration-75"
              style={{
                width: `${isDragging && dragTime !== null ? (dragTime / duration) * 100 : progress}%`,
              }}
            />
          </div>

          {/* Scrubber handle */}
          <div
            className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-primary-500 rounded-full shadow-md transform -translate-x-1/2 transition-transform ${
              isDragging ? 'scale-125' : 'scale-100 group-hover:scale-110'
            }`}
            style={{
              left: `${isDragging && dragTime !== null ? (dragTime / duration) * 100 : progress}%`,
            }}
          />

          {/* Hover time preview */}
          {hoverTime !== null && !isDragging && (
            <div
              className="absolute bottom-full mb-2 px-2 py-1 bg-gray-800 dark:bg-gray-900 text-white text-xs rounded transform -translate-x-1/2 pointer-events-none"
              style={{ left: `${(hoverTime / duration) * 100}%` }}
            >
              {formatTime(hoverTime)}
            </div>
          )}

          {/* Seeking indicator */}
          {isSeeking && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="animate-pulse text-xs text-primary-500 bg-white/80 dark:bg-gray-800/80 px-2 py-0.5 rounded">
                Seeking...
              </div>
            </div>
          )}
        </div>

        {/* Total duration */}
        <span className="text-sm font-mono text-gray-600 dark:text-gray-300 min-w-[48px] text-right">
          {formatTime(duration)}
        </span>
      </div>

      {/* Additional controls row */}
      <div className="flex items-center justify-between mt-2 text-xs text-gray-500 dark:text-gray-400">
        <div className="flex items-center gap-2">
          {/* Rewind button */}
          <button
            onClick={() => onSeek(Math.max(0, currentTime - 10000))}
            className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
            title="Rewind 10 seconds"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0019 16V8a1 1 0 00-1.6-.8l-5.334 4zM4.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0011 16V8a1 1 0 00-1.6-.8l-5.334 4z" />
            </svg>
          </button>

          {/* Forward button */}
          <button
            onClick={() => onSeek(Math.min(duration, currentTime + 10000))}
            className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
            title="Forward 10 seconds"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.933 12.8a1 1 0 000-1.6L6.6 7.2A1 1 0 005 8v8a1 1 0 001.6.8l5.333-4zM19.933 12.8a1 1 0 000-1.6l-5.333-4A1 1 0 0013 8v8a1 1 0 001.6.8l5.333-4z" />
            </svg>
          </button>

          <span className="px-2">|</span>

          {/* Go to start */}
          <button
            onClick={() => onSeek(0)}
            className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
            title="Go to start"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
          </button>

          {/* Go to end / Live */}
          <button
            onClick={() => onSeek(duration)}
            className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
            title="Go to live"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
            </svg>
          </button>
        </div>

        {/* DVR badge */}
        <span className="px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded text-xs">
          DVR
        </span>
      </div>
    </div>
  );
};
