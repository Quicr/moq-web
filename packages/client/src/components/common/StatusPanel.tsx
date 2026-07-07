// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Status Panel Component
 *
 * Displays connection status, MOQT version, and control message errors.
 * Glassmorphic design with status-aware styling.
 */

import React from 'react';
import { useStore } from '../../store';

// Get MOQT version display info
const getMoqtVersionInfo = () => {
  const version = __MOQT_VERSION__;
  switch (version) {
    case 'draft-16':
      return { label: 'Draft-16', className: 'badge-purple' };
    case 'draft-14':
    default:
      return { label: 'Draft-14', className: 'badge-blue' };
  }
};

export const StatusPanel: React.FC = () => {
  const { state, sessionState, error, serverUrl, useWorkers } = useStore();
  const versionInfo = getMoqtVersionInfo();

  // Determine status indicator
  const getStatusIndicator = () => {
    if (error) return { color: 'bg-red-400', glow: 'rgba(248, 113, 113, 0.6)', text: 'Error', textColor: 'text-red-400' };
    if (state === 'connected' && sessionState === 'ready') return { color: 'bg-emerald-400', glow: 'rgba(52, 211, 153, 0.6)', text: 'Connected', textColor: 'text-emerald-400' };
    if (state === 'connecting' || sessionState === 'setup') return { color: 'bg-amber-400', glow: 'rgba(251, 191, 36, 0.6)', text: 'Connecting...', textColor: 'text-amber-400', pulse: true };
    return { color: 'bg-gray-400 dark:bg-white/30', glow: 'transparent', text: 'Disconnected', textColor: 'text-muted' };
  };

  const status = getStatusIndicator();

  return (
    <div className="glass-panel">
      <div className="glass-panel-header justify-between">
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-accent-purple" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
          Status
        </div>
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${status.color} ${status.pulse ? 'animate-pulse' : ''}`}
            style={{ boxShadow: `0 0 8px ${status.glow}` }}
          />
          <span className={`text-xs font-medium ${status.textColor}`}>{status.text}</span>
        </div>
      </div>

      <div className="glass-panel-body space-y-3">
        {/* Badges row */}
        <div className="flex flex-wrap gap-2">
          <span className={versionInfo.className}>{versionInfo.label}</span>
          <span className={useWorkers ? 'badge-green' : 'badge'}>
            {useWorkers ? 'Workers' : 'Main Thread'}
          </span>
        </div>

        {/* Connection info */}
        {state === 'connected' && (
          <div className="text-xs text-subtle truncate">
            {serverUrl}
          </div>
        )}

        {/* Error display */}
        {error && (
          <div className="glass-panel-subtle p-3 border-red-500/30">
            <div className="text-red-300 font-medium text-sm mb-1">MOQT Error</div>
            <div className="text-red-400/70 text-xs">{error}</div>
          </div>
        )}

        {/* Success state */}
        {!error && state === 'connected' && sessionState === 'ready' && (
          <div className="glass-panel-subtle p-3 flex items-center gap-2">
            <svg className="w-4 h-4 text-emerald-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-xs text-tertiary">
              Session ready. Publish or subscribe to tracks.
            </span>
          </div>
        )}

        {/* Disconnected state */}
        {!error && state === 'disconnected' && (
          <div className="glass-panel-subtle p-3 flex items-center gap-2">
            <svg className="w-4 h-4 text-hint flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-xs text-subtle">
              Configure settings, then connect when ready.
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
