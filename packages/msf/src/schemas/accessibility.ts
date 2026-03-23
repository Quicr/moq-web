// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Accessibility schema fields per PR #133
 *
 * Supports SCTE-35 markers and CEA-608/708 closed captions.
 */

import { z } from 'zod';

/**
 * Accessibility feature types
 */
export const AccessibilityTypeEnum = z.enum([
  'cea608',
  'cea708',
  'dvb-subtitles',
  'ttml',
  'webvtt',
]);

/**
 * Accessibility configuration for a track
 */
export const AccessibilitySchema = z.object({
  /** Type of accessibility feature */
  type: AccessibilityTypeEnum,
  /** Language code (BCP 47) */
  lang: z.string().optional(),
  /** Human-readable label */
  label: z.string().optional(),
  /** Channel/service number for CEA-608/708 */
  channel: z.number().int().min(1).max(63).optional(),
});

/**
 * SCTE-35 marker configuration
 */
export const Scte35Schema = z.object({
  /** Whether SCTE-35 markers are present */
  enabled: z.boolean(),
  /** Cue-out duration in milliseconds */
  cueOutDuration: z.number().optional(),
  /** Pre-roll time in milliseconds */
  preRoll: z.number().optional(),
});

/**
 * Accessibility fields that can be added to track definitions
 */
export const AccessibilityFieldsSchema = z.object({
  /** Accessibility features for this track */
  accessibility: z.array(AccessibilitySchema).optional(),
  /** SCTE-35 configuration */
  scte35: Scte35Schema.optional(),
});

export type AccessibilityType = z.infer<typeof AccessibilityTypeEnum>;
export type Accessibility = z.infer<typeof AccessibilitySchema>;
export type Scte35 = z.infer<typeof Scte35Schema>;
export type AccessibilityFields = z.infer<typeof AccessibilityFieldsSchema>;
