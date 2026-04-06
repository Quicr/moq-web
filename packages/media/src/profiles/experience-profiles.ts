// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Experience Profiles
 *
 * Predefined configurations for different media consumption scenarios.
 * These profiles provide sensible defaults for jitter buffer and latency
 * settings based on the intended use case.
 */

/**
 * Experience profile names
 */
export type ExperienceProfileName =
  | 'ultra-low'
  | 'interactive'
  | 'low-latency-live'
  | 'live-streaming'
  | 'broadcast'
  | 'custom';

/**
 * Subscriber-side settings for an experience profile
 */
export interface ExperienceProfileSettings {
  /** Jitter buffer delay in milliseconds */
  jitterBufferDelay: number;
  /** Use latency-only deadline (true=interactive, false=streaming) */
  useLatencyDeadline: boolean;
  /** Maximum acceptable latency in ms before skipping */
  maxLatency: number;
  /** Expected GOP duration in ms */
  estimatedGopDuration: number;
  /** Skip to latest group immediately when behind */
  skipToLatestGroup: boolean;
  /** Grace period in frames before skipping */
  skipGraceFrames: number;
  /** Enable catch-up mode when buffer gets deep */
  enableCatchUp: boolean;
  /** Number of ready frames that triggers catch-up */
  catchUpThreshold: number;
}

/**
 * Complete experience profile definition
 */
export interface ExperienceProfile {
  /** Profile identifier */
  name: ExperienceProfileName;
  /** Human-readable display name */
  displayName: string;
  /** Short description of the use case */
  description: string;
  /** Target end-to-end latency in ms (maps to MSF targetLatency) */
  targetLatency: number;
  /** Subscriber-side settings */
  settings: ExperienceProfileSettings;
}

/**
 * Predefined experience profiles
 */
export const EXPERIENCE_PROFILES: Record<Exclude<ExperienceProfileName, 'custom'>, ExperienceProfile> = {
  'ultra-low': {
    name: 'ultra-low',
    displayName: 'Ultra-Low Latency',
    description: 'Gaming, remote desktop',
    targetLatency: 50,
    settings: {
      jitterBufferDelay: 50,
      useLatencyDeadline: true,
      maxLatency: 50,
      estimatedGopDuration: 500,
      skipToLatestGroup: true,
      skipGraceFrames: 1,
      enableCatchUp: true,
      catchUpThreshold: 3,
    },
  },

  'interactive': {
    name: 'interactive',
    displayName: 'Interactive',
    description: 'Video conferencing',
    targetLatency: 100,
    settings: {
      jitterBufferDelay: 80,
      useLatencyDeadline: true,
      maxLatency: 150,
      estimatedGopDuration: 2000,
      skipToLatestGroup: true,
      skipGraceFrames: 2,
      enableCatchUp: true,
      catchUpThreshold: 4,
    },
  },

  'low-latency-live': {
    name: 'low-latency-live',
    displayName: 'Low-Latency Live',
    description: 'Live sports, events',
    targetLatency: 500,
    settings: {
      jitterBufferDelay: 100,
      useLatencyDeadline: true,
      maxLatency: 500,
      estimatedGopDuration: 1000,
      skipToLatestGroup: false,
      skipGraceFrames: 3,
      enableCatchUp: true,
      catchUpThreshold: 5,
    },
  },

  'live-streaming': {
    name: 'live-streaming',
    displayName: 'Live Streaming',
    description: 'Webinars, broadcasts',
    targetLatency: 2000,
    settings: {
      jitterBufferDelay: 150,
      useLatencyDeadline: false,
      maxLatency: 2000,
      estimatedGopDuration: 2000,
      skipToLatestGroup: false,
      skipGraceFrames: 5,
      enableCatchUp: true,
      catchUpThreshold: 8,
    },
  },

  'broadcast': {
    name: 'broadcast',
    displayName: 'Broadcast',
    description: 'VOD-like playback',
    targetLatency: 5000,
    settings: {
      jitterBufferDelay: 200,
      useLatencyDeadline: false,
      maxLatency: 5000,
      estimatedGopDuration: 3000,
      skipToLatestGroup: false,
      skipGraceFrames: 8,
      enableCatchUp: false,
      catchUpThreshold: 10,
    },
  },
};

/**
 * Get an experience profile by name
 */
export function getExperienceProfile(name: ExperienceProfileName): ExperienceProfile | undefined {
  if (name === 'custom') {
    return undefined;
  }
  return EXPERIENCE_PROFILES[name];
}

/**
 * Derive a profile name from a target latency value
 * Useful when catalog specifies targetLatency but not experienceProfile
 */
export function profileFromTargetLatency(latencyMs: number): ExperienceProfileName {
  if (latencyMs <= 50) return 'ultra-low';
  if (latencyMs <= 150) return 'interactive';
  if (latencyMs <= 750) return 'low-latency-live';
  if (latencyMs <= 3000) return 'live-streaming';
  return 'broadcast';
}

/**
 * Check if current settings match a profile's settings
 * Returns the matching profile name or 'custom' if no match
 */
export function detectCurrentProfile(settings: ExperienceProfileSettings): ExperienceProfileName {
  for (const [name, profile] of Object.entries(EXPERIENCE_PROFILES)) {
    const ps = profile.settings;
    if (
      settings.jitterBufferDelay === ps.jitterBufferDelay &&
      settings.useLatencyDeadline === ps.useLatencyDeadline &&
      settings.maxLatency === ps.maxLatency &&
      settings.estimatedGopDuration === ps.estimatedGopDuration &&
      settings.skipToLatestGroup === ps.skipToLatestGroup &&
      settings.skipGraceFrames === ps.skipGraceFrames &&
      settings.enableCatchUp === ps.enableCatchUp &&
      settings.catchUpThreshold === ps.catchUpThreshold
    ) {
      return name as ExperienceProfileName;
    }
  }
  return 'custom';
}

/**
 * Profile names excluding 'custom' (for iteration)
 */
export type DefinedProfileName = Exclude<ExperienceProfileName, 'custom'>;

/**
 * List of profile names in order (for UI display)
 */
export const EXPERIENCE_PROFILE_ORDER: DefinedProfileName[] = [
  'ultra-low',
  'interactive',
  'low-latency-live',
  'live-streaming',
  'broadcast',
];
