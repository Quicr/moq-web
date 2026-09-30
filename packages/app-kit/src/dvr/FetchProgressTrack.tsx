// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import type { SawtoothFetchWindow } from './useSawtoothFetch.js';

export interface FetchProgressTrackProps {
  /** Total asset duration in ms — the scrubber's coordinate space. */
  durationMs: number;
  /** Playhead position in ms. */
  positionMs: number;
  /** Group→PTS map so we can turn `groupId` back into ms. */
  bufferedGroupsToMs: Array<{ startMs: number; endMs: number }>;
  activeFetches: SawtoothFetchWindow[];
  /** Called when the user clicks the [x] on an in-flight window. */
  onCancelFetch?: (requestId: bigint) => void;
}

/**
 * Sub-scrubber that visualises DVR/VOD fetch progress: green ranges for
 * already-buffered groups, animated blue stripes for in-flight windows,
 * a red playhead marker.
 */
export function FetchProgressTrack({
  durationMs,
  positionMs,
  bufferedGroupsToMs,
  activeFetches,
  onCancelFetch,
}: FetchProgressTrackProps) {
  const pct = (ms: number) => Math.max(0, Math.min(100, (ms / Math.max(1, durationMs)) * 100));
  return (
    <div
      style={{
        position: 'relative',
        height: 22,
        borderRadius: 6,
        background: 'rgba(15, 23, 42, 0.6)',
        border: '1px solid var(--ak-border)',
        overflow: 'hidden',
      }}
      title="Fetch progress — green = buffered, blue = in flight"
    >
      {/* Buffered ranges */}
      {bufferedGroupsToMs.map((r, i) => (
        <div
          key={`b-${i}`}
          style={{
            position: 'absolute',
            left: `${pct(r.startMs)}%`,
            width: `${pct(r.endMs - r.startMs)}%`,
            top: 0,
            bottom: 0,
            background: 'rgba(34, 197, 94, 0.35)',
          }}
        />
      ))}
      {/* In-flight windows */}
      {activeFetches.map((w) => {
        const left = pct(w.startMs);
        const width = Math.max(0.5, pct(w.endMs - w.startMs));
        return (
          <div
            key={String(w.requestId)}
            style={{
              position: 'absolute',
              left: `${left}%`,
              width: `${width}%`,
              top: 0,
              bottom: 0,
              backgroundImage:
                'repeating-linear-gradient(45deg, rgba(56,189,248,0.7) 0 6px, rgba(56,189,248,0.25) 6px 12px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              paddingRight: 2,
              cursor: onCancelFetch ? 'pointer' : 'default',
            }}
            title={`Fetch #${String(w.requestId)}: groups ${w.startGroup}..${w.endGroup} · ${w.objectsReceived} objs`}
            onClick={() => onCancelFetch?.(w.requestId)}
          >
            {onCancelFetch ? (
              <span
                style={{
                  fontSize: 10,
                  lineHeight: 1,
                  padding: '1px 3px',
                  background: 'rgba(0,0,0,0.4)',
                  color: 'white',
                  borderRadius: 3,
                }}
              >
                ✕
              </span>
            ) : null}
          </div>
        );
      })}
      {/* Playhead */}
      <div
        style={{
          position: 'absolute',
          left: `${pct(positionMs)}%`,
          top: 0,
          bottom: 0,
          width: 2,
          background: '#f87171',
          transform: 'translateX(-1px)',
        }}
      />
    </div>
  );
}
