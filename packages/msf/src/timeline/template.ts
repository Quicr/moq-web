// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Media timeline template per MSF spec
 *
 * For fixed-duration content (constant framerate video, fixed audio frames),
 * the template allows calculating time/location mappings without storing
 * individual entries.
 *
 * Spec format (6-element array):
 * [startMediaTime, deltaMediaTime, [startGroupID, startObjectID],
 *  [deltaGroupID, deltaObjectID], startWallclock, deltaWallclock]
 */

import type {
  MediaTimelineTemplate,
  MediaTimelineTemplateArray,
  LocationRef,
} from '../schemas/index.js';
import type { MediaTimelinePoint } from './media-timeline.js';

/**
 * Error thrown when template operations fail
 */
export class TimelineTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimelineTemplateError';
  }
}

/**
 * Convert spec array format to object format
 */
export function templateFromArray(arr: MediaTimelineTemplateArray): MediaTimelineTemplate {
  return {
    startMediaTime: arr[0],
    deltaMediaTime: arr[1],
    startGroupId: arr[2][0],
    startObjectId: arr[2][1],
    deltaGroupId: arr[3][0],
    deltaObjectId: arr[3][1],
    startWallclock: arr[4],
    deltaWallclock: arr[5],
  };
}

/**
 * Convert object format to spec array format
 */
export function templateToArray(template: MediaTimelineTemplate): MediaTimelineTemplateArray {
  return [
    template.startMediaTime ?? 0,
    template.deltaMediaTime,
    [template.startGroupId, template.startObjectId ?? 0],
    [template.deltaGroupId ?? 0, template.deltaObjectId ?? 1],
    template.startWallclock ?? 0,
    template.deltaWallclock ?? 0,
  ];
}

/**
 * Media timeline template calculator
 *
 * Supports both spec-compliant array format and object format for ease of use.
 *
 * @example
 * ```typescript
 * // From spec array format
 * const calc = MediaTimelineCalculator.fromArray([0, 3000, [0, 0], [0, 1], Date.now(), 33]);
 *
 * // From object format
 * const calc = new MediaTimelineCalculator({
 *   startMediaTime: 0,
 *   deltaMediaTime: 3000, // 30fps at 90kHz timescale
 *   startGroupId: 0,
 *   startObjectId: 0,
 *   deltaGroupId: 0,
 *   deltaObjectId: 1,
 *   startWallclock: Date.now(),
 *   deltaWallclock: 33, // ~30fps in ms
 * });
 *
 * // Calculate location for a given time
 * const location = calc.locationForTime(90000);
 *
 * // Calculate time for a given location
 * const time = calc.timeForLocation(0, 15);
 * ```
 */
export class MediaTimelineCalculator {
  private readonly template: Required<MediaTimelineTemplate>;

  constructor(template: MediaTimelineTemplate) {
    this.template = {
      startMediaTime: template.startMediaTime ?? 0,
      deltaMediaTime: template.deltaMediaTime,
      startGroupId: template.startGroupId,
      startObjectId: template.startObjectId ?? 0,
      deltaGroupId: template.deltaGroupId ?? 0,
      deltaObjectId: template.deltaObjectId ?? 1,
      startWallclock: template.startWallclock ?? 0,
      deltaWallclock: template.deltaWallclock ?? 0,
    };

    if (this.template.deltaMediaTime <= 0) {
      throw new TimelineTemplateError('deltaMediaTime must be positive');
    }

    if (this.template.deltaObjectId === 0 && this.template.deltaGroupId === 0) {
      throw new TimelineTemplateError(
        'At least one of deltaObjectId or deltaGroupId must be non-zero'
      );
    }
  }

  /**
   * Create calculator from spec array format
   */
  static fromArray(arr: MediaTimelineTemplateArray): MediaTimelineCalculator {
    return new MediaTimelineCalculator(templateFromArray(arr));
  }

  /**
   * Calculate the location for a given media time
   *
   * @param mediaTime - Media time in timescale units
   * @returns Location reference [groupId, objectId]
   */
  locationForTime(mediaTime: number): LocationRef {
    const relativeTime = mediaTime - this.template.startMediaTime;
    if (relativeTime < 0) {
      throw new TimelineTemplateError('Media time is before start time');
    }

    const objectIndex = Math.floor(relativeTime / this.template.deltaMediaTime);
    const groupId = this.template.startGroupId + objectIndex * this.template.deltaGroupId;
    const objectId = this.template.startObjectId + objectIndex * this.template.deltaObjectId;

    return [groupId, objectId];
  }

