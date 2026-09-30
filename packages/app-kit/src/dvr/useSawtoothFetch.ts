// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Sawtooth FETCH scheduler for DVR/VOD playback.
 *
 * Overlapping short fetch windows (default 3 GOPs each, 1-GOP overlap) walk
 * the playhead forward. When the buffer ahead of the playhead falls below
 * `lowWaterGops`, we kick a new window from `lastFetchedGroup + 1`. On seek
 * we cancel every in-flight fetch and snap to the target group's keyframe.
 *
 * The scheduler is transport-agnostic: pass in a small `FetchDriver` that
 * knows how to fire a fetch and how to cancel one — this hook stays a hook.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DvrPlayerControls } from './useDvrPlayer.js';

export interface SawtoothFetchWindow {
  requestId: bigint;
  startGroup: number;
  endGroup: number;
  /** ms range this window covers (approx, based on group→pts map). */
  startMs: number;
  endMs: number;
  /** UI hint: bytes received on this window so far. */
  bytesReceived: number;
  /** UI hint: number of objects received. */
  objectsReceived: number;
  startedAt: number;
  /** First-byte latency (ms), populated once the first object lands. */
  firstByteMs?: number;
}

export interface SawtoothStats {
  activeFetches: SawtoothFetchWindow[];
  bufferedGroups: number;
  bufferedAheadGops: number;
  totalBytes: number;
  windowsCompleted: number;
  windowsCancelled: number;
}

/**
 * Group → media PTS mapping used to translate a scrub position (ms) into a
 * FETCH `startGroup`. Ordered by increasing PTS. Each entry corresponds to a
 * keyframe / new-group boundary.
 */
export interface GroupPtsPoint {
  groupId: number;
  ptsMs: number;
}

export interface FetchDriver {
  /** Kick a fetch for `[startGroup, endGroup]`. Returns the request id. */
  fetch: (window: {
    startGroup: number;
    endGroup: number;
    onObject: (groupId: number, objectId: number, data: Uint8Array) => void;
  }) => Promise<bigint>;
  /** Cancel a fetch. Idempotent. */
  cancel: (requestId: bigint) => Promise<void>;
}

export interface SawtoothOptions {
  /** How many GOPs per window (default 3). */
  windowGops?: number;
  /** GOP overlap between adjacent windows (default 1). Dedupe handles duplicates. */
  overlapGops?: number;
  /** Refill trigger: when bufferedAheadGops < this, launch the next window. */
  lowWaterGops?: number;
  /** Max windows in flight at once (default 2). */
  maxInFlight?: number;
}

export interface UseSawtoothFetchInput {
  controls: DvrPlayerControls;
  /** Group→PTS map (from the media timeline track). */
  groupPts: GroupPtsPoint[];
  /** Total group count if known (from media-timeline last entry or catalog). */
  totalGroups?: number;
  driver: FetchDriver;
  onObject: (groupId: number, objectId: number, data: Uint8Array) => void;
  options?: SawtoothOptions;
}

const DEFAULTS: Required<SawtoothOptions> = {
  windowGops: 3,
  overlapGops: 1,
  lowWaterGops: 2,
  maxInFlight: 2,
};

function ptsToGroup(pts: number, groupPts: GroupPtsPoint[]): number {
  if (groupPts.length === 0) return 0;
  // Binary search for the largest groupPts[i].ptsMs <= pts.
  let lo = 0;
  let hi = groupPts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (groupPts[mid].ptsMs <= pts) lo = mid;
    else hi = mid - 1;
  }
  return groupPts[lo].groupId;
}

function groupToPts(group: number, groupPts: GroupPtsPoint[]): number {
  const entry = groupPts.find((g) => g.groupId === group);
  return entry?.ptsMs ?? 0;
}

/**
 * React hook that drives sawtooth FETCH scheduling from a DvrPlayerControls
 * position + rate.
 */
