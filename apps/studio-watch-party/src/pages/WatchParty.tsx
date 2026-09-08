import { useState } from 'react';
import { navigate } from '../lib/router';
import { useWatchParty } from '../lib/useWatchParty';
import { useSessionStore } from '../stores/session-store';

const statusLabel: Record<string, string> = {
  idle: 'Idle',
  connecting: 'Connecting to relay…',
  subscribing: 'Subscribing…',
  watching: 'Watching',
  error: 'Error',
};

const chipTone: Record<string, string> = {
  idle: 'chip',
  connecting: 'chip warn',
  subscribing: 'chip warn',
  watching: 'chip active',
  error: 'chip warn',
};

export function WatchParty({ roomId }: { roomId: string; track?: string }) {
  const relayUrl = useSessionStore((s) => s.relayUrl);
  const setRelayUrl = useSessionStore((s) => s.setRelayUrl);
  const { state, start, stop, attachCanvas, setMuted } = useWatchParty(roomId);
  const [muted, setLocalMuted] = useState(false);

  const busy = state.status === 'connecting' || state.status === 'subscribing';

  const toggleMute = () => {
    const next = !muted;
    setLocalMuted(next);
    setMuted(next);
  };

  return (
    <div className="min-h-full p-6">
      <header className="flex items-center justify-between mb-6">
        <button className="secondary text-xs" onClick={() => navigate({ name: 'landing' })}>
          ← Home
        </button>
        <div className="text-center">
          <div className="text-xs mono uppercase tracking-widest text-slate-500">
            Watch Party · Viewer
          </div>
          <div className="text-lg mono text-accent-light">room {roomId}</div>
        </div>
        <div className="w-16" />
      </header>

      <div className="grid md:grid-cols-3 gap-4">
        <div className="md:col-span-2 glass p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs mono uppercase tracking-wider text-slate-500">
              Live feed
            </span>
            <span className={chipTone[state.status] ?? 'chip'}>
              {statusLabel[state.status] ?? state.status}
            </span>
          </div>
          <div className="relative aspect-video bg-black/60 rounded-lg overflow-hidden flex items-center justify-center">
            <canvas ref={attachCanvas} className="w-full h-full object-contain" />
            {state.status !== 'watching' && (
              <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm pointer-events-none">
                {state.status === 'idle'
                  ? 'Click Join Room to start subscribing.'
                  : statusLabel[state.status]}
              </div>
            )}
          </div>
          {state.status === 'watching' && (
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="chip active">{state.fps} fps</span>
              <span className="chip">{state.frames} frames</span>
              <span className="chip">{state.audioChunks} audio chunks</span>
              {state.videoSubId !== undefined && (
                <span className="chip">video sub {state.videoSubId}</span>
              )}
              {state.audioSubId !== undefined && (
                <span className="chip">audio sub {state.audioSubId}</span>
              )}
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
            {state.status !== 'watching' ? (
              <button className="primary" disabled={busy} onClick={start}>
                {busy ? statusLabel[state.status] : 'Join Room'}
              </button>
            ) : (
              <>
                <button className="secondary" onClick={toggleMute}>
                  {muted ? 'Unmute' : 'Mute'}
                </button>
                <button className="secondary" onClick={stop}>
                  Leave
                </button>
              </>
            )}
          </div>

          <div className="text-xs text-slate-500 pt-2 border-t border-slate-700/50">
            Phase 1 · bare subscribe. Catalog / ABR / auth land in later phases.
          </div>
        </div>
      </div>
    </div>
  );
}
