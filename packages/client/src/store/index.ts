// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Zustand State Management
 *
 * Centralized state management for the MOQT client application.
 * Uses Zustand slices for connection, publishing, subscribing,
 * chat, and settings.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { MOQTransport, Logger, LogLevel as CoreLogLevel, VarIntType, setVarIntType } from '@web-moq/core';
import type { VADProvider, ExperienceProfileName } from '@web-moq/media';
import {
  MediaSession,
  type SessionState,
  type MediaConfig,
  type WorkerConfig,
  EXPERIENCE_PROFILES,
  detectCurrentProfile,
  createVodFetchController,
  type VodFetchController,
} from '@web-moq/media';
import { TransportState, LogLevel } from '../types';
import { isDebugMode } from '../components/common/DevSettingsPanel';

/**
 * Create workers for offloading transport/encoding/decoding to web workers.
 * Workers are created once and reused across sessions.
 */
let workers: WorkerConfig | undefined;

function getWorkers(): WorkerConfig {
  if (!workers) {
    log.info('Creating transport, encode, and decode workers');
    workers = {
      transportWorker: new Worker(
        new URL('../workers/transport-worker.ts', import.meta.url),
        { type: 'module' }
      ),
      encodeWorker: new Worker(
        new URL('../workers/codec-encode-worker.ts', import.meta.url),
        { type: 'module' }
      ),
      decodeWorker: new Worker(
        new URL('../workers/codec-decode-worker.ts', import.meta.url),
        { type: 'module' }
      ),
    };
    log.info('Workers created', {
      hasTransportWorker: !!workers.transportWorker,
      hasEncodeWorker: !!workers.encodeWorker,
      hasDecodeWorker: !!workers.decodeWorker,
    });
  }
  return workers;
}

// Simple logger for now - will use moqt-core Logger when built
const log = {
  info: (msg: string, data?: unknown) => console.log(`[moqt:client:store] ${msg}`, data),
  warn: (msg: string, data?: unknown) => console.warn(`[moqt:client:store] ${msg}`, data),
  error: (msg: string, data?: unknown) => console.error(`[moqt:client:store] ${msg}`, data),
};

// Module-level storage for VOD fetch controllers (keyed by subscriptionId)
// These manage adaptive buffer-aware fetching for VOD content
const vodFetchControllers = new Map<number, VodFetchController>();

interface TransportConfig {
  serverCertificateHashes?: ArrayBuffer[];
  connectionTimeout?: number;
}

// Transport factory - can be set at runtime when moqt-transport is loaded
let createTransport: (config?: TransportConfig) => MOQTransport = () => {
  throw new Error('MOQTransport not initialized. Call setTransportFactory() first.');
};

/**
 * Set the transport factory function
 * This should be called from main.tsx after importing moqt-transport
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setTransportFactory(factory: (config?: TransportConfig) => any): void {
  createTransport = factory;
}

/**
 * Fetch pre-computed certificate fingerprint for WebTransport
 * The fingerprint is a raw binary SHA-256 hash of the DER-encoded certificate
 */
async function fetchCertificateHash(): Promise<ArrayBuffer> {
  const response = await fetch('/certificate_fingerprint.hex');
  const hash = await response.arrayBuffer();

  // Debug: log the hash as base64
  const hashArray = new Uint8Array(hash);
  const hashBase64 = btoa(String.fromCharCode(...hashArray));
  log.info('Certificate fingerprint (base64)', hashBase64);
  log.info('Certificate fingerprint (bytes)', hashArray.byteLength);

  return hash;
}

// ============================================================================
// Types
// ============================================================================

export interface MediaTrack {
  id: string;
  type: 'video' | 'audio';
  namespace: string[];
  trackName: string;
  active: boolean;
  stats: {
    groupId: number;
    objectId: number;
    bytesTransferred: number;
  };
}

export interface ChatMessage {
  id: string;
  participantId: string;
  displayName: string;
  content: string;
  timestamp: number;
}

export interface Participant {
  id: string;
  displayName: string;
  lastSeen: number;
}

// ============================================================================
// Decode Error Tracking
// ============================================================================

/** Decode error entry with diagnostic information */
export interface DecodeErrorEntry {
  id: number;
  message: string;
  timestamp: number;
  diagnostics?: {
    mediaType: 'video' | 'audio';
    groupId?: number;
    objectId?: number;
    isKeyframe?: boolean;
    dataSize?: number;
    sequence?: number;
    framesDecodedBefore: number;
    keyframesReceived: number;
    hadKeyframe: boolean;
  };
}

// ============================================================================
// Connection Slice
// ============================================================================

interface ConnectionSlice {
  transport: MOQTransport | null;
  session: MediaSession | null;
  state: TransportState;
  sessionState: SessionState;
  serverUrl: string;
  error: string | null;
  /** Recent decode errors with diagnostics (max 10, newest first) */
  decodeErrors: DecodeErrorEntry[];
  /** Add a decode error */
  addDecodeError: (message: string, diagnostics?: DecodeErrorEntry['diagnostics']) => void;
  /** Clear all decode errors */
  clearDecodeErrors: () => void;

  connect: (url: string) => Promise<void>;
  disconnect: () => Promise<void>;
  setServerUrl: (url: string) => void;

  // Publish/Subscribe methods that delegate to session
  startPublishing: (namespace: string, trackName: string, deliveryTimeout?: number, priority?: number, deliveryMode?: 'stream' | 'datagram', videoEnabled?: boolean, audioEnabled?: boolean) => Promise<bigint>;
  stopPublishing: (trackAlias: bigint | string) => Promise<void>;
  // Announce flow methods
  announceNamespace: (namespace: string) => Promise<void>;
  cancelAnnounce: (namespace: string) => Promise<void>;
  /** Status for announce flow UI */
  announceStatus: 'idle' | 'announcing' | 'waiting' | 'active';
  /** Pending stream for announce flow (waiting for subscribers) */
  pendingAnnounceStream: MediaStream | null;
  pendingAnnounceConfig: {
    namespace: string;
    trackName: string;
    deliveryTimeout?: number;
    priority?: number;
    deliveryMode?: 'stream' | 'datagram';
    /** Track type enabled from panel - overrides stream track detection */
    videoEnabled?: boolean;
    audioEnabled?: boolean;
  } | null;
  startSubscription: (namespace: string, trackName: string, mediaType?: 'video' | 'audio', videoConfig?: { codec?: string; width?: number; height?: number }, isLive?: boolean, catalogFramerate?: number, catalogGopDuration?: number) => Promise<number>;
  /** Start VOD subscription using FETCH with adaptive buffer management */
  startVodSubscription: (namespace: string, trackName: string, mediaType: 'video' | 'audio', videoConfig: { codec?: string; width?: number; height?: number } | undefined, trackInfo: { framerate?: number; gopDuration?: number; totalGroups?: number }, bufferConfig?: { initialBufferSec?: number; minBufferSec?: number; fetchBatchSec?: number }, startGroup?: number) => Promise<number>;
  /** Standalone FETCH for previously published content (no media pipeline) */
  fetchTrack: (
    namespace: string,
    trackName: string,
    startGroup: number,
    endGroup: number,
    onData: (data: Uint8Array, groupId: number, objectId: number) => void
  ) => Promise<{ requestId: number; cancel: () => Promise<void> }>;
  stopSubscription: (subscriptionId: number) => Promise<void>;
  pauseSubscription: (subscriptionId: number) => Promise<void>;
  resumeSubscription: (subscriptionId: number) => Promise<void>;
  isSubscriptionPaused: (subscriptionId: number) => boolean;
  seekSubscription: (subscriptionId: number, timeMs: number) => Promise<void>;

