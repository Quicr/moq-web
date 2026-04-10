// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Connection Status Indicator
 *
 * Visual indicator showing current connection state with glow effects.
 */

import React from 'react';
import { useStore } from '../../store';
import { TransportState } from '../../types';

interface StatusConfig {
  color: string;
  glow: string;
  text: string;
  textColor: string;
  pulse: boolean;
}

const statusConfig: Record<TransportState, StatusConfig> = {
  disconnected: {
    color: 'bg-white/30',
    glow: 'transparent',
    text: 'Offline',
    textColor: 'text-white/40',
    pulse: false,
  },
  connecting: {
    color: 'bg-amber-400',
    glow: 'rgba(251, 191, 36, 0.5)',
    text: 'Connecting',
    textColor: 'text-amber-400',
    pulse: true,
  },
  connected: {
    color: 'bg-emerald-400',
    glow: 'rgba(52, 211, 153, 0.5)',
    text: 'Connected',
    textColor: 'text-emerald-400',
    pulse: false,
  },
  closing: {
    color: 'bg-amber-400',
    glow: 'rgba(251, 191, 36, 0.5)',
    text: 'Closing',
    textColor: 'text-amber-400',
    pulse: true,
  },
  closed: {
    color: 'bg-white/30',
    glow: 'transparent',
    text: 'Closed',
    textColor: 'text-white/40',
    pulse: false,
  },
  failed: {
    color: 'bg-red-400',
    glow: 'rgba(248, 113, 113, 0.5)',
    text: 'Failed',
    textColor: 'text-red-400',
    pulse: false,
  },
};

export const ConnectionStatus: React.FC = () => {
  const { state } = useStore();

  const config = statusConfig[state] || statusConfig.disconnected;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5">
      <span
        className={`w-2 h-2 rounded-full ${config.color} ${config.pulse ? 'animate-pulse' : ''}`}
        style={{ boxShadow: `0 0 8px ${config.glow}` }}
      />
      <span className={`text-xs font-medium ${config.textColor}`}>
        {config.text}
      </span>
    </div>
  );
};
