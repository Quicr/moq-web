// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Catalog Subscriber Panel
 *
 * Component for subscribing to MSF catalogs and displaying received tracks.
 * Supports offline configuration with "Connect & Go" workflow.
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useStore } from '../../store';
import { createMSFSession, type MSFSession, type FullCatalog, type Track } from '@web-moq/msf';
import { ABRController, type ABRTrack } from '@web-moq/media';
import { parseSubtitles, type SubtitleCue } from '../player/SubtitleOverlay';
import { MoqMediaPlayer } from '../player/MoqMediaPlayer';

interface CatalogSubscriberPanelProps {
  namespace: string;
  onNamespaceChange: (namespace: string) => void;
}

// Timeline data type for VOD seeking
interface TimelineData {
  duration: number;
  entries: Array<{ groupId: number; timestamp: number; objectCount: number }>;
  framerate: number;
}

/**
 * Get experience profile label from targetLatency
 */
function getExperienceProfile(targetLatency?: number): string {
  if (!targetLatency) return 'default';
  if (targetLatency <= 100) return 'interactive';
  if (targetLatency <= 1000) return 'streaming';
  return 'broadcast';
}

/**
 * Format bitrate for display
 */
function formatBitrate(bitrate?: number): string {
  if (!bitrate) return 'N/A';
  if (bitrate >= 1_000_000) {
    return `${(bitrate / 1_000_000).toFixed(1)} Mbps`;
  }
  return `${(bitrate / 1000).toFixed(0)} Kbps`;
}

/**
 * Determine track type from track properties
 */
function getTrackType(track: Track): 'video' | 'audio' | 'subtitle' | 'timeline' | 'data' {
  if (track.width || track.height || track.framerate) return 'video';
  if (track.samplerate || track.channelConfig) return 'audio';
  if (track.role === 'subtitle' || track.lang) return 'subtitle';
  if (track.packaging === 'mediatimeline' || track.name.toLowerCase().includes('timeline')) return 'timeline';
  return 'data';
}

