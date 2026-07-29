import { useRef, useEffect } from 'react';

interface VideoTileProps {
  participantId: string;
  isSpeaking: boolean;
  currentRendition?: string;
  gridPosition?: number;
  onCanvasRef: (participantId: string, canvas: HTMLCanvasElement) => void;
  onCanvasUnmount: (participantId: string) => void;
}

const RENDITION_COLORS: Record<string, string> = {
  '720p': 'bg-green-500',
  '360p': 'bg-yellow-500',
  '180p': 'bg-red-500',
};

export function VideoTile({ participantId, isSpeaking, currentRendition, gridPosition, onCanvasRef, onCanvasUnmount }: VideoTileProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (canvasRef.current) {
      onCanvasRef(participantId, canvasRef.current);
    }
    return () => {
      onCanvasUnmount(participantId);
    };
  }, [participantId, onCanvasRef, onCanvasUnmount]);

  const renditionColor = currentRendition ? (RENDITION_COLORS[currentRendition] ?? 'bg-gray-500') : '';

  return (
    <div
      className={`relative overflow-hidden rounded-2xl bg-gray-800 shadow-lg transition-all duration-300 ${
        isSpeaking ? 'ring-2 ring-green-400 ring-offset-2 ring-offset-gray-900' : ''
      }`}
    >
      <canvas
        ref={canvasRef}
        className="h-full w-full object-cover"
      />
      <div className="absolute bottom-3 left-3 flex items-center gap-2">
        <div className="rounded-lg bg-black/60 px-3 py-1 backdrop-blur-sm">
          <span className="text-sm font-medium text-white">{participantId}</span>
        </div>
        {currentRendition && (
          <div className={`rounded-lg px-2 py-1 ${renditionColor}`}>
            <span className="text-xs font-bold text-white">{currentRendition}</span>
          </div>
        )}
      </div>
      {isSpeaking && (
        <div className="absolute left-3 top-3">
          <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-green-400" />
        </div>
      )}
      {gridPosition !== undefined && (
        <div className="absolute right-3 top-3 rounded-full bg-black/60 px-2 py-1 backdrop-blur-sm">
          <span className="text-xs font-medium text-gray-300">#{gridPosition + 1}</span>
        </div>
      )}
    </div>
  );
}
