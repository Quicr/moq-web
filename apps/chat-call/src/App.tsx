import { useRoomStore } from './stores/room-store';
import { useMoqtRoom } from './hooks/use-moqt-room';
import { Lobby } from './components/lobby/Lobby';
import { RoomView } from './components/room/RoomView';
import { TopBar } from './components/shared/TopBar';

export function App() {
  const { currentRoom } = useRoomStore();
  useMoqtRoom();

  return (
    <div className="ak-app">
      <TopBar />
      <main style={{ padding: '0 16px 20px 16px' }}>
        {currentRoom ? <RoomView /> : <Lobby />}
      </main>
    </div>
  );
}
