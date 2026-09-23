import { GlassPanel } from '@moq-web/app-kit/shell';

export interface RosterEntry {
  peerId: string;
  role: 'host' | 'guest';
  priority: number;
  delivery: 'stream' | 'datagram';
}

interface Props {
  entries: RosterEntry[];
  selfId: string;
}

export function StreamRoster({ entries, selfId }: Props) {
  return (
    <GlassPanel padding="md">
      <div className="ak-heading" style={{ marginBottom: 12 }}>Roster</div>
      <div className="ak-stack" style={{ gap: 8 }}>
        {entries.length === 0 ? (
          <div className="ak-subtle">No participants yet.</div>
        ) : entries.map((p) => (
          <div key={p.peerId} className="ak-row-between" style={{ padding: '8px 0' }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                {p.peerId}{p.peerId === selfId ? ' (you)' : ''}
              </div>
              <div className="ak-subtle" style={{ fontSize: 12 }}>{p.role}</div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <span className="ak-chip ak-chip-neutral">{p.delivery}</span>
              <span className="ak-chip">pri {p.priority}</span>
            </div>
          </div>
        ))}
      </div>
    </GlassPanel>
  );
}
