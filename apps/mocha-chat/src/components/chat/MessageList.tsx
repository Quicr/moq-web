import { useEffect, useRef } from 'react';
import { useChannelStore } from '../../stores/channel-store';
import { useAuthStore } from '../../stores/auth-store';

export function MessageList() {
  const { messages } = useChannelStore();
  const { identity } = useAuthStore();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-mocha-300 gap-2">
        <span className="material-symbols-rounded text-5xl">chat_bubble_outline</span>
        <p className="text-sm">No messages yet. Say something!</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-3">
      {messages.map((msg, i) => {
        const isOwn = msg.sender.userId === identity?.userId;
        return (
          <div key={`${msg.id.group}-${msg.id.object}-${i}`} className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[70%] rounded-2xl px-4 py-2.5 shadow-sm ${
              isOwn
                ? 'bg-gradient-to-br from-mocha-600 to-mocha-700 text-white'
                : 'bg-white/80 border border-mocha-100 text-mocha-800'
            }`}>
              {!isOwn && (
                <p className="text-xs font-semibold text-mocha-500 mb-0.5">
                  {msg.sender.displayName}
                </p>
              )}
              <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.content.body}</p>
              <p className={`text-[10px] mt-1 ${isOwn ? 'text-mocha-200' : 'text-mocha-400'}`}>
                {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
