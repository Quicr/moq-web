import { useEffect, useState } from 'react';
import { useAuthStore } from '../../stores/auth-store';
import { useConnectionStore } from '../../stores/connection-store';
import { useChannelStore } from '../../stores/channel-store';

const TOKEN_SERVICE_URL = import.meta.env.VITE_TOKEN_SERVICE_URL || '/api';

const VISIBILITY_ICON: Record<string, string> = {
  public: 'public',
  authenticated: 'shield_person',
  private: 'lock',
};

const VISIBILITY_LABEL: Record<string, string> = {
  public: 'Public — anyone can join',
  authenticated: 'Sign-in required',
  private: 'Private — invite only',
};

export function ChannelList() {
  const { identity, tokenProvider, logout } = useAuthStore();
  const { connect, state: connState } = useConnectionStore();
  const { rooms, fetchRooms, joinChannel } = useChannelStore();
  const [joining, setJoining] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newRoomName, setNewRoomName] = useState('');
  const [newRoomVisibility, setNewRoomVisibility] = useState<'public' | 'authenticated' | 'private'>('public');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchRooms();
  }, [fetchRooms]);

  const handleJoin = async (room: typeof rooms[0]) => {
    if (!identity) return;
    setJoining(room.id);
    setError(null);
    try {
      const session = await connect(room.name, identity, tokenProvider);
      await joinChannel(session, room);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to join';
      if (msg.includes('sign-in') || msg.includes('requires')) {
        setError(`Cannot join #${room.name}: sign-in with Google is required`);
      } else if (msg.includes('private') || msg.includes('invite')) {
        setError(`Cannot join #${room.name}: this is a private room — ask a member for an invite link`);
      } else {
        setError(msg);
      }
    } finally {
      setJoining(null);
    }
  };

  const handleCreateRoom = async () => {
    if (!newRoomName.trim()) return;
    setCreating(true);
    try {
      const name = newRoomName.trim().toLowerCase().replace(/\s+/g, '-');
      const res = await fetch(`${TOKEN_SERVICE_URL}/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          namespace_prefix: `mocha/${name}`,
          visibility: newRoomVisibility,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed: ${res.status}`);
      }
      setNewRoomName('');
      setShowCreate(false);
      await fetchRooms();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create room');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="glass-card p-8 w-full max-w-md">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <img src="/logo.svg" alt="" className="w-9 h-9" />
            <div>
              <h1 className="text-lg font-bold text-mocha-800">Channels</h1>
              <p className="text-xs text-mocha-500">{identity?.displayName}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowCreate(!showCreate)} className="glass-button-ghost text-sm" title="Create channel">
              <span className="material-symbols-rounded text-base">add</span>
            </button>
            <button onClick={logout} className="glass-button-ghost text-sm">
              Logout
            </button>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 mb-4 p-3 rounded-xl bg-red-50 border border-red-200">
            <span className="material-symbols-rounded text-red-500 text-lg">error</span>
            <span className="text-sm text-red-700">{error}</span>
            <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-600">
              <span className="material-symbols-rounded text-sm">close</span>
            </button>
          </div>
        )}

        {connState === 'connecting' && (
          <div className="flex items-center gap-2 mb-4 p-3 rounded-xl bg-amber-50 border border-amber-200">
            <span className="w-3 h-3 border-2 border-mocha-400/50 border-t-mocha-600 rounded-full animate-spin" />
            <span className="text-sm text-mocha-700">Connecting to relay...</span>
          </div>
        )}

        {showCreate && (
          <div className="mb-4 p-4 rounded-xl bg-white/60 border border-mocha-200">
            <div className="flex gap-2 mb-3">
              <input
                type="text"
                value={newRoomName}
                onChange={(e) => setNewRoomName(e.target.value)}
                placeholder="channel-name"
                className="flex-1 px-3 py-2 rounded-lg border border-mocha-200 bg-white/80 text-sm focus:outline-none focus:border-mocha-400"
                onKeyDown={(e) => e.key === 'Enter' && handleCreateRoom()}
              />
            </div>
            <div className="flex items-center gap-3 mb-3">
              {(['public', 'authenticated', 'private'] as const).map((v) => (
                <label key={v} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="visibility"
                    checked={newRoomVisibility === v}
                    onChange={() => setNewRoomVisibility(v)}
                    className="accent-amber-600"
                  />
                  <span className="material-symbols-rounded text-sm text-mocha-500">{VISIBILITY_ICON[v]}</span>
                  <span className="text-xs text-mocha-700 capitalize">{v}</span>
                </label>
              ))}
            </div>
            <button
              onClick={handleCreateRoom}
              disabled={creating || !newRoomName.trim()}
              className="w-full py-2 rounded-lg bg-mocha-600 text-white text-sm font-medium hover:bg-mocha-700 disabled:opacity-50 transition-colors"
            >
              {creating ? 'Creating...' : 'Create Channel'}
            </button>
          </div>
        )}

        {rooms.length === 0 ? (
          <div className="text-center py-12 text-mocha-400">
            <span className="material-symbols-rounded text-4xl block mb-2">forum</span>
            No channels available
          </div>
        ) : (
          <ul className="space-y-2">
            {rooms.map((room) => (
              <li key={room.id}>
                <button
                  onClick={() => handleJoin(room)}
                  disabled={joining !== null}
                  className="w-full text-left px-4 py-3.5 rounded-xl bg-white/50 border border-mocha-100 hover:bg-mocha-50 hover:border-mocha-200 hover:shadow-warm transition-all duration-200 disabled:opacity-50 group"
                >
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-rounded text-mocha-400 text-lg group-hover:text-mocha-600 transition-colors">
                      {VISIBILITY_ICON[room.visibility] || 'tag'}
                    </span>
                    <span className="font-medium text-mocha-800">{room.name}</span>
                    <span className="ml-auto text-xs text-mocha-400" title={VISIBILITY_LABEL[room.visibility]}>
                      {room.visibility !== 'public' && (
                        <span className="capitalize">{room.visibility}</span>
                      )}
                    </span>
                    {joining === room.id && (
                      <span className="w-3 h-3 border-2 border-mocha-400/50 border-t-mocha-600 rounded-full animate-spin" />
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
