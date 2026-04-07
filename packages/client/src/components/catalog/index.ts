// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Catalog Components
 *
 * Components for building and subscribing to MSF catalogs.
 */

export { CatalogBuilderPanel } from './CatalogBuilderPanel';
export { TrackCard } from './TrackCard';
export { AddTrackModal } from './AddTrackModal';

export type {
  CatalogTrackType,
  CatalogTrackConfig,
  CatalogExperienceProfile,
  VODTrackConfig,
  LiveTrackConfig,
  AudioTrackConfig,
  SubtitleTrackConfig,
  TimelineTrackConfig,
  CatalogBuilderState,
} from './types';

export {
  DEFAULT_TRACK_CONFIGS,
  EXPERIENCE_PROFILE_INFO,
} from './types';
