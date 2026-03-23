// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MSF URL parser and generator (PR #87)
 *
 * Parses and generates MSF URLs for track references.
 * Format: https://host/path#namespace-elements--trackName
 */

import {
  encodeTrackReference,
  decodeTrackReference,
  encodeNamespace,
  type TrackReference,
} from './encoder.js';

/**
 * Error thrown when URL parsing fails
 */
export class MsfUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MsfUrlError';
  }
}

/**
 * Parsed MSF URL components
 */
export interface MsfUrl {
  /** Base URL without fragment */
  baseUrl: string;
  /** MOQT relay URL (scheme://host/path) */
  relayUrl: string;
  /** Track namespace */
  namespace: string[];
  /** Track name */
  trackName: string;
}

/**
 * Parse an MSF URL
 *
 * @param url - Full URL string
 * @returns Parsed URL components
 * @throws {MsfUrlError} If URL is invalid
 */
export function parseMsfUrl(url: string): MsfUrl {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MsfUrlError('Invalid URL format');
  }

  const fragment = parsed.hash;
  if (!fragment || fragment === '#') {
    throw new MsfUrlError('URL must have a fragment with track reference');
  }

  // Remove the # prefix
  const trackRef = decodeTrackReference(fragment.substring(1));

  // Construct base URL (without fragment)
  const baseUrl = url.split('#')[0];

  // Relay URL is the base URL
  const relayUrl = baseUrl;

  return {
    baseUrl,
    relayUrl,
    namespace: trackRef.namespace,
    trackName: trackRef.trackName,
  };
}

/**
 * Generate an MSF URL
 *
 * @param relayUrl - Base relay URL
 * @param namespace - Track namespace
 * @param trackName - Track name
 * @returns Full MSF URL
 */
export function generateMsfUrl(
  relayUrl: string,
  namespace: string[],
  trackName: string
): string {
  // Ensure relay URL doesn't have a fragment
  const baseUrl = relayUrl.split('#')[0];
  const fragment = encodeTrackReference(namespace, trackName);
  return `${baseUrl}#${fragment}`;
}

/**
 * Generate a catalog URL for a given namespace
 *
 * @param relayUrl - Base relay URL
 * @param namespace - Session namespace
 * @returns URL for the catalog track
 */
export function generateCatalogUrl(relayUrl: string, namespace: string[]): string {
  return generateMsfUrl(relayUrl, namespace, 'catalog');
}

/**
 * Extract just the track reference from a URL
 *
 * @param url - Full URL or just fragment
 * @returns Track reference
 */
export function extractTrackReference(url: string): TrackReference {
  // If it starts with http, parse as full URL
  if (url.startsWith('http')) {
    const parsed = parseMsfUrl(url);
    return {
      namespace: parsed.namespace,
      trackName: parsed.trackName,
    };
  }

  // Otherwise, treat as fragment (with or without #)
  const fragment = url.startsWith('#') ? url.substring(1) : url;
  return decodeTrackReference(fragment);
}

/**
 * Build a URL fragment from namespace and track name
 *
 * @param namespace - Track namespace
 * @param trackName - Track name
 * @returns URL fragment (without #)
 */
export function buildFragment(namespace: string[], trackName: string): string {
  return encodeTrackReference(namespace, trackName);
}

/**
 * Build a namespace-only fragment (no track name)
 *
 * @param namespace - Namespace elements
 * @returns URL fragment (without #)
 */
export function buildNamespaceFragment(namespace: string[]): string {
  return encodeNamespace(namespace);
}