export function useSawtoothFetch(input: UseSawtoothFetchInput): SawtoothStats {
  const opts = { ...DEFAULTS, ...input.options };
  const [stats, setStats] = useState<SawtoothStats>({
    activeFetches: [],
    bufferedGroups: 0,
    bufferedAheadGops: 0,
    totalBytes: 0,
    windowsCompleted: 0,
    windowsCancelled: 0,
  });

  const stateRef = useRef({
    /** Highest groupId we've dispatched a fetch for (inclusive). */
    lastRequested: -1,
    /** Set of groupIds received at least one object for. */
    received: new Set<number>(),
    /** Set of dedupe keys (groupId,objectId). */
    seen: new Set<string>(),
    inFlight: new Map<bigint, SawtoothFetchWindow>(),
    totalBytes: 0,
    completed: 0,
    cancelled: 0,
    /** Playhead group as of last dispatch decision. */
    playheadGroup: 0,
  });

  const commitStats = () => {
    const s = stateRef.current;
    const playheadGroup = s.playheadGroup;
    let bufferedAhead = 0;
    for (let g = playheadGroup; g <= s.lastRequested; g++) {
      if (s.received.has(g)) bufferedAhead += 1;
      else break;
    }
    setStats({
      activeFetches: Array.from(s.inFlight.values()),
      bufferedGroups: s.received.size,
      bufferedAheadGops: bufferedAhead,
      totalBytes: s.totalBytes,
      windowsCompleted: s.completed,
      windowsCancelled: s.cancelled,
    });
  };

  const driverRef = useRef(input.driver);
  driverRef.current = input.driver;
  const onObjectRef = useRef(input.onObject);
  onObjectRef.current = input.onObject;

  const kickWindow = async (startGroup: number, endGroup: number) => {
    const s = stateRef.current;
    if (s.inFlight.size >= opts.maxInFlight) return;
    const startedAt = performance.now();
    const window: SawtoothFetchWindow = {
      requestId: -1n,
      startGroup,
      endGroup,
      startMs: groupToPts(startGroup, input.groupPts),
      endMs: groupToPts(endGroup, input.groupPts),
      bytesReceived: 0,
      objectsReceived: 0,
      startedAt,
    };
    try {
      const rid = await driverRef.current.fetch({
        startGroup,
        endGroup,
        onObject: (groupId, objectId, data) => {
          const key = `${groupId}:${objectId}`;
          if (s.seen.has(key)) return;
          s.seen.add(key);
          s.received.add(groupId);
          s.totalBytes += data.byteLength;
          const w = s.inFlight.get(rid);
          if (w) {
            w.bytesReceived += data.byteLength;
            w.objectsReceived += 1;
            if (w.firstByteMs === undefined) w.firstByteMs = performance.now() - w.startedAt;
          }
          onObjectRef.current(groupId, objectId, data);
          commitStats();
        },
      });
      window.requestId = rid;
      s.inFlight.set(rid, window);
      s.lastRequested = Math.max(s.lastRequested, endGroup);
      commitStats();
    } catch (err) {
      void err;
    }
  };

  const cancelAll = async () => {
    const s = stateRef.current;
    const inflight = Array.from(s.inFlight.values());
    for (const w of inflight) {
      try { await driverRef.current.cancel(w.requestId); } catch { /* noop */ }
      s.inFlight.delete(w.requestId);
      s.cancelled += 1;
    }
    commitStats();
  };

  // Reset seen state when the source (groupPts identity) changes materially.
  const groupPtsSignature = useMemo(
    () => `${input.groupPts.length}:${input.groupPts[0]?.groupId ?? '-'}`,
    [input.groupPts],
  );

  useEffect(() => {
    stateRef.current = {
      lastRequested: -1,
      received: new Set(),
      seen: new Set(),
      inFlight: new Map(),
      totalBytes: 0,
      completed: 0,
      cancelled: 0,
      playheadGroup: 0,
    };
    commitStats();
    return () => {
      void cancelAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupPtsSignature]);

  // Poll the intent every 250ms and dispatch new windows.
  const { state } = input.controls;
  const { positionMs, isPaused, isSeeking } = state;

  useEffect(() => {
    // Seek: cancel + reset request pointer to the new group's keyframe.
    if (isSeeking) return;
    const s = stateRef.current;
    const playheadGroup = ptsToGroup(positionMs, input.groupPts);
    s.playheadGroup = playheadGroup;
    // If we jumped backward past our received buffer, drop received state
    // for groups we no longer need to keep in memory (simple: keep as-is;
    // dedupe still saves work). We do reset lastRequested to just before
    // playhead so future refills fetch again if needed.
    if (playheadGroup <= s.lastRequested - opts.windowGops * 2) {
      // A significant backward seek — cancel in-flight and reseat.
      void cancelAll().then(() => {
        s.lastRequested = playheadGroup - 1;
        s.seen.clear();
        s.received.clear();
        commitStats();
      });
    }
    commitStats();
  }, [positionMs, isSeeking, input.groupPts, opts.windowGops]);

  useEffect(() => {
    if (isSeeking) return;
    const tick = () => {
      const s = stateRef.current;
      const playheadGroup = s.playheadGroup;
      let bufferedAhead = 0;
      for (let g = playheadGroup; g <= s.lastRequested; g++) {
        if (s.received.has(g)) bufferedAhead += 1;
        else break;
      }
      const needRefill = bufferedAhead < opts.lowWaterGops
        || s.lastRequested < playheadGroup + opts.windowGops - 1;
      if (needRefill && s.inFlight.size < opts.maxInFlight) {
        const start = Math.max(playheadGroup, s.lastRequested + 1 - opts.overlapGops);
        const totalGroups = input.totalGroups ?? Number.MAX_SAFE_INTEGER;
        const end = Math.min(start + opts.windowGops - 1, totalGroups - 1);
        if (end >= start) void kickWindow(start, end);
      }
    };
    // Immediate kick + interval refill.
    tick();
    if (isPaused) return; // Paused: only refresh on external position changes.
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPaused, isSeeking, opts.lowWaterGops, opts.windowGops, opts.overlapGops, opts.maxInFlight, input.totalGroups]);

  return stats;
}
