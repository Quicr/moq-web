// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Unified MoQ Media Player Component
 *
 * A single player component that works for both live and VOD content.
 *
 * Playback Control:
 * - Live (isLive=true): Uses SUBSCRIBE_UPDATE forward=0/1 for pause/resume
 * - VOD (isLive=false): Uses playout buffer pause for pause/resume
 *
 * Seeking:
 * - Uses FETCH for both live and VOD
 * - For live: If content not available, falls back to live edge
 * - For VOD: Fetches the requested position
 *
 * UI adapts based on available metadata:
 * - With duration: Shows progress bar with time
 * - Without duration: Shows live indicator, seek still works via FETCH
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { VideoRenderer, VideoRendererMetrics } from '../subscribe/VideoRenderer';
import { useStore } from '../../store';
import { EXPERIENCE_PROFILES, type ExperienceProfileName } from '@web-moq/media';

export interface MoqMediaPlayerProps {
  /** The VideoFrame to render */
  frame: VideoFrame | null;
  /** Subscription ID for controlling playback */
  subscriptionId: number;
  /** Whether content is live (from catalog or explicit) */
  isLive: boolean;
  /** Total duration in milliseconds (from catalog, optional for live) */
  duration?: number;
  /** Frames per second (from catalog, for time calculation) */
  framerate?: number;
  /** Total groups (from catalog, for seek calculation) */
  totalGroups?: number;
  /** GOP duration in milliseconds (from catalog, for seek calculation) */
  gopDuration?: number;
  /** Optional className for styling */
  className?: string;
  /** Show controls (default: true) */
  showControls?: boolean;
  /** Callback when playback state changes */
  onPlaybackStateChange?: (playing: boolean) => void;
  /** Callback when seek completes */
  onSeekComplete?: (timeMs: number, success: boolean) => void;
  /** Enable diagnostic overlay for debugging playback issues */
  enableDiagnostics?: boolean;
}

/**
 * Unified MoQ Media Player
 *
 * Works for both live and VOD content with appropriate behavior:
 * - Pause/Resume: SUBSCRIBE_UPDATE for live, buffer pause for VOD
 * - Seek: FETCH-based for both (DVR for live, position for VOD)
 */
