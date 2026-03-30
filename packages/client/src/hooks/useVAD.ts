// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview VAD Hook
 *
 * React hook for managing Voice Activity Detection state.
 * Handles VAD instance lifecycle and audio processing.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useStore } from '../store';
import type { VAD, VADResult, LibfvadModule, SileroVADFactory } from '@web-moq/media';
import { LibfvadVAD, SileroVAD } from '@web-moq/media';

interface UseVADOptions {
  /** Media stream to analyze */
  stream: MediaStream | null;
  /** libfvad WASM module loader (required if using libfvad) */
  libfvadLoader?: () => Promise<LibfvadModule>;
  /** Silero VAD factory (required if using silero) */
  sileroFactory?: SileroVADFactory;
}

interface UseVADReturn {
  /** Whether VAD is ready */
  isReady: boolean;
  /** Whether speech is detected */
  isSpeaking: boolean;
  /** Latest VAD result */
  result: VADResult | null;
  /** Audio context for visualization */
  audioContext: AudioContext | null;
  /** Audio source node for visualization */
  sourceNode: MediaStreamAudioSourceNode | null;
  /** Error if VAD failed to initialize */
  error: string | null;
}

/**
 * Hook for managing Voice Activity Detection
 */
export function useVAD({
  stream,
  libfvadLoader,
  sileroFactory,
}: UseVADOptions): UseVADReturn {
  const { vadEnabled, vadProvider } = useStore();

  const [isReady, setIsReady] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [result, setResult] = useState<VADResult | null>(null);
  const [audioContext, setAudioContext] = useState<AudioContext | null>(null);
  const [sourceNode, setSourceNode] = useState<MediaStreamAudioSourceNode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const vadRef = useRef<VAD | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  // Cleanup function
  const cleanup = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (vadRef.current) {
      vadRef.current.destroy();
      vadRef.current = null;
    }
    if (audioContext) {
      audioContext.close();
      setAudioContext(null);
    }
    setSourceNode(null);
    setIsReady(false);
    setIsSpeaking(false);
    setResult(null);
  }, [audioContext]);

  // Initialize VAD when stream and settings are ready
  useEffect(() => {
    if (!vadEnabled || !stream) {
      cleanup();
      return;
    }

    // Check for required loaders
    if (vadProvider === 'libfvad' && !libfvadLoader) {
      setError('libfvad loader not provided');
      return;
    }
    if (vadProvider === 'silero' && !sileroFactory) {
      setError('Silero factory not provided');
      return;
    }

    let cancelled = false;

    async function initVAD() {
      try {
        setError(null);

        // Create audio context
        const ctx = new AudioContext({ sampleRate: 48000 });
        const source = ctx.createMediaStreamSource(stream!);

        if (cancelled) {
          ctx.close();
          return;
        }

        setAudioContext(ctx);
        setSourceNode(source);

        // Create VAD instance
        let vad: VAD;
        if (vadProvider === 'libfvad' && libfvadLoader) {
          vad = new LibfvadVAD(
            { provider: 'libfvad', sampleRate: 48000, frameSize: 480 },
            libfvadLoader
          );
        } else if (vadProvider === 'silero' && sileroFactory) {
          vad = new SileroVAD(
            { provider: 'silero', sampleRate: 48000, frameSize: 480 },
            sileroFactory
          );
        } else {
          throw new Error(`Unknown VAD provider: ${vadProvider}`);
        }

        await vad.init();

        if (cancelled) {
          vad.destroy();
          ctx.close();
          return;
        }

        vadRef.current = vad;

        // Set up event handlers
        vad.on('speech-start', () => setIsSpeaking(true));
        vad.on('speech-end', () => setIsSpeaking(false));
        vad.on('vad-result', (r) => setResult(r));

        // Create audio processor
        // Note: ScriptProcessorNode is deprecated but still widely supported
        // AudioWorklet would be better but requires more setup
        const processor = ctx.createScriptProcessor(480, 1, 1);
        processor.onaudioprocess = (e) => {
          const inputData = e.inputBuffer.getChannelData(0);
          try {
            vad.process(inputData);
          } catch (err) {
            console.error('VAD processing error:', err);
          }
        };

        source.connect(processor);
        processor.connect(ctx.destination);
        processorRef.current = processor;

        setIsReady(true);
      } catch (err) {
        console.error('Failed to initialize VAD:', err);
        setError((err as Error).message);
      }
    }

    initVAD();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [vadEnabled, vadProvider, stream, libfvadLoader, sileroFactory, cleanup]);

  return {
    isReady,
    isSpeaking,
    result,
    audioContext,
    sourceNode,
    error,
  };
}
