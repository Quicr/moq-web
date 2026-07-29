import { useRef, useCallback, useEffect } from 'react';

interface AudioSource {
  gainNode: GainNode;
  nextStartTime: number;
}

export function useAudioMixer() {
  const ctxRef = useRef<AudioContext | null>(null);
  const sourcesRef = useRef<Map<string, AudioSource>>(new Map());

  const init = useCallback(() => {
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext({ sampleRate: 48000 });
    }
    return ctxRef.current;
  }, []);

  const handleAudioData = useCallback((participantId: string, audioData: AudioData) => {
    const ctx = ctxRef.current;
    if (!ctx || ctx.state === 'closed') {
      audioData.close();
      return;
    }

    // Resume context on first audio (browser autoplay policy)
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    let source = sourcesRef.current.get(participantId);
    if (!source) {
      const gainNode = ctx.createGain();
      gainNode.gain.value = 1.0;
      gainNode.connect(ctx.destination);
      source = { gainNode, nextStartTime: ctx.currentTime };
      sourcesRef.current.set(participantId, source);
    }

    // Convert AudioData to AudioBuffer and schedule playback
    const numberOfFrames = audioData.numberOfFrames;
    const numberOfChannels = audioData.numberOfChannels;
    const sampleRate = audioData.sampleRate;

    const audioBuffer = ctx.createBuffer(numberOfChannels, numberOfFrames, sampleRate);
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const channelData = new Float32Array(numberOfFrames);
      audioData.copyTo(channelData, { planeIndex: ch, format: 'f32-planar' });
      audioBuffer.copyToChannel(channelData, ch);
    }
    audioData.close();

    const bufferSource = ctx.createBufferSource();
    bufferSource.buffer = audioBuffer;
    bufferSource.connect(source.gainNode);

    const startTime = Math.max(source.nextStartTime, ctx.currentTime);
    bufferSource.start(startTime);
    source.nextStartTime = startTime + audioBuffer.duration;
  }, []);

  const removeParticipant = useCallback((participantId: string) => {
    const source = sourcesRef.current.get(participantId);
    if (source) {
      source.gainNode.disconnect();
      sourcesRef.current.delete(participantId);
    }
  }, []);

  const destroy = useCallback(() => {
    for (const [, source] of sourcesRef.current) {
      source.gainNode.disconnect();
    }
    sourcesRef.current.clear();
    if (ctxRef.current && ctxRef.current.state !== 'closed') {
      ctxRef.current.close();
      ctxRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      destroy();
    };
  }, [destroy]);

  return { init, handleAudioData, removeParticipant, destroy };
}
