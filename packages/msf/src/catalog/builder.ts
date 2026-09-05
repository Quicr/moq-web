// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Fluent catalog builder
 *
 * Provides a builder pattern for constructing MSF catalogs.
 */

import { MSF_VERSION } from '../version.js';
import type { FullCatalog, InitDataEntry, Track } from '../schemas/index.js';
import type { VideoTrackInput, AudioTrackInput, DataTrackInput } from '../types/index.js';

/**
 * Fluent builder for constructing MSF catalogs
 *
 * @example
 * ```typescript
 * const catalog = createCatalog()
 *   .generatedAt()
 *   .addVideoTrack({
 *     name: 'video-main',
 *     codec: 'avc1.4D401E',
 *     width: 1280, height: 720,
 *     framerate: 30, bitrate: 2_000_000,
 *     isLive: true,
 *   })
 *   .addAudioTrack({
 *     name: 'audio-main',
 *     codec: 'opus',
 *     samplerate: 48000,
 *     channelConfig: 'stereo',
 *     isLive: true,
 *   })
 *   .build();
 * ```
 */
export class CatalogBuilder {
  private tracks: Track[] = [];
  private _publishTracks: Track[] = [];
  private _initDataList: InitDataEntry[] = [];
  private _generatedAt?: number;
  private _isComplete?: true;

  /**
   * Set the generation timestamp to now
   */
  generatedAt(timestamp?: number): this {
    this._generatedAt = timestamp ?? Date.now();
    return this;
  }

  /**
   * Mark the catalog as complete (all tracks known).
   *
   * MSF §5.6: `isComplete` MUST NOT be included if it is false — this is a
   * one-way latch that promises no further tracks or objects will be added.
   * The builder therefore only accepts the `true` value.
   */
  isComplete(): this {
    this._isComplete = true;
    return this;
  }

  /**
   * Add a video track to the catalog
   */
  addVideoTrack(input: VideoTrackInput): this {
    const track: Track = {
      name: input.name,
      packaging: 'loc',
      isLive: input.isLive,
      codec: input.codec,
      width: input.width,
      height: input.height,
      displayWidth: input.displayWidth,
      displayHeight: input.displayHeight,
      framerate: input.framerate,
      bitrate: input.bitrate,
      namespace: input.namespace,
      role: input.role,
      renderGroup: input.renderGroup,
      altGroup: input.altGroup,
      targetLatency: input.targetLatency,
      label: input.label,
      depends: input.depends,
      initData: input.initData,
      temporalId: input.temporalId,
      spatialId: input.spatialId,
      // VOD metadata
      trackDuration: input.trackDuration,
      timescale: input.timescale,
      totalGroups: input.totalGroups,
      gopDuration: input.gopDuration,
    };
    // Remove undefined values
    this.tracks.push(this.removeUndefined(track));
    return this;
  }

  /**
   * Add an audio track to the catalog
   */
  addAudioTrack(input: AudioTrackInput): this {
    const track: Track = {
      name: input.name,
      packaging: 'loc',
      isLive: input.isLive,
      codec: input.codec,
      samplerate: input.samplerate,
      channelConfig: input.channelConfig,
      bitrate: input.bitrate,
      namespace: input.namespace,
      role: input.role,
      renderGroup: input.renderGroup,
      altGroup: input.altGroup,
      targetLatency: input.targetLatency,
      label: input.label,
      lang: input.lang,
      audioSpecificConfig: input.audioSpecificConfig,
      // VOD metadata
      trackDuration: input.trackDuration,
      totalGroups: input.totalGroups,
      gopDuration: input.gopDuration,
    };
    this.tracks.push(this.removeUndefined(track));
    return this;
  }

  /**
   * Add a data/metadata track to the catalog
   */
  addDataTrack(input: DataTrackInput): this {
    const track: Track = {
      name: input.name,
      packaging: input.packaging,
      isLive: input.isLive,
      mimeType: input.mimeType,
      namespace: input.namespace,
      role: input.role,
      label: input.label,
      timescale: input.timescale,
    };
    this.tracks.push(this.removeUndefined(track));
    return this;
  }

  /**
   * Add a raw track definition
   */
  addTrack(track: Track): this {
    this.tracks.push(track);
    return this;
  }

  /**
   * Add multiple tracks at once
   */
  addTracks(tracks: Track[]): this {
    this.tracks.push(...tracks);
    return this;
  }

  /**
   * Add a track subscribers may publish back on this session (§5 `publishTracks`).
   */
  addPublishTrack(track: Track): this {
    this._publishTracks.push(track);
    return this;
  }

  /**
   * Register an initialization-data entry referenced by track `initRef` (§5 `initDataList`).
   */
  addInitData(entry: InitDataEntry): this {
    this._initDataList.push(entry);
    return this;
  }

  /**
   * Build the catalog
   */
  build(): FullCatalog {
    const catalog: FullCatalog = {
      version: MSF_VERSION,
      tracks: this.tracks,
    };

    if (this._generatedAt !== undefined) {
      catalog.generatedAt = this._generatedAt;
    }

    if (this._isComplete !== undefined) {
      catalog.isComplete = this._isComplete;
    }

    if (this._publishTracks.length > 0) {
      catalog.publishTracks = this._publishTracks;
    }

    if (this._initDataList.length > 0) {
      catalog.initDataList = this._initDataList;
    }

    return catalog;
  }

  /**
   * Remove undefined values from an object
   */
  private removeUndefined<T extends object>(obj: T): T {
    return Object.fromEntries(
      Object.entries(obj).filter(([, v]) => v !== undefined)
    ) as T;
  }
}

/**
 * Create a new catalog builder
 */
export function createCatalog(): CatalogBuilder {
  return new CatalogBuilder();
}
