// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Catalog Builder Panel
 *
 * UI for building and publishing MSF catalogs with multiple tracks.
 * Supports VOD, live video, audio, subtitles, and media timeline tracks.
 * Works fully offline - no connection required until publish.
 */

import React, { useState, useCallback, useRef } from 'react';
import { TrackCard } from './TrackCard';
import { AddTrackModal } from './AddTrackModal';
import type {
  CatalogTrackConfig,
  CatalogTrackType,
  VODTrackConfig,
  LiveTrackConfig,
  AudioTrackConfig,
  SubtitleTrackConfig,
  TimelineTrackConfig,
} from './types';
import { DEFAULT_TRACK_CONFIGS } from './types';
import { createCatalog, type FullCatalog } from '@web-moq/msf';
import { VODLoader, type VODPreloadMetadata } from '@web-moq/media';

interface CatalogBuilderPanelProps {
  namespace: string;
  onNamespaceChange: (namespace: string) => void;
  onPublishCatalog: (catalog: FullCatalog, tracks: CatalogTrackConfig[]) => void;
  /** Custom text for publish button (e.g., "Connect & Publish" when disconnected) */
  publishButtonText?: string;
  /** Whether publish is in progress */
  isPublishing?: boolean;
}

export const CatalogBuilderPanel: React.FC<CatalogBuilderPanelProps> = ({
  namespace,
  onNamespaceChange,
  onPublishCatalog,
  publishButtonText = 'Publish Catalog',
  isPublishing = false,
}) => {
  const [tracks, setTracks] = useState<CatalogTrackConfig[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addingTrackType, setAddingTrackType] = useState<CatalogTrackType | null>(null);
  const [editingTrack, setEditingTrack] = useState<CatalogTrackConfig | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  // Track VOD loaders for preloading
  const vodLoadersRef = useRef<Map<string, VODLoader>>(new Map());

  // Generate unique ID for new tracks
  const generateId = () => `track-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  // Open add track modal
  const handleAddTrack = (type: CatalogTrackType) => {
    setAddingTrackType(type);
    setEditingTrack(null);
    setShowAddModal(true);
  };

  // Handle track creation from modal
  const handleTrackCreated = useCallback((config: Partial<CatalogTrackConfig>) => {
    const id = generateId();
    const type = addingTrackType!;
    const defaults = DEFAULT_TRACK_CONFIGS[type];

    const newTrack: CatalogTrackConfig = {
      ...defaults,
      ...config,
      id,
      type,
      name: config.name || `${type}-${tracks.length + 1}`,
      status: 'idle',
      experienceProfile: config.experienceProfile || defaults.experienceProfile,
    } as CatalogTrackConfig;

    setTracks(prev => [...prev, newTrack]);
    setShowAddModal(false);
    setAddingTrackType(null);

    // Auto-preload VOD tracks when they have a source
    if (type === 'video-vod') {
      const vodTrack = newTrack as VODTrackConfig;
      if (vodTrack.videoFile || vodTrack.videoUrl) {
        // Schedule preload after state update
        setTimeout(() => handlePreloadVOD(vodTrack), 0);
      }
    }
  }, [addingTrackType, tracks.length]);

  // Handle track update
  const handleTrackUpdated = useCallback((config: Partial<CatalogTrackConfig>) => {
    if (!editingTrack) return;

    setTracks(prev => prev.map(t =>
      t.id === editingTrack.id ? { ...t, ...config } as CatalogTrackConfig : t
    ));
    setShowAddModal(false);
    setEditingTrack(null);
  }, [editingTrack]);

  // Remove track
  const handleRemoveTrack = (id: string) => {
    setTracks(prev => prev.filter(t => t.id !== id));
  };

  // Edit track
  const handleEditTrack = (track: CatalogTrackConfig) => {
    setEditingTrack(track);
    setAddingTrackType(track.type);
    setShowAddModal(true);
  };

  // Update track status
  const updateTrackStatus = (id: string, status: CatalogTrackConfig['status'], error?: string) => {
    setTracks(prev => prev.map(t =>
      t.id === id ? { ...t, status, error } : t
    ));
  };

  // Update VOD track with progress
  const updateVODProgress = (id: string, progress: { phase: string; progress: number; error?: string }) => {
    setTracks(prev => prev.map(t => {
      if (t.id !== id || t.type !== 'video-vod') return t;
      const vodTrack = t as VODTrackConfig;
      return {
        ...vodTrack,
        loadProgress: {
          phase: progress.phase as 'fetching' | 'decoding' | 'complete' | 'error',
          progress: progress.progress,
        },
        status: progress.phase === 'error' ? 'error' : progress.phase === 'complete' ? 'ready' : 'loading',
        error: progress.error,
      } as VODTrackConfig;
    }));
  };

  // Preload VOD video - fetches and validates without full decode
  const handlePreloadVOD = async (track: VODTrackConfig) => {
    const useFile = !!track.videoFile;

    // Validate source is provided
    if (!useFile && !track.videoUrl) {
      updateTrackStatus(track.id, 'error', 'No video source specified');
      return;
    }

    // Validate URL format if using URL
    if (!useFile) {
      const urlString = track.videoUrl.trim();
      try {
        const url = new URL(urlString);
        if (!['http:', 'https:'].includes(url.protocol)) {
          updateTrackStatus(track.id, 'error', 'URL must use http or https protocol');
          return;
        }
      } catch {
        // Check if it looks like multiple URLs or comments were pasted
        if (urlString.includes('\n') || urlString.includes('#')) {
          updateTrackStatus(track.id, 'error', 'Invalid URL: contains multiple lines or comments. Please enter a single URL.');
        } else {
          updateTrackStatus(track.id, 'error', `Invalid URL format: "${urlString.slice(0, 50)}${urlString.length > 50 ? '...' : ''}"`);
        }
        return;
      }
    }

    updateTrackStatus(track.id, 'loading');
    updateVODProgress(track.id, { phase: 'fetching', progress: 0 });

    try {
      // Create or get loader for this track
      let loader = vodLoadersRef.current.get(track.id);
      if (!loader) {
        loader = new VODLoader({
          framerate: track.framerate,
          width: track.width,
          height: track.height,
          bitrate: track.bitrate,
          loop: track.loopPlayback,
          onProgress: (progress) => {
            updateVODProgress(track.id, progress);
          },
        });
        vodLoadersRef.current.set(track.id, loader);
      }

      let metadata: VODPreloadMetadata;

      if (useFile) {
        console.log('[CatalogBuilder] Preloading VOD from file:', track.videoFile!.name);
        metadata = await loader.preloadFile(track.videoFile!);
      } else {
        console.log('[CatalogBuilder] Preloading VOD from URL:', track.videoUrl);
        metadata = await loader.preload(track.videoUrl);
      }
      console.log('[CatalogBuilder] VOD preloaded:', metadata);

      // Update track with actual video metadata including VOD-specific fields
      setTracks(prev => prev.map(t => {
        if (t.id !== track.id) return t;
        const vodTrack = t as VODTrackConfig;
        return {
          ...vodTrack,
          status: 'ready',
          duration: metadata.duration,
          width: metadata.width,
          height: metadata.height,
          framerate: metadata.framerate, // Actual framerate from video
          codec: metadata.codec ?? vodTrack.codec, // Actual codec if extracted
          totalGroups: metadata.totalGroups,
          gopDuration: metadata.gopDuration,
          loadProgress: { phase: 'complete', progress: 100 },
        } as VODTrackConfig;
      }));
    } catch (err) {
      const error = (err as Error).message;
      console.error('[CatalogBuilder] Preload failed:', error);
      updateVODProgress(track.id, { phase: 'error', progress: 0, error });
    }
  };

  // Build MSF catalog from tracks
  const buildCatalog = (): FullCatalog => {
    const builder = createCatalog().generatedAt();

    for (const track of tracks) {
      switch (track.type) {
        case 'video-vod': {
          const t = track as VODTrackConfig;
          builder.addVideoTrack({
            name: t.name,
            codec: t.codec,
            width: t.width,
            height: t.height,
            framerate: t.framerate,
            bitrate: t.bitrate,
            isLive: false,
            targetLatency: getTargetLatency(t.experienceProfile),
            // VOD metadata for player controls
            trackDuration: t.duration, // Duration in ms (timescale=1000)
            timescale: 1000,
            totalGroups: t.totalGroups,
            gopDuration: t.gopDuration,
          });
          break;
        }
        case 'video-live': {
          const t = track as LiveTrackConfig;
          builder.addVideoTrack({
            name: t.name,
            codec: t.codec,
            width: t.width,
            height: t.height,
            framerate: t.framerate,
            bitrate: t.bitrate,
            isLive: true,
            targetLatency: getTargetLatency(t.experienceProfile),
          });
          break;
        }
        case 'audio': {
          const t = track as AudioTrackConfig;
          builder.addAudioTrack({
            name: t.name,
            codec: t.codec,
            samplerate: t.samplerate,
            channelConfig: t.channelConfig,
            bitrate: t.bitrate,
            isLive: true, // Audio typically follows video liveness
            targetLatency: getTargetLatency(t.experienceProfile),
          });
          break;
        }
        case 'subtitle': {
          const t = track as SubtitleTrackConfig;
          // Use addTrack directly since addDataTrack doesn't support 'subtitle' role
          builder.addTrack({
            name: t.name,
            packaging: 'loc',
            isLive: false,
            mimeType: t.format === 'webvtt' ? 'text/vtt' : 'application/x-subrip',
            role: 'subtitle',
            label: t.label,
            lang: t.language,
          });
          break;
        }
        case 'timeline': {
          const t = track as TimelineTrackConfig;
          builder.addDataTrack({
            name: t.name,
            packaging: 'mediatimeline',
            isLive: false,
            role: 'metadata',
            timescale: t.timescale,
          });
          break;
        }
      }
    }

    return builder.build();
  };

  // Get target latency from experience profile
  function getTargetLatency(profile: string): number {
    switch (profile) {
      case 'interactive': return 50;
      case 'streaming': return 500;
      case 'broadcast': return 2000;
      default: return 100;
    }
  }

  // Handle publish catalog
  const handlePublishCatalog = async () => {
    if (tracks.length === 0) return;

    try {
      const catalog = buildCatalog();
      await onPublishCatalog(catalog, tracks);
    } catch (err) {
      console.error('Failed to publish catalog:', err);
    }
  };

  // Render catalog preview
  const previewCatalog = tracks.length > 0 ? buildCatalog() : null;

  // Track type buttons config
  const trackTypes: { type: CatalogTrackType; label: string }[] = [
    { type: 'video-vod', label: 'VOD' },
    { type: 'video-live', label: 'Live' },
    { type: 'audio', label: 'Audio' },
    { type: 'subtitle', label: 'Subtitle' },
    { type: 'timeline', label: 'Timeline' },
  ];

  return (
    <div className="space-y-6">
      {/* Namespace Input */}
      <div className="glass-panel">
        <div className="glass-panel-header">
          <svg className="w-5 h-5 text-accent-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          </svg>
          Catalog Configuration
        </div>
        <div className="glass-panel-body space-y-4">
          <div>
            <label className="label">Namespace</label>
            <input
              type="text"
              value={namespace}
              onChange={(e) => onNamespaceChange(e.target.value)}
              placeholder="conference/room-1/media"
              className="input"
            />
            <p className="text-xs text-gray-400 dark:text-white/40 mt-2">
              Base namespace for publishing the catalog and tracks
            </p>
          </div>
        </div>
      </div>

      {/* Track List */}
      <div className="glass-panel">
        <div className="glass-panel-header justify-between">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-accent-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
            <span>Tracks</span>
            {tracks.length > 0 && (
              <span className="badge-blue">{tracks.length}</span>
            )}
          </div>
        </div>

        {/* Add Track Buttons */}
        <div className="px-5 py-3 border-b border-white/5 flex flex-wrap gap-2">
          {trackTypes.map(({ type, label }) => (
            <button
              key={type}
              onClick={() => handleAddTrack(type)}
              className="btn-sm btn-secondary flex items-center gap-1.5"
              title={`Add ${label} Track`}
            >
              <svg className="w-3.5 h-3.5 text-gray-500 dark:text-white/50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              {label}
            </button>
          ))}
        </div>

        <div className="glass-panel-body">
          {tracks.length === 0 ? (
            <div className="text-center py-12">
              <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-white/5 flex items-center justify-center">
                <svg className="w-8 h-8 text-gray-200 dark:text-white/20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
              </div>
              <p className="text-gray-600 dark:text-white/60 font-medium">No tracks configured</p>
              <p className="text-gray-400 dark:text-white/40 text-sm mt-1">Add VOD, Live, Audio, or Subtitle tracks to build your catalog</p>
            </div>
          ) : (
            <div className="space-y-3">
              {tracks.map(track => (
                <TrackCard
                  key={track.id}
                  track={track}
                  onEdit={() => handleEditTrack(track)}
                  onRemove={() => handleRemoveTrack(track.id)}
                  onPreload={track.type === 'video-vod' ? () => handlePreloadVOD(track as VODTrackConfig) : undefined}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Catalog Preview */}
      {tracks.length > 0 && previewCatalog && (
        <div className="glass-panel">
          <div className="glass-panel-header justify-between">
            <div className="flex items-center gap-3">
              <svg className="w-5 h-5 text-accent-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
              </svg>
              <span>Catalog Preview</span>
            </div>
            <button
              onClick={() => setShowPreview(!showPreview)}
              className="btn-sm btn-ghost"
            >
              {showPreview ? 'Hide' : 'Show'} JSON
            </button>
          </div>
          {showPreview && (
            <div className="glass-panel-body">
              <pre className="text-xs text-gray-700 dark:text-white/70 p-4 rounded-xl overflow-auto max-h-64 bg-black/30 border border-white/5">
                {JSON.stringify(previewCatalog, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Publish Action */}
      <button
        onClick={handlePublishCatalog}
        disabled={tracks.length === 0 || isPublishing}
        className="btn-primary w-full flex items-center justify-center gap-2 py-3"
      >
        {isPublishing ? (
          <>
            <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            {publishButtonText}
          </>
        ) : (
          <>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            {publishButtonText}
          </>
        )}
      </button>

      {/* Add/Edit Track Modal */}
      {showAddModal && addingTrackType && (
        <AddTrackModal
          type={addingTrackType}
          existingTrack={editingTrack}
          onSave={editingTrack ? handleTrackUpdated : handleTrackCreated}
          onClose={() => {
            setShowAddModal(false);
            setAddingTrackType(null);
            setEditingTrack(null);
          }}
        />
      )}
    </div>
  );
};
