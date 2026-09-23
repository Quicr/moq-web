// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { useEffect, useRef } from 'react';
import { GlassPanel } from '@moq-web/app-kit/shell';

export interface MediaTile {
  peerId: string;
  isSelf: boolean;
  displayName?: string;
}

interface MediaGridProps {
  tiles: MediaTile[];
  localStream: MediaStream | undefined;
  peerVideoFrames: Map<string, VideoFrame>;
  muted: boolean;
  videoOff: boolean;
  onToggleMute: () => void;
  onToggleVideo: () => void;
  status: 'idle' | 'connecting' | 'ready' | 'error';
}

/**
 * Grid of local + remote video tiles. Local tile uses `<video srcObject>`;
 * remote tiles paint `VideoFrame` objects into `<canvas>`.
 */
export function MediaGrid({
  tiles,
  localStream,
  peerVideoFrames,
  muted,
  videoOff,
  onToggleMute,
  onToggleVideo,
  status,
}: MediaGridProps) {
  const localRef = useRef<HTMLVideoElement | null>(null);
  const canvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());

  useEffect(() => {
    const el = localRef.current;
    if (!el) return;
    if (localStream && el.srcObject !== localStream) el.srcObject = localStream;
    if (!localStream && el.srcObject) el.srcObject = null;
  }, [localStream]);

  useEffect(() => {
    for (const [peerId, frame] of peerVideoFrames) {
      const canvas = canvasRefs.current.get(peerId);
      if (!canvas) continue;
      if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
      if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      try { ctx.drawImage(frame, 0, 0, canvas.width, canvas.height); }
      catch { /* frame may have closed on rapid updates */ }
    }
  }, [peerVideoFrames]);

  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: `repeat(${Math.min(tiles.length, 2)}, minmax(0, 1fr))`,
    gap: 12,
  };

  return (
    <GlassPanel strong padding="sm">
      <div style={gridStyle}>
        {tiles.map((t) => (
          <div
            key={t.peerId}
            style={{
              position: 'relative',
              aspectRatio: '16 / 9',
              borderRadius: 12,
              overflow: 'hidden',
              background:
                'radial-gradient(60% 80% at 30% 40%, rgba(129, 140, 248, 0.35), transparent 60%), radial-gradient(80% 60% at 80% 60%, rgba(236, 72, 153, 0.30), transparent 55%), #050914',
            }}
          >
            {t.isSelf ? (
              <video
                ref={(el) => { localRef.current = el; }}
                autoPlay
                muted
                playsInline
                style={{
                  position: 'absolute', inset: 0, width: '100%', height: '100%',
                  objectFit: 'cover',
                  display: !videoOff && localStream ? 'block' : 'none',
                }}
              />
            ) : (
              <canvas
                ref={(el) => {
                  if (el) canvasRefs.current.set(t.peerId, el);
                  else canvasRefs.current.delete(t.peerId);
                }}
                style={{
                  position: 'absolute', inset: 0, width: '100%', height: '100%',
                  objectFit: 'cover',
                  display: peerVideoFrames.has(t.peerId) ? 'block' : 'none',
                }}
              />
            )}
            {((t.isSelf && (videoOff || !localStream)) || (!t.isSelf && !peerVideoFrames.has(t.peerId))) && (
              <div style={{
                position: 'absolute', inset: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'rgba(255,255,255,0.6)', fontSize: 14, letterSpacing: '0.08em', textTransform: 'uppercase',
              }}>
                {t.isSelf
                  ? (status === 'ready' ? 'camera off' : 'press go live')
                  : 'waiting for frames…'}
              </div>
            )}
            <div style={{
              position: 'absolute', bottom: 8, left: 8,
              padding: '4px 10px',
              background: 'rgba(0,0,0,0.55)',
              backdropFilter: 'blur(4px)',
              borderRadius: 999,
              color: 'white', fontSize: 12, fontWeight: 600,
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              {t.isSelf && muted ? <span style={{ color: '#f87171' }}>🔇</span> : null}
              {t.isSelf ? 'You' : (t.displayName ?? t.peerId)}
            </div>
            {t.isSelf && localStream && (
              <div style={{
                position: 'absolute', top: 8, right: 8,
                width: 8, height: 8, borderRadius: '50%',
                background: '#10b981', boxShadow: '0 0 0 4px rgba(16, 185, 129, 0.25)',
              }} />
            )}
          </div>
        ))}
      </div>
      <div className="ak-row" style={{ justifyContent: 'center', gap: 10, marginTop: 12 }}>
        <button
          className={`ak-btn ${muted ? 'ak-btn-ghost' : ''}`}
          onClick={onToggleMute}
          disabled={!localStream}
          title={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? '🔇 Muted' : '🎤 Mic'}
        </button>
        <button
          className={`ak-btn ${videoOff ? 'ak-btn-ghost' : ''}`}
          onClick={onToggleVideo}
          disabled={!localStream}
          title={videoOff ? 'Turn on camera' : 'Turn off camera'}
        >
          {videoOff ? '📷 Camera off' : '📹 Camera'}
        </button>
      </div>
    </GlassPanel>
  );
}
