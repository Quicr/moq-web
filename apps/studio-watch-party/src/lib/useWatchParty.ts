import { useEffect, useRef, useState } from 'react';
import {
  AUDIO_CONFIG,
  AUDIO_TRACK_NAME,
  VIDEO_CONFIG,
  VIDEO_TRACK_NAME,
  closeConnection,
  connectToRelay,
  type RoomConnection,
} from './session';
import { useSessionStore } from '../stores/session-store';
import { VideoPainter } from './videoPainter';
import { AudioPlayer } from './audioPlayer';

export type WatchStatus =
  | 'idle'
  | 'connecting'
  | 'subscribing'
  | 'watching'
  | 'error';

export interface WatchState {
  status: WatchStatus;
  error?: string;
  videoSubId?: number;
  audioSubId?: number;
  fps: number;
  frames: number;
  audioChunks: number;
}

export function useWatchParty(roomId: string) {
  const relayUrl = useSessionStore((s) => s.relayUrl);
  const setConn = useSessionStore((s) => s.setConn);

  const [state, setState] = useState<WatchState>({
    status: 'idle',
    fps: 0,
    frames: 0,
    audioChunks: 0,
  });

  const painterRef = useRef<VideoPainter | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);
  const connRef = useRef<RoomConnection | null>(null);
  const framesRef = useRef(0);
  const audioChunksRef = useRef(0);
  const statsTimerRef = useRef<number | null>(null);

  if (!painterRef.current) painterRef.current = new VideoPainter();
  if (!playerRef.current) playerRef.current = new AudioPlayer();

  useEffect(() => {
    return () => {
      if (statsTimerRef.current !== null) {
        window.clearInterval(statsTimerRef.current);
        statsTimerRef.current = null;
      }
      painterRef.current?.dispose();
      playerRef.current?.dispose();
      painterRef.current = null;
      playerRef.current = null;
      if (connRef.current) {
        void closeConnection(connRef.current);
        connRef.current = null;
      }
      setConn({ status: 'idle' });
    };
  }, [setConn]);

  const attachCanvas = (canvas: HTMLCanvasElement | null) => {
    painterRef.current?.attach(canvas);
  };

  const start = async () => {
    if (state.status !== 'idle' && state.status !== 'error') return;
    try {
      setState((s) => ({ ...s, status: 'connecting', error: undefined }));
      setConn({ status: 'connecting' });
      const conn = await connectToRelay(relayUrl, roomId);
      connRef.current = conn;
      setConn({ status: 'connected', connection: conn });

      // Unlock the AudioContext now — must happen on the click that started this.
      await playerRef.current?.resume();

      conn.media.on('video-frame', ({ frame }) => {
        framesRef.current++;
        painterRef.current?.push(frame);
      });
      conn.media.on('audio-data', ({ audioData }) => {
        audioChunksRef.current++;
        playerRef.current?.push(audioData);
      });

      setState((s) => ({ ...s, status: 'subscribing' }));

      const videoSubId = await conn.media.subscribe(
        conn.namespace,
        VIDEO_TRACK_NAME,
        VIDEO_CONFIG,
        'video'
      );
      const audioSubId = await conn.media.subscribe(
        conn.namespace,
        AUDIO_TRACK_NAME,
        AUDIO_CONFIG,
        'audio'
      );

      setState((s) => ({
        ...s,
        status: 'watching',
        videoSubId,
        audioSubId,
      }));

      statsTimerRef.current = window.setInterval(() => {
        setState((prev) => ({
          ...prev,
          fps: painterRef.current?.currentFps() ?? 0,
          frames: framesRef.current,
          audioChunks: audioChunksRef.current,
        }));
      }, 500);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, status: 'error', error: message }));
      if (connRef.current) {
        await closeConnection(connRef.current);
        connRef.current = null;
      }
      setConn({ status: 'error', message });
    }
  };

  const stop = async () => {
    if (statsTimerRef.current !== null) {
      window.clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }
    if (connRef.current) {
      await closeConnection(connRef.current);
      connRef.current = null;
    }
    setState({
      status: 'idle',
      fps: 0,
      frames: 0,
      audioChunks: 0,
    });
    framesRef.current = 0;
    audioChunksRef.current = 0;
    setConn({ status: 'idle' });
  };

  const setMuted = (muted: boolean) => {
    playerRef.current?.setMuted(muted);
  };

  return { state, start, stop, attachCanvas, setMuted };
}
