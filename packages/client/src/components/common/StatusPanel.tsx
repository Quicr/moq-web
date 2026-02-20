// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Status Panel Component
 *
 * Displays connection status, MOQT version, and control message errors.
 */

import React from 'react';
import { useStore } from '../../store';

// Get MOQT version display info
const getMoqtVersionInfo = () => {
  const version = __MOQT_VERSION__;
  switch (version) {
    case 'draft-16':
      return { label: 'Draft-16', color: 'bg-purple-500', textColor: 'text-purple-700 dark:text-purple-300' };
    case 'draft-14':
    default:
      return { label: 'Draft-14', color: 'bg-blue-500', textColor: 'text-blue-700 dark:text-blue-300' };
  }
};

export const StatusPanel: React.FC = () => {
  const { state, sessionState, error, serverUrl, useWorkers } = useStore();
  const versionInfo = getMoqtVersionInfo();

  // Determine status color
  const getStatusColor = () => {
    if (error) return 'bg-red-500';
    if (state === 'connected' && sessionState === 'ready') return 'bg-green-500';
    if (state === 'connecting' || sessionState === 'setup') return 'bg-yellow-500';
    return 'bg-gray-500';
  };

  // Determine status text
  const getStatusText = () => {
    if (error) return 'Error';
    if (state === 'connected' && sessionState === 'ready') return 'Connected';
    if (state === 'connecting') return 'Connecting...';
    if (sessionState === 'setup') return 'Setting up session...';
    return 'Disconnected';
  };

  return (
    <div className="panel">
      <div className="panel-header flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span>Status</span>
          <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${versionInfo.color} text-white`}>
            {versionInfo.label}
          </span>
          <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${useWorkers ? 'bg-green-500' : 'bg-gray-400'} text-white`}>
            {useWorkers ? 'Workers' : 'Main Thread'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${getStatusColor()}`} />
          <span className="text-xs font-normal">{getStatusText()}</span>
        </div>
      </div>
      <div className="panel-body">
        {/* Connection info */}
        {state === 'connected' && (
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            {serverUrl}
          </div>
        )}

        {/* Error display */}
        {error && (
          <div className="p-3 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-md text-sm">
            <div className="font-medium mb-1">MOQT Error</div>
            <div>{error}</div>
          </div>
        )}

        {/* No error - show success state */}
        {!error && state === 'connected' && sessionState === 'ready' && (
          <div className="p-2 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 rounded-md text-xs">
            Session ready. You can publish or subscribe to tracks.
          </div>
        )}

        {/* Disconnected state */}
        {!error && state === 'disconnected' && (
          <div className="p-2 bg-gray-100 dark:bg-gray-900/30 text-gray-500 dark:text-gray-400 rounded-md text-xs">
            Not connected. Enter a relay URL and click Connect.
          </div>
        )}
      </div>
    </div>
  );
};
