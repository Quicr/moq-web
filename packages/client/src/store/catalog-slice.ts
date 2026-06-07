// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Catalog Store Slice
 *
 * State management for MSF catalog building, publishing, and subscribing.
 */

import type { StateCreator } from 'zustand';
import type { FullCatalog } from '@web-moq/msf';
import { VODLoader, type VODLoadProgress } from '@web-moq/media';
import type {
  CatalogTrackConfig,
  CatalogTrackType,
  VODTrackConfig,
} from '../components/catalog/types';
import { DEFAULT_TRACK_CONFIGS } from '../components/catalog/types';
import type { SubtitleCue } from '../components/player/SubtitleOverlay';

/**
 * Timeline entry mapping group to timestamp
 */
export interface TimelineEntry {
  groupId: number;
  timestamp: number; // milliseconds
  objectCount: number;
}

/**
 * Timeline data for VOD seeking
 */
export interface TimelineData {
  version: number;
  timescale: number;
  duration: number; // milliseconds
  frameCount: number;
  framerate: number;
  entries: TimelineEntry[];
}

/**
 * Catalog slice state
 */
export interface CatalogSlice {
  // Builder state
  catalogNamespace: string;
  catalogTracks: CatalogTrackConfig[];

  // Publishing state
  publishedCatalog: FullCatalog | null;
  catalogPublishStatus: 'idle' | 'publishing' | 'published' | 'error';
  catalogPublishError: string | null;

  // Subscription state
  receivedCatalog: FullCatalog | null;
  catalogSubscribeStatus: 'idle' | 'subscribing' | 'subscribed' | 'error';

  // Subtitle state (keyed by track name)
  subtitleCues: Map<string, SubtitleCue[]>;
  activeSubtitleTrack: string | null;

  // Timeline state (for VOD seeking)
  timelineData: TimelineData | null;

  // VOD loaders (keyed by track ID)
  vodLoaders: Map<string, VODLoader>;

  // Actions - Builder
  setCatalogNamespace: (namespace: string) => void;
  addCatalogTrack: (type: CatalogTrackType) => string;
  updateCatalogTrack: (id: string, updates: Partial<CatalogTrackConfig>) => void;
  removeCatalogTrack: (id: string) => void;
  clearCatalogTracks: () => void;

  // Actions - VOD Loading
  loadVODTrack: (trackId: string, url: string) => Promise<void>;
  getVODLoader: (trackId: string) => VODLoader | undefined;

  // Actions - Publishing
  setCatalogPublishStatus: (status: 'idle' | 'publishing' | 'published' | 'error', error?: string) => void;
  setPublishedCatalog: (catalog: FullCatalog | null) => void;

  // Actions - Subscription
  setReceivedCatalog: (catalog: FullCatalog | null) => void;
  setCatalogSubscribeStatus: (status: 'idle' | 'subscribing' | 'subscribed' | 'error') => void;

  // Actions - Subtitles
  setSubtitleCues: (trackName: string, cues: SubtitleCue[]) => void;
  addSubtitleCue: (trackName: string, cue: SubtitleCue) => void;
  setActiveSubtitleTrack: (trackName: string | null) => void;
  getSubtitleCues: (trackName?: string) => SubtitleCue[];
  clearSubtitles: () => void;

  // Actions - Timeline
  setTimelineData: (data: TimelineData | null) => void;
  getGroupForTimestamp: (timestampMs: number) => { groupId: number; objectId: number } | null;
  getTimestampForGroup: (groupId: number) => number | null;
}

/**
 * Generate unique track ID
 */
