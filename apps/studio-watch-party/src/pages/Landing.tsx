import { useState } from 'react';
import { navigate, randomRoomId } from '../lib/router';

const MSF_SECTIONS = [
  { id: '§2', label: 'ABR alt-groups' },
  { id: '§3', label: 'Secure objects' },
  { id: '§4', label: 'Catalog lifecycle' },
  { id: '§5', label: 'publishTracks' },
  { id: '§7', label: 'Deltas' },
  { id: '§8', label: '%var% URLs' },
  { id: '§11', label: 'Media timeline' },
  { id: '§12', label: 'Event timeline' },
  { id: '§13', label: 'moqlog' },
  { id: '§14', label: 'moqmetrics' },
  { id: '§16', label: 'CEA-608 CC' },
  { id: '§17', label: 'CAT auth' },
];

export function Landing() {
  const [joinRoom, setJoinRoom] = useState('');

  const startStudio = () => {
    navigate({ name: 'studio', roomId: randomRoomId() });
  };

  const openRoom = () => {
    const trimmed = joinRoom.trim();
    if (!trimmed) return;
    navigate({ name: 'room', roomId: trimmed });
  };

  return (
    <div className="min-h-full flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-4xl">
        <div className="text-center mb-10">
          <div className="text-xs mono uppercase tracking-[0.25em] text-accent">
            MSF Showcase · draft-18 interop
          </div>
          <h1 className="text-4xl md:text-5xl font-semibold mt-3 mb-4 bg-gradient-to-r from-accent to-indigo-400 bg-clip-text text-transparent">
            Studio & Watch Party
          </h1>
          <p className="text-slate-400 max-w-2xl mx-auto">
            One demo, every MSF surface. Publish A/V + catalog from a Studio tab, join
            from as many Watch Party tabs as you like, and watch the compliance chips
            light up as each MSF section is exercised end-to-end.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <div className="glass p-6">
            <div className="text-xs mono uppercase tracking-wider text-slate-500 mb-2">
              Broadcaster
            </div>
            <h2 className="text-xl font-semibold mb-2">Start Studio</h2>
            <p className="text-sm text-slate-400 mb-5">
              Grants camera/mic, publishes catalog + video-hi/lo, audio, reactions,
              captions. You control ABR variants, deltas, and CAT-gated premium.
            </p>
            <button className="primary w-full" onClick={startStudio}>
              Start Studio →
            </button>
          </div>

          <div className="glass p-6">
            <div className="text-xs mono uppercase tracking-wider text-slate-500 mb-2">
              Viewer
            </div>
            <h2 className="text-xl font-semibold mb-2">Join Room</h2>
            <p className="text-sm text-slate-400 mb-5">
              Paste a room id from a Studio session. You'll subscribe to the catalog,
              pick a quality, and can request the mic to become a guest publisher.
            </p>
            <div className="flex gap-2">
              <input
                className="field flex-1"
                placeholder="room id (e.g. 4a91c...)"
                value={joinRoom}
                onChange={(e) => setJoinRoom(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && openRoom()}
              />
              <button className="secondary" onClick={openRoom} disabled={!joinRoom.trim()}>
                Join
              </button>
            </div>
          </div>
        </div>

        <div className="glass p-5">
          <div className="text-xs mono uppercase tracking-wider text-slate-500 mb-3">
            MSF surface coverage
          </div>
          <div className="flex flex-wrap gap-2">
            {MSF_SECTIONS.map((s) => (
              <span key={s.id} className="chip">
                <span className="text-accent-light">{s.id}</span>
                <span className="text-slate-400">{s.label}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
