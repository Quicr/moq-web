// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview High-frequency video frame queue hook
 *
 * React state updates are batched and limited to ~60fps at best, which causes
 * frame drops when receiving 60fps content. This hook decouples frame reception
 * from React rendering using refs and requestAnimationFrame.
 *
 * Uses a FIFO queue (not just latest frame) to handle timing jitter where
 * multiple frames may arrive between RAF callbacks.
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

// Maximum frames to buffer per subscription to prevent memory issues
const MAX_QUEUE_SIZE = 10;

/**
 * Hook for managing high-frequency video frame updates without React state
 */
export function useVideoFrameQueue() {
  // Frame queues per subscription - FIFO queue to handle timing jitter
  const frameQueuesRef = useRef<Map<number, FrameQueueEntry[]>>(new Map());
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
   * Uses FIFO queue to handle timing jitter
   */
  const pushFrame = useCallback((subscriptionId: number, frame: VideoFrame) => {
    let queue = frameQueuesRef.current.get(subscriptionId);
    if (!queue) {
      queue = [];
      frameQueuesRef.current.set(subscriptionId, queue);
    }

    // Add to queue
    queue.push({
      frame,
      timestamp: performance.now(),
    });

    // If queue is too large, drop oldest unconsumed frames
    while (queue.length > MAX_QUEUE_SIZE) {
      const oldest = queue.shift();
      if (oldest && !consumedFramesRef.current.has(oldest.frame)) {
        try {
          oldest.frame.close();
        } catch {
          // Already closed
        }
      }
    }

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
   * Get the next frame for a subscription (FIFO order)
   * Marks the frame as consumed (caller is responsible for closing after render)
   */
  const getFrame = useCallback((subscriptionId: number): VideoFrame | null => {
    const queue = frameQueuesRef.current.get(subscriptionId);
    if (!queue || queue.length === 0) return null;

    // Get oldest frame (FIFO)
    const entry = queue.shift()!;

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
   * Remove a subscription and close its frames
   */
  const removeSubscription = useCallback((subscriptionId: number) => {
    const queue = frameQueuesRef.current.get(subscriptionId);
    if (queue) {
      for (const entry of queue) {
        if (!consumedFramesRef.current.has(entry.frame)) {
          try {
            entry.frame.close();
          } catch {
            // Already closed
          }
        }
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
    for (const [, queue] of frameQueuesRef.current) {
      for (const entry of queue) {
        if (!consumedFramesRef.current.has(entry.frame)) {
          try {
            entry.frame.close();
          } catch {
            // Already closed
          }
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
        const queue = frameQueuesRef.current.get(subscriptionId);
        if (!queue || queue.length === 0) return null;
        const entry = queue.shift()!;
        consumedFramesRef.current.add(entry.frame);
        return entry.frame;
      };
      getFrameGetterRef.current.set(subscriptionId, getter);
    }
    return getter;
  }, []);

  /**
   * Get the current queue depth for a subscription (for diagnostics)
   */
  const getQueueDepth = useCallback((subscriptionId: number): number => {
    const queue = frameQueuesRef.current.get(subscriptionId);
    return queue?.length ?? 0;
  }, []);

  return {
    pushFrame,
    getFrame,
    getFrameGetter,
    getQueueDepth,
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
