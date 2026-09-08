import { useRoute } from './lib/router';
import { Landing } from './pages/Landing';
import { Studio } from './pages/Studio';
import { WatchParty } from './pages/WatchParty';

export default function App() {
  const route = useRoute();

  switch (route.name) {
    case 'landing':
      return <Landing />;
    case 'studio':
      return <Studio roomId={route.roomId} />;
    case 'room':
      return <WatchParty roomId={route.roomId} track={route.track} />;
  }
}
