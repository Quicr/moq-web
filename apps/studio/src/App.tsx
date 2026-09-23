import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppShell,
  GlassPanel,
  StatusDot,
  TrickPlayBar,
  useDvrPlayer,
  useTransportActions,
  useTransportConfig,
  type StatusState,
} from '@moq-web/app-kit';
import { Timeline, type TimelineEntry } from './components/Timeline';
import { StreamRoster, type RosterEntry } from './components/StreamRoster';
import { openStudioBroadcast, type StudioBroadcast, type TimelineEvent } from './moqt';

const ROOM_ID = new URLSearchParams(globalThis.location?.search ?? '').get('room') ?? 'default';
const SELF_ID = `host-${Math.random().toString(36).slice(2, 8)}`;

export function App() {
  const cfg = useTransportConfig();
  const { applyProfile } = useTransportActions();

  useEffect(() => {
    if (cfg.profile === 'interactive') applyProfile('live-streaming');
  }, [cfg.profile, applyProfile]);

  const [status, setStatus] = useState<StatusState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [roster, setRoster] = useState<Record<string, RosterEntry>>({});
  const roomRef = useRef<StudioBroadcast | null>(null);
  const startedAtRef = useRef<number>(0);

  const controls = useDvrPlayer({
    range: { startMs: 0, endMs: 60_000, liveEdgeMs: 60_000 },
    autoPlay: true,
  });

  const disconnect = useCallback(async () => {
    const r = roomRef.current;
    roomRef.current = null;
    if (r) await r.close();
    setStatus('idle');
    setEntries([]);
    setRoster({});
  }, []);

  useEffect(() => () => { void disconnect(); }, [disconnect]);

  const connect = useCallback(async () => {
    await disconnect();
    setError(null);
    setStatus('connecting');
    startedAtRef.current = Date.now();
    try {
      const broadcast = await openStudioBroadcast({
        transport: cfg,
        roomId: ROOM_ID,
        selfId: SELF_ID,
        onPeerJoined: (peerId) => {
          setRoster((cur) => ({ ...cur, [peerId]: { peerId, role: peerId === SELF_ID ? 'host' : 'guest', delivery: 'stream', priority: cfg.publisher.publisherPriority } }));
        },
        onPeerLeft: (peerId) => {
          setRoster((cur) => {
            const { [peerId]: _drop, ...rest } = cur;
            void _drop;
            return rest;
          });
        },
        onEvent: (peerId, evt) => {
          setEntries((cur) => [...cur, { ...evt, peerId, receivedAt: Date.now() }].slice(-256));
        },
        onError: (err) => {
          setError(err.message);
          setStatus('error');
        },
      });
      roomRef.current = broadcast;
      setRoster({ [SELF_ID]: { peerId: SELF_ID, role: 'host', delivery: 'stream', priority: cfg.publisher.publisherPriority } });
      setStatus('ready');
      await broadcast.emitEvent({ t: Date.now() - startedAtRef.current, kind: 'join', label: `${SELF_ID} live` });
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
    }
  }, [cfg, disconnect]);

  const emit = useCallback(async (kind: TimelineEvent['kind'], label: string) => {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.emitEvent({ t: Date.now() - startedAtRef.current, kind, label });
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  return (
    <AppShell
      title="Studio · watch party"
      tagline="Live streaming with MSF, event + media timelines. Powered by @moq-web/session."
      actions={
        <>
          <StatusDot state={status} label={
            status === 'ready' ? `Live · ${SELF_ID}` :
            status === 'connecting' ? 'Connecting…' :
            status === 'error' ? 'Error' : 'Idle'
          } />
          <button
            className="ak-btn ak-btn-primary"
            onClick={() => (status === 'ready' ? void disconnect() : void connect())}
          >
            {status === 'ready' ? 'Stop' : 'Go live'}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(280px, 1fr)', gap: 20 }}>
        <div className="ak-stack">
          {error ? (
            <GlassPanel padding="md">
              <div className="ak-heading" style={{ color: '#f87171', marginBottom: 4 }}>Session error</div>
              <div className="ak-subtle" style={{ fontSize: 12 }}>{error}</div>
            </GlassPanel>
          ) : null}
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
                {status === 'ready' ? `● Live · room=${ROOM_ID}` : 'Press “Go live” to open a MoQ session'}
              </div>
            </div>
          </GlassPanel>
          <TrickPlayBar controls={controls} />
          <Timeline entries={entries} durationMs={60_000} selfId={SELF_ID} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="ak-btn" disabled={status !== 'ready'} onClick={() => void emit('delta', 'Bitrate step-up')}>+ Bitrate delta</button>
            <button className="ak-btn" disabled={status !== 'ready'} onClick={() => void emit('meta', 'Slide change')}>+ Slide change</button>
            <button className="ak-btn" disabled={status !== 'ready'} onClick={() => void emit('meta', 'Q&A open')}>+ Q&A open</button>
          </div>
        </div>
        <div className="ak-stack">
          <StreamRoster entries={Object.values(roster)} selfId={SELF_ID} />
        </div>
      </div>
    </AppShell>
  );
}
