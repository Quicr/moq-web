import { useStore } from './store';
import { JoinScreen } from './components/JoinScreen';
import { MeetingRoom } from './components/MeetingRoom';

export function App() {
  const isJoined = useStore((s) => s.isJoined);
  return isJoined ? <MeetingRoom /> : <JoinScreen />;
}
