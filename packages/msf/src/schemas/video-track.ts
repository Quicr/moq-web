// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Video track schema fields
 *
 * Defines video-specific fields for track definitions.
 */

import { z } from 'zod';

/**
 * Video-specific fields for track definitions
 */
export const VideoFieldsSchema = z.object({
  /** Encoded video width in pixels */
  width: z.number().int().positive().optional(),
  /** Encoded video height in pixels */
  height: z.number().int().positive().optional(),
  /** Display width (may differ from encoded for aspect ratio) */
  displayWidth: z.number().int().positive().optional(),
  /** Display height (may differ from encoded for aspect ratio) */
  displayHeight: z.number().int().positive().optional(),
  /** Frame rate (frames per second) */
  framerate: z.number().positive().optional(),
  /** Bitrate in bits per second */
  bitrate: z.number().int().positive().optional(),
});

export type VideoFields = z.infer<typeof VideoFieldsSchema>;
