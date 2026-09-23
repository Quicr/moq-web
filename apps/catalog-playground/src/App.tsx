import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppShell,
  CatalogBuilder,
  GlassPanel,
  StatusDot,
  TransportConfigPanel,
  useTransportConfig,
  type CatalogFieldSpec,
  type StatusState,
} from '@moq-web/app-kit';
import { openCatalogRoundTrip, type CatalogRoundTrip } from './moqt';

const FIELDS: CatalogFieldSpec[] = [
  { id: 'namespace', label: 'Namespace suffix', type: 'string', defaultValue: `demo-${Math.random().toString(36).slice(2, 8)}`, description: 'Appended to catalog-playground/ to isolate this session' },
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
  id: string;
  timestamp: number;
  groupId: number;
  objectId: number;
  payload: Record<string, string | number | boolean>;
}

export function App() {
  const cfg = useTransportConfig();
  const [status, setStatus] = useState<StatusState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<CatalogEntry[]>([]);
  const [subscribed, setSubscribed] = useState<CatalogEntry[]>([]);
  const [namespace, setNamespace] = useState<string>('');
  const roomRef = useRef<CatalogRoundTrip | null>(null);

  const disconnect = useCallback(async () => {
    const r = roomRef.current;
    roomRef.current = null;
    if (r) await r.close();
    setStatus('idle');
    setNamespace('');
  }, []);

  useEffect(() => () => { void disconnect(); }, [disconnect]);

  const connect = useCallback(async (nsSuffix: string) => {
    await disconnect();
    setError(null);
    setStatus('connecting');
    const ns = ['catalog-playground', nsSuffix];
    try {
      const room = await openCatalogRoundTrip({
        transport: cfg,
        namespace: ns,
        onPublished: (payload, groupId, objectId) => {
          setPublished((cur) => [
            { id: `${groupId}-${objectId}-p`, timestamp: Date.now(), groupId, objectId, payload },
            ...cur,
          ].slice(0, 30));
        },
        onReceived: (payload, groupId, objectId) => {
          setSubscribed((cur) => [
            { id: `${groupId}-${objectId}-s`, timestamp: Date.now(), groupId, objectId, payload },
            ...cur,
          ].slice(0, 30));
        },
        onError: (err) => {
          setError(err.message);
          setStatus('error');
        },
      });
      roomRef.current = room;
      setNamespace(ns.join('/'));
      setStatus('ready');
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
    }
  }, [cfg, disconnect]);

  const onPublish = useCallback(async (values: Record<string, string | number | boolean>) => {
    let room = roomRef.current;
    const nsSuffix = String(values.namespace ?? 'demo');
    if (!room) {
      await connect(nsSuffix);
      room = roomRef.current;
      if (!room) return;
    }
    try {
      await room.publish(values);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [connect]);

  return (
    <AppShell
      title="Catalog playground"
      tagline="Publish a catalog to the relay, then verify what the subscriber receives on the round-trip."
      actions={
        <>
          <StatusDot state={status} label={
            status === 'ready' ? `Connected · ${namespace}` :
            status === 'connecting' ? 'Connecting…' :
            status === 'error' ? 'Error' : 'Idle'
          } />
          {status === 'ready' ? (
            <button className="ak-btn" onClick={() => void disconnect()}>Disconnect</button>
          ) : null}
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(320px, 1fr)', gap: 20 }}>
        <div className="ak-stack">
          {error ? (
            <GlassPanel padding="md">
              <div className="ak-heading" style={{ color: '#f87171', marginBottom: 4 }}>Connection error</div>
              <div className="ak-subtle" style={{ fontSize: 12 }}>{error}</div>
            </GlassPanel>
          ) : null}
          <CatalogBuilder fields={FIELDS} onPublish={onPublish} />
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
          key={e.id}
          className="ak-glass"
          style={{ padding: 12, borderLeft: `3px solid ${accent}` }}
        >
          <div className="ak-caption">
            {new Date(e.timestamp).toLocaleTimeString()} · g{e.groupId} · o{e.objectId}
          </div>
          <pre style={{ margin: 0, fontSize: 12, overflowX: 'auto' }}>
            {JSON.stringify(e.payload, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}
