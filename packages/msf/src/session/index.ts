// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Session module exports
 */

// Group numbering
export {
  EpochGroupNumbering,
  SequentialGroupNumbering,
  createGroupNumbering,
  type GroupNumberingStrategy,
} from './group-numbering.js';

// §10 Prior Group ID Gap
export {
  PRIOR_GROUP_ID_GAP_EXTENSION_ID,
  GroupIdGapTracker,
  encodePriorGroupIdGap,
  decodePriorGroupIdGap,
} from './group-gap.js';

// Catalog track
export {
  CatalogTrackError,
  CatalogSubscriber,
  CatalogPublisher,
  createCatalogSubscriber,
  createCatalogPublisher,
  type CatalogCallback,
  type CatalogSubscribeOptions,
  type CatalogPublishOptions,
} from './catalog-track.js';

// MSF session
export {
  MSFSession,
  createMSFSession,
  type MSFSessionConfig,
  type TrackInfo,
  type PublishedTrackInfo,
} from './msf-session.js';
