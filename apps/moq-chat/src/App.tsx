import { useRoomStore } from './stores/room-store';
import { useMoqtRoom } from './hooks/use-moqt-room';
import { Lobby } from './components/lobby/Lobby';
import { RoomView } from './components/room/RoomView';

export function App() {
  const { currentRoom } = useRoomStore();
  useMoqtRoom();

  if (currentRoom) {
    return <RoomView />;
  }

  return <Lobby />;
}
