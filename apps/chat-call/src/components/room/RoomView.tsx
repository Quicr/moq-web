import { useState } from 'react';
import { useAuthStore } from '../../stores/auth-store';
import { useRoomStore } from '../../stores/room-store';
import { Icon } from '../shared/Icon';
import { TokenInspector } from '../shared/TokenInspector';
import { ChatPanel } from './ChatPanel';
import { MediaGrid } from './MediaGrid';

export function RoomView() {
  const { user } = useAuthStore();
  const { currentRoom, leaveRoom } = useRoomStore();
  const [showInspector, setShowInspector] = useState(false);
  const [activeTab, setActiveTab] = useState<'media' | 'chat'>('media');

  if (!currentRoom) return null;

  return (
    <div className="min-h-screen flex flex-col">
      {/* Top bar */}
      <div className="glass !rounded-none border-b border-white/20 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={leaveRoom}
            className="p-2 hover:bg-white/30 rounded-lg transition-colors"
          >
            <Icon name="arrow_back" size={20} className="text-gray-600" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-semibold text-gray-800">{currentRoom.name}</h1>
              {currentRoom.isPublic ? (
                <span className="badge-public text-[10px]">Public</span>
              ) : (
                <span className="badge-private text-[10px]">Private</span>
              )}
            </div>
            <p className="text-xs text-gray-400">
              {currentRoom.participants} participant{currentRoom.participants !== 1 && 's'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowInspector(!showInspector)}
            className={`p-2 rounded-lg transition-colors ${
              showInspector ? 'bg-primary-100 text-primary-600' : 'hover:bg-white/30 text-gray-500'
            }`}
            title="Token Inspector"
          >
            <Icon name="token" size={20} />
          </button>
          <div className="flex items-center gap-1 text-xs text-gray-400">
            <div className="w-2 h-2 bg-green-400 rounded-full" />
            Connected
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: media + chat */}
        <div className="flex-1 flex flex-col lg:flex-row">
          {/* Tab switcher for mobile */}
          <div className="lg:hidden flex border-b border-gray-200/40">
            <button
              onClick={() => setActiveTab('media')}
              className={`flex-1 py-2 text-sm font-medium text-center transition-colors ${
                activeTab === 'media' ? 'text-primary-600 border-b-2 border-primary-500' : 'text-gray-400'
              }`}
            >
              <Icon name="videocam" size={16} className="inline mr-1" />
              Media
            </button>
            <button
              onClick={() => setActiveTab('chat')}
              className={`flex-1 py-2 text-sm font-medium text-center transition-colors ${
                activeTab === 'chat' ? 'text-primary-600 border-b-2 border-primary-500' : 'text-gray-400'
              }`}
            >
              <Icon name="chat" size={16} className="inline mr-1" />
              Chat
            </button>
          </div>

          {/* Media section */}
          <div className={`flex-1 ${activeTab !== 'media' ? 'hidden lg:flex' : 'flex'} flex-col`}>
            <MediaGrid />
          </div>

          {/* Chat section */}
          <div
            className={`lg:w-80 lg:border-l border-gray-200/40 ${
              activeTab !== 'chat' ? 'hidden lg:flex' : 'flex'
            } flex-col`}
          >
            <ChatPanel />
          </div>
        </div>

        {/* Right sidebar: Token Inspector */}
        {showInspector && (
          <div className="hidden lg:block w-72 border-l border-gray-200/40 p-4 overflow-y-auto bg-gray-50/30">
            <TokenInspector />
            {user?.isAnonymous && (
              <div className="mt-4 glass-card !p-3 !bg-amber-50/50 border-amber-200/30">
                <div className="flex items-center gap-2 text-xs text-amber-700">
                  <Icon name="shield" size={16} />
                  <span className="font-medium">Limited Token</span>
                </div>
                <p className="text-[11px] text-amber-600 mt-1">
                  Anonymous tokens grant subscribe-only access to public rooms.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
