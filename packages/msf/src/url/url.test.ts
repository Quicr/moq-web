// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import {
  encodeElement,
  decodeElement,
  encodeNamespace,
  decodeNamespace,
  encodeTrackReference,
  decodeTrackReference,
} from './encoder.js';
import {
  parseMsfUrl,
  generateMsfUrl,
  generateCatalogUrl,
  extractTrackReference,
  buildFragment,
  MsfUrlError,
} from './parser.js';
import {
  parseFragmentVariables,
  serializeFragmentVariables,
  substituteVariables,
  substituteVariablesDeep,
  extractVariableNames,
  VariableSubstitutionError,
} from './variables.js';

describe('NamespaceEncoder', () => {
  describe('encodeElement/decodeElement', () => {
    it('should encode hyphens', () => {
      expect(encodeElement('room-123')).toBe('room.2d123');
    });

    it('should encode multiple hyphens', () => {
      expect(encodeElement('a-b-c')).toBe('a.2db.2dc');
    });

    it('should not change strings without special chars', () => {
      expect(encodeElement('simple')).toBe('simple');
    });

    it('should decode hyphens', () => {
      expect(decodeElement('room.2d123')).toBe('room-123');
    });

    it('should decode multiple hyphens', () => {
      expect(decodeElement('a.2db.2dc')).toBe('a-b-c');
    });

    it('should roundtrip encode/decode', () => {
      const original = 'test-name-with-hyphens';
      expect(decodeElement(encodeElement(original))).toBe(original);
    });
  });

  describe('encodeNamespace/decodeNamespace', () => {
    it('should encode simple namespace', () => {
      expect(encodeNamespace(['conference', 'room1'])).toBe('conference-room1');
    });

    it('should encode namespace with hyphens in elements', () => {
      expect(encodeNamespace(['conference', 'room-123'])).toBe('conference-room.2d123');
    });

    it('should decode simple namespace', () => {
      expect(decodeNamespace('conference-room1')).toEqual(['conference', 'room1']);
    });

    it('should decode namespace with encoded hyphens', () => {
      expect(decodeNamespace('conference-room.2d123')).toEqual(['conference', 'room-123']);
    });

    it('should handle empty namespace', () => {
      expect(encodeNamespace([])).toBe('');
      expect(decodeNamespace('')).toEqual([]);
    });

    it('should handle single element namespace', () => {
      expect(encodeNamespace(['single'])).toBe('single');
      expect(decodeNamespace('single')).toEqual(['single']);
    });

    it('should roundtrip complex namespace', () => {
      const original = ['org', 'team-alpha', 'project-x'];
      const encoded = encodeNamespace(original);
      expect(decodeNamespace(encoded)).toEqual(original);
    });
  });

  describe('encodeTrackReference/decodeTrackReference', () => {
    it('should encode track reference', () => {
      expect(encodeTrackReference(['conference', 'room1'], 'video-main'))
        .toBe('conference-room1--video.2dmain');
    });

    it('should encode track with empty namespace', () => {
      expect(encodeTrackReference([], 'video')).toBe('video');
    });

    it('should decode track reference', () => {
      const result = decodeTrackReference('conference-room1--video.2dmain');
      expect(result.namespace).toEqual(['conference', 'room1']);
      expect(result.trackName).toBe('video-main');
    });

    it('should decode track with no namespace', () => {
      const result = decodeTrackReference('video');
      expect(result.namespace).toEqual([]);
      expect(result.trackName).toBe('video');
    });

    it('should roundtrip track reference', () => {
      const namespace = ['conference', 'room-42'];
      const trackName = 'video-track-1';
      const encoded = encodeTrackReference(namespace, trackName);
      const decoded = decodeTrackReference(encoded);

      expect(decoded.namespace).toEqual(namespace);
      expect(decoded.trackName).toBe(trackName);
    });
  });
});

