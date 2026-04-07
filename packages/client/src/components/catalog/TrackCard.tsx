// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Track Card Component
 *
 * Displays a single track in the catalog builder with status and controls.
 */

import React from 'react';
import type { CatalogTrackConfig, VODTrackConfig, LiveTrackConfig, AudioTrackConfig, SubtitleTrackConfig, TimelineTrackConfig } from './types';
import { EXPERIENCE_PROFILE_INFO } from './types';

interface TrackCardProps {
  track: CatalogTrackConfig;
  onEdit: () => void;
  onRemove: () => void;
  onStartPublish: () => void;
  onStopPublish: () => void;
}

const TrackTypeIcon: React.FC<{ type: CatalogTrackConfig['type'] }> = ({ type }) => {
  switch (type) {
    case 'video-vod':
      return (
        <svg className="w-5 h-5 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
        </svg>
      );
    case 'video-live':
      return (
        <svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      );
    case 'audio':
      return (
        <svg className="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
        </svg>
      );
    case 'subtitle':
      return (
        <svg className="w-5 h-5 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
        </svg>
      );
    case 'timeline':
      return (
        <svg className="w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
  }
};

const TrackTypeBadge: React.FC<{ track: CatalogTrackConfig }> = ({ track }) => {
  switch (track.type) {
    case 'video-vod':
      return (
        <span className="px-2 py-0.5 text-xs rounded-full bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300">
          VOD
        </span>
      );
    case 'video-live':
    case 'audio':
      return (
        <span className="px-2 py-0.5 text-xs rounded-full bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300">
          LIVE
        </span>
      );
    case 'subtitle':
      return (
        <span className="px-2 py-0.5 text-xs rounded-full bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300">
          SUBTITLE
        </span>
      );
    case 'timeline':
      return (
        <span className="px-2 py-0.5 text-xs rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
          TIMELINE
        </span>
      );
  }
};

const TrackDetails: React.FC<{ track: CatalogTrackConfig }> = ({ track }) => {
  switch (track.type) {
    case 'video-vod': {
      const t = track as VODTrackConfig;
      const durationStr = formatDuration(t.duration);
      return (
        <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
          <div className="truncate" title={t.videoUrl}>URL: {t.videoUrl || 'Not set'}</div>
          <div>{t.width}x{t.height} @ {t.framerate}fps | {formatBitrate(t.bitrate)}</div>
          <div>Duration: {durationStr} | DVR: {t.enableDvr ? 'Yes' : 'No'} | Loop: {t.loopPlayback ? 'Yes' : 'No'}</div>
        </div>
      );
    }
    case 'video-live': {
      const t = track as LiveTrackConfig;
      return (
        <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
          <div>Source: {t.deviceId ? 'Camera selected' : 'Default camera'}</div>
          <div>{t.width}x{t.height} @ {t.framerate}fps | {formatBitrate(t.bitrate)}</div>
        </div>
      );
    }
    case 'audio': {
      const t = track as AudioTrackConfig;
      return (
        <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
          <div>Source: {t.deviceId ? 'Microphone selected' : 'Default microphone'}</div>
          <div>{t.codec} | {t.samplerate}Hz | {t.channelConfig} | {formatBitrate(t.bitrate)}</div>
        </div>
      );
    }
    case 'subtitle': {
      const t = track as SubtitleTrackConfig;
      return (
        <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
          <div>Language: {t.label} ({t.language})</div>
          <div>Format: {t.format.toUpperCase()}</div>
        </div>
      );
    }
    case 'timeline': {
      const t = track as TimelineTrackConfig;
      return (
        <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
          <div>Timescale: {t.timescale} units/sec</div>
          <div>Media timeline for VOD seeking</div>
        </div>
      );
    }
  }
};

const StatusIndicator: React.FC<{ status: CatalogTrackConfig['status']; error?: string }> = ({ status, error }) => {
  switch (status) {
    case 'idle':
      return <span className="badge badge-gray">Ready</span>;
    case 'loading':
      return (
        <span className="badge badge-blue flex items-center gap-1">
          <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          Loading
        </span>
      );
    case 'ready':
      return <span className="badge badge-green">Ready</span>;
    case 'publishing':
      return (
        <span className="badge badge-green flex items-center gap-1">
          <span className="w-2 h-2 bg-white rounded-full animate-pulse" />
          Publishing
        </span>
      );
    case 'error':
      return (
        <span className="badge badge-red" title={error}>
          Error
        </span>
      );
  }
};

function formatDuration(ms: number): string {
  if (ms === 0) return '--:--';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function formatBitrate(bps: number): string {
  if (bps >= 1_000_000) {
    return `${(bps / 1_000_000).toFixed(1)}Mbps`;
  }
  return `${(bps / 1_000).toFixed(0)}kbps`;
}

export const TrackCard: React.FC<TrackCardProps> = ({
  track,
  onEdit,
  onRemove,
  onStartPublish,
  onStopPublish,
}) => {
  const profileInfo = EXPERIENCE_PROFILE_INFO[track.experienceProfile];
  const isPublishing = track.status === 'publishing';
  const canPublish = track.status === 'ready' || track.status === 'idle';

  return (
    <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <TrackTypeIcon type={track.type} />
          <span className="font-medium">{track.name}</span>
          <TrackTypeBadge track={track} />
        </div>
        <StatusIndicator status={track.status} error={track.error} />
      </div>

      {/* Details */}
      <TrackDetails track={track} />

      {/* Experience Profile */}
      <div className="mt-2 text-xs">
        <span className="text-gray-400">Profile:</span>{' '}
        <span className="text-primary-600 dark:text-primary-400">
          {profileInfo.label} ({profileInfo.targetLatency})
        </span>
      </div>

      {/* Loading Progress (for VOD) */}
      {track.type === 'video-vod' && (track as VODTrackConfig).loadProgress && (
        <div className="mt-2">
          <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
            <span>{(track as VODTrackConfig).loadProgress?.phase}</span>
            <span>{(track as VODTrackConfig).loadProgress?.progress}%</span>
          </div>
          <div className="h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary-500 transition-all duration-300"
              style={{ width: `${(track as VODTrackConfig).loadProgress?.progress ?? 0}%` }}
            />
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 mt-3">
        {!isPublishing ? (
          <button
            onClick={onStartPublish}
            disabled={!canPublish}
            className="btn-success btn-sm flex-1"
          >
            Start Publishing
          </button>
        ) : (
          <button
            onClick={onStopPublish}
            className="btn-warning btn-sm flex-1"
          >
            Stop Publishing
          </button>
        )}
        <button
          onClick={onEdit}
          disabled={isPublishing}
          className="btn-secondary btn-sm"
        >
          Edit
        </button>
        <button
          onClick={onRemove}
          disabled={isPublishing}
          className="btn-danger btn-sm"
        >
          Remove
        </button>
      </div>
    </div>
  );
};
