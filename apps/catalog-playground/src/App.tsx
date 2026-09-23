import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppShell,
  GlassPanel,
  MsfCatalogBuilder,
  StatusDot,
  useTransportConfig,
  type StatusState,
} from '@moq-web/app-kit';
import type { FullCatalog } from '@moq-web/msf';
import { openCatalogRoundTrip, type CatalogRoundTrip } from './moqt';

interface CatalogEntry {
  id: string;
  timestamp: number;
  groupId: number;
  objectId: number;
  payload: unknown;
}

const NAMESPACE_SUFFIX = `demo-${Math.random().toString(36).slice(2, 8)}`;

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

  const connect = useCallback(async () => {
    if (roomRef.current) return roomRef.current;
    setError(null);
    setStatus('connecting');
    const ns = ['catalog-playground', NAMESPACE_SUFFIX];
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
      return room;
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
      return null;
    }
  }, [cfg]);

  const onPublish = useCallback(async (_catalog: FullCatalog, serialized: string) => {
    let room = roomRef.current;
    if (!room) {
      room = await connect();
      if (!room) return;
    }
    await room.publish(serialized);
  }, [connect]);

  return (
    <AppShell
      title="Catalog playground"
      tagline="Build a full MSF catalog, publish it, and verify the subscriber round-trip."
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
      <div className="ak-stack">
        {error ? (
          <GlassPanel padding="md">
            <div className="ak-heading" style={{ color: '#f87171', marginBottom: 4 }}>Connection error</div>
            <div className="ak-subtle" style={{ fontSize: 12 }}>{error}</div>
          </GlassPanel>
        ) : null}
        <MsfCatalogBuilder onPublish={onPublish} />
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
          <pre style={{ margin: 0, fontSize: 11, overflowX: 'auto', maxHeight: 200 }}>
            {JSON.stringify(e.payload, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}