export const CatalogSubscriberPanel: React.FC<CatalogSubscriberPanelProps> = ({
  namespace,
  onNamespaceChange,
}) => {
  const { session, sessionState, state, connect, serverUrl, startSubscription, onVideoFrame } = useStore();

  const [subscribeStatus, setSubscribeStatus] = useState<'idle' | 'connecting' | 'subscribing' | 'subscribed' | 'error'>('idle');
  const [subscribeError, setSubscribeError] = useState<string | null>(null);
  const [receivedCatalog, setReceivedCatalog] = useState<FullCatalog | null>(null);
  const [subscribedTracks, setSubscribedTracks] = useState<Set<string>>(new Set());
  const [loadingSubtitles, setLoadingSubtitles] = useState<Set<string>>(new Set());
  const [loadingTimeline, setLoadingTimeline] = useState<Set<string>>(new Set());
  const [showCatalogJson, setShowCatalogJson] = useState(false);

  // Local state for subtitles and timeline (TODO: integrate with store)
  const [_subtitleCuesMap, setSubtitleCuesMap] = useState<Map<string, SubtitleCue[]>>(new Map());
  const [activeSubtitleTrack, setActiveSubtitleTrack] = useState<string | null>(null);
  const [_timelineData, setTimelineData] = useState<TimelineData | null>(null);
  // Note: _subtitleCuesMap and _timelineData are set but read access will be added when player integration is complete

  // Video frames for rendering
  const [videoFrames, setVideoFrames] = useState<Map<string, VideoFrame | null>>(new Map());
  const subscriptionToTrackRef = useRef<Map<number, string>>(new Map());
  const trackToSubscriptionRef = useRef<Map<string, number>>(new Map()); // Reverse map for VOD controls

  // ABR state
  const abrControllerRef = useRef<ABRController | null>(null);
  const [abrEnabled, setAbrEnabled] = useState(true);
  const [selectedQuality, setSelectedQuality] = useState<Map<number, string>>(new Map()); // altGroup -> trackName

  // Helper to set subtitle cues for a track
  const setSubtitleCues = useCallback((trackName: string, cues: SubtitleCue[]) => {
    setSubtitleCuesMap(prev => new Map(prev).set(trackName, cues));
  }, []);

  // MSF Session reference
  const msfSessionRef = useRef<MSFSession | null>(null);

  const isConnected = state === 'connected' && sessionState === 'ready';

  // Group tracks by altGroup for ABR quality switching
  const tracksByAltGroup = useMemo(() => {
    if (!receivedCatalog) return new Map<number, Track[]>();

    const groups = new Map<number, Track[]>();
    for (const track of receivedCatalog.tracks) {
      if (track.altGroup !== undefined) {
        if (!groups.has(track.altGroup)) {
          groups.set(track.altGroup, []);
        }
        groups.get(track.altGroup)!.push(track);
      }
    }

    // Sort each group by bitrate or resolution
    for (const [, tracks] of groups) {
      tracks.sort((a, b) => {
        if (a.bitrate !== undefined && b.bitrate !== undefined) {
          return a.bitrate - b.bitrate;
        }
        if (a.width !== undefined && b.width !== undefined) {
          return a.width - b.width;
        }
        return 0;
      });
    }

    return groups;
  }, [receivedCatalog]);

  // Initialize ABR controller when catalog is received
  useEffect(() => {
    if (!receivedCatalog || tracksByAltGroup.size === 0) {
      abrControllerRef.current = null;
      return;
    }

    const handleSwitch = async (fromTrack: ABRTrack, toTrack: ABRTrack) => {
      console.log('[ABR] Switching from', fromTrack.name, 'to', toTrack.name);

      // Find the Track objects
      const from = receivedCatalog.tracks.find(t => t.name === fromTrack.name);
      const to = receivedCatalog.tracks.find(t => t.name === toTrack.name);

      if (!from || !to) return;

      // Unsubscribe from current track (TODO: implement proper unsubscribe)
      setSubscribedTracks(prev => {
        const newSet = new Set(prev);
        newSet.delete(fromTrack.name);
        return newSet;
      });

      // Subscribe to new track
      await handleTrackSubscribe(to);

      // Update selected quality
      setSelectedQuality(prev => new Map(prev).set(fromTrack.altGroup, toTrack.name));
    };

    const abr = new ABRController({
      onSwitch: handleSwitch,
      debug: true,
    });

    // Register all tracks with altGroup
    for (const [altGroup, tracks] of tracksByAltGroup) {
      for (const track of tracks) {
        abr.registerTrack({
          name: track.name,
          namespace: track.namespace ?? namespace.split('/'),
          altGroup,
          bitrate: track.bitrate,
          width: track.width,
          height: track.height,
          codec: track.codec,
        });
      }
    }

    abrControllerRef.current = abr;

    if (abrEnabled) {
      abr.start();
    }

    return () => {
      abr.stop();
    };
  }, [receivedCatalog, tracksByAltGroup, namespace, abrEnabled]);

  // Handle manual quality selection
  const handleQualityChange = useCallback(async (altGroup: number, trackName: string) => {
    if (!abrControllerRef.current) return;

    const success = await abrControllerRef.current.requestQuality(altGroup, trackName);
    if (success) {
      setSelectedQuality(prev => new Map(prev).set(altGroup, trackName));
    }
  }, []);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (msfSessionRef.current) {
        msfSessionRef.current.close().catch(console.error);
      }
      // Close any remaining video frames
      videoFrames.forEach(frame => {
        if (frame) {
          try { frame.close(); } catch { /* already closed */ }
        }
      });
    };
  }, []);

  // Handle incoming video frames
  useEffect(() => {
    const unsubscribe = onVideoFrame(({ subscriptionId, frame }) => {
      const trackName = subscriptionToTrackRef.current.get(subscriptionId);
      if (trackName) {
        setVideoFrames(prev => {
          const newMap = new Map(prev);
          // Close previous frame to avoid memory leak
          const oldFrame = newMap.get(trackName);
          if (oldFrame) {
            try { oldFrame.close(); } catch { /* already closed */ }
          }
          newMap.set(trackName, frame);
          return newMap;
        });
      }
    });

    return unsubscribe;
  }, [onVideoFrame]);

  /**
   * Connect & Subscribe flow - handles connection if needed
   */
  const handleSubscribe = useCallback(async () => {
    setSubscribeError(null);
    setReceivedCatalog(null);

    // If not connected, connect first
    if (!session || sessionState !== 'ready') {
      setSubscribeStatus('connecting');

      try {
        await connect(serverUrl);

        // Wait for session to be ready
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Session setup timeout')), 10000);

          const checkReady = () => {
            const { sessionState: currentState } = useStore.getState();
            if (currentState === 'ready') {
              clearTimeout(timeout);
              resolve();
            } else if (currentState === 'error') {
              clearTimeout(timeout);
              reject(new Error('Session setup failed'));
            } else {
              setTimeout(checkReady, 100);
            }
          };
          checkReady();
        });
      } catch (err) {
        console.error('[CatalogSubscriber] Failed to connect:', err);
        setSubscribeError(`Connection failed: ${(err as Error).message}`);
        setSubscribeStatus('error');
        return;
      }
    }

    // Get fresh session reference
    const { session: currentSession } = useStore.getState();
    if (!currentSession) {
      setSubscribeError('No session after connect');
      setSubscribeStatus('error');
      return;
    }

    setSubscribeStatus('subscribing');

    try {
      // Create MSFSession for catalog subscription
      const moqtSession = currentSession.getMOQTSession();
      const msfSession = createMSFSession(moqtSession, namespace.split('/'));
      msfSessionRef.current = msfSession;

      // Subscribe to catalog with callbacks
      await msfSession.subscribeCatalog(
        (catalog, isIndependent) => {
          console.log('[CatalogSubscriber] Received catalog:', {
            tracks: catalog.tracks.length,
            isIndependent,
            generatedAt: catalog.generatedAt,
          });
          setReceivedCatalog(catalog);
        },
        (error) => {
          console.error('[CatalogSubscriber] Catalog error:', error);
          setSubscribeError(error.message);
          setSubscribeStatus('error');
        }
      );

      console.log('[CatalogSubscriber] Subscribed to catalog:', namespace);
      setSubscribeStatus('subscribed');
    } catch (err) {
      console.error('[CatalogSubscriber] Failed to subscribe:', err);
      setSubscribeError((err as Error).message);
      setSubscribeStatus('error');
    }
  }, [session, sessionState, namespace, serverUrl, connect]);

  // Unsubscribe from catalog
  const handleUnsubscribe = useCallback(async () => {
    if (msfSessionRef.current) {
      await msfSessionRef.current.close();
      msfSessionRef.current = null;
    }
    setSubscribeStatus('idle');
    setReceivedCatalog(null);
    setSubscribedTracks(new Set());
  }, []);

  // Subscribe to a specific track
  const handleTrackSubscribe = useCallback(async (track: Track) => {
    if (!receivedCatalog) return;

    const trackNamespace = track.namespace ?? namespace.split('/');
    const trackName = track.name;

    try {
      const mediaType = getTrackType(track) === 'audio' ? 'audio' : 'video';

      // Pass video config from catalog track info for proper decoder configuration
      const videoConfig = mediaType === 'video' && (track.codec || track.width) ? {
        codec: track.codec,
        width: track.width,
        height: track.height,
      } : undefined;

      console.log('[CatalogSubscriber] Subscribing with video config:', videoConfig);

      // Pass isLive from catalog for auto policy selection (VOD vs Live)
      // Pass framerate for VOD frame pacing
      const subscriptionId = await startSubscription(
        trackNamespace.join('/'),
        trackName,
        mediaType,
        videoConfig,
        track.isLive,
        track.framerate
      );

      // Map subscription ID to track name for video frame routing
      subscriptionToTrackRef.current.set(subscriptionId, trackName);
      trackToSubscriptionRef.current.set(trackName, subscriptionId);
      console.log('[CatalogSubscriber] Mapped subscription', { subscriptionId, trackName });

      setSubscribedTracks(prev => new Set([...prev, trackName]));
      console.log('[CatalogSubscriber] Subscribed to track:', trackName);
    } catch (err) {
      console.error('[CatalogSubscriber] Failed to subscribe to track:', err);
    }
  }, [receivedCatalog, namespace, startSubscription]);

  // Subscribe to a subtitle track
  const handleSubtitleSubscribe = useCallback(async (track: Track) => {
    if (!msfSessionRef.current || !receivedCatalog) return;

    const trackNamespace = track.namespace ?? namespace.split('/');
    const trackName = track.name;

    setLoadingSubtitles(prev => new Set([...prev, trackName]));

    try {
      const moqtSession = msfSessionRef.current.getMOQTSession();
      let accumulatedContent = '';

      await moqtSession.subscribe(
        trackNamespace,
        trackName,
        {},
        (data: Uint8Array, groupId: number, objectId: number) => {
          const textContent = new TextDecoder().decode(data);

          console.log('[CatalogSubscriber] Received subtitle data:', {
            trackName,
            groupId,
            objectId,
            size: data.byteLength,
          });

          accumulatedContent += textContent;
          const cues = parseSubtitles(accumulatedContent);

          if (cues.length > 0) {
            console.log('[CatalogSubscriber] Parsed subtitle cues:', {
              trackName,
              cueCount: cues.length,
            });

            setSubtitleCues(trackName, cues);

            if (!activeSubtitleTrack) {
              setActiveSubtitleTrack(trackName);
            }
          }
        }
      );

      setSubscribedTracks(prev => new Set([...prev, trackName]));
      setLoadingSubtitles(prev => {
        const next = new Set(prev);
        next.delete(trackName);
        return next;
      });

      console.log('[CatalogSubscriber] Subscribed to subtitle track:', trackName);
    } catch (err) {
      console.error('[CatalogSubscriber] Failed to subscribe to subtitle track:', err);
      setLoadingSubtitles(prev => {
        const next = new Set(prev);
        next.delete(trackName);
        return next;
      });
    }
  }, [receivedCatalog, namespace, setSubtitleCues, setActiveSubtitleTrack, activeSubtitleTrack]);

  // Subscribe to a timeline track
  const handleTimelineSubscribe = useCallback(async (track: Track) => {
    if (!msfSessionRef.current || !receivedCatalog) return;

    const trackNamespace = track.namespace ?? namespace.split('/');
    const trackName = track.name;

    setLoadingTimeline(prev => new Set([...prev, trackName]));

    try {
      const moqtSession = msfSessionRef.current.getMOQTSession();

      await moqtSession.subscribe(
        trackNamespace,
        trackName,
        {},
        (data: Uint8Array, groupId: number, objectId: number) => {
          const textContent = new TextDecoder().decode(data);

          console.log('[CatalogSubscriber] Received timeline data:', {
            trackName,
            groupId,
            objectId,
            size: data.byteLength,
          });

          try {
            const timelineData = JSON.parse(textContent);
            console.log('[CatalogSubscriber] Parsed timeline:', {
              duration: timelineData.duration,
              entries: timelineData.entries?.length,
              framerate: timelineData.framerate,
            });

            setTimelineData(timelineData);
          } catch (parseErr) {
            console.error('[CatalogSubscriber] Failed to parse timeline:', parseErr);
          }
        }
      );

      setSubscribedTracks(prev => new Set([...prev, trackName]));
      setLoadingTimeline(prev => {
        const next = new Set(prev);
        next.delete(trackName);
        return next;
      });

      console.log('[CatalogSubscriber] Subscribed to timeline track:', trackName);
    } catch (err) {
      console.error('[CatalogSubscriber] Failed to subscribe to timeline track:', err);
      setLoadingTimeline(prev => {
        const next = new Set(prev);
        next.delete(trackName);
        return next;
      });
    }
  }, [receivedCatalog, namespace, setTimelineData]);

  /**
   * Get button text based on connection state
   */
  const getSubscribeButtonText = () => {
    if (subscribeStatus === 'connecting') return 'Connecting...';
    if (subscribeStatus === 'subscribing') return 'Subscribing...';
    if (isConnected) return 'Subscribe';
    return 'Connect & Subscribe';
  };

  // Track type icons
  const TrackIcon: React.FC<{ type: string; className?: string }> = ({ type, className = 'w-5 h-5' }) => {
    const icons: Record<string, string> = {
      video: 'M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z',
      audio: 'M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z',
      subtitle: 'M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z',
      timeline: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
      data: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4',
    };

    const colors: Record<string, string> = {
      video: 'text-accent-purple',
      audio: 'text-emerald-400',
      subtitle: 'text-blue-400',
      timeline: 'text-orange-400',
      data: 'text-gray-500 dark:text-white/50',
    };

    return (
      <svg className={`${className} ${colors[type] || colors.data}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={icons[type] || icons.data} />
      </svg>
    );
  };

  return (
    <div className="glass-panel">
      <div className="glass-panel-header">
        <svg className="w-5 h-5 text-accent-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
        </svg>
        Subscribe to Catalog
      </div>
      <div className="glass-panel-body space-y-4">
        {/* Namespace Input */}
        <div>
          <label className="label">Catalog Namespace</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={namespace}
              onChange={(e) => onNamespaceChange(e.target.value)}
              placeholder="conference/room-1/media"
              className="input flex-1"
              disabled={subscribeStatus === 'subscribed'}
            />
            {subscribeStatus !== 'subscribed' ? (
              <button
                onClick={handleSubscribe}
                disabled={subscribeStatus === 'connecting' || subscribeStatus === 'subscribing'}
                className="btn-primary whitespace-nowrap"
              >
                {getSubscribeButtonText()}
              </button>
            ) : (
              <button
                onClick={handleUnsubscribe}
                className="btn-secondary whitespace-nowrap"
              >
                Unsubscribe
              </button>
            )}
          </div>
          <p className="text-xs text-gray-400 dark:text-white/40 mt-2">
            Subscribe to receive the catalog and auto-discover tracks
          </p>
        </div>

        {/* Error Display */}
        {subscribeError && (
          <div className="glass-panel-subtle p-4 flex items-center gap-3 border-red-500/30">
            <div className="w-10 h-10 rounded-xl bg-red-500/20 flex items-center justify-center flex-shrink-0">
              <svg className="w-5 h-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <p className="text-red-300 font-medium text-sm">Subscribe Error</p>
              <p className="text-red-400/70 text-xs">{subscribeError}</p>
            </div>
          </div>
        )}

        {/* Received Catalog */}
        {receivedCatalog ? (
          <div className="space-y-4">
            {/* Catalog Info */}
            <div className="glass-panel-subtle p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
                    <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-gray-900 dark:text-white/90 font-medium text-sm">Catalog Received</p>
                    <p className="text-gray-500 dark:text-white/50 text-xs">
                      {receivedCatalog.tracks.length} track{receivedCatalog.tracks.length !== 1 ? 's' : ''} available
                      {receivedCatalog.generatedAt && (
                        <> &middot; {new Date(receivedCatalog.generatedAt).toLocaleString()}</>
                      )}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setShowCatalogJson(!showCatalogJson)}
                  className="btn-sm btn-ghost text-xs"
                >
                  {showCatalogJson ? 'Hide' : 'Show'} JSON
                </button>
              </div>

              {/* Collapsible JSON View */}
              {showCatalogJson && (
                <div className="mt-4">
                  <pre className="text-xs text-gray-700 dark:text-white/70 p-3 rounded-lg overflow-auto max-h-48 bg-black/20 border border-white/5">
                    {JSON.stringify(receivedCatalog, null, 2)}
                  </pre>
                </div>
              )}
            </div>

            {/* Track List */}
            <div className="space-y-2">
              {receivedCatalog.tracks.map((track, index) => {
                const trackType = getTrackType(track);
                const isSubscribed = subscribedTracks.has(track.name);

                return (
                  <div
                    key={`${track.name}-${index}`}
                    className={`glass-panel-subtle p-4 transition-all ${
                      isSubscribed ? 'border-emerald-500/30' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <TrackIcon type={trackType} />
                        <div>
                          <span className="font-medium text-sm text-gray-900 dark:text-white/90">{track.name}</span>
                          {track.label && (
                            <span className="text-xs text-gray-400 dark:text-white/40 ml-2">({track.label})</span>
                          )}
                        </div>
                      </div>

                      {/* Subscribe Button */}
                      {(trackType === 'video' || trackType === 'audio') && (
                        <button
                          onClick={() => handleTrackSubscribe(track)}
                          disabled={isSubscribed}
                          className={`btn-sm ${isSubscribed ? 'btn-success opacity-60' : 'btn-primary'}`}
                        >
                          {isSubscribed ? 'Subscribed' : 'Subscribe'}
                        </button>
                      )}
                      {trackType === 'subtitle' && (
                        <>
                          {isSubscribed ? (
                            <button
                              onClick={() => setActiveSubtitleTrack(
                                activeSubtitleTrack === track.name ? null : track.name
                              )}
                              className={`btn-sm ${
                                activeSubtitleTrack === track.name
                                  ? 'btn-success'
                                  : 'btn-secondary'
                              }`}
                            >
                              {activeSubtitleTrack === track.name ? 'Active' : 'Use'}
                            </button>
                          ) : (
                            <button
                              onClick={() => handleSubtitleSubscribe(track)}
                              disabled={loadingSubtitles.has(track.name)}
                              className="btn-sm btn-primary"
                            >
                              {loadingSubtitles.has(track.name) ? 'Loading...' : 'Subscribe'}
                            </button>
                          )}
                        </>
                      )}
                      {trackType === 'timeline' && (
                        <button
                          onClick={() => handleTimelineSubscribe(track)}
                          disabled={isSubscribed || loadingTimeline.has(track.name)}
                          className={`btn-sm ${isSubscribed ? 'btn-success opacity-60' : 'btn-primary'}`}
                        >
                          {loadingTimeline.has(track.name) ? 'Loading...' : isSubscribed ? 'Loaded' : 'Load'}
                        </button>
                      )}
                    </div>

                    {/* Track Details */}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {track.codec && (
                        <span className="badge">{track.codec}</span>
                      )}
                      {track.width && track.height && (
                        <span className="badge">{track.width}x{track.height}</span>
                      )}
                      {track.framerate && (
                        <span className="badge">{track.framerate}fps</span>
                      )}
                      {track.bitrate && (
                        <span className="badge">{formatBitrate(track.bitrate)}</span>
                      )}
                      {track.samplerate && (
                        <span className="badge">{track.samplerate / 1000}kHz</span>
                      )}
                      {track.channelConfig && (
                        <span className="badge">{track.channelConfig}</span>
                      )}
                      {track.isLive !== undefined && (
                        <span className={track.isLive ? 'badge-red' : 'badge-blue'}>
                          {track.isLive ? 'LIVE' : 'VOD'}
                        </span>
                      )}
                      {track.altGroup !== undefined && (
                        <span className="badge-purple">
                          ABR Group {track.altGroup}
                        </span>
                      )}
                      {track.targetLatency && (
                        <span className="badge-yellow">
                          {getExperienceProfile(track.targetLatency)}
                        </span>
                      )}
                      {track.lang && (
                        <span className="badge">{track.lang}</span>
                      )}
                      {trackType === 'subtitle' && activeSubtitleTrack === track.name && (
                        <span className="badge-green">active</span>
                      )}
                    </div>

                    {/* Quality Selector for ABR tracks */}
                    {track.altGroup !== undefined && isSubscribed && tracksByAltGroup.get(track.altGroup)!.length > 1 && (
                      <div className="mt-3 flex items-center gap-2">
                        <span className="text-xs text-gray-500 dark:text-white/50">Quality:</span>
                        <select
                          value={selectedQuality.get(track.altGroup) ?? track.name}
                          onChange={(e) => handleQualityChange(track.altGroup!, e.target.value)}
                          className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200"
                        >
                          {tracksByAltGroup.get(track.altGroup)!.map((t) => (
                            <option key={t.name} value={t.name}>
                              {t.width && t.height ? `${t.height}p` : t.name}
                              {t.bitrate ? ` (${formatBitrate(t.bitrate)})` : ''}
                            </option>
                          ))}
                        </select>
                        <label className="flex items-center gap-1 text-xs text-gray-500 dark:text-white/50">
                          <input
                            type="checkbox"
                            checked={abrEnabled}
                            onChange={(e) => {
                              setAbrEnabled(e.target.checked);
                              if (abrControllerRef.current) {
                                e.target.checked ? abrControllerRef.current.start() : abrControllerRef.current.stop();
                              }
                            }}
                            className="w-3 h-3"
                          />
                          Auto
                        </label>
                      </div>
                    )}

                    {/* Video Player for subscribed video tracks */}
                    {trackType === 'video' && isSubscribed && (
                      <div className="mt-4">
                        <MoqMediaPlayer
                          frame={videoFrames.get(track.name) ?? null}
                          subscriptionId={trackToSubscriptionRef.current.get(track.name) ?? 0}
                          isLive={track.isLive ?? true}
                          duration={track.trackDuration}
                          framerate={track.framerate}
                          totalGroups={track.totalGroups}
                          gopDuration={track.gopDuration}
                          className="w-full rounded-lg overflow-hidden"
                          showControls={true}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : subscribeStatus === 'idle' ? (
          <div className="text-center py-12">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-white/5 flex items-center justify-center">
              <svg className="w-8 h-8 text-gray-200 dark:text-white/20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
            </div>
            <p className="text-gray-600 dark:text-white/60 font-medium">No catalog subscribed</p>
            <p className="text-gray-400 dark:text-white/40 text-sm mt-1">Enter a namespace and subscribe to view catalog</p>
          </div>
        ) : (subscribeStatus === 'connecting' || subscribeStatus === 'subscribing') ? (
          <div className="text-center py-12">
            <svg className="w-10 h-10 mx-auto mb-4 animate-spin text-accent-purple" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <p className="text-gray-600 dark:text-white/60">
              {subscribeStatus === 'connecting' ? 'Connecting to relay...' : 'Subscribing to catalog...'}
            </p>
          </div>
        ) : (
          <div className="text-center py-12 text-gray-500 dark:text-white/50">
            <p>Waiting for catalog...</p>
          </div>
        )}
      </div>
    </div>
  );
};
