import { useRef, useEffect } from 'react';
import { useStore } from '../store';

interface SelfViewProps {
  stream: MediaStream | null;
}

export function SelfView({ stream }: SelfViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const displayName = useStore((s) => s.displayName);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  if (!stream) return null;

  return (
    <div className="absolute bottom-20 right-4 w-48 overflow-hidden rounded-xl bg-gray-800 shadow-2xl ring-1 ring-white/10">
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="h-full w-full object-cover"
      />
      <div className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white backdrop-blur-sm">
        {displayName} (You)
      </div>
    </div>
  );
}
