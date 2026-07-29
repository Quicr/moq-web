import { useStore, type Participant } from '../store';
import { VideoTile } from './VideoTile';

interface VideoGridProps {
  onCanvasRef: (participantId: string, canvas: HTMLCanvasElement) => void;
  onCanvasUnmount: (participantId: string) => void;
}

export function VideoGrid({ onCanvasRef, onCanvasUnmount }: VideoGridProps) {
  const participants = useStore((s) => s.participants);
  const topNVideo = useStore((s) => s.topNVideo);
  const gridLayout = useStore((s) => s.gridLayout);

  const participantList: Participant[] = Array.from(participants.values());

  if (participantList.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="mb-4 text-6xl opacity-30">
            <svg className="mx-auto h-24 w-24 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </div>
          <p className="text-lg text-gray-400">Waiting for participants...</p>
          <p className="mt-1 text-sm text-gray-500">
            Top-{topNVideo} active speakers will appear here
          </p>
        </div>
      </div>
    );
  }

  const maxSlots = gridLayout === '2x2' ? 4 : 2;
  const visibleParticipants = participantList.slice(0, maxSlots);

  const gridClass =
    gridLayout === '2x2' && visibleParticipants.length > 2
      ? 'grid-cols-2 grid-rows-2'
      : 'grid-cols-2';

  return (
    <div className={`grid h-full gap-4 p-4 ${gridClass}`}>
      {visibleParticipants.map((p, index) => (
        <VideoTile
          key={p.id}
          participantId={p.id}
          isSpeaking={p.isSpeaking}
          currentRendition={p.currentRendition}
          gridPosition={index}
          onCanvasRef={onCanvasRef}
          onCanvasUnmount={onCanvasUnmount}
        />
      ))}
    </div>
  );
}
