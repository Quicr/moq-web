// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Connection Status Indicator
 *
 * Visual indicator showing current connection state.
 */

import React from 'react';
import { useStore } from '../../store';
import { TransportState } from '../../types';

const statusConfig: Record<TransportState, { color: string; text: string; pulse: boolean }> = {
  disconnected: {
    color: 'bg-gray-400',
    text: 'Disconnected',
    pulse: false,
  },
  connecting: {
    color: 'bg-yellow-500',
    text: 'Connecting',
    pulse: true,
  },
  connected: {
    color: 'bg-green-500',
    text: 'Connected',
    pulse: false,
  },
  closing: {
    color: 'bg-yellow-500',
    text: 'Closing',
    pulse: true,
  },
  closed: {
    color: 'bg-gray-400',
    text: 'Closed',
    pulse: false,
  },
  failed: {
    color: 'bg-red-500',
    text: 'Failed',
    pulse: false,
  },
};

export const ConnectionStatus: React.FC = () => {
  const { state } = useStore();

  const config = statusConfig[state] || statusConfig.disconnected;

  return (
    <div className="flex items-center gap-2">
      <span
        className={`w-2 h-2 rounded-full ${config.color} ${
          config.pulse ? 'animate-pulse' : ''
        }`}
      />
      <span className="text-sm text-gray-500 dark:text-gray-400">
        {config.text}
      </span>
    </div>
  );
};
