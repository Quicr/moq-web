// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { useEffect, useRef } from 'react';

export interface VideoTileProps {
  stream: MediaStream | null;
  label?: string;
  muted?: boolean;
  mirror?: boolean;
}

export function VideoTile({ stream, label, muted = true, mirror = false }: VideoTileProps) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <div
      className="ak-glass"
      style={{
        position: 'relative',
        aspectRatio: '16 / 9',
        overflow: 'hidden',
        background: '#050914',
      }}
    >
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={muted}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: mirror ? 'scaleX(-1)' : undefined,
        }}
      />
      {label && (
        <div
          style={{
            position: 'absolute',
            bottom: 10,
            left: 10,
            padding: '4px 10px',
            borderRadius: 999,
            background: 'rgba(15, 23, 42, 0.55)',
            color: '#f8fafc',
            fontSize: 12,
            fontWeight: 600,
            backdropFilter: 'blur(8px)',
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
}
