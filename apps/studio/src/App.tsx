import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppShell,
  GlassPanel,
  StatusDot,
  isCloudflareCatEnabled,
  useTransportActions,
  useTransportConfig,
  type GroupPtsPoint,
  type StatusState,
} from '@moq-web/app-kit';
import type { FullCatalog } from '@moq-web/msf';
import { Timeline, type TimelineEntry } from './components/Timeline';
import { StreamRoster, type RosterEntry } from './components/StreamRoster';
import { MediaGrid, type MediaTile } from './components/MediaGrid';
import { EventComposer } from './components/EventComposer';
import { PeerDvrPanel } from './components/PeerDvrPanel';
import { LoginPanel } from './components/LoginPanel';
import { RoomPicker } from './components/RoomPicker';
import { openStudioBroadcast, type PeerDvrHandle, type StudioBroadcast, type TimelineEvent } from './moqt';
import { loadSession, MoatAuthError, mintCat, saveSession, type MoatSession, type StudioRoom } from './moat';

const INITIAL_PARAMS = new URLSearchParams(globalThis.location?.search ?? '');
const INITIAL_ROOM_ID = INITIAL_PARAMS.get('room') ?? 'default';
const INITIAL_CONFIG = INITIAL_PARAMS.get('config');
const SELF_ID = `host-${Math.random().toString(36).slice(2, 8)}`;

// Diff two peer-catalog snapshots and describe the change in human-readable
// form. The subscriber applies MSF deltas internally and re-fires the full
// catalog on every mutation, so the delta itself is not surfaced here — we
// reconstruct it by comparing the previous full snapshot.
function diffCatalogs(prev: FullCatalog | undefined, next: FullCatalog): string[] {
  if (!prev) return [`+catalog · ${next.tracks.length} tracks`];
  const msgs: string[] = [];
  const prevByName = new Map(prev.tracks.map((t) => [t.name, t]));
  const nextByName = new Map(next.tracks.map((t) => [t.name, t]));
  for (const [name, t] of nextByName) {
    const p = prevByName.get(name);
    if (!p) { msgs.push(`+${name} (${t.packaging})`); continue; }
    if (p.isLive !== t.isLive) msgs.push(`~${name} isLive→${t.isLive}`);
  }
  for (const name of prevByName.keys()) {
    if (!nextByName.has(name)) msgs.push(`-${name}`);
  }
  return msgs;
}

