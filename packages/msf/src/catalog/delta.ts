// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Catalog delta operations
 *
 * Provides functions for generating and applying delta updates to catalogs.
 */

import { MSF_VERSION } from '../version.js';
import type { FullCatalog, DeltaCatalog, Track, CloneTrack } from '../schemas/index.js';

/**
 * Error thrown when delta operations fail
 */
export class DeltaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeltaError';
  }
}

/**
 * Options for delta generation
 */
export interface DeltaOptions {
  /** Include generation timestamp */
  generatedAt?: boolean;
}

/**
 * Generate a delta update between two catalogs
 *
 * @param oldCatalog - Base catalog
 * @param newCatalog - Updated catalog
 * @param options - Delta generation options
 * @returns Delta catalog or null if no changes
 */
export function generateDelta(
  oldCatalog: FullCatalog,
  newCatalog: FullCatalog,
  options: DeltaOptions = {}
): DeltaCatalog | null {
  const oldTrackNames = new Set(oldCatalog.tracks.map((t) => t.name));
  const newTrackNames = new Set(newCatalog.tracks.map((t) => t.name));

  // Find tracks to add (in new but not in old)
  const addTracks: Track[] = newCatalog.tracks.filter(
    (t) => !oldTrackNames.has(t.name)
  );

  // Find tracks to remove (in old but not in new)
  const removeTracks: string[] = oldCatalog.tracks
    .filter((t) => !newTrackNames.has(t.name))
    .map((t) => t.name);

  // Check for modified tracks (same name but different content)
  const modifiedTracks: Track[] = [];
  for (const newTrack of newCatalog.tracks) {
    if (oldTrackNames.has(newTrack.name)) {
      const oldTrack = oldCatalog.tracks.find((t) => t.name === newTrack.name);
      if (oldTrack && !tracksEqual(oldTrack, newTrack)) {
        modifiedTracks.push(newTrack);
      }
    }
  }

  // If there are modified tracks, they need to be removed and re-added
  if (modifiedTracks.length > 0) {
    removeTracks.push(...modifiedTracks.map((t) => t.name));
    addTracks.push(...modifiedTracks);
  }

  // No changes
  if (addTracks.length === 0 && removeTracks.length === 0) {
    return null;
  }

  const delta: DeltaCatalog = {
    version: MSF_VERSION,
    deltaUpdate: true,
  };

  if (addTracks.length > 0) {
    delta.addTracks = addTracks;
  }

  if (removeTracks.length > 0) {
    delta.removeTracks = removeTracks;
  }

  if (options.generatedAt) {
    delta.generatedAt = Date.now();
  }

  return delta;
}

/**
 * Apply a delta update to a base catalog
 *
 * @param baseCatalog - Base catalog to update
 * @param delta - Delta update to apply
 * @returns Updated catalog
 * @throws {DeltaError} If delta application fails
 */
export function applyDelta(
  baseCatalog: FullCatalog,
  delta: DeltaCatalog
): FullCatalog {
  // Start with a copy of the base tracks
  let tracks = [...baseCatalog.tracks];

  // Remove tracks
  if (delta.removeTracks && delta.removeTracks.length > 0) {
    const removeSet = new Set(delta.removeTracks);
    tracks = tracks.filter((t) => !removeSet.has(t.name));
  }

  // Add tracks
  if (delta.addTracks && delta.addTracks.length > 0) {
    // Ensure no duplicates
    const existingNames = new Set(tracks.map((t) => t.name));
    for (const track of delta.addTracks) {
      if (existingNames.has(track.name)) {
        throw new DeltaError(`Track '${track.name}' already exists in catalog`);
      }
      existingNames.add(track.name);
    }
    tracks.push(...delta.addTracks);
  }

  // Clone tracks
  if (delta.cloneTracks && delta.cloneTracks.length > 0) {
    for (const clone of delta.cloneTracks) {
      const sourceTrack = tracks.find((t) => t.name === clone.sourceName);
      if (!sourceTrack) {
        throw new DeltaError(
          `Source track '${clone.sourceName}' not found for clone`
        );
      }

      const existingNames = new Set(tracks.map((t) => t.name));
      if (existingNames.has(clone.name)) {
        throw new DeltaError(`Clone target '${clone.name}' already exists`);
      }

      // Create cloned track with overrides
      const clonedTrack: Track = {
        ...sourceTrack,
        ...clone.overrides,
        name: clone.name,
      };
      tracks.push(clonedTrack);
    }
  }

  return {
    version: MSF_VERSION,
    tracks,
    generatedAt: delta.generatedAt ?? baseCatalog.generatedAt,
    isComplete: baseCatalog.isComplete,
  };
}

/**
 * Create a delta builder for incremental updates
 */
export class DeltaBuilder {
  private addTracks: Track[] = [];
  private removeTracks: string[] = [];
  private cloneTracks: CloneTrack[] = [];
  private _generatedAt?: number;

  /**
   * Add a track to the delta
   */
  add(track: Track): this {
    this.addTracks.push(track);
    return this;
  }

  /**
   * Remove a track by name
   */
  remove(trackName: string): this {
    this.removeTracks.push(trackName);
    return this;
  }

  /**
   * Clone a track with optional overrides
   */
  clone(sourceName: string, newName: string, overrides?: Partial<Omit<Track, 'name'>>): this {
    this.cloneTracks.push({
      sourceName,
      name: newName,
      overrides,
    });
    return this;
  }

  /**
   * Set generation timestamp
   */
  generatedAt(timestamp?: number): this {
    this._generatedAt = timestamp ?? Date.now();
    return this;
  }

  /**
   * Build the delta catalog
   */
  build(): DeltaCatalog {
    const delta: DeltaCatalog = {
      version: MSF_VERSION,
      deltaUpdate: true,
    };

    if (this.addTracks.length > 0) {
      delta.addTracks = this.addTracks;
    }

    if (this.removeTracks.length > 0) {
      delta.removeTracks = this.removeTracks;
    }

    if (this.cloneTracks.length > 0) {
      delta.cloneTracks = this.cloneTracks;
    }

    if (this._generatedAt !== undefined) {
      delta.generatedAt = this._generatedAt;
    }

    return delta;
  }

  /**
   * Check if the delta has any changes
   */
  hasChanges(): boolean {
    return (
      this.addTracks.length > 0 ||
      this.removeTracks.length > 0 ||
      this.cloneTracks.length > 0
    );
  }
}

/**
 * Create a new delta builder
 */
export function createDelta(): DeltaBuilder {
  return new DeltaBuilder();
}

/**
 * Check if two tracks are equal
 */
function tracksEqual(a: Track, b: Track): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
