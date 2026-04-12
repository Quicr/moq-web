// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Standalone Fetch Panel Component
 *
 * Interface for testing FETCH functionality independently of the catalog-driven flow.
 * Allows fetching previously published content from a relay's cache.
 */

import React, { useState, useCallback, useRef } from 'react';
import { useStore } from '../../store';

interface FetchStats {
  requestId: number;
  objectsReceived: number;
  bytesReceived: number;
  groupsReceived: Set<number>;
  startTime: number;
  lastUpdateTime: number;
  status: 'fetching' | 'complete' | 'error' | 'cancelled';
  error?: string;
}

interface FetchResult {
  groupId: number;
  objectId: number;
  size: number;
  timestamp: number;
}

export const FetchPanel: React.FC = () => {
  const { session, sessionState, fetchTrack } = useStore();

  // Form state
  const [namespace, setNamespace] = useState('dvr21');
  const [trackName, setTrackName] = useState('vod-video');
  const [startGroup, setStartGroup] = useState(0);
  const [endGroup, setEndGroup] = useState(5);

  // Fetch state
  const [activeFetches, setActiveFetches] = useState<Map<number, FetchStats>>(new Map());
  const [results, setResults] = useState<FetchResult[]>([]);
  const cancelFnRef = useRef<Map<number, () => Promise<void>>>(new Map());

  // Max results to display
  const maxResults = 100;

  const handleFetch = useCallback(async () => {
    if (!session || sessionState !== 'ready') {
      console.error('[FetchPanel] Session not ready');
      return;
    }

    try {
      console.log('[FetchPanel] Starting FETCH', { namespace, trackName, startGroup, endGroup });

      const { requestId, cancel } = await fetchTrack(
        namespace,
        trackName,
        startGroup,
        endGroup,
        (data: Uint8Array, groupId: number, objectId: number) => {
          const timestamp = performance.now();

          // Update stats
          setActiveFetches(prev => {
            const newMap = new Map(prev);
            const stats = newMap.get(requestId);
            if (stats) {
              stats.objectsReceived++;
              stats.bytesReceived += data.length;
              stats.groupsReceived.add(groupId);
              stats.lastUpdateTime = timestamp;
            }
            return newMap;
          });

          // Add to results (limited)
          setResults(prev => {
            const newResult: FetchResult = {
              groupId,
              objectId,
              size: data.length,
              timestamp,
            };
            const updated = [...prev, newResult];
            if (updated.length > maxResults) {
              return updated.slice(-maxResults);
            }
            return updated;
          });

          console.log('[FetchPanel] Received object', {
            requestId,
            groupId,
            objectId,
            size: data.length,
          });
        }
      );

      // Store cancel function
      cancelFnRef.current.set(requestId, cancel);

      // Initialize stats
      const initialStats: FetchStats = {
        requestId,
        objectsReceived: 0,
        bytesReceived: 0,
        groupsReceived: new Set(),
        startTime: performance.now(),
        lastUpdateTime: performance.now(),
        status: 'fetching',
      };

      setActiveFetches(prev => {
        const newMap = new Map(prev);
        newMap.set(requestId, initialStats);
        return newMap;
      });

      console.log('[FetchPanel] FETCH started', { requestId });

    } catch (err) {
      console.error('[FetchPanel] FETCH error', err);
    }
  }, [session, sessionState, fetchTrack, namespace, trackName, startGroup, endGroup]);

  const handleCancel = useCallback(async (requestId: number) => {
    const cancelFn = cancelFnRef.current.get(requestId);
    if (cancelFn) {
      try {
        await cancelFn();
        setActiveFetches(prev => {
          const newMap = new Map(prev);
          const stats = newMap.get(requestId);
          if (stats) {
            stats.status = 'cancelled';
          }
          return newMap;
        });
        cancelFnRef.current.delete(requestId);
      } catch (err) {
        console.error('[FetchPanel] Cancel error', err);
      }
    }
  }, []);

  const handleClearResults = useCallback(() => {
    setResults([]);
    setActiveFetches(new Map());
    cancelFnRef.current.clear();
  }, []);

  const isConnected = sessionState === 'ready';

  return (
    <div className="p-4 bg-gray-800 rounded-lg">
      <h2 className="text-xl font-bold text-white mb-4">Standalone FETCH Test</h2>

      {/* Connection status */}
      <div className="mb-4">
        <span className={`inline-block w-3 h-3 rounded-full mr-2 ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
        <span className="text-gray-300">{isConnected ? 'Connected' : 'Not Connected'}</span>
      </div>

      {/* Form */}
      <div className="space-y-3 mb-4">
        <div>
          <label className="block text-sm text-gray-400 mb-1">Namespace</label>
          <input
            type="text"
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
            className="w-full px-3 py-2 bg-gray-700 text-white rounded border border-gray-600 focus:border-blue-500 focus:outline-none"
            placeholder="e.g., dvr21"
          />
        </div>

        <div>
          <label className="block text-sm text-gray-400 mb-1">Track Name</label>
          <input
            type="text"
            value={trackName}
            onChange={(e) => setTrackName(e.target.value)}
            className="w-full px-3 py-2 bg-gray-700 text-white rounded border border-gray-600 focus:border-blue-500 focus:outline-none"
            placeholder="e.g., vod-video"
          />
        </div>

        <div className="flex space-x-3">
          <div className="flex-1">
            <label className="block text-sm text-gray-400 mb-1">Start Group</label>
            <input
              type="number"
              value={startGroup}
              onChange={(e) => setStartGroup(parseInt(e.target.value) || 0)}
              className="w-full px-3 py-2 bg-gray-700 text-white rounded border border-gray-600 focus:border-blue-500 focus:outline-none"
              min={0}
            />
          </div>
          <div className="flex-1">
            <label className="block text-sm text-gray-400 mb-1">End Group</label>
            <input
              type="number"
              value={endGroup}
              onChange={(e) => setEndGroup(parseInt(e.target.value) || 0)}
              className="w-full px-3 py-2 bg-gray-700 text-white rounded border border-gray-600 focus:border-blue-500 focus:outline-none"
              min={0}
            />
          </div>
        </div>

        <div className="flex space-x-2">
          <button
            onClick={handleFetch}
            disabled={!isConnected}
            className={`flex-1 px-4 py-2 rounded font-medium ${
              isConnected
                ? 'bg-blue-600 hover:bg-blue-700 text-white'
                : 'bg-gray-600 text-gray-400 cursor-not-allowed'
            }`}
          >
            Start FETCH
          </button>
          <button
            onClick={handleClearResults}
            className="px-4 py-2 rounded font-medium bg-gray-600 hover:bg-gray-500 text-white"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Active Fetches */}
      {activeFetches.size > 0 && (
        <div className="mb-4">
          <h3 className="text-lg font-semibold text-white mb-2">Active Fetches</h3>
          <div className="space-y-2">
            {Array.from(activeFetches.entries()).map(([reqId, stats]) => (
              <div key={reqId} className="p-3 bg-gray-700 rounded">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-white font-medium">Request #{reqId}</span>
                  <span className={`text-sm px-2 py-1 rounded ${
                    stats.status === 'fetching' ? 'bg-blue-600' :
                    stats.status === 'complete' ? 'bg-green-600' :
                    stats.status === 'cancelled' ? 'bg-yellow-600' :
                    'bg-red-600'
                  }`}>
                    {stats.status}
                  </span>
                </div>
                <div className="text-sm text-gray-300 space-y-1">
                  <div>Objects: {stats.objectsReceived}</div>
                  <div>Bytes: {(stats.bytesReceived / 1024).toFixed(2)} KB</div>
                  <div>Groups: {stats.groupsReceived.size} ({Array.from(stats.groupsReceived).sort((a, b) => a - b).join(', ')})</div>
                  <div>Duration: {((stats.lastUpdateTime - stats.startTime) / 1000).toFixed(2)}s</div>
                </div>
                {stats.status === 'fetching' && (
                  <button
                    onClick={() => handleCancel(reqId)}
                    className="mt-2 px-3 py-1 text-sm rounded bg-red-600 hover:bg-red-700 text-white"
                  >
                    Cancel
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-white mb-2">
            Received Objects ({results.length})
          </h3>
          <div className="max-h-60 overflow-y-auto bg-gray-900 rounded p-2">
            <table className="w-full text-sm">
              <thead className="text-gray-400">
                <tr>
                  <th className="text-left py-1 px-2">Group</th>
                  <th className="text-left py-1 px-2">Object</th>
                  <th className="text-left py-1 px-2">Size</th>
                </tr>
              </thead>
              <tbody className="text-gray-300">
                {results.slice(-20).map((result, idx) => (
                  <tr key={idx} className="border-t border-gray-800">
                    <td className="py-1 px-2">{result.groupId}</td>
                    <td className="py-1 px-2">{result.objectId}</td>
                    <td className="py-1 px-2">{result.size} bytes</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {results.length > 20 && (
              <div className="text-center text-gray-500 text-xs py-1">
                Showing last 20 of {results.length} objects
              </div>
            )}
          </div>
        </div>
      )}

      {/* Help text */}
      <div className="mt-4 text-sm text-gray-500">
        <p>Use this panel to test FETCH requests independently of the catalog flow.</p>
        <p className="mt-1">The relay must have cached content for the specified track and group range.</p>
      </div>
    </div>
  );
};
