// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Audio track schema fields
 *
 * Defines audio-specific fields for track definitions.
 */

import { z } from 'zod';

/**
 * Channel configuration identifiers
 */
export const ChannelConfigEnum = z.enum([
  'mono',
  'stereo',
  'surround-5.1',
  'surround-7.1',
  'atmos',
]);

/**
 * Audio-specific fields for track definitions
 */
export const AudioFieldsSchema = z.object({
  /** Sample rate in Hz */
  samplerate: z.number().int().positive().optional(),
  /** Channel configuration */
  channelConfig: ChannelConfigEnum.optional(),
  /** Bitrate in bits per second */
  bitrate: z.number().int().positive().optional(),
});

export type ChannelConfig = z.infer<typeof ChannelConfigEnum>;
export type AudioFields = z.infer<typeof AudioFieldsSchema>;
