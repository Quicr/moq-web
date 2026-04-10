// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Developer Settings Panel
 *
 * Debug settings panel that shows only when ?debug=1 is in the URL.
 * Provides access to log level controls and other developer options.
 */

import React from 'react';
import { useStore } from '../../store';
import { LogLevel } from '../../types';
import { VarIntType } from '@web-moq/core';

/**
 * Check if debug mode is enabled via query parameter
 */
export function isDebugMode(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return params.get('debug') === '1';
}

export const DevSettingsPanel: React.FC = () => {
  const { logLevel, setLogLevel, useAnnounceFlow, setUseAnnounceFlow, enableStats, setEnableStats, varIntType, setVarIntType } = useStore();
  const [isExpanded, setIsExpanded] = React.useState(true);

  // Don't render if not in debug mode
  if (!isDebugMode()) {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <div className="bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-300 dark:border-yellow-700 rounded-lg shadow-lg overflow-hidden max-w-xs">
        {/* Header */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full px-4 py-2 flex items-center justify-between bg-yellow-100 dark:bg-yellow-800/50 hover:bg-yellow-200 dark:hover:bg-yellow-800/70 transition-colors"
        >
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-yellow-600 dark:text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span className="text-sm font-semibold text-yellow-800 dark:text-yellow-200">
              Dev Settings
            </span>
          </div>
          <svg
            className={`w-4 h-4 text-yellow-600 dark:text-yellow-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {/* Content */}
        {isExpanded && (
          <div className="p-4 space-y-4">
            {/* Log Level */}
            <div>
              <label className="block text-xs font-medium text-yellow-800 dark:text-yellow-200 mb-1">
                Log Level
              </label>
              <select
                value={logLevel}
                onChange={(e) => setLogLevel(Number(e.target.value) as LogLevel)}
                className="input w-full py-1.5 text-sm border-yellow-300 dark:border-yellow-600 focus:ring-yellow-500"
              >
                <option value={LogLevel.TRACE}>Trace (verbose)</option>
                <option value={LogLevel.DEBUG}>Debug</option>
                <option value={LogLevel.INFO}>Info</option>
                <option value={LogLevel.WARN}>Warning</option>
                <option value={LogLevel.ERROR}>Error (default)</option>
                <option value={LogLevel.SILENT}>Silent</option>
              </select>
              <p className="mt-1 text-xs text-yellow-600 dark:text-yellow-400">
                Check browser console for logs
              </p>
            </div>

            {/* Announce Flow Toggle */}
            <div>
              <label className="flex items-center justify-between">
                <span className="text-xs font-medium text-yellow-800 dark:text-yellow-200">
                  Use Announce Flow
                </span>
                <button
                  onClick={() => setUseAnnounceFlow(!useAnnounceFlow)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                    useAnnounceFlow ? 'bg-yellow-500' : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                      useAnnounceFlow ? 'translate-x-5' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
              <p className="mt-1 text-xs text-yellow-600 dark:text-yellow-400">
                Use PUBLISH_NAMESPACE instead of PUBLISH
              </p>
            </div>

            {/* Network Stats Toggle */}
            <div>
              <label className="flex items-center justify-between">
                <span className="text-xs font-medium text-yellow-800 dark:text-yellow-200">
                  Enable Network Stats
                </span>
                <button
                  onClick={() => setEnableStats(!enableStats)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                    enableStats ? 'bg-yellow-500' : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                      enableStats ? 'translate-x-5' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
              <p className="mt-1 text-xs text-yellow-600 dark:text-yellow-400">
                Show jitter graph under subscriptions
              </p>
            </div>

            {/* VarInt Type Toggle */}
            <div>
              <label className="flex items-center justify-between">
                <span className="text-xs font-medium text-yellow-800 dark:text-yellow-200">
                  MOQT VarInt Encoding
                </span>
                <button
                  onClick={() => setVarIntType(varIntType === VarIntType.MOQT ? VarIntType.QUIC : VarIntType.MOQT)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                    varIntType === VarIntType.MOQT ? 'bg-yellow-500' : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                      varIntType === VarIntType.MOQT ? 'translate-x-5' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
              <p className="mt-1 text-xs text-yellow-600 dark:text-yellow-400">
                {varIntType === VarIntType.MOQT ? 'Using MOQT varint (1.4.1)' : 'Using QUIC varint (RFC 9000)'}
              </p>
            </div>

            {/* Debug Info */}
            <div className="pt-2 border-t border-yellow-200 dark:border-yellow-700">
              <p className="text-xs text-yellow-600 dark:text-yellow-400">
                Debug mode enabled via <code className="bg-yellow-100 dark:bg-yellow-800 px-1 rounded">?debug=1</code>
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
