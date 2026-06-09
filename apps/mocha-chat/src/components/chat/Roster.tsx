import { useChannelStore } from '../../stores/channel-store';

export function Roster() {
  const { roster } = useChannelStore();
  const entries = [...roster.values()];

  return (
    <aside className="w-56 glass border-l border-mocha-100/50 p-4 overflow-y-auto hidden md:block">
      <h2 className="text-xs font-semibold text-mocha-500 uppercase tracking-wider mb-4">
        Online &middot; {entries.length}
      </h2>
      {entries.length === 0 ? (
        <p className="text-sm text-mocha-300 text-center mt-8">No one else here yet</p>
      ) : (
        <ul className="space-y-1.5">
          {entries.map((entry) => (
            <li key={entry.userId} className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-mocha-50 transition-colors">
              <span className={`w-2.5 h-2.5 rounded-full ${
                entry.status === 'online' ? 'bg-green-500' :
                entry.status === 'away' ? 'bg-amber-500' :
                entry.status === 'dnd' ? 'bg-red-500' :
                'bg-gray-400'
              }`} />
              <span className="text-sm text-mocha-700 truncate">
                {entry.displayName}
              </span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
