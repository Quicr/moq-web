// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { useCallback, useEffect, useRef, useState } from 'react';

export interface CameraOptions {
  video?: MediaTrackConstraints | boolean;
  audio?: MediaTrackConstraints | boolean;
}

export interface CameraState {
  stream: MediaStream | null;
  active: boolean;
  error: Error | null;
  start: () => Promise<void>;
  stop: () => void;
}

export function useLocalCamera(opts: CameraOptions = { video: true, audio: true }): CameraState {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const stop = useCallback(() => {
    setStream((cur) => {
      cur?.getTracks().forEach((t) => t.stop());
      return null;
    });
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: optsRef.current.video ?? true,
        audio: optsRef.current.audio ?? true,
      });
      setStream(s);
    } catch (e) {
      setError(e as Error);
    }
  }, []);

  useEffect(() => () => stop(), [stop]);

  return { stream, active: stream !== null, error, start, stop };
}
