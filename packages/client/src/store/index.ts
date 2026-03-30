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
import type { VADProvider } from '@web-moq/media';
import { MediaSession, type SessionState, type MediaConfig, type WorkerConfig } from '@web-moq/media';
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

interface TransportConfig {
  serverCertificateHashes?: ArrayBuffer[];
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
  } | null;
  startSubscription: (namespace: string, trackName: string, mediaType?: 'video' | 'audio') => Promise<number>;
  stopSubscription: (subscriptionId: number) => Promise<void>;
  pauseSubscription: (subscriptionId: number) => Promise<void>;
  resumeSubscription: (subscriptionId: number) => Promise<void>;
  isSubscriptionPaused: (subscriptionId: number) => boolean;

  // Video frame handler registration
  onVideoFrame: (handler: (data: { subscriptionId: number; frame: VideoFrame }) => void) => () => void;
  // Audio data handler registration
  onAudioData: (handler: (data: { subscriptionId: number; audioData: AudioData }) => void) => () => void;
  // Jitter sample handler registration (only active when enableStats is true)
  onJitterSample: (handler: (data: { subscriptionId: number; sample: { interArrivalTimes: number[]; avgJitter: number; maxJitter: number } }) => void) => () => void;
  // Latency stats handler registration (only active when enableStats is true)
  onLatencyStats: (handler: (data: { subscriptionId: number; stats: { processingDelay: number; bufferDepth: number; bufferDelay: number } }) => void) => () => void;
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
  setEnableStats: (value: boolean) => void;
  setJitterBufferDelay: (value: number) => void;
  setVarIntType: (type: VarIntType) => void;
  setVadEnabled: (value: boolean) => void;
  setVadProvider: (provider: VADProvider) => void;
  setVadVisualizationEnabled: (value: boolean) => void;
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
            });

            // Connect via the transport worker
            await session.connect(url);
            log.info('Connected to relay via transport worker', { url });
          } else {
            // Main thread mode: Transport runs on main thread
            log.info('Using main thread mode');

            transport = createTransport({ serverCertificateHashes });

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

          session.on('state-change', (state) => {
            set({ sessionState: state });
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

            const { pendingAnnounceStream, pendingAnnounceConfig, videoBitrate, audioBitrate, videoResolution, keyframeInterval, videoEnabled, audioEnabled } = get();

            if (pendingAnnounceStream && pendingAnnounceConfig) {
              try {
                // Start publishing on this track
                const config = {
                  videoBitrate,
                  audioBitrate,
                  videoResolution,
                  keyframeInterval,
                  deliveryTimeout: pendingAnnounceConfig.deliveryTimeout ?? 5000,
                  priority: pendingAnnounceConfig.priority ?? 128,
                  deliveryMode: pendingAnnounceConfig.deliveryMode ?? 'stream',
                  videoEnabled,
                  audioEnabled,
                };

                await session.startAnnouncePublish(
                  event.trackAlias,
                  event.namespace,
                  event.trackName,
                  pendingAnnounceStream,
                  config
                );

                // Add to published tracks
                get().addPublishedTrack({
                  id: `pub-${event.trackAlias.toString()}`,
                  type: 'video',
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
        const { session, localStream, videoBitrate, audioBitrate, videoResolution, keyframeInterval, videoEnabled: globalVideoEnabled, audioEnabled: globalAudioEnabled, useAnnounceFlow } = get();
        if (!session) {
          throw new Error('No session');
        }
        if (!localStream) {
          throw new Error('No local stream');
        }

        // Use passed parameters if provided, otherwise fall back to global state
        const effectiveVideoEnabled = videoEnabled ?? globalVideoEnabled;
        const effectiveAudioEnabled = audioEnabled ?? globalAudioEnabled;

        const config: MediaConfig = {
          videoBitrate,
          audioBitrate,
          videoResolution,
          keyframeInterval,
          deliveryTimeout: deliveryTimeout ?? 5000,
          priority: priority ?? 128,
          deliveryMode: deliveryMode ?? 'stream',
          videoEnabled: effectiveVideoEnabled,
          audioEnabled: effectiveAudioEnabled,
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

      startSubscription: async (namespace: string, trackName: string, mediaType?: 'video' | 'audio') => {
        const { session, videoBitrate, audioBitrate, videoResolution, enableStats, jitterBufferDelay } = get();
        if (!session) {
          throw new Error('No session');
        }

        const config: MediaConfig = {
          videoBitrate,
          audioBitrate,
          videoResolution,
          enableStats,
          jitterBufferDelay,
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
        const { session, namespaceSubscriptions, videoBitrate, audioBitrate, videoResolution, enableStats, jitterBufferDelay } = get();
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
      enableStats: false, // Default to off for performance
      jitterBufferDelay: 100, // Default 100ms jitter buffer
      varIntType: VarIntType.QUIC, // Default to QUIC varints for compatibility
      vadEnabled: false, // Default VAD off
      vadProvider: 'libfvad', // Default to lightweight libfvad
      vadVisualizationEnabled: false, // Default viz off for performance

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
