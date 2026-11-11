// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Protocol violations by kind, and the Session Termination Code each draft
 * closes with.
 *
 * Codecs and the data plane say *what* went wrong (a Violation); the session
 * picks the code for its draft. Draft-23 (§12.2) has a code per kind; earlier
 * drafts close with PROTOCOL_VIOLATION for nearly all of them. This keeps
 * draft-specific error codes out of the codecs.
 */

import { isDraftAtLeast, type DraftVersion } from '../version/constants.js';
import { SessionErrorCodeDraft18, SessionErrorCodeDraft23 } from '../messages/types.js';

export type Violation =
  /** No more specific kind applies */
  | 'protocol-violation'
  /** A control message cannot be parsed or misses a required element */
  | 'malformed-message'
  /** A control message field has a value that is not allowed */
  | 'invalid-field'
  /** A Track Namespace breaks §8.7 */
  | 'invalid-track-namespace'
  /** Unknown message type, or a message on the wrong stream, order or count */
  | 'unexpected-message'
  /** A message or field not allowed for the sender's role */
  | 'role-violation'
  /** A Message Parameter is unknown, duplicated, out of scope or out of range */
  | 'invalid-parameter'
  /** A Key-Value-Pair value does not match its type's definition */
  | 'malformed-key-value'
  /** A delta-decoded value is below 0 or above 2^64-1 */
  | 'delta-overflow'
  /** A field or structure is longer than its maximum */
  | 'field-length'
  /** A data stream or datagram has an unknown type or invalid Type Flags */
  | 'invalid-stream-header'
  /** An Object's serialization cannot be decoded */
  | 'malformed-object'
  /** An Object has an invalid status, or Properties with a non-Normal status */
  | 'invalid-object-status'
  /** A data stream ended with a FIN inside an Object */
  | 'truncated-object'
  /** The peer closed the control stream */
  | 'closed-control-stream';

const DRAFT23_CODES: Record<Violation, SessionErrorCodeDraft23> = {
  'protocol-violation': SessionErrorCodeDraft23.PROTOCOL_VIOLATION,
  'malformed-message': SessionErrorCodeDraft23.MALFORMED_MESSAGE,
  'invalid-field': SessionErrorCodeDraft23.INVALID_FIELD,
  'invalid-track-namespace': SessionErrorCodeDraft23.INVALID_TRACK_NAMESPACE,
  'unexpected-message': SessionErrorCodeDraft23.UNEXPECTED_MESSAGE,
  'role-violation': SessionErrorCodeDraft23.ROLE_VIOLATION,
  'invalid-parameter': SessionErrorCodeDraft23.INVALID_PARAMETER,
  'malformed-key-value': SessionErrorCodeDraft23.MALFORMED_KEY_VALUE,
  'delta-overflow': SessionErrorCodeDraft23.DELTA_ENCODING_OVERFLOW,
  'field-length': SessionErrorCodeDraft23.FIELD_LENGTH_EXCEEDED,
  'invalid-stream-header': SessionErrorCodeDraft23.INVALID_STREAM_HEADER,
  'malformed-object': SessionErrorCodeDraft23.MALFORMED_OBJECT,
  'invalid-object-status': SessionErrorCodeDraft23.INVALID_OBJECT_STATUS,
  'truncated-object': SessionErrorCodeDraft23.TRUNCATED_OBJECT,
  'closed-control-stream': SessionErrorCodeDraft23.CLOSED_CONTROL_STREAM,
};

/**
 * The Session Termination Code `draft` closes with for `violation`. Before
 * draft-23 only a formatting error in a Key-Value-Pair had its own code
 * (KEY_VALUE_FORMATTING_ERROR, the same value as MALFORMED_KEY_VALUE).
 */
export function terminationCodeFor(violation: Violation, draft: DraftVersion): number {
  if (isDraftAtLeast(draft, 23)) {
    return DRAFT23_CODES[violation];
  }

  return violation === 'malformed-key-value'
    ? SessionErrorCodeDraft18.KEY_VALUE_FORMATTING_ERROR
    : SessionErrorCodeDraft18.PROTOCOL_VIOLATION;
}

/** Codec error tags that imply a kind when the thrower set none */
const TAG_VIOLATIONS: Readonly<Record<string, Violation>> = {
  malformed: 'malformed-message',
  'bounds-exceeded': 'field-length',
  // A Token structure that does not parse (AUTH_TOKEN_FORMAT_ERROR, §8.9)
  'key-value-formatting-error': 'malformed-key-value',
};

/**
 * The kind of violation `err` reports: its own `violation` if set, else one
 * implied by its codec tag. Undefined for errors that are not violations.
 */
export function violationOf(err: unknown): Violation | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const { violation, code } = err as { violation?: Violation; code?: unknown };
  if (violation) {
    return violation;
  }

  return typeof code === 'string' ? TAG_VIOLATIONS[code] : undefined;
}
