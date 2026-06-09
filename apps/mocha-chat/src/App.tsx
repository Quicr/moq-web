import { useAuthStore } from './stores/auth-store';
import { useChannelStore } from './stores/channel-store';
import { LoginScreen } from './components/login/LoginScreen';
import { ChatView } from './components/chat/ChatView';
import { ChannelList } from './components/chat/ChannelList';

export function App() {
  const { identity } = useAuthStore();
  const { activeChannel } = useChannelStore();

  if (!identity) {
    return <LoginScreen />;
  }

  if (!activeChannel) {
    return <ChannelList />;
  }

  return <ChatView />;
}
