// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Accessibility schema fields (MSF §16).
 *
 * Accessibility descriptors follow the DASH scheme/value model:
 *   { scheme: "urn:scte:dash:cc:cea-608:2015", value: "CC1=eng;CC3=spa" }
 *
 * Also supports SCTE-35 markers for ad insertion.
 */

import { z } from 'zod';

/**
 * Known accessibility scheme URNs (MSF §16 Table).
 */
export const AccessibilityScheme = {
  CEA608: 'urn:scte:dash:cc:cea-608:2015',
  CEA708: 'urn:scte:dash:cc:cea-708:2015',
} as const;

/**
 * URN of an accessibility scheme (MSF §16).
 *
 * Reserved URNs: {@link AccessibilityScheme.CEA608}, {@link AccessibilityScheme.CEA708}.
 * Custom URNs are permitted; any RFC 8141-shaped URN is accepted.
 */
export const AccessibilitySchemeSchema = z
  .string()
  .min(1)
  .refine((v) => /^urn:[A-Za-z0-9][A-Za-z0-9-]{0,31}:[^\s]+$/.test(v), {
    message: 'accessibility.scheme must be a URN (RFC 8141)',
  });

/**
 * SCTE 214-1 accessibility value format: semicolon-separated `channel=lang`
 * pairs (e.g. `"CC1=eng;CC3=spa"`).
 */
export const AccessibilityValueSchema = z
  .string()
  .min(1)
  .refine(
    (v) =>
      v.split(';').every((pair) => /^[A-Za-z0-9._-]+=[A-Za-z0-9-]+$/.test(pair.trim())),
    {
      message:
        'accessibility.value must be SCTE 214-1 pairs (e.g. "CC1=eng;CC3=spa")',
    }
  );

/**
 * Accessibility descriptor for a track (MSF §16).
 */
export const AccessibilitySchema = z.object({
  /** URN identifying the accessibility scheme. */
  scheme: AccessibilitySchemeSchema,
  /** Scheme-specific value; SCTE 214-1 formatted for CEA-608/708. */
  value: AccessibilityValueSchema.optional(),
  /** Human-readable label. */
  label: z.string().optional(),
});

/**
 * @deprecated Kept for compatibility with the previous shortname enum
 * (`cea608`/`cea708`/…). Prefer the URN in {@link AccessibilityScheme}.
 */
export const AccessibilityTypeEnum = z.enum([
  'cea608',
  'cea708',
  'dvb-subtitles',
  'ttml',
  'webvtt',
]);

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
