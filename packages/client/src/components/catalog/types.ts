// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Catalog UI Types
 *
 * Types for the catalog builder and subscriber components.
 */

import type { VODLoadProgress } from '@web-moq/media';

/**
 * Simplified experience profile for catalog builder
 */
export type CatalogExperienceProfile = 'interactive' | 'streaming' | 'broadcast';

/**
 * Track type in the catalog builder
 */
export type CatalogTrackType = 'video-vod' | 'video-live' | 'audio' | 'subtitle' | 'timeline';

/**
 * Base configuration for all track types
 */
export interface BaseTrackConfig {
  id: string;
  type: CatalogTrackType;
  name: string;
  experienceProfile: CatalogExperienceProfile;
  status: 'idle' | 'loading' | 'ready' | 'publishing' | 'error';
  error?: string;
  /** Render group for A/V sync (tracks in same group should be synced) */
  renderGroup?: number;
  /** Alt group for ABR switching (tracks in same altGroup are quality variants) */
  altGroup?: number;
  /** Human-readable label */
  label?: string;
}

/**
 * VOD video track configuration
 */
export interface VODTrackConfig extends BaseTrackConfig {
  type: 'video-vod';
  /** Video source: URL or local file */
  videoUrl: string;
  /** Local video file (alternative to URL) */
  videoFile?: File;
  codec: string;
  width: number;
  height: number;
  framerate: number;
  bitrate: number;
  duration: number; // milliseconds
  /** Total number of groups/GOPs */
  totalGroups?: number;
  /** GOP duration in milliseconds */
  gopDuration?: number;
  enableDvr: boolean;
  loopPlayback: boolean;
  loadProgress?: VODLoadProgress;
  /**
   * Fetch-only mode: if true, don't auto-stream via SUBSCRIBE.
   * Subscribers must use FETCH to retrieve content.
   * Default: true (recommended for smooth VOD playback)
   */
  fetchOnly?: boolean;
}

/**
 * Live video track configuration
 */
export interface LiveTrackConfig extends BaseTrackConfig {
  type: 'video-live';
  deviceId?: string;
  codec: string;
  width: number;
  height: number;
  framerate: number;
  bitrate: number;
}

/**
 * Audio track configuration
 */
export interface AudioTrackConfig extends BaseTrackConfig {
  type: 'audio';
  deviceId?: string;
  codec: string;
  samplerate: number;
  channelConfig: 'mono' | 'stereo';
  bitrate: number;
}

/**
 * Subtitle track configuration
 */
export interface SubtitleTrackConfig extends BaseTrackConfig {
  type: 'subtitle';
  language: string;
  format: 'webvtt' | 'srt';
  label: string;
}

/**
 * Media timeline track configuration (for VOD seeking/DVR)
 */
export interface TimelineTrackConfig extends BaseTrackConfig {
  type: 'timeline';
  timescale: number; // units per second (typically 1000 for ms)
  duration?: number; // total duration in timescale units
}

/**
 * Union type for all track configs
 */
export type CatalogTrackConfig =
  | VODTrackConfig
  | LiveTrackConfig
  | AudioTrackConfig
  | SubtitleTrackConfig
  | TimelineTrackConfig;

/**
 * Catalog builder state
 */
export interface CatalogBuilderState {
  namespace: string;
  tracks: CatalogTrackConfig[];
  catalogStatus: 'idle' | 'building' | 'published' | 'error';
  catalogError?: string;
}

/**
 * Experience profile descriptions for UI
 */
export const EXPERIENCE_PROFILE_INFO: Record<CatalogExperienceProfile, {
  label: string;
  description: string;
  targetLatency: string;
}> = {
  interactive: {
    label: 'Interactive',
    description: 'Lowest latency for real-time interaction',
    targetLatency: '~50ms',
  },
  streaming: {
    label: 'Streaming',
    description: 'Balanced quality and latency',
    targetLatency: '~500ms',
  },
  broadcast: {
    label: 'Broadcast',
    description: 'Maximum quality with buffering',
    targetLatency: '~2000ms',
  },
};

/**
 * Default configurations for new tracks
 */
export const DEFAULT_TRACK_CONFIGS = {
  'video-vod': {
    codec: 'avc1.42E01F',
    width: 1280,
    height: 720,
    framerate: 30,
    bitrate: 2_000_000,
    enableDvr: true,
    loopPlayback: false,
    experienceProfile: 'streaming' as CatalogExperienceProfile,
  },
  'video-live': {
    codec: 'avc1.42E01F',
    width: 1280,
    height: 720,
    framerate: 30,
    bitrate: 2_000_000,
    experienceProfile: 'interactive' as CatalogExperienceProfile,
  },
  audio: {
    codec: 'opus',
    samplerate: 48000,
    channelConfig: 'stereo' as const,
    bitrate: 128_000,
    experienceProfile: 'interactive' as CatalogExperienceProfile,
  },
  subtitle: {
    language: 'en',
    format: 'webvtt' as const,
    label: 'English',
    experienceProfile: 'streaming' as CatalogExperienceProfile,
  },
  timeline: {
    timescale: 1000, // milliseconds
    experienceProfile: 'streaming' as CatalogExperienceProfile,
  },
};
