import { useRef, useCallback } from 'react';
import { MOQTSession, type IncomingPublishEvent } from '@moq-web/session';
import { SubscribePipeline } from '@moq-web/media';
import { serializeSwitchingSetAssignment, GroupOrder } from '@moq-web/core';
import { useStore } from '../store';
import { DEFAULTS, SPEECH_ACTIVITY_KEY, SIMULCAST_LAYERS } from '../lib/constants';

interface TrackPipeline {
  participantId: string;
  rendition: string;
  trackName: string;
  pipeline: SubscribePipeline;
  subscriptionId: number;
  lastObjectTime: number;
}

const STALE_THRESHOLD_MS = 800;

export function useSubscribe() {
  const pipelinesRef = useRef<Map<string, TrackPipeline>>(new Map());
  const videoCanvasesRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const audioCallbackRef = useRef<((participantId: string, audioData: AudioData) => void) | null>(null);
  const staleIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Track which rendition is currently active per participant (DTS selected)
  const activeRenditionRef = useRef<Map<string, string>>(new Map());
  // Track switching set IDs assigned per participant
  const switchingSetIdsRef = useRef<Map<string, number>>(new Map());
  const nextSetIdRef = useRef(1);
  // Track how many renditions have been received per participant (for activate flag)
  const renditionsReceivedRef = useRef<Map<string, Set<string>>>(new Map());
  const topNVideo = useStore((s) => s.topNVideo);
  const simulcastEnabled = useStore((s) => s.simulcastEnabled);

  const setAudioCallback = useCallback(
    (cb: (participantId: string, audioData: AudioData) => void) => {
      audioCallbackRef.current = cb;
    },
    []
  );

  const getRenditionForParticipant = useCallback((participantId: string): string => {
    return activeRenditionRef.current.get(participantId) ?? '360p';
  }, []);

  const updateVisibleParticipants = useCallback(() => {
    const now = Date.now();
    const activeParticipants = new Map<string, string>();

    for (const [, tp] of pipelinesRef.current) {
      if (tp.trackName === 'video' && (now - tp.lastObjectTime) < STALE_THRESHOLD_MS) {
        // Track the active rendition — prefer the one currently receiving data
        const existing = activeParticipants.get(tp.participantId);
        if (!existing || tp.rendition === getRenditionForParticipant(tp.participantId)) {
          activeParticipants.set(tp.participantId, tp.rendition);
        }
      }
    }

    const store = useStore.getState();
    const current = store.participants;

    for (const [pid, rendition] of activeParticipants) {
      if (!current.has(pid)) {
        store.addParticipant(pid, {
          id: pid,
          trackName: `${pid}/video`,
          isSpeaking: true,
          currentRendition: rendition,
        });
      } else {
        store.updateParticipant(pid, { currentRendition: rendition });
      }
    }

    for (const [pid] of current) {
      if (!activeParticipants.has(pid)) {
        store.removeParticipant(pid);
      }
    }
  }, [getRenditionForParticipant]);

  const startSubscribe = useCallback(
    async (session: MOQTSession, roomId: string) => {
      const renditions = simulcastEnabled
        ? SIMULCAST_LAYERS.map((l) => l.label)
        : [SIMULCAST_LAYERS[0].label];

      // Enable deferred PUBLISH_OK for SSTS when simulcast is active
      if (simulcastEnabled) {
        session.setDeferPublishOk(true);
      }

      // Subscribe to each rendition namespace with Top-N filter
      for (const rendition of renditions) {
        await session.subscribeNamespace([roomId, rendition], {
          trackFilter: {
            propertyType: SPEECH_ACTIVITY_KEY,
            maxSelected: topNVideo,
          },
        });
      }

      // Subscribe to audio namespace (no Top-N filter — all audio forwarded)
      await session.subscribeNamespace([roomId, 'audio'], {});

      session.on('incoming-publish', (event: IncomingPublishEvent) => {
        const { namespace, trackName, subscriptionId, requestId, groupOrder } = event;
        // Namespace structure: [roomId, rendition, participantId]
        const participantId = namespace[namespace.length - 1];
        const rendition = namespace[namespace.length - 2];
        const isVideo = trackName === 'video';
        const isAudio = trackName === 'opus48k' || trackName === 'audio';
        const key = `${participantId}/${rendition}/${trackName}`;

        // Filter self (own participant ID is last element)
        const ownName = useStore.getState().displayName;
        if (participantId === ownName) return;

        // Send PUBLISH_OK with SSTS assignment for video tracks in simulcast mode
        if (simulcastEnabled && isVideo) {
          // Assign switching set ID per participant
          if (!switchingSetIdsRef.current.has(participantId)) {
            switchingSetIdsRef.current.set(participantId, nextSetIdRef.current++);
          }
          const setId = switchingSetIdsRef.current.get(participantId)!;

          // Track renditions received for this participant
          if (!renditionsReceivedRef.current.has(participantId)) {
            renditionsReceivedRef.current.set(participantId, new Set());
          }
          renditionsReceivedRef.current.get(participantId)!.add(rendition);
          const receivedCount = renditionsReceivedRef.current.get(participantId)!.size;
          const isLast = receivedCount >= renditions.length;

          // Determine rank: first set (lowest ID) = rank 0 (active speaker priority)
          const { rankMode } = useStore.getState();
          const rank = rankMode === 'speaker-priority' && setId === 1 ? 0 : 1;

          const layerConfig = SIMULCAST_LAYERS.find((l) => l.label === rendition);
          const thresholdKbps = layerConfig?.thresholdKbps ?? 1000;

          const sstsBytes = serializeSwitchingSetAssignment({
            switchingSetId: setId,
            throughputThresholdKbps: thresholdKbps,
            setThroughputFraction: 5,
            activateSwitching: isLast,
            setRank: rank,
          });

          session.sendPublishOkWithSsts(requestId, groupOrder, sstsBytes);
        } else if (simulcastEnabled && isAudio) {
          session.acceptIncomingPublish(requestId, groupOrder);
        }

        // Re-publish for an existing track
        const existing = pipelinesRef.current.get(key);
        if (existing) {
          existing.subscriptionId = subscriptionId;
          existing.lastObjectTime = Date.now();
          session.setSubscriptionCallback(subscriptionId, (data, groupId, objectId, timestamp) => {
            existing.lastObjectTime = Date.now();
            existing.pipeline.push(data, groupId, objectId, timestamp);
          });
          if (isVideo) {
            useStore.getState().addParticipant(participantId, {
              id: participantId,
              trackName: `${participantId}/video`,
              isSpeaking: true,
              currentRendition: rendition,
            });
          }
          return;
        }

        if (isVideo) {
          const layerConfig = SIMULCAST_LAYERS.find((l) => l.label === rendition) ?? SIMULCAST_LAYERS[0];

          const pipeline = new SubscribePipeline({
            mediaType: 'video',
            video: {
              codec: 'avc1.42E01F',
              codedWidth: layerConfig.width,
              codedHeight: layerConfig.height,
            },
            policyType: 'live',
            maxLatency: 500,
          });

          pipeline.on('video-frame', (frame: VideoFrame) => {
            // Only render if this is the active rendition for this participant
            const activeRendition = activeRenditionRef.current.get(participantId) ?? '360p';
            if (rendition === activeRendition || !simulcastEnabled) {
              const canvas = videoCanvasesRef.current.get(participantId);
              if (canvas) {
                const ctx = canvas.getContext('2d');
                if (ctx) {
                  canvas.width = frame.displayWidth;
                  canvas.height = frame.displayHeight;
                  ctx.drawImage(frame, 0, 0);
                }
              }
            }
            frame.close();
          });

          pipeline.start();

          const trackEntry: TrackPipeline = {
            participantId,
            rendition,
            trackName,
            pipeline,
            subscriptionId,
            lastObjectTime: Date.now(),
          };
          pipelinesRef.current.set(key, trackEntry);

          session.setSubscriptionCallback(subscriptionId, (data, groupId, objectId, timestamp) => {
            trackEntry.lastObjectTime = Date.now();
            pipeline.push(data, groupId, objectId, timestamp);
          });

          // Set initial active rendition (before DTS kicks in, default to the first one we receive)
          if (!activeRenditionRef.current.has(participantId)) {
            activeRenditionRef.current.set(participantId, rendition);
          }

          useStore.getState().addParticipant(participantId, {
            id: participantId,
            trackName: `${participantId}/video`,
            isSpeaking: true,
            currentRendition: rendition,
          });
        } else if (isAudio) {
          const pipeline = new SubscribePipeline({
            mediaType: 'audio',
            audio: {
              codec: 'opus',
              sampleRate: DEFAULTS.audioSampleRate,
              numberOfChannels: DEFAULTS.audioChannels,
            },
            policyType: 'live',
            maxLatency: 200,
          });

          pipeline.on('audio-data', (audioData: AudioData) => {
            if (audioCallbackRef.current) {
              audioCallbackRef.current(participantId, audioData);
            } else {
              audioData.close();
            }
          });

          pipeline.start();

          const audioEntry: TrackPipeline = {
            participantId,
            rendition,
            trackName,
            pipeline,
            subscriptionId,
            lastObjectTime: Date.now(),
          };
          pipelinesRef.current.set(key, audioEntry);

          session.setSubscriptionCallback(subscriptionId, (data, groupId, objectId, timestamp) => {
            audioEntry.lastObjectTime = Date.now();
            pipeline.push(data, groupId, objectId, timestamp);
          });
        }
      });

      // Periodic check: show/hide participants based on active data flow
      staleIntervalRef.current = setInterval(updateVisibleParticipants, 500);
    },
    [topNVideo, simulcastEnabled, updateVisibleParticipants]
  );

  const setActiveRendition = useCallback((participantId: string, rendition: string) => {
    activeRenditionRef.current.set(participantId, rendition);
    useStore.getState().updateParticipant(participantId, { currentRendition: rendition });
  }, []);

  const stopSubscribe = useCallback(() => {
    if (staleIntervalRef.current) {
      clearInterval(staleIntervalRef.current);
      staleIntervalRef.current = null;
    }
    for (const [, tp] of pipelinesRef.current) {
      tp.pipeline.stop();
    }
    pipelinesRef.current.clear();
    videoCanvasesRef.current.clear();
    activeRenditionRef.current.clear();
    useStore.getState().clearParticipants();
  }, []);

  const registerCanvas = useCallback((participantId: string, canvas: HTMLCanvasElement) => {
    videoCanvasesRef.current.set(participantId, canvas);
  }, []);

  const unregisterCanvas = useCallback((participantId: string) => {
    videoCanvasesRef.current.delete(participantId);
  }, []);

  return { startSubscribe, stopSubscribe, registerCanvas, unregisterCanvas, setAudioCallback, setActiveRendition };
}
