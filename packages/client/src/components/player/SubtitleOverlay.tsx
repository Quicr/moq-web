// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Subtitle Overlay Component
 *
 * Displays subtitles over video content. Supports WebVTT format parsing
 * and syncs subtitles with video playback time.
 */

import React, { useState, useMemo } from 'react';

/**
 * Subtitle cue with timing and text
 */
export interface SubtitleCue {
  /** Start time in milliseconds */
  startTime: number;
  /** End time in milliseconds */
  endTime: number;
  /** Subtitle text (may contain line breaks) */
  text: string;
  /** Optional cue identifier */
  id?: string;
}

interface SubtitleOverlayProps {
  /** Array of subtitle cues */
  cues: SubtitleCue[];
  /** Current playback time in milliseconds */
  currentTime: number;
  /** Whether subtitles are enabled */
  enabled?: boolean;
  /** Font size (default: 'medium') */
  fontSize?: 'small' | 'medium' | 'large';
  /** Background style (default: 'box') */
  backgroundStyle?: 'box' | 'shadow' | 'none';
  /** Position (default: 'bottom') */
  position?: 'top' | 'bottom';
  /** Optional className for custom styling */
  className?: string;
}

/** Font size map */
const FONT_SIZES = {
  small: 'text-sm',
  medium: 'text-base',
  large: 'text-xl',
};

/**
 * Parse WebVTT timestamp to milliseconds
 * Format: HH:MM:SS.mmm or MM:SS.mmm
 */
export function parseVTTTimestamp(timestamp: string): number {
  const parts = timestamp.trim().split(':');
  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  if (parts.length === 3) {
    hours = parseInt(parts[0], 10);
    minutes = parseInt(parts[1], 10);
    seconds = parseFloat(parts[2]);
  } else if (parts.length === 2) {
    minutes = parseInt(parts[0], 10);
    seconds = parseFloat(parts[1]);
  }

  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

/**
 * Parse WebVTT content to subtitle cues
 */
export function parseWebVTT(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const lines = content.split('\n');
  let i = 0;

  // Skip WEBVTT header
  while (i < lines.length && !lines[i].includes('-->')) {
    i++;
  }

  while (i < lines.length) {
    const line = lines[i].trim();

    // Look for timestamp line
    if (line.includes('-->')) {
      const [startStr, endStr] = line.split('-->').map(s => s.trim().split(' ')[0]);
      const startTime = parseVTTTimestamp(startStr);
      const endTime = parseVTTTimestamp(endStr);

      // Collect text lines
      const textLines: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i].trim());
        i++;
      }

      if (textLines.length > 0) {
        cues.push({
          startTime,
          endTime,
          text: textLines.join('\n'),
        });
      }
    } else {
      i++;
    }
  }

  return cues;
}

/**
 * Parse SRT content to subtitle cues
 */
export function parseSRT(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const blocks = content.trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length < 2) continue;

    // Find timestamp line
    let timestampLineIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) {
        timestampLineIndex = i;
        break;
      }
    }

    const timestampLine = lines[timestampLineIndex];
    if (!timestampLine?.includes('-->')) continue;

    // Parse timestamps (SRT uses comma for milliseconds)
    const [startStr, endStr] = timestampLine.split('-->').map(s =>
      s.trim().replace(',', '.')
    );
    const startTime = parseVTTTimestamp(startStr);
    const endTime = parseVTTTimestamp(endStr);

    // Collect text lines after timestamp
    const textLines = lines.slice(timestampLineIndex + 1).filter(l => l.trim());

    if (textLines.length > 0) {
      cues.push({
        startTime,
        endTime,
        text: textLines.join('\n'),
        id: lines[0]?.match(/^\d+$/) ? lines[0] : undefined,
      });
    }
  }

  return cues;
}

/**
 * Auto-detect and parse subtitle content
 */
export function parseSubtitles(content: string): SubtitleCue[] {
  const trimmed = content.trim();

  if (trimmed.startsWith('WEBVTT')) {
    return parseWebVTT(content);
  }

  // Assume SRT if starts with a number
  if (/^\d+\s*$/.test(trimmed.split('\n')[0])) {
    return parseSRT(content);
  }

  // Try WebVTT first, fall back to SRT
  const vttCues = parseWebVTT(content);
  if (vttCues.length > 0) return vttCues;

  return parseSRT(content);
}

/**
 * Subtitle Overlay Component
 */
export const SubtitleOverlay: React.FC<SubtitleOverlayProps> = ({
  cues,
  currentTime,
  enabled = true,
  fontSize = 'medium',
  backgroundStyle = 'box',
  position = 'bottom',
  className = '',
}) => {
  // Find active cue(s) for current time
  const activeCues = useMemo(() => {
    if (!enabled) return [];

    return cues.filter(
      cue => currentTime >= cue.startTime && currentTime <= cue.endTime
    );
  }, [cues, currentTime, enabled]);

  if (!enabled || activeCues.length === 0) {
    return null;
  }

  // Background styles
  const bgStyles = {
    box: 'bg-black/80 px-4 py-2 rounded',
    shadow: 'text-shadow-lg',
    none: '',
  };

  // Position styles
  const positionStyles = {
    top: 'top-8',
    bottom: 'bottom-16',
  };

  return (
    <div
      className={`absolute left-0 right-0 ${positionStyles[position]} flex justify-center pointer-events-none ${className}`}
    >
      <div
        className={`
          max-w-[80%] text-center text-white
          ${FONT_SIZES[fontSize]}
          ${bgStyles[backgroundStyle]}
        `}
        style={backgroundStyle === 'shadow' ? {
          textShadow: '2px 2px 4px rgba(0,0,0,0.9), -1px -1px 2px rgba(0,0,0,0.9)',
        } : undefined}
      >
        {activeCues.map((cue, index) => (
          <div key={cue.id || index} className="whitespace-pre-wrap">
            {cue.text}
          </div>
        ))}
      </div>
    </div>
  );
};

/**
 * Hook to manage subtitle state
 */
export function useSubtitles(initialCues: SubtitleCue[] = []) {
  const [cues, setCues] = useState<SubtitleCue[]>(initialCues);
  const [enabled, setEnabled] = useState(true);
  const [fontSize, setFontSize] = useState<'small' | 'medium' | 'large'>('medium');
  const [backgroundStyle, setBackgroundStyle] = useState<'box' | 'shadow' | 'none'>('box');

  // Load subtitles from URL
  const loadFromUrl = async (url: string) => {
    try {
      const response = await fetch(url);
      const content = await response.text();
      const parsed = parseSubtitles(content);
      setCues(parsed);
      return parsed;
    } catch (err) {
      console.error('Failed to load subtitles:', err);
      return [];
    }
  };

  // Load subtitles from text content
  const loadFromText = (content: string) => {
    const parsed = parseSubtitles(content);
    setCues(parsed);
    return parsed;
  };

  // Add a single cue (for live subtitles)
  const addCue = (cue: SubtitleCue) => {
    setCues(prev => [...prev, cue]);
  };

  // Clear all cues
  const clearCues = () => {
    setCues([]);
  };

  return {
    cues,
    enabled,
    fontSize,
    backgroundStyle,
    setEnabled,
    setFontSize,
    setBackgroundStyle,
    loadFromUrl,
    loadFromText,
    addCue,
    clearCues,
  };
}
