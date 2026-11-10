// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §14 — Grease / reserved codepoints.
 *
 * The spec reserves values matching `0x7f * N + 0x9D` (0x9D, 0x11C, 0x19B, ...)
 * across seven registries so that peers can advertise unknown values without
 * negotiation, exercising the "MUST ignore unknown" paths in receivers.
 *
 * Normative receiver rules (§14):
 *   - Unknown Setup Options: skip via length field.
 *   - Unknown Properties: skip via length field.
 *   - Unknown error codes in Session Termination / REQUEST_ERROR / PUBLISH_DONE
 *     / Stream Reset: MUST be treated as INTERNAL_ERROR for that registry.
 *
 * `isGreaseCode(n)` recognises the reserved pattern for logging/audit tools.
 * `normalize<Registry>ErrorCode(code)` maps any unknown code (grease or not)
 * to that registry's INTERNAL_ERROR so callers see stable enum values.
 *
 * §14 itself does not mandate that senders emit grease. This module is a
 * receiver-side compliance primitive; sending grease from tests exercises
 * peer tolerance.
 */

import {
  PublishDoneErrorCodeDraft18,
  RequestErrorCodeDraft18,
  SessionErrorCodeDraft18,
  StreamResetErrorCodeDraft18,
  RequestErrorCodeDraft22,
  SessionErrorCodeDraft22,
  PublishDoneErrorCodeDraft22,
  RequestErrorCodeDraft23,
  SessionErrorCodeDraft23,
  PublishDoneErrorCodeDraft23,
  StreamResetErrorCodeDraft23,
} from '../messages/types.js';

const GREASE_MULTIPLIER = 0x7f;
const GREASE_OFFSET = 0x9d;

/**
 * Returns true if `code` matches the draft-18 §14 grease pattern
 * `0x7f * N + 0x9D` for some non-negative integer N.
 *
 * Accepts `number` for small codes and `bigint` for values that exceed
 * JS Number's safe integer range (grease values go up to
 * 0x3fffffffffffffde per §14).
 */
export function isGreaseCode(code: number | bigint): boolean {
  if (typeof code === 'bigint') {
    if (code < BigInt(GREASE_OFFSET)) return false;
    return (code - BigInt(GREASE_OFFSET)) % BigInt(GREASE_MULTIPLIER) === 0n;
  }
  if (!Number.isInteger(code) || code < GREASE_OFFSET) return false;
  return (code - GREASE_OFFSET) % GREASE_MULTIPLIER === 0;
}

function isKnownEnumValue(enumObj: Record<string, string | number>, code: number): boolean {
  // TS enums produce reverse mappings for numeric members, so we can look up
  // the code as a string key. Filter out the reverse mapping name entries by
  // checking that the value at the numeric key is a string (the enum member
  // name) — that means the numeric member exists.
  return typeof enumObj[code as unknown as string] === 'string';
}

/**
 * Draft-18 §14: any unknown REQUEST_ERROR code MUST be treated as
 * INTERNAL_ERROR for the request-error context. Returns the input untouched
 * when it matches a defined member.
 */
export function normalizeRequestErrorCode(code: number): RequestErrorCodeDraft18 {
  return isKnownEnumValue(RequestErrorCodeDraft18 as unknown as Record<string, string | number>, code)
    ? (code as RequestErrorCodeDraft18)
    : RequestErrorCodeDraft18.INTERNAL_ERROR;
}

/**
 * Draft-18 §14: any unknown PUBLISH_DONE status code MUST be treated as
 * INTERNAL_ERROR for the publish-done context.
 */
export function normalizePublishDoneErrorCode(code: number): PublishDoneErrorCodeDraft18 {
  return isKnownEnumValue(PublishDoneErrorCodeDraft18 as unknown as Record<string, string | number>, code)
    ? (code as PublishDoneErrorCodeDraft18)
    : PublishDoneErrorCodeDraft18.INTERNAL_ERROR;
}

/**
 * Draft-18 §14: any unknown Session Termination code MUST be treated as
 * INTERNAL_ERROR for the session-termination context.
 */
