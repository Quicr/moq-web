// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview PlayoutBuffer Factory
 *
 * Factory functions to create PlayoutBuffer instances with the appropriate
 * ReleasePolicy based on:
 *
 * 1. CATALOG-DRIVEN: isLive field from MSF catalog
 * 2. EXPLICIT CONFIG: User specifies policy type
 * 3. ADAPTIVE (default): Observes patterns, best-effort adaptation
 *
 * @example
 * ```typescript
 * // From catalog track (preferred)
 * const buffer = createPlayoutBufferFromTrack({ isLive: false });
 *
 * // Explicit policy selection
 * const vodBuffer = createPlayoutBuffer('vod');
 * const liveBuffer = createPlayoutBuffer('live', { jitterDelay: 80 });
 *
 * // Default (no config) - uses adaptive
 * const defaultBuffer = createPlayoutBuffer();
 * ```
 */

import { PlayoutBuffer, type PlayoutBufferConfig } from './playout-buffer.js';
import { VodReleasePolicy, type VodReleasePolicyConfig } from './vod-release-policy.js';
import { LiveReleasePolicy, type LiveReleasePolicyConfig } from './live-release-policy.js';
import { AdaptiveReleasePolicy, type AdaptiveReleasePolicyConfig } from './adaptive-release-policy.js';
import {
  getExperienceProfile,
  type ExperienceProfileName,
  type ExperienceProfileSettings,
} from '../profiles/experience-profiles.js';

// ============================================================
// Policy Types
// ============================================================

/**
 * Available policy types
 */
export type PolicyType = 'vod' | 'live' | 'adaptive';

/**
 * Track info for catalog-driven selection
 */
export interface TrackPolicyInfo {
  /** Whether track is live (from MSF catalog) */
  isLive: boolean;

  /** Experience profile name (optional, for live content) */
  experienceProfile?: ExperienceProfileName;

  /** Custom profile settings (overrides defaults) */
  profileSettings?: Partial<ExperienceProfileSettings>;

  /** Target framerate for VOD pacing (from catalog) */
  framerate?: number;

