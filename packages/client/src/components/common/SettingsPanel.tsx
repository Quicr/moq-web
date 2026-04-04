// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Settings Panel Component
 *
 * Application settings including theme, codec settings, and delivery options.
 */

import React, { useState } from 'react';
import { useStore } from '../../store';
import { LogLevel } from '../../types';
import { VarIntType } from '@web-moq/core';

export const SettingsPanel: React.FC = () => {
  const [showAdvancedJitter, setShowAdvancedJitter] = useState(false);

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
    jitterBufferDelay,
    setJitterBufferDelay,
    varIntType,
    setVarIntType,
    vadEnabled,
    setVadEnabled,
    vadProvider,
    setVadProvider,
    vadVisualizationEnabled,
    setVadVisualizationEnabled,
    audioDeliveryMode,
    setAudioDeliveryMode,
    useGroupArbiter,
    setUseGroupArbiter,
    maxLatency,
    setMaxLatency,
    estimatedGopDuration,
    setEstimatedGopDuration,
    skipToLatestGroup,
    setSkipToLatestGroup,
    skipGraceFrames,
    setSkipGraceFrames,
    enableCatchUp,
    setEnableCatchUp,
    catchUpThreshold,
    setCatchUpThreshold,
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

      {/* Voice Activity Detection */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
          Voice Activity Detection
        </h3>
        <div className="space-y-4">
          {/* Enable VAD Toggle */}
          <div>
            <label className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Enable VAD
                </span>
                <p className="text-xs text-gray-500 mt-0.5">
                  Detect voice activity for active speaker switching
                </p>
              </div>
              <button
                onClick={() => setVadEnabled(!vadEnabled)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  vadEnabled ? 'bg-primary-500' : 'bg-gray-300 dark:bg-gray-600'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    vadEnabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </label>
          </div>

          {/* VAD Provider Selection */}
          {vadEnabled && (
            <>
              <div>
                <label className="label">VAD Provider</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setVadProvider('libfvad')}
                    className={`p-3 rounded-md border text-left ${
                      vadProvider === 'libfvad'
                        ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/30'
                        : 'border-gray-200 dark:border-gray-700'
                    }`}
                  >
                    <div className="font-medium text-sm">libfvad</div>
                    <div className="text-xs text-gray-500 mt-1">
                      WebRTC VAD, low CPU
                    </div>
                  </button>
                  <button
                    onClick={() => setVadProvider('silero')}
                    className={`p-3 rounded-md border text-left ${
                      vadProvider === 'silero'
                        ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/30'
                        : 'border-gray-200 dark:border-gray-700'
                    }`}
                  >
                    <div className="font-medium text-sm">Silero</div>
                    <div className="text-xs text-gray-500 mt-1">
                      Neural network, higher accuracy
                    </div>
                  </button>
                </div>
              </div>

              {/* VAD Visualization Toggle */}
              <div>
                <label className="flex items-center justify-between">
                  <div>
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                      Show VAD Visualization
                    </span>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Display audio bars indicator (uses more CPU)
                    </p>
                  </div>
                  <button
                    onClick={() => setVadVisualizationEnabled(!vadVisualizationEnabled)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      vadVisualizationEnabled ? 'bg-primary-500' : 'bg-gray-300 dark:bg-gray-600'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        vadVisualizationEnabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </label>
              </div>
            </>
          )}
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

          {/* Audio Delivery Mode (only shown when main mode is stream) */}
          {deliveryMode === 'stream' && (
            <div>
              <label className="label">Audio Delivery</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setAudioDeliveryMode('datagram')}
                  className={`p-3 rounded-md border text-left ${
                    audioDeliveryMode === 'datagram'
                      ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/30'
                      : 'border-gray-200 dark:border-gray-700'
                  }`}
                >
                  <div className="font-medium text-sm">Datagram</div>
                  <div className="text-xs text-gray-500 mt-1">
                    Low-latency (default)
                  </div>
                </button>
                <button
                  onClick={() => setAudioDeliveryMode('stream')}
                  className={`p-3 rounded-md border text-left ${
                    audioDeliveryMode === 'stream'
                      ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/30'
                      : 'border-gray-200 dark:border-gray-700'
                  }`}
                >
                  <div className="font-medium text-sm">Stream</div>
                  <div className="text-xs text-gray-500 mt-1">
                    Reliable, ordered
                  </div>
                </button>
              </div>
            </div>
          )}

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

          {/* Jitter Buffer Delay */}
          <div>
            <label className="label">
              Jitter Buffer: {jitterBufferDelay}ms
            </label>
            <input
              type="range"
              min="50"
              max="300"
              step="10"
              value={jitterBufferDelay}
              onChange={(e) => setJitterBufferDelay(Number(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>50ms (low latency)</span>
              <span>300ms (smooth)</span>
            </div>
          </div>

          {/* Advanced Jitter Buffer Settings (collapsible) */}
          <div className="border border-gray-200 dark:border-gray-700 rounded-md">
            <button
              onClick={() => setShowAdvancedJitter(!showAdvancedJitter)}
              className="w-full flex items-center justify-between p-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800 rounded-md transition-colors"
            >
              <div>
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Advanced Jitter Settings
                </span>
                <p className="text-xs text-gray-500 mt-0.5">
                  Group-aware buffering for parallel streams
                </p>
              </div>
              <svg
                className={`w-5 h-5 text-gray-500 transition-transform ${showAdvancedJitter ? 'rotate-180' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {showAdvancedJitter && (
              <div className="p-3 pt-0 space-y-4 border-t border-gray-200 dark:border-gray-700">
                {/* Group-Aware Buffer Toggle */}
                <div>
                  <label className="flex items-center justify-between">
                    <div>
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        Enable GroupArbiter
                      </span>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Deadline-based ordering for QUIC streams
                      </p>
                    </div>
                    <button
                      onClick={() => setUseGroupArbiter(!useGroupArbiter)}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        useGroupArbiter ? 'bg-primary-500' : 'bg-gray-300 dark:bg-gray-600'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          useGroupArbiter ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </label>
                </div>

                {/* GroupArbiter Settings (only shown when enabled) */}
                {useGroupArbiter && (
                  <>
                    <div>
                      <label className="label">
                        Max Latency: {maxLatency}ms
                      </label>
                      <input
                        type="range"
                        min="200"
                        max="2000"
                        step="100"
                        value={maxLatency}
                        onChange={(e) => setMaxLatency(Number(e.target.value))}
                        className="w-full"
                      />
                      <div className="flex justify-between text-xs text-gray-500 mt-1">
                        <span>200ms (aggressive)</span>
                        <span>2000ms (tolerant)</span>
                      </div>
                    </div>
                    <div>
                      <label className="label">
                        GOP Duration: {estimatedGopDuration}ms
                      </label>
                      <input
                        type="range"
                        min="100"
                        max="5000"
                        step="100"
                        value={estimatedGopDuration}
                        onChange={(e) => setEstimatedGopDuration(Number(e.target.value))}
                        className="w-full"
                      />
                      <div className="flex justify-between text-xs text-gray-500 mt-1">
                        <span>100ms (short)</span>
                        <span>5000ms (long)</span>
                      </div>
                    </div>
                    <div>
                      <label className="flex items-center justify-between">
                        <div>
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            Skip to Latest Group
                          </span>
                          <p className="text-xs text-gray-500 mt-0.5">
                            Jump to newest GOP when behind (aggressive catch-up)
                          </p>
                        </div>
                        <button
                          onClick={() => setSkipToLatestGroup(!skipToLatestGroup)}
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                            skipToLatestGroup ? 'bg-primary-500' : 'bg-gray-300 dark:bg-gray-600'
                          }`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                              skipToLatestGroup ? 'translate-x-6' : 'translate-x-1'
                            }`}
                          />
                        </button>
                      </label>
                    </div>
                    {skipToLatestGroup && (
                      <div>
                        <label className="label">
                          Grace Period: {skipGraceFrames} frame{skipGraceFrames !== 1 ? 's' : ''}
                        </label>
                        <input
                          type="range"
                          min="0"
                          max="10"
                          step="1"
                          value={skipGraceFrames}
                          onChange={(e) => setSkipGraceFrames(Number(e.target.value))}
                          className="w-full"
                        />
                        <div className="flex justify-between text-xs text-gray-500 mt-1">
                          <span>0 (immediate)</span>
                          <span>10 (patient)</span>
                        </div>
                      </div>
                    )}

                    {/* Catch-up Mode */}
                    <div className="pt-2">
                      <label className="flex items-center justify-between">
                        <div>
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            Buffer Catch-Up
                          </span>
                          <p className="text-xs text-gray-500 mt-0.5">
                            Fast-forward when buffer gets too deep
                          </p>
                        </div>
                        <button
                          onClick={() => setEnableCatchUp(!enableCatchUp)}
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                            enableCatchUp ? 'bg-primary-500' : 'bg-gray-300 dark:bg-gray-600'
                          }`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                              enableCatchUp ? 'translate-x-6' : 'translate-x-1'
                            }`}
                          />
                        </button>
                      </label>
                    </div>
                    {enableCatchUp && (
                      <div>
                        <label className="label">
                          Catch-Up Threshold: {catchUpThreshold} frame{catchUpThreshold !== 1 ? 's' : ''}
                        </label>
                        <input
                          type="range"
                          min="3"
                          max="15"
                          step="1"
                          value={catchUpThreshold}
                          onChange={(e) => setCatchUpThreshold(Number(e.target.value))}
                          className="w-full"
                        />
                        <div className="flex justify-between text-xs text-gray-500 mt-1">
                          <span>3 (aggressive)</span>
                          <span>15 (tolerant)</span>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
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
          <p className="mt-1 font-mono text-[10px]">
            Commit: {import.meta.env.VITE_GIT_COMMIT || 'dev'}
          </p>
        </div>
      </div>
    </div>
  );
};
