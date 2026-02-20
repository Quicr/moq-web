// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Settings Panel Component
 *
 * Application settings including theme, codec settings, and delivery options.
 */

import React from 'react';
import { useStore } from '../../store';
import { LogLevel } from '../../types';
import { VarIntType } from '@web-moq/core';

export const SettingsPanel: React.FC = () => {
  const {
    theme,
    setTheme,
    logLevel,
    setLogLevel,
    videoBitrate,
    setVideoBitrate,
    audioBitrate,
    setAudioBitrate,
    videoResolution,
    setVideoResolution,
    deliveryMode,
    setDeliveryMode,
    useAnnounceFlow,
    setUseAnnounceFlow,
    enableStats,
    setEnableStats,
    varIntType,
    setVarIntType,
  } = useStore();

  return (
    <div className="p-4 space-y-6">
      {/* Appearance */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
          Appearance
        </h3>
        <div className="space-y-3">
          <div>
            <label className="label">Theme</label>
            <select
              value={theme}
              onChange={(e) => setTheme(e.target.value as 'light' | 'dark' | 'system')}
              className="input"
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
        </div>
      </div>

      {/* Video Settings */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
          Video Settings
        </h3>
        <div className="space-y-3">
          <div>
            <label className="label">Resolution</label>
            <select
              value={videoResolution}
              onChange={(e) => setVideoResolution(e.target.value as '720p' | '1080p' | '480p')}
              className="input"
            >
              <option value="480p">480p (854x480)</option>
              <option value="720p">720p (1280x720)</option>
              <option value="1080p">1080p (1920x1080)</option>
            </select>
          </div>
          <div>
            <label className="label">
              Video Bitrate: {(videoBitrate / 1_000_000).toFixed(1)} Mbps
            </label>
            <input
              type="range"
              min="500000"
              max="8000000"
              step="500000"
              value={videoBitrate}
              onChange={(e) => setVideoBitrate(Number(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>0.5 Mbps</span>
              <span>8 Mbps</span>
            </div>
          </div>
        </div>
      </div>

      {/* Audio Settings */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
          Audio Settings
        </h3>
        <div>
          <label className="label">
            Audio Bitrate: {audioBitrate / 1000} kbps
          </label>
          <select
            value={audioBitrate}
            onChange={(e) => setAudioBitrate(Number(e.target.value))}
            className="input"
          >
            <option value="64000">64 kbps</option>
            <option value="96000">96 kbps</option>
            <option value="128000">128 kbps</option>
            <option value="192000">192 kbps</option>
            <option value="256000">256 kbps</option>
          </select>
        </div>
      </div>

      {/* Delivery Settings */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
          Delivery Settings
        </h3>
        <div className="space-y-4">
          <div>
            <label className="label">Delivery Mode</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setDeliveryMode('stream')}
                className={`p-3 rounded-md border text-left ${
                  deliveryMode === 'stream'
                    ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/30'
                    : 'border-gray-200 dark:border-gray-700'
                }`}
              >
                <div className="font-medium text-sm">Stream</div>
                <div className="text-xs text-gray-500 mt-1">
                  Reliable, ordered delivery
                </div>
              </button>
              <button
                onClick={() => setDeliveryMode('datagram')}
                className={`p-3 rounded-md border text-left ${
                  deliveryMode === 'datagram'
                    ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/30'
                    : 'border-gray-200 dark:border-gray-700'
                }`}
              >
                <div className="font-medium text-sm">Datagram</div>
                <div className="text-xs text-gray-500 mt-1">
                  Low-latency, best-effort
                </div>
              </button>
            </div>
          </div>

          {/* Use Announce Flow Toggle */}
          <div>
            <label className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Use Announce Flow
                </span>
                <p className="text-xs text-gray-500 mt-0.5">
                  Use PUBLISH_NAMESPACE instead of PUBLISH
                </p>
              </div>
              <button
                onClick={() => setUseAnnounceFlow(!useAnnounceFlow)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  useAnnounceFlow ? 'bg-primary-500' : 'bg-gray-300 dark:bg-gray-600'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    useAnnounceFlow ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </label>
          </div>

          {/* Enable Network Stats Toggle */}
          <div>
            <label className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Enable Network Stats
                </span>
                <p className="text-xs text-gray-500 mt-0.5">
                  Show jitter graph under subscriptions
                </p>
              </div>
              <button
                onClick={() => setEnableStats(!enableStats)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  enableStats ? 'bg-primary-500' : 'bg-gray-300 dark:bg-gray-600'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    enableStats ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </label>
          </div>

          {/* MOQT VarInt Encoding Toggle */}
          <div>
            <label className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  MOQT VarInt Encoding
                </span>
                <p className="text-xs text-gray-500 mt-0.5">
                  {varIntType === VarIntType.MOQT
                    ? 'Using MOQT varint (Section 1.4.1)'
                    : 'Using QUIC varint (RFC 9000)'}
                </p>
              </div>
              <button
                onClick={() => setVarIntType(varIntType === VarIntType.MOQT ? VarIntType.QUIC : VarIntType.MOQT)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  varIntType === VarIntType.MOQT ? 'bg-primary-500' : 'bg-gray-300 dark:bg-gray-600'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    varIntType === VarIntType.MOQT ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </label>
          </div>
        </div>
      </div>

      {/* Debug Settings */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
          Debug
        </h3>
        <div>
          <label className="label">Log Level</label>
          <select
            value={logLevel}
            onChange={(e) => setLogLevel(Number(e.target.value) as LogLevel)}
            className="input"
          >
            <option value={LogLevel.TRACE}>Trace</option>
            <option value={LogLevel.DEBUG}>Debug</option>
            <option value={LogLevel.INFO}>Info</option>
            <option value={LogLevel.WARN}>Warning</option>
            <option value={LogLevel.ERROR}>Error</option>
            <option value={LogLevel.SILENT}>Silent</option>
          </select>
        </div>
      </div>

      {/* About */}
      <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
        <div className="text-center text-xs text-gray-500">
          <p className="font-medium">MOQT Client v0.1.0</p>
          <p className="mt-1">Media over QUIC Transport</p>
        </div>
      </div>
    </div>
  );
};
