// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview DTS (Dynamic Track Switching) Utilities
 *
 * Implements encoding and decoding of DTS SWITCHING-SET-ASSIGNMENT
 * parameters as specified in the DTS4MoQ specification.
 *
 * @see https://github.com/wilaw/dts4moq/blob/main/draft-wilaw-moq-dts4moq.md
 *
 * @example
 * ```typescript
 * import { serializeSwitchingSetAssignment, RequestParameter } from '@moq-web/core';
 *
 * // Create DTS assignment for a 720p track in switching set 1
 * const dtsBytes = serializeSwitchingSetAssignment({
 *   switchingSetId: 1,
 *   throughputThresholdKbps: 800,
 *   setThroughputFraction: 5,
 *   activateSwitching: true,
 *   setRank: 1,
 * });
 *
 * // Use in subscribe parameters
 * const params = new Map([[RequestParameter.SWITCHING_SET_ASSIGNMENT, dtsBytes]]);
 * ```
 */

import { VarInt } from './varint.js';

/**
 * DTS SWITCHING-SET-ASSIGNMENT parameter structure
 *
 * @remarks
 * This parameter is sent in SUBSCRIBE messages to configure
 * relay-side dynamic track switching based on available bandwidth.
 */
export interface SwitchingSetAssignment {
  /**
   * Switching set ID - groups subscriptions into a switching set.
   * Tracks with the same ID are considered alternatives for the same content.
   */
  switchingSetId: number;

  /**
   * Throughput threshold in kbps.
   * Minimum bandwidth required for the relay to select this track.
   */
  throughputThresholdKbps: number;

  /**
   * Set throughput fraction (1-10).
   * Determines the proportion of total bandwidth allocated to this set.
   * Value represents N/10 of total bandwidth.
   */
  setThroughputFraction: number;

  /**
   * Activate switching flag.
   * Set to true on the last track in a switching set to activate relay switching.
   */
  activateSwitching: boolean;

  /**
   * Set rank (1-255).
   * Priority for bandwidth allocation - lower values have higher priority.
   * Default is 1.
   */
  setRank: number;
}

/**
 * Serialize a SWITCHING-SET-ASSIGNMENT parameter to bytes
 *
 * @param assignment - The DTS assignment parameters
 * @returns Uint8Array containing the encoded parameter value
 *
 * @example
 * ```typescript
 * // Single switching set with 3 quality levels
 * const track1080p = serializeSwitchingSetAssignment({
 *   switchingSetId: 1,
 *   throughputThresholdKbps: 1500,
 *   setThroughputFraction: 5,
 *   activateSwitching: false,
 *   setRank: 1,
 * });
 *
 * const track720p = serializeSwitchingSetAssignment({
 *   switchingSetId: 1,
 *   throughputThresholdKbps: 800,
 *   setThroughputFraction: 5,
 *   activateSwitching: false,
 *   setRank: 1,
 * });
 *
 * const track360p = serializeSwitchingSetAssignment({
 *   switchingSetId: 1,
 *   throughputThresholdKbps: 300,
 *   setThroughputFraction: 5,
 *   activateSwitching: true,  // Activate on last track
 *   setRank: 1,
 * });
 * ```
 */
export function serializeSwitchingSetAssignment(
  assignment: SwitchingSetAssignment
): Uint8Array {
  const setIdBytes = VarInt.encode(assignment.switchingSetId);
  const thresholdBytes = VarInt.encode(assignment.throughputThresholdKbps);
  const fractionBytes = VarInt.encode(assignment.setThroughputFraction);
  const activateBytes = VarInt.encode(assignment.activateSwitching ? 1 : 0);
  const rankBytes = VarInt.encode(assignment.setRank);

  const totalLength =
    setIdBytes.length + thresholdBytes.length + fractionBytes.length +
    activateBytes.length + rankBytes.length;

  const result = new Uint8Array(totalLength);
  let offset = 0;

  result.set(setIdBytes, offset);
  offset += setIdBytes.length;

  result.set(thresholdBytes, offset);
  offset += thresholdBytes.length;

  result.set(fractionBytes, offset);
  offset += fractionBytes.length;

  result.set(activateBytes, offset);
  offset += activateBytes.length;

  result.set(rankBytes, offset);

  return result;
}

/**
 * Deserialize a SWITCHING-SET-ASSIGNMENT parameter from bytes
 *
 * @param data - The encoded parameter bytes
 * @returns The decoded DTS assignment
 * @throws {Error} If the data is invalid or incomplete
 */
export function deserializeSwitchingSetAssignment(
  data: Uint8Array
): SwitchingSetAssignment {
  let offset = 0;

  const [switchingSetId, setIdLen] = VarInt.decode(data.subarray(offset));
  offset += setIdLen;

  const [throughputThresholdKbps, thresholdLen] = VarInt.decode(
    data.subarray(offset)
  );
  offset += thresholdLen;

  const [setThroughputFraction, fractionLen] = VarInt.decode(
    data.subarray(offset)
  );
  offset += fractionLen;

  const [activateRaw, activateLen] = VarInt.decode(data.subarray(offset));
  offset += activateLen;

  const [setRank] = VarInt.decode(data.subarray(offset));

  return {
    switchingSetId: Number(switchingSetId),
    throughputThresholdKbps: Number(throughputThresholdKbps),
    setThroughputFraction: Number(setThroughputFraction),
    activateSwitching: Number(activateRaw) !== 0,
    setRank: Number(setRank),
  };
}
