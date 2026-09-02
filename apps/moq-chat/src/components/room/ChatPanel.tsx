import { useState, useRef, useEffect } from 'react';
import { useAuthStore } from '../../stores/auth-store';
import { useMoqtStore } from '../../stores/moqt-store';
import { useRoomStore } from '../../stores/room-store';
import type { PeerMessage } from '../../lib/chat/types';
import { Avatar } from '../shared/Avatar';
import { Icon } from '../shared/Icon';

export function ChatPanel() {
  const { user } = useAuthStore();
  const currentRoom = useRoomStore((s) => s.currentRoom);
  const messages = useMoqtStore((s) => s.messages);
  const sendMessage = useMoqtStore((s) => s.sendMessage);
  const room = useMoqtStore((s) => s.room);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const canSend = !!user && !user.isAnonymous && !!room && !sending;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || !canSend) return;
    setSending(true);
    try {
      await sendMessage(input.trim());
      setInput('');
    } catch (err) {
      console.error('[ChatPanel] send failed', err);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Chat header */}
      <div className="px-4 py-3 border-b border-gray-200/40 flex items-center gap-2">
        <Icon name="chat" size={18} className="text-primary-500" />
        <span className="font-medium text-gray-700 text-sm">
          Chat — {currentRoom?.name}
        </span>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-gray-400 text-sm mt-8">
            <Icon name="forum" size={32} className="opacity-30 mb-2" />
            <p>No messages yet. Say hello!</p>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} isOwn={msg.senderId === user?.id} />
        ))}
      </div>

      {/* Input */}
      <div className="p-3 border-t border-gray-200/40">
        {user && !user.isAnonymous ? (
          <form
            onSubmit={(e) => { e.preventDefault(); void handleSend(); }}
            className="flex items-center gap-2"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type a message..."
              className="input-glass flex-1 !py-2.5 text-sm"
              disabled={!room}
            />
            <button
              type="submit"
              disabled={!canSend || !input.trim()}
              className="p-2.5 bg-primary-500 text-white rounded-xl hover:bg-primary-600 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Icon name="send" size={18} />
            </button>
          </form>
        ) : (
          <div className="text-center text-xs text-gray-400 py-2">
            <Icon name="lock" size={14} className="inline mr-1" />
            Sign in to send messages
          </div>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ message, isOwn }: { message: PeerMessage; isOwn: boolean }) {
  return (
    <div className={`flex items-end gap-2 ${isOwn ? 'flex-row-reverse' : ''}`}>
      <Avatar name={message.senderName} size="sm" />
      <div className={`max-w-[70%] ${isOwn ? 'items-end' : 'items-start'}`}>
        {!isOwn && (
          <div className="text-xs text-gray-400 mb-0.5 px-1">{message.senderName}</div>
        )}
        <div
          className={`px-3 py-2 rounded-2xl text-sm ${
            isOwn
              ? 'bg-primary-500 text-white rounded-br-md'
              : 'bg-white/80 text-gray-700 border border-gray-100 rounded-bl-md'
          }`}
        >
          {message.text}
        </div>
        <div className="text-[10px] text-gray-300 mt-0.5 px-1">
          {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </div>
  );
}
