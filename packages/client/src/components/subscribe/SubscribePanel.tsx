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
import { SubscribeNamespacePanel } from './SubscribeNamespacePanel';
import { isDebugMode } from '../common/DevSettingsPanel';
import { EXPERIENCE_PROFILES, type ExperienceProfileName } from '@web-moq/media';
import type { SwitchingSetAssignment } from '@web-moq/core';

type MediaType = 'video' | 'audio';

interface DtsConfig {
  enabled: boolean;
  switchingSetId: number;
  throughputThresholdKbps: number;
  setThroughputFraction: number;
  activateSwitching: boolean;
  setRank: number;
}

interface SubscriptionConfig {
  id: string;
  mediaType: MediaType;
  namespace: string;
  trackName: string;
  subscriptionId?: number;
  isSubscribed: boolean;
  isPaused: boolean;
  dts?: DtsConfig;
  objectsReceived?: number;
}

interface VideoFrameMap {
  [subscriptionId: number]: VideoFrame | null;
}

type SubscribeMode = 'track' | 'namespace';

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
    experienceProfile,
    secureObjectsEnabled,
  } = useStore();

  // Get target latency from experience profile for graph color thresholds
  const targetLatency = experienceProfile === 'custom'
    ? 100 // Default for custom
    : EXPERIENCE_PROFILES[experienceProfile as Exclude<ExperienceProfileName, 'custom'>]?.targetLatency ?? 100;

  // Subscribe mode toggle
  const [subscribeMode, setSubscribeMode] = useState<SubscribeMode>('track');

  // Subscription configurations
  const [subscriptionConfigs, setSubscriptionConfigs] = useState<SubscriptionConfig[]>([]);

  // New subscription form state
  const [newSubscription, setNewSubscription] = useState<Partial<SubscriptionConfig>>({
    mediaType: 'video',
    namespace: 'conference/room-1/media',
    trackName: '',
  });

  // DTS configuration state
  const [dtsEnabled, setDtsEnabled] = useState(false);
  const [dtsConfig, setDtsConfig] = useState<Omit<DtsConfig, 'enabled'>>({
    switchingSetId: 1,
    throughputThresholdKbps: 2000,
    setThroughputFraction: 5,
    activateSwitching: false,
    setRank: 1,
  });

  // DTS Simulcast quick setup (track names are fixed: video-1080p, video-720p, video-480p)
  const [simulcastQualities, setSimulcastQualities] = useState({
    '1080p': true,
    '720p': true,
    '480p': true,
  });

  const [subscribeError, setSubscribeError] = useState<string | null>(null);

  // Map of subscription IDs to their latest video frames - use refs to avoid React batching
  const [videoFrames, setVideoFrames] = useState<VideoFrameMap>({});
  const videoFramesRef = useRef<VideoFrameMap>({});
  const frameUpdateCountRef = useRef<number>(0);
  // Per-subscription throttling to avoid second subscription waiting for first
  const lastStateUpdateRef = useRef<{ [subscriptionId: number]: number }>({});
  // Track the last frame passed to React state (so we don't close it while VideoRenderer needs it)
  const lastStateFrameRef = useRef<VideoFrameMap>({});
  // Track which subscription last received a frame (for DTS selection indicator)
  const [lastActiveSubscriptionId, setLastActiveSubscriptionId] = useState<number | null>(null);
  const lastFrameTimeRef = useRef<{ [subscriptionId: number]: number }>({});

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

      // Per-subscription throttle to max 60fps to avoid excessive re-renders
      // Each subscription has its own throttle timer so they don't block each other
      const now = performance.now();
      const lastUpdate = lastStateUpdateRef.current[data.subscriptionId] ?? 0;
      const shouldUpdateState = now - lastUpdate > 16; // ~60fps per subscription

      // Close any existing frame in the ref that won't be rendered
      // BUT don't close the frame that's currently in React state (VideoRenderer may still need it)
      const existingFrame = videoFramesRef.current[data.subscriptionId];
      const frameInState = lastStateFrameRef.current[data.subscriptionId];
      if (existingFrame && existingFrame !== data.frame && existingFrame !== frameInState) {
        // This is an intermediate throttled frame that was never passed to React state
        // Close it now to prevent GC warning
        try {
          existingFrame.close();
        } catch {
          // Frame may already be closed
        }
      }

      // Update ref with new frame
      videoFramesRef.current[data.subscriptionId] = data.frame;

      if (shouldUpdateState) {
        lastStateUpdateRef.current[data.subscriptionId] = now;
        lastStateFrameRef.current[data.subscriptionId] = data.frame;
        lastFrameTimeRef.current[data.subscriptionId] = now;
        setVideoFrames(prev => ({
          ...prev,
          [data.subscriptionId]: data.frame,
        }));
        // Update which subscription is currently receiving frames (for DTS indicator)
        setLastActiveSubscriptionId(data.subscriptionId);
      }
      // Frames passed to React state will be closed by VideoRenderer after rendering

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
      dts: dtsEnabled ? { enabled: true, ...dtsConfig } : undefined,
      objectsReceived: 0,
    };

    setSubscriptionConfigs([...subscriptionConfigs, config]);
    setNewSubscription({
      ...newSubscription,
      trackName: '',
    });
  };

  // Build DTS simulcast subscription configs based on selected qualities
  const buildSimulcastSubscriptionConfigs = (): SubscriptionConfig[] => {
    if (!newSubscription.namespace) return [];

    const qualityConfigs: Record<string, { threshold: number; rank: number }> = {
      '1080p': { threshold: 4000, rank: 3 },
      '720p': { threshold: 2000, rank: 2 },
      '480p': { threshold: 500, rank: 1 },
    };

    const selectedQualities = Object.entries(simulcastQualities)
      .filter(([, enabled]) => enabled)
      .map(([quality]) => quality);

    if (selectedQualities.length === 0) return [];

    return selectedQualities.map((quality, index) => ({
      id: `sub-config-${Date.now()}-${quality}`,
      mediaType: 'video' as MediaType,
      namespace: newSubscription.namespace!,
      trackName: `video-${quality}`,
      isSubscribed: false,
      isPaused: false,
      dts: {
        enabled: true,
        switchingSetId: 1,
        throughputThresholdKbps: qualityConfigs[quality].threshold,
        setThroughputFraction: 5,
        activateSwitching: index === selectedQualities.length - 1,
        setRank: qualityConfigs[quality].rank,
      },
      objectsReceived: 0,
    }));
  };

  // Add AND subscribe to all simulcast tracks in one action
  const addAndSubscribeSimulcast = async () => {
    const configs = buildSimulcastSubscriptionConfigs();
    if (configs.length === 0) return;

    // Subscribe to each track and collect results
    const subscribedConfigs: SubscriptionConfig[] = [];
    for (const config of configs) {
      try {
        let dtsAssignment: SwitchingSetAssignment | undefined;
        if (config.dts?.enabled) {
          dtsAssignment = {
            switchingSetId: config.dts.switchingSetId,
            throughputThresholdKbps: config.dts.throughputThresholdKbps,
            setThroughputFraction: config.dts.setThroughputFraction,
            activateSwitching: config.dts.activateSwitching,
            setRank: config.dts.setRank,
          };
        }
        const subscriptionId = await startSubscription(config.namespace, config.trackName, config.mediaType, dtsAssignment);

        // Immediately add to ref so frames can be processed
        activeSubscriptionIdsRef.current = [...activeSubscriptionIdsRef.current, subscriptionId];

        subscribedConfigs.push({
          ...config,
          isSubscribed: true,
          subscriptionId,
        });
      } catch (err) {
        console.error(`Failed to subscribe to ${config.trackName}:`, err);
        subscribedConfigs.push(config); // Keep unsubscribed
      }
    }

    // Update state once with all configs
    setSubscriptionConfigs([...subscriptionConfigs, ...subscribedConfigs]);
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
        dts: config.dts,
      });
    }

    try {
      // Build DTS assignment if configured
      let dtsAssignment: SwitchingSetAssignment | undefined;
      if (config.dts?.enabled) {
        dtsAssignment = {
          switchingSetId: config.dts.switchingSetId,
          throughputThresholdKbps: config.dts.throughputThresholdKbps,
          setThroughputFraction: config.dts.setThroughputFraction,
          activateSwitching: config.dts.activateSwitching,
          setRank: config.dts.setRank,
        };
      }

      // Pass mediaType and DTS assignment
      const subscriptionId = await startSubscription(config.namespace, config.trackName, config.mediaType, dtsAssignment);

      if (isDebugMode()) {
        console.log('[SubscribePanel] Subscription created', {
          subscriptionId,
          namespace: config.namespace,
          trackName: config.trackName,
          hasDts: !!dtsAssignment,
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
      {/* Mode Selector */}
      <div className="flex gap-2 p-1 bg-gray-100 dark:bg-gray-800 rounded-lg">
        <button
          onClick={() => setSubscribeMode('track')}
          className={`flex-1 px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            subscribeMode === 'track'
              ? 'bg-white dark:bg-gray-700 text-primary-600 dark:text-primary-400 shadow-sm'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}
        >
          Subscribe to Track
        </button>
        <button
          onClick={() => setSubscribeMode('namespace')}
          className={`flex-1 px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            subscribeMode === 'namespace'
              ? 'bg-white dark:bg-gray-700 text-primary-600 dark:text-primary-400 shadow-sm'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}
        >
          Subscribe to Namespace
        </button>
      </div>

      {/* Namespace Mode */}
      {subscribeMode === 'namespace' && <SubscribeNamespacePanel />}

      {/* Track Mode */}
      {subscribeMode === 'track' && (
      <>
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

          {/* DTS Configuration */}
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
            <div className="flex items-center justify-between mb-3">
              <label className="label mb-0">DTS (Dynamic Track Switching)</label>
              <button
                onClick={() => setDtsEnabled(!dtsEnabled)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  dtsEnabled ? 'bg-primary-500' : 'bg-gray-300 dark:bg-gray-600'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    dtsEnabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            {dtsEnabled && (
              <div className="space-y-3 p-3 bg-gray-50 dark:bg-gray-900 rounded-lg">
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                  Add multiple tracks with the same Switching Set ID. The relay will select one based on bandwidth.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label text-xs">Switching Set ID</label>
                    <input
                      type="number"
                      value={dtsConfig.switchingSetId}
                      onChange={(e) => setDtsConfig({ ...dtsConfig, switchingSetId: parseInt(e.target.value) || 1 })}
                      className="input"
                      min={1}
                    />
                  </div>
                  <div>
                    <label className="label text-xs">Threshold (kbps)</label>
                    <input
                      type="number"
                      value={dtsConfig.throughputThresholdKbps}
                      onChange={(e) => setDtsConfig({ ...dtsConfig, throughputThresholdKbps: parseInt(e.target.value) || 0 })}
                      className="input"
                      min={0}
                      step={100}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={dtsConfig.activateSwitching}
                      onChange={(e) => setDtsConfig({ ...dtsConfig, activateSwitching: e.target.checked })}
                      className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                    />
                    <span>Activate Switching</span>
                    <span className="text-xs text-gray-500">(set on last track in set)</span>
                  </label>
                </div>
              </div>
            )}
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

      {/* DTS Simulcast Subscribe */}
      <div className="panel">
        <div className="panel-header">Subscribe with DTS</div>
        <div className="panel-body space-y-4">
          <div>
            <label className="label">Namespace</label>
            <input
              type="text"
              value={newSubscription.namespace}
              onChange={(e) => setNewSubscription({ ...newSubscription, namespace: e.target.value })}
              placeholder="suhas"
              className="input"
            />
            <p className="text-xs text-gray-500 mt-1">Must match publisher's namespace</p>
          </div>

          {/* Quality Selection */}
          <div>
            <label className="label">Select Qualities</label>
            <div className="grid grid-cols-3 gap-2 text-xs text-center">
              <label className={`p-3 rounded cursor-pointer border-2 transition-colors ${
                simulcastQualities['1080p']
                  ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-400'
                  : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:border-blue-300'
              }`}>
                <input
                  type="checkbox"
                  checked={simulcastQualities['1080p']}
                  onChange={(e) => setSimulcastQualities({ ...simulcastQualities, '1080p': e.target.checked })}
                  className="sr-only"
                />
                <div className="font-semibold text-blue-700 dark:text-blue-300">1080p</div>
                <div className="text-gray-500">≥4 Mbps</div>
              </label>
              <label className={`p-3 rounded cursor-pointer border-2 transition-colors ${
                simulcastQualities['720p']
                  ? 'bg-green-50 dark:bg-green-900/20 border-green-400'
                  : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:border-green-300'
              }`}>
                <input
                  type="checkbox"
                  checked={simulcastQualities['720p']}
                  onChange={(e) => setSimulcastQualities({ ...simulcastQualities, '720p': e.target.checked })}
                  className="sr-only"
                />
                <div className="font-semibold text-green-700 dark:text-green-300">720p</div>
                <div className="text-gray-500">≥2 Mbps</div>
              </label>
              <label className={`p-3 rounded cursor-pointer border-2 transition-colors ${
                simulcastQualities['480p']
                  ? 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-400'
                  : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:border-yellow-300'
              }`}>
                <input
                  type="checkbox"
                  checked={simulcastQualities['480p']}
                  onChange={(e) => setSimulcastQualities({ ...simulcastQualities, '480p': e.target.checked })}
                  className="sr-only"
                />
                <div className="font-semibold text-yellow-700 dark:text-yellow-300">480p</div>
                <div className="text-gray-500">≥0.8 Mbps</div>
              </label>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {Object.values(simulcastQualities).filter(v => v).length === 0
                ? 'Select at least one quality'
                : `Tracks: ${Object.entries(simulcastQualities).filter(([,v]) => v).map(([q]) => `video-${q}`).join(', ')}`
              }
            </p>
          </div>

          {/* Main action button */}
          <button
            onClick={addAndSubscribeSimulcast}
            disabled={sessionState !== 'ready' || !newSubscription.namespace || !Object.values(simulcastQualities).some(v => v)}
            className="btn-success w-full py-3 text-base font-semibold"
          >
            Subscribe ({Object.values(simulcastQualities).filter(v => v).length} track{Object.values(simulcastQualities).filter(v => v).length !== 1 ? 's' : ''})
          </button>

          <p className="text-xs text-gray-500 text-center">
            Relay will select best quality based on your bandwidth
          </p>
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
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium">{config.trackName}</span>
                        {secureObjectsEnabled && (
                          <svg className="w-4 h-4 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                          </svg>
                        )}
                        {config.dts?.enabled && (
                          <span className="badge badge-purple text-xs">
                            DTS Set {config.dts.switchingSetId} @ {config.dts.throughputThresholdKbps}kbps
                            {config.dts.activateSwitching && ' ✓'}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500">{config.namespace}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {config.isSubscribed && config.subscriptionId !== undefined && (
                      <span className="text-xs text-gray-500">
                        {subscribedTracks.find(t => t.id === `sub-${config.subscriptionId}`)?.stats.bytesTransferred
                          ? `${Math.round((subscribedTracks.find(t => t.id === `sub-${config.subscriptionId}`)?.stats.bytesTransferred || 0) / 1024)}KB`
                          : '0KB'}
                      </span>
                    )}
                    <span className={`badge ${config.isSubscribed ? (config.isPaused ? 'badge-yellow' : 'badge-green') : 'badge-gray'}`}>
                      {config.isSubscribed ? (config.isPaused ? 'Paused' : 'Subscribed') : 'Not Subscribed'}
                    </span>
                  </div>
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

      {/* Video Players - sized proportionally by resolution (1080p largest, 720p medium, 480p smallest) */}
      {videoSubscriptions.length > 0 && (() => {
        // Compute DTS selection state and sort by bitrate (highest first)
        // isDtsSelected is true only for the subscription that most recently received frames
        const subscriptionsWithDts = videoSubscriptions.map(config => {
          const track = subscribedTracks.find(t => t.id === `sub-${config.subscriptionId}`);
          const bytesTransferred = track?.stats.bytesTransferred || 0;
          // For DTS, only the subscription currently receiving data is "selected"
          const isDtsSelected = config.dts?.enabled && config.subscriptionId === lastActiveSubscriptionId;
          const bitrateKbps = config.dts?.throughputThresholdKbps || 0;
          return { config, track, isDtsSelected, bitrateKbps, bytesTransferred };
        }).sort((a, b) => b.bitrateKbps - a.bitrateKbps); // Sort by bitrate descending

        const hasDtsSubscriptions = subscriptionsWithDts.some(s => s.config.dts?.enabled);
        const selectedTrack = subscriptionsWithDts.find(s => s.isDtsSelected);

        // Calculate relative widths based on resolution/bitrate
        // 1080p (4000kbps) -> 100%, 720p (2000kbps) -> 70%, 480p (800kbps) -> 50%
        const getWidthClass = (bitrateKbps: number) => {
          if (bitrateKbps >= 3000) return 'w-full'; // 1080p - full width
          if (bitrateKbps >= 1500) return 'w-3/4';  // 720p - 75% width
          return 'w-1/2';                            // 480p - 50% width
        };

        return (
          <div className="panel">
            <div className="panel-header">
              Video Players ({videoSubscriptions.length})
              {hasDtsSubscriptions && selectedTrack && (
                <span className="ml-2 text-xs text-green-600 dark:text-green-400">
                  DTS Active: {selectedTrack.config.trackName}
                </span>
              )}
            </div>
            <div className="panel-body space-y-4">
              {subscriptionsWithDts.map(({ config, track, isDtsSelected, bitrateKbps }) => (
                <div key={config.id} className={`space-y-2 ${getWidthClass(bitrateKbps)}`}>
                  {isDebugMode() && (
                    <div className="text-sm font-medium flex items-center justify-between">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate">{config.trackName}</span>
                      </span>
                      <span className="text-xs text-gray-500 ml-2">
                        {track ? `G:${track.stats.groupId} O:${track.stats.objectId}` : ''}
                      </span>
                    </div>
                  )}
                  <VideoRenderer
                    frame={config.subscriptionId !== undefined ? videoFrames[config.subscriptionId] || null : null}
                    trackName={config.trackName}
                    isDtsSelected={isDtsSelected}
                    bitrateKbps={bitrateKbps}
                    expectedResolution={(() => {
                      // Extract resolution from track name (e.g., "video-1080p" -> "1080p")
                      const match = config.trackName.match(/(\d+p)$/);
                      return match ? match[1] : undefined;
                    })()}
                  />
                  {enableStats && config.subscriptionId !== undefined && (
                    <div className="space-y-2">
                      <JitterGraph
                        subscriptionId={config.subscriptionId}
                        onJitterSample={onJitterSample}
                        targetLatency={targetLatency}
                      />
                      <LatencyStatsGraph
                        subscriptionId={config.subscriptionId}
                        onLatencyStats={onLatencyStats}
                        targetLatency={targetLatency}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Audio Players - One per audio subscription */}
      {audioSubscriptions.length > 0 && (
        <div className="panel">
          <div className="panel-header">Audio Players ({audioSubscriptions.length})</div>
          <div className="panel-body space-y-3">
            {audioSubscriptions.map(config => (
              <div key={config.id} className="space-y-2">
                <div className="text-sm font-medium flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate">{config.trackName}</span>
                    {secureObjectsEnabled && (
                      <svg className="w-4 h-4 text-yellow-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                      </svg>
                    )}
                  </span>
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
                      targetLatency={targetLatency}
                    />
                    <LatencyStatsGraph
                      subscriptionId={config.subscriptionId}
                      onLatencyStats={onLatencyStats}
                      targetLatency={targetLatency}
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
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-sm">{track.trackName}</span>
                        {secureObjectsEnabled && (
                          <svg className="w-4 h-4 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                          </svg>
                        )}
                      </div>
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
      </>
      )}
    </div>
  );
};
