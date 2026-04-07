// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview VOD Video Player Component
 *
 * Video player with playback controls for VOD content.
 * Supports play/pause, seeking, and progress display.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { VideoRenderer } from './VideoRenderer';
import { useStore } from '../../store';

interface VODVideoPlayerProps {
  /** The VideoFrame to render */
  frame: VideoFrame | null;
  /** Subscription ID for controlling playback */
  subscriptionId: number;
  /** Total duration in milliseconds (from VOD metadata) */
  duration?: number;
  /** Frames per second for time calculation */
  framerate?: number;
  /** Optional className for styling */
  className?: string;
  /** Enable VOD controls (default: true if duration provided) */
  showControls?: boolean;
}

/**
 * VOD Video Player with playback controls
 */
export const VODVideoPlayer: React.FC<VODVideoPlayerProps> = ({
  frame,
  subscriptionId,
  duration = 0,
  framerate = 30,
  className = '',
  showControls,
}) => {
  const { pauseSubscription, resumeSubscription, isSubscriptionPaused, seekSubscription } = useStore();

  const [isPaused, setIsPaused] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekTime, setSeekTime] = useState(0);
  const frameCountRef = useRef(0);
  const startTimeRef = useRef<number | null>(null);

  // Calculate if controls should be shown
  const controlsEnabled = showControls ?? (duration > 0);

  // Update current time based on frame count
  useEffect(() => {
    if (frame && !isPaused && !isSeeking) {
      frameCountRef.current++;
      // Calculate time from frame count
      const timeMs = (frameCountRef.current / framerate) * 1000;
      setCurrentTime(timeMs);

      if (!startTimeRef.current) {
        startTimeRef.current = Date.now();
      }
    }
  }, [frame, isPaused, isSeeking, framerate]);

  // Sync pause state with subscription
  useEffect(() => {
    const paused = isSubscriptionPaused(subscriptionId);
    setIsPaused(paused);
  }, [subscriptionId, isSubscriptionPaused]);

  // Handle play/pause
  const handlePlayPause = useCallback(async () => {
    try {
      if (isPaused) {
        await resumeSubscription(subscriptionId);
        setIsPaused(false);
      } else {
        await pauseSubscription(subscriptionId);
        setIsPaused(true);
      }
    } catch (err) {
      console.error('Failed to toggle playback:', err);
    }
  }, [isPaused, subscriptionId, pauseSubscription, resumeSubscription]);

  // Handle seek
  const handleSeek = useCallback(async (timeMs: number) => {
    try {
      setIsSeeking(true);
      setSeekTime(timeMs);

      // Pause during seek
      await pauseSubscription(subscriptionId);

      // Call seek via store
      await seekSubscription(subscriptionId, timeMs);

      // Update current time
      setCurrentTime(timeMs);
      frameCountRef.current = Math.floor((timeMs / 1000) * framerate);

      // Resume if wasn't paused before
      if (!isPaused) {
        await resumeSubscription(subscriptionId);
      }
    } catch (err) {
      console.error('Failed to seek:', err);
    } finally {
      setIsSeeking(false);
    }
  }, [subscriptionId, pauseSubscription, resumeSubscription, seekSubscription, isPaused, framerate]);

  // Handle seek bar change
  const handleSeekBarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const timeMs = Number(e.target.value);
    setSeekTime(timeMs);
  };

  // Handle seek bar release
  const handleSeekBarRelease = () => {
    handleSeek(seekTime);
  };

  // Format time as MM:SS
  const formatTime = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  // Calculate progress percentage
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className={`vod-video-player relative ${className}`}>
      {/* Video Display */}
      <VideoRenderer frame={frame} />

      {/* Playback Controls Overlay */}
      {controlsEnabled && (
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-3">
          {/* Progress Bar */}
          <div className="mb-2">
            <input
              type="range"
              min={0}
              max={duration}
              value={isSeeking ? seekTime : currentTime}
              onChange={handleSeekBarChange}
              onMouseUp={handleSeekBarRelease}
              onTouchEnd={handleSeekBarRelease}
              className="w-full h-1 bg-white/30 rounded-lg appearance-none cursor-pointer
                [&::-webkit-slider-thumb]:appearance-none
                [&::-webkit-slider-thumb]:w-3
                [&::-webkit-slider-thumb]:h-3
                [&::-webkit-slider-thumb]:rounded-full
                [&::-webkit-slider-thumb]:bg-white
                [&::-webkit-slider-thumb]:cursor-pointer
                [&::-webkit-slider-thumb]:shadow-md"
              style={{
                background: `linear-gradient(to right, #3b82f6 ${progress}%, rgba(255,255,255,0.3) ${progress}%)`,
              }}
            />
          </div>

          {/* Controls Row */}
          <div className="flex items-center gap-3">
            {/* Play/Pause Button */}
            <button
              onClick={handlePlayPause}
              className="p-2 rounded-full bg-white/20 hover:bg-white/30 transition-colors"
              title={isPaused ? 'Play' : 'Pause'}
            >
              {isPaused ? (
                <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              ) : (
                <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
              )}
            </button>

            {/* Time Display */}
            <div className="text-white text-sm font-mono">
              {formatTime(currentTime)} / {formatTime(duration)}
            </div>

            {/* Seeking Indicator */}
            {isSeeking && (
              <div className="text-white/70 text-xs flex items-center gap-1">
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Seeking...
              </div>
            )}

            {/* Live/VOD Indicator */}
            <div className="ml-auto">
              {duration > 0 ? (
                <span className="px-2 py-0.5 bg-purple-500/80 text-white text-xs rounded-full">
                  VOD
                </span>
              ) : (
                <span className="px-2 py-0.5 bg-red-500/80 text-white text-xs rounded-full flex items-center gap-1">
                  <span className="w-2 h-2 bg-white rounded-full animate-pulse" />
                  LIVE
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Center Play Button (when paused) */}
      {isPaused && controlsEnabled && (
        <button
          onClick={handlePlayPause}
          className="absolute inset-0 flex items-center justify-center bg-black/30 hover:bg-black/40 transition-colors"
        >
          <div className="p-4 rounded-full bg-white/20 backdrop-blur-sm">
            <svg className="w-12 h-12 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </button>
      )}
    </div>
  );
};
