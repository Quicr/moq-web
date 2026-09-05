// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Prior Group ID Gap object-header extension (MSF §10).
 *
 * When a publisher restarts, MSF §10 requires the first Object of the first
 * new Group to carry a Prior Group ID Gap extension header conveying the
 * highest Group ID published before the restart. Subscribers use this to
 * detect the discontinuity and re-fetch the catalog.
 *
 * This module deals only with:
 *   - persisting the last-published Group ID across restarts
 *   - producing/parsing the extension value bytes
 *
 * Attaching the extension to actual MOQT Object headers is the transport
 * layer's job; consumers pass the emitted bytes into `session`'s object
 * extension map keyed by {@link PRIOR_GROUP_ID_GAP_EXTENSION_ID}.
 */

/**
 * Object header extension type-ID reserved by MSF §10 for the
 * "Prior Group ID Gap" extension.
 *
 * The MSF spec assigns this in Table 5 (Object Header Extensions).
 */
export const PRIOR_GROUP_ID_GAP_EXTENSION_ID = 0x20 as const;

/**
 * Encode a Prior Group ID as a QUIC varint (u62).
 *
 * MOQT variable-length integers use the two most-significant bits of the
 * first byte to select 1/2/4/8-byte encodings, per RFC 9000 §16.
 */
export function encodePriorGroupIdGap(priorGroupId: number | bigint): Uint8Array {
  const v = typeof priorGroupId === 'bigint' ? priorGroupId : BigInt(priorGroupId);
  if (v < 0n) {
    throw new RangeError('priorGroupId must be non-negative');
  }

  if (v < 0x40n) {
    // 6-bit value, 1-byte encoding (prefix 00)
    return new Uint8Array([Number(v)]);
  }
  if (v < 0x4000n) {
    // 14-bit value, 2-byte encoding (prefix 01)
    const buf = new Uint8Array(2);
    const n = Number(v);
    buf[0] = 0x40 | ((n >> 8) & 0x3f);
    buf[1] = n & 0xff;
    return buf;
  }
  if (v < 0x40000000n) {
    // 30-bit value, 4-byte encoding (prefix 10)
    const buf = new Uint8Array(4);
    const n = Number(v);
    buf[0] = 0x80 | ((n >>> 24) & 0x3f);
    buf[1] = (n >>> 16) & 0xff;
    buf[2] = (n >>> 8) & 0xff;
    buf[3] = n & 0xff;
    return buf;
  }
  if (v < 0x4000000000000000n) {
    // 62-bit value, 8-byte encoding (prefix 11)
    const buf = new Uint8Array(8);
    const hi = Number(v >> 32n);
    const lo = Number(v & 0xffffffffn);
    buf[0] = 0xc0 | ((hi >>> 24) & 0x3f);
    buf[1] = (hi >>> 16) & 0xff;
    buf[2] = (hi >>> 8) & 0xff;
    buf[3] = hi & 0xff;
    buf[4] = (lo >>> 24) & 0xff;
    buf[5] = (lo >>> 16) & 0xff;
    buf[6] = (lo >>> 8) & 0xff;
    buf[7] = lo & 0xff;
    return buf;
  }
  throw new RangeError('priorGroupId exceeds QUIC varint range (2^62-1)');
}

/**
 * Decode a QUIC-varint-encoded Prior Group ID Gap extension payload.
 *
 * @returns bigint with the value, and the number of bytes consumed.
 */
export function decodePriorGroupIdGap(bytes: Uint8Array): {
  value: bigint;
  length: number;
} {
  if (bytes.length === 0) {
    throw new RangeError('empty priorGroupId extension payload');
  }
  const prefix = bytes[0] >> 6;
  const length = 1 << prefix;
  if (bytes.length < length) {
    throw new RangeError(
      `truncated varint: need ${length} bytes, have ${bytes.length}`
    );
  }
  let value = BigInt(bytes[0] & 0x3f);
  for (let i = 1; i < length; i++) {
    value = (value << 8n) | BigInt(bytes[i]);
  }
  return { value, length };
}

/**
 * Tracks the highest Group ID published on a track and emits the §10
 * Prior Group ID Gap extension after a restart.
 *
 * Callers persist and restore `lastGroupId` across process restarts
 * (typically via localStorage / IndexedDB in the browser or a KV store on
 * the publisher side). The first `nextGroup()` call after `restart()` sets
 * the next group ID strictly greater than the previously highest one and
 * flags that the first Object of that Group MUST carry the extension.
 */
export class GroupIdGapTracker {
  private _lastGroupId: bigint;
  private _pendingRestartFrom: bigint | null = null;

  constructor(lastPublishedGroupId?: number | bigint) {
    this._lastGroupId =
      lastPublishedGroupId === undefined
        ? -1n
        : typeof lastPublishedGroupId === 'bigint'
          ? lastPublishedGroupId
          : BigInt(lastPublishedGroupId);
  }

  /**
   * Latest Group ID that has been observed / recorded.
   */
  get lastGroupId(): bigint {
    return this._lastGroupId;
  }

  /**
   * Record that a group has been published so we can persist the value and
   * pick a strictly greater ID after a restart.
   */
  recordGroup(groupId: number | bigint): void {
    const v = typeof groupId === 'bigint' ? groupId : BigInt(groupId);
    if (v > this._lastGroupId) this._lastGroupId = v;
  }

  /**
   * Mark that a publisher restart has just happened. The next `nextGroup()`
   * call will emit the Prior Group ID Gap extension.
   */
  restart(): void {
    if (this._lastGroupId >= 0n) {
      this._pendingRestartFrom = this._lastGroupId;
    }
  }

  /**
   * Pick the next Group ID after a restart. If a restart is pending, this
   * returns the extension bytes to attach to the first Object of that group.
   */
  nextGroupAfterRestart(candidate: number | bigint): {
    groupId: bigint;
    extension?: { id: number; value: Uint8Array };
  } {
    const c = typeof candidate === 'bigint' ? candidate : BigInt(candidate);
    // §10: the new starting Group ID MUST be strictly greater than any
    // previously published Group ID.
    let groupId = c;
    if (groupId <= this._lastGroupId) groupId = this._lastGroupId + 1n;

    if (this._pendingRestartFrom !== null) {
      const extension = {
        id: PRIOR_GROUP_ID_GAP_EXTENSION_ID,
        value: encodePriorGroupIdGap(this._pendingRestartFrom),
      };
      this._pendingRestartFrom = null;
      this.recordGroup(groupId);
      return { groupId, extension };
    }

    this.recordGroup(groupId);
    return { groupId };
  }
}
