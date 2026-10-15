// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * WebTransport `sendOrder` of the streams that are not object data
 * (d22 §5.1.2, §11.5; d18 §7.2).
 *
 * Higher values are sent first. Control streams go before request streams,
 * and both before any object stream, whose `sendOrder` stays below 2^52 (see
 * `computeSendOrder` in @moq-web/session). Padding goes after everything.
 */
export const SendOrder = {
  CONTROL: Number.MAX_SAFE_INTEGER,
  REQUEST: Number.MAX_SAFE_INTEGER - 1,
  PADDING: -1,
} as const;
