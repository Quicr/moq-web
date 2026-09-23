import { GlassPanel } from '@moq-web/app-kit/shell';
import type { TimelineEvent } from '../moqt';

export interface TimelineEntry extends TimelineEvent {
  peerId: string;
  receivedAt: number;
}

interface TimelineProps {
  entries: TimelineEntry[];
  durationMs: number;
  selfId: string;
}

function kindColor(kind: TimelineEvent['kind']) {
  return kind === 'delta'
    ? 'linear-gradient(180deg, #f59e0b, #f97316)'
    : kind === 'join'
    ? 'linear-gradient(180deg, #10b981, #059669)'
    : 'linear-gradient(180deg, #818cf8, #6366f1)';
}

export function Timeline({ entries, durationMs, selfId }: TimelineProps) {
  const windowMs = Math.max(durationMs, ...entries.map((e) => e.t), 1000);
  return (
    <GlassPanel padding="md">
      <div className="ak-row-between" style={{ marginBottom: 8 }}>
        <div className="ak-heading">Event & media timeline</div>
        <div className="ak-subtle">{entries.length} events from {new Set(entries.map((e) => e.peerId)).size || 0} peers</div>
      </div>
      <div style={{ position: 'relative', height: 56, background: 'var(--ak-bg-elev)', borderRadius: 12, overflow: 'hidden' }}>
        {entries.map((e, idx) => (
          <div
            key={`${e.peerId}-${e.t}-${idx}`}
            title={`${e.peerId} · ${e.label} @ ${(e.t / 1000).toFixed(1)}s`}
            style={{
              position: 'absolute',
              top: e.peerId === selfId ? 8 : 28,
              height: 20,
              left: `calc(${Math.min((e.t / windowMs) * 100, 99)}% - 6px)`,
              width: 12,
              borderRadius: 6,
              background: kindColor(e.kind),
              boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
        {entries.slice(-10).reverse().map((e, idx) => (
          <span key={idx} className="ak-chip ak-chip-neutral" title={e.peerId}>
            {(e.t / 1000).toFixed(1)}s · {e.label}
          </span>
        ))}
        {entries.length === 0 ? <span className="ak-subtle">No events yet. Press Go live and emit some.</span> : null}
      </div>
    </GlassPanel>
  );
}
