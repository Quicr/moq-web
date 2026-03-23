// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Timeline module exports
 */

// Media timeline
export {
  MediaTimelineError,
  encodeMediaTimelineEntry,
  decodeMediaTimelineEntry,
  encodeMediaTimeline,
  decodeMediaTimeline,
  serializeMediaTimeline,
  parseMediaTimeline,
  findLocationForTime,
  findTimeForLocation,
  type MediaTimelinePoint,
} from './media-timeline.js';

// Event timeline
export {
  EventTimelineError,
  encodeEventTimelineEntry,
  decodeEventTimelineEntry,
  encodeEventTimeline,
  decodeEventTimeline,
  serializeEventTimeline,
  parseEventTimeline,
  createWallclockEvent,
  createLocationEvent,
  createMediaTimeEvent,
  createCompositeEvent,
  type EventTimelinePoint,
} from './event-timeline.js';

// Timeline template
export {
  TimelineTemplateError,
  MediaTimelineCalculator,
  createVideoTemplate,
  createAudioTemplate,
  templateFromArray,
  templateToArray,
} from './template.js';
