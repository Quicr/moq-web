// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import {
  encodeMediaTimelineEntry,
  decodeMediaTimelineEntry,
  encodeMediaTimeline,
  decodeMediaTimeline,
  serializeMediaTimeline,
  parseMediaTimeline,
  findLocationForTime,
  findTimeForLocation,
  MediaTimelineError,
  type MediaTimelinePoint,
} from './media-timeline.js';
import {
  encodeEventTimelineEntry,
  decodeEventTimelineEntry,
  createWallclockEvent,
  createLocationEvent,
  createMediaTimeEvent,
  createCompositeEvent,
  serializeEventTimeline,
  parseEventTimeline,
  EventTimelineError,
  type EventTimelinePoint,
} from './event-timeline.js';
import {
  MediaTimelineCalculator,
  createVideoTemplate,
  createAudioTemplate,
  templateFromArray,
  templateToArray,
  TimelineTemplateError,
} from './template.js';
import type { MediaTimelineTemplateArray } from '../schemas/index.js';

describe('MediaTimeline', () => {
  describe('encode/decode', () => {
    it('should encode media timeline entry', () => {
      const point: MediaTimelinePoint = {
        mediaPTS: 90000,
        groupId: 1,
        objectId: 0,
      };

      const entry = encodeMediaTimelineEntry(point);

      expect(entry).toEqual([90000, [1, 0]]);
    });

    it('should encode entry with wallclock time', () => {
      const point: MediaTimelinePoint = {
        mediaPTS: 90000,
        groupId: 1,
        objectId: 0,
        wallclockTime: 1700000000000,
      };

      const entry = encodeMediaTimelineEntry(point);

      expect(entry).toEqual([90000, [1, 0], 1700000000000]);
    });

    it('should decode media timeline entry', () => {
      const entry = [90000, [1, 5]];
      const point = decodeMediaTimelineEntry(entry as [number, [number, number]]);

      expect(point.mediaPTS).toBe(90000);
      expect(point.groupId).toBe(1);
      expect(point.objectId).toBe(5);
      expect(point.wallclockTime).toBeUndefined();
    });

    it('should decode entry with wallclock time', () => {
      const entry = [90000, [1, 5], 1700000000000];
      const point = decodeMediaTimelineEntry(entry as [number, [number, number], number]);

      expect(point.wallclockTime).toBe(1700000000000);
    });

    it('should throw on invalid entry', () => {
      expect(() => decodeMediaTimelineEntry([] as unknown as [number, [number, number]])).toThrow(MediaTimelineError);
      expect(() => decodeMediaTimelineEntry(['invalid'] as unknown as [number, [number, number]])).toThrow(MediaTimelineError);
    });
  });

  describe('batch encode/decode', () => {
    it('should encode multiple points', () => {
      const points: MediaTimelinePoint[] = [
        { mediaPTS: 0, groupId: 0, objectId: 0 },
        { mediaPTS: 3000, groupId: 0, objectId: 1 },
        { mediaPTS: 6000, groupId: 0, objectId: 2 },
      ];

      const entries = encodeMediaTimeline(points);

      expect(entries).toHaveLength(3);
      expect(entries[0]).toEqual([0, [0, 0]]);
      expect(entries[1]).toEqual([3000, [0, 1]]);
      expect(entries[2]).toEqual([6000, [0, 2]]);
    });

    it('should decode multiple entries', () => {
      const entries: [number, [number, number]][] = [
        [0, [0, 0]],
        [3000, [0, 1]],
        [6000, [0, 2]],
      ];

      const points = decodeMediaTimeline(entries);

      expect(points).toHaveLength(3);
      expect(points[0].mediaPTS).toBe(0);
      expect(points[2].objectId).toBe(2);
    });
  });

  describe('serialization', () => {
    it('should serialize timeline to JSON', () => {
      const points: MediaTimelinePoint[] = [
        { mediaPTS: 0, groupId: 0, objectId: 0 },
      ];

      const json = serializeMediaTimeline(points);

      expect(JSON.parse(json)).toEqual([[0, [0, 0]]]);
    });

    it('should parse timeline from JSON', () => {
      const json = '[[0,[0,0]],[3000,[0,1]]]';
      const points = parseMediaTimeline(json);

      expect(points).toHaveLength(2);
      expect(points[0].mediaPTS).toBe(0);
      expect(points[1].mediaPTS).toBe(3000);
    });
  });

  describe('lookup functions', () => {
    const timeline: MediaTimelinePoint[] = [
      { mediaPTS: 0, groupId: 0, objectId: 0 },
      { mediaPTS: 3000, groupId: 0, objectId: 1 },
      { mediaPTS: 6000, groupId: 0, objectId: 2 },
      { mediaPTS: 9000, groupId: 1, objectId: 0 },
    ];

    it('should find location for exact time', () => {
      const location = findLocationForTime(timeline, 3000);
      expect(location).toEqual([0, 1]);
    });

    it('should find location for time between entries', () => {
      const location = findLocationForTime(timeline, 4500);
      expect(location).toEqual([0, 1]); // Returns entry before target
    });

    it('should return null for time before start', () => {
      const location = findLocationForTime(timeline, -100);
      expect(location).toBeNull();
    });

    it('should return last entry for time after end', () => {
      const location = findLocationForTime(timeline, 100000);
      expect(location).toEqual([1, 0]);
    });

    it('should find time for location', () => {
      const time = findTimeForLocation(timeline, 0, 2);
      expect(time).toBe(6000);
    });

    it('should return null for unknown location', () => {
      const time = findTimeForLocation(timeline, 99, 99);
      expect(time).toBeNull();
    });
  });
});