export function normalizeSessionErrorCode(code: number): SessionErrorCodeDraft18 {
  return isKnownEnumValue(SessionErrorCodeDraft18 as unknown as Record<string, string | number>, code)
    ? (code as SessionErrorCodeDraft18)
    : SessionErrorCodeDraft18.INTERNAL_ERROR;
}

/**
 * Draft-18 §14: any unknown Data Stream Reset code MUST be treated as
 * INTERNAL_ERROR for the stream-reset context.
 */
export function normalizeStreamResetErrorCode(code: number): StreamResetErrorCodeDraft18 {
  return isKnownEnumValue(StreamResetErrorCodeDraft18 as unknown as Record<string, string | number>, code)
    ? (code as StreamResetErrorCodeDraft18)
    : StreamResetErrorCodeDraft18.INTERNAL_ERROR;
}

// =============================================================================
// Draft-22 Normalizers
// =============================================================================
// Draft-22 adds CONFLICTING_FILTERS (0x35), INVALID_FILTER (0x36) to REQUEST_ERROR
// and TOO_MANY_REQUEST_UPDATES (0x1B) to Session Termination.
// PUBLISH_DONE codes are the same but with SUBSCRIPTION_ENDED removed.

export function normalizeRequestErrorCodeDraft22(code: number): number {
  return isKnownEnumValue(RequestErrorCodeDraft22 as unknown as Record<string, string | number>, code)
    ? code
    : RequestErrorCodeDraft22.INTERNAL_ERROR;
}

export function normalizeSessionErrorCodeDraft22(code: number): number {
  return isKnownEnumValue(SessionErrorCodeDraft22 as unknown as Record<string, string | number>, code)
    ? code
    : SessionErrorCodeDraft22.INTERNAL_ERROR;
}

export function normalizePublishDoneErrorCodeDraft22(code: number): number {
  return isKnownEnumValue(PublishDoneErrorCodeDraft22 as unknown as Record<string, string | number>, code)
    ? code
    : PublishDoneErrorCodeDraft22.INTERNAL_ERROR;
}

// =============================================================================
// Draft-23 Normalizers
// =============================================================================

// Draft-23 adds UNAVAILABLE and drops PREFIX_OVERLAP from REQUEST_ERROR, adds
// EXPIRED_AUTH_TOKEN to PUBLISH_DONE, drops UNKNOWN_OBJECT_STATUS from stream
// resets, and adds the categorised session codes 0x200-0x4FF.

/** §12.2: 0x200-0x4FF are grouped by category; an unknown code there keeps its category */
const SESSION_CATEGORY_START = 0x200;
const SESSION_CATEGORY_END = 0x4ff;

export function normalizeRequestErrorCodeDraft23(code: number): number {
  return isKnownEnumValue(RequestErrorCodeDraft23 as unknown as Record<string, string | number>, code)
    ? code
    : RequestErrorCodeDraft23.INTERNAL_ERROR;
}

/**
 * Unknown codes become INTERNAL_ERROR, except non-grease codes in a §12.2
 * category range, which are kept so the receiver can read their category.
 */
export function normalizeSessionErrorCodeDraft23(code: number): number {
  if (isKnownEnumValue(SessionErrorCodeDraft23 as unknown as Record<string, string | number>, code)) {
    return code;
  }
  const inCategory = code >= SESSION_CATEGORY_START && code <= SESSION_CATEGORY_END;

  return inCategory && !isGreaseCode(code) ? code : SessionErrorCodeDraft23.INTERNAL_ERROR;
}

export function normalizePublishDoneErrorCodeDraft23(code: number): number {
  return isKnownEnumValue(PublishDoneErrorCodeDraft23 as unknown as Record<string, string | number>, code)
    ? code
    : PublishDoneErrorCodeDraft23.INTERNAL_ERROR;
}

export function normalizeStreamResetErrorCodeDraft23(code: number): number {
  return isKnownEnumValue(StreamResetErrorCodeDraft23 as unknown as Record<string, string | number>, code)
    ? code
    : StreamResetErrorCodeDraft23.INTERNAL_ERROR;
}
