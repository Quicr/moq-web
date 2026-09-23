import { useEffect, useRef } from 'react';

import { useAuthStore } from '../stores/auth-store';
import { useMoqtStore } from '../stores/moqt-store';
import { useRoomStore } from '../stores/room-store';

/**
 * Connects the current room selection to a live MOQT session.
 * Fetches a token via the auth strategy, opens a MoqtRoom, and tears
 * it down when the user leaves the room or logs out.
 */
export function useMoqtRoom(): void {
  const currentRoom = useRoomStore((s) => s.currentRoom);
  const user = useAuthStore((s) => s.user);
  const fetchToken = useAuthStore((s) => s.fetchToken);
  const join = useMoqtStore((s) => s.join);
  const leave = useMoqtStore((s) => s.leave);
  const joinedRoomId = useRef<string | null>(null);

  useEffect(() => {
    if (!currentRoom || !user) {
      if (joinedRoomId.current) {
        joinedRoomId.current = null;
        void leave();
      }
      return;
    }
    if (joinedRoomId.current === currentRoom.id) return;
    joinedRoomId.current = currentRoom.id;

    const role = user.isAnonymous ? 'subscriber' : 'publisher';
    (async () => {
      const token = await fetchToken(currentRoom.id, role);
      await join({
        roomId: currentRoom.id,
        namespacePrefix: currentRoom.namespace_prefix,
        selfId: user.id,
        displayName: user.displayName,
        token,
        publishVideo: !user.isAnonymous,
        publishAudio: !user.isAnonymous,
      });
    })().catch((err) => {
      console.error('[useMoqtRoom] join failed', err);
      joinedRoomId.current = null;
    });

    return () => {
      // Cleanup on unmount / room change is handled by the next effect run.
    };
  }, [currentRoom, user, fetchToken, join, leave]);
}
