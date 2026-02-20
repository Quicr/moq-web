// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Media Session Module
 *
 * High-level media session for MOQT video/audio streaming.
 */

export { MediaSession } from './media-session.js';
export type { MediaSessionOptions } from './media-session.js';
export type {
  SessionState,
  MediaSessionEventType,
  MediaConfig,
  MediaSubscribeOptions,
  MediaPublishOptions,
  ResolutionConfig,
  WorkerConfig,
} from './types.js';
export { getResolutionConfig } from './types.js';
