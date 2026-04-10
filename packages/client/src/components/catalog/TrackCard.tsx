// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Track Card Component
 *
 * Displays a single track in the catalog builder with status and controls.
 * Glassmorphic design with status-aware styling.
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
  onPreload?: () => void;
}

// Track type icons with glassmorphic colors
const TrackTypeIcon: React.FC<{ type: CatalogTrackConfig['type'] }> = ({ type }) => {
  const iconPaths: Record<string, string> = {
    'video-vod': 'M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z',
    'video-live': 'M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z',
    'audio': 'M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z',
    'subtitle': 'M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z',
    'timeline': 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  };

  const iconColors: Record<string, string> = {
    'video-vod': 'text-accent-purple',
    'video-live': 'text-red-400',
    'audio': 'text-emerald-400',
    'subtitle': 'text-amber-400',
    'timeline': 'text-blue-400',
  };

  return (
    <svg className={`w-5 h-5 ${iconColors[type]}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={iconPaths[type]} />
    </svg>
  );
};

// Track type badge
const TrackTypeBadge: React.FC<{ track: CatalogTrackConfig }> = ({ track }) => {
  const badges: Record<string, { className: string; label: string }> = {
    'video-vod': { className: 'badge-purple', label: 'VOD' },
    'video-live': { className: 'badge-red', label: 'LIVE' },
    'audio': { className: 'badge-green', label: 'AUDIO' },
    'subtitle': { className: 'badge-yellow', label: 'SUBTITLE' },
    'timeline': { className: 'badge-blue', label: 'TIMELINE' },
  };

  const config = badges[track.type] || { className: 'badge', label: track.type };
  return <span className={config.className}>{config.label}</span>;
};

// Track details
const TrackDetails: React.FC<{ track: CatalogTrackConfig }> = ({ track }) => {
  switch (track.type) {
    case 'video-vod': {
      const t = track as VODTrackConfig;
      return (
        <div className="text-xs text-muted space-y-1">
          <div className="truncate" title={t.videoUrl}>
            <span className="text-hint">URL:</span> {t.videoUrl || 'Not set'}
          </div>
          <div>
            <span className="text-tertiary">{t.width}x{t.height}</span>
            <span className="text-hint"> @ </span>
            <span className="text-tertiary">{t.framerate}fps</span>
            <span className="text-hint"> | </span>
            <span className="text-tertiary">{formatBitrate(t.bitrate)}</span>
          </div>
          <div>
            <span className="text-hint">Duration:</span> {formatDuration(t.duration)}
            <span className="text-hint"> | DVR:</span> {t.enableDvr ? 'Yes' : 'No'}
            <span className="text-hint"> | Loop:</span> {t.loopPlayback ? 'Yes' : 'No'}
          </div>
        </div>
      );
    }
    case 'video-live': {
      const t = track as LiveTrackConfig;
      return (
        <div className="text-xs text-muted space-y-1">
          <div><span className="text-hint">Source:</span> {t.deviceId ? 'Camera selected' : 'Default camera'}</div>
          <div>
            <span className="text-tertiary">{t.width}x{t.height}</span>
            <span className="text-hint"> @ </span>
            <span className="text-tertiary">{t.framerate}fps</span>
            <span className="text-hint"> | </span>
            <span className="text-tertiary">{formatBitrate(t.bitrate)}</span>
          </div>
        </div>
      );
    }
    case 'audio': {
      const t = track as AudioTrackConfig;
      return (
        <div className="text-xs text-muted space-y-1">
          <div><span className="text-hint">Source:</span> {t.deviceId ? 'Microphone selected' : 'Default microphone'}</div>
          <div>
            <span className="text-tertiary">{t.codec}</span>
            <span className="text-hint"> | </span>
            <span className="text-tertiary">{t.samplerate}Hz</span>
            <span className="text-hint"> | </span>
            <span className="text-tertiary">{t.channelConfig}</span>
          </div>
        </div>
      );
    }
    case 'subtitle': {
      const t = track as SubtitleTrackConfig;
      return (
        <div className="text-xs text-muted space-y-1">
          <div><span className="text-hint">Language:</span> {t.label} ({t.language})</div>
          <div><span className="text-hint">Format:</span> {t.format.toUpperCase()}</div>
        </div>
      );
    }
    case 'timeline': {
      const t = track as TimelineTrackConfig;
      return (
        <div className="text-xs text-muted space-y-1">
          <div><span className="text-hint">Timescale:</span> {t.timescale} units/sec</div>
          <div className="text-hint">Media timeline for VOD seeking</div>
        </div>
      );
    }
  }
};

// Status indicator with glow
const StatusIndicator: React.FC<{ status: CatalogTrackConfig['status']; error?: string }> = ({ status, error }) => {
  switch (status) {
    case 'idle':
      return <span className="badge">Ready</span>;
    case 'loading':
      return (
        <span className="badge-blue flex items-center gap-1">
          <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          Loading
        </span>
      );
    case 'ready':
      return <span className="badge-green">Ready</span>;
    case 'publishing':
      return (
        <span className="badge-green flex items-center gap-1">
          <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
          Publishing
        </span>
      );
    case 'error':
      return <span className="badge-red" title={error}>Error</span>;
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
  onPreload,
}) => {
  const profileInfo = EXPERIENCE_PROFILE_INFO[track.experienceProfile];
  const isPublishing = track.status === 'publishing';
  const isLoading = track.status === 'loading';
  const canPublish = track.status === 'ready' || track.status === 'idle';
  const canPreload = track.type === 'video-vod' && track.status === 'idle' && onPreload;

  return (
    <div className="glass-panel-subtle p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <TrackTypeIcon type={track.type} />
          <span className="font-medium text-secondary">{track.name}</span>
          <TrackTypeBadge track={track} />
        </div>
        <StatusIndicator status={track.status} error={track.error} />
      </div>

      {/* Details */}
      <TrackDetails track={track} />

      {/* Experience Profile */}
      <div className="mt-3 text-xs">
        <span className="text-hint">Profile:</span>{' '}
        <span className="text-accent-cyan">
          {profileInfo.label}
        </span>
        <span className="text-hint"> ({profileInfo.targetLatency})</span>
      </div>

      {/* Loading Progress (for VOD) */}
      {track.type === 'video-vod' && (track as VODTrackConfig).loadProgress && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs text-muted mb-1">
            <span>{(track as VODTrackConfig).loadProgress?.phase}</span>
            <span>{(track as VODTrackConfig).loadProgress?.progress}%</span>
          </div>
          <div className="h-1 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${(track as VODTrackConfig).loadProgress?.progress ?? 0}%`,
                background: 'linear-gradient(90deg, #a855f7 0%, #6366f1 50%, #0ea5e9 100%)',
              }}
            />
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 mt-4">
        {!isPublishing ? (
          <>
            {canPreload && (
              <button
                onClick={onPreload}
                disabled={isLoading}
                className="btn-primary btn-sm"
                title="Preload video to verify it can be decoded"
              >
                {isLoading ? 'Loading...' : 'Preload'}
              </button>
            )}
            <button
              onClick={onStartPublish}
              disabled={!canPublish}
              className="btn-success btn-sm flex-1"
            >
              Start
            </button>
          </>
        ) : (
          <button
            onClick={onStopPublish}
            className="btn-secondary btn-sm flex-1"
          >
            Stop
          </button>
        )}
        <button
          onClick={onEdit}
          disabled={isPublishing || isLoading}
          className="btn-secondary btn-sm"
        >
          Edit
        </button>
        <button
          onClick={onRemove}
          disabled={isPublishing || isLoading}
          className="btn-danger btn-sm"
        >
          Remove
        </button>
      </div>
    </div>
  );
};
