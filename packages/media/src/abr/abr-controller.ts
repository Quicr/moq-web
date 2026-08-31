// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview ABR (Adaptive Bitrate) Controller
 *
 * Monitors playback quality and switches between tracks in the same altGroup
 * to optimize quality based on network conditions and buffer health.
 *
 * Uses altGroup from MSF catalog to identify switchable quality variants.
 *
 * @example
 * ```typescript
 * const abr = new ABRController({
 *   onSwitch: async (fromTrack, toTrack) => {
 *     await session.unsubscribe(fromTrack);
 *     await session.subscribe(toTrack);
 *   },
 * });
 *
 * // Register tracks from catalog
 * for (const track of catalog.tracks) {
 *   if (track.altGroup !== undefined) {
 *     abr.registerTrack(track);
 *   }
 * }
 *
 * // Start monitoring
 * abr.start();
 *
 * // Report buffer/bandwidth samples
 * abr.reportBufferLevel(2.5); // 2.5 seconds buffered
 * abr.reportBandwidth(5_000_000); // 5 Mbps estimated
 * ```
 */

/**
 * Track info for ABR decisions
 */
export interface ABRTrack {
  /** Track name (unique identifier) */
  name: string;

  /** Namespace for the track */
  namespace: string[];

  /** Alt group - tracks with same altGroup are quality variants */
  altGroup: number;

  /** Bitrate in bits per second (for sorting quality levels) */
  bitrate?: number;

  /** Width in pixels (for sorting by resolution) */
  width?: number;

  /** Height in pixels */
  height?: number;

  /** Codec string */
  codec?: string;

  /** Whether this track is currently subscribed */
  isSubscribed?: boolean;
}

/**
 * ABR algorithm type
 */
export type ABRAlgorithm = 'buffer-based' | 'bandwidth-based' | 'hybrid';

/**
 * ABR Controller configuration
 */
export interface ABRControllerConfig {
  /**
   * Callback when ABR decides to switch tracks
   * Should unsubscribe from old track and subscribe to new track
   */
  onSwitch: (fromTrack: ABRTrack, toTrack: ABRTrack) => Promise<void>;

  /** ABR algorithm to use (default: 'hybrid') */
  algorithm?: ABRAlgorithm;

  /** Minimum buffer level (seconds) before considering upgrade (default: 4) */
  minBufferForUpgrade?: number;

  /** Buffer level (seconds) that triggers downgrade (default: 1) */
  bufferDowngradeThreshold?: number;

  /** Bandwidth safety margin (0-1, default: 0.8 = use 80% of estimated bandwidth) */
  bandwidthSafetyMargin?: number;

  /** Minimum time between switches (ms, default: 5000) */
  minSwitchInterval?: number;

  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Default ABR configuration
 */
export const DEFAULT_ABR_CONFIG: Required<Omit<ABRControllerConfig, 'onSwitch'>> = {
  algorithm: 'hybrid',
  minBufferForUpgrade: 4,
  bufferDowngradeThreshold: 1,
  bandwidthSafetyMargin: 0.8,
  minSwitchInterval: 5000,
  debug: false,
};

/**
 * ABR statistics
 */
export interface ABRStats {
  /** Number of quality upgrades */
  upgrades: number;

  /** Number of quality downgrades */
  downgrades: number;

  /** Current quality level index (0 = lowest) */
  currentQualityLevel: number;

  /** Total quality levels available */
  totalQualityLevels: number;

  /** Current buffer level (seconds) */
  bufferLevel: number;

  /** Estimated bandwidth (bps) */
  estimatedBandwidth: number;

