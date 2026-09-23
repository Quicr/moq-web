import { useEffect, useState } from 'react';
import {
  AppShell,
  GlassPanel,
  StatusDot,
  TransportConfigPanel,
  TrickPlayBar,
  useDvrPlayer,
  useTransportActions,
  useTransportConfig,
} from '@moq-web/app-kit';
import { BufferMeter } from './components/BufferMeter';
import { AssetPicker, type VodAsset } from './components/AssetPicker';

const ASSETS: VodAsset[] = [
  { id: 'demo-1', title: 'Nature short (fake)', durationMs: 180_000, sizeBytes: 62_000_000 },
  { id: 'demo-2', title: 'Product intro (fake)', durationMs: 300_000, sizeBytes: 110_000_000 },
  { id: 'demo-3', title: 'Conference recording', durationMs: 3_600_000, sizeBytes: 1_400_000_000 },
];

export function App() {
  const [selected, setSelected] = useState<VodAsset>(ASSETS[0]);
  const [uploading, setUploading] = useState<{ pct: number } | null>(null);
  const cfg = useTransportConfig();
  const { applyProfile } = useTransportActions();

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

  const buffered = Math.min(
    selected.durationMs,
    controls.state.positionMs + cfg.playback.jitterBufferDelay * 20,
  );

  return (
    <AppShell
      title="VOD · DVR"
      tagline="Publish once, seek anywhere. Trick play + smart buffer over MoQT fetch."
      actions={
        <StatusDot
          state={uploading ? 'connecting' : 'ready'}
          label={uploading ? `Publishing ${uploading.pct}%` : 'Ready'}
        />
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(320px, 1fr)', gap: 20 }}>
        <div className="ak-stack">
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
              {controls.state.isPaused ? '❚❚ paused' : `▶ ${controls.state.rate}× play`}
            </div>
          </GlassPanel>
          <TrickPlayBar controls={controls} showLiveButton={false} />
          <BufferMeter
            positionMs={controls.state.positionMs}
            bufferedMs={buffered}
            durationMs={selected.durationMs}
          />
        </div>
        <div className="ak-stack">
          <GlassPanel padding="md">
            <div className="ak-heading" style={{ marginBottom: 10 }}>Publish</div>
            <div className="ak-subtle" style={{ marginBottom: 12 }}>
              Simulates uploading the selected asset over MoQT.
            </div>
            <button
              className="ak-btn ak-btn-primary"
              disabled={uploading !== null}
              onClick={() => {
                setUploading({ pct: 0 });
                let pct = 0;
                const id = setInterval(() => {
                  pct += 5;
                  setUploading({ pct });
                  if (pct >= 100) {
                    clearInterval(id);
                    setUploading(null);
                  }
                }, 120);
              }}
            >
              {uploading ? `Publishing… ${uploading.pct}%` : 'Publish asset'}
            </button>
          </GlassPanel>
          <TransportConfigPanel defaultSection="playback" />
        </div>
      </div>
    </AppShell>
  );
}
