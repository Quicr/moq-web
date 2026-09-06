import { navigate } from '../lib/router';

export function WatchParty({ roomId, track }: { roomId: string; track?: string }) {
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
          <div className="text-lg mono text-accent-light">
            room {roomId}
            {track ? ` · ${track}` : ''}
          </div>
        </div>
        <div className="w-16" />
      </header>

      <div className="glass p-8 text-center text-slate-400">
        <div className="text-xs mono uppercase tracking-wider text-slate-500 mb-2">
          Phase 0 · scaffold
        </div>
        <p className="max-w-lg mx-auto text-sm">
          Viewer surface will land here in Phase 1 (bare subscribe + decode) and grow
          through Phases 2–8 (ABR picker, reactions, captions, guest mic, premium
          unlock, compliance chips).
        </p>
      </div>
    </div>
  );
}
