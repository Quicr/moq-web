// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview High-frequency video frame queue hook
 *
 * React state updates are batched and limited to ~60fps at best, which causes
 * frame drops when receiving 60fps content. This hook decouples frame reception
 * from React rendering using refs and requestAnimationFrame.
 *
 * Usage:
 * ```tsx
 * const { getFrame, pushFrame, cleanup } = useVideoFrameQueue();
 *
 * // In video frame handler:
 * pushFrame(subscriptionId, frame);
 *
 * // In VideoRenderer:
 * <VideoRenderer frameGetter={() => getFrame(subscriptionId)} />
 * ```
 */

import { useRef, useCallback, useEffect, useState } from 'react';

interface FrameQueueEntry {
  frame: VideoFrame;
  timestamp: number;
}

/**
 * Hook for managing high-frequency video frame updates without React state
 */
export function useVideoFrameQueue() {
  // Frame queues per subscription - holds latest frame only (no accumulation)
  const frameQueuesRef = useRef<Map<number, FrameQueueEntry>>(new Map());
  // Track which frames have been consumed to avoid double-close
  const consumedFramesRef = useRef<WeakSet<VideoFrame>>(new WeakSet());
  // Callback registry for frame updates (triggers re-render via RAF)
  const frameCallbacksRef = useRef<Map<number, () => void>>(new Map());
  // RAF handle for cleanup
  const rafHandleRef = useRef<number | null>(null);
  // Pending updates flag
  const pendingUpdateRef = useRef<Set<number>>(new Set());

  /**
   * Push a new frame for a subscription
   * Closes the previous frame if it wasn't consumed
   */
  const pushFrame = useCallback((subscriptionId: number, frame: VideoFrame) => {
    const existing = frameQueuesRef.current.get(subscriptionId);

    // Close previous frame if it wasn't consumed
    if (existing && !consumedFramesRef.current.has(existing.frame)) {
      try {
        existing.frame.close();
      } catch {
        // Already closed
      }
    }

    // Store new frame
    frameQueuesRef.current.set(subscriptionId, {
      frame,
      timestamp: performance.now(),
    });

    // Mark as pending update
    pendingUpdateRef.current.add(subscriptionId);

    // Schedule RAF callback if not already scheduled
    if (rafHandleRef.current === null) {
      rafHandleRef.current = requestAnimationFrame(() => {
        rafHandleRef.current = null;

        // Notify all pending subscriptions
        for (const subId of pendingUpdateRef.current) {
          const callback = frameCallbacksRef.current.get(subId);
          if (callback) {
            callback();
          }
        }
        pendingUpdateRef.current.clear();
      });
    }
  }, []);

  /**
   * Get the latest frame for a subscription
   * Marks the frame as consumed (won't be auto-closed on next push)
   */
  const getFrame = useCallback((subscriptionId: number): VideoFrame | null => {
    const entry = frameQueuesRef.current.get(subscriptionId);
    if (!entry) return null;

    // Mark as consumed - caller is responsible for closing after render
    consumedFramesRef.current.add(entry.frame);
    return entry.frame;
  }, []);

  /**
   * Register a callback to be notified when new frames arrive
   * Returns unsubscribe function
   */
  const onFrameUpdate = useCallback((subscriptionId: number, callback: () => void): () => void => {
    frameCallbacksRef.current.set(subscriptionId, callback);
    return () => {
      frameCallbacksRef.current.delete(subscriptionId);
    };
  }, []);

  /**
   * Remove a subscription and close its frame
   */
  const removeSubscription = useCallback((subscriptionId: number) => {
    const entry = frameQueuesRef.current.get(subscriptionId);
    if (entry && !consumedFramesRef.current.has(entry.frame)) {
      try {
        entry.frame.close();
      } catch {
        // Already closed
      }
    }
    frameQueuesRef.current.delete(subscriptionId);
    frameCallbacksRef.current.delete(subscriptionId);
  }, []);

  /**
   * Cleanup all subscriptions
   */
  const cleanup = useCallback(() => {
    // Cancel pending RAF
    if (rafHandleRef.current !== null) {
      cancelAnimationFrame(rafHandleRef.current);
      rafHandleRef.current = null;
    }

    // Close all unconsumed frames
    for (const [, entry] of frameQueuesRef.current) {
      if (!consumedFramesRef.current.has(entry.frame)) {
        try {
          entry.frame.close();
        } catch {
          // Already closed
        }
      }
    }

    frameQueuesRef.current.clear();
    frameCallbacksRef.current.clear();
    pendingUpdateRef.current.clear();
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  /**
   * Get a stable frame getter function for a subscription
   * Unlike getFrame(id), this returns a memoized callback that can be passed to children
   * without causing re-renders or RAF loop restarts
   */
  const getFrameGetterRef = useRef<Map<number, () => VideoFrame | null>>(new Map());

  const getFrameGetter = useCallback((subscriptionId: number): () => VideoFrame | null => {
    let getter = getFrameGetterRef.current.get(subscriptionId);
    if (!getter) {
      // Create a stable getter function that closes over the subscriptionId
      getter = () => {
        const entry = frameQueuesRef.current.get(subscriptionId);
        if (!entry) return null;
        consumedFramesRef.current.add(entry.frame);
        return entry.frame;
      };
      getFrameGetterRef.current.set(subscriptionId, getter);
    }
    return getter;
  }, []);

  return {
    pushFrame,
    getFrame,
    getFrameGetter,
    onFrameUpdate,
    removeSubscription,
    cleanup,
  };
}

/**
 * Hook for a single subscription's frame - triggers re-render on new frames
 */
export function useVideoFrame(
  subscriptionId: number | undefined,
  frameQueue: ReturnType<typeof useVideoFrameQueue>
): VideoFrame | null {
  const [, forceUpdate] = useState(0);
  const frameRef = useRef<VideoFrame | null>(null);
  useEffect(() => {
    if (subscriptionId === undefined) return;

    const unsubscribe = frameQueue.onFrameUpdate(subscriptionId, () => {
      // Get the new frame and trigger re-render
      frameRef.current = frameQueue.getFrame(subscriptionId);
      forceUpdate(n => n + 1);
    });

    return unsubscribe;
  }, [subscriptionId, frameQueue, forceUpdate]);

  return subscriptionId !== undefined ? frameQueue.getFrame(subscriptionId) : null;
}
