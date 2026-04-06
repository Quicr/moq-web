// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Settings Panel Component
 *
 * Application settings including theme, codec settings, and delivery options.
 */

import React, { useState, useEffect } from 'react';
import { useStore } from '../../store';
import { LogLevel } from '../../types';
import { VarIntType } from '@web-moq/core';
import {
  EXPERIENCE_PROFILES,
  EXPERIENCE_PROFILE_ORDER,
  type ExperienceProfileName,
} from '@web-moq/media';

export const SettingsPanel: React.FC = () => {
  const [showFineTune, setShowFineTune] = useState(false);

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
    useLatencyDeadline,
    setUseLatencyDeadline,
    arbiterDebug,
    setArbiterDebug,
    experienceProfile,
    applyExperienceProfile,
    updateDetectedProfile,
  } = useStore();

  // Update detected profile when individual settings change
  useEffect(() => {
    updateDetectedProfile();
  }, [
    jitterBufferDelay,
    useLatencyDeadline,
    maxLatency,
    estimatedGopDuration,
    skipToLatestGroup,
    skipGraceFrames,
    enableCatchUp,
    catchUpThreshold,
    updateDetectedProfile,
  ]);

  const handleProfileChange = (profileName: ExperienceProfileName) => {
    applyExperienceProfile(profileName);
    if (profileName !== 'custom') {
      setShowFineTune(false);
    }
  };

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

          {/* Experience Profile (Accordion Style) */}
          <div className="border border-gray-200 dark:border-gray-700 rounded-md overflow-hidden">
            <div className="bg-gray-50 dark:bg-gray-800/50 px-3 py-2 border-b border-gray-200 dark:border-gray-700">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Experience Profile
              </span>
            </div>

            {/* Profile Rows */}
            <div className="divide-y divide-gray-200 dark:divide-gray-700">
              {EXPERIENCE_PROFILE_ORDER.map((profileName) => {
                const profile = EXPERIENCE_PROFILES[profileName];
                const isSelected = experienceProfile === profileName;
                return (
                  <div key={profileName}>
                    {/* Profile Row Header */}
                    <button
                      onClick={() => handleProfileChange(profileName)}
                      className={`w-full px-3 py-2.5 flex items-center text-left transition-colors ${
                        isSelected
                          ? 'bg-primary-50 dark:bg-primary-900/20'
                          : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
                      }`}
                    >
                      {/* Radio indicator */}
                      <div className={`w-4 h-4 rounded-full border-2 mr-3 flex items-center justify-center flex-shrink-0 ${
                        isSelected
                          ? 'border-primary-500'
                          : 'border-gray-300 dark:border-gray-600'
                      }`}>
                        {isSelected && (
                          <div className="w-2 h-2 rounded-full bg-primary-500" />
                        )}
                      </div>
                      {/* Profile info */}
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm text-gray-900 dark:text-gray-100">
                          {profile.displayName}
                        </div>
                        <div className="text-xs text-gray-500 truncate">
                          {profile.description}
                        </div>
                      </div>
                      {/* Latency badge */}
                      <div className="ml-2 px-2 py-0.5 rounded text-xs font-mono bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400">
                        {profile.targetLatency}ms
                      </div>
                    </button>

                    {/* Expanded Settings (only for selected profile) */}
                    {isSelected && (
                      <div className="px-3 pb-3 bg-primary-50/50 dark:bg-primary-900/10">
                        {/* Settings Summary */}
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 py-2 text-xs border-b border-primary-200 dark:border-primary-800/30 mb-2">
                          <div className="flex justify-between">
                            <span className="text-gray-500">Jitter Buffer:</span>
                            <span className="font-mono text-gray-700 dark:text-gray-300">{jitterBufferDelay}ms</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">Max Latency:</span>
                            <span className="font-mono text-gray-700 dark:text-gray-300">{maxLatency}ms</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">GOP Duration:</span>
                            <span className="font-mono text-gray-700 dark:text-gray-300">{estimatedGopDuration}ms</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">Skip to Latest:</span>
                            <span className="font-mono text-gray-700 dark:text-gray-300">{skipToLatestGroup ? 'On' : 'Off'}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">Catch-up:</span>
                            <span className="font-mono text-gray-700 dark:text-gray-300">{enableCatchUp ? `On (${catchUpThreshold}f)` : 'Off'}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">Interactive:</span>
                            <span className="font-mono text-gray-700 dark:text-gray-300">{useLatencyDeadline ? 'On' : 'Off'}</span>
                          </div>
                        </div>

                        {/* Customize Button */}
                        <button
                          onClick={() => setShowFineTune(!showFineTune)}
                          className="flex items-center text-xs text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300"
                        >
                          <svg
                            className={`w-3 h-3 mr-1 transition-transform ${showFineTune ? 'rotate-90' : ''}`}
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                          Customize
                        </button>

                        {/* Fine-tune Controls */}
                        {showFineTune && (
                          <div className="mt-3 space-y-4">
                            {/* Jitter Buffer */}
                            <div>
                              <label className="label text-xs">
                                Jitter Buffer: {jitterBufferDelay}ms
                              </label>
                              <input
                                type="range"
                                min="50"
                                max="300"
                                step="10"
                                value={jitterBufferDelay}
                                onChange={(e) => setJitterBufferDelay(Number(e.target.value))}
                                className="w-full h-1.5"
                              />
                            </div>

                            {/* Interactive Mode Toggle */}
                            <div>
                              <label className="flex items-center justify-between">
                                <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
                                  Interactive Mode
                                </span>
                                <button
                                  onClick={() => setUseLatencyDeadline(!useLatencyDeadline)}
                                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                                    useLatencyDeadline ? 'bg-primary-500' : 'bg-gray-300 dark:bg-gray-600'
                                  }`}
                                >
                                  <span
                                    className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                                      useLatencyDeadline ? 'translate-x-5' : 'translate-x-1'
                                    }`}
                                  />
                                </button>
                              </label>
                            </div>

                            {/* Max Latency */}
                            <div>
                              <label className="label text-xs">
                                Max Latency: {maxLatency}ms
                              </label>
                              <input
                                type="range"
                                min="0"
                                max="5000"
                                step="50"
                                value={maxLatency}
                                onChange={(e) => setMaxLatency(Number(e.target.value))}
                                className="w-full h-1.5"
                              />
                            </div>

                            {/* GOP Duration */}
                            <div>
                              <label className="label text-xs">
                                GOP Duration: {estimatedGopDuration}ms
                              </label>
                              <input
                                type="range"
                                min="100"
                                max="5000"
                                step="100"
                                value={estimatedGopDuration}
                                onChange={(e) => setEstimatedGopDuration(Number(e.target.value))}
                                className="w-full h-1.5"
                              />
                            </div>

                            {/* Skip to Latest */}
                            <div>
                              <label className="flex items-center justify-between">
                                <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
                                  Skip to Latest Group
                                </span>
                                <button
                                  onClick={() => setSkipToLatestGroup(!skipToLatestGroup)}
                                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                                    skipToLatestGroup ? 'bg-primary-500' : 'bg-gray-300 dark:bg-gray-600'
                                  }`}
                                >
                                  <span
                                    className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                                      skipToLatestGroup ? 'translate-x-5' : 'translate-x-1'
                                    }`}
                                  />
                                </button>
                              </label>
                            </div>

                            {skipToLatestGroup && (
                              <div>
                                <label className="label text-xs">
                                  Grace Period: {skipGraceFrames} frames
                                </label>
                                <input
                                  type="range"
                                  min="0"
                                  max="10"
                                  step="1"
                                  value={skipGraceFrames}
                                  onChange={(e) => setSkipGraceFrames(Number(e.target.value))}
                                  className="w-full h-1.5"
                                />
                              </div>
                            )}

                            {/* Catch-up */}
                            <div>
                              <label className="flex items-center justify-between">
                                <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
                                  Buffer Catch-Up
                                </span>
                                <button
                                  onClick={() => setEnableCatchUp(!enableCatchUp)}
                                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                                    enableCatchUp ? 'bg-primary-500' : 'bg-gray-300 dark:bg-gray-600'
                                  }`}
                                >
                                  <span
                                    className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                                      enableCatchUp ? 'translate-x-5' : 'translate-x-1'
                                    }`}
                                  />
                                </button>
                              </label>
                            </div>

                            {enableCatchUp && (
                              <div>
                                <label className="label text-xs">
                                  Catch-Up Threshold: {catchUpThreshold} frames
                                </label>
                                <input
                                  type="range"
                                  min="3"
                                  max="15"
                                  step="1"
                                  value={catchUpThreshold}
                                  onChange={(e) => setCatchUpThreshold(Number(e.target.value))}
                                  className="w-full h-1.5"
                                />
                              </div>
                            )}

                            {/* Debug */}
                            <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
                              <label className="flex items-center justify-between">
                                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                                  Debug Logging
                                </span>
                                <button
                                  onClick={() => setArbiterDebug(!arbiterDebug)}
                                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                                    arbiterDebug ? 'bg-orange-500' : 'bg-gray-300 dark:bg-gray-600'
                                  }`}
                                >
                                  <span
                                    className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                                      arbiterDebug ? 'translate-x-5' : 'translate-x-1'
                                    }`}
                                  />
                                </button>
                              </label>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Custom Row */}
              <div>
                <button
                  onClick={() => handleProfileChange('custom')}
                  className={`w-full px-3 py-2.5 flex items-center text-left transition-colors ${
                    experienceProfile === 'custom'
                      ? 'bg-primary-50 dark:bg-primary-900/20'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
                  }`}
                >
                  <div className={`w-4 h-4 rounded-full border-2 mr-3 flex items-center justify-center flex-shrink-0 ${
                    experienceProfile === 'custom'
                      ? 'border-primary-500'
                      : 'border-gray-300 dark:border-gray-600'
                  }`}>
                    {experienceProfile === 'custom' && (
                      <div className="w-2 h-2 rounded-full bg-primary-500" />
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="font-medium text-sm text-gray-900 dark:text-gray-100">
                      Custom
                    </div>
                    <div className="text-xs text-gray-500">
                      Manually configured settings
                    </div>
                  </div>
                </button>

                {/* Custom expanded state */}
                {experienceProfile === 'custom' && (
                  <div className="px-3 pb-3 bg-primary-50/50 dark:bg-primary-900/10">
                    <div className="py-2 text-xs text-gray-500 border-b border-primary-200 dark:border-primary-800/30 mb-2">
                      Settings have been customized and don't match any profile.
                    </div>
                    <button
                      onClick={() => setShowFineTune(!showFineTune)}
                      className="flex items-center text-xs text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300"
                    >
                      <svg
                        className={`w-3 h-3 mr-1 transition-transform ${showFineTune ? 'rotate-90' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                      Edit Settings
                    </button>

                    {showFineTune && (
                      <div className="mt-3 space-y-4">
                        {/* Same controls as above */}
                        <div>
                          <label className="label text-xs">Jitter Buffer: {jitterBufferDelay}ms</label>
                          <input type="range" min="50" max="300" step="10" value={jitterBufferDelay}
                            onChange={(e) => setJitterBufferDelay(Number(e.target.value))} className="w-full h-1.5" />
                        </div>
                        <div>
                          <label className="flex items-center justify-between">
                            <span className="text-xs font-medium text-gray-700 dark:text-gray-300">Interactive Mode</span>
                            <button onClick={() => setUseLatencyDeadline(!useLatencyDeadline)}
                              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${useLatencyDeadline ? 'bg-primary-500' : 'bg-gray-300 dark:bg-gray-600'}`}>
                              <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${useLatencyDeadline ? 'translate-x-5' : 'translate-x-1'}`} />
                            </button>
                          </label>
                        </div>
                        <div>
                          <label className="label text-xs">Max Latency: {maxLatency}ms</label>
                          <input type="range" min="0" max="5000" step="50" value={maxLatency}
                            onChange={(e) => setMaxLatency(Number(e.target.value))} className="w-full h-1.5" />
                        </div>
                        <div>
                          <label className="label text-xs">GOP Duration: {estimatedGopDuration}ms</label>
                          <input type="range" min="100" max="5000" step="100" value={estimatedGopDuration}
                            onChange={(e) => setEstimatedGopDuration(Number(e.target.value))} className="w-full h-1.5" />
                        </div>
                        <div>
                          <label className="flex items-center justify-between">
                            <span className="text-xs font-medium text-gray-700 dark:text-gray-300">Skip to Latest Group</span>
                            <button onClick={() => setSkipToLatestGroup(!skipToLatestGroup)}
                              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${skipToLatestGroup ? 'bg-primary-500' : 'bg-gray-300 dark:bg-gray-600'}`}>
                              <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${skipToLatestGroup ? 'translate-x-5' : 'translate-x-1'}`} />
                            </button>
                          </label>
                        </div>
                        {skipToLatestGroup && (
                          <div>
                            <label className="label text-xs">Grace Period: {skipGraceFrames} frames</label>
                            <input type="range" min="0" max="10" step="1" value={skipGraceFrames}
                              onChange={(e) => setSkipGraceFrames(Number(e.target.value))} className="w-full h-1.5" />
                          </div>
                        )}
                        <div>
                          <label className="flex items-center justify-between">
                            <span className="text-xs font-medium text-gray-700 dark:text-gray-300">Buffer Catch-Up</span>
                            <button onClick={() => setEnableCatchUp(!enableCatchUp)}
                              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${enableCatchUp ? 'bg-primary-500' : 'bg-gray-300 dark:bg-gray-600'}`}>
                              <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${enableCatchUp ? 'translate-x-5' : 'translate-x-1'}`} />
                            </button>
                          </label>
                        </div>
                        {enableCatchUp && (
                          <div>
                            <label className="label text-xs">Catch-Up Threshold: {catchUpThreshold} frames</label>
                            <input type="range" min="3" max="15" step="1" value={catchUpThreshold}
                              onChange={(e) => setCatchUpThreshold(Number(e.target.value))} className="w-full h-1.5" />
                          </div>
                        )}
                        <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
                          <label className="flex items-center justify-between">
                            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Debug Logging</span>
                            <button onClick={() => setArbiterDebug(!arbiterDebug)}
                              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${arbiterDebug ? 'bg-orange-500' : 'bg-gray-300 dark:bg-gray-600'}`}>
                              <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${arbiterDebug ? 'translate-x-5' : 'translate-x-1'}`} />
                            </button>
                          </label>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* GroupArbiter Toggle - Footer */}
            <div className="px-3 py-2 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-200 dark:border-gray-700">
              <label className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
                    Enable GroupArbiter
                  </span>
                  <p className="text-xs text-gray-500">
                    Required for profile settings to take effect
                  </p>
                </div>
                <button
                  onClick={() => setUseGroupArbiter(!useGroupArbiter)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                    useGroupArbiter ? 'bg-primary-500' : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                      useGroupArbiter ? 'translate-x-5' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
            </div>
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
