import { useEffect, useRef, useState, useCallback } from 'react';
import { useStore } from '../store';
import { useSession } from '../hooks/useSession';
import { usePublish } from '../hooks/usePublish';
import { useBotPublish } from '../hooks/useBotPublish';
import { useSubscribe } from '../hooks/useSubscribe';
import { useAudioMixer } from '../hooks/useAudioMixer';
import { VideoGrid } from './VideoGrid';
import { ControlBar } from './ControlBar';
import { SelfView } from './SelfView';
import { NetworkControls } from './NetworkControls';

export function MeetingRoom() {
  const roomId = useStore((s) => s.roomId);
  const displayName = useStore((s) => s.displayName);
  const setJoined = useStore((s) => s.setJoined);
  const isBot = useStore((s) => s.isBot);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('Connecting...');
  const initializedRef = useRef(false);

  const { connect, disconnect } = useSession();
  const humanPublish = usePublish();
  const botPublish = useBotPublish();
  const [vadStatus, setVadStatus] = useState<string>('pending');
  const [speechValue, setSpeechValue] = useState(0);
  const { startSubscribe, stopSubscribe, registerCanvas, unregisterCanvas, setAudioCallback } = useSubscribe();
  const { init: initMixer, handleAudioData, destroy: destroyMixer } = useAudioMixer();

  const handleLeave = useCallback(() => {
    if (isBot) {
      botPublish.stopPublish();
    } else {
      humanPublish.stopPublish();
    }
    stopSubscribe();
    destroyMixer();
    disconnect();
    setJoined(false);
  }, [isBot, botPublish, humanPublish, stopSubscribe, destroyMixer, disconnect, setJoined]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    (async () => {
      try {
        setStatus('Connecting to relay...');
        const session = await connect();

        setStatus('Starting media...');
        initMixer();
        setAudioCallback(handleAudioData);

        if (isBot) {
          const stream = await botPublish.startPublish(session, roomId);
          setLocalStream(stream);
        } else {
          const stream = await humanPublish.startPublish(session, roomId);
          setLocalStream(stream);

          setTimeout(() => setVadStatus(humanPublish.getVADStatus()), 3000);
          const speechPoll = setInterval(() => setSpeechValue(humanPublish.getCurrentSpeechState()), 50);
          (window as unknown as Record<string, unknown>).__speechPoll = speechPoll;
        }

        setStatus('Subscribing to room...');
        await startSubscribe(session, roomId);

        setStatus('');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Connection failed';
        setError(msg);
        setStatus('');
      }
    })();

    return () => {
      if (isBot) {
        botPublish.stopPublish();
      } else {
        humanPublish.stopPublish();
      }
      stopSubscribe();
      destroyMixer();
      disconnect();
    };
  }, []);

  return (
    <div className="flex h-screen flex-col bg-gray-900">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-gray-800 px-6 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-white">MOCHA Meet</h1>
          <span className="rounded-full bg-gray-800 px-3 py-0.5 text-sm text-gray-300">
            {roomId}
          </span>
          <span className="text-sm text-gray-400">
            User: <span className="font-medium text-white">{displayName}</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          {status && (
            <span className="text-sm text-yellow-400">{status}</span>
          )}
          {isBot ? (
            <span className="rounded-full bg-indigo-900 px-2 py-0.5 text-xs font-mono text-indigo-300">
              BOT MODE
            </span>
          ) : (
            <>
              <span className={`rounded-full px-2 py-0.5 text-xs font-mono ${
                vadStatus === 'loaded' ? 'bg-green-900 text-green-300' :
                vadStatus === 'failed' ? 'bg-red-900 text-red-300' :
                'bg-yellow-900 text-yellow-300'
              }`}>
                VAD: {vadStatus}
              </span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-mono ${
                speechValue === 2 ? 'bg-green-600 text-white' :
                speechValue === 1 ? 'bg-yellow-600 text-white' :
                'bg-gray-700 text-gray-400'
              }`}>
                Speech: {speechValue === 2 ? 'START' : speechValue === 1 ? 'SPEAKING' : 'SILENT'}
              </span>
            </>
          )}
        </div>
      </header>

      {/* Main content */}
      <main className="relative flex-1 overflow-hidden">
        {error ? (
          <div className="flex h-full items-center justify-center">
            <div className="rounded-lg bg-red-900/30 p-6 text-center">
              <p className="text-lg text-red-300">{error}</p>
              <button
                onClick={handleLeave}
                className="mt-4 rounded-lg bg-gray-700 px-4 py-2 text-sm text-white hover:bg-gray-600"
              >
                Back to lobby
              </button>
            </div>
          </div>
        ) : (
          <div className="flex h-full">
            <div className="flex-1">
              <VideoGrid onCanvasRef={registerCanvas} onCanvasUnmount={unregisterCanvas} />
            </div>
            <div className="w-72 overflow-y-auto border-l border-gray-800 p-4">
              <NetworkControls />
              <div className="mt-4">
                <SelfView stream={localStream} />
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Control bar */}
      <footer className="border-t border-gray-800">
        <ControlBar onLeave={handleLeave} />
      </footer>
    </div>
  );
}