  /**
   * Calculate the media time for a given location
   *
   * @param groupId - Group ID
   * @param objectId - Object ID within the group
   * @returns Media time in timescale units
   */
  timeForLocation(groupId: number, objectId: number): number {
    // Calculate object index from location
    let objectIndex: number;

    if (this.template.deltaGroupId !== 0) {
      const groupOffset = groupId - this.template.startGroupId;
      if (groupOffset < 0) {
        throw new TimelineTemplateError('Group ID is before start group');
      }
      objectIndex = groupOffset / this.template.deltaGroupId;
    } else {
      const objectOffset = objectId - this.template.startObjectId;
      if (objectOffset < 0) {
        throw new TimelineTemplateError('Object ID is before start object');
      }
      objectIndex = objectOffset / this.template.deltaObjectId;
    }

    if (!Number.isInteger(objectIndex)) {
      throw new TimelineTemplateError('Location does not align with template');
    }

    return this.template.startMediaTime + objectIndex * this.template.deltaMediaTime;
  }

  /**
   * Calculate wallclock time for a given media time
   *
   * @param mediaTime - Media time in timescale units
   * @returns Wallclock time in epoch milliseconds
   */
  wallclockForMediaTime(mediaTime: number): number {
    const relativeTime = mediaTime - this.template.startMediaTime;
    const objectIndex = Math.floor(relativeTime / this.template.deltaMediaTime);
    return this.template.startWallclock + objectIndex * this.template.deltaWallclock;
  }

  /**
   * Calculate media time for a given wallclock time
   *
   * @param wallclock - Wallclock time in epoch milliseconds
   * @returns Media time in timescale units
   */
  mediaTimeForWallclock(wallclock: number): number {
    if (this.template.deltaWallclock === 0) {
      throw new TimelineTemplateError('Cannot calculate media time: deltaWallclock is 0');
    }
    const relativeWallclock = wallclock - this.template.startWallclock;
    const objectIndex = Math.floor(relativeWallclock / this.template.deltaWallclock);
    return this.template.startMediaTime + objectIndex * this.template.deltaMediaTime;
  }

  /**
   * Generate timeline points for a range of objects
   *
   * @param startIndex - Start object index (inclusive)
   * @param endIndex - End object index (exclusive)
   * @returns Array of media timeline points
   */
  generatePoints(startIndex: number, endIndex: number): MediaTimelinePoint[] {
    const points: MediaTimelinePoint[] = [];

    for (let i = startIndex; i < endIndex; i++) {
      const mediaPTS = this.template.startMediaTime + i * this.template.deltaMediaTime;
      const groupId = this.template.startGroupId + i * this.template.deltaGroupId;
      const objectId = this.template.startObjectId + i * this.template.deltaObjectId;
      const wallclockTime = this.template.startWallclock + i * this.template.deltaWallclock;

      points.push({
        mediaPTS,
        groupId,
        objectId,
        wallclockTime: this.template.deltaWallclock !== 0 ? wallclockTime : undefined,
      });
    }

    return points;
  }

  /**
   * Get the template configuration in object format
   */
  getTemplate(): MediaTimelineTemplate {
    return { ...this.template };
  }

  /**
   * Get the template configuration in spec array format
   */
  toArray(): MediaTimelineTemplateArray {
    return templateToArray(this.template);
  }
}

/**
 * Create a template for constant framerate video
 *
 * @param startGroupId - Starting group ID
 * @param framerate - Frames per second
 * @param timescale - Timescale units per second (default 90000 for video)
 * @param startWallclock - Optional start wallclock time
 */
export function createVideoTemplate(
  startGroupId: number,
  framerate: number,
  timescale = 90000,
  startWallclock?: number
): MediaTimelineCalculator {
  const deltaMediaTime = timescale / framerate;
  const deltaWallclock = 1000 / framerate;

  return new MediaTimelineCalculator({
    startMediaTime: 0,
    deltaMediaTime,
    startGroupId,
    startObjectId: 0,
    deltaGroupId: 0,
    deltaObjectId: 1,
    startWallclock: startWallclock ?? 0,
    deltaWallclock,
  });
}

/**
 * Create a template for audio frames
 *
 * @param startGroupId - Starting group ID
 * @param samplerate - Audio sample rate (used to calculate wallclock delta)
 * @param samplesPerFrame - Samples per audio frame (deltaMediaTime)
 * @param startWallclock - Optional start wallclock time
 */
export function createAudioTemplate(
  startGroupId: number,
  samplerate: number,
  samplesPerFrame: number,
  startWallclock?: number
): MediaTimelineCalculator {
  const deltaWallclock = (samplesPerFrame / samplerate) * 1000;

  return new MediaTimelineCalculator({
    startMediaTime: 0,
    deltaMediaTime: samplesPerFrame,
    startGroupId,
    startObjectId: 0,
    deltaGroupId: 0,
    deltaObjectId: 1,
    startWallclock: startWallclock ?? 0,
    deltaWallclock,
  });
}

