import { useState } from 'react';
import {
  AppShell,
  CatalogBuilder,
  GlassPanel,
  TransportConfigPanel,
  type CatalogFieldSpec,
} from '@moq-web/app-kit';

const FIELDS: CatalogFieldSpec[] = [
  { id: 'namespace', label: 'Namespace', type: 'string', defaultValue: 'demo/catalog', description: 'Track namespace to publish under' },
  { id: 'title', label: 'Title', type: 'string', defaultValue: 'Demo stream' },
  { id: 'codec', label: 'Video codec', type: 'string', defaultValue: 'av01.0.05M.08' },
  { id: 'bitrate', label: 'Bitrate (bps)', type: 'number', defaultValue: 2_000_000 },
  { id: 'width', label: 'Width', type: 'number', defaultValue: 1280 },
  { id: 'height', label: 'Height', type: 'number', defaultValue: 720 },
  { id: 'framerate', label: 'Framerate', type: 'number', defaultValue: 30 },
  { id: 'audioCodec', label: 'Audio codec', type: 'string', defaultValue: 'opus' },
  { id: 'e2ee', label: 'End-to-end encrypted', type: 'boolean', defaultValue: false },
  { id: 'lowLatency', label: 'Low-latency track', type: 'boolean', defaultValue: true },
];

interface CatalogEntry {
  timestamp: number;
  payload: Record<string, string | number | boolean>;
}

export function App() {
  const [published, setPublished] = useState<CatalogEntry[]>([]);
  const [subscribed, setSubscribed] = useState<CatalogEntry[]>([]);

  const publish = (values: Record<string, string | number | boolean>) => {
    const entry: CatalogEntry = { timestamp: Date.now(), payload: values };
    setPublished((cur) => [entry, ...cur].slice(0, 20));
    // In-memory loopback: apps that wire a real MoQT adapter would send the
    // catalog over `publish()` and receive it on `subscribe()`. The playground
    // demonstrates the shape end-to-end so you can inspect the round-trip.
    setTimeout(() => setSubscribed((cur) => [entry, ...cur].slice(0, 20)), 200);
  };

  return (
    <AppShell
      title="Catalog playground"
      tagline="Build a catalog, publish it, and see what the subscriber verifies on the other side."
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(320px, 1fr)', gap: 20 }}>
        <div className="ak-stack">
          <CatalogBuilder fields={FIELDS} onPublish={publish} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <GlassPanel padding="md">
              <div className="ak-heading" style={{ marginBottom: 10 }}>Publisher log</div>
              <CatalogList entries={published} accent="var(--ak-accent)" />
            </GlassPanel>
            <GlassPanel padding="md">
              <div className="ak-heading" style={{ marginBottom: 10 }}>Subscriber verified</div>
              <CatalogList entries={subscribed} accent="#10b981" />
            </GlassPanel>
          </div>
        </div>
        <TransportConfigPanel defaultSection="publisher" />
      </div>
    </AppShell>
  );
}

function CatalogList({ entries, accent }: { entries: CatalogEntry[]; accent: string }) {
  if (entries.length === 0) return <div className="ak-subtle">Nothing yet.</div>;
  return (
    <div className="ak-stack" style={{ gap: 10 }}>
      {entries.map((e) => (
        <div
          key={e.timestamp}
          className="ak-glass"
          style={{ padding: 12, borderLeft: `3px solid ${accent}` }}
        >
          <div className="ak-caption">{new Date(e.timestamp).toLocaleTimeString()}</div>
          <pre style={{ margin: 0, fontSize: 12, overflowX: 'auto' }}>
            {JSON.stringify(e.payload, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}
