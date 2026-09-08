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

export type StudioStatus =
  | 'idle'
  | 'requesting-media'
  | 'connecting'
  | 'publishing'
  | 'live'
  | 'error';

export interface StudioState {
  status: StudioStatus;
  error?: string;
  videoTrackAlias?: bigint;
  audioTrackAlias?: bigint;
}

export function useStudio(roomId: string) {
  const relayUrl = useSessionStore((s) => s.relayUrl);
  const setConn = useSessionStore((s) => s.setConn);

  const [state, setState] = useState<StudioState>({ status: 'idle' });
  const streamRef = useRef<MediaStream | null>(null);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const connRef = useRef<RoomConnection | null>(null);

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (connRef.current) {
        void closeConnection(connRef.current);
        connRef.current = null;
      }
      setConn({ status: 'idle' });
    };
  }, [setConn]);

  const attachPreview = (el: HTMLVideoElement | null) => {
    previewRef.current = el;
    if (el && streamRef.current) {
      el.srcObject = streamRef.current;
    }
  };

  const start = async () => {
    if (state.status !== 'idle' && state.status !== 'error') return;
    try {
      setState({ status: 'requesting-media' });
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      });
      streamRef.current = stream;
      if (previewRef.current) previewRef.current.srcObject = stream;

      setState({ status: 'connecting' });
      setConn({ status: 'connecting' });
      const conn = await connectToRelay(relayUrl, roomId);
      connRef.current = conn;
      setConn({ status: 'connected', connection: conn });

      setState({ status: 'publishing' });

      // Split MediaStream into video-only + audio-only streams so each
      // MSF track corresponds to a single MoQT track.
      const videoTrack = stream.getVideoTracks()[0];
      const audioTrack = stream.getAudioTracks()[0];

      let videoAlias: bigint | undefined;
      let audioAlias: bigint | undefined;

      if (videoTrack) {
        const videoStream = new MediaStream([videoTrack]);
        videoAlias = await conn.media.publish(
          conn.namespace,
          VIDEO_TRACK_NAME,
          videoStream,
          VIDEO_CONFIG
        );
      }
      if (audioTrack) {
        const audioStream = new MediaStream([audioTrack]);
        audioAlias = await conn.media.publish(
          conn.namespace,
          AUDIO_TRACK_NAME,
          audioStream,
          AUDIO_CONFIG
        );
      }

      setState({
        status: 'live',
        videoTrackAlias: videoAlias,
        audioTrackAlias: audioAlias,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ status: 'error', error: message });
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (connRef.current) {
        await closeConnection(connRef.current);
        connRef.current = null;
      }
      setConn({ status: 'error', message });
    }
  };

  const stop = async () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (previewRef.current) previewRef.current.srcObject = null;
    if (connRef.current) {
      await closeConnection(connRef.current);
      connRef.current = null;
    }
    setState({ status: 'idle' });
    setConn({ status: 'idle' });
  };

  return { state, start, stop, attachPreview };
}
