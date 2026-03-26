// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Subscribe Namespace Panel Component
 *
 * Interface for subscribing to namespace prefixes to discover tracks.
 * Receives PUBLISH messages from publishers and displays discovered tracks.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useStore } from '../../store';
import { VideoRenderer } from './VideoRenderer';

export const SubscribeNamespacePanel: React.FC = () => {
  const {
    namespaceSubscriptions,
    sessionState,
    addNamespacePanel,
    removeNamespacePanel,
    startNamespaceSubscription,
    stopNamespaceSubscription,
    onVideoFrame,
  } = useStore();

  const [newNamespacePrefix, setNewNamespacePrefix] = useState('conference/room-1');
  const [error, setError] = useState<string | null>(null);
  const [videoFrames, setVideoFrames] = useState<Record<number, VideoFrame | null>>({});

  // Listen for video frames from discovered tracks
  const handleVideoFrame = useCallback((data: { subscriptionId: number; frame: VideoFrame }) => {
    setVideoFrames(prev => {
      // Close previous frame if exists
      const prevFrame = prev[data.subscriptionId];
      if (prevFrame && prevFrame !== data.frame) {
        try {
          prevFrame.close();
        } catch {
          // Already closed
        }
      }
      return { ...prev, [data.subscriptionId]: data.frame };
    });
  }, []);

  useEffect(() => {
    const unsubscribe = onVideoFrame(handleVideoFrame);
    return () => {
      unsubscribe();
      // Clean up frames on unmount
      Object.values(videoFrames).forEach(frame => {
        if (frame) {
          try {
            frame.close();
          } catch {
            // Already closed
          }
        }
      });
    };
  }, [onVideoFrame, handleVideoFrame]);

  const handleAddPanel = () => {
    if (!newNamespacePrefix.trim()) return;
    addNamespacePanel(newNamespacePrefix.trim());
    setNewNamespacePrefix('');
  };

  const handleStartSubscription = async (panelId: string) => {
    setError(null);
    try {
      await startNamespaceSubscription(panelId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleStopSubscription = async (panelId: string) => {
    try {
      await stopNamespaceSubscription(panelId);
    } catch (err) {
      console.error('Failed to stop namespace subscription:', err);
    }
  };

  return (
    <div className="space-y-6">
      {/* Add Namespace Subscription */}
      <div className="panel">
        <div className="panel-header">Subscribe to Namespace</div>
        <div className="panel-body space-y-4">
          <div>
            <label className="label">Namespace Prefix</label>
            <input
              type="text"
              value={newNamespacePrefix}
              onChange={(e) => setNewNamespacePrefix(e.target.value)}
              placeholder="conference/room-1"
              className="input"
            />
            <p className="text-xs text-gray-500 mt-1">
              Discover all tracks published under this namespace prefix
            </p>
          </div>
          <button
            onClick={handleAddPanel}
            disabled={!newNamespacePrefix.trim()}
            className="btn-primary w-full"
          >
            Add Namespace Subscription
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-md text-sm">
          {error}
        </div>
      )}

      {/* Namespace Subscription Panels */}
      {namespaceSubscriptions.map(panel => (
        <div key={panel.id} className="panel">
          <div className="panel-header flex items-center justify-between">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              <span>{panel.namespacePrefix}</span>
            </div>
            <span className={`badge ${panel.isActive ? 'badge-green' : 'badge-gray'}`}>
              {panel.isActive ? 'Active' : 'Inactive'}
            </span>
          </div>
          <div className="panel-body space-y-4">
            {/* Control buttons */}
            <div className="flex gap-2">
              {!panel.isActive ? (
                <button
                  onClick={() => handleStartSubscription(panel.id)}
                  disabled={sessionState !== 'ready'}
                  className="btn-success btn-sm flex-1"
                >
                  Start Discovery
                </button>
              ) : (
                <button
                  onClick={() => handleStopSubscription(panel.id)}
                  className="btn-warning btn-sm flex-1"
                >
                  Stop Discovery
                </button>
              )}
              <button
                onClick={() => removeNamespacePanel(panel.id)}
                disabled={panel.isActive}
                className="btn-danger btn-sm"
              >
                Remove
              </button>
            </div>

            {/* Discovered Tracks */}
            {panel.tracks.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Discovered Tracks ({panel.tracks.length})
                </h4>
                <div className="space-y-2">
                  {panel.tracks.map((track, idx) => (
                    <div
                      key={idx}
                      className="p-3 bg-gray-50 dark:bg-gray-900 rounded-md"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          {track.type === 'video' && (
                            <svg className="w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                            </svg>
                          )}
                          {track.type === 'audio' && (
                            <svg className="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                            </svg>
                          )}
                          {track.type === 'chat' && (
                            <svg className="w-5 h-5 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                            </svg>
                          )}
                          {track.type === 'unknown' && (
                            <svg className="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                          )}
                          <div>
                            <div className="font-medium text-sm">{track.trackName}</div>
                            <div className="text-xs text-gray-500">{track.namespace.join('/')}</div>
                          </div>
                        </div>
                        <span className={`badge ${
                          track.type === 'video' ? 'badge-blue' :
                          track.type === 'audio' ? 'badge-green' :
                          track.type === 'chat' ? 'badge-yellow' : 'badge-gray'
                        }`}>
                          {track.type}
                        </span>
                      </div>
                      {/* Render video for video tracks */}
                      {track.type === 'video' && track.subscriptionId !== undefined && (
                        <VideoRenderer
                          frame={videoFrames[track.subscriptionId] || null}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {panel.isActive && panel.tracks.length === 0 && (
              <div className="text-center py-4 text-gray-500 text-sm">
                <svg className="w-8 h-8 mx-auto mb-2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                Waiting for publishers to announce tracks...
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};
