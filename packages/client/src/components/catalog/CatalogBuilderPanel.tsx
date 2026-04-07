// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Catalog Builder Panel
 *
 * UI for building and publishing MSF catalogs with multiple tracks.
 * Supports VOD, live video, audio, subtitles, and media timeline tracks.
 */

import React, { useState, useCallback } from 'react';
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

interface CatalogBuilderPanelProps {
  namespace: string;
  onNamespaceChange: (namespace: string) => void;
  onPublishCatalog: (catalog: FullCatalog, tracks: CatalogTrackConfig[]) => void;
}

export const CatalogBuilderPanel: React.FC<CatalogBuilderPanelProps> = ({
  namespace,
  onNamespaceChange,
  onPublishCatalog,
}) => {
  const [tracks, setTracks] = useState<CatalogTrackConfig[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addingTrackType, setAddingTrackType] = useState<CatalogTrackType | null>(null);
  const [editingTrack, setEditingTrack] = useState<CatalogTrackConfig | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [catalogStatus, setCatalogStatus] = useState<'idle' | 'publishing' | 'published'>('idle');

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

    setCatalogStatus('publishing');
    try {
      const catalog = buildCatalog();
      await onPublishCatalog(catalog, tracks);
      setCatalogStatus('published');
    } catch (err) {
      console.error('Failed to publish catalog:', err);
      setCatalogStatus('idle');
    }
  };

  // Render catalog preview
  const previewCatalog = buildCatalog();

  return (
    <div className="space-y-6">
      {/* Namespace Input */}
      <div className="panel">
        <div className="panel-header">Catalog Configuration</div>
        <div className="panel-body space-y-4">
          <div>
            <label className="label">Namespace</label>
            <input
              type="text"
              value={namespace}
              onChange={(e) => onNamespaceChange(e.target.value)}
              placeholder="conference/room-1/media"
              className="input"
            />
            <p className="text-xs text-gray-500 mt-1">
              Base namespace for publishing the catalog and tracks
            </p>
          </div>
        </div>
      </div>

      {/* Track List */}
      <div className="panel">
        <div className="panel-header flex items-center justify-between">
          <span>Tracks ({tracks.length})</span>
          <div className="flex gap-2">
            <button
              onClick={() => handleAddTrack('video-vod')}
              className="btn-sm btn-secondary flex items-center gap-1"
              title="Add VOD Video Track"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              VOD
            </button>
            <button
              onClick={() => handleAddTrack('video-live')}
              className="btn-sm btn-secondary flex items-center gap-1"
              title="Add Live Video Track"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Live
            </button>
            <button
              onClick={() => handleAddTrack('audio')}
              className="btn-sm btn-secondary flex items-center gap-1"
              title="Add Audio Track"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Audio
            </button>
            <button
              onClick={() => handleAddTrack('subtitle')}
              className="btn-sm btn-secondary flex items-center gap-1"
              title="Add Subtitle Track"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Subtitle
            </button>
            <button
              onClick={() => handleAddTrack('timeline')}
              className="btn-sm btn-secondary flex items-center gap-1"
              title="Add Media Timeline Track"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Timeline
            </button>
          </div>
        </div>
        <div className="panel-body">
          {tracks.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <svg className="w-12 h-12 mx-auto mb-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              <p>No tracks configured</p>
              <p className="text-sm">Add VOD, Live, Audio, or Subtitle tracks to build your catalog</p>
            </div>
          ) : (
            <div className="space-y-3">
              {tracks.map(track => (
                <TrackCard
                  key={track.id}
                  track={track}
                  onEdit={() => handleEditTrack(track)}
                  onRemove={() => handleRemoveTrack(track.id)}
                  onStartPublish={() => updateTrackStatus(track.id, 'publishing')}
                  onStopPublish={() => updateTrackStatus(track.id, 'ready')}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Catalog Preview */}
      {tracks.length > 0 && (
        <div className="panel">
          <div className="panel-header flex items-center justify-between">
            <span>Catalog Preview</span>
            <button
              onClick={() => setShowPreview(!showPreview)}
              className="btn-sm btn-secondary"
            >
              {showPreview ? 'Hide' : 'Show'} JSON
            </button>
          </div>
          {showPreview && (
            <div className="panel-body">
              <pre className="text-xs bg-gray-900 text-gray-100 p-4 rounded-lg overflow-auto max-h-64">
                {JSON.stringify(previewCatalog, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Publish Actions */}
      <div className="flex gap-3">
        <button
          onClick={handlePublishCatalog}
          disabled={tracks.length === 0 || catalogStatus === 'publishing'}
          className="btn-primary flex-1 flex items-center justify-center gap-2"
        >
          {catalogStatus === 'publishing' ? (
            <>
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Publishing...
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              Publish Catalog
            </>
          )}
        </button>
      </div>

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