  /** Time since last switch (ms) */
  timeSinceLastSwitch: number;
}

/**
 * ABR Controller - Adaptive Bitrate switching between quality variants
 *
 * Monitors buffer health and bandwidth to switch between tracks in the same
 * altGroup, optimizing for the best quality that can be sustained.
 */
export class ABRController {
  private config: Required<ABRControllerConfig>;
  private tracks: Map<number, ABRTrack[]> = new Map(); // altGroup -> tracks (sorted by bitrate)
  private activeTrack: Map<number, ABRTrack> = new Map(); // altGroup -> current track
  private bufferLevel = 0;
  private estimatedBandwidth = 0;
  private bandwidthSamples: number[] = [];
  private lastSwitchTime = 0;
  private stats: ABRStats;
  private running = false;
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: ABRControllerConfig) {
    this.config = {
      ...DEFAULT_ABR_CONFIG,
      ...config,
    } as Required<ABRControllerConfig>;

    this.stats = {
      upgrades: 0,
      downgrades: 0,
      currentQualityLevel: 0,
      totalQualityLevels: 0,
      bufferLevel: 0,
      estimatedBandwidth: 0,
      timeSinceLastSwitch: 0,
    };
  }

  /**
   * Register a track for ABR switching
   * Tracks with the same altGroup can be switched between
   */
  registerTrack(track: ABRTrack): void {
    const { altGroup } = track;

    if (!this.tracks.has(altGroup)) {
      this.tracks.set(altGroup, []);
    }

    const groupTracks = this.tracks.get(altGroup)!;

    // Check if track already exists
    const existingIndex = groupTracks.findIndex(t => t.name === track.name);
    if (existingIndex >= 0) {
      groupTracks[existingIndex] = track;
    } else {
      groupTracks.push(track);
    }

    // Sort by bitrate (or resolution if bitrate not available)
    groupTracks.sort((a, b) => {
      if (a.bitrate !== undefined && b.bitrate !== undefined) {
        return a.bitrate - b.bitrate;
      }
      if (a.width !== undefined && b.width !== undefined) {
        return a.width - b.width;
      }
      return 0;
    });

    this.log('Track registered', { name: track.name, altGroup, totalInGroup: groupTracks.length });
  }

  /**
   * Set the currently active track for an altGroup
   * Call this when a subscription is started
   */
  setActiveTrack(altGroup: number, trackName: string): void {
    const groupTracks = this.tracks.get(altGroup);
    if (!groupTracks) {
      this.log('No tracks in altGroup', { altGroup });
      return;
    }

    const track = groupTracks.find(t => t.name === trackName);
    if (track) {
      track.isSubscribed = true;
      this.activeTrack.set(altGroup, track);
      this.updateStats();
      this.log('Active track set', { altGroup, trackName });
    }
  }

  /**
   * Report current buffer level (seconds of content buffered)
   */
  reportBufferLevel(seconds: number): void {
    this.bufferLevel = seconds;
    this.stats.bufferLevel = seconds;
  }

  /**
   * Report bandwidth sample (bits per second)
   */
  reportBandwidth(bps: number): void {
    this.bandwidthSamples.push(bps);

    // Keep last 10 samples
    if (this.bandwidthSamples.length > 10) {
      this.bandwidthSamples.shift();
    }

    // Use EWMA for bandwidth estimation
    this.estimatedBandwidth = this.calculateEWMA(this.bandwidthSamples);
    this.stats.estimatedBandwidth = this.estimatedBandwidth;
  }

  /**
   * Start ABR monitoring
   */
  start(): void {
    if (this.running) return;

    this.running = true;
    this.checkInterval = setInterval(() => this.checkAndSwitch(), 1000);
    this.log('ABR started');
  }

  /**
   * Stop ABR monitoring
   */
  stop(): void {
    this.running = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.log('ABR stopped');
  }

  /**
   * Get ABR statistics
   */
  getStats(): ABRStats {
    return {
      ...this.stats,
      timeSinceLastSwitch: Date.now() - this.lastSwitchTime,
    };
  }

  /**
   * Get available quality levels for an altGroup
   */
  getQualityLevels(altGroup: number): ABRTrack[] {
    return this.tracks.get(altGroup) ?? [];
  }

