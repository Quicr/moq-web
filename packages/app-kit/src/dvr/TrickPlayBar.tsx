// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import type { DvrPlayerControls } from './useDvrPlayer.js';

const RATES = [0.25, 0.5, 1, 1.5, 2, 4];

function fmt(ms: number): string {
  if (!isFinite(ms)) return '--:--';
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export interface TrickPlayBarProps {
  controls: DvrPlayerControls;
  showLiveButton?: boolean;
}

export function TrickPlayBar({ controls, showLiveButton = true }: TrickPlayBarProps) {
  const { state, play, pause, seek, commitSeek, setRate, goLive } = controls;
  const { range, positionMs, rate, isPaused } = state;
  const duration = Math.max(1, range.endMs - range.startMs);
  const progress = ((positionMs - range.startMs) / duration) * 100;
  const atLive = range.liveEdgeMs !== undefined && Math.abs(range.endMs - positionMs) < 500;

  return (
    <div className="ak-glass" style={{ padding: 14 }}>
      <div className="ak-row" style={{ gap: 10 }}>
        <button
          className="ak-btn ak-btn-primary"
          onClick={() => (isPaused ? play() : pause())}
          style={{ minWidth: 88 }}
        >
          {isPaused ? '▶ Play' : '❚❚ Pause'}
        </button>
        <div style={{ flex: 1 }}>
          <input
            type="range"
            className="ak-range"
            min={range.startMs}
            max={range.endMs}
            step={100}
            value={positionMs}
            onChange={(e) => seek(Number(e.target.value))}
            onMouseUp={commitSeek}
            onTouchEnd={commitSeek}
          />
          <div className="ak-row-between" style={{ marginTop: 4 }}>
            <span className="ak-subtle" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {fmt(positionMs - range.startMs)}
            </span>
            <span className="ak-subtle" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {fmt(range.endMs - range.startMs)}
            </span>
          </div>
        </div>
        <select
          className="ak-select"
          value={rate}
          onChange={(e) => setRate(Number(e.target.value))}
          style={{ width: 90 }}
        >
          {RATES.map((r) => (
            <option key={r} value={r}>{r}×</option>
          ))}
        </select>
        {showLiveButton && (
          <button
            className={atLive ? 'ak-btn' : 'ak-btn ak-btn-primary'}
            onClick={goLive}
            disabled={atLive}
            title="Jump to live edge"
          >
            ● Live
          </button>
        )}
      </div>
      <div
        aria-hidden
        style={{
          height: 3,
          background: 'var(--ak-border)',
          borderRadius: 999,
          marginTop: 8,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${progress}%`,
            height: '100%',
            background: 'linear-gradient(90deg, var(--ak-accent), #8b5cf6)',
          }}
        />
      </div>
    </div>
  );
}
