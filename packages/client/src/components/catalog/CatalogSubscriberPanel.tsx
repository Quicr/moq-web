// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Catalog Subscriber Panel
 *
 * Component for subscribing to MSF catalogs and displaying received tracks.
 * Automatically subscribes to media tracks based on catalog content.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useStore } from '../../store';
import { createMSFSession, type MSFSession, type FullCatalog, type Track } from '@web-moq/msf';
import { parseSubtitles } from '../player/SubtitleOverlay';

interface CatalogSubscriberPanelProps {
  namespace: string;
  onNamespaceChange: (namespace: string) => void;
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
  // Check for timeline track by packaging or name
  if (track.packaging === 'mediatimeline' || track.name.toLowerCase().includes('timeline')) return 'timeline';
  return 'data';
}

export const CatalogSubscriberPanel: React.FC<CatalogSubscriberPanelProps> = ({
  namespace,
  onNamespaceChange,
}) => {
  const { session, sessionState, startSubscription, setSubtitleCues, setActiveSubtitleTrack, activeSubtitleTrack, setTimelineData } = useStore();

  const [subscribeStatus, setSubscribeStatus] = useState<'idle' | 'subscribing' | 'subscribed' | 'error'>('idle');
  const [subscribeError, setSubscribeError] = useState<string | null>(null);
  const [receivedCatalog, setReceivedCatalog] = useState<FullCatalog | null>(null);
  const [subscribedTracks, setSubscribedTracks] = useState<Set<string>>(new Set());
  const [loadingSubtitles, setLoadingSubtitles] = useState<Set<string>>(new Set());
  const [loadingTimeline, setLoadingTimeline] = useState<Set<string>>(new Set());

  // MSF Session reference
  const msfSessionRef = useRef<MSFSession | null>(null);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (msfSessionRef.current) {
        msfSessionRef.current.close().catch(console.error);
      }
    };
  }, []);

  // Subscribe to catalog
  const handleSubscribe = useCallback(async () => {
    if (!session || sessionState !== 'ready') {
      setSubscribeError('Session not ready');
      return;
    }

    setSubscribeStatus('subscribing');
    setSubscribeError(null);
    setReceivedCatalog(null);

    try {
      // Create MSFSession for catalog subscription
      const moqtSession = session.getMOQTSession();
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
  }, [session, sessionState, namespace]);

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

      // Subscribe to the track using store action
      await startSubscription(
        trackNamespace.join('/'),
        trackName,
        mediaType
      );

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

    // Mark as loading
    setLoadingSubtitles(prev => new Set([...prev, trackName]));

    try {
      // Get the underlying MOQT session for data track subscription
      const moqtSession = msfSessionRef.current.getMOQTSession();

      // Accumulated subtitle content (may come in multiple objects)
      let accumulatedContent = '';

      // Subscribe to subtitle track directly via MOQTSession
      // Subtitle tracks return text content (WebVTT or SRT format)
      await moqtSession.subscribe(
        trackNamespace,
        trackName,
        {}, // Default options
        (data: Uint8Array, groupId: number, objectId: number) => {
          // Convert Uint8Array to string
          const textContent = new TextDecoder().decode(data);

          console.log('[CatalogSubscriber] Received subtitle data:', {
            trackName,
            groupId,
            objectId,
            size: data.byteLength,
          });

          // Accumulate content (full subtitle file may be split across objects)
          accumulatedContent += textContent;

          // Try to parse accumulated content
          const cues = parseSubtitles(accumulatedContent);

          if (cues.length > 0) {
            console.log('[CatalogSubscriber] Parsed subtitle cues:', {
              trackName,
              cueCount: cues.length,
            });

            // Store cues in state
            setSubtitleCues(trackName, cues);

            // Auto-set as active if no active subtitle track
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

    // Mark as loading
    setLoadingTimeline(prev => new Set([...prev, trackName]));

    try {
      // Get the underlying MOQT session for data track subscription
      const moqtSession = msfSessionRef.current.getMOQTSession();

      // Subscribe to timeline track directly via MOQTSession
      await moqtSession.subscribe(
        trackNamespace,
        trackName,
        {}, // Default options
        (data: Uint8Array, groupId: number, objectId: number) => {
          // Convert Uint8Array to string and parse as JSON
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

            // Store timeline data in state
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

  return (
    <div className="panel">
      <div className="panel-header">Subscribe to Catalog</div>
      <div className="panel-body space-y-4">
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
                disabled={sessionState !== 'ready' || subscribeStatus === 'subscribing'}
                className="btn-primary"
              >
                {subscribeStatus === 'subscribing' ? 'Subscribing...' : 'Subscribe'}
              </button>
            ) : (
              <button
                onClick={handleUnsubscribe}
                className="btn-secondary"
              >
                Unsubscribe
              </button>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Subscribe to receive the catalog and auto-discover tracks
          </p>
        </div>

        {/* Error Display */}
        {subscribeError && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <div className="flex items-center gap-2 text-red-700 dark:text-red-300 text-sm">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>{subscribeError}</span>
            </div>
          </div>
        )}

        {/* Received Catalog */}
        {receivedCatalog ? (
          <div className="space-y-3">
            {/* Catalog Info */}
            <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
              <div className="flex items-center gap-2 text-blue-700 dark:text-blue-300 text-sm font-medium">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Catalog Received
              </div>
              <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">
                {receivedCatalog.tracks.length} tracks available
                {receivedCatalog.generatedAt && (
                  <> - Generated: {new Date(receivedCatalog.generatedAt).toLocaleString()}</>
                )}
              </p>
            </div>

            {/* Track List */}
            <div className="space-y-2">
              {receivedCatalog.tracks.map((track, index) => {
                const trackType = getTrackType(track);
                const isSubscribed = subscribedTracks.has(track.name);

                return (
                  <div
                    key={`${track.name}-${index}`}
                    className={`p-3 border rounded-lg transition-colors ${
                      isSubscribed
                        ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
                        : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {/* Track Type Icon */}
                        {trackType === 'video' && (
                          <svg className="w-5 h-5 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                        )}
                        {trackType === 'audio' && (
                          <svg className="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                          </svg>
                        )}
                        {trackType === 'subtitle' && (
                          <svg className="w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
                          </svg>
                        )}
                        {trackType === 'timeline' && (
                          <svg className="w-5 h-5 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        )}
                        {trackType === 'data' && (
                          <svg className="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                          </svg>
                        )}

                        <div>
                          <span className="font-medium text-sm">{track.name}</span>
                          {track.label && (
                            <span className="text-xs text-gray-500 ml-2">({track.label})</span>
                          )}
                        </div>
                      </div>

                      {/* Subscribe Button */}
                      {(trackType === 'video' || trackType === 'audio') && (
                        <button
                          onClick={() => handleTrackSubscribe(track)}
                          disabled={isSubscribed}
                          className={`btn-sm ${isSubscribed ? 'btn-secondary opacity-50' : 'btn-primary'}`}
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
                                  ? 'bg-green-500 hover:bg-green-600 text-white'
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
                          className={`btn-sm ${isSubscribed ? 'btn-secondary opacity-50' : 'btn-primary'}`}
                        >
                          {loadingTimeline.has(track.name) ? 'Loading...' : isSubscribed ? 'Loaded' : 'Load'}
                        </button>
                      )}
                    </div>

                    {/* Track Details */}
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      {track.codec && (
                        <span className="px-2 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">
                          {track.codec}
                        </span>
                      )}
                      {track.width && track.height && (
                        <span className="px-2 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">
                          {track.width}x{track.height}
                        </span>
                      )}
                      {track.framerate && (
                        <span className="px-2 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">
                          {track.framerate}fps
                        </span>
                      )}
                      {track.bitrate && (
                        <span className="px-2 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">
                          {formatBitrate(track.bitrate)}
                        </span>
                      )}
                      {track.samplerate && (
                        <span className="px-2 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">
                          {track.samplerate / 1000}kHz
                        </span>
                      )}
                      {track.channelConfig && (
                        <span className="px-2 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">
                          {track.channelConfig}
                        </span>
                      )}
                      {track.isLive !== undefined && (
                        <span className={`px-2 py-0.5 rounded ${
                          track.isLive
                            ? 'bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300'
                            : 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300'
                        }`}>
                          {track.isLive ? 'LIVE' : 'VOD'}
                        </span>
                      )}
                      {track.targetLatency && (
                        <span className="px-2 py-0.5 bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300 rounded">
                          {getExperienceProfile(track.targetLatency)}
                        </span>
                      )}
                      {track.lang && (
                        <span className="px-2 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">
                          {track.lang}
                        </span>
                      )}
                      {trackType === 'subtitle' && activeSubtitleTrack === track.name && (
                        <span className="px-2 py-0.5 bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 rounded">
                          active
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : subscribeStatus === 'idle' ? (
          <div className="text-center py-8 text-gray-500">
            <svg className="w-12 h-12 mx-auto mb-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
            <p>No catalog subscribed</p>
            <p className="text-sm">Enter a namespace and subscribe to view catalog</p>
          </div>
        ) : subscribeStatus === 'subscribing' ? (
          <div className="text-center py-8 text-gray-500">
            <svg className="w-8 h-8 mx-auto mb-3 animate-spin text-primary-500" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <p>Subscribing to catalog...</p>
          </div>
        ) : (
          <div className="text-center py-8 text-gray-500">
            <p>Waiting for catalog...</p>
          </div>
        )}
      </div>
    </div>
  );
};
