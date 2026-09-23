import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppShell,
  GlassPanel,
  StatusDot,
  TransportConfigPanel,
  TrickPlayBar,
  useDvrPlayer,
  useTransportActions,
  useTransportConfig,
  type StatusState,
} from '@moq-web/app-kit';
import { BufferMeter } from './components/BufferMeter';
import { AssetPicker, type VodAsset } from './components/AssetPicker';
import { openVodBroadcast, type VodPublishHandle } from './moqt';

const ASSETS: VodAsset[] = [
  { id: 'demo-1', title: 'Nature short (fake)', durationMs: 180_000, sizeBytes: 62_000_000 },
  { id: 'demo-2', title: 'Product intro (fake)', durationMs: 300_000, sizeBytes: 110_000_000 },
  { id: 'demo-3', title: 'Conference recording', durationMs: 3_600_000, sizeBytes: 1_400_000_000 },
];

const CHANNEL_ID = new URLSearchParams(globalThis.location?.search ?? '').get('channel')
  ?? `vod-${Math.random().toString(36).slice(2, 8)}`;

export function App() {
  const [selected, setSelected] = useState<VodAsset>(ASSETS[0]);
  const [publishing, setPublishing] = useState<{ pct: number } | null>(null);
  const [status, setStatus] = useState<StatusState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [receivedChunks, setReceivedChunks] = useState<number>(0);
  const [lastReceiveMs, setLastReceiveMs] = useState<number | null>(null);
  const cfg = useTransportConfig();
  const { applyProfile } = useTransportActions();
  const handleRef = useRef<VodPublishHandle | null>(null);

  useEffect(() => {
    if (cfg.profile === 'interactive') applyProfile('vod');
  }, [cfg.profile, applyProfile]);

  const controls = useDvrPlayer({
    range: { startMs: 0, endMs: selected.durationMs },
    autoPlay: false,
  });

  useEffect(() => {
    controls.setRange({ startMs: 0, endMs: selected.durationMs });
  }, [selected.id, selected.durationMs, controls]);

  const disconnect = useCallback(async () => {
    const h = handleRef.current;
    handleRef.current = null;
    if (h) await h.close();
    setStatus('idle');
    setReceivedChunks(0);
    setLastReceiveMs(null);
  }, []);

  useEffect(() => () => { void disconnect(); }, [disconnect]);

  const connect = useCallback(async () => {
    if (handleRef.current) return handleRef.current;
    setError(null);
    setStatus('connecting');
    try {
      const handle = await openVodBroadcast({
        transport: cfg,
        channel: CHANNEL_ID,
        onProgress: (pct) => setPublishing({ pct }),
        onChunk: (chunk, receivedAtMs) => {
          setReceivedChunks((n) => n + 1);
          setLastReceiveMs(receivedAtMs);
          const bufferedMs = Math.min(selected.durationMs, (chunk.index + 1) * chunk.chunkMs);
          controls.setBuffered(bufferedMs);
        },
        onError: (err) => {
          setError(err.message);
          setStatus('error');
        },
      });
      handleRef.current = handle;
      setStatus('ready');
      return handle;
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
      return null;
    }
  }, [cfg, controls, selected.durationMs]);

  const publishAsset = useCallback(async () => {
    setPublishing({ pct: 0 });
    setReceivedChunks(0);
    const handle = await connect();
    if (!handle) {
      setPublishing(null);
      return;
    }
    try {
      await handle.publishAsset({
        assetId: selected.id,
        durationMs: selected.durationMs,
        sizeBytes: selected.sizeBytes,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPublishing(null);
    }
  }, [connect, selected]);

  const bufferedMs = Math.min(
    selected.durationMs,
    Math.max(controls.state.positionMs, receivedChunks * 1000),
  );

  return (
    <AppShell
      title="VOD · DVR"
      tagline="Publish once over MoQ, seek anywhere. Trick play + smart buffer on real objects."
      actions={
        <StatusDot
          state={status}
          label={
            publishing ? `Publishing ${publishing.pct}%` :
            status === 'ready' ? `Ready · ${CHANNEL_ID}` :
            status === 'connecting' ? 'Connecting…' :
            status === 'error' ? 'Error' : 'Idle'
          }
        />
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(320px, 1fr)', gap: 20 }}>
        <div className="ak-stack">
          {error ? (
            <GlassPanel padding="md">
              <div className="ak-heading" style={{ color: '#f87171', marginBottom: 4 }}>Session error</div>
              <div className="ak-subtle" style={{ fontSize: 12 }}>{error}</div>
            </GlassPanel>
          ) : null}
          <AssetPicker assets={ASSETS} selected={selected} onSelect={setSelected} />
          <GlassPanel strong padding="sm">
            <div
              style={{
                aspectRatio: '16 / 9',
                background:
                  'radial-gradient(70% 90% at 30% 30%, rgba(56,189,248,0.28), transparent 60%), radial-gradient(70% 90% at 70% 70%, rgba(129,140,248,0.28), transparent 55%), #050914',
                borderRadius: 12,
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'rgba(255,255,255,0.65)',
                fontSize: 14,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              {controls.state.isPaused ? '❚❚ paused' : `▶ ${controls.state.rate}× play`} · {receivedChunks} chunks
            </div>
          </GlassPanel>
          <TrickPlayBar controls={controls} showLiveButton={false} />
          <BufferMeter
            positionMs={controls.state.positionMs}
            bufferedMs={bufferedMs}
            durationMs={selected.durationMs}
          />
        </div>
        <div className="ak-stack">
          <GlassPanel padding="md">
            <div className="ak-heading" style={{ marginBottom: 10 }}>Publish</div>
            <div className="ak-subtle" style={{ marginBottom: 12 }}>
              Uploads chunk metadata for the selected asset over MoQ.
              Channel <code>{CHANNEL_ID}</code>.
            </div>
            <button
              className="ak-btn ak-btn-primary"
              disabled={publishing !== null}
              onClick={() => void publishAsset()}
            >
              {publishing ? `Publishing… ${publishing.pct}%` : 'Publish asset'}
            </button>
            {lastReceiveMs !== null ? (
              <div className="ak-caption" style={{ marginTop: 8 }}>
                Last chunk received {new Date(lastReceiveMs).toLocaleTimeString()}
              </div>
            ) : null}
          </GlassPanel>
          <TransportConfigPanel defaultSection="playback" />
        </div>
      </div>
    </AppShell>
  );
}