describe('MsfUrlParser', () => {
  describe('parseMsfUrl', () => {
    it('should parse MSF URL with namespace and track', () => {
      const url = 'https://relay.example.com/moq#conference-room1--video';
      const result = parseMsfUrl(url);

      expect(result.baseUrl).toBe('https://relay.example.com/moq');
      expect(result.relayUrl).toBe('https://relay.example.com/moq');
      expect(result.namespace).toEqual(['conference', 'room1']);
      expect(result.trackName).toBe('video');
    });

    it('should parse URL with encoded hyphens', () => {
      const url = 'https://relay.example.com/moq#conference-room.2d123--video.2dmain';
      const result = parseMsfUrl(url);

      expect(result.namespace).toEqual(['conference', 'room-123']);
      expect(result.trackName).toBe('video-main');
    });

    it('should throw on URL without fragment', () => {
      expect(() => parseMsfUrl('https://relay.example.com/moq')).toThrow(MsfUrlError);
    });

    it('should throw on invalid URL', () => {
      expect(() => parseMsfUrl('not a url')).toThrow(MsfUrlError);
    });
  });

  describe('generateMsfUrl', () => {
    it('should generate MSF URL', () => {
      const url = generateMsfUrl(
        'https://relay.example.com/moq',
        ['conference', 'room1'],
        'video'
      );

      expect(url).toBe('https://relay.example.com/moq#conference-room1--video');
    });

    it('should handle hyphens in names', () => {
      const url = generateMsfUrl(
        'https://relay.example.com/moq',
        ['room-1'],
        'video-main'
      );

      expect(url).toBe('https://relay.example.com/moq#room.2d1--video.2dmain');
    });

    it('should strip existing fragment from relay URL', () => {
      const url = generateMsfUrl(
        'https://relay.example.com/moq#existing',
        ['ns'],
        'track'
      );

      expect(url).toBe('https://relay.example.com/moq#ns--track');
    });
  });

  describe('generateCatalogUrl', () => {
    it('should generate catalog URL', () => {
      const url = generateCatalogUrl(
        'https://relay.example.com/moq',
        ['conference', 'room1']
      );

      expect(url).toBe('https://relay.example.com/moq#conference-room1--catalog');
    });
  });

  describe('extractTrackReference', () => {
    it('should extract from full URL', () => {
      const ref = extractTrackReference('https://relay.example.com/moq#ns--track');
      expect(ref.namespace).toEqual(['ns']);
      expect(ref.trackName).toBe('track');
    });

    it('should extract from fragment with hash', () => {
      const ref = extractTrackReference('#ns--track');
      expect(ref.namespace).toEqual(['ns']);
      expect(ref.trackName).toBe('track');
    });

    it('should extract from fragment without hash', () => {
      const ref = extractTrackReference('ns--track');
      expect(ref.namespace).toEqual(['ns']);
      expect(ref.trackName).toBe('track');
    });
  });

  describe('buildFragment', () => {
    it('should build fragment', () => {
      const fragment = buildFragment(['ns1', 'ns2'], 'track');
      expect(fragment).toBe('ns1-ns2--track');
    });
  });

  describe('roundtrip', () => {
    it('should roundtrip URL generation and parsing', () => {
      const namespace = ['org', 'team', 'project-x'];
      const trackName = 'video-720p';
      const relayUrl = 'https://relay.example.com/moq';

      const generated = generateMsfUrl(relayUrl, namespace, trackName);
      const parsed = parseMsfUrl(generated);

      expect(parsed.namespace).toEqual(namespace);
      expect(parsed.trackName).toBe(trackName);
      expect(parsed.relayUrl).toBe(relayUrl);
    });
  });
});

