// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Catalog Panel
 *
 * Main panel for MSF catalog operations - building, publishing, and subscribing.
 * Supports offline configuration with "Connect & Go" workflow.
 */

import React, { useState, useCallback, useRef } from 'react';
import { useStore } from '../../store';
import { CatalogBuilderPanel } from './CatalogBuilderPanel';
import { CatalogSubscriberPanel } from './CatalogSubscriberPanel';
import type { CatalogTrackConfig, VODTrackConfig } from './types';
import { createMSFSession, type FullCatalog, type MSFSession } from '@web-moq/msf';
import { VODLoader } from '@web-moq/media';

type CatalogMode = 'publish' | 'subscribe';

export const CatalogPanel: React.FC = () => {
  const { session, sessionState, state, connect, serverUrl } = useStore();

  const [mode, setMode] = useState<CatalogMode>('publish');
  const [namespace, setNamespace] = useState('conference/room-1/media');
  const [publishedCatalog, setPublishedCatalog] = useState<FullCatalog | null>(null);
  const [publishStatus, setPublishStatus] = useState<'idle' | 'connecting' | 'publishing' | 'published' | 'error'>('idle');
  const [publishError, setPublishError] = useState<string | null>(null);
  const [catalogRepublishSec, setCatalogRepublishSec] = useState(1); // 0 = disabled, >0 = interval in seconds

  // Track VOD loaders for each VOD track
  const [vodLoaders] = useState<Map<string, VODLoader>>(new Map());

  // MSF Session wrapper
  const msfSessionRef = useRef<MSFSession | null>(null);

  const isConnected = state === 'connected' && sessionState === 'ready';
  const isConnecting = state === 'connecting' || sessionState === 'setup';

  /**
   * Connect & Publish flow - handles connection if needed, then publishes
   */
  const handlePublishCatalog = useCallback(async (catalog: FullCatalog, tracks: CatalogTrackConfig[]) => {
    setPublishError(null);

    // If not connected, connect first
    if (!session || sessionState !== 'ready') {
      setPublishStatus('connecting');

      try {
        await connect(serverUrl);

        // Wait for session to be ready (connect resolves when transport connects,
        // but session setup may still be in progress)
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
        console.error('[CatalogPanel] Failed to connect:', err);
        setPublishError(`Connection failed: ${(err as Error).message}`);
        setPublishStatus('error');
        return;
      }
    }

    // Now we should be connected - get fresh session reference
    const { session: currentSession } = useStore.getState();
    if (!currentSession) {
      setPublishError('No session after connect');
      setPublishStatus('error');
      return;
    }

    setPublishStatus('publishing');

    try {
      console.log('[CatalogPanel] Publishing catalog:', catalog);
      console.log('[CatalogPanel] Tracks to publish:', tracks);

      // Create MSFSession wrapper for this namespace
      const namespaceParts = namespace.split('/');
      if (!msfSessionRef.current) {
        // Get underlying MOQTSession from MediaSession
        const moqtSession = currentSession.getMOQTSession();
        msfSessionRef.current = createMSFSession(moqtSession, namespaceParts, {
          catalogPublishOptions: {
            republishIntervalMs: catalogRepublishSec > 0 ? catalogRepublishSec * 1000 : 0,
          },
        });
      }
      const msfSession = msfSessionRef.current;

      // Load VOD tracks and collect publish options
      const vodTrackOptions = new Map<string, ReturnType<VODLoader['getPublishOptions']>>();

      for (const track of tracks) {
        if (track.type === 'video-vod') {
          const vodTrack = track as VODTrackConfig;
          const hasSource = vodTrack.videoFile || vodTrack.videoUrl;

          if (hasSource) {
            // Get or create loader for this track
            let loader = vodLoaders.get(track.id);
            if (!loader) {
              const sourceName = vodTrack.videoFile ? vodTrack.videoFile.name : vodTrack.videoUrl;
              console.log('[CatalogPanel] Loading VOD:', sourceName);

              loader = new VODLoader({
                framerate: vodTrack.framerate,
                width: vodTrack.width,
                height: vodTrack.height,
                bitrate: vodTrack.bitrate,
                loop: vodTrack.loopPlayback,
                onProgress: (progress) => {
                  console.log(`[CatalogPanel] VOD load progress: ${progress.phase} ${progress.progress}%`);
                },
              });

              vodLoaders.set(track.id, loader);

              // Load the video
              if (vodTrack.videoFile) {
                await loader.loadFile(vodTrack.videoFile);
              } else {
                await loader.load(vodTrack.videoUrl);
              }
              console.log('[CatalogPanel] VOD loaded:', loader.getMetadata());
            }

            // Collect publish options
            vodTrackOptions.set(vodTrack.name, loader.getPublishOptions());
          }
        }
      }

      // Use MSFSession to publish catalog and all VOD tracks
      console.log('[CatalogPanel] Publishing via MSFSession:', vodTrackOptions.size, 'VOD tracks');
      await msfSession.publishAll(catalog, vodTrackOptions);
      console.log('[CatalogPanel] Catalog and tracks published successfully');

      setPublishedCatalog(catalog);
      setPublishStatus('published');
    } catch (err) {
      console.error('[CatalogPanel] Failed to publish catalog:', err);
      setPublishError((err as Error).message);
      setPublishStatus('error');
    }
  }, [session, sessionState, serverUrl, connect, namespace, vodLoaders, catalogRepublishSec]);

  /**
   * Get button text based on connection and publish state
   */
  const getPublishButtonText = () => {
    if (publishStatus === 'connecting') return 'Connecting...';
    if (publishStatus === 'publishing') return 'Publishing...';
    if (isConnected) return 'Publish Catalog';
    if (isConnecting) return 'Connecting...';
    return 'Connect & Publish';
  };

  return (
    <div className="space-y-6">
      {/* Mode Selector */}
      <div className="tab-list">
        <button
          onClick={() => setMode('publish')}
          className={`tab flex-1 flex items-center justify-center gap-2 ${mode === 'publish' ? 'tab-active' : ''}`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
          Build & Publish
        </button>
        <button
          onClick={() => setMode('subscribe')}
          className={`tab flex-1 flex items-center justify-center gap-2 ${mode === 'subscribe' ? 'tab-active' : ''}`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
          </svg>
          Subscribe
        </button>
      </div>

      {/* Publish Mode */}
      {mode === 'publish' && (
        <>
          {/* Status Banner */}
          {publishStatus === 'published' && publishedCatalog && (
            <div className="glass-panel-subtle p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div>
                <p className="text-secondary font-medium">Catalog Published</p>
                <p className="text-muted text-sm">
                  {publishedCatalog.tracks.length} tracks on <span className="text-accent-cyan">{namespace}</span>
                </p>
              </div>
            </div>
          )}

          {publishError && (
            <div className="glass-panel-subtle p-4 flex items-center gap-3 border-red-500/30">
              <div className="w-10 h-10 rounded-xl bg-red-500/20 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <p className="text-red-300 font-medium">Publish Error</p>
                <p className="text-red-400/70 text-sm">{publishError}</p>
              </div>
            </div>
          )}

          {/* Catalog Republish Interval */}
          <div className="glass-panel-subtle p-4">
            <div className="flex items-center gap-4">
              <label className="text-sm text-secondary whitespace-nowrap">Catalog Republish:</label>
              <input
                type="number"
                min="0"
                max="60"
                value={catalogRepublishSec}
                onChange={(e) => setCatalogRepublishSec(Math.max(0, parseInt(e.target.value) || 0))}
                className="input-field w-20 text-center"
              />
              <span className="text-xs text-muted">sec (0 = disabled)</span>
            </div>
          </div>

          <CatalogBuilderPanel
            namespace={namespace}
            onNamespaceChange={setNamespace}
            onPublishCatalog={handlePublishCatalog}
            publishButtonText={getPublishButtonText()}
            isPublishing={publishStatus === 'connecting' || publishStatus === 'publishing'}
          />
        </>
      )}

      {/* Subscribe Mode */}
      {mode === 'subscribe' && (
        <CatalogSubscriberPanel
          namespace={namespace}
          onNamespaceChange={setNamespace}
        />
      )}

      {/* Info Panel */}
      <div className="glass-panel">
        <div className="glass-panel-header">
          <svg className="w-5 h-5 text-accent-purple" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          About MSF Catalogs
        </div>
        <div className="glass-panel-body text-sm text-tertiary space-y-3">
          <p>
            <span className="text-secondary font-medium">MSF (MOQT Streaming Format)</span> catalogs describe available media tracks
            for a session, including codec, resolution, bitrate, and experience profile information.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="glass-panel-subtle p-3 rounded-lg">
              <p className="text-secondary font-medium text-xs uppercase tracking-wide mb-1">VOD/DVR</p>
              <p className="text-muted text-xs">
                Publisher creates catalog with VOD and live tracks. Subscribers can seek and rewind content.
              </p>
            </div>
            <div className="glass-panel-subtle p-3 rounded-lg">
              <p className="text-secondary font-medium text-xs uppercase tracking-wide mb-1">Conferencing</p>
              <p className="text-muted text-xs">
                Catalog defines room template. All participants follow the template when publishing.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
