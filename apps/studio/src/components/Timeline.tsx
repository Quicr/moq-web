import { GlassPanel } from '@moq-web/app-kit/shell';

interface TimelineProps {
  positionMs: number;
  durationMs: number;
}

const EVENTS = [
  { t: 3_000, label: 'Opening titles', kind: 'meta' },
  { t: 12_000, label: 'Presenter A joins', kind: 'join' },
  { t: 22_500, label: 'Slide change', kind: 'meta' },
  { t: 37_000, label: 'Q&A open', kind: 'meta' },
  { t: 50_500, label: 'Bitrate step-up', kind: 'delta' },
];

export function Timeline({ positionMs, durationMs }: TimelineProps) {
  return (
    <GlassPanel padding="md">
      <div className="ak-row-between" style={{ marginBottom: 8 }}>
        <div className="ak-heading">Event & media timeline</div>
        <div className="ak-subtle">deltas · joins · media boundaries</div>
      </div>
      <div style={{ position: 'relative', height: 56, background: 'var(--ak-bg-elev)', borderRadius: 12, overflow: 'hidden' }}>
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            width: `${(positionMs / durationMs) * 100}%`,
            background: 'linear-gradient(90deg, rgba(99,102,241,0.28), rgba(236,72,153,0.28))',
          }}
        />
        {EVENTS.map((e) => (
          <div
            key={e.t}
            title={`${e.label} @ ${(e.t / 1000).toFixed(1)}s`}
            style={{
              position: 'absolute',
              top: 8,
              bottom: 8,
              left: `calc(${(e.t / durationMs) * 100}% - 6px)`,
              width: 12,
              borderRadius: 6,
              background:
                e.kind === 'delta'
                  ? 'linear-gradient(180deg, #f59e0b, #f97316)'
                  : e.kind === 'join'
                  ? 'linear-gradient(180deg, #10b981, #059669)'
                  : 'linear-gradient(180deg, #818cf8, #6366f1)',
              boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
        {EVENTS.map((e) => (
          <span key={e.t} className="ak-chip ak-chip-neutral">
            {(e.t / 1000).toFixed(1)}s · {e.label}
          </span>
        ))}
      </div>
    </GlassPanel>
  );
}
