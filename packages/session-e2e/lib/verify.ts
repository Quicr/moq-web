// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface ReceivedObject {
  groupId: number;
  objectId: number;
  bytes: Uint8Array;
  timestamp: number;
}

/**
 * Wait until `count` objects have been received or `timeoutMs` elapses.
 * Returns received-in-arrival-order; sorting by (group,object) is left to
 * the caller since arrival order is itself a signal we may want to assert.
 */
export function collectObjects(
  count: number,
  timeoutMs: number,
): {
  onObject: (data: Uint8Array, groupId: number, objectId: number, timestamp: number) => void;
  done: Promise<ReceivedObject[]>;
} {
  const received: ReceivedObject[] = [];
  let resolveFn!: (v: ReceivedObject[]) => void;
  let rejectFn!: (e: Error) => void;
  const done = new Promise<ReceivedObject[]>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  const timer = setTimeout(() => {
    rejectFn(
      new Error(`collectObjects timeout: got ${received.length}/${count} after ${timeoutMs}ms`),
    );
  }, timeoutMs);

  return {
    onObject: (bytes, groupId, objectId, timestamp) => {
      received.push({ groupId, objectId, bytes, timestamp });
      if (received.length >= count) {
        clearTimeout(timer);
        resolveFn(received.slice(0, count));
      }
    },
    done,
  };
}

/**
 * Assert that (groupId, objectId) increases monotonically in arrival order.
 * A monotonicity violation signals reorder — usually a MOQ-level bug.
 */
export function assertMonotonic(objs: ReceivedObject[]): void {
  let lastGroup = -1;
  let lastObject = -1;
  for (const o of objs) {
    const groupOk = o.groupId > lastGroup;
    const sameGroupObjectOk = o.groupId === lastGroup && o.objectId > lastObject;
    if (!groupOk && !sameGroupObjectOk) {
      throw new Error(
        `non-monotonic delivery: got (${o.groupId},${o.objectId}) after (${lastGroup},${lastObject})`,
      );
    }
    lastGroup = o.groupId;
    lastObject = o.objectId;
  }
}
