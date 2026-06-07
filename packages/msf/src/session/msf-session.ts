// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MSF Session wrapper
 *
 * Wraps a MOQTSession to provide MSF-specific operations for catalog
 * management and track discovery.
 */

import type { MOQTSession, VODPublishOptions } from '@web-moq/session';
import type { FullCatalog, Track } from '../schemas/index.js';
import {
  CatalogSubscriber,
  CatalogPublisher,
  createCatalogSubscriber,
  createCatalogPublisher,
  type CatalogPublishOptions,
} from './catalog-track.js';
import { generateMsfUrl, generateCatalogUrl, parseMsfUrl } from '../url/index.js';

/**
 * Published track info
 */
export interface PublishedTrackInfo {
  trackAlias: bigint;
  trackName: string;
  type: 'vod' | 'live';
}

/**
 * MSF Session configuration
 */
export interface MSFSessionConfig {
  /** Catalog publish options */
  catalogPublishOptions?: CatalogPublishOptions;
}

/**
 * Track info from catalog
 */
export interface TrackInfo {
  namespace: string[];
  name: string;
  track: Track;
}

/**
 * MSF-aware session wrapper
 *
 * Provides high-level APIs for MSF catalog management on top of a MOQTSession.
 *
 * @example
 * ```typescript
 * const msfSession = new MSFSession(moqtSession, ['conference', 'room-1']);
 *
 * // Subscribe to catalog
 * await msfSession.subscribeCatalog((catalog, isIndependent) => {
 *   console.log('Received catalog:', catalog.tracks.length, 'tracks');
 * });
 *
 * // Publish catalog
 * await msfSession.startCatalogPublishing();
 * await msfSession.publishCatalog(catalog);
 * ```
 */
export class MSFSession {
  private session: MOQTSession;
  private namespace: string[];
  private catalogSubscriber: CatalogSubscriber | null = null;
  private catalogPublisher: CatalogPublisher | null = null;
  private config: MSFSessionConfig;
  private publishedTracks: Map<string, PublishedTrackInfo> = new Map();

  constructor(
    session: MOQTSession,
    namespace: string[],
    config: MSFSessionConfig = {}
  ) {
    this.session = session;
    this.namespace = namespace;
    this.config = config;
  }

  /**
   * Get the session namespace
   */
  getNamespace(): string[] {
    return [...this.namespace];
  }

  /**
   * Get the underlying MOQT session
   */
  getMOQTSession(): MOQTSession {
    return this.session;
  }

  /**
   * Subscribe to the catalog track
   */
  async subscribeCatalog(
    onCatalog: (catalog: FullCatalog, isIndependent: boolean) => void,
    onError?: (error: Error) => void
  ): Promise<void> {
    if (this.catalogSubscriber) {
      throw new Error('Already subscribed to catalog');
    }

    this.catalogSubscriber = createCatalogSubscriber(
      this.session,
      this.namespace,
      { onCatalog, onError }
    );

    await this.catalogSubscriber.subscribe();
  }

  /**
   * Unsubscribe from the catalog track
   */
  async unsubscribeCatalog(): Promise<void> {
    if (this.catalogSubscriber) {
      await this.catalogSubscriber.unsubscribe();
      this.catalogSubscriber = null;
    }
  }

  /**
   * Get the current catalog (from subscription)
   */
  getCatalog(): FullCatalog | null {
    return this.catalogSubscriber?.getCatalog() ?? null;
  }

  /**
   * Start publishing the catalog track
   */
  async startCatalogPublishing(): Promise<void> {
    if (this.catalogPublisher) {
      throw new Error('Already publishing catalog');
    }

    this.catalogPublisher = createCatalogPublisher(
      this.session,
      this.namespace,
      this.config.catalogPublishOptions
    );

    await this.catalogPublisher.start();
  }

  /**
   * Stop publishing the catalog track
   */
  async stopCatalogPublishing(): Promise<void> {
    if (this.catalogPublisher) {
      await this.catalogPublisher.stop();
      this.catalogPublisher = null;
    }
  }

  /**
   * Publish a full catalog
   */
  async publishCatalog(catalog: FullCatalog): Promise<void> {
    if (!this.catalogPublisher) {
      throw new Error('Not publishing catalog');
    }
    await this.catalogPublisher.publishFull(catalog);
  }

  /**
   * Get the published catalog
   */
  getPublishedCatalog(): FullCatalog | null {
    return this.catalogPublisher?.getCatalog() ?? null;
  }

  /**
   * Get all tracks from the current catalog
   */
  getTracks(): TrackInfo[] {
    const catalog = this.getCatalog();
    if (!catalog) {
      return [];
    }

    return catalog.tracks.map((track) => ({
      namespace: track.namespace ?? this.namespace,
      name: track.name,
      track,
    }));
  }

  /**
   * Find a track by name in the current catalog
   */
  findTrack(trackName: string): TrackInfo | null {
    const tracks = this.getTracks();
    const found = tracks.find((t) => t.name === trackName);
    return found ?? null;
  }