export function App() {
  const cfg = useTransportConfig();
  const {
    applyProfile, setRelay, setPublisher, setSubscriber, setPlayback, setTargetLatency,
    setAuthProvider, setAuthProviderState,
  } = useTransportActions();

  useEffect(() => {
    if (cfg.profile === 'interactive') applyProfile('live-streaming');
  }, [cfg.profile, applyProfile]);

  // Apply config from URL params (e.g. from shared link)
  useEffect(() => {
    if (!INITIAL_CONFIG) return;
    try {
      const shared = JSON.parse(atob(INITIAL_CONFIG));
      if (shared.profile) applyProfile(shared.profile);
      if (shared.relay) setRelay(shared.relay);
      if (shared.publisher) setPublisher(shared.publisher);
      if (shared.subscriber) setSubscriber(shared.subscriber);
      if (shared.playback) setPlayback(shared.playback);
      if (shared.targetLatencyMs != null) setTargetLatency(shared.targetLatencyMs);
      if (typeof shared.auth?.providerId === 'string') {
        setAuthProvider(shared.auth.providerId);
        if (shared.auth.providerState) setAuthProviderState(shared.auth.providerState);
      }
    } catch { /* ignore malformed config */ }
  }, [applyProfile, setRelay, setPublisher, setSubscriber, setPlayback, setTargetLatency, setAuthProvider, setAuthProviderState]);

  // C4M mode: the relay requires a CAT, so identity + rooms come from moat
  // (sign-in gate, room directory) instead of the free-text room field.
  const catRequired = isCloudflareCatEnabled(cfg.auth);
  const [moatSession, setMoatSession] = useState<MoatSession | null>(() => loadSession());
  const [catRoom, setCatRoom] = useState<StudioRoom | null>(null);
  const [liveRoomId, setLiveRoomId] = useState<string | null>(null);
  // Set when the user picks another room while live: leave + join on next render.
  const [switchPending, setSwitchPending] = useState(false);
  const [freeRoomId, setFreeRoomId] = useState<string>(INITIAL_ROOM_ID);
  const roomId = catRequired ? (catRoom?.slug ?? '') : freeRoomId;
  const [status, setStatus] = useState<StatusState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [roster, setRoster] = useState<Record<string, RosterEntry>>({});
  const [localStream, setLocalStream] = useState<MediaStream | undefined>(undefined);
  const [peerVideoFrames, setPeerVideoFrames] = useState<Map<string, VideoFrame>>(new Map());
  const [peerCatalogs, setPeerCatalogs] = useState<Record<string, FullCatalog>>({});
  const [catalogLog, setCatalogLog] = useState<Array<{ t: number; peerId: string; msg: string }>>([]);
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);
  const [publishMedia, setPublishMedia] = useState(true);
  const [peerTimelines, setPeerTimelines] = useState<Record<string, GroupPtsPoint[]>>({});
  const [dvrPeer, setDvrPeer] = useState<string | null>(null);
  const [dvrHandle, setDvrHandle] = useState<PeerDvrHandle | null>(null);
  const roomRef = useRef<StudioBroadcast | null>(null);
  const startedAtRef = useRef<number>(0);

  const disconnect = useCallback(async () => {
    const r = roomRef.current;
    roomRef.current = null;
    if (r) await r.close();
    setLiveRoomId(null);
    setStatus('idle');
    setEntries([]);
    setRoster({});
    setLocalStream(undefined);
    setPeerVideoFrames((prev) => {
      for (const f of prev.values()) try { f.close(); } catch { /* noop */ }
      return new Map();
    });
    setPeerCatalogs({});
    setCatalogLog([]);
    setPeerTimelines({});
    setDvrPeer(null);
    if (dvrHandle) void dvrHandle.stop();
    setDvrHandle(null);
  }, [dvrHandle]);

  useEffect(() => () => { void disconnect(); }, [disconnect]);

  const signIn = useCallback((s: MoatSession) => {
    saveSession(s);
    setMoatSession(s);
  }, []);

  const signOut = useCallback(() => {
    void disconnect();
    saveSession(null);
    setMoatSession(null);
    setCatRoom(null);
  }, [disconnect]);

  const connect = useCallback(async () => {
    await disconnect();
    setError(null);
    setStatus('connecting');
    startedAtRef.current = Date.now();
    try {
      let authToken: { raw: string; type: number } | undefined;
      if (catRequired) {
        if (!moatSession || !catRoom) throw new Error('Sign in and pick a room first');
        // Fresh CAT per connect: scoped to this room, short-lived (moat default 1h).
        authToken = await mintCat(moatSession, catRoom);
      }
      const broadcast = await openStudioBroadcast({
        transport: cfg,
        roomId,
        selfId: SELF_ID,
        publishMedia,
        authToken,
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
          setPeerTimelines((cur) => {
            const { [peerId]: _drop, ...rest } = cur;
            void _drop;
            return rest;
          });
          if (dvrPeer === peerId) {
            setDvrPeer(null);
            if (dvrHandle) void dvrHandle.stop();
            setDvrHandle(null);
          }
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
        onPeerMediaTimeline: (peerId, point) => {
          setPeerTimelines((cur) => {
            const prev = cur[peerId] ?? [];
            const g = typeof point.groupId === 'bigint' ? Number(point.groupId) : point.groupId;
            if (prev.some((p) => p.groupId === g)) return cur;
            return { ...cur, [peerId]: [...prev, { groupId: g, ptsMs: point.mediaPTS }] };
          });
        },
        onPeerCatalog: (peerId, catalog) => {
          setPeerCatalogs((cur) => {
            const prev = cur[peerId];
            const changes = diffCatalogs(prev, catalog);
            if (changes.length > 0) {
              const now = Date.now();
              setCatalogLog((log) => [
                ...changes.map((msg) => ({ t: now, peerId, msg })),
                ...log,
              ].slice(0, 64));
            }
            return { ...cur, [peerId]: catalog };
          });
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
      // Merge — don't replace. Peers whose NAMESPACE arrived during the
      // openStudioBroadcast await already sit in `roster` via onPeerJoined;
      // an object-literal setRoster here would wipe them and drop their tiles.
      setRoster((cur) => ({
        ...cur,
        [SELF_ID]: { peerId: SELF_ID, role: 'host', delivery: 'stream', priority: cfg.publisher.publisherPriority },
      }));
      setLiveRoomId(catRequired ? (catRoom?.id ?? null) : null);
      setStatus('ready');
      await broadcast.emitEvent({ t: Date.now() - startedAtRef.current, kind: 'join', label: `${SELF_ID} live` });
    } catch (err) {
      if (err instanceof MoatAuthError) {
        saveSession(null);
        setMoatSession(null);
      }
      setError((err as Error).message);
      setStatus('error');
    }
  }, [cfg, disconnect, publishMedia, roomId, catRequired, moatSession, catRoom]);

  // Picking a room: while live in another room, leave it and join the new one.
  const selectRoom = useCallback((room: StudioRoom) => {
    setCatRoom(room);
    if (liveRoomId && liveRoomId !== room.id) setSwitchPending(true);
  }, [liveRoomId]);

  useEffect(() => {
    if (!switchPending || !catRoom) return;
    setSwitchPending(false);
    void connect(); // connect() disconnects the current room first
  }, [switchPending, catRoom, connect]);

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

  const handleToggleDvr = useCallback((peerId: string) => {
    const room = roomRef.current;
    if (!room) return;
    // Already rewinding this peer — return to live.
    if (dvrPeer === peerId) {
      if (dvrHandle) void dvrHandle.stop();
      setDvrHandle(null);
      setDvrPeer(null);
      return;
    }
    // Switching peers: stop the previous DVR first.
    if (dvrHandle) void dvrHandle.stop();
    const catalog = peerCatalogs[peerId];
    if (!catalog) return;
    const handle = room.startPeerDvr(peerId, {
      onDvrFrame: (frame) => { try { frame.close(); } catch { /* noop */ } },
      catalog,
    });
    if (!handle) return;
    setDvrHandle(handle);
    setDvrPeer(peerId);
  }, [dvrPeer, dvrHandle, peerCatalogs]);

  const peerHasVideo = (peerId: string): boolean => {
    const cat = peerCatalogs[peerId];
    if (!cat) return false;
    return cat.tracks.some((t) => t.name === 'video');
  };

  const tiles: MediaTile[] = [
    ...(publishMedia ? [{ peerId: SELF_ID, isSelf: true }] : []),
    ...Object.keys(roster)
      .filter((id) => id !== SELF_ID && peerHasVideo(id))
      .map((id) => ({ peerId: id, isSelf: false })),
  ];

  const totalPeerTracks = Object.values(peerCatalogs).reduce((n, c) => n + c.tracks.length, 0);
  const isDraft16 = cfg.relay.draft === 'draft-16';

  const shareRoom = useCallback(() => {
    const url = new URL(globalThis.location.href);
    url.searchParams.set('room', roomId);
    const shared = {
      profile: cfg.profile,
      relay: cfg.relay,
      publisher: cfg.publisher,
      subscriber: cfg.subscriber,
      playback: cfg.playback,
      targetLatencyMs: cfg.targetLatencyMs,
      // C4M rooms: the recipient needs the relay connection token too. It only
      // selects the relay; without a CAT (sign-in + room) the relay refuses
      // the session, so the token is only shared when C4M is required.
      ...(catRequired ? {
        auth: {
          providerId: cfg.auth.providerId,
          providerState: { relayJwt: (cfg.auth.providerState as { relayJwt?: string }).relayJwt, catEnabled: true },
        },
      } : {}),
    };
    url.searchParams.set('config', btoa(JSON.stringify(shared)));
    try {
      void navigator.clipboard.writeText(url.toString());
    } catch { /* clipboard may be unavailable */ }
  }, [roomId, cfg, catRequired]);

  useEffect(() => {
    if (!roomId) return; // C4M mode before a room is picked: keep ?room= for preselect
    const url = new URL(globalThis.location.href);
    const current = url.searchParams.get('room') ?? '';
    if (current !== roomId) {
      url.searchParams.set('room', roomId);
      globalThis.history?.replaceState(null, '', url.toString());
    }
  }, [roomId]);

  const roomLocked = status === 'ready' || status === 'connecting';
  const canGoLive = !catRequired || (moatSession !== null && catRoom !== null);

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
          }
            relayUrl={cfg.relay.relays[0]}
            draft={cfg.relay.draft}
            error={error}
          />
          {catRequired ? (
            <span className="ak-row" style={{ gap: 6, fontSize: 12 }}>
              <span className="ak-subtle">Room</span>
              <b>{catRoom ? catRoom.name : moatSession ? 'pick a room' : 'sign in'}</b>
            </span>
          ) : (
            <label className="ak-row" style={{ gap: 6, fontSize: 12 }}>
              <span className="ak-subtle">Room</span>
              <input
                className="ak-input"
                style={{ width: 120, fontSize: 12, padding: '4px 8px' }}
                value={freeRoomId}
                onChange={(e) => setFreeRoomId(e.target.value.trim() || 'default')}
                disabled={roomLocked}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                placeholder="room"
                title={roomLocked ? 'Disconnect to change the room' : 'Type a room name to join a different room'}
              />
            </label>
          )}
          <label className="ak-row" style={{ gap: 6, fontSize: 12 }}>
            <input
              type="checkbox"
              checked={publishMedia}
              onChange={(e) => setPublishMedia(e.target.checked)}
              disabled={roomLocked}
            />
            Publish camera / mic
          </label>
          <button
            className="ak-btn ak-btn-ghost"
            onClick={shareRoom}
            title={`Copy https://…?room=${roomId}`}
          >
            🔗 Share
          </button>
          <button
            className="ak-btn ak-btn-primary"
            onClick={() => (status === 'ready' ? void disconnect() : void connect())}
            disabled={status !== 'ready' && !canGoLive}
            title={canGoLive ? undefined : 'Sign in and pick a room first'}
          >
            {catRequired
              ? (status === 'ready' ? 'Leave room' : 'Join room')
              : (status === 'ready' ? 'Stop' : 'Go live')}
          </button>
        </>
      }
    >
      <div className="studio-grid" style={{ display: 'grid', gap: 20 }}>
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
          {catRequired && !moatSession ? <LoginPanel onSignedIn={signIn} /> : null}
          {catRequired && moatSession ? (
            <RoomPicker
              session={moatSession}
              selected={catRoom}
              liveRoomId={liveRoomId}
              initialSlug={INITIAL_PARAMS.get('room')}
              disabled={status === 'connecting'}
              onSelect={selectRoom}
              onSignOut={signOut}
            />
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
            dvrPeer={dvrPeer}
            onToggleDvr={handleToggleDvr}
          />
          {dvrPeer && dvrHandle ? (
            <PeerDvrPanel
              peerId={dvrPeer}
              handle={dvrHandle}
              timeline={peerTimelines[dvrPeer] ?? []}
              liveEdgeMs={(peerTimelines[dvrPeer]?.at(-1)?.ptsMs) ?? 0}
              onClose={() => handleToggleDvr(dvrPeer)}
            />
          ) : null}
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
          {catalogLog.length > 0 ? (
            <GlassPanel padding="md">
              <div className="ak-heading" style={{ marginBottom: 6 }}>Catalog deltas</div>
              <div
                className="ak-stack"
                style={{
                  gap: 4,
                  maxHeight: 220,
                  overflowY: 'auto',
                  fontFamily: 'ui-monospace, monospace',
                  fontSize: 11,
                }}
              >
                {catalogLog.map((e, i) => (
                  <div key={i} className="ak-row" style={{ gap: 6 }}>
                    <span className="ak-subtle" style={{ minWidth: 62 }}>
                      {new Date(e.t).toLocaleTimeString().slice(-8)}
                    </span>
                    <span className="ak-chip ak-chip-neutral" style={{ fontSize: 10 }}>{e.peerId}</span>
                    <span>{e.msg}</span>
                  </div>
                ))}
              </div>
            </GlassPanel>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}
