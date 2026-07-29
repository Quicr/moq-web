import { useRef, useCallback } from 'react';
import { MOQTSession } from '@moq-web/session';
import { PublishPipeline } from '@moq-web/media';
import { useStore } from '../store';
import { DEFAULTS, SPEECH_ACTIVITY_KEY, SIMULCAST_LAYERS } from '../lib/constants';
import { useVAD } from './useVAD';

interface LayerPublishState {
  label: string;
  pipeline: PublishPipeline;
  trackAlias: bigint;
}

export function usePublish() {
  const layersRef = useRef<LayerPublishState[]>([]);
  const audioPipelineRef = useRef<PublishPipeline | null>(null);
  const audioAliasRef = useRef<bigint | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const displayName = useStore((s) => s.displayName);
  const simulcastEnabled = useStore((s) => s.simulcastEnabled);
  const { startVAD, stopVAD, getSpeechValue, consumeKeyframeRequest, getVADStatus, getCurrentState } = useVAD();

  const startPublish = useCallback(
    async (session: MOQTSession, roomId: string) => {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: DEFAULTS.videoWidth,
          height: DEFAULTS.videoHeight,
          frameRate: DEFAULTS.videoFramerate,
        },
        audio: {
          sampleRate: DEFAULTS.audioSampleRate,
          channelCount: DEFAULTS.audioChannels,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      // Set own namespace prefix for self-filtering (matches last element of namespace)
      session.setOwnNamespacePrefix(displayName);

      const layers = simulcastEnabled ? SIMULCAST_LAYERS : [SIMULCAST_LAYERS[0]];

      // Publish video tracks — one per rendition namespace
      for (const layer of layers) {
        const namespace = [roomId, layer.label, displayName];

        const trackAlias = await session.publish(namespace, 'video', {
          deliveryMode: 'stream',
          priority: layer.priority,
        });

        const pipeline = new PublishPipeline({
          video: {
            width: layer.width,
            height: layer.height,
            bitrate: layer.bitrate,
            framerate: layer.framerate,
          },
        });

        pipeline.on('video-object', (obj) => {
          if (consumeKeyframeRequest()) {
            pipeline.forceKeyframe();
          }
          const sv = getSpeechValue();
          session.sendObject(trackAlias, obj.data, {
            groupId: obj.groupId,
            objectId: obj.objectId,
            newGroup: obj.isKeyframe,
            isKeyframe: obj.isKeyframe,
            type: 'video',
            extensions: new Map<number, number>([[SPEECH_ACTIVITY_KEY, sv]]),
          });
        });

        // Start pipeline with the video track (resized internally by encoder)
        await pipeline.start(stream);

        layersRef.current.push({ label: layer.label, pipeline, trackAlias });
      }

      // Publish audio under its own namespace
      const audioNamespace = [roomId, 'audio', displayName];
      const audioAlias = await session.publish(audioNamespace, 'opus48k', {
        deliveryMode: 'stream',
        audioDeliveryMode: 'stream',
        priority: 0,
      });
      audioAliasRef.current = audioAlias;

      const audioPipeline = new PublishPipeline({
        audio: {
          sampleRate: DEFAULTS.audioSampleRate,
          numberOfChannels: DEFAULTS.audioChannels,
          bitrate: DEFAULTS.audioBitrate,
        },
      });
      audioPipelineRef.current = audioPipeline;

      audioPipeline.on('audio-object', (obj) => {
        session.sendObject(audioAlias, obj.data, {
          groupId: obj.groupId,
          objectId: obj.objectId,
          type: 'audio',
        });
      });

      await audioPipeline.start(stream);
      await startVAD(stream);
      return stream;
    },
    [displayName, simulcastEnabled, startVAD, getSpeechValue, consumeKeyframeRequest]
  );

  const stopPublish = useCallback(async () => {
    await stopVAD();
    for (const layer of layersRef.current) {
      layer.pipeline.stop();
    }
    layersRef.current = [];
    if (audioPipelineRef.current) {
      audioPipelineRef.current.stop();
      audioPipelineRef.current = null;
    }
    audioAliasRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, [stopVAD]);

  const getLocalStream = useCallback(() => streamRef.current, []);

  return { startPublish, stopPublish, getLocalStream, getVADStatus, getCurrentSpeechState: getCurrentState };
}
