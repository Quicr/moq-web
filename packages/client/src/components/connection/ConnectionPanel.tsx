// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Connection Panel Component
 *
 * Provides server URL input and connect/disconnect controls.
 * Glassmorphic design with glow effects on connection state.
 */

import React, { useState } from 'react';
import { useStore } from '../../store';

export const ConnectionPanel: React.FC = () => {
  const { serverUrl, state, error, connect, disconnect, setServerUrl, localDevelopment, setLocalDevelopment, useWorkers, setUseWorkers } = useStore();
  const [inputUrl, setInputUrl] = useState(serverUrl);

  const isConnecting = state === 'connecting';
  const isConnected = state === 'connected';

  const handleConnect = async () => {
    try {
      await connect(inputUrl);
    } catch (err) {
      // Error is handled in store
    }
  };

  const handleDisconnect = async () => {
    await disconnect();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isConnected && !isConnecting) {
      handleConnect();
    }
  };

  // Toggle switch component
  const Toggle: React.FC<{
    id: string;
    checked: boolean;
    onChange: () => void;
    disabled?: boolean;
  }> = ({ id, checked, onChange, disabled }) => (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-all duration-200 ${
        checked
          ? 'bg-gradient-to-r from-accent-purple to-primary-500'
          : 'bg-white/10'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-lg transition-transform duration-200 ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );

  return (
    <div className={`glass-panel ${isConnected ? 'border-emerald-500/30' : ''}`}>
      <div className="glass-panel-header">
        <svg className="w-5 h-5 text-accent-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
        </svg>
        Connection
        {isConnected && (
          <span className="ml-auto flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" style={{ boxShadow: '0 0 8px rgba(52, 211, 153, 0.6)' }} />
            <span className="text-xs font-normal text-emerald-400">Live</span>
          </span>
        )}
      </div>

      <div className="glass-panel-body space-y-4">
        <div>
          <label htmlFor="serverUrl" className="label">
            Relay URL
          </label>
          <input
            id="serverUrl"
            type="text"
            value={inputUrl}
            onChange={(e) => {
              setInputUrl(e.target.value);
              setServerUrl(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder="https://relay.example.com/moq"
            className="input"
            disabled={isConnected || isConnecting}
          />
        </div>

        <div className="flex items-center justify-between">
          <label htmlFor="localDev" className="text-sm text-tertiary">
            Local Development
          </label>
          <Toggle
            id="localDev"
            checked={localDevelopment}
            onChange={() => setLocalDevelopment(!localDevelopment)}
            disabled={isConnected || isConnecting}
          />
        </div>
        <p className="text-xs text-subtle -mt-2">
          Enable for self-signed certificates
        </p>

        <div className="flex items-center justify-between">
          <label htmlFor="useWorkers" className="text-sm text-tertiary">
            Web Workers
          </label>
          <Toggle
            id="useWorkers"
            checked={useWorkers}
            onChange={() => setUseWorkers(!useWorkers)}
            disabled={isConnected || isConnecting}
          />
        </div>
        <p className="text-xs text-subtle -mt-2">
          Offload encoding/decoding to background threads
        </p>

        {error && (
          <div className="glass-panel-subtle p-3 border-red-500/30">
            <div className="flex items-center gap-2 text-red-400 text-sm">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="truncate">{error}</span>
            </div>
          </div>
        )}

        <div className="pt-2">
          {!isConnected ? (
            <button
              onClick={handleConnect}
              disabled={isConnecting || !inputUrl}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              {isConnecting ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Connecting...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  Connect
                </>
              )}
            </button>
          ) : (
            <button
              onClick={handleDisconnect}
              className="btn-danger w-full flex items-center justify-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              Disconnect
            </button>
          )}
        </div>

        {/* Connection Info */}
        {isConnected && (
          <div className="glass-panel-subtle p-3 flex items-center gap-2">
            <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-sm text-emerald-300">Connected to relay</span>
          </div>
        )}
      </div>
    </div>
  );
};
