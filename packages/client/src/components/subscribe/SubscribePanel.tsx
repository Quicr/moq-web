// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Subscribe Panel Component
 *
 * Interface for subscribing to multiple media tracks, browsing available tracks,
 * and playing received media with a video window per video track.
 */

import React, { useState, useEffect, useRef } from 'react';
import { useStore } from '../../store';
import { VideoRenderer } from './VideoRenderer';
import { AudioPlayer } from './AudioPlayer';
import { JitterGraph } from './JitterGraph';
import { LatencyStatsGraph } from './LatencyStatsGraph';
import { isDebugMode } from '../common/DevSettingsPanel';

type MediaType = 'video' | 'audio';

interface SubscriptionConfig {
  id: string;
  mediaType: MediaType;
  namespace: string;
  trackName: string;
  subscriptionId?: number;
  isSubscribed: boolean;
  isPaused: boolean;
}

interface VideoFrameMap {
  [subscriptionId: number]: VideoFrame | null;
}

export const SubscribePanel: React.FC = () => {
  const {
    subscribedTracks,
    availableTracks,
    sessionState,
    startSubscription,
    stopSubscription,
    pauseSubscription,
    resumeSubscription,
    onVideoFrame,
    onAudioData,
    onJitterSample,
    onLatencyStats,
    enableStats,
  } = useStore();

  // Subscription configurations
  const [subscriptionConfigs, setSubscriptionConfigs] = useState<SubscriptionConfig[]>([]);

  // New subscription form state
  const [newSubscription, setNewSubscription] = useState<Partial<SubscriptionConfig>>({
    mediaType: 'video',
    namespace: 'conference/room-1/media',
    trackName: '',
  });

  const [subscribeError, setSubscribeError] = useState<string | null>(null);

  // Map of subscription IDs to their latest video frames - use refs to avoid React batching
  const [videoFrames, setVideoFrames] = useState<VideoFrameMap>({});
  const videoFramesRef = useRef<VideoFrameMap>({});
  const frameUpdateCountRef = useRef<number>(0);
  // Per-subscription throttling to avoid second subscription waiting for first
  const lastStateUpdateRef = useRef<{ [subscriptionId: number]: number }>({});

  // Track active subscription IDs for video frame handler
  const activeSubscriptionIds = subscriptionConfigs
    .filter(c => c.isSubscribed && c.subscriptionId !== undefined)
    .map(c => c.subscriptionId!);

  // Use a ref for active subscription IDs so the handler always sees current value
  // This fixes a race condition where frames arrive before the handler is re-registered
  const activeSubscriptionIdsRef = useRef<number[]>(activeSubscriptionIds);
  activeSubscriptionIdsRef.current = activeSubscriptionIds;

  // Set up video frame handler - register as soon as session is available
  // The handler uses a ref to check subscription IDs, so it handles frames
  // even before useEffect can re-run after a subscription is created
  useEffect(() => {
    if (isDebugMode()) {
      console.log('[SubscribePanel] Setting up video frame handler');
    }

    const unsubscribe = onVideoFrame((data) => {
      // Use ref to always check against current subscription IDs (fixes race condition)
      // This allows frames to be processed immediately when a subscription is created,
      // even before React has re-rendered and useEffect could re-run
      if (!activeSubscriptionIdsRef.current.includes(data.subscriptionId)) {
        return;
      }

      frameUpdateCountRef.current++;

      // Update ref immediately with new frame
      videoFramesRef.current[data.subscriptionId] = data.frame;

      // Per-subscription throttle to max 60fps to avoid excessive re-renders
      // Each subscription has its own throttle timer so they don't block each other
      const now = performance.now();
      const lastUpdate = lastStateUpdateRef.current[data.subscriptionId] ?? 0;
      if (now - lastUpdate > 16) { // ~60fps per subscription
        lastStateUpdateRef.current[data.subscriptionId] = now;
        setVideoFrames(prev => ({
          ...prev,
          [data.subscriptionId]: data.frame,
        }));
      }
      // Don't close frames here - VideoRenderer handles frame lifecycle
      // after rendering. This avoids race conditions where frames are
      // closed before they can be drawn.

      // Log stats every 300 frames to reduce overhead (debug mode only)
      if (isDebugMode() && frameUpdateCountRef.current % 300 === 0) {
        console.log('[SubscribePanel] Frame stats', {
          totalFrames: frameUpdateCountRef.current,
          subscriptionId: data.subscriptionId,
        });
      }
    });

    return () => {
      if (isDebugMode()) {
        console.log('[SubscribePanel] Cleanup: unsubscribing handler');
      }
      unsubscribe();
    };
  }, [onVideoFrame]);

  // Clean up frames when component unmounts
  // Note: VideoRenderer handles closing frames after rendering, but we should
  // still try to close any frames that haven't been rendered yet
  useEffect(() => {
    return () => {
      Object.values(videoFramesRef.current).forEach(frame => {
        if (frame) {
          try {
            frame.close();
          } catch {
            // Frame may already be closed by VideoRenderer
          }
        }
      });
    };
  }, []);

  const addSubscriptionConfig = () => {
    if (!newSubscription.namespace || !newSubscription.trackName) return;

    const config: SubscriptionConfig = {
      id: `sub-config-${Date.now()}`,
      mediaType: newSubscription.mediaType || 'video',
      namespace: newSubscription.namespace,
      trackName: newSubscription.trackName,
      isSubscribed: false,
      isPaused: false,
    };

    setSubscriptionConfigs([...subscriptionConfigs, config]);
    setNewSubscription({
      ...newSubscription,
      trackName: '',
    });
  };

  const removeSubscriptionConfig = (id: string) => {
    const config = subscriptionConfigs.find(c => c.id === id);
    if (config?.isSubscribed && config.subscriptionId !== undefined) {
      // Need to unsubscribe first
      handleUnsubscribe(config);
    }
    setSubscriptionConfigs(subscriptionConfigs.filter(c => c.id !== id));
  };

  const handleSubscribe = async (config: SubscriptionConfig) => {
    setSubscribeError(null);

    if (isDebugMode()) {
      console.log('[SubscribePanel] handleSubscribe called', {
        namespace: config.namespace,
        trackName: config.trackName,
        mediaType: config.mediaType,
      });
    }

    try {
      // Pass mediaType so only the appropriate decoder is created
      const subscriptionId = await startSubscription(config.namespace, config.trackName, config.mediaType);

      if (isDebugMode()) {
        console.log('[SubscribePanel] Subscription created', {
          subscriptionId,
          namespace: config.namespace,
          trackName: config.trackName,
        });
      }

      // Immediately add to ref so frames can be processed before React re-renders
      // This fixes the race condition where frames arrive after startSubscription
      // but before setSubscriptionConfigs triggers a re-render
      activeSubscriptionIdsRef.current = [...activeSubscriptionIdsRef.current, subscriptionId];

      setSubscriptionConfigs(subscriptionConfigs.map(c =>
        c.id === config.id ? { ...c, isSubscribed: true, subscriptionId, isPaused: false } : c
      ));
    } catch (err) {
      const error = err as Error;
      console.error('Failed to subscribe:', error);
      setSubscribeError(error.message);
    }
  };

  const handleUnsubscribe = async (config: SubscriptionConfig) => {
    if (config.subscriptionId === undefined) return;

    // Immediately remove from ref so frames stop being processed
    activeSubscriptionIdsRef.current = activeSubscriptionIdsRef.current.filter(
      id => id !== config.subscriptionId
    );

    try {
      await stopSubscription(config.subscriptionId);

      // Clean up video frame for this subscription
      const frame = videoFramesRef.current[config.subscriptionId];
      if (frame) {
        try {
          frame.close();
        } catch {
          // Frame may already be closed by VideoRenderer
        }
        delete videoFramesRef.current[config.subscriptionId];
        setVideoFrames(prev => {
          const newFrames = { ...prev };
          delete newFrames[config.subscriptionId!];
          return newFrames;
        });
      }

      setSubscriptionConfigs(subscriptionConfigs.map(c =>
        c.id === config.id ? { ...c, isSubscribed: false, subscriptionId: undefined, isPaused: false } : c
      ));
    } catch (err) {
      console.error('Failed to unsubscribe:', err);
    }
  };

  const handlePause = async (config: SubscriptionConfig) => {
    if (config.subscriptionId === undefined) return;

    try {
      await pauseSubscription(config.subscriptionId);
      setSubscriptionConfigs(subscriptionConfigs.map(c =>
        c.id === config.id ? { ...c, isPaused: true } : c
      ));
    } catch (err) {
      console.error('Failed to pause subscription:', err);
    }
  };

  const handleResume = async (config: SubscriptionConfig) => {
    if (config.subscriptionId === undefined) return;

    try {
      await resumeSubscription(config.subscriptionId);
      setSubscriptionConfigs(subscriptionConfigs.map(c =>
        c.id === config.id ? { ...c, isPaused: false } : c
      ));
    } catch (err) {
      console.error('Failed to resume subscription:', err);
    }
  };

  const handleSubscribeToAvailable = (track: { namespace: string[]; trackName: string }) => {
    setNewSubscription({
      ...newSubscription,
      namespace: track.namespace.join('/'),
      trackName: track.trackName,
    });
  };

  // Get video subscriptions with their frames
  const videoSubscriptions = subscriptionConfigs.filter(
    c => c.mediaType === 'video' && c.isSubscribed && c.subscriptionId !== undefined
  );

  // Get audio subscriptions
  const audioSubscriptions = subscriptionConfigs.filter(
    c => c.mediaType === 'audio' && c.isSubscribed && c.subscriptionId !== undefined
  );

  return (
    <div className="space-y-6">
      {/* Add New Subscription */}
      <div className="panel">
        <div className="panel-header">Add Subscription</div>
        <div className="panel-body space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Media Type</label>
              <select
                value={newSubscription.mediaType}
                onChange={(e) => setNewSubscription({ ...newSubscription, mediaType: e.target.value as MediaType })}
                className="input"
              >
                <option value="video">Video</option>
                <option value="audio">Audio</option>
              </select>
            </div>
          </div>
          <div>
            <label className="label">Namespace</label>
            <input
              type="text"
              value={newSubscription.namespace}
              onChange={(e) => setNewSubscription({ ...newSubscription, namespace: e.target.value })}
              placeholder="conference/room-1/media"
              className="input"
            />
          </div>
          <div>
            <label className="label">Track Name</label>
            <input
              type="text"
              value={newSubscription.trackName}
              onChange={(e) => setNewSubscription({ ...newSubscription, trackName: e.target.value })}
              placeholder={newSubscription.mediaType === 'video' ? 'user-id/video' : 'user-id/audio'}
              className="input"
            />
          </div>
          <button
            onClick={addSubscriptionConfig}
            disabled={!newSubscription.namespace || !newSubscription.trackName}
            className="btn-primary w-full"
          >
            Add Subscription
          </button>
        </div>
      </div>

      {/* Available Tracks */}
      {availableTracks.length > 0 && (
        <div className="panel">
          <div className="panel-header">Available Tracks</div>
          <div className="panel-body">
            <div className="space-y-2">
              {availableTracks.map((track, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-900 rounded-md"
                >
                  <div>
                    <div className="font-medium text-sm">{track.trackName}</div>
                    <div className="text-xs text-gray-500">{track.namespace.join('/')}</div>
                  </div>
                  <button
                    onClick={() => handleSubscribeToAvailable(track)}
                    className="btn-sm btn-primary"
                  >
                    Add
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Subscription Configurations */}
      {subscriptionConfigs.length > 0 && (
        <div className="panel">
          <div className="panel-header">Configured Subscriptions ({subscriptionConfigs.length})</div>
          <div className="panel-body space-y-3">
            {subscribeError && (
              <div className="p-3 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-md text-sm">
                {subscribeError}
              </div>
            )}
            {subscriptionConfigs.map(config => (
              <div
                key={config.id}
                className="p-4 bg-gray-50 dark:bg-gray-900 rounded-lg space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {config.mediaType === 'video' ? (
                      <svg className="w-6 h-6 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    ) : (
                      <svg className="w-6 h-6 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                      </svg>
                    )}
                    <div>
                      <div className="font-medium">{config.trackName}</div>
                      <div className="text-xs text-gray-500">{config.namespace}</div>
                    </div>
                  </div>
                  <span className={`badge ${config.isSubscribed ? (config.isPaused ? 'badge-yellow' : 'badge-green') : 'badge-gray'}`}>
                    {config.isSubscribed ? (config.isPaused ? 'Paused' : 'Subscribed') : 'Not Subscribed'}
                  </span>
                </div>

                <div className="flex gap-2">
                  {!config.isSubscribed ? (
                    <button
                      onClick={() => handleSubscribe(config)}
                      disabled={sessionState !== 'ready'}
                      className="btn-success btn-sm flex-1"
                    >
                      Subscribe
                    </button>
                  ) : (
                    <>
                      {!config.isPaused ? (
                        <button
                          onClick={() => handlePause(config)}
                          className="btn-warning btn-sm flex-1"
                        >
                          Pause
                        </button>
                      ) : (
                        <button
                          onClick={() => handleResume(config)}
                          className="btn-success btn-sm flex-1"
                        >
                          Resume
                        </button>
                      )}
                      <button
                        onClick={() => handleUnsubscribe(config)}
                        className="btn-danger btn-sm flex-1"
                      >
                        Unsubscribe
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => removeSubscriptionConfig(config.id)}
                    disabled={config.isSubscribed}
                    className="btn-secondary btn-sm"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Video Players - One per video subscription */}
      {videoSubscriptions.length > 0 && (
        <div className="panel">
          <div className="panel-header">Video Players ({videoSubscriptions.length})</div>
          <div className="panel-body">
            <div className={`grid gap-4 ${videoSubscriptions.length === 1 ? 'grid-cols-1' : videoSubscriptions.length <= 4 ? 'grid-cols-2' : 'grid-cols-3'}`}>
              {videoSubscriptions.map(config => (
                <div key={config.id} className="space-y-2">
                  <div className="text-sm font-medium flex items-center justify-between">
                    <span className="truncate">{config.trackName}</span>
                    {isDebugMode() && (
                      <span className="text-xs text-gray-500 ml-2">
                        {config.subscriptionId !== undefined && subscribedTracks.find(t => t.id === `sub-${config.subscriptionId}`)
                          ? `G:${subscribedTracks.find(t => t.id === `sub-${config.subscriptionId}`)?.stats.groupId} O:${subscribedTracks.find(t => t.id === `sub-${config.subscriptionId}`)?.stats.objectId}`
                          : ''}
                      </span>
                    )}
                  </div>
                  <VideoRenderer
                    frame={config.subscriptionId !== undefined ? videoFrames[config.subscriptionId] || null : null}
                  />
                  {enableStats && config.subscriptionId !== undefined && (
                    <div className="space-y-2">
                      <JitterGraph
                        subscriptionId={config.subscriptionId}
                        onJitterSample={onJitterSample}
                      />
                      <LatencyStatsGraph
                        subscriptionId={config.subscriptionId}
                        onLatencyStats={onLatencyStats}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Audio Players - One per audio subscription */}
      {audioSubscriptions.length > 0 && (
        <div className="panel">
          <div className="panel-header">Audio Players ({audioSubscriptions.length})</div>
          <div className="panel-body space-y-3">
            {audioSubscriptions.map(config => (
              <div key={config.id} className="space-y-2">
                <div className="text-sm font-medium flex items-center justify-between">
                  <span className="truncate">{config.trackName}</span>
                  {isDebugMode() && (
                    <span className="text-xs text-gray-500 ml-2">
                      {config.subscriptionId !== undefined && subscribedTracks.find(t => t.id === `sub-${config.subscriptionId}`)
                        ? `G:${subscribedTracks.find(t => t.id === `sub-${config.subscriptionId}`)?.stats.groupId} O:${subscribedTracks.find(t => t.id === `sub-${config.subscriptionId}`)?.stats.objectId}`
                        : ''}
                    </span>
                  )}
                </div>
                {config.subscriptionId !== undefined && (
                  <AudioPlayer
                    subscriptionId={config.subscriptionId}
                    onAudioData={onAudioData}
                  />
                )}
                {enableStats && config.subscriptionId !== undefined && (
                  <div className="space-y-2">
                    <JitterGraph
                      subscriptionId={config.subscriptionId}
                      onJitterSample={onJitterSample}
                    />
                    <LatencyStatsGraph
                      subscriptionId={config.subscriptionId}
                      onLatencyStats={onLatencyStats}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Subscribed Tracks Stats */}
      {subscribedTracks.length > 0 && (
        <div className="panel">
          <div className="panel-header">Subscription Stats</div>
          <div className="panel-body">
            <div className="space-y-2">
              {subscribedTracks.map(track => (
                <div
                  key={track.id}
                  className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-900 rounded-md"
                >
                  <div className="flex items-center gap-3">
                    {track.type === 'video' ? (
                      <svg className="w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    ) : (
                      <svg className="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                      </svg>
                    )}
                    <div>
                      <div className="font-medium text-sm">{track.trackName}</div>
                      <div className="text-xs text-gray-500">{track.namespace.join('/')}</div>
                    </div>
                  </div>
                  {isDebugMode() && (
                    <div className="text-xs text-gray-500">
                      G:{track.stats.groupId} O:{track.stats.objectId}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