  /** Minimum frames to buffer before starting VOD playback */
  minBufferFrames?: number;

  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Combined policy configuration
 */
export type PolicyConfig =
  | { type: 'vod'; config?: Partial<VodReleasePolicyConfig> }
  | { type: 'live'; config?: Partial<LiveReleasePolicyConfig> }
  | { type: 'adaptive'; config?: Partial<AdaptiveReleasePolicyConfig> };

// ============================================================
// Factory Functions
// ============================================================

/**
 * Create a PlayoutBuffer with default policy (adaptive)
 *
 * Use when no configuration is available. The adaptive policy
 * will observe arrival patterns and adjust behavior accordingly.
 *
 * @param bufferConfig - Optional buffer configuration
 * @returns PlayoutBuffer with AdaptiveReleasePolicy
 */
export function createDefaultPlayoutBuffer<T>(
  bufferConfig?: Partial<PlayoutBufferConfig>
): PlayoutBuffer<T> {
  return createAdaptivePlayoutBuffer(bufferConfig);
}

/**
 * Create a PlayoutBuffer from catalog track information
 *
 * PREFERRED method when MSF catalog is available.
 * Automatically selects VodReleasePolicy for VOD (isLive=false)
 * and LiveReleasePolicy for live content with profile-based settings.
 *
 * @param trackInfo - Track metadata including isLive flag
 * @param bufferConfig - Optional buffer configuration
 * @returns Configured PlayoutBuffer
 */
export function createPlayoutBufferFromTrack<T>(
  trackInfo: TrackPolicyInfo,
  bufferConfig?: Partial<PlayoutBufferConfig>
): PlayoutBuffer<T> {
  if (!trackInfo.isLive) {
    // VOD content - pass framerate for pacing and buffer config
    return createVodPlayoutBuffer(bufferConfig, {
      targetFramerate: trackInfo.framerate ?? 30,
      enablePacing: true,
      minBufferFrames: trackInfo.minBufferFrames,
      debug: trackInfo.debug,
    });
  }

  // Live content - use experience profile
  const profileName = trackInfo.experienceProfile ?? 'interactive';
  return createLivePlayoutBuffer(profileName, trackInfo.profileSettings, bufferConfig);
}

/**
 * Create a PlayoutBuffer with explicit policy type
 *
 * Use when user explicitly specifies the policy, regardless of catalog.
 *
 * @param policyType - 'vod', 'live', or 'adaptive'
 * @param policyConfig - Policy-specific configuration
 * @param bufferConfig - Buffer configuration
 */
export function createPlayoutBuffer<T>(
  policyType: PolicyType = 'adaptive',
  policyConfig?: Partial<VodReleasePolicyConfig> | Partial<LiveReleasePolicyConfig> | Partial<AdaptiveReleasePolicyConfig>,
  bufferConfig?: Partial<PlayoutBufferConfig>
): PlayoutBuffer<T> {
  switch (policyType) {
    case 'vod':
      return createVodPlayoutBuffer(bufferConfig, policyConfig as Partial<VodReleasePolicyConfig>);
    case 'live':
      return new PlayoutBuffer<T>(
        new LiveReleasePolicy<T>(policyConfig as Partial<LiveReleasePolicyConfig>),
        bufferConfig
      );
    case 'adaptive':
    default:
      return createAdaptivePlayoutBuffer(bufferConfig, policyConfig as Partial<AdaptiveReleasePolicyConfig>);
  }
}

/**
 * Create a PlayoutBuffer for VOD content
 *
 * Sequential playback, no skipping, waits for all frames.
 *
 * @param bufferConfig - Optional buffer configuration
 * @param policyConfig - Optional VOD policy configuration
 */
export function createVodPlayoutBuffer<T>(
  bufferConfig?: Partial<PlayoutBufferConfig>,
  policyConfig?: Partial<VodReleasePolicyConfig>
): PlayoutBuffer<T> {
  const policy = new VodReleasePolicy<T>(policyConfig);
  return new PlayoutBuffer<T>(policy, bufferConfig);
}

/**
 * Create a PlayoutBuffer for live content
 *
 * Uses experience profile settings for jitter buffer, deadlines, etc.
 *
 * @param profileName - Experience profile ('ultra-low', 'interactive', etc.)
 * @param overrides - Optional settings to override profile defaults
 * @param bufferConfig - Optional buffer configuration
 */
export function createLivePlayoutBuffer<T>(
  profileName: ExperienceProfileName = 'interactive',
  overrides?: Partial<ExperienceProfileSettings>,
  bufferConfig?: Partial<PlayoutBufferConfig>
): PlayoutBuffer<T> {
  const profile = getExperienceProfile(profileName);
  const settings = profile?.settings ?? {};

  // Map experience profile settings to live policy config
  const mergedSettings = { ...settings, ...overrides };

  const policyConfig: Partial<LiveReleasePolicyConfig> = {
    jitterDelay: mergedSettings.jitterBufferDelay,
    maxLatency: mergedSettings.maxLatency,
    useLatencyDeadline: mergedSettings.useLatencyDeadline,
    estimatedGopDuration: mergedSettings.estimatedGopDuration,
    skipToLatestGroup: mergedSettings.skipToLatestGroup,
    skipGraceFrames: mergedSettings.skipGraceFrames,
    enableCatchUp: mergedSettings.enableCatchUp,
    catchUpThreshold: mergedSettings.catchUpThreshold,
  };

  const policy = new LiveReleasePolicy<T>(policyConfig);
  return new PlayoutBuffer<T>(policy, bufferConfig);
}

/**
 * Create a PlayoutBuffer with adaptive policy
 *
 * Observes arrival patterns and adapts behavior.
 * Use when no catalog or explicit config is available.
 *
 * @param bufferConfig - Optional buffer configuration
 * @param policyConfig - Optional adaptive policy configuration
 */
export function createAdaptivePlayoutBuffer<T>(
  bufferConfig?: Partial<PlayoutBufferConfig>,
  policyConfig?: Partial<AdaptiveReleasePolicyConfig>
): PlayoutBuffer<T> {
  const policy = new AdaptiveReleasePolicy<T>(policyConfig);
  return new PlayoutBuffer<T>(policy, bufferConfig);
}

// ============================================================
// Convenience Presets
// ============================================================

/**
 * Preset configurations for common scenarios
 */
export const POLICY_PRESETS = {
  /**
   * Video calling - ultra-low latency, aggressive skipping
   */
  videoCalling: <T>() => createLivePlayoutBuffer<T>('interactive', {
    jitterBufferDelay: 50,
    maxLatency: 100,
    skipToLatestGroup: true,
  }),

  /**
   * Live sports - low latency, moderate buffering
   */
  liveSports: <T>() => createLivePlayoutBuffer<T>('low-latency-live'),

  /**
   * Webinar - higher latency acceptable, smooth playback
   */
  webinar: <T>() => createLivePlayoutBuffer<T>('live-streaming'),

  /**
   * Broadcast - VOD-like latency for live content
   */
  broadcast: <T>() => createLivePlayoutBuffer<T>('broadcast'),

  /**
   * VOD playback - perfect quality, no skipping
   */
  vod: <T>() => createVodPlayoutBuffer<T>(),

  /**
   * DVR (live with rewind) - VOD-like but may have gaps
   */
  dvr: <T>() => createVodPlayoutBuffer<T>(undefined, {
    maxWaitTimeMs: 5000, // Don't wait forever for missing frames
  }),

  /**
   * Gaming - ultra-low latency, very aggressive
   */
  gaming: <T>() => createLivePlayoutBuffer<T>('ultra-low', {
    jitterBufferDelay: 20,
    maxLatency: 50,
    skipGraceFrames: 1,
  }),

  /**
   * Unknown content - adaptive detection
   */
  unknown: <T>() => createAdaptivePlayoutBuffer<T>(),
} as const;

// ============================================================
// Migration Helper
// ============================================================

/**
 * Create a PlayoutBuffer compatible with old GroupArbiter API
 *
 * For migration from GroupArbiter to PlayoutBuffer.
 * Maps old TimingConfig to new LiveReleasePolicyConfig.
 *
 * @deprecated Use createLivePlayoutBuffer instead
 */
export function createFromArbiterConfig<T>(
  arbiterConfig: {
    maxLatency?: number;
    jitterDelay?: number;
    estimatedGopDuration?: number;
    useLatencyDeadline?: boolean;
    skipToLatestGroup?: boolean;
    skipGraceFrames?: number;
    enableCatchUp?: boolean;
    catchUpThreshold?: number;
    maxCatchUpFrames?: number;
    allowPartialGroupDecode?: boolean;
    skipOnlyToKeyframe?: boolean;
    deadlineExtension?: number;
    maxActiveGroups?: number;
    maxFramesPerGroup?: number;
    debug?: boolean;
  },
  bufferConfig?: Partial<PlayoutBufferConfig>
): PlayoutBuffer<T> {
  const policy = new LiveReleasePolicy<T>({
    maxLatency: arbiterConfig.maxLatency,
    jitterDelay: arbiterConfig.jitterDelay,
    estimatedGopDuration: arbiterConfig.estimatedGopDuration,
    useLatencyDeadline: arbiterConfig.useLatencyDeadline,
    skipToLatestGroup: arbiterConfig.skipToLatestGroup,
    skipGraceFrames: arbiterConfig.skipGraceFrames,
    enableCatchUp: arbiterConfig.enableCatchUp,
    catchUpThreshold: arbiterConfig.catchUpThreshold,
    maxCatchUpFrames: arbiterConfig.maxCatchUpFrames,
    allowPartialGroupDecode: arbiterConfig.allowPartialGroupDecode,
    skipOnlyToKeyframe: arbiterConfig.skipOnlyToKeyframe,
    deadlineExtension: arbiterConfig.deadlineExtension,
    maxActiveGroups: arbiterConfig.maxActiveGroups,
    maxFramesPerGroup: arbiterConfig.maxFramesPerGroup,
    debug: arbiterConfig.debug,
  });

  return new PlayoutBuffer<T>(policy, bufferConfig);
}
