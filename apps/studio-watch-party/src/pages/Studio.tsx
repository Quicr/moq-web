import { useState } from 'react';
import { navigate, routeToHash } from '../lib/router';
import { useStudio } from '../lib/useStudio';
import { useSessionStore } from '../stores/session-store';

const statusLabel: Record<string, string> = {
  idle: 'Idle',
  'requesting-media': 'Requesting camera/mic…',
  connecting: 'Connecting to relay…',
  publishing: 'Publishing tracks…',
  live: 'Live',
  error: 'Error',
};

const chipTone: Record<string, string> = {
  idle: 'chip',
  'requesting-media': 'chip warn',
  connecting: 'chip warn',
  publishing: 'chip warn',
  live: 'chip active',
  error: 'chip warn',
};

export function Studio({ roomId }: { roomId: string }) {
  const relayUrl = useSessionStore((s) => s.relayUrl);
  const setRelayUrl = useSessionStore((s) => s.setRelayUrl);
  const { state, start, stop, attachPreview } = useStudio(roomId);
  const [copied, setCopied] = useState(false);

  const roomHash = routeToHash({ name: 'room', roomId });
  const shareUrl = `${window.location.origin}${window.location.pathname}${roomHash}`;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — clipboard perms not granted
    }
  };

  const isBusy =
    state.status === 'requesting-media' ||
    state.status === 'connecting' ||
    state.status === 'publishing';

  return (
    <div className="min-h-full p-6">
      <header className="flex items-center justify-between mb-6">
        <button className="secondary text-xs" onClick={() => navigate({ name: 'landing' })}>
          ← Home
        </button>
        <div className="text-center">
          <div className="text-xs mono uppercase tracking-widest text-slate-500">
            Studio · Broadcaster
          </div>
          <div className="text-lg mono text-accent-light">room {roomId}</div>
        </div>
        <button className="secondary text-xs" onClick={copyLink}>
          {copied ? 'Copied ✓' : 'Copy Watch Link'}
        </button>
      </header>

      <div className="grid md:grid-cols-3 gap-4">
        <div className="md:col-span-2 glass p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs mono uppercase tracking-wider text-slate-500">
              Local preview
            </span>
            <span className={chipTone[state.status] ?? 'chip'}>
              {statusLabel[state.status] ?? state.status}
            </span>
          </div>
          <div className="aspect-video bg-black/60 rounded-lg overflow-hidden">
            <video
              ref={attachPreview}
              className="w-full h-full object-cover"
              autoPlay
              muted
              playsInline
            />
          </div>
          {state.status === 'live' && (
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="chip active">video-main · alias {String(state.videoTrackAlias)}</span>
              <span className="chip active">audio-main · alias {String(state.audioTrackAlias)}</span>
            </div>
          )}
          {state.status === 'error' && state.error && (
            <div className="mt-3 text-sm text-red-300 mono">{state.error}</div>
          )}
        </div>

        <div className="glass p-4 space-y-4">
          <div>
            <div className="text-xs mono uppercase tracking-wider text-slate-500 mb-2">
              Relay
            </div>
            <input
              className="field w-full"
              value={relayUrl}
              onChange={(e) => setRelayUrl(e.target.value)}
              disabled={state.status !== 'idle' && state.status !== 'error'}
            />
          </div>

          <div>
            <div className="text-xs mono uppercase tracking-wider text-slate-500 mb-2">
              Namespace
            </div>
            <div className="mono text-xs text-slate-400 break-all">
              msf-demo / studio-watch-party / {roomId}
            </div>
          </div>

          <div className="flex flex-col gap-2 pt-2">
            {state.status !== 'live' ? (
              <button className="primary" disabled={isBusy} onClick={start}>
                {isBusy ? statusLabel[state.status] : 'Start Broadcast'}
              </button>
            ) : (
              <button className="secondary" onClick={stop}>
                Stop Broadcast
              </button>
            )}
          </div>

          <div className="text-xs text-slate-500 pt-2 border-t border-slate-700/50">
            Phase 1 · bare A/V publish. Catalog / ABR / auth land in later phases.
          </div>
        </div>
      </div>
    </div>
  );
}
