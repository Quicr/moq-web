// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Draft-18 §7 priority scheduling helpers.
 *
 * The spec (§7.2) orders schedulable objects by:
 *   1. Subscriber priority (lower number = higher priority)
 *   2. Publisher priority (lower number = higher priority)
 *   3. Group order (Ascending vs Descending)
 *   4. Subgroup / Object ID within the same group
 *
 * WebTransport exposes a single `sendOrder` (WebIDL long long, surfaced as
 * JS Number) on outgoing streams that the browser uses to prioritize QUIC
 * transmission when the pipe is congested. Higher `sendOrder` values are
 * sent first, so we invert the MOQT priority numbers (0 is highest) when
 * packing them into `sendOrder`.
 *
 * Layout of the returned 52-bit value (fits safely in a JS Number ≤ 2^53):
 *
 *   [8 bits: 0xFF - subscriberPriority]  ← most significant
 *   [8 bits: 0xFF - publisherPriority ]
 *   [36 bits: group-order-adjusted group ID]  ← least significant
 *
 * For ASCENDING, lower groupIds should ship first, so we place
 * `(2^36 - 1) - groupId` in the low bits. For DESCENDING, we place
 * `groupId` directly. This mirrors the spec: within a request, at equal
 * subscriber + publisher priority, group-order breaks the tie.
 */

import { GroupOrder } from '@moq-web/core';
import type { RequestParameterDraft18 } from '@moq-web/core';

const GROUP_BITS = 36;
const GROUP_MAX = 2 ** GROUP_BITS - 1; // 0xF_FFFF_FFFF

/**
 * Compute the WebTransport `sendOrder` for a schedulable object.
 *
 * @param subscriberPriority - Subscriber priority (0-255, 0 = highest).
 * @param publisherPriority  - Publisher priority (0-255, 0 = highest).
 * @param groupOrder         - ASCENDING (lower group IDs first) or
 *                             DESCENDING (higher group IDs first).
 * @param groupId            - Group ID of the object (non-negative).
 * @returns A JS Number safe for `WebTransportSendStreamOptions.sendOrder`
 *          — larger values are transmitted first.
 */
export function computeSendOrder(
  subscriberPriority: number,
  publisherPriority: number,
  groupOrder: GroupOrder,
  groupId: number,
): number {
  const subP = clamp8(subscriberPriority);
  const pubP = clamp8(publisherPriority);
  const invSub = 0xff - subP;
  const invPub = 0xff - pubP;

  // Group-order tiebreak in the low `GROUP_BITS`. ASCENDING wants lower
  // groupId to ship first (bigger sendOrder), so invert; DESCENDING wants
  // higher groupId to ship first, so use it directly.
  const g = Math.max(0, Math.min(Math.floor(groupId), GROUP_MAX));
  const groupBits = groupOrder === GroupOrder.DESCENDING ? g : (GROUP_MAX - g);

  // [ invSub(8) | invPub(8) | groupBits(36) ]  = 52 bits total, safely in
  // JS Number range (< 2^53).
  return invSub * 2 ** (8 + GROUP_BITS) + invPub * 2 ** GROUP_BITS + groupBits;
}

function clamp8(v: number): number {
  if (!Number.isFinite(v)) return 128;
  if (v < 0) return 0;
  if (v > 0xff) return 0xff;
  return Math.floor(v);
}

/**
 * §10.2 SUBSCRIBER_PRIORITY (0x20) is a single unsigned byte.
 * §10.2 GROUP_ORDER (0x22) is a single unsigned byte, 1 = ascending,
 * 2 = descending; any other value falls back to ASCENDING.
 *
 * @param params - Parameters map from a decoded draft-18 SUBSCRIBE or
 *                 REQUEST_UPDATE message. Undefined → defaults are returned.
 */
export function parseSubscriberSchedulingParams(
  params: Map<number, Uint8Array> | undefined,
): { subscriberPriority?: number; groupOrder?: GroupOrder } {
  if (!params) return {};
  const out: { subscriberPriority?: number; groupOrder?: GroupOrder } = {};

  const pri = params.get(SUBSCRIBER_PRIORITY);
  if (pri && pri.length > 0) {
    out.subscriberPriority = pri[0];
  }

  const go = params.get(GROUP_ORDER);
  if (go && go.length > 0) {
    const v = go[0];
    out.groupOrder = v === 2 ? GroupOrder.DESCENDING : GroupOrder.ASCENDING;
  }

  return out;
}

// Local mirror of the draft-18 parameter type IDs so this module doesn't
// need to import the runtime enum. Keep in sync with
// packages/core/src/messages/types.ts `RequestParameterDraft18`.
const SUBSCRIBER_PRIORITY: number = 0x20 satisfies RequestParameterDraft18;
const GROUP_ORDER: number = 0x22 satisfies RequestParameterDraft18;