function generateTrackId(): string {
  return `track-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Create the catalog slice
 */
export const createCatalogSlice: StateCreator<CatalogSlice> = (set, get, _api) => ({
  // Initial state
  catalogNamespace: 'conference/room-1/media',
  catalogTracks: [],
  publishedCatalog: null,
  catalogPublishStatus: 'idle',
  catalogPublishError: null,
  receivedCatalog: null,
  catalogSubscribeStatus: 'idle',
  vodLoaders: new Map(),
  subtitleCues: new Map(),
  activeSubtitleTrack: null,
  timelineData: null,

  // Builder actions
  setCatalogNamespace: (namespace) => set({ catalogNamespace: namespace }),

  addCatalogTrack: (type) => {
    const id = generateTrackId();
    const defaults = DEFAULT_TRACK_CONFIGS[type];
    const { catalogTracks } = get();

    const trackCount = catalogTracks.filter(t => t.type === type).length;
    const name = `${type.replace('video-', '')}-${trackCount + 1}`;

    const newTrack: CatalogTrackConfig = {
      ...defaults,
      id,
      type,
      name,
      status: 'idle',
      experienceProfile: defaults.experienceProfile,
    } as CatalogTrackConfig;

    // Add type-specific defaults
    if (type === 'video-vod') {
      (newTrack as VODTrackConfig).videoUrl = '';
      (newTrack as VODTrackConfig).duration = 0;
    }

    set({ catalogTracks: [...catalogTracks, newTrack] });
    return id;
  },

  updateCatalogTrack: (id, updates) => {
    const { catalogTracks } = get();
    set({
      catalogTracks: catalogTracks.map(t =>
        t.id === id ? { ...t, ...updates } as CatalogTrackConfig : t
      ),
    });
  },

  removeCatalogTrack: (id) => {
    const { catalogTracks, vodLoaders } = get();

    // Clean up VOD loader if exists
    const loader = vodLoaders.get(id);
    if (loader) {
      loader.clear();
      vodLoaders.delete(id);
    }

    set({ catalogTracks: catalogTracks.filter(t => t.id !== id) });
  },

  clearCatalogTracks: () => {
    const { vodLoaders } = get();

    // Clean up all VOD loaders
    for (const loader of vodLoaders.values()) {
      loader.clear();
    }

    set({
      catalogTracks: [],
      vodLoaders: new Map(),
    });
  },

  // VOD Loading actions
  loadVODTrack: async (trackId, url) => {
    const { catalogTracks, vodLoaders, updateCatalogTrack } = get();
    const track = catalogTracks.find(t => t.id === trackId);

    if (!track || track.type !== 'video-vod') {
      console.error('[CatalogSlice] Track not found or not VOD:', trackId);
      return;
    }

    const vodTrack = track as VODTrackConfig;

    // Update track with URL and loading status
    updateCatalogTrack(trackId, {
      videoUrl: url,
      status: 'loading',
      loadProgress: { phase: 'fetching', progress: 0 },
    } as Partial<VODTrackConfig>);

    // Create loader
    const loader = new VODLoader({
      framerate: vodTrack.framerate,
      width: vodTrack.width,
      height: vodTrack.height,
      bitrate: vodTrack.bitrate,
      loop: vodTrack.loopPlayback,
      onProgress: (progress: VODLoadProgress) => {
        updateCatalogTrack(trackId, {
          loadProgress: progress,
        } as Partial<VODTrackConfig>);
      },
    });

    vodLoaders.set(trackId, loader);

    try {
      await loader.load(url);
      const metadata = loader.getMetadata();

      updateCatalogTrack(trackId, {
        status: 'ready',
        duration: metadata?.duration ?? 0,
        loadProgress: { phase: 'complete', progress: 100 },
      } as Partial<VODTrackConfig>);

      console.log('[CatalogSlice] VOD loaded:', {
        trackId,
        duration: metadata?.duration,
        frames: loader.frameCount,
      });
    } catch (err) {
      console.error('[CatalogSlice] Failed to load VOD:', err);
      updateCatalogTrack(trackId, {
        status: 'error',
        error: (err as Error).message,
        loadProgress: { phase: 'error', progress: 0, error: (err as Error).message },
      } as Partial<VODTrackConfig>);
    }
  },

  getVODLoader: (trackId) => {
    const { vodLoaders } = get();
    return vodLoaders.get(trackId);
  },

  // Publishing actions
  setCatalogPublishStatus: (status, error) => set({
    catalogPublishStatus: status,
    catalogPublishError: error ?? null,
  }),

  setPublishedCatalog: (catalog) => set({ publishedCatalog: catalog }),

  // Subscription actions
  setReceivedCatalog: (catalog) => set({ receivedCatalog: catalog }),

  setCatalogSubscribeStatus: (status) => set({ catalogSubscribeStatus: status }),

  // Subtitle actions
  setSubtitleCues: (trackName, cues) => {
    const { subtitleCues } = get();
    const newMap = new Map(subtitleCues);
    newMap.set(trackName, cues);
    set({ subtitleCues: newMap });
  },

  addSubtitleCue: (trackName, cue) => {
    const { subtitleCues } = get();
    const existing = subtitleCues.get(trackName) ?? [];
    const newMap = new Map(subtitleCues);
    newMap.set(trackName, [...existing, cue]);
    set({ subtitleCues: newMap });
  },

  setActiveSubtitleTrack: (trackName) => set({ activeSubtitleTrack: trackName }),

  getSubtitleCues: (trackName?) => {
    const { subtitleCues, activeSubtitleTrack } = get();
    const track = trackName ?? activeSubtitleTrack;
    if (!track) return [];
    return subtitleCues.get(track) ?? [];
  },

  clearSubtitles: () => set({
    subtitleCues: new Map(),
    activeSubtitleTrack: null,
  }),

  // Timeline actions
  setTimelineData: (data) => set({ timelineData: data }),

  getGroupForTimestamp: (timestampMs) => {
    const { timelineData } = get();
    if (!timelineData || timelineData.entries.length === 0) {
      return null;
    }

    // Find the group that contains this timestamp
    // Entries are sorted by groupId which correlates to timestamp
    for (let i = timelineData.entries.length - 1; i >= 0; i--) {
      const entry = timelineData.entries[i];
      if (timestampMs >= entry.timestamp) {
        // Calculate object offset within the group based on framerate
        const timeIntoGroup = timestampMs - entry.timestamp;
        const objectId = Math.floor((timeIntoGroup / 1000) * timelineData.framerate);
        return {
          groupId: entry.groupId,
          objectId: Math.min(objectId, entry.objectCount - 1),
        };
      }
    }

    // Before first entry - return start
    return { groupId: 0, objectId: 0 };
  },

  getTimestampForGroup: (groupId) => {
    const { timelineData } = get();
    if (!timelineData) {
      return null;
    }

    const entry = timelineData.entries.find(e => e.groupId === groupId);
    return entry?.timestamp ?? null;
  },
});
