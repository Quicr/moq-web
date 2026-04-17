// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Publish Panel Component
 *
 * Main interface for publishing multiple media tracks including device selection,
 * encoding settings, and track management.
 * Reorganized with collapsible sections for a cleaner, less busy interface.
 */

import React, { useState, useRef, useEffect } from 'react';
import { getResolutionConfig, VODLoader, type VODLoadProgress } from '@web-moq/media';
import { useStore } from '../../store';
import { isDebugMode } from '../common/DevSettingsPanel';
import { useVAD } from '../../hooks/useVAD';
import { VADIndicator, VADDot } from '../common/VADIndicator';

type MediaType = 'video' | 'audio';
type Resolution = '4k' | '1080p' | '720p' | '480p';
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
  trackAlias?: bigint;
  // VOD-specific fields
  isVod?: boolean;
  vodUrl?: string;
  vodLoop?: boolean;
  vodLoader?: VODLoader;
  vodProgress?: VODLoadProgress;
  vodPlaybackUrl?: string;
  vodIsPlaying?: boolean;
}

// Collapsible Section Component
const CollapsibleSection: React.FC<{
  title: string;
  icon: React.ReactNode;
  defaultOpen?: boolean;
  badge?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, icon, defaultOpen = false, badge, children }) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="glass-panel">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="collapsible-header"
      >
        <div className="flex items-center gap-3">
          {icon}
          <span className="font-semibold text-white">{title}</span>
          {badge}
        </div>
        <svg
          className={`collapsible-chevron ${isOpen ? 'open' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      <div className={`collapsible-content ${isOpen ? 'open' : 'closed'}`}>
        <div className="glass-panel-body border-t border-white/5">
          {children}
        </div>
      </div>
    </div>
  );
};

export const PublishPanel: React.FC = () => {
  const {
    localStream,
    setLocalStream,
    publishedTracks,
    sessionState,
    startPublishing: storeStartPublishing,
    stopPublishing: storeStopPublishing,
    keyframeInterval,
    videoResolution,
    setKeyframeInterval,
    useAnnounceFlow,
    announceStatus,
    cancelAnnounce,
    secureObjectsEnabled,
    vodPublishEnabled,
    session,
    addPublishedTrack,
    onIncomingFetch,
  } = useStore();

  const videoRef = useRef<HTMLVideoElement>(null);
  const vodVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
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
    isVod: false,
    vodUrl: '',
    vodLoop: false,
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

  const createCaptureStream = async (videoDeviceId?: string, audioDeviceId?: string) => {
    const { width, height } = getResolutionConfig(videoResolution);

    return navigator.mediaDevices.getUserMedia({
      video: videoDeviceId
        ? {
            deviceId: { exact: videoDeviceId },
            width,
            height,
          }
        : { width, height },
      audio: audioDeviceId
        ? { deviceId: { exact: audioDeviceId } }
        : true,
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

  // Listen for incoming FETCH requests to start local VOD playback
  useEffect(() => {
    if (!session) return;

    const unsubscribe = onIncomingFetch((event) => {
      console.log('[PublishPanel] Incoming FETCH for VOD track', event);

      // Find matching VOD track config that's publishing
      const matchingConfig = trackConfigs.find(config =>
        config.isVod &&
        config.isPublishing &&
        config.namespace === event.namespace.join('/') &&
        config.trackName === event.trackName
      );

      if (matchingConfig && matchingConfig.vodLoader && !matchingConfig.vodIsPlaying) {
        console.log('[PublishPanel] Starting local playback for VOD track', matchingConfig.trackName);

        // Create playback URL from VOD loader
        const playbackUrl = matchingConfig.vodLoader.createPlaybackUrl();
        if (playbackUrl) {
          setTrackConfigs(prev => prev.map(t =>
            t.id === matchingConfig.id
              ? { ...t, vodPlaybackUrl: playbackUrl, vodIsPlaying: true }
              : t
          ));
        }
      }
    });

    return unsubscribe;
  }, [session, trackConfigs, onIncomingFetch]);

  const addTrackConfig = () => {
    if (!newTrack.namespace || !newTrack.trackName) return;
    if (newTrack.isVod && !newTrack.vodUrl) return;

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
      isVod: newTrack.isVod,
      vodUrl: newTrack.vodUrl,
      vodLoop: newTrack.vodLoop,
    };

    setTrackConfigs([...trackConfigs, config]);
    setNewTrack({
      ...newTrack,
      trackName: '',
      vodUrl: '',
    });
  };

  const removeTrackConfig = (id: string) => {
    setTrackConfigs(trackConfigs.filter(t => t.id !== id));
  };

  const startPublishingTrack = async (config: TrackConfig) => {
    setPublishError(null);

    try {
      // Handle VOD track publishing
      if (config.isVod && config.vodUrl) {
        if (!session) {
          setPublishError('No session available');
          return;
        }

        // Get resolution dimensions
        const getResolutionDimensions = (res: Resolution | undefined) => {
          switch (res) {
            case '4k': return { width: 3840, height: 2160 };
            case '1080p': return { width: 1920, height: 1080 };
            case '720p': return { width: 1280, height: 720 };
            case '480p': return { width: 854, height: 480 };
            default: return { width: 1280, height: 720 };
          }
        };
        const { width, height } = getResolutionDimensions(config.resolution);

        // Create VOD loader and load the video
        const loader = new VODLoader({
          framesPerGroup: 30,
          framerate: config.framerate ?? 30,
          width,
          height,
          bitrate: config.bitrate ?? (config.resolution === '4k' ? 15000000 : 2000000),
          loop: config.vodLoop ?? false,
          codec: config.resolution === '4k' ? 'avc1.640033' : 'avc1.42E01F',
          onProgress: (progress) => {
            setTrackConfigs(prev => prev.map(t =>
              t.id === config.id ? { ...t, vodProgress: progress } : t
            ));
          },
        });

        // Update config with loader
        setTrackConfigs(prev => prev.map(t =>
          t.id === config.id ? { ...t, vodLoader: loader, vodProgress: { phase: 'fetching', progress: 0 } } : t
        ));

        // Load the video
        await loader.load(config.vodUrl);

        // Get publish options from loader
        const publishOptions = loader.getPublishOptions();

        // Publish VOD track
        const trackAlias = await session.publishVOD(
          config.namespace.split('/'),
          config.trackName,
          {
            ...publishOptions,
            priority: config.priority,
            deliveryTimeout: config.deliveryTimeout,
            deliveryMode: config.deliveryMode,
          }
        );

        // Add to published tracks for stats display
        addPublishedTrack({
          id: `pub-${trackAlias.toString()}`,
          type: 'video',
          namespace: config.namespace.split('/'),
          trackName: config.trackName,
          active: true,
          stats: { groupId: 0, objectId: 0, bytesTransferred: 0 },
        });

        setTrackConfigs(prev => prev.map(t =>
          t.id === config.id ? { ...t, isPublishing: true, trackAlias, vodLoader: loader } : t
        ));
        return;
      }

      // Standard live track publishing
      let stream = localStream;
      if (!stream) {
        await startCapture();
        stream = useStore.getState().localStream;
      }

      if (!stream) {
        setPublishError('Failed to capture media');
        return;
      }

      // Each track gets its own video/audio enabled based on its media type
      // These are passed directly to startPublishing, not set globally
      const videoEnabled = config.mediaType === 'video';
      const audioEnabled = config.mediaType === 'audio';

      const trackAlias = await storeStartPublishing(
        config.namespace,
        config.trackName,
        config.deliveryTimeout,
        config.priority,
        config.deliveryMode,
        videoEnabled,
        audioEnabled
      );

      setTrackConfigs(prev => prev.map(t =>
        t.id === config.id ? { ...t, isPublishing: true, trackAlias } : t
      ));
    } catch (err) {
      const error = err as Error;
      console.error('Failed to start publishing:', error);
      setPublishError(error.message);
    }
  };

  const stopPublishingTrack = async (config: TrackConfig) => {
    try {
      if (config.trackAlias !== undefined) {
        await storeStopPublishing(config.trackAlias);
      }
      // Clean up VOD loader if present
      if (config.vodLoader) {
        config.vodLoader.clear();
      }
      setTrackConfigs(prev => prev.map(t =>
        t.id === config.id ? { ...t, isPublishing: false, trackAlias: undefined, vodLoader: undefined, vodProgress: undefined } : t
      ));
    } catch (err) {
      console.error('Failed to stop publishing:', err);
    }
  };

  const videoDevices = devices.filter(d => d.kind === 'videoinput');
  const audioDevices = devices.filter(d => d.kind === 'audioinput');
  const hasPublishingTracks = trackConfigs.some(t => t.isPublishing);

  // State for advanced options visibility
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <div className="space-y-4">
      {/* Media Source - Collapsible: Preview + Devices combined */}
      <CollapsibleSection
        title="Media Source"
        icon={
          <svg className="w-5 h-5 text-accent-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        }
        badge={localStream ? <span className="badge-green text-xs ml-2">Active</span> : null}
        defaultOpen={!localStream}
      >
        <div className="space-y-4">
          {/* Compact Preview - 16:9 aspect ratio */}
          <div className="video-container" style={{ paddingBottom: '56.25%' }}>
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="absolute inset-0 w-full h-full object-cover"
              style={{ display: localStream ? 'block' : 'none' }}
            />
            {!localStream && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-center text-gray-400 dark:text-white/40">
                  <svg className="w-10 h-10 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  <p className="text-sm">No preview</p>
                </div>
              </div>
            )}
          </div>

          {/* Capture Button + VAD inline */}
          <div className="flex items-center gap-4">
            {!localStream ? (
              <button onClick={startCapture} className="btn-primary">
                Start Capture
              </button>
            ) : (
              <button onClick={stopCapture} className="btn-secondary" disabled={hasPublishingTracks}>
                Stop Capture
              </button>
            )}
            {localStream && (
              <div className={`flex items-center gap-2 text-sm ${isSpeaking ? 'text-emerald-400' : 'text-gray-500 dark:text-white/50'}`}>
                <VADIndicator audioContext={audioContext} sourceNode={sourceNode} isSpeaking={isSpeaking} vadResult={vadResult} />
                <VADDot isSpeaking={isSpeaking} />
                <span>{isSpeaking ? 'Speaking' : 'Silent'}</span>
              </div>
            )}
          </div>

          {/* Compact device selection - 3 columns + refresh */}
          <div className="flex items-end gap-3">
            <div className="grid grid-cols-3 gap-3 flex-1">
              <div>
                <label className="label text-xs">Camera</label>
                <select value={selectedVideoDevice} onChange={(e) => setSelectedVideoDevice(e.target.value)} className="input py-2 text-sm" disabled={hasPublishingTracks}>
                  {videoDevices.map(device => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || `Camera ${device.deviceId.slice(0, 6)}`}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label text-xs">Microphone</label>
                <select value={selectedAudioDevice} onChange={(e) => setSelectedAudioDevice(e.target.value)} className="input py-2 text-sm" disabled={hasPublishingTracks}>
                  {audioDevices.map(device => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || `Mic ${device.deviceId.slice(0, 6)}`}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label text-xs">Keyframe</label>
                <select value={keyframeInterval} onChange={(e) => setKeyframeInterval(Number(e.target.value))} className="input py-2 text-sm" disabled={hasPublishingTracks}>
                  <option value={0.5}>0.5s</option>
                  <option value={1}>1s</option>
                  <option value={2}>2s</option>
                  <option value={5}>5s</option>
                </select>
              </div>
            </div>
            <button
              onClick={refreshDevices}
              className="btn-secondary btn-sm py-2"
              title="Refresh device list"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
        </div>
      </CollapsibleSection>

      {/* Add Track - Streamlined form */}
      <div className="glass-panel">
        <div className="glass-panel-header">
          <svg className="w-5 h-5 text-accent-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Track
        </div>
        <div className="glass-panel-body space-y-4">
          {/* VOD Toggle (compact) */}
          {vodPublishEnabled && (
            <label className="flex items-center gap-3 p-3 rounded-xl bg-white/5 border border-white/10 cursor-pointer hover:bg-white/8">
              <input
                type="checkbox"
                checked={newTrack.isVod ?? false}
                onChange={(e) => setNewTrack({ ...newTrack, isVod: e.target.checked, mediaType: 'video' })}
                className="w-4 h-4 rounded border-white/30 bg-white/10 text-accent-cyan focus:ring-accent-cyan"
              />
              <div className="flex-1">
                <span className="text-sm font-medium text-white">VOD Track</span>
                <span className="text-xs text-gray-500 dark:text-white/50 ml-2">from URL</span>
              </div>
            </label>
          )}

          {/* VOD URL (shown when enabled) */}
          {newTrack.isVod && (
            <div className="space-y-2">
              <input
                type="text"
                value={newTrack.vodUrl ?? ''}
                onChange={(e) => setNewTrack({ ...newTrack, vodUrl: e.target.value })}
                placeholder="https://example.com/video.mp4"
                className="input"
              />
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-white/70">
                <input
                  type="checkbox"
                  checked={newTrack.vodLoop ?? false}
                  onChange={(e) => setNewTrack({ ...newTrack, vodLoop: e.target.checked })}
                  className="w-4 h-4 rounded border-white/30 bg-white/10"
                />
                Loop continuously
              </label>
            </div>
          )}

          {/* Essential fields - 2 rows */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label text-xs">Namespace</label>
              <input
                type="text"
                value={newTrack.namespace}
                onChange={(e) => setNewTrack({ ...newTrack, namespace: e.target.value })}
                placeholder="conference/room-1/media"
                className="input py-2"
              />
            </div>
            <div>
              <label className="label text-xs">Track Name</label>
              <input
                type="text"
                value={newTrack.trackName}
                onChange={(e) => setNewTrack({ ...newTrack, trackName: e.target.value })}
                placeholder={newTrack.mediaType === 'video' ? 'user-id/video' : 'user-id/audio'}
                className="input py-2"
              />
            </div>
          </div>

          <div className="grid grid-cols-4 gap-3">
            <div>
              <label className="label text-xs">Type</label>
              <select
                value={newTrack.mediaType}
                onChange={(e) => {
                  const mediaType = e.target.value as MediaType;
                  const deliveryMode: DeliveryMode = mediaType === 'video' ? 'stream' : 'datagram';
                  setNewTrack({ ...newTrack, mediaType, deliveryMode, isVod: mediaType === 'audio' ? false : newTrack.isVod });
                }}
                className="input py-2"
                disabled={newTrack.isVod}
              >
                <option value="video">Video</option>
                <option value="audio">Audio</option>
              </select>
            </div>
            {newTrack.mediaType === 'video' ? (
              <>
                <div>
                  <label className="label text-xs">Resolution</label>
                  <select value={newTrack.resolution} onChange={(e) => setNewTrack({ ...newTrack, resolution: e.target.value as Resolution })} className="input py-2">
                    <option value="4k">4K</option>
                    <option value="1080p">1080p</option>
                    <option value="720p">720p</option>
                    <option value="480p">480p</option>
                  </select>
                </div>
                <div>
                  <label className="label text-xs">FPS</label>
                  <select value={newTrack.framerate} onChange={(e) => setNewTrack({ ...newTrack, framerate: Number(e.target.value) as Framerate })} className="input py-2">
                    <option value={30}>30</option>
                    <option value={24}>24</option>
                    <option value={15}>15</option>
                  </select>
                </div>
                <div>
                  <label className="label text-xs">Bitrate</label>
                  <select value={newTrack.bitrate} onChange={(e) => setNewTrack({ ...newTrack, bitrate: Number(e.target.value) })} className="input py-2">
                    <option value={20000000}>20 Mbps</option>
                    <option value={15000000}>15 Mbps</option>
                    <option value={8000000}>8 Mbps</option>
                    <option value={4000000}>4 Mbps</option>
                    <option value={2000000}>2 Mbps</option>
                    <option value={1000000}>1 Mbps</option>
                  </select>
                </div>
              </>
            ) : (
              <>
                <div>
                  <label className="label text-xs">Bitrate</label>
                  <select value={newTrack.bitrate} onChange={(e) => setNewTrack({ ...newTrack, bitrate: Number(e.target.value) })} className="input py-2">
                    <option value={128000}>128 kbps</option>
                    <option value={96000}>96 kbps</option>
                    <option value={64000}>64 kbps</option>
                  </select>
                </div>
                <div className="col-span-2" />
              </>
            )}
          </div>

          {/* Advanced Options Toggle */}
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-2 text-sm text-gray-500 dark:text-white/50 hover:text-gray-700 dark:text-white/70 transition-colors"
          >
            <svg className={`w-4 h-4 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
            Advanced Options
          </button>

          {/* Advanced Options (collapsed by default) */}
          {showAdvanced && (
            <div className="grid grid-cols-3 gap-3 p-3 rounded-xl bg-white/5 border border-white/5">
              <div>
                <label className="label text-xs">Delivery Mode</label>
                <select value={newTrack.deliveryMode} onChange={(e) => setNewTrack({ ...newTrack, deliveryMode: e.target.value as DeliveryMode })} className="input py-2">
                  <option value="stream">Stream</option>
                  <option value="datagram">Datagram</option>
                </select>
              </div>
              <div>
                <label className="label text-xs">Timeout (ms)</label>
                <input type="number" value={newTrack.deliveryTimeout} onChange={(e) => setNewTrack({ ...newTrack, deliveryTimeout: Number(e.target.value) })} min={0} className="input py-2" />
              </div>
              <div>
                <label className="label text-xs">Priority</label>
                <input type="number" value={newTrack.priority} onChange={(e) => setNewTrack({ ...newTrack, priority: Number(e.target.value) })} min={0} max={255} className="input py-2" />
              </div>
            </div>
          )}

          <button
            onClick={addTrackConfig}
            disabled={!newTrack.namespace || !newTrack.trackName || (newTrack.isVod && !newTrack.vodUrl)}
            className="btn-primary w-full"
          >
            Add {newTrack.isVod ? 'VOD ' : ''}Track
          </button>
        </div>
      </div>

      {/* Configured Tracks - Always visible when tracks exist */}
      {trackConfigs.length > 0 && (
        <div className="glass-panel">
          <div className="glass-panel-header justify-between">
            <div className="flex items-center gap-3">
              <svg className="w-5 h-5 text-accent-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              <span>Tracks</span>
              <span className="badge-blue text-xs">{trackConfigs.length}</span>
            </div>
          </div>
          <div className="glass-panel-body space-y-2">
            {publishError && (
              <div className="p-3 rounded-lg bg-red-500/20 border border-red-500/30 text-red-300 text-sm">
                {publishError}
              </div>
            )}
            {trackConfigs.map(config => (
              <div key={config.id} className="p-3 rounded-xl bg-white/5 border border-white/5 hover:border-white/10 transition-colors">
                {/* Compact track row */}
                <div className="flex items-center gap-3">
                  {/* Icon */}
                  {config.mediaType === 'video' ? (
                    <svg className="w-5 h-5 text-blue-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5 text-emerald-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                  )}

                  {/* Track info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-white truncate">{config.trackName}</span>
                      {secureObjectsEnabled && (
                        <svg className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                        </svg>
                      )}
                      {config.isVod && <span className="badge-blue text-xs py-0.5">VOD</span>}
                    </div>
                    <div className="text-xs text-gray-400 dark:text-white/40 truncate">{config.namespace}</div>
                  </div>

                  {/* Specs badges */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {config.mediaType === 'video' && (
                      <>
                        <span className="text-xs text-gray-500 dark:text-white/50">{config.resolution}</span>
                        <span className="text-gray-200 dark:text-white/20">·</span>
                        <span className="text-xs text-gray-500 dark:text-white/50">{config.framerate}fps</span>
                        <span className="text-gray-200 dark:text-white/20">·</span>
                        <span className="text-xs text-gray-500 dark:text-white/50">{((config.bitrate || 0) / 1000000).toFixed(0)}M</span>
                      </>
                    )}
                    {config.mediaType === 'audio' && (
                      <span className="text-xs text-gray-500 dark:text-white/50">{((config.bitrate || 0) / 1000)}kbps</span>
                    )}
                  </div>

                  {/* Status badge */}
                  <span className={`flex-shrink-0 ${
                    config.isPublishing
                      ? (useAnnounceFlow && announceStatus === 'waiting' ? 'badge-yellow' : 'badge-green')
                      : 'badge-gray'
                  }`}>
                    {config.isPublishing
                      ? (useAnnounceFlow && announceStatus === 'waiting' ? 'Waiting' :
                         useAnnounceFlow && announceStatus === 'announcing' ? 'Announcing' : 'Live')
                      : 'Ready'}
                  </span>

                  {/* Actions */}
                  <div className="flex gap-1.5 flex-shrink-0">
                    {!config.isPublishing ? (
                      <button onClick={() => startPublishingTrack(config)} disabled={sessionState !== 'ready'} className="btn-success btn-sm py-1.5 px-3">
                        Publish
                      </button>
                    ) : (
                      <button onClick={() => stopPublishingTrack(config)} className="btn-danger btn-sm py-1.5 px-3">
                        Stop
                      </button>
                    )}
                    <button onClick={() => removeTrackConfig(config.id)} disabled={config.isPublishing} className="btn-secondary btn-sm py-1.5 px-2">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* VOD Progress (if applicable) */}
                {config.vodProgress && config.vodProgress.phase !== 'complete' && (
                  <div className="mt-2 flex items-center gap-2 text-xs text-gray-500 dark:text-white/50">
                    <span className="capitalize">{config.vodProgress.phase}</span>
                    <div className="flex-1 h-1 bg-white/10 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all ${config.vodProgress.phase === 'error' ? 'bg-red-500' : 'bg-accent-cyan'}`}
                        style={{ width: `${config.vodProgress.progress}%` }}
                      />
                    </div>
                    <span>{config.vodProgress.progress}%</span>
                  </div>
                )}

                {/* VOD Local Playback (when subscriber connects) */}
                {config.vodPlaybackUrl && config.vodIsPlaying && (
                  <div className="mt-3">
                    <div className="flex items-center gap-2 text-xs text-emerald-400 mb-2">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <span>Local playback (subscriber connected)</span>
                    </div>
                    <div className="video-container" style={{ paddingBottom: '56.25%' }}>
                      <video
                        ref={(el) => {
                          if (el) vodVideoRefs.current.set(config.id, el);
                        }}
                        src={config.vodPlaybackUrl}
                        autoPlay
                        muted
                        loop={config.vodLoop}
                        playsInline
                        className="absolute inset-0 w-full h-full object-cover rounded-lg"
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Status Sections - Only shown when relevant */}
      {(useAnnounceFlow && announceStatus !== 'idle') && (
        <div className="glass-panel-subtle p-4">
          <div className="flex items-center gap-3">
            {announceStatus === 'announcing' && (
              <>
                <div className="animate-spin h-4 w-4 border-2 border-accent-cyan border-t-transparent rounded-full" />
                <span className="text-sm text-gray-700 dark:text-white/70">Announcing namespace...</span>
              </>
            )}
            {announceStatus === 'waiting' && (
              <>
                <div className="animate-pulse h-4 w-4 bg-amber-400 rounded-full" />
                <span className="text-sm text-gray-700 dark:text-white/70">Waiting for subscribers...</span>
                {trackConfigs.length > 0 && trackConfigs[0].namespace && (
                  <button onClick={() => cancelAnnounce(trackConfigs[0].namespace)} className="btn-ghost btn-sm ml-auto py-1 px-2 text-xs">
                    Cancel
                  </button>
                )}
              </>
            )}
            {announceStatus === 'active' && (
              <>
                <div className="h-4 w-4 bg-emerald-400 rounded-full" />
                <span className="text-sm text-emerald-400">Publishing to subscribers</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Publishing Stats - Collapsible */}
      {publishedTracks.length > 0 && (
        <CollapsibleSection
          title="Publishing Stats"
          icon={
            <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          }
          badge={<span className="badge-green text-xs ml-2">{publishedTracks.length} active</span>}
        >
          <div className="space-y-2">
            {publishedTracks.map(track => (
              <div key={track.id} className="flex items-center justify-between p-2 rounded-lg bg-white/5">
                <div className="flex items-center gap-2">
                  {track.type === 'video' ? (
                    <svg className="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                  )}
                  <span className="text-sm text-gray-800 dark:text-white/80">{track.trackName}</span>
                </div>
                {isDebugMode() && (
                  <span className="text-xs text-gray-400 dark:text-white/40 font-mono">G:{track.stats.groupId} O:{track.stats.objectId}</span>
                )}
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
};
