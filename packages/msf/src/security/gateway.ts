// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MSF ↔ secure-objects publish/subscribe boundary.
 *
 * `MsfSecurityGateway` is a small facade over
 * {@link @moq-web/secure-objects#SecureObjectsContext} that MSF-aware
 * publishers/subscribers can hang off their per-track object handlers.
 *
 * Responsibilities:
 *  - Turn an outbound payload into a `SecureObjectsContext` encrypt() call,
 *    accepting caller-provided "encrypted properties" that will be shipped in
 *    the Type-0xA (`ENCRYPTED_PROPERTIES`) MOQT private-header extension.
 *  - Reverse the flow on inbound: strip the ciphertext, return the plaintext
 *    plus any properties recovered from the extension.
 *
 * The transport layer (raw MOQT stream framing + extension wire format) is
 * intentionally left to the caller; this module owns the crypto boundary
 * only. That keeps the MSF package free of a hard dependency on any specific
 * moqt object-header codec while still fulfilling §3's requirement that
 * subscribers decrypt payloads before further processing.
 */

import {
  SecureObjectsContext,
  PropertyType,
  type EncryptedObject,
  type ObjectIdentifier,
} from '@moq-web/secure-objects';
import type { Track } from '../schemas/index.js';
import {
  createTrackContext,
  isSecureObjectsTrack,
  TrackSecurityError,
  type CreateTrackContextOptions,
} from './track-secure-context.js';

/**
 * Header extension carrying Type-0xA `ENCRYPTED_PROPERTIES` payload.
 * Consumers of this module are responsible for serialising / deserialising
 * this alongside the other MOQT object headers.
 */
export interface EncryptedPropertiesExtension {
  /** MOQT header extension type id — always `PropertyType.ENCRYPTED_PROPERTIES`. */
  id: typeof PropertyType.ENCRYPTED_PROPERTIES;
  /** Opaque bytes that were sealed alongside the payload. */
  data: Uint8Array;
}

export const ENCRYPTED_PROPERTIES_EXTENSION_ID =
  PropertyType.ENCRYPTED_PROPERTIES;

/**
 * Result of {@link MsfSecurityGateway.sealForPublish}.
 */
export interface SealedObject {
  /** Ciphertext (including AEAD tag) to place in the MOQT Object payload. */
  ciphertext: Uint8Array;
  /** Key id that was used, for `KEY_ID` (Type-0x02) header extension. */
  keyId: bigint;
  /** Cipher-suite number (secure-objects enum). */
  cipherSuite: EncryptedObject['cipherSuite'];
  /**
   * When the caller supplied `encryptedProperties`, they were embedded into
   * the sealed payload; this extension is returned so the caller can attach
   * a Type-0xA MOQT header extension on the wire.
   */
  encryptedPropertiesExtension?: EncryptedPropertiesExtension;
}

/**
 * Result of {@link MsfSecurityGateway.openFromSubscribe}.
 */
export interface OpenedObject {
  /** Recovered application payload. */
  plaintext: Uint8Array;
  /**
   * Encrypted properties that had been sealed alongside the payload. Only
   * populated when they were sealed on the publish side.
   */
  encryptedProperties?: Uint8Array;
}

/**
 * MSF publish/subscribe security gateway for a single track.
 *
 * Instantiate one per subscribed / published track that has
 * `encryptionScheme = "moq-secure-objects"`. Callers should share a single
 * gateway across all objects of the track — reusing the underlying
 * {@link SecureObjectsContext} preserves the nonce-reuse guardrails.
 */
export class MsfSecurityGateway {
  constructor(private readonly ctx: SecureObjectsContext) {}

  /**
   * Build a gateway for a catalog track. Convenience wrapper around
   * {@link createTrackContext}.
   */
  static async forTrack(
    track: Track,
    opts: CreateTrackContextOptions
  ): Promise<MsfSecurityGateway> {
    const ctx = await createTrackContext(track, opts);
    return new MsfSecurityGateway(ctx);
  }

  /**
   * Encrypt a payload before sending it as a MOQT Object.
   */
  async sealForPublish(
    plaintext: Uint8Array,
    location: ObjectIdentifier,
    encryptedProperties?: Uint8Array
  ): Promise<SealedObject> {
    const sealed = await this.ctx.encrypt(plaintext, location, encryptedProperties);
    const out: SealedObject = {
      ciphertext: sealed.ciphertext,
      keyId: sealed.keyId,
      cipherSuite: sealed.cipherSuite,
    };
    if (encryptedProperties && encryptedProperties.length > 0) {
      out.encryptedPropertiesExtension = {
        id: PropertyType.ENCRYPTED_PROPERTIES,
        data: encryptedProperties,
      };
    }
    return out;
  }

  /**
   * Decrypt a MOQT Object payload just received on a subscription.
   */
  async openFromSubscribe(
    ciphertext: Uint8Array,
    location: ObjectIdentifier
  ): Promise<OpenedObject> {
    const opened = await this.ctx.decrypt(ciphertext, location);
    return {
      plaintext: opened.plaintext,
      encryptedProperties: opened.encryptedProperties,
    };
  }

  /**
   * Expose the underlying secure-objects context (advanced callers).
   */
  get context(): SecureObjectsContext {
    return this.ctx;
  }
}

/**
 * Convenience predicate: does the given track require gateway wrapping?
 */
export function trackRequiresGateway(track: Track): boolean {
  return isSecureObjectsTrack(track);
}

export { TrackSecurityError };
