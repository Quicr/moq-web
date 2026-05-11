// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Publish Panel Component
 *
 * Main interface for publishing multiple media tracks including device selection,
 * encoding settings, and track management.
 */

import React, { useState, useRef, useEffect } from 'react';
import { getResolutionConfig } from '@web-moq/media';
import { useStore } from '../../store';
import { isDebugMode } from '../common/DevSettingsPanel';
import { useVAD } from '../../hooks/useVAD';
import { VADIndicator, VADDot } from '../common/VADIndicator';

type MediaType = 'video' | 'audio';
type Resolution = '1080p' | '720p' | '480p';
type Framerate = 30 | 24 | 15;
type DeliveryMode = 'stream' | 'datagram';

interface TrackConfig {
  id: string;
  mediaType: MediaType;
  namespace: string;
  trackName: string;
  resolution?: Resolution;
  framerate?: Framerate;
  bitrate?: number;
  deliveryTimeout: number;
  priority: number;
  deliveryMode: DeliveryMode;
  isPublishing: boolean;
  isPaused: boolean;
  trackAlias?: bigint;
}

export const PublishPanel: React.FC = () => {
  const {
    localStream,
    setLocalStream,
    publishedTracks,
    sessionState,
    startPublishing: storeStartPublishing,
    stopPublishing: storeStopPublishing,
    pausePublishing,
    resumePublishing,
    isPublishPaused,
    keyframeInterval,
    videoResolution,
    setKeyframeInterval,
    useAnnounceFlow,
    announceStatus,
    announceTrackAliases,
    cancelAnnounce,
    secureObjectsEnabled,
  } = useStore();

  const videoRef = useRef<HTMLVideoElement>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedVideoDevice, setSelectedVideoDevice] = useState('');
  const [selectedAudioDevice, setSelectedAudioDevice] = useState('');
  const [publishError, setPublishError] = useState<string | null>(null);

  // Track configurations
  const [trackConfigs, setTrackConfigs] = useState<TrackConfig[]>([]);

  // New track form state
  const [newTrack, setNewTrack] = useState<Partial<TrackConfig>>({
    mediaType: 'video',
    namespace: 'conference/room-1/media',
    trackName: '',
    resolution: '720p',
    framerate: 30,
    bitrate: 2000000,
    deliveryTimeout: 5000,
    priority: 128,
    deliveryMode: 'stream', // Video defaults to stream
  });

  // Simulcast quality selection
  const [simulcastQualities, setSimulcastQualities] = useState({
    '1080p': true,
    '720p': true,
    '480p': true,
  });

  // Voice Activity Detection
  const {
    isSpeaking,
    audioContext,
    sourceNode,
    result: vadResult,
  } = useVAD({ stream: localStream });

  // Get available devices - must request permissions first to see all devices (including virtual cameras like OBS)
  const refreshDevices = async () => {
    try {
      // Request temporary media access to get full device enumeration
      // Without this, virtual cameras like OBS may not appear in the list
      let tempStream: MediaStream | null = null;
      try {
        tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch (permErr) {
        console.warn('Could not get media permissions for device enumeration:', permErr);
      }

      const allDevices = await navigator.mediaDevices.enumerateDevices();
      console.log('All devices:', allDevices);
      setDevices(allDevices);

      // Stop the temporary stream - we only needed it to unlock device enumeration
      if (tempStream) {
        tempStream.getTracks().forEach(track => track.stop());
      }

      const videoDevices = allDevices.filter(d => d.kind === 'videoinput');
      const audioDevices = allDevices.filter(d => d.kind === 'audioinput');
      console.log('Video devices:', videoDevices);

      if (videoDevices.length > 0 && !selectedVideoDevice) {
        setSelectedVideoDevice(videoDevices[0].deviceId);
      }
      if (audioDevices.length > 0 && !selectedAudioDevice) {
        setSelectedAudioDevice(audioDevices[0].deviceId);
      }
    } catch (err) {
      console.error('Failed to enumerate devices:', err);
    }
  };

  useEffect(() => {
    refreshDevices();
  }, []);

  // Update video preview
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  const createCaptureStream = async (
    videoDeviceId?: string,
    audioDeviceId?: string,
    options?: { videoEnabled?: boolean; audioEnabled?: boolean }
  ) => {
    const { width, height } = getResolutionConfig(videoResolution);
    const videoEnabled = options?.videoEnabled ?? true;
    const audioEnabled = options?.audioEnabled ?? true;

    return navigator.mediaDevices.getUserMedia({
      video: videoEnabled
        ? (videoDeviceId
            ? { deviceId: { exact: videoDeviceId }, width, height }
            : { width, height })
        : false,
      audio: audioEnabled
        ? (audioDeviceId
            ? { deviceId: { exact: audioDeviceId } }
            : true)
        : false,
    });
  };

  const replaceLocalStream = (stream: MediaStream) => {
    if (localStream && localStream !== stream) {
      localStream.getTracks().forEach(track => track.stop());
    }
    setLocalStream(stream);
  };

  const captureSelectedDevices = async (videoDeviceId = selectedVideoDevice, audioDeviceId = selectedAudioDevice) => {
    try {
      const stream = await createCaptureStream(videoDeviceId, audioDeviceId);
      replaceLocalStream(stream);
    } catch (err) {
      console.error('Failed to capture media:', err);
    }
  };

  const startCapture = async () => {
    await captureSelectedDevices();
  };

  const stopCapture = () => {
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
    }
  };

  useEffect(() => {
    if (!localStream) return;

    void captureSelectedDevices(selectedVideoDevice, selectedAudioDevice);
  }, [selectedVideoDevice, selectedAudioDevice]);

  const addTrackConfig = () => {
    if (!newTrack.namespace || !newTrack.trackName) return;

    // Default delivery mode: stream for video, datagram for audio
    const defaultDeliveryMode: DeliveryMode = newTrack.mediaType === 'video' ? 'stream' : 'datagram';

    const config: TrackConfig = {
      id: `track-${Date.now()}`,
      mediaType: newTrack.mediaType || 'video',
      namespace: newTrack.namespace,
      trackName: newTrack.trackName,
      resolution: newTrack.mediaType === 'video' ? newTrack.resolution : undefined,
      framerate: newTrack.mediaType === 'video' ? newTrack.framerate : undefined,
      bitrate: newTrack.bitrate,
      deliveryTimeout: newTrack.deliveryTimeout ?? 5000,
      priority: newTrack.priority ?? 128,
      deliveryMode: newTrack.deliveryMode ?? defaultDeliveryMode,
      isPublishing: false,
      isPaused: false,
    };

    setTrackConfigs([...trackConfigs, config]);
    setNewTrack({
      ...newTrack,
      trackName: '',
    });
  };

  // Build simulcast track configs based on selected qualities
  const buildSimulcastConfigs = (): TrackConfig[] => {
    if (!newTrack.namespace) return [];

    const qualityConfigs: Record<string, { resolution: Resolution; bitrate: number }> = {
      '1080p': { resolution: '1080p', bitrate: 4000000 },
      '720p': { resolution: '720p', bitrate: 2000000 },
      '480p': { resolution: '480p', bitrate: 500000 },
    };

    return Object.entries(simulcastQualities)
      .filter(([, enabled]) => enabled)
      .map(([quality]) => ({
        id: `track-${Date.now()}-${quality}`,
        mediaType: 'video' as MediaType,
        namespace: newTrack.namespace!,
        trackName: `video-${quality}`,
        resolution: qualityConfigs[quality].resolution,
        framerate: 30 as Framerate,
        bitrate: qualityConfigs[quality].bitrate,
        deliveryTimeout: 5000,
        priority: 128,
        deliveryMode: 'stream' as DeliveryMode,
        isPublishing: false,
        isPaused: false,
      }));
  };

  // Add simulcast tracks (without starting)
  const addDtsSimulcastTracks = () => {
    const configs = buildSimulcastConfigs();
    if (configs.length === 0) return;
    setTrackConfigs([...trackConfigs, ...configs]);
  };

  // Add AND start simulcast tracks in one action
  const addAndStartSimulcast = async () => {
    const configs = buildSimulcastConfigs();
    if (configs.length === 0) return;

    // Add to state
    const newConfigs = [...trackConfigs, ...configs];
    setTrackConfigs(newConfigs);

    // Start each track immediately (don't wait for state update)
    for (const config of configs) {
      await startPublishingTrack(config);
    }
  };

  // Start all stopped tracks
  const startAllTracks = async () => {
    const stoppedTracks = trackConfigs.filter(t => !t.isPublishing);
    for (const track of stoppedTracks) {
      await startPublishingTrack(track);
    }
  };

  const removeTrackConfig = (id: string) => {
    setTrackConfigs(trackConfigs.filter(t => t.id !== id));
  };

  const startPublishingTrack = async (config: TrackConfig) => {
    setPublishError(null);

    try {
      // Each track gets its own video/audio enabled based on its media type
      const videoEnabled = config.mediaType === 'video';
      const audioEnabled = config.mediaType === 'audio';

      // Always create a fresh stream for each track
      // This ensures each track has its own independent stream that won't be stopped
      // when other operations happen (device changes, other tracks starting, etc.)
      const stream = await createCaptureStream(
        videoEnabled ? selectedVideoDevice : undefined,
        audioEnabled ? selectedAudioDevice : undefined,
        { videoEnabled, audioEnabled }
      );

      // Update localStream for preview (don't stop the old one if tracks are still publishing)
      if (!localStream) {
        setLocalStream(stream);
      }

      if (!stream) {
        setPublishError('Failed to capture media');
        return;
      }

      // Pass the stream directly to startPublishing with per-track config for simulcast
      const trackAlias = await storeStartPublishing(
        config.namespace,
        config.trackName,
        config.deliveryTimeout,
        config.priority,
        config.deliveryMode,
        videoEnabled,
        audioEnabled,
        stream,
        // Per-track video settings for simulcast (different resolution/bitrate per track)
        config.mediaType === 'video' ? {
          resolution: config.resolution,
          bitrate: config.bitrate,
          framerate: config.framerate,
        } : undefined
      );

      setTrackConfigs(trackConfigs.map(t =>
        t.id === config.id ? { ...t, isPublishing: true, trackAlias } : t
      ));
    } catch (err) {
      const error = err as Error;
      console.error('Failed to start publishing:', error);
      setPublishError(error.message);
    }
  };

  const stopPublishingTrack = async (config: TrackConfig) => {
    // In announce flow, look up the actual trackAlias from the map using namespace/trackName
    // because config.trackAlias is just a placeholder (0n) returned from startPublishing
    const trackKey = `${config.namespace}/${config.trackName}`;
    const announceAlias = announceTrackAliases.get(trackKey);
    const effectiveTrackAlias = useAnnounceFlow && announceAlias !== undefined
      ? announceAlias
      : config.trackAlias;

    try {
      if (effectiveTrackAlias !== undefined) {
        await storeStopPublishing(effectiveTrackAlias);
      }
      setTrackConfigs(trackConfigs.map(t =>
        t.id === config.id ? { ...t, isPublishing: false, trackAlias: undefined } : t
      ));
    } catch (err) {
      console.error('Failed to stop publishing:', err);
    }
  };

  const videoDevices = devices.filter(d => d.kind === 'videoinput');
  const audioDevices = devices.filter(d => d.kind === 'audioinput');
  const hasPublishingTracks = trackConfigs.some(t => t.isPublishing);

  return (
    <div className="space-y-6">
      {/* Video Preview */}
      <div className="panel">
        <div className="panel-header">Local Preview</div>
        <div className="panel-body">
          <div className="video-container mb-4" style={{ position: 'relative', paddingBottom: '56.25%' }}>
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                display: localStream ? 'block' : 'none',
              }}
            />
            {!localStream && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-100 dark:bg-gray-700">
                <div className="text-center text-gray-400">
                  <svg className="w-12 h-12 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  <p className="text-sm">No video</p>
                </div>
              </div>
            )}
          </div>
          <div className="flex gap-2">
            {!localStream ? (
              <button onClick={startCapture} className="btn-secondary flex-1">
                Start Capture
              </button>
            ) : (
              <button onClick={stopCapture} className="btn-secondary flex-1" disabled={hasPublishingTracks}>
                Stop Capture
              </button>
            )}
          </div>
          {/* VAD Status - fixed height container to prevent layout shifts */}
          <div className="mt-2 h-8 flex items-center">
            {localStream && (
              <div className={`flex items-center gap-3 text-sm ${isSpeaking ? 'text-green-600 dark:text-green-400' : 'text-gray-500 dark:text-gray-400'}`}>
                <VADIndicator
                  audioContext={audioContext}
                  sourceNode={sourceNode}
                  isSpeaking={isSpeaking}
                  vadResult={vadResult}
                />
                <VADDot isSpeaking={isSpeaking} />
                <span>{isSpeaking ? 'Speaking' : 'Silent'}</span>
                {vadResult && (
                  <span className="text-xs opacity-75">({(vadResult.probability * 100).toFixed(0)}%)</span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Device Selection */}
      <div className="panel">
        <div className="panel-header flex items-center justify-between">
          <span>Device Selection</span>
          <button
            onClick={refreshDevices}
            className="btn-secondary btn-sm"
            title="Refresh device list"
          >
            Refresh
          </button>
        </div>
        <div className="panel-body space-y-4">
          <div>
            <label className="label">Camera</label>
            <select
              value={selectedVideoDevice}
              onChange={(e) => setSelectedVideoDevice(e.target.value)}
              className="input"
              disabled={hasPublishingTracks}
            >
              {videoDevices.map(device => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Camera ${device.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Microphone</label>
            <select
              value={selectedAudioDevice}
              onChange={(e) => setSelectedAudioDevice(e.target.value)}
              className="input"
              disabled={hasPublishingTracks}
            >
              {audioDevices.map(device => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Microphone ${device.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Keyframe Interval</label>
            <select
              value={keyframeInterval}
              onChange={(e) => setKeyframeInterval(Number(e.target.value))}
              className="input"
              disabled={hasPublishingTracks}
            >
              <option value={0.5}>0.5 seconds (fast join)</option>
              <option value={1}>1 second</option>
              <option value={2}>2 seconds</option>
              <option value={5}>5 seconds</option>
            </select>
          </div>
        </div>
      </div>

      {/* Add Video Tracks */}
      <div className="panel">
        <div className="panel-header">Add Video Tracks</div>
        <div className="panel-body space-y-4">
          <div>
            <label className="label">Namespace</label>
            <input
              type="text"
              value={newTrack.namespace}
              onChange={(e) => setNewTrack({ ...newTrack, namespace: e.target.value })}
              placeholder="suhas"
              className="input"
            />
            <p className="text-xs text-gray-500 mt-1">Use same namespace on subscriber</p>
          </div>

          {/* Quality Selection */}
          <div>
            <label className="label">Select Qualities</label>
            <div className="grid grid-cols-3 gap-2 text-xs text-center">
              <label className={`p-3 rounded cursor-pointer border-2 transition-colors ${
                simulcastQualities['1080p']
                  ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-400'
                  : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:border-blue-300'
              }`}>
                <input
                  type="checkbox"
                  checked={simulcastQualities['1080p']}
                  onChange={(e) => setSimulcastQualities({ ...simulcastQualities, '1080p': e.target.checked })}
                  className="sr-only"
                />
                <div className="font-semibold text-blue-700 dark:text-blue-300">1080p</div>
                <div className="text-gray-500">4 Mbps</div>
              </label>
              <label className={`p-3 rounded cursor-pointer border-2 transition-colors ${
                simulcastQualities['720p']
                  ? 'bg-green-50 dark:bg-green-900/20 border-green-400'
                  : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:border-green-300'
              }`}>
                <input
                  type="checkbox"
                  checked={simulcastQualities['720p']}
                  onChange={(e) => setSimulcastQualities({ ...simulcastQualities, '720p': e.target.checked })}
                  className="sr-only"
                />
                <div className="font-semibold text-green-700 dark:text-green-300">720p</div>
                <div className="text-gray-500">2 Mbps</div>
              </label>
              <label className={`p-3 rounded cursor-pointer border-2 transition-colors ${
                simulcastQualities['480p']
                  ? 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-400'
                  : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:border-yellow-300'
              }`}>
                <input
                  type="checkbox"
                  checked={simulcastQualities['480p']}
                  onChange={(e) => setSimulcastQualities({ ...simulcastQualities, '480p': e.target.checked })}
                  className="sr-only"
                />
                <div className="font-semibold text-yellow-700 dark:text-yellow-300">480p</div>
                <div className="text-gray-500">0.5 Mbps</div>
              </label>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {Object.values(simulcastQualities).filter(v => v).length === 0
                ? 'Select at least one quality'
                : `Tracks: ${Object.entries(simulcastQualities).filter(([,v]) => v).map(([q]) => `video-${q}`).join(', ')}`
              }
            </p>
          </div>

          {/* Main action button */}
          <button
            onClick={addAndStartSimulcast}
            disabled={sessionState !== 'ready' || !newTrack.namespace || !Object.values(simulcastQualities).some(v => v)}
            className="btn-success w-full py-3 text-base font-semibold"
          >
            Add & Start Publishing ({Object.values(simulcastQualities).filter(v => v).length} track{Object.values(simulcastQualities).filter(v => v).length !== 1 ? 's' : ''})
          </button>

          {/* Secondary actions */}
          <div className="flex gap-2 text-sm">
            <button
              onClick={addDtsSimulcastTracks}
              disabled={!newTrack.namespace || !Object.values(simulcastQualities).some(v => v)}
              className="btn-secondary flex-1"
            >
              Add Only
            </button>
            {trackConfigs.some(t => !t.isPublishing) && (
              <button
                onClick={startAllTracks}
                disabled={sessionState !== 'ready'}
                className="btn-primary flex-1"
              >
                Start All Stopped
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Advanced: Single Track (collapsed by default) */}
      <details className="panel">
        <summary className="panel-header cursor-pointer flex items-center gap-2">
          <svg className="w-4 h-4 transition-transform details-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          Advanced: Add Single Track
        </summary>
        <div className="panel-body space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Media Type</label>
              <select
                value={newTrack.mediaType}
                onChange={(e) => {
                  const mediaType = e.target.value as MediaType;
                  const deliveryMode: DeliveryMode = mediaType === 'video' ? 'stream' : 'datagram';
                  setNewTrack({ ...newTrack, mediaType, deliveryMode });
                }}
                className="input"
              >
                <option value="video">Video</option>
                <option value="audio">Audio</option>
              </select>
            </div>
            {newTrack.mediaType === 'video' && (
              <>
                <div>
                  <label className="label">Resolution</label>
                  <select
                    value={newTrack.resolution}
                    onChange={(e) => setNewTrack({ ...newTrack, resolution: e.target.value as Resolution })}
                    className="input"
                  >
                    <option value="1080p">1080p</option>
                    <option value="720p">720p</option>
                    <option value="480p">480p</option>
                  </select>
                </div>
                <div>
                  <label className="label">Bitrate</label>
                  <select
                    value={newTrack.bitrate}
                    onChange={(e) => setNewTrack({ ...newTrack, bitrate: Number(e.target.value) })}
                    className="input"
                  >
                    <option value={4000000}>4 Mbps</option>
                    <option value={2000000}>2 Mbps</option>
                    <option value={1000000}>1 Mbps</option>
                    <option value={500000}>0.5 Mbps</option>
                  </select>
                </div>
              </>
            )}
            {newTrack.mediaType === 'audio' && (
              <div>
                <label className="label">Bitrate</label>
                <select
                  value={newTrack.bitrate}
                  onChange={(e) => setNewTrack({ ...newTrack, bitrate: Number(e.target.value) })}
                  className="input"
                >
                  <option value={128000}>128 kbps</option>
                  <option value={96000}>96 kbps</option>
                  <option value={64000}>64 kbps</option>
                </select>
              </div>
            )}
          </div>
          <div>
            <label className="label">Track Name</label>
            <input
              type="text"
              value={newTrack.trackName}
              onChange={(e) => setNewTrack({ ...newTrack, trackName: e.target.value })}
              placeholder={newTrack.mediaType === 'video' ? 'video-custom' : 'audio'}
              className="input"
            />
          </div>
          <button
            onClick={addTrackConfig}
            disabled={!newTrack.namespace || !newTrack.trackName}
            className="btn-secondary w-full"
          >
            Add Single Track
          </button>
        </div>
      </details>

      {/* Track Configurations */}
      {trackConfigs.length > 0 && (
        <div className="panel">
          <div className="panel-header">Configured Tracks ({trackConfigs.length})</div>
          <div className="panel-body space-y-3">
            {publishError && (
              <div className="p-3 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-md text-sm">
                {publishError}
              </div>
            )}
            {trackConfigs.map(config => (
              <div
                key={config.id}
                className="p-4 bg-gray-50 dark:bg-gray-900 rounded-lg space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {config.mediaType === 'video' ? (
                      <svg className="w-6 h-6 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    ) : (
                      <svg className="w-6 h-6 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                      </svg>
                    )}
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium">{config.trackName}</span>
                        {secureObjectsEnabled && (
                          <svg className="w-4 h-4 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                          </svg>
                        )}
                      </div>
                      <div className="text-xs text-gray-500">{config.namespace}</div>
                    </div>
                  </div>
                  <span className={`badge ${
                    config.isPublishing
                      ? (useAnnounceFlow && announceStatus === 'waiting' ? 'badge-yellow' : 'badge-green')
                      : 'badge-gray'
                  }`}>
                    {config.isPublishing
                      ? (useAnnounceFlow && announceStatus === 'waiting' ? 'Waiting' :
                         useAnnounceFlow && announceStatus === 'announcing' ? 'Announcing' :
                         'Publishing')
                      : 'Stopped'}
                  </span>
                </div>

                {config.mediaType === 'video' && (
                  <div className="flex gap-4 text-sm text-gray-600 dark:text-gray-400">
                    <span>{config.resolution}</span>
                    <span>{config.framerate} fps</span>
                    <span>{((config.bitrate || 0) / 1000000).toFixed(1)} Mbps</span>
                  </div>
                )}
                {config.mediaType === 'audio' && (
                  <div className="text-sm text-gray-600 dark:text-gray-400">
                    {((config.bitrate || 0) / 1000)} kbps
                  </div>
                )}
                <div className="flex gap-4 text-sm text-gray-600 dark:text-gray-400">
                  <span className={`px-2 py-0.5 rounded ${config.deliveryMode === 'stream' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' : 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'}`}>
                    {config.deliveryMode}
                  </span>
                  <span>Timeout: {config.deliveryTimeout}ms</span>
                  <span>Priority: {config.priority}</span>
                </div>

                <div className="flex gap-2">
                  {!config.isPublishing ? (
                    <button
                      onClick={() => startPublishingTrack(config)}
                      disabled={sessionState !== 'ready'}
                      className="btn-success btn-sm flex-1"
                    >
                      Start
                    </button>
                  ) : (
                    <button
                      onClick={() => stopPublishingTrack(config)}
                      className="btn-danger btn-sm flex-1"
                      title="Stop publishing - relay will select next best track (DTS)"
                    >
                      Stop
                    </button>
                  )}
                  <button
                    onClick={() => removeTrackConfig(config.id)}
                    disabled={config.isPublishing}
                    className="btn-secondary btn-sm"
                    title="Remove track configuration"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* DTS Simulcast Control - Quick toggle for each quality */}
      {trackConfigs.some(t => t.isPublishing && t.mediaType === 'video') && (
        <div className="panel">
          <div className="panel-header flex items-center gap-2">
            <span>DTS Simulcast Control</span>
            <span className="text-xs text-gray-500 font-normal">(pause/resume triggers relay track selection)</span>
          </div>
          <div className="panel-body">
            <div className="grid grid-cols-3 gap-3">
              {['1080p', '720p', '480p'].map(quality => {
                const config = trackConfigs.find(t => t.trackName === `video-${quality}`);
                const isPublishing = config?.isPublishing ?? false;
                const isConfigured = !!config;
                // Check if the track is paused (only relevant if publishing)
                const trackKey = config ? `${config.namespace}/${config.trackName}` : '';
                const announceAlias = announceTrackAliases.get(trackKey);
                const effectiveAlias = useAnnounceFlow && announceAlias !== undefined
                  ? announceAlias
                  : config?.trackAlias;
                const isPaused = isPublishing && effectiveAlias !== undefined && isPublishPaused(effectiveAlias);
                const isActive = isPublishing && !isPaused;

                return (
                  <button
                    key={quality}
                    onClick={() => {
                      if (!config || effectiveAlias === undefined) return;
                      if (isActive) {
                        // Pause - stops sending frames
                        pausePublishing(effectiveAlias);
                        setTrackConfigs(trackConfigs.map(t =>
                          t.id === config.id ? { ...t, isPaused: true } : t
                        ));
                      } else if (isPaused) {
                        // Resume - starts sending frames again
                        resumePublishing(effectiveAlias);
                        setTrackConfigs(trackConfigs.map(t =>
                          t.id === config.id ? { ...t, isPaused: false } : t
                        ));
                      }
                    }}
                    disabled={!isConfigured || !isPublishing || sessionState !== 'ready'}
                    className={`p-4 rounded-lg border-2 transition-all ${
                      !isConfigured || !isPublishing
                        ? 'bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700 opacity-50 cursor-not-allowed'
                        : isActive
                        ? 'bg-green-100 dark:bg-green-900/30 border-green-500 hover:bg-green-200 dark:hover:bg-green-900/50'
                        : 'bg-yellow-100 dark:bg-yellow-900/30 border-yellow-400 hover:bg-yellow-200 dark:hover:bg-yellow-900/50'
                    }`}
                  >
                    <div className={`text-lg font-bold ${
                      !isConfigured || !isPublishing ? 'text-gray-400' :
                      isActive ? 'text-green-700 dark:text-green-300' : 'text-yellow-600 dark:text-yellow-400'
                    }`}>
                      {quality}
                    </div>
                    <div className={`text-xs mt-1 ${
                      !isConfigured || !isPublishing ? 'text-gray-400' :
                      isActive ? 'text-green-600 dark:text-green-400' : 'text-yellow-500 dark:text-yellow-400'
                    }`}>
                      {!isConfigured ? 'Not configured' : !isPublishing ? 'Not publishing' : isActive ? 'SENDING' : 'PAUSED'}
                    </div>
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-gray-500 mt-3">
              Click to pause/resume. Pausing stops frames; relay selects next available track.
            </p>
          </div>
        </div>
      )}

      {/* Announce Flow Status */}
      {useAnnounceFlow && announceStatus !== 'idle' && (
        <div className="panel">
          <div className="panel-header">Announce Flow Status</div>
          <div className="panel-body">
            <div className={`p-4 rounded-lg ${
              announceStatus === 'announcing' ? 'bg-blue-100 dark:bg-blue-900/30' :
              announceStatus === 'waiting' ? 'bg-yellow-100 dark:bg-yellow-900/30' :
              announceStatus === 'active' ? 'bg-green-100 dark:bg-green-900/30' :
              'bg-gray-100 dark:bg-gray-900/30'
            }`}>
              <div className="flex items-center gap-3">
                {announceStatus === 'announcing' && (
                  <>
                    <div className="animate-spin h-5 w-5 border-2 border-blue-500 border-t-transparent rounded-full" />
                    <span className="text-blue-700 dark:text-blue-300 font-medium">Announcing namespace...</span>
                  </>
                )}
                {announceStatus === 'waiting' && (
                  <>
                    <div className="animate-pulse h-5 w-5 bg-yellow-500 rounded-full" />
                    <span className="text-yellow-700 dark:text-yellow-300 font-medium">Waiting for subscribers...</span>
                  </>
                )}
                {announceStatus === 'active' && (
                  <>
                    <div className="h-5 w-5 bg-green-500 rounded-full" />
                    <span className="text-green-700 dark:text-green-300 font-medium">Publishing to subscribers</span>
                  </>
                )}
              </div>
              {announceStatus === 'waiting' && (
                <p className="mt-2 text-sm text-yellow-600 dark:text-yellow-400">
                  Namespace announced. Media will start when a subscriber connects.
                </p>
              )}
              {(announceStatus === 'announcing' || announceStatus === 'waiting') && trackConfigs.length > 0 && trackConfigs[0].namespace && (
                <button
                  onClick={() => cancelAnnounce(trackConfigs[0].namespace)}
                  className="mt-3 btn-secondary btn-sm"
                >
                  Cancel Announce
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Published Tracks Stats */}
      {publishedTracks.length > 0 && (
        <div className="panel">
          <div className="panel-header">Publishing Stats</div>
          <div className="panel-body">
            <div className="space-y-2">
              {publishedTracks.map(track => (
                <div
                  key={track.id}
                  className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-900 rounded-md"
                >
                  <div className="flex items-center gap-3">
                    {track.type === 'video' ? (
                      <svg className="w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    ) : (
                      <svg className="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                      </svg>
                    )}
                    <div>
                      <div className="font-medium text-sm">{track.trackName}</div>
                      <div className="text-xs text-gray-500">{track.namespace.join('/')}</div>
                    </div>
                  </div>
                  {isDebugMode() && (
                    <div className="text-xs text-gray-500">
                      G:{track.stats.groupId} O:{track.stats.objectId}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