  // Video frame handler registration
  onVideoFrame: (handler: (data: { subscriptionId: number; frame: VideoFrame }) => void) => () => void;
  // Audio data handler registration
  onAudioData: (handler: (data: { subscriptionId: number; audioData: AudioData }) => void) => () => void;
  // Subscribe stats handler registration (groupId, objectId, bytes per object received)
  onSubscribeStats: (handler: (data: { subscriptionId: number; groupId: number; objectId: number; bytes: number }) => void) => () => void;
  // Jitter sample handler registration (only active when enableStats is true)
  onJitterSample: (handler: (data: { subscriptionId: number; sample: { interArrivalTimes: number[]; avgJitter: number; maxJitter: number } }) => void) => () => void;
  // Latency stats handler registration (only active when enableStats is true)
  onLatencyStats: (handler: (data: { subscriptionId: number; stats: { processingDelay: number; bufferDepth: number; bufferDelay: number } }) => void) => () => void;
  // Incoming FETCH event handler (for VOD publisher local playback)
  onIncomingFetch: (handler: (data: { namespace: string[]; trackName: string; startGroup: number; endGroup: number }) => void) => () => void;
}

// ============================================================================
// Publish Slice
// ============================================================================

interface PublishSlice {
  publishedTracks: MediaTrack[];
  localStream: MediaStream | null;
  isPublishing: boolean;
  videoEnabled: boolean;
  audioEnabled: boolean;

  setLocalStream: (stream: MediaStream | null) => void;
  addPublishedTrack: (track: MediaTrack) => void;
  removePublishedTrack: (id: string) => void;
  updateTrackStats: (id: string, stats: MediaTrack['stats']) => void;
  setIsPublishing: (value: boolean) => void;
  setVideoEnabled: (value: boolean) => void;
  setAudioEnabled: (value: boolean) => void;
}

// ============================================================================
// Subscribe Slice
// ============================================================================

interface SubscribeSlice {
  subscribedTracks: MediaTrack[];
  availableTracks: Array<{ namespace: string[]; trackName: string }>;

  addSubscribedTrack: (track: MediaTrack) => void;
  removeSubscribedTrack: (id: string) => void;
  setAvailableTracks: (tracks: Array<{ namespace: string[]; trackName: string }>) => void;
  updateSubscribedTrackStats: (id: string, stats: MediaTrack['stats']) => void;
}

// ============================================================================
// Namespace Subscription Slice
// ============================================================================

/** Track discovered under a namespace subscription */
interface DiscoveredTrack {
  /** Full namespace */
  namespace: string[];
  /** Track name (e.g., "video", "audio", "chat") */
  trackName: string;
  /** Track alias for receiving objects */
  trackAlias: bigint;
  /** Internal subscription ID for object routing */
  subscriptionId?: number;
  /** Track type inferred from trackName */
  type: 'video' | 'audio' | 'chat' | 'unknown';
}

/** A namespace subscription panel */
interface NamespaceSubscriptionPanel {
  /** Panel ID */
  id: string;
  /** Namespace prefix being subscribed to */
  namespacePrefix: string;
  /** Session's namespace subscription ID */
  subscriptionId?: number;
  /** Whether subscription is active */
  isActive: boolean;
  /** Tracks discovered under this namespace */
  tracks: DiscoveredTrack[];
}

interface NamespaceSubscribeSlice {
  /** Active namespace subscription panels */
  namespaceSubscriptions: NamespaceSubscriptionPanel[];

  /** Add a new namespace subscription panel */
  addNamespacePanel: (namespacePrefix: string) => string;
  /** Remove a namespace subscription panel */
  removeNamespacePanel: (panelId: string) => void;
  /** Start subscription for a panel */
  startNamespaceSubscription: (panelId: string) => Promise<void>;
  /** Stop subscription for a panel */
  stopNamespaceSubscription: (panelId: string) => Promise<void>;
  /** Add discovered track to a panel */
  addDiscoveredTrack: (panelId: string, track: DiscoveredTrack) => void;
  /** Get panel by subscription ID */
  getPanelBySubscriptionId: (subscriptionId: number) => NamespaceSubscriptionPanel | undefined;
}

// ============================================================================
// Chat Slice
// ============================================================================

interface ChatSlice {
  messages: ChatMessage[];
  participants: Participant[];
  participantId: string;
  displayName: string;

  addMessage: (message: ChatMessage) => void;
  clearMessages: () => void;
  setDisplayName: (name: string) => void;
  addParticipant: (participant: Participant) => void;
  removeParticipant: (id: string) => void;
  updateParticipantLastSeen: (id: string) => void;
}

// ============================================================================
// Settings Slice
// ============================================================================

interface SettingsSlice {
  theme: 'light' | 'dark' | 'system';
  logLevel: LogLevel;
  videoBitrate: number;
  audioBitrate: number;
  videoResolution: '720p' | '1080p' | '480p';
  keyframeInterval: number;
  deliveryMode: 'stream' | 'datagram';
  localDevelopment: boolean;
  useWorkers: boolean;
  /** Use announce flow (PUBLISH_NAMESPACE) instead of direct PUBLISH */
  useAnnounceFlow: boolean;
  /** Connection timeout in milliseconds (default: 300000 = 5 minutes) */
  connectionTimeout: number;
  /** Enable jitter/network stats collection and display */
  enableStats: boolean;
  /** Jitter buffer delay in milliseconds */
  jitterBufferDelay: number;
  /** VarInt encoding type (QUIC or MOQT) */
  varIntType: VarIntType;
  /** Enable Voice Activity Detection */
  vadEnabled: boolean;
  /** VAD provider to use */
  vadProvider: VADProvider;
  /** Enable VAD visualization (audio bars) */
  vadVisualizationEnabled: boolean;
  /** Audio delivery mode: datagram (low latency) or stream (reliable) */
  audioDeliveryMode: 'datagram' | 'stream';
  /** Selected experience profile for subscriber-side settings */
  experienceProfile: ExperienceProfileName;
  /** Use GroupArbiter for group-aware jitter buffering (handles parallel QUIC streams) */
  useGroupArbiter: boolean;
  /**
   * Policy type for frame release strategy (new PlayoutBuffer architecture)
   * - 'vod': Sequential playback, no skipping (for DVR/recorded content)
   * - 'live': Deadline-based with jitter buffer (for real-time streaming)
   * - 'adaptive': Auto-detect from catalog isLive or arrival patterns
   */
  policyType: 'vod' | 'live' | 'adaptive';
  /** Maximum acceptable latency before skipping to next keyframe (ms) */
  maxLatency: number;
  /** Initial estimated GOP duration (ms) */
  estimatedGopDuration: number;
  /** Skip to latest group immediately when a new group arrives (aggressive catch-up) */
  skipToLatestGroup: boolean;
  /** Number of frame intervals to wait before skipping to latest group (grace period) */
  skipGraceFrames: number;
  /** Enable catch-up mode when buffer gets too deep */
  enableCatchUp: boolean;
  /** Number of ready frames that triggers catch-up mode */
  catchUpThreshold: number;
  /** Use latency-only deadline (true=interactive, false=streaming) */
  useLatencyDeadline: boolean;
  /** Enable GroupArbiter debug logging */
  arbiterDebug: boolean;
  /** Enable Secure Objects encryption */
  secureObjectsEnabled: boolean;
  /** Secure Objects cipher suite (hex string, e.g., "0x0004") */
  secureObjectsCipherSuite: string;
  /** Track base key for encryption (hex string, 32-64 hex chars = 16-32 bytes) */
  secureObjectsBaseKey: string;
  /** Enable QuicR-Mac interop mode (fixed-size LOC extensions) */
  quicrInteropEnabled: boolean;
  /** Participant ID for QuicR interop (32-bit) */
  quicrParticipantId: number;
  /** Enable VOD publishing mode (load video from URL) */
  vodPublishEnabled: boolean;

  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  setLogLevel: (level: LogLevel) => void;
  setVideoBitrate: (bitrate: number) => void;
  setAudioBitrate: (bitrate: number) => void;
  setVideoResolution: (resolution: '720p' | '1080p' | '480p') => void;
  setKeyframeInterval: (seconds: number) => void;
  setDeliveryMode: (mode: 'stream' | 'datagram') => void;
  setLocalDevelopment: (value: boolean) => void;
  setUseWorkers: (value: boolean) => void;
  setUseAnnounceFlow: (value: boolean) => void;
  setConnectionTimeout: (value: number) => void;
  setEnableStats: (value: boolean) => void;
  setJitterBufferDelay: (value: number) => void;
  setVarIntType: (type: VarIntType) => void;
  setVadEnabled: (value: boolean) => void;
  setVadProvider: (provider: VADProvider) => void;
  setVadVisualizationEnabled: (value: boolean) => void;
  setAudioDeliveryMode: (mode: 'datagram' | 'stream') => void;
  setUseGroupArbiter: (value: boolean) => void;
  setPolicyType: (value: 'vod' | 'live' | 'adaptive') => void;
  setMaxLatency: (value: number) => void;
  setEstimatedGopDuration: (value: number) => void;
  setSkipToLatestGroup: (value: boolean) => void;
  setSkipGraceFrames: (value: number) => void;
  setEnableCatchUp: (value: boolean) => void;
  setCatchUpThreshold: (value: number) => void;
  setUseLatencyDeadline: (value: boolean) => void;
  setArbiterDebug: (value: boolean) => void;
  setSecureObjectsEnabled: (value: boolean) => void;
  setSecureObjectsCipherSuite: (value: string) => void;
  setSecureObjectsBaseKey: (value: string) => void;
  setQuicrInteropEnabled: (value: boolean) => void;
  setQuicrParticipantId: (value: number) => void;
  setVodPublishEnabled: (value: boolean) => void;
  /** Apply an experience profile (sets all related settings) */
  applyExperienceProfile: (profile: ExperienceProfileName) => void;
  /** Update detected profile based on current settings */
  updateDetectedProfile: () => void;
}

