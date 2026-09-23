import { GlassPanel } from '@moq-web/app-kit/shell';

const PARTICIPANTS = [
  { name: 'Producer', role: 'host', priority: 32, delivery: 'stream' as const },
  { name: 'Guest · A', role: 'speaker', priority: 64, delivery: 'stream' as const },
  { name: 'Guest · B', role: 'speaker', priority: 96, delivery: 'datagram' as const },
];

export function StreamRoster() {
  return (
    <GlassPanel padding="md">
      <div className="ak-heading" style={{ marginBottom: 12 }}>Roster</div>
      <div className="ak-stack" style={{ gap: 8 }}>
        {PARTICIPANTS.map((p) => (
          <div key={p.name} className="ak-row-between" style={{ padding: '8px 0' }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div>
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
