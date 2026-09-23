import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppShell,
  GlassPanel,
  StatusDot,
  useTransportActions,
  useTransportConfig,
  type StatusState,
} from '@moq-web/app-kit';
import type { FullCatalog } from '@moq-web/msf';
import { Timeline, type TimelineEntry } from './components/Timeline';
import { StreamRoster, type RosterEntry } from './components/StreamRoster';
import { MediaGrid, type MediaTile } from './components/MediaGrid';
import { EventComposer } from './components/EventComposer';
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
  const [localStream, setLocalStream] = useState<MediaStream | undefined>(undefined);
  const [peerVideoFrames, setPeerVideoFrames] = useState<Map<string, VideoFrame>>(new Map());
  const [peerCatalogs, setPeerCatalogs] = useState<Record<string, FullCatalog>>({});
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);
  const [publishMedia, setPublishMedia] = useState(true);
  const roomRef = useRef<StudioBroadcast | null>(null);
  const startedAtRef = useRef<number>(0);

  const disconnect = useCallback(async () => {
    const r = roomRef.current;
    roomRef.current = null;
    if (r) await r.close();
    setStatus('idle');
    setEntries([]);
    setRoster({});
    setLocalStream(undefined);
    setPeerVideoFrames((prev) => {
      for (const f of prev.values()) try { f.close(); } catch { /* noop */ }
      return new Map();
    });
    setPeerCatalogs({});
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
        publishMedia,
        onPeerJoined: (peerId) => {
          setRoster((cur) => ({ ...cur, [peerId]: { peerId, role: 'guest', delivery: 'stream', priority: cfg.publisher.publisherPriority } }));
        },
        onPeerLeft: (peerId) => {
          setRoster((cur) => {
            const { [peerId]: _drop, ...rest } = cur;
            void _drop;
            return rest;
          });
          setPeerVideoFrames((cur) => {
            const next = new Map(cur);
            const f = next.get(peerId);
            if (f) { try { f.close(); } catch { /* noop */ } }
            next.delete(peerId);
            return next;
          });
          setPeerCatalogs((cur) => {
            const { [peerId]: _drop, ...rest } = cur;
            void _drop;
            return rest;
          });
        },
        onEvent: (peerId, evt) => {
          setEntries((cur) => [...cur, { ...evt, peerId, receivedAt: Date.now() }].slice(-256));
        },
        onPeerVideoFrame: (peerId, frame) => {
          setPeerVideoFrames((cur) => {
            const next = new Map(cur);
            const prev = next.get(peerId);
            if (prev) { try { prev.close(); } catch { /* noop */ } }
            next.set(peerId, frame);
            return next;
          });
        },
        onPeerAudioData: (_peerId, audio) => {
          try { audio.close(); } catch { /* noop */ }
        },
        onPeerCatalog: (peerId, catalog) => {
          setPeerCatalogs((cur) => ({ ...cur, [peerId]: catalog }));
          setEntries((cur) => [...cur, {
            t: Date.now() - startedAtRef.current,
            kind: 'meta' as const,
            label: `catalog from ${peerId}: ${catalog.tracks.length} tracks`,
            peerId,
            receivedAt: Date.now(),
          }].slice(-256));
        },
        onError: (err) => {
          setError(err.message);
          setStatus('error');
        },
      });
      roomRef.current = broadcast;
      setLocalStream(broadcast.getLocalStream());
      setRoster({ [SELF_ID]: { peerId: SELF_ID, role: 'host', delivery: 'stream', priority: cfg.publisher.publisherPriority } });
      setStatus('ready');
      await broadcast.emitEvent({ t: Date.now() - startedAtRef.current, kind: 'join', label: `${SELF_ID} live` });
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
    }
  }, [cfg, disconnect, publishMedia]);

  const emit = useCallback(async (kind: TimelineEvent['kind'], label: string) => {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.emitEvent({ t: Date.now() - startedAtRef.current, kind, label });
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const handleToggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    roomRef.current?.setLocalMuted(next);
  }, [muted]);

  const handleToggleVideo = useCallback(() => {
    const next = !videoOff;
    setVideoOff(next);
    roomRef.current?.setLocalVideoOff(next);
  }, [videoOff]);

  const tiles: MediaTile[] = [
    { peerId: SELF_ID, isSelf: true },
    ...Object.keys(roster).filter((id) => id !== SELF_ID).map((id) => ({ peerId: id, isSelf: false })),
  ];

  const totalPeerTracks = Object.values(peerCatalogs).reduce((n, c) => n + c.tracks.length, 0);
  const isDraft16 = cfg.relay.draft === 'draft-16';

  const shareRoom = useCallback(() => {
    const url = new URL(globalThis.location.href);
    url.searchParams.set('room', ROOM_ID);
    try {
      void navigator.clipboard.writeText(url.toString());
    } catch { /* clipboard may be unavailable */ }
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
          <label className="ak-row" style={{ gap: 6, fontSize: 12 }}>
            <input
              type="checkbox"
              checked={publishMedia}
              onChange={(e) => setPublishMedia(e.target.checked)}
              disabled={status === 'ready' || status === 'connecting'}
            />
            Publish camera / mic
          </label>
          <button
            className="ak-btn ak-btn-ghost"
            onClick={shareRoom}
            title={`Copy https://…?room=${ROOM_ID}`}
          >
            🔗 Share
          </button>
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
              <div className="ak-row-between">
                <div>
                  <div className="ak-heading" style={{ color: '#f87171', marginBottom: 4 }}>Session error</div>
                  <div className="ak-subtle" style={{ fontSize: 12 }}>{error}</div>
                </div>
                <button className="ak-btn ak-btn-ghost" onClick={() => setError(null)}>Dismiss</button>
              </div>
            </GlassPanel>
          ) : null}
          {isDraft16 && status === 'ready' ? (
            <div className="ak-glass" style={{ padding: '8px 12px', fontSize: 12, color: 'var(--ak-fg-muted)' }}>
              ⚠️ Running on draft-16 — namespace subscribe is unsupported, so peers only discover each other via explicit announcements. Switch to draft-18 for full multi-party discovery.
            </div>
          ) : null}
          <MediaGrid
            tiles={tiles}
            localStream={localStream}
            peerVideoFrames={peerVideoFrames}
            muted={muted}
            videoOff={videoOff}
            onToggleMute={handleToggleMute}
            onToggleVideo={handleToggleVideo}
            status={status}
          />
          <Timeline entries={entries} durationMs={60_000} selfId={SELF_ID} />
          <EventComposer onEmit={(kind, label) => void emit(kind, label)} disabled={status !== 'ready'} />
          {totalPeerTracks > 0 ? (
            <GlassPanel padding="md">
              <div className="ak-heading" style={{ marginBottom: 8 }}>Peer catalogs</div>
              <div className="ak-stack" style={{ gap: 8 }}>
                {Object.entries(peerCatalogs).map(([peerId, catalog]) => (
                  <div key={peerId} className="ak-glass" style={{ padding: 10 }}>
                    <div className="ak-caption" style={{ marginBottom: 4 }}>{peerId} · {catalog.tracks.length} tracks</div>
                    <div className="ak-row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {catalog.tracks.map((t, i) => (
                        <span key={i} className="ak-chip ak-chip-neutral" style={{ fontSize: 10 }}>
                          {t.name} · {t.packaging}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </GlassPanel>
          ) : null}
        </div>
        <div className="ak-stack">
          <StreamRoster entries={Object.values(roster)} selfId={SELF_ID} />
        </div>
      </div>
    </AppShell>
  );
}
