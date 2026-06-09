import { useState, useRef, useEffect } from 'react';
import { useAuthStore } from '../../stores/auth-store';
import { useConnectionStore } from '../../stores/connection-store';
import { useChannelStore } from '../../stores/channel-store';
import { MessageList } from './MessageList';
import { TypingBar } from './TypingBar';
import { Roster } from './Roster';

export function ChatView() {
  const { identity } = useAuthStore();
  const { disconnect } = useConnectionStore();
  const { activeChannel, activeRoom, leaveChannel } = useChannelStore();
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const typingTimeout = useRef<ReturnType<typeof setTimeout>>();

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !activeChannel) return;

    setSending(true);
    try {
      await activeChannel.sendMessage({ type: 'text/plain', body: input.trim() });
      setInput('');
    } catch (err) {
      console.error('Send failed:', err);
    } finally {
      setSending(false);
    }
  };

  const handleInput = (value: string) => {
    setInput(value);
    if (activeChannel && value.trim()) {
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      activeChannel.sendTypingIndicator();
      typingTimeout.current = setTimeout(() => {}, 3000);
    }
  };

  const handleLeave = async () => {
    await leaveChannel();
    await disconnect();
  };

  useEffect(() => {
    return () => {
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
    };
  }, []);

  return (
    <div className="h-screen flex flex-col">
      {/* Header */}
      <header className="glass border-b border-mocha-100/50 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={handleLeave} className="text-mocha-500 hover:text-mocha-700 transition-colors">
            <span className="material-symbols-rounded">arrow_back</span>
          </button>
          <img src="/logo.svg" alt="" className="w-7 h-7" />
          <h1 className="font-semibold text-mocha-800">
            # {activeRoom?.name}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-mocha-600">{identity?.displayName}</span>
          <span className="w-2 h-2 rounded-full bg-green-500" />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Messages area */}
        <div className="flex-1 flex flex-col">
          <MessageList />
          <TypingBar />

          {/* Input */}
          <div className="p-4 glass border-t border-mocha-100/50">
            <form onSubmit={handleSend} className="flex gap-3">
              <input
                type="text"
                value={input}
                onChange={(e) => handleInput(e.target.value)}
                placeholder="Type a message..."
                className="glass-input flex-1"
              />
              <button
                type="submit"
                disabled={!input.trim() || sending}
                className="glass-button px-5"
              >
                <span className="material-symbols-rounded text-lg">send</span>
              </button>
            </form>
          </div>
        </div>

        {/* Roster */}
        <Roster />
      </div>
    </div>
  );
}
