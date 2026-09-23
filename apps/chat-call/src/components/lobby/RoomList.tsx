import { useEffect } from 'react';
import { useAuthStore } from '../../stores/auth-store';
import { useRoomStore, type Room } from '../../stores/room-store';
import { Icon } from '../shared/Icon';

export function RoomList() {
  const { user } = useAuthStore();
  const { rooms, joinRoom, fetchRooms } = useRoomStore();

  useEffect(() => { fetchRooms(); }, [fetchRooms]);

  const canAccessRoom = (room: Room) => {
    if (room.isPublic) return true;
    return user && !user.isAnonymous;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-800">Rooms</h2>
        {user && !user.isAnonymous && (
          <button className="btn-ghost flex items-center gap-1 text-sm">
            <Icon name="add" size={18} />
            Create Room
          </button>
        )}
      </div>

      <div className="grid gap-3">
        {rooms.map((room) => {
          const accessible = canAccessRoom(room);
          return (
            <button
              key={room.id}
              onClick={() => accessible && joinRoom(room)}
              disabled={!accessible}
              className={`glass-card !p-4 text-left w-full group ${
                accessible
                  ? 'cursor-pointer hover:border-primary-200'
                  : 'opacity-60 cursor-not-allowed'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium text-gray-800 truncate">{room.name}</h3>
                    {room.isPublic ? (
                      <span className="badge-public">Public</span>
                    ) : (
                      <span className="badge-private">
                        <Icon name="lock" size={12} className="mr-0.5" />
                        Private
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-500">
                    <span className="flex items-center gap-1">
                      <Icon name="group" size={14} />
                      {room.participants}
                    </span>
                    {room.hasVideo && (
                      <span className="flex items-center gap-1">
                        <Icon name="videocam" size={14} />
                        Video
                      </span>
                    )}
                    {room.hasAudio && (
                      <span className="flex items-center gap-1">
                        <Icon name="mic" size={14} />
                        Audio
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {!accessible && (
                    <span className="text-xs text-amber-600 bg-amber-50 px-2 py-1 rounded-lg">
                      Sign in required
                    </span>
                  )}
                  <Icon
                    name="arrow_forward"
                    size={20}
                    className={`text-gray-300 transition-transform ${
                      accessible ? 'group-hover:translate-x-1 group-hover:text-primary-400' : ''
                    }`}
                  />
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
