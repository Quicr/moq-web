// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

/**
 * Headless DVR player state machine.
 *
 * The DVR layer manages *what the user is doing* — play/pause, scrub, trick
 * play, live edge — decoupled from *how* frames are delivered. The actual
 * MoQT fetch/subscribe wiring is provided by the app; useDvrPlayer just tells
 * it what to load via the returned `intent` (play / pause / seek-to / rate).
 *
 * This is the reusable core that studio + vod-dvr both build on.
 */

export type DvrIntent =
  | { kind: 'idle' }
  | { kind: 'play'; positionMs: number; rate: number }
  | { kind: 'paused'; positionMs: number }
  | { kind: 'seek'; positionMs: number };

export interface DvrRange {
  startMs: number;
  endMs: number;
  liveEdgeMs?: number;
}

export interface DvrPlayerState {
  positionMs: number;
  rate: number;
  isPaused: boolean;
  isSeeking: boolean;
  bufferedMs: number;
  range: DvrRange;
  intent: DvrIntent;
}

type Action =
  | { type: 'set-range'; range: DvrRange }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; positionMs: number }
  | { type: 'seek-commit' }
  | { type: 'set-rate'; rate: number }
  | { type: 'tick'; positionMs: number }
  | { type: 'set-buffered'; bufferedMs: number };

const clampPosition = (pos: number, range: DvrRange) => Math.min(Math.max(pos, range.startMs), range.endMs);

function reducer(state: DvrPlayerState, action: Action): DvrPlayerState {
  switch (action.type) {
    case 'set-range': {
      const range = action.range;
      const positionMs = clampPosition(state.positionMs, range);
      return { ...state, range, positionMs };
    }
    case 'play':
      return {
        ...state,
        isPaused: false,
        intent: { kind: 'play', positionMs: state.positionMs, rate: state.rate },
      };
    case 'pause':
      return {
        ...state,
        isPaused: true,
        intent: { kind: 'paused', positionMs: state.positionMs },
      };
    case 'seek': {
      const clamped = clampPosition(action.positionMs, state.range);
      return {
        ...state,
        positionMs: clamped,
        isSeeking: true,
        intent: { kind: 'seek', positionMs: clamped },
      };
    }
    case 'seek-commit':
      return {
        ...state,
        isSeeking: false,
        intent: state.isPaused
          ? { kind: 'paused', positionMs: state.positionMs }
          : { kind: 'play', positionMs: state.positionMs, rate: state.rate },
      };
    case 'set-rate':
      return {
        ...state,
        rate: action.rate,
        intent: state.isPaused ? state.intent : { kind: 'play', positionMs: state.positionMs, rate: action.rate },
      };
    case 'tick':
      return { ...state, positionMs: clampPosition(action.positionMs, state.range) };
    case 'set-buffered':
      return { ...state, bufferedMs: action.bufferedMs };
    default:
      return state;
  }
}

export interface DvrPlayerOptions {
  range?: DvrRange;
  autoPlay?: boolean;
}

export interface DvrPlayerControls {
  state: DvrPlayerState;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (positionMs: number) => void;
  commitSeek: () => void;
  setRate: (rate: number) => void;
  setBuffered: (ms: number) => void;
  setRange: (range: DvrRange) => void;
  goLive: () => void;
}

export function useDvrPlayer({ range, autoPlay = false }: DvrPlayerOptions = {}): DvrPlayerControls {
  const initialRange: DvrRange = range ?? { startMs: 0, endMs: 0 };
  const [state, dispatch] = useReducer(reducer, {
    positionMs: initialRange.startMs,
    rate: 1,
    isPaused: !autoPlay,
    isSeeking: false,
    bufferedMs: 0,
    range: initialRange,
    intent: autoPlay
      ? { kind: 'play', positionMs: initialRange.startMs, rate: 1 }
      : { kind: 'paused', positionMs: initialRange.startMs },
  });

  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (range) dispatch({ type: 'set-range', range });
  }, [range?.startMs, range?.endMs, range?.liveEdgeMs]);

  useEffect(() => {
    if (state.isPaused || state.isSeeking) return;
    const interval = 250;
    const id = setInterval(() => {
      const s = stateRef.current;
      const next = s.positionMs + interval * s.rate;
      if (next > s.range.endMs) {
        dispatch({ type: 'tick', positionMs: s.range.endMs });
        dispatch({ type: 'pause' });
      } else {
        dispatch({ type: 'tick', positionMs: next });
      }
    }, interval);
    return () => clearInterval(id);
  }, [state.isPaused, state.isSeeking, state.rate]);

  const controls = useMemo<DvrPlayerControls>(
    () => ({
      state,
      play: () => dispatch({ type: 'play' }),
      pause: () => dispatch({ type: 'pause' }),
      toggle: () => (stateRef.current.isPaused ? dispatch({ type: 'play' }) : dispatch({ type: 'pause' })),
      seek: (positionMs) => dispatch({ type: 'seek', positionMs }),
      commitSeek: () => dispatch({ type: 'seek-commit' }),
      setRate: (rate) => dispatch({ type: 'set-rate', rate }),
      setBuffered: (bufferedMs) => dispatch({ type: 'set-buffered', bufferedMs }),
      setRange: useCallback((r: DvrRange) => dispatch({ type: 'set-range', range: r }), []),
      goLive: () => {
        const edge = stateRef.current.range.liveEdgeMs ?? stateRef.current.range.endMs;
        dispatch({ type: 'seek', positionMs: edge });
        dispatch({ type: 'seek-commit' });
        dispatch({ type: 'play' });
      },
    }),
    [state],
  );

  return controls;
}
