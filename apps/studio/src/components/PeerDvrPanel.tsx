// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FetchProgressTrack,
  FetchStatsFooter,
  GlassPanel,
  TrickPlayBar,
  useDvrPlayer,
  useSawtoothFetch,
  type GroupPtsPoint,
} from '@moq-web/app-kit';
import type { PeerDvrHandle } from '../moqt';

interface PeerDvrPanelProps {
  peerId: string;
  handle: PeerDvrHandle;
  /** Group→PTS points collected from the peer's mediatimeline track. */
  timeline: GroupPtsPoint[];
  /** Latest live frame position for the peer, used as the DVR range end. */
  liveEdgeMs: number;
  onClose: () => void;
}

/**
 * Per-peer sawtooth DVR overlay. Paints decoded frames into its own canvas
 * (independent from the live tile) and drives useSawtoothFetch off the
 * broadcast's PeerDvrHandle.
 */
export function PeerDvrPanel({ peerId, handle, timeline, liveEdgeMs, onClose }: PeerDvrPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [rangeEndMs, setRangeEndMs] = useState(Math.max(liveEdgeMs, 1000));

  useEffect(() => {
    if (liveEdgeMs > rangeEndMs) setRangeEndMs(liveEdgeMs);
  }, [liveEdgeMs, rangeEndMs]);

  const controls = useDvrPlayer({
    range: { startMs: 0, endMs: rangeEndMs, liveEdgeMs },
    autoPlay: false,
  });

  useEffect(() => {
    controls.setRange({ startMs: 0, endMs: rangeEndMs, liveEdgeMs });
  }, [rangeEndMs, liveEdgeMs, controls]);

  const bufferedGroupsToMs = useMemo(() => {
    if (timeline.length === 0) return [];
    return timeline.map((p, i) => ({
      startMs: p.ptsMs,
      endMs: timeline[i + 1]?.ptsMs ?? (rangeEndMs || p.ptsMs + 2000),
    }));
  }, [timeline, rangeEndMs]);

  const drawFrame = useCallback((frame: VideoFrame) => {
    const canvas = canvasRef.current;
    if (!canvas) { frame.close(); return; }
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
    }
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.drawImage(frame, 0, 0);
    frame.close();
  }, []);

  // The pipeline paint hook is wired by the parent through moqt.ts's
  // startPeerDvr({ onDvrFrame }). We install a forwarder so the DOM canvas
  // ref inside this component still receives the frames.
  useEffect(() => {
    handle.setFrameSink?.(drawFrame);
    return () => handle.setFrameSink?.(null);
  }, [handle, drawFrame]);

  const stats = useSawtoothFetch({
    controls,
    groupPts: timeline,
    totalGroups: timeline.length > 0 ? timeline[timeline.length - 1].groupId + 1 : undefined,
    driver: handle.driver,
    onObject: (groupId, objectId, data) => {
      const point = timeline.find((p) => p.groupId === groupId);
      const ptsUs = point ? point.ptsMs * 1000 : groupId * 2_000_000;
      handle.pushObject(data, groupId, objectId, ptsUs);
    },
  });

  return (
    <GlassPanel strong padding="sm">
      <div className="ak-row-between" style={{ marginBottom: 8 }}>
        <div className="ak-heading">DVR · {peerId}</div>
        <button className="ak-btn ak-btn-ghost" onClick={onClose} style={{ fontSize: 12 }}>
          ⏹ Return to live
        </button>
      </div>
      <div
        style={{
          aspectRatio: '16 / 9',
          background: '#050914',
          borderRadius: 12,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 8,
        }}
      >
        <canvas ref={canvasRef} style={{ maxWidth: '100%', maxHeight: '100%' }} />
      </div>
      <TrickPlayBar controls={controls} showLiveButton />
      <FetchProgressTrack
        durationMs={rangeEndMs}
        positionMs={controls.state.positionMs}
        bufferedGroupsToMs={bufferedGroupsToMs.filter((_, i) =>
          stats.bufferedAheadGops > 0 && i <= controls.state.positionMs
        )}
        activeFetches={stats.activeFetches}
        onCancelFetch={(rid) => void handle.driver.cancel(rid)}
      />
      <FetchStatsFooter stats={stats} />
    </GlassPanel>
  );
}
