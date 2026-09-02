import { useAuthStore } from '../../stores/auth-store';
import { Avatar } from '../shared/Avatar';
import { Icon } from '../shared/Icon';
import { LoginCard } from './LoginCard';
import { RoomList } from './RoomList';

export function Lobby() {
  const { user, logout } = useAuthStore();

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <LoginCard />
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div className="glass-card !p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-br from-primary-400 to-primary-600 rounded-xl flex items-center justify-center">
              <Icon name="chat" size={20} className="text-white" />
            </div>
            <div>
              <h1 className="font-semibold text-gray-800">MoQ Chat</h1>
              <p className="text-xs text-gray-500">Media over QUIC</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Avatar name={user.displayName} src={user.avatarUrl} size="sm" />
              <div className="hidden sm:block">
                <div className="text-sm font-medium text-gray-700">{user.displayName}</div>
                <div className="text-xs text-gray-400">
                  {user.isAnonymous ? 'Guest' : user.email}
                </div>
              </div>
            </div>
            {user.isAnonymous && (
              <span className="badge bg-gray-100 text-gray-500">
                <Icon name="visibility" size={12} className="mr-1" />
                View only
              </span>
            )}
            <button onClick={logout} className="btn-ghost text-gray-400" title="Sign out">
              <Icon name="logout" size={20} />
            </button>
          </div>
        </div>

        {/* Guest notice */}
        {user.isAnonymous && (
          <div className="glass-card !p-4 !bg-amber-50/70 border-amber-200/50 flex items-start gap-3">
            <Icon name="info" size={20} className="text-amber-500 mt-0.5" />
            <div className="text-sm text-amber-800">
              <p className="font-medium">Browsing as Guest</p>
              <p className="text-amber-600 mt-0.5">
                You can join public rooms and view content. Sign in with Google to publish
                audio/video and access private rooms.
              </p>
            </div>
          </div>
        )}

        {/* Room list */}
        <RoomList />
      </div>
    </div>
  );
}
