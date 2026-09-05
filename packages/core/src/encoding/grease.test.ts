// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Unit tests for the draft-18 §14 grease helpers.
 *
 * §14 reserves values matching `0x7f * N + 0x9D` for grease and mandates that
 * receivers MUST treat unknown values in the four error-code registries as
 * INTERNAL_ERROR. `grease.ts` exposes a recogniser and four normalizers.
 */

import { describe, it, expect } from 'vitest';
import {
  isGreaseCode,
  normalizeRequestErrorCode,
  normalizePublishDoneErrorCode,
  normalizeSessionErrorCode,
  normalizeStreamResetErrorCode,
} from './grease.js';
import {
  PublishDoneErrorCodeDraft18,
  RequestErrorCodeDraft18,
  SessionErrorCodeDraft18,
  StreamResetErrorCodeDraft18,
} from '../messages/types.js';

describe('draft-18 §14 grease codepoint recognition', () => {
  it('recognises the base grease values 0x9D, 0x11C, 0x19B', () => {
    // 0x7f * 0 + 0x9d = 0x9d
    expect(isGreaseCode(0x9d)).toBe(true);
    // 0x7f * 1 + 0x9d = 0x11c
    expect(isGreaseCode(0x11c)).toBe(true);
    // 0x7f * 2 + 0x9d = 0x19b
    expect(isGreaseCode(0x19b)).toBe(true);
    // 0x7f * 3 + 0x9d = 0x21a
    expect(isGreaseCode(0x21a)).toBe(true);
  });

  it('rejects non-grease values including nearby off-by-ones', () => {
    expect(isGreaseCode(0)).toBe(false);
    expect(isGreaseCode(1)).toBe(false);
    expect(isGreaseCode(0x9c)).toBe(false);
    expect(isGreaseCode(0x9e)).toBe(false);
    // 0x100 is not on the arithmetic progression.
    expect(isGreaseCode(0x100)).toBe(false);
    // Common enum members must not accidentally be treated as grease.
    expect(isGreaseCode(RequestErrorCodeDraft18.INTERNAL_ERROR)).toBe(false);
    expect(isGreaseCode(SessionErrorCodeDraft18.PROTOCOL_VIOLATION)).toBe(false);
  });

  it('handles bigint inputs for large grease values', () => {
    // The largest grease value in §14 is 0x3fffffffffffffde.
    const largest = 0x3fffffffffffffden;
    expect(isGreaseCode(largest)).toBe(true);
    // Off by one on the bigint side.
    expect(isGreaseCode(largest + 1n)).toBe(false);
    expect(isGreaseCode(0n)).toBe(false);
  });

  it('rejects negative and fractional numbers', () => {
    expect(isGreaseCode(-1)).toBe(false);
    expect(isGreaseCode(0.5)).toBe(false);
    expect(isGreaseCode(Number.NaN)).toBe(false);
  });
});

describe('draft-18 §14 error-code normalizers', () => {
  it('normalizeRequestErrorCode: passes known members through', () => {
    expect(normalizeRequestErrorCode(RequestErrorCodeDraft18.UNAUTHORIZED))
      .toBe(RequestErrorCodeDraft18.UNAUTHORIZED);
    expect(normalizeRequestErrorCode(RequestErrorCodeDraft18.REDIRECT))
      .toBe(RequestErrorCodeDraft18.REDIRECT);
  });

  it('normalizeRequestErrorCode: maps unknown / grease codes to INTERNAL_ERROR', () => {
    expect(normalizeRequestErrorCode(0x9d)).toBe(RequestErrorCodeDraft18.INTERNAL_ERROR);
    expect(normalizeRequestErrorCode(0x11c)).toBe(RequestErrorCodeDraft18.INTERNAL_ERROR);
    // An unregistered non-grease code — still unknown.
    expect(normalizeRequestErrorCode(0x7f)).toBe(RequestErrorCodeDraft18.INTERNAL_ERROR);
  });

  it('normalizePublishDoneErrorCode: passes known, maps unknown to INTERNAL_ERROR', () => {
    expect(normalizePublishDoneErrorCode(PublishDoneErrorCodeDraft18.TRACK_ENDED))
      .toBe(PublishDoneErrorCodeDraft18.TRACK_ENDED);
    expect(normalizePublishDoneErrorCode(0x9d))
      .toBe(PublishDoneErrorCodeDraft18.INTERNAL_ERROR);
    expect(normalizePublishDoneErrorCode(0xffff))
      .toBe(PublishDoneErrorCodeDraft18.INTERNAL_ERROR);
  });

  it('normalizeSessionErrorCode: passes known, maps unknown to INTERNAL_ERROR', () => {
    expect(normalizeSessionErrorCode(SessionErrorCodeDraft18.PROTOCOL_VIOLATION))
      .toBe(SessionErrorCodeDraft18.PROTOCOL_VIOLATION);
    expect(normalizeSessionErrorCode(0x9d))
      .toBe(SessionErrorCodeDraft18.INTERNAL_ERROR);
    // NO_ERROR (0x0) is a legitimate defined member.
    expect(normalizeSessionErrorCode(SessionErrorCodeDraft18.NO_ERROR))
      .toBe(SessionErrorCodeDraft18.NO_ERROR);
  });

  it('normalizeStreamResetErrorCode: passes known, maps unknown to INTERNAL_ERROR', () => {
    expect(normalizeStreamResetErrorCode(StreamResetErrorCodeDraft18.CANCELLED))
      .toBe(StreamResetErrorCodeDraft18.CANCELLED);
    expect(normalizeStreamResetErrorCode(0x9d))
      .toBe(StreamResetErrorCodeDraft18.INTERNAL_ERROR);
    // A gap in the enum (0x8 is between EXPIRED_AUTH_TOKEN=0x7 and
    // EXCESSIVE_LOAD=0x9) — currently unassigned, so treat as INTERNAL_ERROR.
    expect(normalizeStreamResetErrorCode(0x8))
      .toBe(StreamResetErrorCodeDraft18.INTERNAL_ERROR);
  });
});
