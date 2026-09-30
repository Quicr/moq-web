import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppShell,
  FetchProgressTrack,
  FetchStatsFooter,
  GlassPanel,
  StatusDot,
  TrickPlayBar,
  useDvrPlayer,
  useSawtoothFetch,
  useTransportActions,
  useTransportConfig,
  type GroupPtsPoint,
  type StatusState,
} from '@moq-web/app-kit';
import { SubscribePipeline } from '@moq-web/media';
import { publishVodAsset, type VodPublishHandle, type VodPublishStats } from './publish/vod-publisher';
import { openVodViewer, type VodViewerHandle } from './moqt';

const SAMPLE_URLS = [
  {
    id: 'bbb-30s',
    title: 'Big Buck Bunny (30 s H.264)',
    url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4',
  },
  {
    id: 'sintel-5s',
    title: 'Sintel (5 s clip)',
    url: 'https://test-videos.co.uk/vids/sintel/mp4/h264/720/Sintel_720_10s_1MB.mp4',
  },
  {
    id: 'jellyfish-5s',
    title: 'Jellyfish (5 s clip)',
    url: 'https://test-videos.co.uk/vids/jellyfish/mp4/h264/720/Jellyfish_720_10s_1MB.mp4',
  },
];

const CHANNEL_ID = new URLSearchParams(globalThis.location?.search ?? '').get('channel')
  ?? `vod-${Math.random().toString(36).slice(2, 8)}`;

interface AssetInfo {
  durationMs: number;
  codec: string;
  width: number;
  height: number;
}

