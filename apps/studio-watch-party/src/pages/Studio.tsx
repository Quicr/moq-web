import { navigate, routeToHash } from '../lib/router';

export function Studio({ roomId }: { roomId: string }) {
  const roomHash = routeToHash({ name: 'room', roomId });
  const shareUrl = `${window.location.origin}${window.location.pathname}${roomHash}`;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      // ignore — clipboard perms not granted
    }
  };

  return (
    <div className="min-h-full p-6">
      <header className="flex items-center justify-between mb-6">
        <div>
          <button className="secondary text-xs" onClick={() => navigate({ name: 'landing' })}>
            ← Home
          </button>
        </div>
        <div className="text-center">
          <div className="text-xs mono uppercase tracking-widest text-slate-500">
            Studio · Broadcaster
          </div>
          <div className="text-lg mono text-accent-light">room {roomId}</div>
        </div>
        <button className="secondary text-xs" onClick={copyLink}>
          Copy Watch Link
        </button>
      </header>

      <div className="glass p-8 text-center text-slate-400">
        <div className="text-xs mono uppercase tracking-wider text-slate-500 mb-2">
          Phase 0 · scaffold
        </div>
        <p className="max-w-lg mx-auto text-sm">
          Studio surface will land here in Phase 1 (bare A/V loop) and grow through
          Phases 2–8. For now this route only proves the router + workspace deps wire
          up cleanly against `main`.
        </p>
      </div>
    </div>
  );
}