describe('EventTimeline', () => {
  describe('encode/decode per MSF spec', () => {
    it('should encode wallclock event (t field)', () => {
      const point = createWallclockEvent(1700000000000, { type: 'marker' });
      const entry = encodeEventTimelineEntry(point);

      expect(entry.t).toBe(1700000000000);
      expect(entry.data).toEqual({ type: 'marker' });
      expect(entry.l).toBeUndefined();
      expect(entry.m).toBeUndefined();
    });

    it('should encode location event (l field as [groupId, objectId])', () => {
      const point = createLocationEvent(5, 10, { action: 'seek' });
      const entry = encodeEventTimelineEntry(point);

      expect(entry.l).toEqual([5, 10]);
      expect(entry.data).toEqual({ action: 'seek' });
      expect(entry.t).toBeUndefined();
      expect(entry.m).toBeUndefined();
    });

    it('should encode media time event (m field)', () => {
      const point = createMediaTimeEvent(90000, { frame: 'keyframe' });
      const entry = encodeEventTimelineEntry(point);

      expect(entry.m).toBe(90000);
      expect(entry.data).toEqual({ frame: 'keyframe' });
      expect(entry.t).toBeUndefined();
      expect(entry.l).toBeUndefined();
    });

    it('should encode composite event with multiple references', () => {
      const point = createCompositeEvent(
        { wallclockTime: 1700000000000, location: [1, 2], mediaTime: 90000 },
        { custom: 'data' }
      );
      const entry = encodeEventTimelineEntry(point);

      expect(entry.t).toBe(1700000000000);
      expect(entry.l).toEqual([1, 2]);
      expect(entry.m).toBe(90000);
      expect(entry.data).toEqual({ custom: 'data' });
    });

    it('should decode event entry with wallclock time', () => {
      const entry = { t: 1700000000000, data: { foo: 'bar' } };
      const point = decodeEventTimelineEntry(entry);

      expect(point.wallclockTime).toBe(1700000000000);
      expect(point.data).toEqual({ foo: 'bar' });
    });

    it('should decode event entry with location', () => {
      const entry = { l: [5, 10] as [number, number], data: { action: 'seek' } };
      const point = decodeEventTimelineEntry(entry);

      expect(point.location).toEqual([5, 10]);
      expect(point.data).toEqual({ action: 'seek' });
    });

    it('should decode event entry with media time', () => {
      const entry = { m: 90000 };
      const point = decodeEventTimelineEntry(entry);

      expect(point.mediaTime).toBe(90000);
    });

    it('should throw on invalid location format', () => {
      const entry = { l: 'invalid' };
      expect(() => decodeEventTimelineEntry(entry as any)).toThrow(EventTimelineError);
    });

    it('should throw on invalid entry type', () => {
      expect(() => decodeEventTimelineEntry(null as any)).toThrow(EventTimelineError);
      expect(() => decodeEventTimelineEntry('string' as any)).toThrow(EventTimelineError);
    });
  });

  describe('serialization', () => {
    it('should roundtrip serialize/parse', () => {
      const points: EventTimelinePoint[] = [
        createWallclockEvent(1700000000000, { type: 'start' }),
        createLocationEvent(1, 0, { type: 'keyframe' }),
        createMediaTimeEvent(90000, { type: 'marker' }),
      ];

      const json = serializeEventTimeline(points);
      const parsed = parseEventTimeline(json);

      expect(parsed).toHaveLength(3);
      expect(parsed[0].wallclockTime).toBe(1700000000000);
      expect(parsed[1].location).toEqual([1, 0]);
      expect(parsed[2].mediaTime).toBe(90000);
    });
  });
});

