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
