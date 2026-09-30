// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import type { SawtoothStats } from './useSawtoothFetch.js';

export interface FetchStatsFooterProps {
  stats: SawtoothStats;
  windowStartedAtMs?: number;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Compact stats row for the DVR/VOD viewer: total bytes fetched, effective
 * bitrate over the last window, first-byte latency of the newest fetch,
 * counts of in-flight/completed/cancelled windows.
 */
export function FetchStatsFooter({ stats }: FetchStatsFooterProps) {
  const now = performance.now();
  const active = stats.activeFetches;
  const newest = active.length > 0 ? active[active.length - 1] : undefined;
  const elapsedS = newest ? (now - newest.startedAt) / 1000 : 0;
  const bitrateBps = newest && elapsedS > 0
    ? (newest.bytesReceived * 8) / elapsedS
    : 0;
  const bitrateStr = bitrateBps > 1_000_000
    ? `${(bitrateBps / 1_000_000).toFixed(1)} Mbps`
    : bitrateBps > 1000
    ? `${(bitrateBps / 1000).toFixed(1)} kbps`
    : `${bitrateBps.toFixed(0)} bps`;
  return (
    <div
      className="ak-caption"
      style={{
        display: 'flex',
        gap: 16,
        alignItems: 'center',
        fontVariantNumeric: 'tabular-nums',
        color: 'rgba(255,255,255,0.6)',
        fontSize: 11,
      }}
    >
      <span>total {fmtBytes(stats.totalBytes)}</span>
      <span>rate {bitrateStr}</span>
      <span>first-byte {newest?.firstByteMs ? `${newest.firstByteMs.toFixed(0)} ms` : '—'}</span>
      <span>in-flight {stats.activeFetches.length}</span>
      <span>done {stats.windowsCompleted}</span>
      <span>cancel {stats.windowsCancelled}</span>
      <span>buffered {stats.bufferedAheadGops} GOP ahead</span>
    </div>
  );
}