  /**
   * Find tracks by role
   */
  findTracksByRole(role: string): TrackInfo[] {
    return this.getTracks().filter((t) => t.track.role === role);
  }

  /**
   * Find video tracks
   */
  findVideoTracks(): TrackInfo[] {
    return this.getTracks().filter(
      (t) => t.track.width !== undefined || t.track.height !== undefined
    );
  }

  /**
   * Find audio tracks
   */
  findAudioTracks(): TrackInfo[] {
    return this.getTracks().filter(
      (t) => t.track.samplerate !== undefined || t.track.channelConfig !== undefined
    );
  }

  /**
   * Generate MSF URL for a track
   */
  generateTrackUrl(relayUrl: string, trackName: string): string {
    const track = this.findTrack(trackName);
    if (!track) {
      throw new Error(`Track '${trackName}' not found in catalog`);
    }
    return generateMsfUrl(relayUrl, track.namespace, trackName);
  }

  /**
   * Generate catalog URL
   */
  generateCatalogUrl(relayUrl: string): string {
    return generateCatalogUrl(relayUrl, this.namespace);
  }

  /**
   * Parse an MSF URL and return track info
   */
  parseTrackUrl(url: string): { namespace: string[]; trackName: string } {
    const parsed = parseMsfUrl(url);
    return {
      namespace: parsed.namespace,
      trackName: parsed.trackName,
    };
  }

  /**
   * Publish a VOD track
   *
   * Registers the track with the relay so subscribers can FETCH objects.
   * The track should already be defined in the catalog.
   *
   * @param trackName - Name of the track (must match catalog track name)
   * @param options - VOD publish options from VODLoader.getPublishOptions()
   * @returns Track alias for the published track
   *
   * @example
   * ```typescript
   * // Load VOD
   * const loader = new VODLoader();
   * await loader.loadFile(videoFile);
   *
   * // Publish track
   * const trackAlias = await msfSession.publishVODTrack(
   *   'video-1',
   *   loader.getPublishOptions()
   * );
   * ```
   */
  async publishVODTrack(
    trackName: string,
    options: Omit<VODPublishOptions, 'priority' | 'groupOrder' | 'deliveryTimeout' | 'deliveryMode' | 'audioDeliveryMode'>
  ): Promise<bigint> {
    const trackAlias = await this.session.publishVOD(
      this.namespace,
      trackName,
      options as VODPublishOptions
    );

    this.publishedTracks.set(trackName, {
      trackAlias,
      trackName,
      type: 'vod',
    });

    return trackAlias;
  }

  /**
   * Get all published tracks
   */
  getPublishedTracks(): PublishedTrackInfo[] {
    return Array.from(this.publishedTracks.values());
  }

  /**
   * Get a published track by name
   */
  getPublishedTrack(trackName: string): PublishedTrackInfo | null {
    return this.publishedTracks.get(trackName) ?? null;
  }

  /**
   * Unpublish a track
   */
  async unpublishTrack(trackName: string): Promise<void> {
    const track = this.publishedTracks.get(trackName);
    if (track) {
      await this.session.unpublish(track.trackAlias);
      this.publishedTracks.delete(trackName);
    }
  }

  /**
   * Publish catalog and all VOD tracks in one call
   *
   * Convenience method that:
   * 1. Starts catalog publishing
   * 2. Publishes each VOD track
   * 3. Publishes the catalog JSON
   *
   * @param catalog - The full catalog to publish
   * @param vodTracks - Map of track name to VOD options
   *
   * @example
   * ```typescript
   * const vodTracks = new Map([
   *   ['video-1', loader1.getPublishOptions()],
   *   ['video-2', loader2.getPublishOptions()],
   * ]);
   *
   * await msfSession.publishAll(catalog, vodTracks);
   * ```
   */
  async publishAll(
    catalog: FullCatalog,
    vodTracks: Map<string, Omit<VODPublishOptions, 'priority' | 'groupOrder' | 'deliveryTimeout' | 'deliveryMode' | 'audioDeliveryMode'>>
  ): Promise<void> {
    // Start catalog publishing if not already started
    if (!this.catalogPublisher) {
      await this.startCatalogPublishing();
    }

    // Publish each VOD track
    for (const [trackName, options] of vodTracks) {
      if (!this.publishedTracks.has(trackName)) {
        await this.publishVODTrack(trackName, options);
      }
    }

    // Publish the catalog
    await this.publishCatalog(catalog);
  }

  /**
   * Close the MSF session
   */
  async close(): Promise<void> {
    // Unpublish all tracks
    for (const trackName of this.publishedTracks.keys()) {
      await this.unpublishTrack(trackName);
    }
    await this.unsubscribeCatalog();
    await this.stopCatalogPublishing();
  }
}

/**
 * Create an MSF session
 */
export function createMSFSession(
  session: MOQTSession,
  namespace: string[],
  config?: MSFSessionConfig
): MSFSession {
  return new MSFSession(session, namespace, config);
}