export function App() {
  const [status, setStatus] = useState<StatusState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [publishStats, setPublishStats] = useState<VodPublishStats | null>(null);
  const [assetInfo, setAssetInfo] = useState<AssetInfo | null>(null);
  const [urlInput, setUrlInput] = useState(SAMPLE_URLS[0].url);
  const [timeline, setTimeline] = useState<GroupPtsPoint[]>([]);
  const cfg = useTransportConfig();
  const { applyProfile } = useTransportActions();

  const publishHandleRef = useRef<VodPublishHandle | null>(null);
  const viewerHandleRef = useRef<VodViewerHandle | null>(null);
  const pipelineRef = useRef<SubscribePipeline | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (cfg.profile === 'interactive') applyProfile('vod');
  }, [cfg.profile, applyProfile]);

  const controls = useDvrPlayer({
    range: { startMs: 0, endMs: assetInfo?.durationMs ?? 0 },
    autoPlay: false,
  });

  useEffect(() => {
    if (assetInfo) {
      controls.setRange({ startMs: 0, endMs: assetInfo.durationMs });
    }
  }, [assetInfo?.durationMs]);

  const bufferedGroupsToMs = useMemo(() => {
    if (timeline.length === 0) return [];
    return timeline.map((p, i) => ({
      startMs: p.ptsMs,
      endMs: timeline[i + 1]?.ptsMs ?? (assetInfo?.durationMs ?? p.ptsMs + 2000),
    }));
  }, [timeline, assetInfo?.durationMs]);

  const drawFrame = useCallback((frame: VideoFrame) => {
    const canvas = canvasRef.current;
    if (!canvas) { frame.close(); return; }
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
    }
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.drawImage(frame, 0, 0);
    frame.close();
  }, []);

  const ensureViewer = useCallback(async (): Promise<VodViewerHandle> => {
    if (viewerHandleRef.current) return viewerHandleRef.current;
    const viewer = await openVodViewer({
      transport: cfg,
      channel: CHANNEL_ID,
      onError: (err) => { setError(err.message); setStatus('error'); },
    });
    viewerHandleRef.current = viewer;
    // Wait for the catalog to know codec/description; start the pipeline.
    const catalog = await viewer.waitForCatalog();
    const video = catalog.tracks.find((t) => (t as { packaging?: string }).packaging === 'loc');
    const description = (catalog as unknown as { initData?: Array<{ data: string }> }).initData?.[0]?.data;
    const descBytes = description
      ? Uint8Array.from(atob(description), (c) => c.charCodeAt(0))
      : undefined;
    if (video) {
      const playback = cfg.playback;
      const pipeline = viewer.attachPipeline({
        mediaType: 'video',
        video: {
          codec: (video as { codec?: string }).codec ?? 'avc1.42E01E',
          codedWidth: (video as { width?: number }).width ?? 1280,
          codedHeight: (video as { height?: number }).height ?? 720,
          description: descBytes,
        },
        // VOD playback: sequential release, no skipping, wait for all frames.
        // The knobs below come from the transport config's `playback` block
        // (defaults from the 'vod' latency profile: 3 s jitter buffer, no
        // latency deadline, no catch-up, deep skip-grace) so switching to
        // `interactive` or `broadcast` in the transport dialog changes the
        // decoder's release policy in step.
        policyType: 'vod',
        isLive: false,
        jitterBufferDelay: playback.jitterBufferDelay,
        maxLatency: playback.maxLatency,
        estimatedGopDuration: playback.estimatedGopDuration,
        useLatencyDeadline: playback.useLatencyDeadline,
        skipToLatestGroup: playback.skipToLatestGroup,
        skipGraceFrames: playback.skipGraceFrames,
        enableCatchUp: playback.enableCatchUp,
        catchUpThreshold: playback.catchUpThreshold,
        catalogFramerate: (video as { framerate?: number }).framerate,
      });
      pipeline.on('video-frame', (arg) => drawFrame(arg as VideoFrame));
      await pipeline.start();
      pipelineRef.current = pipeline;
    }
    viewer.onTimelineUpdate(setTimeline);
    return viewer;
  }, [cfg, drawFrame]);

  const startPublish = useCallback(async (input: File | { url: string }) => {
    setError(null);
    setStatus('connecting');
    try {
      const handle = await publishVodAsset({
        transport: cfg,
        channel: CHANNEL_ID,
        input,
        onReady: (info) => { setAssetInfo(info); setStatus('ready'); },
        onStats: (s) => setPublishStats(s),
        onError: (err) => { setError(err.message); setStatus('error'); },
      });
      publishHandleRef.current = handle;
      void ensureViewer();
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
    }
  }, [cfg, ensureViewer]);

  useEffect(() => () => {
    void publishHandleRef.current?.close();
    void viewerHandleRef.current?.close();
    void pipelineRef.current?.stop();
  }, []);

  const fetchDriver = useMemo(() => ({
    fetch: async (window: {
      startGroup: number;
      endGroup: number;
      onObject: (groupId: number, objectId: number, data: Uint8Array) => void;
    }) => {
      const viewer = await ensureViewer();
      return viewer.fetchVideo({
        startGroup: window.startGroup,
        endGroup: window.endGroup,
        onObject: (data, groupId, objectId) => window.onObject(groupId, objectId, data),
      });
    },
    cancel: async (rid: bigint) => {
      await viewerHandleRef.current?.cancelFetch(rid);
    },
  }), [ensureViewer]);

  const stats = useSawtoothFetch({
    controls,
    groupPts: timeline,
    totalGroups: timeline.length > 0 ? timeline[timeline.length - 1].groupId + 1 : undefined,
    driver: fetchDriver,
    onObject: (groupId, objectId, data) => {
      // Push into the pipeline; timestamp in microseconds derived from the
      // group→PTS map for VOD (approximate; the decoder cares about ordering).
      const point = timeline.find((p) => p.groupId === groupId);
      const ptsUs = point ? point.ptsMs * 1000 : groupId * 2_000_000;
      pipelineRef.current?.push(data, groupId, objectId, ptsUs);
    },
  });

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void startPublish(file);
  };

  return (
    <AppShell
      title="VOD · DVR"
      tagline="Publish MP4 → MoQ, seek anywhere. FETCH-driven trick play."
      actions={
        <StatusDot
          state={status}
          label={
            publishStats
              ? `Publishing ${Math.round((publishStats.currentPtsMs / publishStats.durationMs) * 100)}%`
              : status === 'ready' ? `Ready · ${CHANNEL_ID}` :
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
          <GlassPanel strong padding="sm">
            <div
              style={{
                aspectRatio: '16 / 9',
                background: '#050914',
                borderRadius: 12,
                overflow: 'hidden',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <canvas
                ref={canvasRef}
                style={{ maxWidth: '100%', maxHeight: '100%' }}
              />
            </div>
          </GlassPanel>
          <TrickPlayBar controls={controls} showLiveButton={false} />
          <FetchProgressTrack
            durationMs={assetInfo?.durationMs ?? 0}
            positionMs={controls.state.positionMs}
            bufferedGroupsToMs={bufferedGroupsToMs.filter((_, i) =>
              stats.bufferedAheadGops > 0 && i <= controls.state.positionMs
            )}
            activeFetches={stats.activeFetches}
            onCancelFetch={(rid) => void viewerHandleRef.current?.cancelFetch(rid)}
          />
          <FetchStatsFooter stats={stats} />
        </div>
        <div className="ak-stack">
          <GlassPanel padding="md">
            <div className="ak-heading" style={{ marginBottom: 10 }}>Load asset</div>
            <div className="ak-subtle" style={{ marginBottom: 12, fontSize: 12 }}>
              Publish an MP4 (H.264 baseline/main) to channel <code>{CHANNEL_ID}</code>.
              Viewer FETCHes as you scrub.
            </div>
            <div className="ak-stack" style={{ gap: 10 }}>
              <label className="ak-btn" style={{ cursor: 'pointer', textAlign: 'center' }}>
                <input type="file" accept="video/mp4,video/*" onChange={handleFilePick} style={{ display: 'none' }} />
                Choose file…
              </label>
              <div className="ak-row" style={{ gap: 6 }}>
                <input
                  className="ak-input"
                  type="text"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="https://…mp4"
                  style={{ flex: 1 }}
                />
                <button className="ak-btn ak-btn-primary" onClick={() => void startPublish({ url: urlInput })}>
                  Load URL
                </button>
              </div>
              <div className="ak-caption">Samples:</div>
              {SAMPLE_URLS.map((s) => (
                <button
                  key={s.id}
                  className="ak-btn"
                  onClick={() => setUrlInput(s.url)}
                  style={{ textAlign: 'left' }}
                >
                  {s.title}
                </button>
              ))}
            </div>
          </GlassPanel>
          {publishStats ? (
            <GlassPanel padding="md">
              <div className="ak-heading" style={{ marginBottom: 6 }}>Publisher</div>
              <div className="ak-caption">
                {publishStats.samples} samples · {publishStats.keyframes} keyframes ·{' '}
                {(publishStats.bytesPublished / 1024 / 1024).toFixed(1)} MiB
              </div>
              <div className="ak-caption">
                pts {Math.round(publishStats.currentPtsMs)} / {Math.round(publishStats.durationMs)} ms
              </div>
            </GlassPanel>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}
