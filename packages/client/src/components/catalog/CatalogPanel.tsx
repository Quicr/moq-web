// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Catalog Panel
 *
 * Main panel for MSF catalog operations - building, publishing, and subscribing.
 * Supports both VOD/DVR publishing and video conferencing room templates.
 */

import React, { useState, useCallback } from 'react';
import { useStore } from '../../store';
import { CatalogBuilderPanel } from './CatalogBuilderPanel';
import type { CatalogTrackConfig, VODTrackConfig } from './types';
import type { FullCatalog } from '@web-moq/msf';
import { VODLoader } from '@web-moq/media';

type CatalogMode = 'publish' | 'subscribe';

export const CatalogPanel: React.FC = () => {
  const { session, sessionState } = useStore();

  const [mode, setMode] = useState<CatalogMode>('publish');
  const [namespace, setNamespace] = useState('conference/room-1/media');
  const [publishedCatalog, setPublishedCatalog] = useState<FullCatalog | null>(null);
  const [publishStatus, setPublishStatus] = useState<'idle' | 'publishing' | 'published' | 'error'>('idle');
  const [publishError, setPublishError] = useState<string | null>(null);

  // Track VOD loaders for each VOD track
  const [vodLoaders] = useState<Map<string, VODLoader>>(new Map());

  // Handle catalog publish
  const handlePublishCatalog = useCallback(async (catalog: FullCatalog, tracks: CatalogTrackConfig[]) => {
    if (!session || sessionState !== 'ready') {
      setPublishError('Session not ready');
      return;
    }

    setPublishStatus('publishing');
    setPublishError(null);

    try {
      // For now, just log the catalog - full MSF integration coming in Phase 4
      console.log('[CatalogPanel] Publishing catalog:', catalog);
      console.log('[CatalogPanel] Tracks to publish:', tracks);

      // Load VOD tracks
      for (const track of tracks) {
        if (track.type === 'video-vod') {
          const vodTrack = track as VODTrackConfig;
          if (vodTrack.videoUrl && !vodLoaders.has(track.id)) {
            console.log('[CatalogPanel] Loading VOD:', vodTrack.videoUrl);

            const loader = new VODLoader({
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

            try {
              await loader.load(vodTrack.videoUrl);
              console.log('[CatalogPanel] VOD loaded:', loader.getMetadata());
            } catch (err) {
              console.error('[CatalogPanel] Failed to load VOD:', err);
            }
          }
        }
      }

      // TODO: Phase 4 - Use MSFSession to publish catalog
      // const msfSession = createMSFSession(session, namespace.split('/'));
      // await msfSession.startCatalogPublishing();
      // await msfSession.publishCatalog(catalog);

      setPublishedCatalog(catalog);
      setPublishStatus('published');
    } catch (err) {
      console.error('[CatalogPanel] Failed to publish catalog:', err);
      setPublishError((err as Error).message);
      setPublishStatus('error');
    }
  }, [session, sessionState, vodLoaders]);

  return (
    <div className="space-y-6">
      {/* Mode Selector */}
      <div className="flex gap-2 p-1 bg-gray-100 dark:bg-gray-800 rounded-lg">
        <button
          onClick={() => setMode('publish')}
          className={`flex-1 px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            mode === 'publish'
              ? 'bg-white dark:bg-gray-700 text-primary-600 dark:text-primary-400 shadow-sm'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}
        >
          Build & Publish Catalog
        </button>
        <button
          onClick={() => setMode('subscribe')}
          className={`flex-1 px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            mode === 'subscribe'
              ? 'bg-white dark:bg-gray-700 text-primary-600 dark:text-primary-400 shadow-sm'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}
        >
          Subscribe to Catalog
        </button>
      </div>

      {/* Publish Mode */}
      {mode === 'publish' && (
        <>
          {/* Status Banner */}
          {publishStatus === 'published' && publishedCatalog && (
            <div className="p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
              <div className="flex items-center gap-2 text-green-700 dark:text-green-300">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span className="font-medium">Catalog Published</span>
              </div>
              <p className="text-sm text-green-600 dark:text-green-400 mt-1">
                {publishedCatalog.tracks.length} tracks on {namespace}
              </p>
            </div>
          )}

          {publishError && (
            <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="font-medium">Publish Error</span>
              </div>
              <p className="text-sm text-red-600 dark:text-red-400 mt-1">{publishError}</p>
            </div>
          )}

          <CatalogBuilderPanel
            namespace={namespace}
            onNamespaceChange={setNamespace}
            onPublishCatalog={handlePublishCatalog}
          />
        </>
      )}

      {/* Subscribe Mode */}
      {mode === 'subscribe' && (
        <div className="panel">
          <div className="panel-header">Subscribe to Catalog</div>
          <div className="panel-body space-y-4">
            <div>
              <label className="label">Catalog Namespace</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={namespace}
                  onChange={(e) => setNamespace(e.target.value)}
                  placeholder="conference/room-1/media"
                  className="input flex-1"
                />
                <button
                  disabled={sessionState !== 'ready'}
                  className="btn-primary"
                >
                  Subscribe
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Subscribe to receive the catalog and auto-discover tracks
              </p>
            </div>

            {/* Placeholder for received catalog display */}
            <div className="text-center py-8 text-gray-500">
              <svg className="w-12 h-12 mx-auto mb-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              <p>No catalog subscribed</p>
              <p className="text-sm">Enter a namespace and subscribe to view catalog</p>
            </div>
          </div>
        </div>
      )}

      {/* Info Panel */}
      <div className="panel">
        <div className="panel-header">About MSF Catalogs</div>
        <div className="panel-body text-sm text-gray-600 dark:text-gray-400 space-y-2">
          <p>
            <strong>MSF (MOQT Streaming Format)</strong> catalogs describe available media tracks
            for a session, including codec, resolution, bitrate, and experience profile information.
          </p>
          <p>
            <strong>For VOD/DVR:</strong> Publisher creates catalog with VOD and live tracks.
            Subscribers receive the catalog and can seek/rewind VOD content.
          </p>
          <p>
            <strong>For Conferencing:</strong> Catalog defines the room template (track types, codecs).
            All participants follow the template when publishing their media.
          </p>
        </div>
      </div>
    </div>
  );
};
