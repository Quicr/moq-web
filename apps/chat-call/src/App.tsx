import { useEffect } from 'react';
import { useRoomStore } from './stores/room-store';
import { useMoqtStore } from './stores/moqt-store';
import { useMoqtRoom } from './hooks/use-moqt-room';
import { Lobby } from './components/lobby/Lobby';
import { RoomView } from './components/room/RoomView';
import { TopBar } from './components/shared/TopBar';

/**
 * Parse `?join=<base64>` URL param to auto-join a room with settings.
 */
function useAutoJoinFromUrl() {
  const joinRoom = useRoomStore((s) => s.joinRoom);
  const setTopN = useMoqtStore((s) => s.setTopN);

  useEffect(() => {
    const params = new URLSearchParams(globalThis.location?.search ?? '');
    const joinParam = params.get('join');
    if (!joinParam) return;
    try {
      const config = JSON.parse(atob(joinParam));
      // Apply top-N settings before joining
      if (config.topN?.enabled) {
        setTopN(true, config.topN.maxTracks ?? 4);
      }
      // Auto-join the room
      joinRoom({
        id: config.roomId,
        name: config.roomName ?? config.roomId,
        namespace_prefix: config.namespacePrefix,
        isPublic: true,
        participants: 0,
        createdBy: 'shared-link',
        hasVideo: true,
        hasAudio: true,
      });
      // Clean the URL
      const url = new URL(globalThis.location.href);
      url.searchParams.delete('join');
      globalThis.history?.replaceState(null, '', url.toString());
    } catch {
      // Ignore malformed join param
    }
  }, [joinRoom, setTopN]);
}

export function App() {
  const { currentRoom } = useRoomStore();
  useMoqtRoom();
  useAutoJoinFromUrl();

  return (
    <div className="ak-app">
      <TopBar />
      <main style={{ padding: '0 16px 20px 16px' }}>
        {currentRoom ? <RoomView /> : <Lobby />}
      </main>
    </div>
  );
}
