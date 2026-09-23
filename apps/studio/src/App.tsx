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
import { Timeline } from './components/Timeline';
import { StreamRoster } from './components/StreamRoster';

export function App() {
  const cfg = useTransportConfig();
  const { applyProfile } = useTransportActions();

  // Studio defaults to live-streaming profile on first mount.
  useEffect(() => {
    if (cfg.profile === 'interactive') applyProfile('live-streaming');
  }, [cfg.profile, applyProfile]);

  const [connected, setConnected] = useState(false);
  const controls = useDvrPlayer({
    range: { startMs: 0, endMs: 60_000, liveEdgeMs: 60_000 },
    autoPlay: true,
  });

  return (
    <AppShell
      title="Studio · watch party"
      tagline="Live streaming with MSF, event + media timelines, and deltas"
      actions={
        <>
          <StatusDot state={connected ? 'ready' : 'idle'} label={connected ? 'Live' : 'Idle'} />
          <button
            className="ak-btn ak-btn-primary"
            onClick={() => setConnected((v) => !v)}
          >
            {connected ? 'Stop' : 'Go live'}
          </button>
        </>
      }
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 3fr) minmax(280px, 1fr)',
          gap: 20,
        }}
      >
        <div className="ak-stack">
          <GlassPanel strong padding="sm">
            <div
              style={{
                aspectRatio: '16 / 9',
                background:
                  'radial-gradient(60% 80% at 30% 40%, rgba(129, 140, 248, 0.35), transparent 60%), radial-gradient(80% 60% at 80% 60%, rgba(236, 72, 153, 0.30), transparent 55%), #050914',
                borderRadius: 12,
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'rgba(255,255,255,0.6)',
                  fontSize: 14,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                }}
              >
                {connected ? '● Live preview' : 'Press “Go live” to start streaming'}
              </div>
            </div>
          </GlassPanel>
          <TrickPlayBar controls={controls} />
          <Timeline positionMs={controls.state.positionMs} durationMs={60_000} />
        </div>
        <div className="ak-stack">
          <StreamRoster />
          <GlassPanel padding="md">
            <div className="ak-heading" style={{ marginBottom: 10 }}>Transport</div>
            <TransportConfigPanel defaultSection="profile" />
          </GlassPanel>
        </div>
      </div>
    </AppShell>
  );
}