  /**
   * Get all altGroups with multiple quality levels
   */
  getSwitchableAltGroups(): number[] {
    const switchable: number[] = [];
    for (const [altGroup, tracks] of this.tracks) {
      if (tracks.length > 1) {
        switchable.push(altGroup);
      }
    }
    return switchable;
  }

  /**
   * Manually request a quality switch
   */
  async requestQuality(altGroup: number, trackName: string): Promise<boolean> {
    const groupTracks = this.tracks.get(altGroup);
    if (!groupTracks) return false;

    const targetTrack = groupTracks.find(t => t.name === trackName);
    const currentTrack = this.activeTrack.get(altGroup);

    if (!targetTrack || !currentTrack || targetTrack.name === currentTrack.name) {
      return false;
    }

    await this.performSwitch(altGroup, currentTrack, targetTrack, 'manual');
    return true;
  }

  /**
   * Get the currently active track for an altGroup
   */
  getCurrentTrack(altGroup: number): ABRTrack | undefined {
    return this.activeTrack.get(altGroup);
  }

  /**
   * Get the quality tier of the current track within its altGroup.
   * Returns 'lowest' if at the bottom, 'highest' if at the top,
   * 'intermediate' if in between.
   */
  getQualityTier(altGroup: number): 'lowest' | 'intermediate' | 'highest' {
    const groupTracks = this.tracks.get(altGroup);
    const current = this.activeTrack.get(altGroup);
    if (!groupTracks || !current) return 'lowest';

    const idx = groupTracks.findIndex(t => t.name === current.name);
    if (idx <= 0) return 'lowest';
    if (idx >= groupTracks.length - 1) return 'highest';
    return 'intermediate';
  }

  /**
   * Reset ABR state
   */
  reset(): void {
    this.tracks.clear();
    this.activeTrack.clear();
    this.bufferLevel = 0;
    this.estimatedBandwidth = 0;
    this.bandwidthSamples = [];
    this.lastSwitchTime = 0;
    this.stats = {
      upgrades: 0,
      downgrades: 0,
      currentQualityLevel: 0,
      totalQualityLevels: 0,
      bufferLevel: 0,
      estimatedBandwidth: 0,
      timeSinceLastSwitch: 0,
    };
  }

  // ============================================================
  // Private methods
  // ============================================================

  private async checkAndSwitch(): Promise<void> {
    const now = Date.now();

    // Check minimum switch interval
    if (now - this.lastSwitchTime < this.config.minSwitchInterval) {
      return;
    }

    // Check each altGroup
    for (const [altGroup, groupTracks] of this.tracks) {
      if (groupTracks.length <= 1) continue;

      const currentTrack = this.activeTrack.get(altGroup);
      if (!currentTrack) continue;

      const targetTrack = this.selectQuality(groupTracks, currentTrack);
      if (targetTrack && targetTrack.name !== currentTrack.name) {
        await this.performSwitch(altGroup, currentTrack, targetTrack, 'auto');
      }
    }
  }

  private selectQuality(tracks: ABRTrack[], currentTrack: ABRTrack): ABRTrack | null {
    const currentIndex = tracks.findIndex(t => t.name === currentTrack.name);
    if (currentIndex < 0) return null;

    switch (this.config.algorithm) {
      case 'buffer-based':
        return this.selectByBuffer(tracks, currentIndex);
      case 'bandwidth-based':
        return this.selectByBandwidth(tracks);
      case 'hybrid':
      default:
        return this.selectHybrid(tracks, currentIndex);
    }
  }

  private selectByBuffer(tracks: ABRTrack[], currentIndex: number): ABRTrack | null {
    // Low buffer - downgrade
    if (this.bufferLevel < this.config.bufferDowngradeThreshold && currentIndex > 0) {
      return tracks[currentIndex - 1];
    }

    // High buffer - upgrade
    if (this.bufferLevel > this.config.minBufferForUpgrade && currentIndex < tracks.length - 1) {
      return tracks[currentIndex + 1];
    }

    return null;
  }

