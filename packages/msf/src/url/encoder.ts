// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Namespace encoding for MSF URLs (PR #87)
 *
 * Handles encoding/decoding of namespace elements and track names in URLs.
 * Uses period-encoding for hyphens: hyphen (-) encoded as .2d
 *
 * Format: namespace-elements--trackName
 * Example: conference-room.2d123--video-main
 *   namespace: ['conference', 'room-123']
 *   trackName: 'video-main'
 */

/**
 * Error thrown when URL encoding/decoding fails
 */
export class NamespaceEncoderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NamespaceEncoderError';
  }
}

/**
 * Encode a string for use in MSF URL fragments
 * Hyphens are encoded as .2d to avoid confusion with separators
 */
export function encodeElement(element: string): string {
  // Encode hyphens as .2d
  let encoded = element.replace(/-/g, '.2d');
  // Encode periods (that aren't part of .2d) as .2e
  // We need to be careful not to double-encode
  encoded = encoded.replace(/\.(?!2[de])/g, '.2e');
  return encoded;
}

/**
 * Decode a string from MSF URL fragment encoding
 */
export function decodeElement(encoded: string): string {
  // Decode .2d back to hyphen
  let decoded = encoded.replace(/\.2d/g, '-');
  // Decode .2e back to period
  decoded = decoded.replace(/\.2e/g, '.');
  return decoded;
}

/**
 * Encode a namespace array to URL fragment format
 * Elements are joined with hyphens
 *
 * @param namespace - Array of namespace elements
 * @returns Encoded namespace string
 */
export function encodeNamespace(namespace: string[]): string {
  if (namespace.length === 0) {
    return '';
  }
  return namespace.map(encodeElement).join('-');
}

/**
 * Decode a URL fragment to namespace array
 *
 * @param encoded - Encoded namespace string
 * @returns Array of namespace elements
 */
export function decodeNamespace(encoded: string): string[] {
  if (encoded === '') {
    return [];
  }

  // Split on hyphens that aren't encoded (not preceded by a period)
  // This regex splits on hyphens that are not part of .2d encoding
  const elements: string[] = [];
  let current = '';
  let i = 0;

  while (i < encoded.length) {
    if (encoded[i] === '-') {
      // Check if this hyphen is a separator or encoded
      if (current.endsWith('.2')) {
        // This is the 'd' of .2d, so include it
        current += encoded[i];
      } else {
        // This is a separator
        elements.push(decodeElement(current));
        current = '';
      }
    } else {
      current += encoded[i];
    }
    i++;
  }

  // Don't forget the last element
  if (current) {
    elements.push(decodeElement(current));
  }

  return elements;
}

/**
 * Encode a full track reference (namespace + track name)
 * Format: namespace-elements--trackName
 *
 * @param namespace - Array of namespace elements
 * @param trackName - Track name
 * @returns Encoded fragment string
 */
export function encodeTrackReference(namespace: string[], trackName: string): string {
  const encodedNamespace = encodeNamespace(namespace);
  const encodedTrack = encodeElement(trackName);

  if (encodedNamespace === '') {
    return encodedTrack;
  }

  return `${encodedNamespace}--${encodedTrack}`;
}

/**
 * Decoded track reference
 */
export interface TrackReference {
  namespace: string[];
  trackName: string;
}

/**
 * Decode a full track reference from URL fragment
 *
 * @param encoded - Encoded fragment string
 * @returns Decoded namespace and track name
 */
export function decodeTrackReference(encoded: string): TrackReference {
  // Split on double-hyphen (--) which separates namespace from track name
  const doubleHyphenIndex = encoded.indexOf('--');

  if (doubleHyphenIndex === -1) {
    // No namespace, just track name
    return {
      namespace: [],
      trackName: decodeElement(encoded),
    };
  }

  const namespaceEncoded = encoded.substring(0, doubleHyphenIndex);
  const trackEncoded = encoded.substring(doubleHyphenIndex + 2);

  return {
    namespace: decodeNamespace(namespaceEncoded),
    trackName: decodeElement(trackEncoded),
  };
}
