import { useEffect, useState } from 'react';
import { useAuthStore } from '../../stores/auth-store';
import { useConnectionStore } from '../../stores/connection-store';
import { useChannelStore } from '../../stores/channel-store';

export function ChannelList() {
  const { identity, tokenProvider, logout } = useAuthStore();
  const { connect, state: connState } = useConnectionStore();
  const { rooms, fetchRooms, joinChannel } = useChannelStore();
  const [joining, setJoining] = useState<string | null>(null);

  useEffect(() => {
    fetchRooms();
  }, [fetchRooms]);

  const handleJoin = async (room: typeof rooms[0]) => {
    if (!identity) return;
    setJoining(room.id);
    try {
      const session = await connect(room.name, identity, tokenProvider);
      await joinChannel(session, room);
    } catch (err) {
      console.error('Failed to join channel:', err);
    } finally {
      setJoining(null);
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
          <button onClick={logout} className="glass-button-ghost text-sm">
            Logout
          </button>
        </div>

        {connState === 'connecting' && (
          <div className="flex items-center gap-2 mb-4 p-3 rounded-xl bg-amber-50 border border-amber-200">
            <span className="w-3 h-3 border-2 border-mocha-400/50 border-t-mocha-600 rounded-full animate-spin" />
            <span className="text-sm text-mocha-700">Connecting to relay...</span>
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
                    <span className="text-mocha-400 text-lg font-bold group-hover:text-mocha-600 transition-colors">#</span>
                    <span className="font-medium text-mocha-800">{room.name}</span>
                    {joining === room.id && (
                      <span className="ml-auto w-3 h-3 border-2 border-mocha-400/50 border-t-mocha-600 rounded-full animate-spin" />
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