describe('MediaTimelineTemplate', () => {
  describe('spec array format conversion', () => {
    it('should convert from spec array format', () => {
      const arr: MediaTimelineTemplateArray = [
        0,        // startMediaTime
        3000,     // deltaMediaTime
        [0, 0],   // [startGroupId, startObjectId]
        [0, 1],   // [deltaGroupId, deltaObjectId]
        1700000000000, // startWallclock
        33,       // deltaWallclock (~30fps)
      ];

      const template = templateFromArray(arr);

      expect(template.startMediaTime).toBe(0);
      expect(template.deltaMediaTime).toBe(3000);
      expect(template.startGroupId).toBe(0);
      expect(template.startObjectId).toBe(0);
      expect(template.deltaGroupId).toBe(0);
      expect(template.deltaObjectId).toBe(1);
      expect(template.startWallclock).toBe(1700000000000);
      expect(template.deltaWallclock).toBe(33);
    });

    it('should convert to spec array format', () => {
      const template = {
        startMediaTime: 1000,
        deltaMediaTime: 3000,
        startGroupId: 5,
        startObjectId: 0,
        deltaGroupId: 0,
        deltaObjectId: 1,
        startWallclock: 1700000000000,
        deltaWallclock: 33,
      };

      const arr = templateToArray(template);

      expect(arr).toEqual([
        1000,
        3000,
        [5, 0],
        [0, 1],
        1700000000000,
        33,
      ]);
    });

    it('should roundtrip array conversion', () => {
      const original: MediaTimelineTemplateArray = [
        0, 3000, [10, 5], [1, 0], 1700000000000, 100,
      ];

      const template = templateFromArray(original);
      const converted = templateToArray(template);

      expect(converted).toEqual(original);
    });
  });

  describe('calculator from array', () => {
    it('should create calculator from spec array', () => {
      const arr: MediaTimelineTemplateArray = [
        0, 3000, [0, 0], [0, 1], 1700000000000, 33,
      ];

      const calc = MediaTimelineCalculator.fromArray(arr);

      expect(calc.locationForTime(0)).toEqual([0, 0]);
      expect(calc.locationForTime(3000)).toEqual([0, 1]);
      expect(calc.locationForTime(6000)).toEqual([0, 2]);
    });

    it('should export to array format', () => {
      const calc = new MediaTimelineCalculator({
        startMediaTime: 0,
        deltaMediaTime: 3000,
        startGroupId: 0,
        startObjectId: 0,
        deltaGroupId: 0,
        deltaObjectId: 1,
        startWallclock: 1700000000000,
        deltaWallclock: 33,
      });

      const arr = calc.toArray();

      expect(arr[0]).toBe(0);
      expect(arr[1]).toBe(3000);
      expect(arr[2]).toEqual([0, 0]);
      expect(arr[3]).toEqual([0, 1]);
    });
  });

  describe('basic calculations', () => {
    it('should calculate location for time with object increment', () => {
      const calc = new MediaTimelineCalculator({
        startMediaTime: 0,
        deltaMediaTime: 3000,
        startGroupId: 0,
        startObjectId: 0,
        deltaGroupId: 0,
        deltaObjectId: 1,
      });

      expect(calc.locationForTime(0)).toEqual([0, 0]);
      expect(calc.locationForTime(3000)).toEqual([0, 1]);
      expect(calc.locationForTime(6000)).toEqual([0, 2]);
      expect(calc.locationForTime(90000)).toEqual([0, 30]);
    });

    it('should calculate location for time with group increment', () => {
      const calc = new MediaTimelineCalculator({
        startMediaTime: 0,
        deltaMediaTime: 90000, // 1 GOP per group
        startGroupId: 0,
        startObjectId: 0,
        deltaGroupId: 1,
        deltaObjectId: 0,
      });

      expect(calc.locationForTime(0)).toEqual([0, 0]);
      expect(calc.locationForTime(90000)).toEqual([1, 0]);
      expect(calc.locationForTime(180000)).toEqual([2, 0]);
    });

    it('should calculate time for location', () => {
      const calc = new MediaTimelineCalculator({
        startMediaTime: 0,
        deltaMediaTime: 3000,
        startGroupId: 0,
        startObjectId: 0,
        deltaGroupId: 0,
        deltaObjectId: 1,
      });

      expect(calc.timeForLocation(0, 0)).toBe(0);
      expect(calc.timeForLocation(0, 1)).toBe(3000);
      expect(calc.timeForLocation(0, 30)).toBe(90000);
    });

    it('should handle non-zero start values', () => {
      const calc = new MediaTimelineCalculator({
        startMediaTime: 1000000,
        deltaMediaTime: 3000,
        startGroupId: 100,
        startObjectId: 5,
        deltaGroupId: 0,
        deltaObjectId: 1,
      });

      expect(calc.locationForTime(1000000)).toEqual([100, 5]);
      expect(calc.locationForTime(1003000)).toEqual([100, 6]);
      expect(calc.timeForLocation(100, 5)).toBe(1000000);
      expect(calc.timeForLocation(100, 6)).toBe(1003000);
    });
  });

  describe('wallclock calculations', () => {
    it('should calculate wallclock for media time', () => {
      const calc = new MediaTimelineCalculator({
        startMediaTime: 0,
        deltaMediaTime: 3000,
        startGroupId: 0,
        startObjectId: 0,
        deltaGroupId: 0,
        deltaObjectId: 1,
        startWallclock: 1700000000000,
        deltaWallclock: 33,
      });

      expect(calc.wallclockForMediaTime(0)).toBe(1700000000000);
      expect(calc.wallclockForMediaTime(3000)).toBe(1700000000033);
      expect(calc.wallclockForMediaTime(6000)).toBe(1700000000066);
    });

    it('should calculate media time for wallclock', () => {
      const calc = new MediaTimelineCalculator({
        startMediaTime: 0,
        deltaMediaTime: 3000,
        startGroupId: 0,
        startObjectId: 0,
        deltaGroupId: 0,
        deltaObjectId: 1,
        startWallclock: 1700000000000,
        deltaWallclock: 33,
      });

      expect(calc.mediaTimeForWallclock(1700000000000)).toBe(0);
      expect(calc.mediaTimeForWallclock(1700000000033)).toBe(3000);
    });

    it('should throw when deltaWallclock is 0 for mediaTimeForWallclock', () => {
      const calc = new MediaTimelineCalculator({
        startMediaTime: 0,
        deltaMediaTime: 3000,
        startGroupId: 0,
        startObjectId: 0,
        deltaGroupId: 0,
        deltaObjectId: 1,
        startWallclock: 0,
        deltaWallclock: 0,
      });

      expect(() => calc.mediaTimeForWallclock(1700000000000)).toThrow(TimelineTemplateError);
    });
  });

  describe('error handling', () => {
    it('should throw on invalid deltaMediaTime', () => {
      expect(() => new MediaTimelineCalculator({
        startMediaTime: 0,
        deltaMediaTime: 0,
        startGroupId: 0,
        startObjectId: 0,
        deltaGroupId: 0,
        deltaObjectId: 1,
      })).toThrow(TimelineTemplateError);

      expect(() => new MediaTimelineCalculator({
        startMediaTime: 0,
        deltaMediaTime: -1,
        startGroupId: 0,
        startObjectId: 0,
        deltaGroupId: 0,
        deltaObjectId: 1,
      })).toThrow(TimelineTemplateError);
    });

    it('should throw when both delta values are 0', () => {
      expect(() => new MediaTimelineCalculator({
        startMediaTime: 0,
        deltaMediaTime: 3000,
        startGroupId: 0,
        startObjectId: 0,
        deltaGroupId: 0,
        deltaObjectId: 0,
      })).toThrow(TimelineTemplateError);
    });

    it('should throw on time before start', () => {
      const calc = new MediaTimelineCalculator({
        startMediaTime: 1000,
        deltaMediaTime: 1,
        startGroupId: 0,
        startObjectId: 0,
        deltaGroupId: 0,
        deltaObjectId: 1,
      });

      expect(() => calc.locationForTime(0)).toThrow(TimelineTemplateError);
    });

    it('should throw on group before start', () => {
      const calc = new MediaTimelineCalculator({
        startMediaTime: 0,
        deltaMediaTime: 1,
        startGroupId: 10,
        startObjectId: 0,
        deltaGroupId: 1,
        deltaObjectId: 0,
      });

      expect(() => calc.timeForLocation(0, 0)).toThrow(TimelineTemplateError);
    });
  });

  describe('factory functions', () => {
    it('should create video template for 30fps', () => {
      const calc = createVideoTemplate(0, 30, 90000);

      // 30fps = 3000 timescale units per frame at 90kHz
      expect(calc.locationForTime(0)).toEqual([0, 0]);
      expect(calc.locationForTime(3000)).toEqual([0, 1]);
      expect(calc.locationForTime(90000)).toEqual([0, 30]); // 30 frames
    });

    it('should create audio template', () => {
      // 48kHz audio with 960 samples per frame (20ms frames)
      const calc = createAudioTemplate(0, 48000, 960);

      // Each frame is 960 samples
      expect(calc.locationForTime(0)).toEqual([0, 0]);
      expect(calc.locationForTime(960)).toEqual([0, 1]);
      expect(calc.locationForTime(960 * 50)).toEqual([0, 50]);
    });
  });

  describe('point generation', () => {
    it('should generate timeline points', () => {
      const calc = new MediaTimelineCalculator({
        startMediaTime: 0,
        deltaMediaTime: 1000,
        startGroupId: 0,
        startObjectId: 0,
        deltaGroupId: 0,
        deltaObjectId: 1,
        startWallclock: 1700000000000,
        deltaWallclock: 33,
      });

      const points = calc.generatePoints(0, 3);

      expect(points).toHaveLength(3);
      expect(points[0]).toEqual({
        mediaPTS: 0,
        groupId: 0,
        objectId: 0,
        wallclockTime: 1700000000000,
      });
      expect(points[1]).toEqual({
        mediaPTS: 1000,
        groupId: 0,
        objectId: 1,
        wallclockTime: 1700000000033,
      });
      expect(points[2]).toEqual({
        mediaPTS: 2000,
        groupId: 0,
        objectId: 2,
        wallclockTime: 1700000000066,
      });
    });

    it('should omit wallclock when deltaWallclock is 0', () => {
      const calc = new MediaTimelineCalculator({
        startMediaTime: 0,
        deltaMediaTime: 1000,
        startGroupId: 0,
        startObjectId: 0,
        deltaGroupId: 0,
        deltaObjectId: 1,
      });

      const points = calc.generatePoints(0, 2);

      expect(points[0].wallclockTime).toBeUndefined();
      expect(points[1].wallclockTime).toBeUndefined();
    });
  });
});
