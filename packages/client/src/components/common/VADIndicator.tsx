// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Voice Activity Detection Indicator
 *
 * Visual indicator showing VAD state and audio levels.
 * Only renders when VAD visualization is enabled.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useStore } from '../../store';
import type { VADResult } from '@web-moq/media';

interface VADIndicatorProps {
  /** Audio context for analysis */
  audioContext?: AudioContext | null;
  /** Audio source node */
  sourceNode?: MediaStreamAudioSourceNode | null;
  /** Whether speech is detected */
  isSpeaking?: boolean;
  /** Current VAD result */
  vadResult?: VADResult | null;
  /** CSS class name */
  className?: string;
}

/**
 * Audio bars visualization showing volume levels and speech state
 */
export function VADIndicator({
  audioContext,
  sourceNode,
  isSpeaking = false,
  vadResult,
  className = '',
}: VADIndicatorProps) {
  const { vadVisualizationEnabled } = useStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationRef = useRef<number>(0);
  const [levels, setLevels] = useState<number[]>(new Array(8).fill(0));

  // Setup analyser when audio context is available
  useEffect(() => {
    if (!vadVisualizationEnabled || !audioContext || !sourceNode) {
      return;
    }

    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    sourceNode.connect(analyser);
    analyserRef.current = analyser;

    return () => {
      sourceNode.disconnect(analyser);
      analyserRef.current = null;
    };
  }, [vadVisualizationEnabled, audioContext, sourceNode]);

  // Animation loop for visualization
  const animate = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) {
      animationRef.current = requestAnimationFrame(animate);
      return;
    }

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);

    // Calculate 8 frequency band levels
    const bandSize = Math.floor(bufferLength / 8);
    const newLevels = [];
    for (let i = 0; i < 8; i++) {
      let sum = 0;
      for (let j = 0; j < bandSize; j++) {
        sum += dataArray[i * bandSize + j];
      }
      // Normalize to 0-1 range
      newLevels.push(sum / (bandSize * 255));
    }
    setLevels(newLevels);

    animationRef.current = requestAnimationFrame(animate);
  }, []);

  // Start/stop animation
  useEffect(() => {
    if (!vadVisualizationEnabled) {
      return;
    }

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [vadVisualizationEnabled, animate]);

  // Draw canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !vadVisualizationEnabled) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const barWidth = width / 8 - 2;

    ctx.clearRect(0, 0, width, height);

    // Draw bars
    levels.forEach((level, i) => {
      const barHeight = Math.max(4, level * height);
      const x = i * (barWidth + 2) + 1;
      const y = height - barHeight;

      // Color based on speech state
      if (isSpeaking) {
        // Green gradient when speaking
        const gradient = ctx.createLinearGradient(x, height, x, y);
        gradient.addColorStop(0, '#22c55e');
        gradient.addColorStop(1, '#86efac');
        ctx.fillStyle = gradient;
      } else {
        // Gray/blue gradient when silent
        const gradient = ctx.createLinearGradient(x, height, x, y);
        gradient.addColorStop(0, '#6b7280');
        gradient.addColorStop(1, '#9ca3af');
        ctx.fillStyle = gradient;
      }

      // Round the top of bars
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, [2, 2, 0, 0]);
      ctx.fill();
    });
  }, [levels, isSpeaking, vadVisualizationEnabled]);

  if (!vadVisualizationEnabled) {
    return null;
  }

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <canvas
        ref={canvasRef}
        width={64}
        height={24}
        className="rounded"
        title={vadResult ? `Speech: ${(vadResult.probability * 100).toFixed(0)}%` : 'VAD'}
      />
      {isSpeaking && (
        <span className="text-xs text-green-500 font-medium">Speaking</span>
      )}
    </div>
  );
}

/**
 * Compact speech indicator (just a dot)
 */
export function VADDot({ isSpeaking = false, className = '' }: { isSpeaking?: boolean; className?: string }) {
  const { vadVisualizationEnabled } = useStore();

  if (!vadVisualizationEnabled) {
    return null;
  }

  return (
    <div
      className={`w-3 h-3 rounded-full transition-colors duration-150 ${
        isSpeaking ? 'bg-green-500 animate-pulse' : 'bg-gray-400'
      } ${className}`}
      title={isSpeaking ? 'Speaking' : 'Silent'}
    />
  );
}
