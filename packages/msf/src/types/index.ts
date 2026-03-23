// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MSF TypeScript type exports
 *
 * Re-exports all TypeScript types for external use.
 */

// Catalog types
export type {
  CatalogMetadata,
  FullCatalog,
  DeltaCatalog,
  Catalog,
} from '../schemas/catalog.js';

// Track types
export type { Packaging, TrackRole, Track, CloneTrack } from '../schemas/track.js';

// Video/Audio types
export type { VideoFields } from '../schemas/video-track.js';
export type { ChannelConfig, AudioFields } from '../schemas/audio-track.js';

// Timeline types
export type {
  LocationRef,
  MediaTimelineEntry,
  EventTimelineEntry,
  MediaTimelineTemplate,
  MediaTimelineTemplateArray,
} from '../schemas/timeline.js';

// Encryption types
export type { EncryptionScheme, CipherSuite, EncryptionFields } from '../schemas/encryption.js';

// Accessibility types (PR #133)
export type {
  AccessibilityType,
  Accessibility,
  Scte35,
  AccessibilityFields,
} from '../schemas/accessibility.js';

/**
 * Input type for creating a video track
 */
export interface VideoTrackInput {
  name: string;
  codec: string;
  width: number;
  height: number;
  framerate?: number;
  bitrate?: number;
  isLive: boolean;
  displayWidth?: number;
  displayHeight?: number;
  namespace?: string[];
  role?: 'main' | 'alternate' | 'supplementary';
  renderGroup?: number;
  altGroup?: number;
  targetLatency?: number;
  label?: string;
  depends?: string[];
  initData?: string;
  temporalId?: number;
  spatialId?: number;
}

/**
 * Input type for creating an audio track
 */
export interface AudioTrackInput {
  name: string;
  codec: string;
  samplerate?: number;
  channelConfig?: 'mono' | 'stereo' | 'surround-5.1' | 'surround-7.1' | 'atmos';
  bitrate?: number;
  isLive: boolean;
  namespace?: string[];
  role?: 'main' | 'alternate' | 'commentary' | 'dub';
  renderGroup?: number;
  altGroup?: number;
  targetLatency?: number;
  label?: string;
  lang?: string;
}

/**
 * Input type for creating a data track
 */
export interface DataTrackInput {
  name: string;
  packaging: 'loc' | 'mediatimeline' | 'eventtimeline';
  isLive: boolean;
  mimeType?: string;
  namespace?: string[];
  role?: 'metadata' | 'logs' | 'metrics';
  label?: string;
  timescale?: number;
}
