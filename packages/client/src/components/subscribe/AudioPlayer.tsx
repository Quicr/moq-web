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
import { useStore } from '../../store';

interface AudioPlayerProps {
  subscriptionId: number;
  onAudioData: (handler: (data: { subscriptionId: number; audioData: AudioData }) => void) => () => void;
  /** Get current video playback time in milliseconds for A/V sync */
  getVideoTimeMs?: () => number;
}

// Buffer time to add at start to allow audio to accumulate (reduces glitches)
const INITIAL_BUFFER_TIME = 0.1; // 100ms
// Max gap allowed before resetting schedule (handles network delays)
const MAX_SCHEDULE_GAP = 0.3; // 300ms

// Audio analysis data
interface AudioAnalysis {
  frameNum: number;
  timestampUs: number;
  timestampSec: number;
  durationSec: number;
  sampleRate: number;
  numberOfFrames: number;
  numberOfChannels: number;
  minSample: number;
  maxSample: number;
  avgAbsSample: number;
  hasClipping: boolean;
  gapFromPrevMs: number | null;
}

export const AudioPlayer: React.FC<AudioPlayerProps> = ({ subscriptionId, onAudioData, getVideoTimeMs }) => {
  const updateSyncTime = useStore(state => state.updateSyncTime);
  const onSeekStart = useStore(state => state.onSeekStart);
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(1.0);
  const [isMuted, setIsMuted] = useState(false);
  const [audioStats, setAudioStats] = useState({ framesPlayed: 0, sampleRate: 0 });
  const nextPlayTimeRef = useRef<number>(0);
  const isInitializedRef = useRef(false);
  const isFirstFrameRef = useRef(true);
  // Track the offset between content time (PTS) and AudioContext time
  const timeOffsetRef = useRef<number | null>(null);
  // Track the first PTS we received
  const firstPtsRef = useRef<number | null>(null);
  // Audio analysis
  const analysisDataRef = useRef<AudioAnalysis[]>([]);
  const prevEndTimeRef = useRef<number | null>(null);
  // Last sync time sent to worker (avoid flooding)
  const lastSyncTimeSentRef = useRef<number>(0);

  // Initialize AudioContext with the content's sample rate
  const initializeAudio = useCallback((contentSampleRate: number) => {
    if (audioContextRef.current) {
      // If already initialized with different sample rate, close and recreate
      if (audioContextRef.current.sampleRate !== contentSampleRate) {
        console.log('[AudioPlayer] Sample rate mismatch, recreating AudioContext', {
          current: audioContextRef.current.sampleRate,
          content: contentSampleRate,
        });
        audioContextRef.current.close();
        audioContextRef.current = null;
        gainNodeRef.current = null;
      } else {
        return; // Already initialized with correct sample rate
      }
    }

    console.log('[AudioPlayer] Initializing AudioContext with sample rate:', contentSampleRate);
    const audioContext = new AudioContext({ sampleRate: contentSampleRate });
    audioContextRef.current = audioContext;

    const gainNode = audioContext.createGain();
    gainNode.gain.value = isMuted ? 0 : volume;
    gainNode.connect(audioContext.destination);
    gainNodeRef.current = gainNode;

    nextPlayTimeRef.current = audioContext.currentTime;
    isInitializedRef.current = true;
    isFirstFrameRef.current = true; // Reset for fresh start
    timeOffsetRef.current = null; // Reset time offset for new context

    console.log('[AudioPlayer] AudioContext initialized', {
      sampleRate: audioContext.sampleRate,
      state: audioContext.state,
    });

    // Resume if suspended (browser autoplay policy)
    if (audioContext.state === 'suspended') {
      audioContext.resume().then(() => {
        console.log('[AudioPlayer] AudioContext resumed');
      });
    }
  }, [volume, isMuted]);

  // Reset timing state on seek to prevent stale A/V sync calculations
  useEffect(() => {
    const unsubscribe = onSeekStart(({ subscriptionId: seekSubId }) => {
      // Reset timing if this is our subscription or its paired video subscription
      // (we receive audio subscription ID, but seek happens on video subscription)
      console.log('[AudioPlayer] Seek detected, resetting timing state', {
        ourSubscriptionId: subscriptionId,
        seekSubscriptionId: seekSubId,
      });
      isFirstFrameRef.current = true;
      timeOffsetRef.current = null;
      firstPtsRef.current = null;
      nextPlayTimeRef.current = audioContextRef.current?.currentTime ?? 0;
    });

    return unsubscribe;
  }, [onSeekStart, subscriptionId]);

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
      const sampleRate = audioData.sampleRate;

      // Initialize audio context with content's sample rate
      if (!audioContextRef.current || audioContextRef.current.sampleRate !== sampleRate) {
        initializeAudio(sampleRate);
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

        // Get timestamp from AudioData (microseconds)
        const audioTimestampUs = audioData.timestamp;
        const audioTimestampSec = audioTimestampUs / 1_000_000;

        // Always log first 10 frames for debugging
        if (audioStats.framesPlayed < 10) {
          console.log('[AudioPlayer] DEBUG frame', {
            frameNum: audioStats.framesPlayed,
            audioTimestampUs,
            audioTimestampSec,
            numberOfFrames: audioData.numberOfFrames,
            sampleRate: audioData.sampleRate,
            durationSec: audioData.numberOfFrames / audioData.sampleRate,
          });
        }

        if (isDebugMode()) {
          console.log('[AudioPlayer] Creating AudioBuffer', {
            numberOfChannels,
            numberOfFrames,
            sampleRate,
            contextSampleRate: audioContext.sampleRate,
            audioTimestampUs,
            audioTimestampSec,
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

        // Analyze audio for first 50 frames
        const frameNum = analysisDataRef.current.length;
        if (frameNum < 50) {
          const channelData = audioBuffer.getChannelData(0); // Analyze first channel
          let minSample = Infinity;
          let maxSample = -Infinity;
          let sumAbs = 0;
          for (let i = 0; i < channelData.length; i++) {
            const sample = channelData[i];
            minSample = Math.min(minSample, sample);
            maxSample = Math.max(maxSample, sample);
            sumAbs += Math.abs(sample);
          }
          const avgAbsSample = sumAbs / channelData.length;
          const hasClipping = maxSample >= 0.99 || minSample <= -0.99;

          // Calculate gap from previous frame
          const durationSec = numberOfFrames / sampleRate;
          const expectedEndTime = prevEndTimeRef.current;
          const gapFromPrevMs = expectedEndTime !== null
            ? (audioTimestampSec - expectedEndTime) * 1000
            : null;

          const analysis: AudioAnalysis = {
            frameNum,
            timestampUs: audioTimestampUs,
            timestampSec: audioTimestampSec,
            durationSec,
            sampleRate,
            numberOfFrames,
            numberOfChannels,
            minSample,
            maxSample,
            avgAbsSample,
            hasClipping,
            gapFromPrevMs,
          };
          analysisDataRef.current.push(analysis);
          prevEndTimeRef.current = audioTimestampSec + durationSec;

          // Log every 10th frame or interesting frames
          if (frameNum % 10 === 0 || hasClipping || (gapFromPrevMs !== null && Math.abs(gapFromPrevMs) > 5)) {
            console.log('[AudioPlayer] ANALYSIS', analysis);
          }

          // At frame 49, log summary
          if (frameNum === 49) {
            const gaps = analysisDataRef.current
              .filter(a => a.gapFromPrevMs !== null)
              .map(a => a.gapFromPrevMs!);
            const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
            const maxGap = Math.max(...gaps);
            const minGap = Math.min(...gaps);
            const clippingCount = analysisDataRef.current.filter(a => a.hasClipping).length;
            const timestamps = analysisDataRef.current.map(a => a.timestampSec);
            const timestampDiffs = timestamps.slice(1).map((t, i) => t - timestamps[i]);

            console.log('[AudioPlayer] === ANALYSIS SUMMARY (50 frames) ===');
            console.log('[AudioPlayer] Gaps: avg=', avgGap.toFixed(2), 'ms, min=', minGap.toFixed(2), 'ms, max=', maxGap.toFixed(2), 'ms');
            console.log('[AudioPlayer] Clipping frames:', clippingCount);
            console.log('[AudioPlayer] First timestamp:', timestamps[0].toFixed(3), 's');
            console.log('[AudioPlayer] Last timestamp:', timestamps[timestamps.length - 1].toFixed(3), 's');
            console.log('[AudioPlayer] Avg timestamp diff:', (timestampDiffs.reduce((a,b)=>a+b,0)/timestampDiffs.length*1000).toFixed(2), 'ms');
            console.log('[AudioPlayer] Sample rates:', [...new Set(analysisDataRef.current.map(a => a.sampleRate))]);
            console.log('[AudioPlayer] Avg sample level:', (analysisDataRef.current.reduce((a,b)=>a+b.avgAbsSample,0)/50).toFixed(4));
            console.log('[AudioPlayer] Full data:', analysisDataRef.current);
          }
        }

        // Create source and play
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(gainNode);

        // Schedule playback - sync with video if available, otherwise use PTS
        const currentTime = audioContext.currentTime;
        let playTime: number;

        // Get video time for A/V sync (if available)
        const videoTimeMs = getVideoTimeMs?.();
        const videoTimeSec = videoTimeMs !== undefined && videoTimeMs > 0 ? videoTimeMs / 1000 : undefined;

        // Log video time periodically for A/V sync debugging
        if (audioStats.framesPlayed % 50 === 0) {
          console.log('[AudioPlayer] A/V sync check', {
            audioFrame: audioStats.framesPlayed,
            audioTimestampSec,
            videoTimeMs,
            videoTimeSec,
            hasVideoTime: videoTimeSec !== undefined,
          });
        }

        if (isFirstFrameRef.current || timeOffsetRef.current === null) {
          // First frame: establish the time offset
          if (videoTimeSec !== undefined) {
            // Sync with video: calculate offset so audio PTS matches video time
            // Audio should play when video reaches the same PTS
            const audioAheadOfVideo = audioTimestampSec - videoTimeSec;
            playTime = currentTime + Math.max(INITIAL_BUFFER_TIME, audioAheadOfVideo);
            timeOffsetRef.current = playTime - audioTimestampSec;
            console.log('[AudioPlayer] First frame, syncing with video', {
              currentTime,
              playTime,
              audioTimestampSec,
              videoTimeSec,
              audioAheadOfVideo,
              timeOffset: timeOffsetRef.current,
            });
          } else {
            // No video sync - use simple buffering
            playTime = currentTime + INITIAL_BUFFER_TIME;
            timeOffsetRef.current = playTime - audioTimestampSec;
            if (isDebugMode()) {
              console.log('[AudioPlayer] First frame (no video sync)', {
                currentTime,
                playTime,
                audioTimestampSec,
                timeOffset: timeOffsetRef.current,
              });
            }
          }
          firstPtsRef.current = audioTimestampSec;
          isFirstFrameRef.current = false;
        } else {
          // Calculate where this frame should play based on its PTS
          playTime = audioTimestampSec + timeOffsetRef.current;

          // If we have video time, check A/V sync and adjust if needed
          if (videoTimeSec !== undefined) {
            const audioVsVideo = audioTimestampSec - videoTimeSec;
            // If audio is more than 1 second behind video, DROP this frame entirely
            // Playing stale audio is worse than skipping it
            if (audioVsVideo < -1.0) {
              console.log('[AudioPlayer] Audio too far behind video, DROPPING frame', {
                audioVsVideo,
                audioTimestampSec,
                videoTimeSec,
              });
              audioData.close();
              return; // Skip this frame entirely
            }
            // If audio is 200ms-1s behind video, play immediately to catch up
            if (audioVsVideo < -0.2) {
              playTime = currentTime; // Play immediately
              console.log('[AudioPlayer] Audio behind video, catching up', { audioVsVideo });
            } else if (audioVsVideo > 0.5) {
              // Audio is ahead of video - delay
              playTime = currentTime + (audioVsVideo - 0.1); // Play when video catches up
              console.log('[AudioPlayer] Audio ahead of video, delaying', { audioVsVideo, delay: audioVsVideo - 0.1 });
            }
          }

          // Check if we've fallen too far behind (audio scheduling, not A/V)
          const lag = currentTime - playTime;
          if (lag > MAX_SCHEDULE_GAP) {
            // Reset: re-establish time offset from current position
            playTime = currentTime + 0.02; // 20ms ahead
            timeOffsetRef.current = playTime - audioTimestampSec;
            if (isDebugMode()) {
              console.log('[AudioPlayer] Too far behind, resetting time offset', {
                lag,
                newPlayTime: playTime,
                newTimeOffset: timeOffsetRef.current,
              });
            }
          } else if (playTime < currentTime) {
            // Frame is slightly late, play immediately
            playTime = currentTime;
          }
        }

        source.start(playTime);

        if (isDebugMode()) {
          console.log('[AudioPlayer] Scheduled audio playback', {
            currentTime,
            playTime,
            audioTimestampSec,
            duration: audioBuffer.duration,
            gainValue: gainNode.gain.value,
          });
        }

        // Update next play time (for gap detection, not used for scheduling)
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

  // Send video time to audio worker for A/V sync (SharedPlaybackClock)
  // This runs at ~60fps when video is playing, throttled to avoid flooding
  useEffect(() => {
    if (!getVideoTimeMs) return;

    let animationFrameId: number;

    const sendSyncUpdate = () => {
      const videoTimeMs = getVideoTimeMs();
      // Only send if video time has changed significantly (>10ms)
      if (videoTimeMs > 0 && Math.abs(videoTimeMs - lastSyncTimeSentRef.current) > 10) {
        updateSyncTime(subscriptionId, videoTimeMs);
        lastSyncTimeSentRef.current = videoTimeMs;
      }
      animationFrameId = requestAnimationFrame(sendSyncUpdate);
    };

    // Start the sync loop
    animationFrameId = requestAnimationFrame(sendSyncUpdate);

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [subscriptionId, getVideoTimeMs, updateSyncTime]);

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
