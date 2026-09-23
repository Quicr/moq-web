import { GlassPanel } from '@moq-web/app-kit/shell';

interface BufferMeterProps {
  positionMs: number;
  bufferedMs: number;
  durationMs: number;
}

export function BufferMeter({ positionMs, bufferedMs, durationMs }: BufferMeterProps) {
  const pos = (positionMs / durationMs) * 100;
  const buf = (bufferedMs / durationMs) * 100;
  const ahead = Math.max(0, bufferedMs - positionMs);
  return (
    <GlassPanel padding="md">
      <div className="ak-row-between" style={{ marginBottom: 8 }}>
        <div className="ak-heading">Smart buffer</div>
        <span className="ak-chip ak-chip-neutral">
          {(ahead / 1000).toFixed(1)}s ahead
        </span>
      </div>
      <div
        style={{
          position: 'relative',
          height: 8,
          background: 'var(--ak-border)',
          borderRadius: 999,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${buf}%`,
            background: 'rgba(56, 189, 248, 0.55)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${pos}%`,
            background: 'linear-gradient(90deg, var(--ak-accent), #8b5cf6)',
          }}
        />
      </div>
      <div className="ak-row-between" style={{ marginTop: 6 }}>
        <span className="ak-subtle" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {(positionMs / 1000).toFixed(1)}s
        </span>
        <span className="ak-subtle" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {(durationMs / 1000).toFixed(0)}s
        </span>
      </div>
    </GlassPanel>
  );
}
