import { useState } from 'react';
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
  const peers = Array.from(new Set(entries.map((e) => e.peerId)));
  const [peerFilter, setPeerFilter] = useState<string>('all');
  const [kindFilter, setKindFilter] = useState<'all' | TimelineEvent['kind']>('all');

  const filtered = entries.filter(
    (e) =>
      (peerFilter === 'all' || e.peerId === peerFilter) &&
      (kindFilter === 'all' || e.kind === kindFilter),
  );
  const windowMs = Math.max(durationMs, ...filtered.map((e) => e.t), 1000);

  const copyJson = () => {
    try {
      navigator.clipboard.writeText(JSON.stringify(filtered, null, 2));
    } catch { /* clipboard may be unavailable outside HTTPS */ }
  };

  return (
    <GlassPanel padding="md">
      <div className="ak-row-between" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <div className="ak-heading">Event & media timeline</div>
        <div className="ak-row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <select
            className="ak-select"
            value={peerFilter}
            onChange={(e) => setPeerFilter(e.target.value)}
            style={{ fontSize: 11, padding: '4px 8px' }}
          >
            <option value="all">all peers</option>
            {peers.map((p) => (
              <option key={p} value={p}>{p === selfId ? `${p} (you)` : p}</option>
            ))}
          </select>
          <select
            className="ak-select"
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as typeof kindFilter)}
            style={{ fontSize: 11, padding: '4px 8px' }}
          >
            <option value="all">all kinds</option>
            <option value="meta">meta</option>
            <option value="delta">delta</option>
            <option value="join">join</option>
          </select>
          <button
            className="ak-btn ak-btn-ghost"
            style={{ fontSize: 11 }}
            onClick={copyJson}
            disabled={filtered.length === 0}
          >
            Copy JSON
          </button>
        </div>
      </div>
      <div className="ak-subtle" style={{ fontSize: 11, marginBottom: 8 }}>
        {filtered.length} event{filtered.length === 1 ? '' : 's'} · {peers.length} peer{peers.length === 1 ? '' : 's'}
      </div>
      <div style={{ position: 'relative', height: 56, background: 'var(--ak-bg-elev)', borderRadius: 12, overflow: 'hidden' }}>
        {filtered.map((e, idx) => (
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
      <div style={{ maxHeight: 180, overflowY: 'auto', marginTop: 12 }}>
        {filtered.length === 0 ? (
          <div className="ak-subtle">No events yet. Emit one below or wait for a peer.</div>
        ) : (
          <div className="ak-stack" style={{ gap: 4 }}>
            {filtered.slice().reverse().map((e, idx) => (
              <div
                key={`${e.peerId}-${e.receivedAt}-${idx}`}
                className="ak-row"
                style={{ gap: 8, fontSize: 11, padding: '4px 8px', borderRadius: 6, background: 'var(--ak-bg-elev)' }}
              >
                <span className="ak-chip ak-chip-neutral" style={{ fontSize: 10, minWidth: 60, textAlign: 'center' }}>
                  {e.kind}
                </span>
                <span style={{ minWidth: 60, color: 'var(--ak-fg-muted)' }}>
                  {(e.t / 1000).toFixed(1)}s
                </span>
                <span style={{ flex: 1 }}>{e.label}</span>
                <span className="ak-subtle" style={{ fontSize: 10 }}>{e.peerId}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </GlassPanel>
  );
}
