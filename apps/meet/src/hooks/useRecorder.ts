import { useRef, useCallback, useState } from 'react';

export function useRecorder() {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const [recording, setRecording] = useState(false);

  const startRecording = useCallback(async () => {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' } as MediaTrackConstraints,
      audio: true,
    });
    streamRef.current = stream;
    chunksRef.current = [];

    const recorder = new MediaRecorder(stream, {
      mimeType: 'video/webm;codecs=vp9,opus',
    });

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `moq-meet-${new Date().toISOString().slice(0, 19)}.webm`;
      a.click();
      URL.revokeObjectURL(url);
      setRecording(false);
    };

    recorder.start(1000);
    recorderRef.current = recorder;
    setRecording(true);

    stream.getVideoTracks()[0].onended = () => {
      stopRecording();
    };
  }, []);

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    recorderRef.current = null;
  }, []);

  return { recording, startRecording, stopRecording };
}