  private selectByBandwidth(tracks: ABRTrack[]): ABRTrack | null {
    if (this.estimatedBandwidth <= 0) return null;

    const safeBandwidth = this.estimatedBandwidth * this.config.bandwidthSafetyMargin;

    // Find highest quality that fits in bandwidth
    for (let i = tracks.length - 1; i >= 0; i--) {
      const track = tracks[i];
      if (track.bitrate !== undefined && track.bitrate <= safeBandwidth) {
        return track;
      }
    }

    // Fall back to lowest quality
    return tracks[0];
  }

  private selectHybrid(tracks: ABRTrack[], currentIndex: number): ABRTrack | null {
    // First check buffer for emergency downgrade
    if (this.bufferLevel < this.config.bufferDowngradeThreshold && currentIndex > 0) {
      return tracks[currentIndex - 1];
    }

    // Then consider bandwidth-based selection if buffer is healthy
    if (this.bufferLevel >= this.config.minBufferForUpgrade && this.estimatedBandwidth > 0) {
      const bandwidthTrack = this.selectByBandwidth(tracks);
      if (bandwidthTrack) {
        const bandwidthIndex = tracks.findIndex(t => t.name === bandwidthTrack.name);
        // Only upgrade one level at a time for stability
        if (bandwidthIndex > currentIndex) {
          return tracks[currentIndex + 1];
        }
        // Allow faster downgrades
        if (bandwidthIndex < currentIndex) {
          return bandwidthTrack;
        }
      }
    }

    return null;
  }

  private async performSwitch(
    altGroup: number,
    fromTrack: ABRTrack,
    toTrack: ABRTrack,
    reason: 'auto' | 'manual'
  ): Promise<void> {
    const groupTracks = this.tracks.get(altGroup)!;
    const fromIndex = groupTracks.findIndex(t => t.name === fromTrack.name);
    const toIndex = groupTracks.findIndex(t => t.name === toTrack.name);

    const isUpgrade = toIndex > fromIndex;

    this.log('Switching quality', {
      altGroup,
      from: fromTrack.name,
      to: toTrack.name,
      reason,
      direction: isUpgrade ? 'upgrade' : 'downgrade',
    });

    try {
      await this.config.onSwitch(fromTrack, toTrack);

      // Update state
      fromTrack.isSubscribed = false;
      toTrack.isSubscribed = true;
      this.activeTrack.set(altGroup, toTrack);
      this.lastSwitchTime = Date.now();

      // Update stats
      if (isUpgrade) {
        this.stats.upgrades++;
      } else {
        this.stats.downgrades++;
      }
      this.updateStats();

      this.log('Switch complete', { altGroup, newTrack: toTrack.name });
    } catch (err) {
      this.log('Switch failed', { altGroup, error: (err as Error).message });
    }
  }

  private updateStats(): void {
    // Find the most relevant altGroup for stats
    for (const [altGroup, track] of this.activeTrack) {
      const groupTracks = this.tracks.get(altGroup);
      if (groupTracks && groupTracks.length > 1) {
        const currentIndex = groupTracks.findIndex(t => t.name === track.name);
        this.stats.currentQualityLevel = currentIndex;
        this.stats.totalQualityLevels = groupTracks.length;
        break;
      }
    }
  }

  private calculateEWMA(samples: number[]): number {
    if (samples.length === 0) return 0;

    const alpha = 0.3; // Smoothing factor
    let ewma = samples[0];

    for (let i = 1; i < samples.length; i++) {
      ewma = alpha * samples[i] + (1 - alpha) * ewma;
    }

    return ewma;
  }

  private log(message: string, data?: Record<string, unknown>): void {
    if (this.config.debug) {
      console.log(`[ABRController] ${message}`, data ?? '');
    }
  }
}
