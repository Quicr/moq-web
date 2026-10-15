import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../../stores/auth-store';
import { useMoqtStore } from '../../stores/moqt-store';
import { Icon } from '../shared/Icon';
import { Avatar } from '../shared/Avatar';

interface TileProps {
  displayName: string;
  isSelf: boolean;
  videoRef: (el: HTMLVideoElement | null) => void;
  canvasRef?: (el: HTMLCanvasElement | null) => void;
  showVideo: boolean;
  showAudioOff: boolean;
  /** Activity value for speaking indicator (0=silent, 1=continuous, 2=speechStart) */
  activityValue?: number;
}

function Tile({ displayName, isSelf, videoRef, canvasRef, showVideo, showAudioOff, activityValue }: TileProps) {
  const isSpeaking = activityValue !== undefined && activityValue > 0;
  return (
    <div className={`relative bg-slate-900 rounded-2xl overflow-hidden flex items-center justify-center min-h-[200px] transition-all duration-200 ${
      isSpeaking ? 'ring-2 ring-emerald-400 ring-offset-2 ring-offset-slate-100' : ''
    }`}>
      {showVideo ? (
        isSelf ? (
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full object-cover"
          />
        )
      ) : (
        <Avatar name={displayName} size="lg" />
      )}
      <div className="absolute bottom-2 left-2 flex items-center gap-1.5 bg-slate-900/60 backdrop-blur-sm rounded-lg px-2 py-1">
        {showAudioOff && <Icon name="mic_off" size={14} className="text-rose-400" />}
        <span className="text-white text-xs font-medium">{isSelf ? 'You' : displayName}</span>
      </div>
      {isSelf && (
        <div className="absolute top-2 right-2">
          <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
        </div>
      )}
    </div>
  );
}

export function MediaGrid() {
  const { user } = useAuthStore();
  const participants = useMoqtStore((s) => s.participants);
  const localStream = useMoqtStore((s) => s.localStream);
  const peerVideoFrames = useMoqtStore((s) => s.peerVideoFrames);
  const setLocalMuted = useMoqtStore((s) => s.setLocalMuted);
  const setLocalVideoOff = useMoqtStore((s) => s.setLocalVideoOff);
  const room = useMoqtStore((s) => s.room);

  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());

  const canPublish = !!user && !user.isAnonymous;

  useEffect(() => {
    const el = localVideoRef.current;
    if (!el) return;
    if (localStream && el.srcObject !== localStream) {
      el.srcObject = localStream;
    }
    if (!localStream && el.srcObject) {
      el.srcObject = null;
    }
  }, [localStream]);

  useEffect(() => {
    for (const [peerId, frame] of peerVideoFrames) {
      const canvas = canvasRefs.current.get(peerId);
      if (!canvas) continue;
      if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
      if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      try {
        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      } catch {
        // frame may already be closed on rapid updates
      }
    }
  }, [peerVideoFrames]);

  const handleMuteToggle = () => {
    const next = !isMuted;
    setIsMuted(next);
    setLocalMuted(next);
  };

  const handleVideoToggle = () => {
    const next = !isVideoOff;
    setIsVideoOff(next);
    setLocalVideoOff(next);
  };

  const showSelfVideo = canPublish && !isVideoOff && !!localStream;
  const totalTiles = 1 + participants.length;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 p-3 grid grid-cols-1 sm:grid-cols-2 gap-3 auto-rows-fr">
        <Tile
          key="self"
          displayName={user?.displayName ?? 'You'}
          isSelf
          videoRef={(el) => { localVideoRef.current = el; }}
          showVideo={showSelfVideo}
          showAudioOff={isMuted}
        />
        {participants.map((p) => (
          <Tile
            key={p.id}
            displayName={p.displayName}
            isSelf={false}
            videoRef={() => {}}
            canvasRef={(el) => {
              if (el) canvasRefs.current.set(p.id, el);
              else canvasRefs.current.delete(p.id);
            }}
            showVideo={peerVideoFrames.has(p.id)}
            showAudioOff={false}
            activityValue={p.activityValue}
          />
        ))}
        {totalTiles < 4 && (
          <div className="border-2 border-dashed border-slate-300/50 rounded-2xl flex items-center justify-center">
            <div className="text-center text-slate-400">
              <Icon name="person_add" size={28} />
              <p className="text-xs mt-1">
                {room ? 'Waiting for others' : 'Connecting...'}
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="p-3 border-t border-slate-200/50">
        <div className="flex items-center justify-center gap-3">
          {canPublish ? (
            <>
              <button
                onClick={handleMuteToggle}
                className={`p-3 rounded-full transition-all duration-150 ${
                  isMuted
                    ? 'bg-rose-100 text-rose-600 hover:bg-rose-200'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                <Icon name={isMuted ? 'mic_off' : 'mic'} size={20} />
              </button>
              <button
                onClick={handleVideoToggle}
                className={`p-3 rounded-full transition-all duration-150 ${
                  isVideoOff
                    ? 'bg-rose-100 text-rose-600 hover:bg-rose-200'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
                title={isVideoOff ? 'Turn on camera' : 'Turn off camera'}
              >
                <Icon name={isVideoOff ? 'videocam_off' : 'videocam'} size={20} />
              </button>
              <button
                className="p-3 rounded-full bg-slate-100 text-slate-400 transition-all duration-150 cursor-not-allowed"
                title="Screen share"
                disabled
              >
                <Icon name="screen_share" size={20} />
              </button>
            </>
          ) : (
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <Icon name="visibility" size={18} />
              Viewing mode — sign in to publish
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
