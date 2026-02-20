// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Audio Player Component
 *
 * Plays decoded audio data using Web Audio API.
 * Receives AudioData objects from the MOQT subscription pipeline
 * and plays them through the speaker.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { isDebugMode } from '../common/DevSettingsPanel';

interface AudioPlayerProps {
  subscriptionId: number;
  onAudioData: (handler: (data: { subscriptionId: number; audioData: AudioData }) => void) => () => void;
}

// Buffer time to add at start to allow audio to accumulate (reduces glitches)
const INITIAL_BUFFER_TIME = 0.05; // 50ms
// Max gap allowed before resetting schedule (handles network delays)
const MAX_SCHEDULE_GAP = 0.3; // 300ms

export const AudioPlayer: React.FC<AudioPlayerProps> = ({ subscriptionId, onAudioData }) => {
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(1.0);
  const [isMuted, setIsMuted] = useState(false);
  const [audioStats, setAudioStats] = useState({ framesPlayed: 0, sampleRate: 0 });
  const nextPlayTimeRef = useRef<number>(0);
  const isInitializedRef = useRef(false);
  const isFirstFrameRef = useRef(true);

  // Initialize AudioContext on first user interaction or when playing starts
  const initializeAudio = useCallback(() => {
    if (audioContextRef.current) return;

    if (isDebugMode()) {
      console.log('[AudioPlayer] Initializing AudioContext');
    }
    const audioContext = new AudioContext({ sampleRate: 48000 });
    audioContextRef.current = audioContext;

    const gainNode = audioContext.createGain();
    gainNode.gain.value = isMuted ? 0 : volume;
    gainNode.connect(audioContext.destination);
    gainNodeRef.current = gainNode;

    nextPlayTimeRef.current = audioContext.currentTime;
    isInitializedRef.current = true;
    isFirstFrameRef.current = true; // Reset for fresh start

    if (isDebugMode()) {
      console.log('[AudioPlayer] AudioContext initialized', {
        sampleRate: audioContext.sampleRate,
        state: audioContext.state,
      });
    }

    // Resume if suspended (browser autoplay policy)
    if (audioContext.state === 'suspended') {
      audioContext.resume().then(() => {
        if (isDebugMode()) {
          console.log('[AudioPlayer] AudioContext resumed');
        }
      });
    }
  }, [volume, isMuted]);

  // Handle incoming audio data
  useEffect(() => {
    if (isDebugMode()) {
      console.log('[AudioPlayer] Setting up audio data handler for subscription', subscriptionId);
    }

    const unsubscribe = onAudioData((data) => {
      if (isDebugMode()) {
        console.log('[AudioPlayer] Received audio-data event', {
          receivedSubscriptionId: data.subscriptionId,
          expectedSubscriptionId: subscriptionId,
          matches: data.subscriptionId === subscriptionId,
          hasAudioData: !!data.audioData,
        });
      }

      if (data.subscriptionId !== subscriptionId) return;

      const audioData = data.audioData;

      // Initialize audio context on first audio data if not already done
      if (!audioContextRef.current) {
        initializeAudio();
      }

      const audioContext = audioContextRef.current;
      const gainNode = gainNodeRef.current;
      if (!audioContext || !gainNode) return;

      // Resume if suspended
      if (audioContext.state === 'suspended') {
        audioContext.resume();
      }

      try {
        // Create AudioBuffer from AudioData
        const numberOfChannels = audioData.numberOfChannels;
        const numberOfFrames = audioData.numberOfFrames;
        const sampleRate = audioData.sampleRate;

        if (isDebugMode()) {
          console.log('[AudioPlayer] Creating AudioBuffer', {
            numberOfChannels,
            numberOfFrames,
            sampleRate,
            contextSampleRate: audioContext.sampleRate,
          });
        }

        const audioBuffer = audioContext.createBuffer(
          numberOfChannels,
          numberOfFrames,
          sampleRate
        );

        // Copy samples from AudioData to AudioBuffer
        for (let channel = 0; channel < numberOfChannels; channel++) {
          const channelData = audioBuffer.getChannelData(channel);
          audioData.copyTo(channelData, {
            planeIndex: channel,
            format: 'f32-planar',
          });
        }

        // Create source and play
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(gainNode);

        // Schedule playback with improved timing
        const currentTime = audioContext.currentTime;
        let playTime: number;

        if (isFirstFrameRef.current) {
          // First frame: add initial buffer to let more audio accumulate
          playTime = currentTime + INITIAL_BUFFER_TIME;
          isFirstFrameRef.current = false;
          if (isDebugMode()) {
            console.log('[AudioPlayer] First frame, adding initial buffer', {
              currentTime,
              playTime,
              bufferTime: INITIAL_BUFFER_TIME,
            });
          }
        } else {
          // Check if we've fallen too far behind (network delay, etc.)
          const gap = currentTime - nextPlayTimeRef.current;
          if (gap > MAX_SCHEDULE_GAP) {
            // Reset scheduling to current time + small buffer
            playTime = currentTime + 0.05; // 50ms ahead
            if (isDebugMode()) {
              console.log('[AudioPlayer] Schedule gap detected, resetting', {
                gap,
                oldNextTime: nextPlayTimeRef.current,
                newPlayTime: playTime,
              });
            }
          } else {
            // Normal case: schedule right after previous buffer
            playTime = Math.max(currentTime, nextPlayTimeRef.current);
          }
        }

        source.start(playTime);

        if (isDebugMode()) {
          console.log('[AudioPlayer] Scheduled audio playback', {
            currentTime,
            playTime,
            duration: audioBuffer.duration,
            gainValue: gainNode.gain.value,
          });
        }

        // Update next play time
        nextPlayTimeRef.current = playTime + audioBuffer.duration;

        // Update stats
        setAudioStats(prev => ({
          framesPlayed: prev.framesPlayed + 1,
          sampleRate,
        }));

        setIsPlaying(true);

        // Close the AudioData to free resources
        audioData.close();
      } catch (err) {
        console.error('[AudioPlayer] Error playing audio:', err);
      }
    });

    return () => {
      if (isDebugMode()) {
        console.log('[AudioPlayer] Cleanup: unsubscribing audio handler');
      }
      unsubscribe();
    };
  }, [subscriptionId, onAudioData, initializeAudio]);

  // Update gain when volume or mute changes
  useEffect(() => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = isMuted ? 0 : volume;
    }
  }, [volume, isMuted]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
    };
  }, []);

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
  };

  const toggleMute = () => {
    setIsMuted(!isMuted);
  };

  return (
    <div className="flex items-center gap-3 p-3 bg-gray-100 dark:bg-gray-800 rounded-lg">
      {/* Audio indicator */}
      <div className={`w-3 h-3 rounded-full ${isPlaying ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`} />

      {/* Mute button */}
      <button
        onClick={toggleMute}
        className="p-2 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
        title={isMuted ? 'Unmute' : 'Mute'}
      >
        {isMuted ? (
          <svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
          </svg>
        ) : (
          <svg className="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
          </svg>
        )}
      </button>

      {/* Volume slider */}
      <input
        type="range"
        min="0"
        max="1"
        step="0.1"
        value={volume}
        onChange={handleVolumeChange}
        className="w-24 h-2 bg-gray-300 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer"
      />

      {/* Stats */}
      <div className="text-xs text-gray-500 dark:text-gray-400">
        {audioStats.sampleRate > 0 ? `${audioStats.sampleRate / 1000}kHz` : '--'} | {audioStats.framesPlayed} frames
      </div>
    </div>
  );
};