describe('Variable substitution (§8)', () => {
  describe('parseFragmentVariables', () => {
    it('parses simple k=v pairs', () => {
      expect(parseFragmentVariables('bitrate=1000&lang=en')).toEqual({
        bitrate: '1000',
        lang: 'en',
      });
    });

    it('accepts empty input', () => {
      expect(parseFragmentVariables('')).toEqual({});
    });

    it('accepts @ in values', () => {
      expect(parseFragmentVariables('user=alice@example')).toEqual({
        user: 'alice@example',
      });
    });

    it('rejects invalid names', () => {
      expect(() => parseFragmentVariables('bad name=1')).toThrow(
        VariableSubstitutionError
      );
      expect(() => parseFragmentVariables('bad%name=1')).toThrow();
    });

    it('rejects invalid values', () => {
      expect(() => parseFragmentVariables('k=has space')).toThrow(
        VariableSubstitutionError
      );
      expect(() => parseFragmentVariables('k=has/slash')).toThrow();
    });

    it("rejects '?' (reserved server-side)", () => {
      expect(() => parseFragmentVariables('k=v?extra=1')).toThrow(
        VariableSubstitutionError
      );
    });

    it('rejects duplicates', () => {
      expect(() => parseFragmentVariables('k=1&k=2')).toThrow(
        VariableSubstitutionError
      );
    });

    it('rejects missing "="', () => {
      expect(() => parseFragmentVariables('k')).toThrow(
        VariableSubstitutionError
      );
    });
  });

  describe('serializeFragmentVariables', () => {
    it('roundtrips', () => {
      const vars = { bitrate: '1000', lang: 'en' };
      expect(parseFragmentVariables(serializeFragmentVariables(vars))).toEqual(
        vars
      );
    });

    it('rejects invalid names/values', () => {
      expect(() => serializeFragmentVariables({ 'bad name': 'v' })).toThrow();
      expect(() => serializeFragmentVariables({ k: 'has space' })).toThrow();
    });
  });

  describe('substituteVariables', () => {
    it('substitutes tokens', () => {
      expect(
        substituteVariables('rate-%bitrate%-%lang%', {
          bitrate: '1000',
          lang: 'en',
        })
      ).toBe('rate-1000-en');
    });

    it('throws on unresolved by default', () => {
      expect(() =>
        substituteVariables('%missing%', { present: 'x' })
      ).toThrow(VariableSubstitutionError);
    });

    it('leaves unresolved when allowUnresolved=true', () => {
      expect(
        substituteVariables('%missing%', { present: 'x' }, {
          allowUnresolved: true,
        })
      ).toBe('%missing%');
    });

    it('leaves plain text alone', () => {
      expect(substituteVariables('no tokens here', {})).toBe('no tokens here');
    });
  });

  describe('substituteVariablesDeep', () => {
    it('walks nested objects and arrays', () => {
      const template = {
        codec: '%codec%',
        list: ['%a%', 'plain'],
        nested: { path: 'items/%id%' },
        n: 42,
      };
      const result = substituteVariablesDeep(template, {
        codec: 'avc1',
        a: 'first',
        id: '123',
      });
      expect(result).toEqual({
        codec: 'avc1',
        list: ['first', 'plain'],
        nested: { path: 'items/123' },
        n: 42,
      });
    });
  });

  describe('extractVariableNames', () => {
    it('collects unique names', () => {
      expect(extractVariableNames('%a%-%b%/%a%')).toEqual(['a', 'b']);
    });
  });

  describe('parseMsfUrl with variables', () => {
    it('parses trailing k=v pairs', () => {
      const url = 'https://relay.example/moq#room-1--video&bitrate=1000&lang=en';
      const parsed = parseMsfUrl(url);
      expect(parsed.namespace).toEqual(['room', '1']);
      expect(parsed.trackName).toBe('video');
      expect(parsed.variables).toEqual({
        bitrate: '1000',
        lang: 'en',
      });
    });

    it('defaults variables to empty', () => {
      const url = 'https://relay.example/moq#room--video';
      const parsed = parseMsfUrl(url);
      expect(parsed.variables).toEqual({});
    });
  });

  describe('generateMsfUrl with variables', () => {
    it('appends k=v pairs to the fragment', () => {
      const url = generateMsfUrl(
        'https://relay.example/moq',
        ['room'],
        'video',
        { bitrate: '1000', lang: 'en' }
      );
      expect(url).toBe(
        'https://relay.example/moq#room--video&bitrate=1000&lang=en'
      );
      const parsed = parseMsfUrl(url);
      expect(parsed.variables).toEqual({ bitrate: '1000', lang: 'en' });
    });
  });
});
