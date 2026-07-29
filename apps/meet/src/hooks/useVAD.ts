import { useRef, useCallback } from 'react';
import { MicVAD } from '@ricky0123/vad-web';

type SpeechState = 'silent' | 'pending_start' | 'speech_start' | 'speaking' | 'pending_stop';

interface VADInternal {
  rawSpeaking: boolean;
  state: SpeechState;
  stateEnteredAt: number;
  needsKeyframe: boolean;
}

const SPEECH_START_DEBOUNCE_MS = 100;
const SPEECH_START_HOLD_MS = 300;
const SPEECH_STOP_DEBOUNCE_MS = 500;

export function useVAD() {
  const vadRef = useRef<MicVAD | null>(null);
  const internalRef = useRef<VADInternal>({
    rawSpeaking: false,
    state: 'silent',
    stateEnteredAt: 0,
    needsKeyframe: false,
  });
  const silentFramesRef = useRef(0);
  const statusRef = useRef<'pending' | 'loaded' | 'failed'>('pending');

  const startVAD = useCallback(async (stream: MediaStream) => {
    if (vadRef.current) return;

    try {
      const vad = await MicVAD.new({
        baseAssetPath: '/vad/',
        onnxWASMBasePath: '/vad/',
        getStream: async () => stream,
        pauseStream: async () => {},
        resumeStream: async () => stream,
        startOnLoad: true,
        model: 'v5',
        onSpeechStart: () => {
          internalRef.current.rawSpeaking = true;
        },
        onSpeechRealStart: () => {
          internalRef.current.rawSpeaking = true;
        },
        onFrameProcessed: (probabilities) => {
          const wasSpeaking = internalRef.current.rawSpeaking;
          if (probabilities.isSpeech > 0.5) {
            internalRef.current.rawSpeaking = true;
            silentFramesRef.current = 0;
          } else {
            silentFramesRef.current++;
            // Require 3 consecutive silent frames (~300ms) before clearing
            if (silentFramesRef.current >= 3) {
              internalRef.current.rawSpeaking = false;
            }
          }
          if (!wasSpeaking && internalRef.current.rawSpeaking) {
            console.log('[VAD] speech detected, isSpeech=', probabilities.isSpeech);
          }
        },
        onSpeechEnd: () => {
          internalRef.current.rawSpeaking = false;
        },
        onVADMisfire: () => {
          internalRef.current.rawSpeaking = false;
        },
      });

      vadRef.current = vad;
      statusRef.current = 'loaded';
      console.log('[VAD] Silero model loaded successfully');
    } catch (err) {
      statusRef.current = 'failed';
      console.error('[VAD] Failed to initialize:', err);
    }
  }, []);

  const stopVAD = useCallback(async () => {
    if (vadRef.current) {
      await vadRef.current.destroy();
      vadRef.current = null;
    }
    internalRef.current = {
      rawSpeaking: false,
      state: 'silent',
      stateEnteredAt: 0,
      needsKeyframe: false,
    };
  }, []);

  /**
   * Called per video object. Returns the SPEECH_ACTIVITY value to stamp:
   *   2 = SPEECH_START (reported on forced keyframe after debounced speech onset)
   *   1 = SPEAKING (continuous speech after START was held for 150ms)
   *   0 = SILENT (no speech detected for 300ms)
   *
   * State flow: silent → pending_start(100ms) → speech_start(150ms, report 2) → speaking(report 1) → pending_stop(300ms) → silent
   *
   * When entering speech_start, sets needsKeyframe=true. Caller must check
   * consumeKeyframeRequest() and force an I-frame before the next encode.
   */
  const getSpeechValue = useCallback((): number => {
    const s = internalRef.current;
    const now = Date.now();

    switch (s.state) {
      case 'silent':
        if (s.rawSpeaking) {
          s.state = 'pending_start';
          s.stateEnteredAt = now;
        }
        return 0;

      case 'pending_start':
        if (!s.rawSpeaking && now - s.stateEnteredAt > SPEECH_START_DEBOUNCE_MS) {
          // Only reset if we've been in pending_start long enough and still no speech
          s.state = 'silent';
          return 0;
        }
        if (s.rawSpeaking && now - s.stateEnteredAt >= SPEECH_START_DEBOUNCE_MS) {
          s.state = 'speech_start';
          s.stateEnteredAt = now;
          s.needsKeyframe = true;
        }
        return 0;

      case 'speech_start':
        if (now - s.stateEnteredAt >= SPEECH_START_HOLD_MS) {
          s.state = s.rawSpeaking ? 'speaking' : 'pending_stop';
          s.stateEnteredAt = now;
          return 1;
        }
        return 2;

      case 'speaking':
        if (!s.rawSpeaking) {
          s.state = 'pending_stop';
          s.stateEnteredAt = now;
        }
        return 1;

      case 'pending_stop':
        if (s.rawSpeaking) {
          s.state = 'speaking';
          return 1;
        }
        if (now - s.stateEnteredAt >= SPEECH_STOP_DEBOUNCE_MS) {
          s.state = 'silent';
          return 0;
        }
        return 1;
    }
  }, []);

  const consumeKeyframeRequest = useCallback((): boolean => {
    if (internalRef.current.needsKeyframe) {
      internalRef.current.needsKeyframe = false;
      return true;
    }
    return false;
  }, []);

  const getVADStatus = useCallback(() => statusRef.current, []);

  const getCurrentState = useCallback((): number => {
    const s = internalRef.current;
    switch (s.state) {
      case 'silent': return 0;
      case 'pending_start': return 0;
      case 'speech_start': return 2;
      case 'speaking': return 1;
      case 'pending_stop': return 1;
    }
  }, []);

  return { startVAD, stopVAD, getSpeechValue, consumeKeyframeRequest, getVADStatus, getCurrentState };
}