// ============================================================================
// Combined Store
// ============================================================================

type AppStore = ConnectionSlice & PublishSlice & SubscribeSlice & NamespaceSubscribeSlice & ChatSlice & SettingsSlice;

export const useStore = create<AppStore>()(
  persist(
    (set, get) => ({
      // ========================================
      // Connection State
      // ========================================
      transport: null,
      session: null,
      state: 'disconnected',
      sessionState: 'none',
      serverUrl: 'https://localhost:4443/moq',
      error: null,
      decodeErrors: [],
      // Announce flow state
      announceStatus: 'idle',
      pendingAnnounceStream: null,
      pendingAnnounceConfig: null,

      connect: async (url: string) => {
        const { transport: existingTransport, session: existingSession, localDevelopment, useWorkers } = get();
        if (existingSession) {
          await existingSession.close();
        }
        if (existingTransport) {
          await existingTransport.close();
        }

        // Fetch certificate hash if local development mode is enabled
        let serverCertificateHashes: ArrayBuffer[] | undefined;
        if (localDevelopment) {
          try {
            log.info('Local development mode: fetching certificate hash');
            const hash = await fetchCertificateHash();
            serverCertificateHashes = [hash];
          } catch (err) {
            log.error('Failed to fetch certificate hash', err);
            // Continue without cert hash - connection may still work with trusted certs
          }
        }

        let transport: MOQTransport | null = null;
        let session: MediaSession;

        try {
          set({ state: 'connecting', error: null, serverUrl: url });

          if (useWorkers) {
            // Worker mode: Transport runs in a web worker
            log.info('Using worker mode for transport + encoding/decoding');

            session = new MediaSession({
              workers: getWorkers(),
              serverCertificateHashes,
              connectionTimeout: get().connectionTimeout,
            });

            // Connect via the transport worker
            await session.connect(url);
            log.info('Connected to relay via transport worker', { url });
          } else {
            // Main thread mode: Transport runs on main thread
            log.info('Using main thread mode');

            transport = createTransport({
              serverCertificateHashes,
              connectionTimeout: get().connectionTimeout,
            });

            transport.on('state-change', (newState: unknown) => {
              set({ state: newState as TransportState });
            });

            transport.on('error', (err: unknown) => {
              const error = err as Error;
              log.error('Transport error', error);
              set({ error: error.message });
            });

            await transport.connect(url);
            log.info('Connected to relay', { url });

            // Create MediaSession with main thread transport (no workers)
            session = new MediaSession(transport);
          }

          set({ transport, state: 'connected' });
          log.info('MediaSession created', { useWorkers });

          session.on('state-change', (sessionState) => {
            set({ sessionState });
            // When session state changes to 'error', update transport state to trigger UI transition
            if (sessionState === 'error') {
              set({ state: 'disconnected' });
            }
          });

          session.on('error', (err) => {
            log.error('Session error', err);
            // Check if this is a DecodeError with diagnostics
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const decodeErr = err as any;
            if (decodeErr.name === 'DecodeError' && decodeErr.diagnostics) {
              get().addDecodeError(err.message, decodeErr.diagnostics);
            } else {
              set({ error: err.message });
            }
          });

          // Listen for publish stats to update track stats
          session.on('publish-stats', (stats) => {
            const { publishedTracks } = get();
            const track = publishedTracks.find(t => t.id === `pub-${stats.trackAlias}`);
            if (track) {
              get().updateTrackStats(track.id, {
                groupId: stats.groupId,
                objectId: stats.objectId,
                bytesTransferred: track.stats.bytesTransferred + stats.bytes,
              });
            }
          });

          // Listen for subscribe stats to update subscribed track stats (only in debug mode)
          if (isDebugMode()) {
            session.on('subscribe-stats', (stats) => {
              const { subscribedTracks } = get();
              const track = subscribedTracks.find(t => t.id === `sub-${stats.subscriptionId}`);
              if (track) {
                get().updateSubscribedTrackStats(track.id, {
                  groupId: stats.groupId,
                  objectId: stats.objectId,
                  bytesTransferred: track.stats.bytesTransferred + stats.bytes,
                });
              }
            });
          }

          // Listen for incoming subscriptions (announce flow)
          session.on('incoming-subscribe', async (event) => {
            log.info('Incoming subscription (announce flow)', {
              requestId: event.requestId,
              namespace: event.namespace.join('/'),
              trackName: event.trackName,
              trackAlias: event.trackAlias.toString(),
            });

            const { pendingAnnounceStream, pendingAnnounceConfig, videoBitrate, audioBitrate, videoResolution, keyframeInterval, audioDeliveryMode, secureObjectsEnabled, secureObjectsCipherSuite, secureObjectsBaseKey, quicrInteropEnabled, quicrParticipantId } = get();

            if (pendingAnnounceStream && pendingAnnounceConfig) {
              try {
                // Check what tracks the stream actually has
                const hasVideoTracks = pendingAnnounceStream.getVideoTracks().length > 0;
                const hasAudioTracks = pendingAnnounceStream.getAudioTracks().length > 0;

                // Use the panel's explicit track type config, but only if the stream has those tracks
                // This respects the panel's intent (e.g., user selected "video" track type)
                // rather than using global settings which may not match the panel's configuration
                const videoEnabled = (pendingAnnounceConfig.videoEnabled ?? hasVideoTracks) && hasVideoTracks;
                const audioEnabled = (pendingAnnounceConfig.audioEnabled ?? hasAudioTracks) && hasAudioTracks;

                // Start publishing on this track
                const config = {
                  videoBitrate,
                  audioBitrate,
                  videoResolution,
                  keyframeInterval,
                  deliveryTimeout: pendingAnnounceConfig.deliveryTimeout ?? 5000,
                  priority: pendingAnnounceConfig.priority ?? 128,
                  deliveryMode: pendingAnnounceConfig.deliveryMode ?? 'stream',
                  audioDeliveryMode,
                  videoEnabled,
                  audioEnabled,
                  // Secure Objects encryption settings
                  secureObjectsEnabled,
                  secureObjectsCipherSuite,
                  secureObjectsBaseKey,
                  // QuicR-Mac interop settings
                  quicrInteropEnabled,
                  quicrParticipantId,
                };

                await session.startAnnouncePublish(
                  event.trackAlias,
                  event.namespace,
                  event.trackName,
                  pendingAnnounceStream,
                  config
                );

                // Add to published tracks (determine type based on what's actually enabled)
                const trackType = config.videoEnabled ? 'video' : 'audio';
                get().addPublishedTrack({
                  id: `pub-${event.trackAlias.toString()}`,
                  type: trackType,
                  namespace: event.namespace,
                  trackName: event.trackName,
                  active: true,
                  stats: { groupId: 0, objectId: 0, bytesTransferred: 0 },
                });

                set({ announceStatus: 'active' });
                log.info('Started publishing for subscriber (announce flow)', {
                  trackAlias: event.trackAlias.toString(),
                });
              } catch (err) {
                log.error('Failed to start announce publish', err);
                set({ error: (err as Error).message });
              }
            } else {
              log.warn('Incoming subscription but no pending stream', {
                hasPendingStream: !!pendingAnnounceStream,
                hasPendingConfig: !!pendingAnnounceConfig,
              });
            }
          });

          // Handle incoming PUBLISH (subscribe namespace flow)
          session.on('incoming-publish', (event) => {
            log.info('Incoming publish (subscribe namespace flow)', {
              namespaceSubscriptionId: event.namespaceSubscriptionId,
              namespace: event.namespace.join('/'),
              trackName: event.trackName,
              trackAlias: event.trackAlias.toString(),
            });

            // Find the panel for this namespace subscription
            const panel = get().getPanelBySubscriptionId(event.namespaceSubscriptionId);
            if (!panel) {
              log.warn('No panel found for namespace subscription', {
                namespaceSubscriptionId: event.namespaceSubscriptionId,
              });
              return;
            }

            // Determine track type from trackName
            let trackType: 'video' | 'audio' | 'chat' | 'unknown' = 'unknown';
            const trackNameLower = event.trackName.toLowerCase();
            if (trackNameLower.includes('video')) {
              trackType = 'video';
            } else if (trackNameLower.includes('audio')) {
              trackType = 'audio';
            } else if (trackNameLower.includes('chat')) {
              trackType = 'chat';
            }

            // Add to discovered tracks
            get().addDiscoveredTrack(panel.id, {
              namespace: event.namespace,
              trackName: event.trackName,
              trackAlias: event.trackAlias,
              subscriptionId: event.subscriptionId,
              type: trackType,
            });

            log.info('Added discovered track', {
              panelId: panel.id,
              trackName: event.trackName,
              trackType,
              trackAlias: event.trackAlias.toString(),
            });
          });

          set({ session, sessionState: 'setup' });

          // Perform MOQT session setup
          await session.setup();
          log.info('MOQT session established');
        } catch (err) {
          const error = err as Error;
          log.error('Connection failed', error);
          set({ error: error.message, state: 'failed', sessionState: 'error' });
          throw err;
        }
      },

      disconnect: async () => {
        const { transport, session, localStream, pendingAnnounceStream } = get();
        if (session) {
          await session.close();
        }
        if (transport) {
          await transport.close();
        }
        // Stop camera/microphone capture
        if (localStream) {
          localStream.getTracks().forEach(track => track.stop());
        }
        if (pendingAnnounceStream) {
          pendingAnnounceStream.getTracks().forEach(track => track.stop());
        }
        set({ transport: null, session: null, state: 'disconnected', sessionState: 'none', localStream: null, pendingAnnounceStream: null, publishedTracks: [], subscribedTracks: [], namespaceSubscriptions: [] });
      },

      setServerUrl: (url: string) => set({ serverUrl: url }),

      addDecodeError: (message: string, diagnostics?: DecodeErrorEntry['diagnostics']) => {
        const { decodeErrors } = get();
        const newError: DecodeErrorEntry = {
          id: Date.now(),
          message,
          timestamp: Date.now(),
          diagnostics,
        };
        // Keep max 10 errors, newest first
        const updated = [newError, ...decodeErrors].slice(0, 10);
        set({ decodeErrors: updated });
      },

      clearDecodeErrors: () => set({ decodeErrors: [] }),

      startPublishing: async (namespace: string, trackName: string, deliveryTimeout?: number, priority?: number, deliveryMode?: 'stream' | 'datagram', videoEnabled?: boolean, audioEnabled?: boolean) => {
        const { session, localStream, videoBitrate, audioBitrate, videoResolution, keyframeInterval, videoEnabled: globalVideoEnabled, audioEnabled: globalAudioEnabled, useAnnounceFlow, audioDeliveryMode } = get();
        if (!session) {
          throw new Error('No session');
        }
        if (!localStream) {
          throw new Error('No local stream');
        }

        // Use passed parameters if provided, otherwise fall back to global state
        const effectiveVideoEnabled = videoEnabled ?? globalVideoEnabled;
        const effectiveAudioEnabled = audioEnabled ?? globalAudioEnabled;

        // Check what tracks the stream actually has
        const hasVideoTracks = localStream.getVideoTracks().length > 0;
        const hasAudioTracks = localStream.getAudioTracks().length > 0;

        const { secureObjectsEnabled, secureObjectsCipherSuite, secureObjectsBaseKey, quicrInteropEnabled, quicrParticipantId } = get();
        const config: MediaConfig = {
          videoBitrate,
          audioBitrate,
          videoResolution,
          keyframeInterval,
          deliveryTimeout: deliveryTimeout ?? 5000,
          priority: priority ?? 128,
          deliveryMode: deliveryMode ?? 'stream',
          audioDeliveryMode,
          // Only enable video/audio if both the setting is enabled AND the stream has those tracks
          videoEnabled: effectiveVideoEnabled && hasVideoTracks,
          audioEnabled: effectiveAudioEnabled && hasAudioTracks,
          // Secure Objects encryption settings
          secureObjectsEnabled,
          secureObjectsCipherSuite,
          secureObjectsBaseKey,
          // QuicR-Mac interop settings
          quicrInteropEnabled,
          quicrParticipantId,
        };

        // Use announce flow if enabled
        if (useAnnounceFlow) {
          log.info('Using announce flow for publishing', { namespace, trackName });

          set({
            announceStatus: 'announcing',
            pendingAnnounceStream: localStream,
            pendingAnnounceConfig: {
              namespace,
              trackName,
              deliveryTimeout: deliveryTimeout ?? 5000,
              priority: priority ?? 128,
              deliveryMode: deliveryMode ?? 'stream',
              // Store the panel's explicit track type intent
              videoEnabled: effectiveVideoEnabled,
              audioEnabled: effectiveAudioEnabled,
            },
          });

          try {
            await session.announceNamespace(namespace.split('/'), {
              deliveryMode: deliveryMode ?? 'stream',
              priority: priority ?? 128,
              deliveryTimeout: deliveryTimeout ?? 5000,
            });

            set({ announceStatus: 'waiting' });
            log.info('Namespace announced, waiting for subscribers', { namespace });

            // Return a placeholder track alias - actual publishing happens when subscribers connect
            return BigInt(0);
          } catch (err) {
            log.error('Failed to announce namespace', err);
            set({
              announceStatus: 'idle',
              pendingAnnounceStream: null,
              pendingAnnounceConfig: null,
              error: (err as Error).message,
            });
            throw err;
          }
        }

        // Standard publish flow
        const trackAlias = await session.publish(
          namespace.split('/'),
          trackName,
          localStream,
          config
        );

        // Add to published tracks
        get().addPublishedTrack({
          id: `pub-${trackAlias.toString()}`,
          type: 'video',
          namespace: namespace.split('/'),
          trackName,
          active: true,
          stats: { groupId: 0, objectId: 0, bytesTransferred: 0 },
        });

        return trackAlias;
      },

      stopPublishing: async (trackAlias: bigint | string) => {
        const { session } = get();
        if (!session) return;

        await session.unpublish(trackAlias);
        get().removePublishedTrack(`pub-${trackAlias.toString()}`);
      },

      announceNamespace: async (namespace: string) => {
        const { session, localStream } = get();
        if (!session) {
          throw new Error('No session');
        }
        if (!localStream) {
          throw new Error('No local stream');
        }

        set({
          announceStatus: 'announcing',
          pendingAnnounceStream: localStream,
          pendingAnnounceConfig: {
            namespace,
            trackName: '', // Will be determined by subscriber
          },
        });

        try {
          await session.announceNamespace(namespace.split('/'), {
            deliveryMode: 'stream',
            priority: 128,
            deliveryTimeout: 5000,
          });

          set({ announceStatus: 'waiting' });
          log.info('Namespace announced, waiting for subscribers', { namespace });
        } catch (err) {
          log.error('Failed to announce namespace', err);
          set({
            announceStatus: 'idle',
            pendingAnnounceStream: null,
            pendingAnnounceConfig: null,
            error: (err as Error).message,
          });
          throw err;
        }
      },

      cancelAnnounce: async (namespace: string) => {
        const { session } = get();
        if (!session) return;

        await session.cancelAnnounce(namespace.split('/'));
        set({
          announceStatus: 'idle',
          pendingAnnounceStream: null,
          pendingAnnounceConfig: null,
        });
        log.info('Namespace announcement cancelled', { namespace });
      },

      startSubscription: async (namespace: string, trackName: string, mediaType?: 'video' | 'audio', videoConfig?: { codec?: string; width?: number; height?: number }, isLive?: boolean, catalogFramerate?: number, catalogGopDuration?: number) => {
        const { session, videoBitrate, audioBitrate, videoResolution, enableStats, jitterBufferDelay, useGroupArbiter, policyType, maxLatency, estimatedGopDuration, skipToLatestGroup, skipGraceFrames, enableCatchUp, catchUpThreshold, useLatencyDeadline, arbiterDebug, secureObjectsEnabled, secureObjectsCipherSuite, secureObjectsBaseKey, quicrInteropEnabled } = get();
        if (!session) {
          throw new Error('No session');
        }

        // For VOD with FETCH, use small initial buffer - data arrives quickly
        let minBufferFrames: number | undefined = 5;
        if (catalogFramerate && catalogGopDuration) {
          const framesPerGop = catalogFramerate * (catalogGopDuration / 1000);
          log.info('VOD catalog info', { catalogFramerate, catalogGopDuration, framesPerGop, minBufferFrames });
        }

        const config: MediaConfig = {
          videoBitrate,
          audioBitrate,
          videoResolution,
          enableStats,
          jitterBufferDelay,
          useGroupArbiter,
          // New PlayoutBuffer architecture - pass isLive from catalog for auto policy selection
          policyType,
          isLive,
          catalogFramerate, // For VOD frame pacing
          minBufferFrames, // Derived from catalog framerate and GOP duration
          maxLatency,
          estimatedGopDuration: catalogGopDuration ?? estimatedGopDuration,
          skipToLatestGroup,
          skipGraceFrames,
          enableCatchUp,
          catchUpThreshold,
          useLatencyDeadline,
          arbiterDebug,
          // Secure Objects encryption settings
          secureObjectsEnabled,
          secureObjectsCipherSuite,
          secureObjectsBaseKey,
          // QuicR-Mac interop settings
          quicrInteropEnabled,
          // Override video decoder config from catalog track info
          videoDecoderConfig: videoConfig ? {
            codec: videoConfig.codec,
            codedWidth: videoConfig.width,
            codedHeight: videoConfig.height,
          } : undefined,
        };

        const subscriptionId = await session.subscribe(
          namespace.split('/'),
          trackName,
          config,
          mediaType
        );

        // Add to subscribed tracks
        get().addSubscribedTrack({
          id: `sub-${subscriptionId}`,
          type: mediaType ?? 'video',
          namespace: namespace.split('/'),
          trackName,
          active: true,
          stats: { groupId: 0, objectId: 0, bytesTransferred: 0 },
        });

        return subscriptionId;
      },

      // VOD subscription using FETCH with adaptive buffer management
      startVodSubscription: async (namespace: string, trackName: string, mediaType: 'video' | 'audio', videoConfig: { codec?: string; width?: number; height?: number } | undefined, trackInfo: { framerate?: number; gopDuration?: number; totalGroups?: number }, bufferConfig?: { initialBufferSec?: number; minBufferSec?: number; fetchBatchSec?: number }, startGroup: number = 0) => {
        const { session, videoBitrate, audioBitrate, videoResolution, enableStats, jitterBufferDelay, arbiterDebug, secureObjectsEnabled, secureObjectsCipherSuite, secureObjectsBaseKey } = get();
        if (!session) {
          throw new Error('No session');
        }

        // Use provided buffer config or defaults for adaptive buffering
        const effectiveBufferConfig = {
          initialBufferSec: bufferConfig?.initialBufferSec ?? 3,
          minBufferSec: bufferConfig?.minBufferSec ?? 2,
          fetchBatchSec: bufferConfig?.fetchBatchSec ?? 2,
        };

        log.info('Starting VOD subscription with FETCH', {
          namespace,
          trackName,
          mediaType,
          trackInfo,
          bufferConfig: effectiveBufferConfig,
        });

        // Create VodFetchController for adaptive buffer management
        const controller = createVodFetchController(trackInfo, effectiveBufferConfig);

        // Track groups received per fetch request for controller notification
        const fetchGroupCounts = new Map<number, { groupsReceived: Set<number>; framesReceived: number; bytesReceived: number }>();

        // Calculate minBufferFrames from track info
        // Keep initial buffer small (5 frames) for quick start - FETCH provides data fast
        const framerate = trackInfo.framerate ?? 30;
        const gopDurationMs = trackInfo.gopDuration ?? 2000;
        const framesPerGop = Math.round(framerate * (gopDurationMs / 1000));
        const minBufferFrames = 5; // Small buffer - FETCH delivers data quickly

        log.info('VOD buffer config', {
          framerate,
          gopDurationMs,
          framesPerGop,
          minBufferFrames,
          totalGroups: trackInfo.totalGroups,
        });

        // Create VOD pipeline (FETCH-only, no SUBSCRIBE message sent to server)
        const config: MediaConfig = {
          videoBitrate,
          audioBitrate,
          videoResolution,
          enableStats,
          jitterBufferDelay,
          policyType: 'vod',
          isLive: false,
          catalogFramerate: framerate,
          minBufferFrames,
          estimatedGopDuration: gopDurationMs,
          arbiterDebug,
          secureObjectsEnabled,
          secureObjectsCipherSuite,
          secureObjectsBaseKey,
          videoDecoderConfig: videoConfig ? {
            codec: videoConfig.codec,
            codedWidth: videoConfig.width,
            codedHeight: videoConfig.height,
          } : undefined,
        };

        // Create decode pipeline without subscribing - we'll use FETCH instead
        const { subscriptionId, pushData, markGroupComplete } = await session.createVodPipeline(
          namespace.split('/'),
          trackName,
          config,
          mediaType
        );

        // Handle fetch requests from controller
        controller.on('fetch-request', async ({ startGroup, endGroup, requestId }: { startGroup: number; endGroup: number; requestId: number }) => {
          log.info('VOD fetch request', { requestId, startGroup, endGroup });
          console.log('[Store] FETCH request from controller', { requestId, startGroup, endGroup, namespace, trackName });

          // Initialize tracking for this fetch
          fetchGroupCounts.set(requestId, {
            groupsReceived: new Set(),
            framesReceived: 0,
            bytesReceived: 0,
          });

          try {
            // Get the MOQT session to issue fetch
            const moqtSession = session.getMOQTSession();
            const fetchStartTime = performance.now();

            await moqtSession.fetch(
              namespace.split('/'),
              trackName,
              {
                startGroup,
                startObject: 0,
                endGroup,
                endObject: 0, // 0 = entire group
              },
              {},
              (data: Uint8Array, groupId: number, objectId: number) => {
                // Track stats for adaptive fetch-ahead
                const stats = fetchGroupCounts.get(requestId);
                if (stats) {
                  stats.bytesReceived += data.length;
                  stats.framesReceived++;

                  // Notify controller about group completion (when objectId wraps or new group)
                  if (!stats.groupsReceived.has(groupId)) {
                    stats.groupsReceived.add(groupId);
                    // Estimate frames per group (will be refined as we receive data)
                    controller.onGroupReceived(groupId, framesPerGop);
                  }

                  // Report bytes for download speed tracking
                  controller.onFetchData(requestId, data.length);
                }

                // Push data to decode pipeline (created above)
                const timestamp = performance.now() * 1000; // microseconds
                pushData(data, groupId, objectId, timestamp);

                log.info('VOD fetch received object', {
                  requestId,
                  groupId,
                  objectId,
                  size: data.length,
                });
              }
            );

            // Mark all groups in this fetch as complete
            for (let g = startGroup; g <= endGroup; g++) {
              markGroupComplete(g);
            }

            const fetchDuration = performance.now() - fetchStartTime;
            log.info('VOD fetch completed', {
              requestId,
              durationMs: Math.round(fetchDuration),
              groupsReceived: fetchGroupCounts.get(requestId)?.groupsReceived.size ?? 0,
            });

            controller.onFetchComplete(requestId);
            fetchGroupCounts.delete(requestId);
          } catch (err) {
            log.error('VOD fetch error', { requestId, error: (err as Error).message });
            fetchGroupCounts.delete(requestId);
          }
        });

        // Handle ready-to-play event
        controller.on('ready-to-play', ({ bufferedGroups, bufferedFrames }: { bufferedGroups: number; bufferedFrames: number }) => {
          log.info('VOD ready to play', { bufferedGroups, bufferedFrames });
        });

        // Handle rebuffering events
        controller.on('rebuffering', ({ currentGroup }: { currentGroup: number }) => {
          log.warn('VOD rebuffering', { currentGroup });
        });

        controller.on('rebuffer-ended', ({ bufferedFrames }: { bufferedFrames: number }) => {
          log.info('VOD rebuffer ended', { bufferedFrames });
        });

        // Handle adaptive speed updates
        controller.on('speed-update', ({ avgMsPerGop, adaptiveFetchAhead }: { avgMsPerGop: number; adaptiveFetchAhead: number }) => {
          log.info('VOD adaptive update', { avgMsPerGop: Math.round(avgMsPerGop), adaptiveFetchAhead });
        });

        // Start the fetch controller (begins initial buffering from startGroup)
        console.log('[Store] Starting VodFetchController with startGroup', { startGroup, namespace, trackName });
        controller.start(startGroup);

        // Add to subscribed tracks
        get().addSubscribedTrack({
          id: `sub-${subscriptionId}`,
          type: mediaType,
          namespace: namespace.split('/'),
          trackName,
          active: true,
          stats: { groupId: 0, objectId: 0, bytesTransferred: 0 },
        });

        // Store controller reference for later access (e.g., seeking)
        // Use a module-level Map since we can't add it to Zustand state easily
        vodFetchControllers.set(subscriptionId, controller);

        return subscriptionId;
      },

      // Standalone FETCH for testing/debugging - no media pipeline
      fetchTrack: async (
        namespace: string,
        trackName: string,
        startGroup: number,
        endGroup: number,
        onData: (data: Uint8Array, groupId: number, objectId: number) => void
      ) => {
        const { session } = get();
        if (!session) {
          throw new Error('No session');
        }

        log.info('Starting standalone FETCH', {
          namespace,
          trackName,
          startGroup,
          endGroup,
        });

        const moqtSession = session.getMOQTSession();
        const requestId = await moqtSession.fetch(
          namespace.split('/'),
          trackName,
          {
            startGroup,
            startObject: 0,
            endGroup,
            endObject: 0, // 0 = entire group
          },
          {},
          onData
        );

        log.info('FETCH request started', { requestId, namespace, trackName });

        return {
          requestId,
          cancel: async () => {
            log.info('Cancelling FETCH', { requestId });
            await moqtSession.cancelFetch(requestId);
          },
        };
      },

      stopSubscription: async (subscriptionId: number) => {
        const { session } = get();
        if (!session) return;

        await session.unsubscribe(subscriptionId);
        get().removeSubscribedTrack(`sub-${subscriptionId}`);
      },

      pauseSubscription: async (subscriptionId: number) => {
        const { session } = get();
        if (!session) return;

        await session.pauseSubscription(subscriptionId);
      },

      resumeSubscription: async (subscriptionId: number) => {
        const { session } = get();
        if (!session) return;

        await session.resumeSubscription(subscriptionId);
      },

      isSubscriptionPaused: (subscriptionId: number) => {
        const { session } = get();
        if (!session) return false;

        return session.isSubscriptionPaused(subscriptionId);
      },

      seekSubscription: async (subscriptionId: number, timeMs: number) => {
        const { session } = get();
        if (!session) return;

        await session.seek(subscriptionId, timeMs);
      },

      onVideoFrame: (handler) => {
        const { session } = get();
        if (isDebugMode()) {
          console.log('[Store] onVideoFrame called', { hasSession: !!session });
        }
        if (!session) {
          if (isDebugMode()) {
            console.log('[Store] No session, returning empty unsubscribe');
          }
          return () => {};
        }
        if (isDebugMode()) {
          console.log('[Store] Registering video-frame handler on session');
        }
        return session.on('video-frame', handler);
      },

      onAudioData: (handler) => {
        const { session } = get();
        if (isDebugMode()) {
          console.log('[Store] onAudioData called', { hasSession: !!session });
        }
        if (!session) {
          if (isDebugMode()) {
            console.log('[Store] No session, returning empty unsubscribe');
          }
          return () => {};
        }
        if (isDebugMode()) {
          console.log('[Store] Registering audio-data handler on session');
        }
        return session.on('audio-data', handler);
      },

      onSubscribeStats: (handler) => {
        const { session } = get();
        if (!session) {
          return () => {};
        }
        return session.on('subscribe-stats', handler);
      },

      onJitterSample: (handler) => {
        const { session } = get();
        if (!session) {
          return () => {};
        }
        return session.on('jitter-sample', handler);
      },

      onLatencyStats: (handler) => {
        const { session } = get();
        if (!session) {
          return () => {};
        }
        return session.on('latency-stats', handler);
      },

      onIncomingFetch: (handler) => {
        const { session } = get();
        if (!session) {
          return () => {};
        }
        return session.on('incoming-fetch', (event) => {
          handler({
            namespace: event.namespace,
            trackName: event.trackName,
            startGroup: event.range.startGroup,
            endGroup: event.range.endGroup,
          });
        });
      },

      // ========================================
      // Publish State
      // ========================================
      publishedTracks: [],
      localStream: null,
      isPublishing: false,
      videoEnabled: true,
      audioEnabled: true,

      setLocalStream: (stream) => set({ localStream: stream }),

      addPublishedTrack: (track) =>
        set((state) => ({
          publishedTracks: [...state.publishedTracks, track],
        })),

      removePublishedTrack: (id) =>
        set((state) => ({
          publishedTracks: state.publishedTracks.filter((t) => t.id !== id),
        })),

      updateTrackStats: (id, stats) =>
        set((state) => ({
          publishedTracks: state.publishedTracks.map((t) =>
            t.id === id ? { ...t, stats } : t
          ),
        })),

      setIsPublishing: (value) => set({ isPublishing: value }),
      setVideoEnabled: (value) => set({ videoEnabled: value }),
      setAudioEnabled: (value) => set({ audioEnabled: value }),

      // ========================================
      // Subscribe State
      // ========================================
      subscribedTracks: [],
      availableTracks: [],

      addSubscribedTrack: (track) =>
        set((state) => ({
          subscribedTracks: [...state.subscribedTracks, track],
        })),

      removeSubscribedTrack: (id) =>
        set((state) => ({
          subscribedTracks: state.subscribedTracks.filter((t) => t.id !== id),
        })),

      setAvailableTracks: (tracks) => set({ availableTracks: tracks }),

      updateSubscribedTrackStats: (id, stats) =>
        set((state) => ({
          subscribedTracks: state.subscribedTracks.map((t) =>
            t.id === id ? { ...t, stats } : t
          ),
        })),

      // ========================================
      // Namespace Subscribe State
      // ========================================
      namespaceSubscriptions: [],

      addNamespacePanel: (namespacePrefix) => {
        const id = `ns-${Date.now()}`;
        const panel: NamespaceSubscriptionPanel = {
          id,
          namespacePrefix,
          isActive: false,
          tracks: [],
        };
        set((state) => ({
          namespaceSubscriptions: [...state.namespaceSubscriptions, panel],
        }));
        return id;
      },

      removeNamespacePanel: (panelId) => {
        const { session, namespaceSubscriptions } = get();
        const panel = namespaceSubscriptions.find(p => p.id === panelId);
        if (panel?.subscriptionId && session) {
          session.unsubscribeNamespace(panel.subscriptionId).catch(err => {
            log.error('Failed to unsubscribe namespace', err);
          });
        }
        set((state) => ({
          namespaceSubscriptions: state.namespaceSubscriptions.filter(p => p.id !== panelId),
        }));
      },

      startNamespaceSubscription: async (panelId) => {
        const { session, namespaceSubscriptions, videoBitrate, audioBitrate, videoResolution, enableStats, jitterBufferDelay, useGroupArbiter, policyType, maxLatency, estimatedGopDuration, skipToLatestGroup, skipGraceFrames, enableCatchUp, catchUpThreshold, useLatencyDeadline, arbiterDebug, secureObjectsEnabled, secureObjectsCipherSuite, secureObjectsBaseKey, quicrInteropEnabled } = get();
        if (!session) throw new Error('No session');

        const panel = namespaceSubscriptions.find(p => p.id === panelId);
        if (!panel) throw new Error('Panel not found');

        const namespacePrefix = panel.namespacePrefix.split('/');

        // Pass media config for auto-creating decode pipelines
        const config: MediaConfig = {
          videoBitrate,
          audioBitrate,
          videoResolution,
          enableStats,
          jitterBufferDelay,
          useGroupArbiter,
          // New PlayoutBuffer architecture
          policyType,
          maxLatency,
          estimatedGopDuration,
          skipToLatestGroup,
          skipGraceFrames,
          enableCatchUp,
          catchUpThreshold,
          useLatencyDeadline,
          arbiterDebug,
          // Secure Objects encryption settings
          secureObjectsEnabled,
          secureObjectsCipherSuite,
          secureObjectsBaseKey,
          // QuicR-Mac interop settings
          quicrInteropEnabled,
        };

        const subscriptionId = await session.subscribeNamespace(namespacePrefix, config);

        set((state) => ({
          namespaceSubscriptions: state.namespaceSubscriptions.map(p =>
            p.id === panelId ? { ...p, subscriptionId, isActive: true } : p
          ),
        }));
      },

      stopNamespaceSubscription: async (panelId) => {
        const { session, namespaceSubscriptions } = get();
        if (!session) return;

        const panel = namespaceSubscriptions.find(p => p.id === panelId);
        if (!panel?.subscriptionId) return;

        await session.unsubscribeNamespace(panel.subscriptionId);

        set((state) => ({
          namespaceSubscriptions: state.namespaceSubscriptions.map(p =>
            p.id === panelId ? { ...p, subscriptionId: undefined, isActive: false, tracks: [] } : p
          ),
        }));
      },

      addDiscoveredTrack: (panelId, track) => {
        set((state) => ({
          namespaceSubscriptions: state.namespaceSubscriptions.map(p =>
            p.id === panelId ? { ...p, tracks: [...p.tracks, track] } : p
          ),
        }));
      },

      getPanelBySubscriptionId: (subscriptionId) => {
        const { namespaceSubscriptions } = get();
        return namespaceSubscriptions.find(p => p.subscriptionId === subscriptionId);
      },

      // ========================================
      // Chat State
      // ========================================
      messages: [],
      participants: [],
      participantId: crypto.randomUUID(),
      displayName: 'Anonymous',

      addMessage: (message) =>
        set((state) => ({
          messages: [...state.messages.slice(-99), message], // Keep last 100
        })),

      clearMessages: () => set({ messages: [] }),

      setDisplayName: (name) => set({ displayName: name }),

      addParticipant: (participant) =>
        set((state) => ({
          participants: state.participants.some((p) => p.id === participant.id)
            ? state.participants.map((p) =>
                p.id === participant.id ? participant : p
              )
            : [...state.participants, participant],
        })),

      removeParticipant: (id) =>
        set((state) => ({
          participants: state.participants.filter((p) => p.id !== id),
        })),

      updateParticipantLastSeen: (id) =>
        set((state) => ({
          participants: state.participants.map((p) =>
            p.id === id ? { ...p, lastSeen: Date.now() } : p
          ),
        })),

      // ========================================
      // Settings State
      // ========================================
      theme: 'system',
      logLevel: LogLevel.ERROR, // Default to ERROR - use ?debug=1 to access dev settings
      videoBitrate: 2_000_000,
      audioBitrate: 128_000,
      videoResolution: '720p',
      keyframeInterval: 1,
      deliveryMode: 'stream',
      localDevelopment: true,
      useWorkers: true, // Default to using workers for better performance
      useAnnounceFlow: false, // Default to direct PUBLISH flow
      connectionTimeout: 300000, // Default 5 minutes (was 10 seconds)
      enableStats: false, // Default to off for performance
      jitterBufferDelay: 100, // Default 100ms jitter buffer
      varIntType: VarIntType.QUIC, // Default to QUIC varints for compatibility
      vadEnabled: false, // Default VAD off
      vadProvider: 'libfvad', // Default to lightweight libfvad
      vadVisualizationEnabled: false, // Default viz off for performance
      audioDeliveryMode: 'datagram', // Default to datagram for low latency
      experienceProfile: 'interactive', // Default to interactive profile
      useGroupArbiter: false, // Legacy - kept for backward compatibility
      policyType: 'adaptive', // Default to auto-detect from catalog or arrival patterns
      maxLatency: 500, // Default 500ms max latency
      estimatedGopDuration: 1000, // Default 1s GOP
      skipToLatestGroup: false, // Default: complete current GOP before switching
      skipGraceFrames: 3, // Default: wait 3 frame intervals before skipping
      enableCatchUp: true, // Default: enable catch-up when buffer gets deep
      catchUpThreshold: 5, // Default: trigger catch-up after 5 ready frames
      useLatencyDeadline: true, // Default: use latency-only deadline (interactive mode)
      arbiterDebug: false, // Default: no debug logging
      secureObjectsEnabled: false, // Default: encryption off
      secureObjectsCipherSuite: '0x0004', // Default: AES_128_GCM_SHA256_128
      secureObjectsBaseKey: '', // Default: empty (user must provide)
      quicrInteropEnabled: false, // Default: standard LOC packaging
      quicrParticipantId: 0, // Default: 0 (should be set by user)
      vodPublishEnabled: false, // Default: VOD publishing off

      setTheme: (theme) => {
        set({ theme });
        // Apply theme
        if (theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
          document.documentElement.classList.add('dark');
        } else {
          document.documentElement.classList.remove('dark');
        }
      },

      setLogLevel: (level) => {
        set({ logLevel: level });
        // Apply log level to moqt-core Logger
        Logger.setLevel(level as unknown as CoreLogLevel);
      },

      setVideoBitrate: (bitrate) => set({ videoBitrate: bitrate }),
      setAudioBitrate: (bitrate) => set({ audioBitrate: bitrate }),
      setVideoResolution: (resolution) => set({ videoResolution: resolution }),
      setKeyframeInterval: (seconds) => set({ keyframeInterval: seconds }),
      setDeliveryMode: (mode) => set({ deliveryMode: mode }),
      setLocalDevelopment: (value) => set({ localDevelopment: value }),
      setUseWorkers: (value) => set({ useWorkers: value }),
      setUseAnnounceFlow: (value) => set({ useAnnounceFlow: value }),
      setConnectionTimeout: (value) => set({ connectionTimeout: value }),
      setEnableStats: (value) => set({ enableStats: value }),
      setJitterBufferDelay: (value) => set({ jitterBufferDelay: value }),
      setVarIntType: (type) => {
        set({ varIntType: type });
        // Apply to the global VarInt codec
        setVarIntType(type);
      },
      setVadEnabled: (value) => set({ vadEnabled: value }),
      setVadProvider: (provider) => set({ vadProvider: provider }),
      setVadVisualizationEnabled: (value) => set({ vadVisualizationEnabled: value }),
      setAudioDeliveryMode: (mode) => set({ audioDeliveryMode: mode }),
      setUseGroupArbiter: (value) => set({ useGroupArbiter: value }),
      setPolicyType: (value) => set({ policyType: value }),
      setMaxLatency: (value) => set({ maxLatency: value }),
      setEstimatedGopDuration: (value) => set({ estimatedGopDuration: value }),
      setSkipToLatestGroup: (value) => set({ skipToLatestGroup: value }),
      setSkipGraceFrames: (value) => set({ skipGraceFrames: value }),
      setEnableCatchUp: (value) => set({ enableCatchUp: value }),
      setCatchUpThreshold: (value) => set({ catchUpThreshold: value }),
      setUseLatencyDeadline: (value) => set({ useLatencyDeadline: value }),
      setArbiterDebug: (value) => set({ arbiterDebug: value }),
      setSecureObjectsEnabled: (value) => set({ secureObjectsEnabled: value }),
      setSecureObjectsCipherSuite: (value) => set({ secureObjectsCipherSuite: value }),
      setSecureObjectsBaseKey: (value) => set({ secureObjectsBaseKey: value }),
      setQuicrInteropEnabled: (value) => set({ quicrInteropEnabled: value }),
      setQuicrParticipantId: (value) => set({ quicrParticipantId: value }),
      setVodPublishEnabled: (value) => set({ vodPublishEnabled: value }),

      applyExperienceProfile: (profileName) => {
        if (profileName === 'custom') {
          set({ experienceProfile: 'custom' });
          return;
        }
        const profile = EXPERIENCE_PROFILES[profileName];
        if (!profile) return;

        set({
          experienceProfile: profileName,
          useGroupArbiter: true, // Enable GroupArbiter when applying a profile
          jitterBufferDelay: profile.settings.jitterBufferDelay,
          useLatencyDeadline: profile.settings.useLatencyDeadline,
          maxLatency: profile.settings.maxLatency,
          estimatedGopDuration: profile.settings.estimatedGopDuration,
          skipToLatestGroup: profile.settings.skipToLatestGroup,
          skipGraceFrames: profile.settings.skipGraceFrames,
          enableCatchUp: profile.settings.enableCatchUp,
          catchUpThreshold: profile.settings.catchUpThreshold,
        });
      },

      updateDetectedProfile: () => {
        const state = get();
        const currentSettings = {
          jitterBufferDelay: state.jitterBufferDelay,
          useLatencyDeadline: state.useLatencyDeadline,
          maxLatency: state.maxLatency,
          estimatedGopDuration: state.estimatedGopDuration,
          skipToLatestGroup: state.skipToLatestGroup,
          skipGraceFrames: state.skipGraceFrames,
          enableCatchUp: state.enableCatchUp,
          catchUpThreshold: state.catchUpThreshold,
        };
        const detected = detectCurrentProfile(currentSettings);
        if (detected !== state.experienceProfile) {
          set({ experienceProfile: detected });
        }
      },
    }),
    {
      name: 'moqt-client-storage',
      partialize: (state) => ({
        serverUrl: state.serverUrl,
        displayName: state.displayName,
        theme: state.theme,
        logLevel: state.logLevel,
        videoBitrate: state.videoBitrate,
        audioBitrate: state.audioBitrate,
        videoResolution: state.videoResolution,
        keyframeInterval: state.keyframeInterval,
        deliveryMode: state.deliveryMode,
        localDevelopment: state.localDevelopment,
        useWorkers: state.useWorkers,
        useAnnounceFlow: state.useAnnounceFlow,
        enableStats: state.enableStats,
        jitterBufferDelay: state.jitterBufferDelay,
        varIntType: state.varIntType,
        vadEnabled: state.vadEnabled,
        vadProvider: state.vadProvider,
        vadVisualizationEnabled: state.vadVisualizationEnabled,
        audioDeliveryMode: state.audioDeliveryMode,
        experienceProfile: state.experienceProfile,
        useGroupArbiter: state.useGroupArbiter,
        policyType: state.policyType,
        maxLatency: state.maxLatency,
        estimatedGopDuration: state.estimatedGopDuration,
        skipToLatestGroup: state.skipToLatestGroup,
        skipGraceFrames: state.skipGraceFrames,
        enableCatchUp: state.enableCatchUp,
        catchUpThreshold: state.catchUpThreshold,
        useLatencyDeadline: state.useLatencyDeadline,
        arbiterDebug: state.arbiterDebug,
        secureObjectsEnabled: state.secureObjectsEnabled,
        secureObjectsCipherSuite: state.secureObjectsCipherSuite,
        secureObjectsBaseKey: state.secureObjectsBaseKey,
        quicrInteropEnabled: state.quicrInteropEnabled,
        quicrParticipantId: state.quicrParticipantId,
        vodPublishEnabled: state.vodPublishEnabled,
      }),
    }
  )
);

// Initialize theme and varint type on load
if (typeof window !== 'undefined') {
  const { theme, varIntType } = useStore.getState();
  if (theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }
  // Apply persisted varint type
  if (varIntType) {
    setVarIntType(varIntType);
  }
}
