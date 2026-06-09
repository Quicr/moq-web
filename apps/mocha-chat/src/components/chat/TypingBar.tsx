import { useChannelStore } from '../../stores/channel-store';
import { useAuthStore } from '../../stores/auth-store';

export function TypingBar() {
  const { typingUsers } = useChannelStore();
  const { identity } = useAuthStore();

  const others = [...typingUsers.values()].filter(
    (t) => t.userId !== identity?.userId,
  );

  if (others.length === 0) return null;

  const names = others.map((t) => t.displayName);
  const text =
    names.length === 1
      ? `${names[0]} is typing...`
      : names.length === 2
        ? `${names[0]} and ${names[1]} are typing...`
        : `${names[0]} and ${names.length - 1} others are typing...`;

  return (
    <div className="px-5 py-1.5 text-xs text-mocha-500 italic flex items-center gap-2">
      <span className="flex gap-0.5">
        <span className="w-1.5 h-1.5 bg-mocha-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-1.5 h-1.5 bg-mocha-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="w-1.5 h-1.5 bg-mocha-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
      </span>
      {text}
    </div>
  );
}