export const MoqMediaPlayer: React.FC<MoqMediaPlayerProps> = ({
  frame,
  subscriptionId,
  isLive,
  duration = 0,
  framerate = 30,
  totalGroups,
  gopDuration = 1000,
  className = '',
  showControls = true,
  onPlaybackStateChange,
  onSeekComplete,
  enableDiagnostics = false,
}) => {
  const {
    pauseSubscription,
    resumeSubscription,
    isSubscriptionPaused,
    seekSubscription,
    experienceProfile,
    jitterBufferDelay,
    maxLatency,
    policyType,
    vodFetchStats,
  } = useStore();

  // Get VOD fetch stats for this subscription
  const fetchStats = vodFetchStats.get(subscriptionId);

  // Playback state
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekTarget, setSeekTarget] = useState(0);
  const [seekFailed, setSeekFailed] = useState(false);

  // Frame counting for time estimation
  const frameCountRef = useRef(0);
  const lastFrameTimeRef = useRef<number>(0);

  // Diagnostic metrics state
  const [rendererMetrics, setRendererMetrics] = useState<VideoRendererMetrics | null>(null);

  // Frame arrival tracking for pacing diagnostics
  const frameArrivalTimesRef = useRef<number[]>([]);
  const lastFrameArrivalRef = useRef<number>(0);

  // Diagnostic log capture
  interface DiagnosticLogEntry {
    time: number;
    type: 'frame' | 'metrics' | 'event';
    data: Record<string, unknown>;
  }
  const diagnosticLogsRef = useRef<DiagnosticLogEntry[]>([]);
  const logStartTimeRef = useRef<number>(0);

  // Track frame arrivals for diagnostics
  useEffect(() => {
    if (frame && enableDiagnostics) {
      const now = performance.now();
      if (logStartTimeRef.current === 0) {
        logStartTimeRef.current = now;
      }

      if (lastFrameArrivalRef.current > 0) {
        const interval = now - lastFrameArrivalRef.current;
        frameArrivalTimesRef.current.push(interval);
        if (frameArrivalTimesRef.current.length > 60) {
          frameArrivalTimesRef.current.shift();
        }
      }
      lastFrameArrivalRef.current = now;

      // Log frame arrival
      diagnosticLogsRef.current.push({
        time: now - logStartTimeRef.current,
        type: 'frame',
        data: {
          timestamp: frame.timestamp,
          width: frame.displayWidth || frame.codedWidth,
          height: frame.displayHeight || frame.codedHeight,
        },
      });

      // Keep last 5000 entries
      if (diagnosticLogsRef.current.length > 5000) {
        diagnosticLogsRef.current = diagnosticLogsRef.current.slice(-5000);
      }
    }
  }, [frame, enableDiagnostics]);

  // Handle metrics update from renderer
  const handleMetricsUpdate = useCallback((metrics: VideoRendererMetrics) => {
    setRendererMetrics(metrics);

    // Log metrics periodically (every 30 frames)
    if (enableDiagnostics && metrics.framesRendered % 30 === 0 && logStartTimeRef.current > 0) {
      diagnosticLogsRef.current.push({
        time: performance.now() - logStartTimeRef.current,
        type: 'metrics',
        data: { ...metrics },
      });
    }
  }, [enableDiagnostics]);

  // Download diagnostic logs
  const handleDownloadLogs = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const logs = diagnosticLogsRef.current;
    const summary = {
      totalFrames: logs.filter(l => l.type === 'frame').length,
      duration: logs.length > 0 ? logs[logs.length - 1].time : 0,
      metrics: rendererMetrics,
      profile: experienceProfile,
      settings: { maxLatency, jitterBufferDelay, policyType, isLive, framerate },
    };

    const content = JSON.stringify({ summary, logs }, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vod-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [rendererMetrics, experienceProfile, maxLatency, jitterBufferDelay, policyType, isLive, framerate]);

  // Clear diagnostic logs
  const handleClearLogs = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    diagnosticLogsRef.current = [];
    logStartTimeRef.current = performance.now();
  }, []);

  // Calculate if we have duration info for progress bar
  const hasDuration = duration > 0;

  // Estimate current position from frame count
  useEffect(() => {
    if (frame && isPlaying && !isSeeking) {
      frameCountRef.current++;
      const estimatedTimeMs = (frameCountRef.current / framerate) * 1000;
      setCurrentTime(estimatedTimeMs);
      lastFrameTimeRef.current = performance.now();
    }
  }, [frame, isPlaying, isSeeking, framerate]);

  // Sync with subscription pause state
  useEffect(() => {
    const paused = isSubscriptionPaused(subscriptionId);
    setIsPlaying(!paused);
  }, [subscriptionId, isSubscriptionPaused]);

  /**
   * Handle play/pause toggle
   * - Live: Uses SUBSCRIBE_UPDATE with forward=0/1
   * - VOD: Pauses the playout buffer
   * Both are now handled by MediaSession.pauseSubscription/resumeSubscription
   */
  const handlePlayPause = useCallback(async () => {
    try {
      if (isPlaying) {
        await pauseSubscription(subscriptionId);
        setIsPlaying(false);
        onPlaybackStateChange?.(false);
      } else {
        await resumeSubscription(subscriptionId);
        setIsPlaying(true);
        onPlaybackStateChange?.(true);
      }
    } catch (err) {
      console.error('[MoqMediaPlayer] Failed to toggle playback:', err);
    }
  }, [isPlaying, subscriptionId, pauseSubscription, resumeSubscription, onPlaybackStateChange]);

  /**
   * Calculate target group from time position
   */
  const timeToGroup = useCallback((timeMs: number): number => {
    if (totalGroups && duration > 0) {
      // Use catalog metadata for accurate calculation
      const progress = timeMs / duration;
      return Math.floor(progress * totalGroups);
    }
    // Fallback: estimate from GOP duration
    return Math.floor(timeMs / gopDuration);
  }, [totalGroups, duration, gopDuration]);

  /**
   * Handle seek operation
   * Same behavior for both live and VOD:
   * 1. Compute target group from time position
   * 2. Issue FETCH request for that group
   * 3. Play from there (or handle failure gracefully)
   */
  const handleSeek = useCallback(async (timeMs: number) => {
    setIsSeeking(true);
    setSeekTarget(timeMs);
    setSeekFailed(false);

    try {
      // Pause during seek
      if (isPlaying) {
        await pauseSubscription(subscriptionId);
      }

      // Calculate target group from time
      const targetGroup = timeToGroup(timeMs);
      console.log('[MoqMediaPlayer] Seeking', {
        timeMs,
        targetGroup,
        isLive,
      });

      // FETCH the target position (same for live and VOD)
      await seekSubscription(subscriptionId, timeMs);

      // Update position
      setCurrentTime(timeMs);
      frameCountRef.current = Math.floor((timeMs / 1000) * framerate);

      // Resume if was playing
      if (isPlaying) {
        await resumeSubscription(subscriptionId);
      }

      onSeekComplete?.(timeMs, true);
    } catch (err) {
      console.error('[MoqMediaPlayer] Seek failed:', err);
      setSeekFailed(true);

      // If seek fails (content not available), go back to live edge for live content
      if (isLive) {
        console.log('[MoqMediaPlayer] Content not available, returning to live edge');
        await resumeSubscription(subscriptionId);
        setIsPlaying(true);
      }

      onSeekComplete?.(timeMs, false);
    } finally {
      setIsSeeking(false);
    }
  }, [
    isPlaying,
    subscriptionId,
    pauseSubscription,
    resumeSubscription,
    seekSubscription,
    timeToGroup,
    framerate,
    isLive,
    hasDuration,
    onSeekComplete,
  ]);

  /**
   * Handle seek bar input change (preview)
   */
  const handleSeekBarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(e.target.value);
    setSeekTarget(value);
  };

  /**
   * Handle seek bar release (commit seek)
   */
  const handleSeekBarCommit = () => {
    handleSeek(seekTarget);
  };

  /**
   * Handle clicking on progress bar for quick seek
   */
  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!hasDuration) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const progress = clickX / rect.width;
    const targetTime = progress * duration;

    handleSeek(targetTime);
  };

  /**
   * Format time as MM:SS or HH:MM:SS
   */
  const formatTime = (ms: number): string => {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  /**
   * Calculate progress percentage for progress bar
   */
  const progress = hasDuration ? (currentTime / duration) * 100 : 0;

  return (
    <div className={`moq-media-player relative group ${className}`}>
      {/* Video Display */}
      <div className="relative">
        <VideoRenderer
          frame={frame}
          enableDiagnostics={enableDiagnostics}
          onMetricsUpdate={handleMetricsUpdate}
          framerate={framerate}
        />

        {/* Seeking Overlay */}
        {isSeeking && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <div className="flex flex-col items-center gap-2">
              <svg className="w-10 h-10 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <span className="text-white text-sm">Seeking to {formatTime(seekTarget)}...</span>
            </div>
          </div>
        )}

        {/* Seek Failed Toast */}
        {seekFailed && isLive && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 px-4 py-2 bg-yellow-500/90 text-black text-sm rounded-lg">
            Content not available, returning to live
          </div>
        )}

        {/* Diagnostics Overlay - Glassmorphic Design */}
        {enableDiagnostics && rendererMetrics && (
          <div className="absolute top-3 left-3 right-3 flex gap-2 pointer-events-none">
            {/* Profile Card */}
            <div className="backdrop-blur-md bg-white/10 border border-white/20 rounded-xl px-3 py-2 shadow-lg">
              <div className="flex items-center gap-2 mb-1.5">
                <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-white/90 text-xs font-semibold uppercase tracking-wide">
                  {experienceProfile !== 'custom'
                    ? EXPERIENCE_PROFILES[experienceProfile as Exclude<ExperienceProfileName, 'custom'>]?.displayName
                    : 'Custom'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
                <div className="text-white/50">Latency</div>
                <div className="text-white/80 font-medium">{maxLatency}ms</div>
                <div className="text-white/50">Jitter Buffer</div>
                <div className="text-white/80 font-medium">{jitterBufferDelay}ms</div>
                <div className="text-white/50">Policy</div>
                <div className="text-white/80 font-medium capitalize">{policyType}</div>
                <div className="text-white/50">Mode</div>
                <div className="text-white/80 font-medium">{isLive ? 'Live' : 'VOD'}</div>
              </div>
            </div>

            {/* Frame Stats Card */}
            <div className="backdrop-blur-md bg-white/10 border border-white/20 rounded-xl px-3 py-2 shadow-lg">
              <div className="flex items-center gap-2 mb-1.5">
                <svg className="w-3 h-3 text-white/70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
                </svg>
                <span className="text-white/90 text-xs font-semibold uppercase tracking-wide">Frames</span>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
                <div className="text-white/50">Rendered</div>
                <div className="text-emerald-400 font-medium">{rendererMetrics.framesRendered}</div>
                <div className="text-white/50">Queued</div>
                <div className="text-sky-400 font-medium">{rendererMetrics.framesQueued}</div>
                <div className="text-white/50">Reordered</div>
                <div className="text-amber-400 font-medium">{rendererMetrics.framesReordered}</div>
                <div className="text-white/50">Dropped</div>
                <div className={`font-medium ${rendererMetrics.framesDropped > 0 ? 'text-red-400' : 'text-white/80'}`}>
                  {rendererMetrics.framesDropped}
                </div>
                <div className="text-white/50">No TS</div>
                <div className={`font-medium ${rendererMetrics.framesWithoutTimestamp > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                  {rendererMetrics.framesWithoutTimestamp}
                </div>
              </div>
            </div>

            {/* Timing Card */}
            <div className="backdrop-blur-md bg-white/10 border border-white/20 rounded-xl px-3 py-2 shadow-lg">
              <div className="flex items-center gap-2 mb-1.5">
                <svg className="w-3 h-3 text-white/70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-white/90 text-xs font-semibold uppercase tracking-wide">Timing</span>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
                <div className="text-white/50">Render</div>
                <div className="text-white/80 font-medium">{rendererMetrics.avgRenderInterval.toFixed(1)}ms</div>
                <div className="text-white/50">Arrival</div>
                <div className="text-white/80 font-medium">
                  {frameArrivalTimesRef.current.length > 0
                    ? `${(frameArrivalTimesRef.current.reduce((a, b) => a + b, 0) / frameArrivalTimesRef.current.length).toFixed(1)}ms`
                    : '-'}
                </div>
                <div className="text-white/50">Jumps</div>
                <div className={`font-medium ${rendererMetrics.frameJumps > 0 ? 'text-orange-400' : 'text-emerald-400'}`}>
                  {rendererMetrics.frameJumps} ({rendererMetrics.backwardJumps}↓ {rendererMetrics.forwardJumps}↑)
                </div>
                <div className="text-white/50">FPS</div>
                <div className="text-white/80 font-medium">
                  {rendererMetrics.avgRenderInterval > 0
                    ? Math.round(1000 / rendererMetrics.avgRenderInterval)
                    : '-'}
                </div>
                <div className="text-white/50">Last TS</div>
                <div className="text-white/80 font-medium text-[8px]">
                  {rendererMetrics.lastFrameTimestamp > 0
                    ? `${(rendererMetrics.lastFrameTimestamp / 1000).toFixed(0)}ms`
                    : '-'}
                </div>
              </div>
            </div>

            {/* VOD Fetch Stats Card */}
            {fetchStats && (
              <div className="backdrop-blur-md bg-white/10 border border-white/20 rounded-xl px-3 py-2 shadow-lg">
                <div className="flex items-center gap-2 mb-1.5">
                  <div className={`w-2 h-2 rounded-full ${
                    fetchStats.state === 'playing' ? 'bg-emerald-400' :
                    fetchStats.state === 'rebuffering' ? 'bg-red-400 animate-pulse' :
                    fetchStats.state === 'initial-buffering' ? 'bg-amber-400 animate-pulse' :
                    'bg-white/40'
                  }`} />
                  <span className="text-white/90 text-xs font-semibold uppercase tracking-wide">
                    {fetchStats.strategy === 'legacy' ? 'Fetch' : fetchStats.strategy.toUpperCase()}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
                  <div className="text-white/50">Buffer</div>
                  <div className={`font-medium ${
                    fetchStats.bufferedSeconds < 2 ? 'text-red-400' :
                    fetchStats.bufferedSeconds < 5 ? 'text-amber-400' :
                    'text-emerald-400'
                  }`}>{fetchStats.bufferedSeconds.toFixed(1)}s</div>
                  <div className="text-white/50">State</div>
                  <div className="text-white/80 font-medium capitalize">{fetchStats.state}</div>
                  <div className="text-white/50">Group</div>
                  <div className="text-white/80 font-medium">{fetchStats.playbackGroup}/{fetchStats.fetchedUpToGroup}</div>
                  <div className="text-white/50">DL Speed</div>
                  <div className="text-white/80 font-medium">
                    {fetchStats.avgMsPerGop > 0 ? `${Math.round(fetchStats.avgMsPerGop)}ms/gop` : '-'}
                  </div>
                  <div className="text-white/50">Fetches</div>
                  <div className="text-sky-400 font-medium">{fetchStats.activeFetches}</div>
                </div>
              </div>
            )}

            {/* Log Controls Card */}
            <div className="backdrop-blur-md bg-white/10 border border-white/20 rounded-xl px-3 py-2 shadow-lg pointer-events-auto">
              <div className="flex items-center gap-2 mb-1.5">
                <svg className="w-3 h-3 text-white/70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span className="text-white/90 text-xs font-semibold uppercase tracking-wide">Logs</span>
              </div>
              <div className="flex flex-col gap-1">
                <div className="text-[10px] text-white/50">
                  {diagnosticLogsRef.current.length} entries
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={handleDownloadLogs}
                    className="px-2 py-1 text-[10px] bg-emerald-500/30 hover:bg-emerald-500/50 text-white rounded transition-colors"
                  >
                    Download
                  </button>
                  <button
                    onClick={handleClearLogs}
                    className="px-2 py-1 text-[10px] bg-red-500/30 hover:bg-red-500/50 text-white rounded transition-colors"
                  >
                    Clear
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Center Play Button (when paused) */}
        {!isPlaying && !isSeeking && (
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

      {/* Controls Overlay */}
      {showControls && (
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-3 opacity-0 group-hover:opacity-100 transition-opacity">
          {/* Progress Bar */}
          <div
            className="mb-2 cursor-pointer"
            onClick={handleProgressClick}
          >
            {hasDuration ? (
              // VOD-style progress bar with duration
              <input
                type="range"
                min={0}
                max={duration}
                value={isSeeking ? seekTarget : currentTime}
                onChange={handleSeekBarChange}
                onMouseUp={handleSeekBarCommit}
                onTouchEnd={handleSeekBarCommit}
                className="w-full h-1.5 bg-white/30 rounded-lg appearance-none cursor-pointer
                  [&::-webkit-slider-thumb]:appearance-none
                  [&::-webkit-slider-thumb]:w-3
                  [&::-webkit-slider-thumb]:h-3
                  [&::-webkit-slider-thumb]:rounded-full
                  [&::-webkit-slider-thumb]:bg-white
                  [&::-webkit-slider-thumb]:cursor-pointer
                  [&::-webkit-slider-thumb]:shadow-md
                  [&::-webkit-slider-thumb]:transition-transform
                  [&::-webkit-slider-thumb]:hover:scale-125"
                style={{
                  background: `linear-gradient(to right, #3b82f6 ${progress}%, rgba(255,255,255,0.3) ${progress}%)`,
                }}
              />
            ) : (
              // Live-style progress indicator (no known duration)
              <div className="h-1.5 bg-white/30 rounded-lg relative">
                <div
                  className="absolute inset-y-0 left-0 bg-red-500 rounded-lg"
                  style={{ width: '100%' }}
                />
                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-red-500 rounded-full animate-pulse" />
              </div>
            )}
          </div>

          {/* Controls Row */}
          <div className="flex items-center gap-3">
            {/* Play/Pause Button */}
            <button
              onClick={handlePlayPause}
              disabled={isSeeking}
              className="p-2 rounded-full bg-white/20 hover:bg-white/30 transition-colors disabled:opacity-50"
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
              ) : (
                <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            {/* Time Display */}
            <div className="text-white text-sm font-mono">
              {formatTime(currentTime)}
              {hasDuration && (
                <span className="text-white/60"> / {formatTime(duration)}</span>
              )}
            </div>

            {/* Skip Backward (10s) */}
            <button
              onClick={() => handleSeek(Math.max(0, currentTime - 10000))}
              disabled={isSeeking}
              className="p-1.5 rounded-full hover:bg-white/20 transition-colors disabled:opacity-50"
              title="Back 10s"
            >
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0019 16V8a1 1 0 00-1.6-.8l-5.333 4zM4.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0011 16V8a1 1 0 00-1.6-.8l-5.334 4z" />
              </svg>
            </button>

            {/* Skip Forward (10s) */}
            <button
              onClick={() => handleSeek(hasDuration ? Math.min(duration, currentTime + 10000) : currentTime + 10000)}
              disabled={isSeeking}
              className="p-1.5 rounded-full hover:bg-white/20 transition-colors disabled:opacity-50"
              title="Forward 10s"
            >
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.933 12.8a1 1 0 000-1.6L6.6 7.2A1 1 0 005 8v8a1 1 0 001.6.8l5.333-4zM19.933 12.8a1 1 0 000-1.6l-5.333-4A1 1 0 0013 8v8a1 1 0 001.6.8l5.333-4z" />
              </svg>
            </button>

            {/* Spacer */}
            <div className="flex-1" />

            {/* Live/VOD Badge */}
            {isLive ? (
              <div className="flex items-center gap-1.5 px-2 py-0.5 bg-red-500/80 text-white text-xs rounded-full">
                <span className="w-2 h-2 bg-white rounded-full animate-pulse" />
                LIVE
              </div>
            ) : (
              <div className="px-2 py-0.5 bg-purple-500/80 text-white text-xs rounded-full">
                VOD
              </div>
            )}

            {/* Go to Live Edge Button (for live content) */}
            {isLive && (
              <button
                onClick={() => {
                  // Resume will go to live edge
                  resumeSubscription(subscriptionId);
                  setIsPlaying(true);
                }}
                className="px-2 py-0.5 bg-white/20 hover:bg-white/30 text-white text-xs rounded transition-colors"
                title="Go to live"
              >
                LIVE
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default MoqMediaPlayer;
