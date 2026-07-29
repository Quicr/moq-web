import { useRef, useCallback } from 'react';
import { MOQTSession } from '@moq-web/session';
import { PublishPipeline } from '@moq-web/media';
import { useStore } from '../store';
import { DEFAULTS, SPEECH_ACTIVITY_KEY, SIMULCAST_LAYERS, type SimulcastLayer } from '../lib/constants';

interface BotLayerState {
  label: string;
  pipeline: PublishPipeline;
  trackAlias: bigint;
  canvas: HTMLCanvasElement;
}

export function useBotPublish() {
  const layersRef = useRef<BotLayerState[]>([]);
  const audioPipelineRef = useRef<PublishPipeline | null>(null);
  const audioAliasRef = useRef<bigint | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioCleanupRef = useRef<(() => void) | null>(null);
  const isSpeakingRef = useRef<() => boolean>(() => false);
  const displayName = useStore((s) => s.displayName);
  const simulcastEnabled = useStore((s) => s.simulcastEnabled);

  const startPublish = useCallback(
    async (session: MOQTSession, roomId: string) => {
      session.setOwnNamespacePrefix(displayName);

      const layers = simulcastEnabled ? SIMULCAST_LAYERS : [SIMULCAST_LAYERS[0]];

      // Create audio context
      const audioCtx = new AudioContext({ sampleRate: DEFAULTS.audioSampleRate });
      audioCtxRef.current = audioCtx;

      const [audioDest, audioCleanup, isSpeaking] = await createSpeechAudio(audioCtx);
      audioCleanupRef.current = audioCleanup;
      isSpeakingRef.current = isSpeaking;

      // Speech state machine
      let speechState: 'silent' | 'start' | 'speaking' = 'silent';
      let speechStartTime = 0;
      const START_HOLD_MS = 300;

      const getSpeechValue = (): number => {
        const speaking = isSpeakingRef.current();
        const now = Date.now();

        if (speaking) {
          if (speechState === 'silent') {
            speechState = 'start';
            speechStartTime = now;
            for (const l of layersRef.current) l.pipeline.forceKeyframe();
            return 2;
          } else if (speechState === 'start') {
            if (now - speechStartTime >= START_HOLD_MS) {
              speechState = 'speaking';
              return 1;
            }
            return 2;
          }
          return 1;
        }
        speechState = 'silent';
        return 0;
      };

      // Create a video pipeline for each simulcast layer
      for (const layer of layers) {
        const canvas = document.createElement('canvas');
        canvas.width = layer.width;
        canvas.height = layer.height;

        const namespace = [roomId, layer.label, displayName];
        const trackAlias = await session.publish(namespace, 'video', {
          deliveryMode: 'stream',
          priority: layer.priority,
        });

        const videoStream = canvas.captureStream(layer.framerate);

        const pipeline = new PublishPipeline({
          video: {
            width: layer.width,
            height: layer.height,
            bitrate: layer.bitrate,
            framerate: layer.framerate,
          },
        });

        pipeline.on('video-object', (obj) => {
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

        await pipeline.start(videoStream);
        layersRef.current.push({ label: layer.label, pipeline, trackAlias, canvas });
      }

      // Audio
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

      const audioStream = new MediaStream([...audioDest.stream.getAudioTracks()]);
      await audioPipeline.start(audioStream);

      // Animate canvases — draw on each layer with resolution-appropriate content
      const draw = () => {
        const now = Date.now();
        const hue = (now / 50) % 360;

        for (const layer of layersRef.current) {
          drawBotCanvas(layer.canvas, layer.label, displayName, hue, now);
        }
        animFrameRef.current = requestAnimationFrame(draw);
      };
      animFrameRef.current = requestAnimationFrame(draw);

      // Return the primary canvas stream for self-view
      const primaryCanvas = layersRef.current[0]?.canvas;
      return primaryCanvas
        ? primaryCanvas.captureStream(DEFAULTS.videoFramerate)
        : new MediaStream();
    },
    [displayName, simulcastEnabled]
  );

  const stopPublish = useCallback(async () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (audioCleanupRef.current) {
      audioCleanupRef.current();
      audioCleanupRef.current = null;
    }
    if (audioCtxRef.current) {
      await audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    for (const layer of layersRef.current) {
      layer.pipeline.stop();
    }
    layersRef.current = [];
    if (audioPipelineRef.current) {
      audioPipelineRef.current.stop();
      audioPipelineRef.current = null;
    }
    audioAliasRef.current = null;
  }, []);

  const getLocalStream = useCallback((): MediaStream | null => {
    const primary = layersRef.current[0]?.canvas;
    if (primary) {
      return primary.captureStream(DEFAULTS.videoFramerate);
    }
    return null;
  }, []);

  return { startPublish, stopPublish, getLocalStream };
}

function drawBotCanvas(
  canvas: HTMLCanvasElement,
  layerLabel: string,
  botName: string,
  hue: number,
  now: number
) {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;

  // Background gradient
  ctx.fillStyle = `hsl(${hue}, 60%, 25%)`;
  ctx.fillRect(0, 0, w, h);

  // Draw fine-detail grid pattern (shows resolution difference clearly)
  ctx.strokeStyle = `hsla(${hue + 180}, 40%, 50%, 0.3)`;
  ctx.lineWidth = 1;
  const gridSize = 20;
  for (let x = 0; x < w; x += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Bot name
  const fontSize = Math.max(16, Math.floor(w / 15));
  ctx.fillStyle = 'white';
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(botName, w / 2, h / 2 - fontSize);

  // Layer label (burned in so you can see which quality is rendered)
  const labelSize = Math.max(12, Math.floor(w / 20));
  ctx.font = `bold ${labelSize}px monospace`;
  ctx.fillStyle = layerLabel === '720p' ? '#4ade80' : layerLabel === '360p' ? '#facc15' : '#f87171';
  ctx.fillText(`${w}x${h} [${layerLabel}]`, w / 2, h / 2 + labelSize);

  // Timestamp
  const timeSize = Math.max(10, Math.floor(w / 25));
  ctx.font = `${timeSize}px monospace`;
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText(new Date(now).toLocaleTimeString(), w / 2, h / 2 + fontSize + labelSize);

  // Small text lines (readable at 720p, blurry at 180p)
  ctx.font = '10px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.textAlign = 'left';
  for (let i = 0; i < 8; i++) {
    ctx.fillText(
      `line ${i}: The quick brown fox jumps over the lazy dog (${layerLabel})`,
      10,
      h - 100 + i * 12
    );
  }
}

async function createSpeechAudio(
  audioCtx: AudioContext
): Promise<[MediaStreamAudioDestinationNode, () => void, () => boolean]> {
  const dest = audioCtx.createMediaStreamDestination();
  let stopped = false;
  let speaking = false;

  const response = await fetch('/bot-speech.mp3');
  const arrayBuffer = await response.arrayBuffer();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

  let sourceNode: AudioBufferSourceNode | null = null;
  let gainNode: GainNode | null = null;
  let cycleTimer: ReturnType<typeof setTimeout> | null = null;
  let fadeTimer: ReturnType<typeof setTimeout> | null = null;
  let playbackOffset = 0;

  const FADE_MS = 800;

  const startSpeaking = () => {
    if (stopped) return;
    speaking = true;
    gainNode = audioCtx.createGain();
    gainNode.gain.setValueAtTime(1, audioCtx.currentTime);
    gainNode.connect(dest);

    sourceNode = audioCtx.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.loop = true;
    sourceNode.connect(gainNode);
    sourceNode.start(0, playbackOffset % audioBuffer.duration);
  };

  const fadeOutAndStop = () => {
    if (!gainNode || !sourceNode) {
      speaking = false;
      return;
    }
    gainNode.gain.setValueAtTime(gainNode.gain.value, audioCtx.currentTime);
    gainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + FADE_MS / 1000);

    fadeTimer = setTimeout(() => {
      speaking = false;
      if (sourceNode) {
        sourceNode.stop();
        sourceNode.disconnect();
        sourceNode = null;
      }
      if (gainNode) {
        gainNode.disconnect();
        gainNode = null;
      }
    }, FADE_MS);
  };

  const cycle = () => {
    if (stopped) return;
    startSpeaking();
    const speakDuration = 10000;
    cycleTimer = setTimeout(() => {
      if (stopped) return;
      playbackOffset += speakDuration / 1000;
      fadeOutAndStop();
      const pause = 10000 + Math.random() * 2000;
      cycleTimer = setTimeout(cycle, pause + FADE_MS);
    }, speakDuration);
  };

  cycle();

  const cleanup = () => {
    stopped = true;
    speaking = false;
    if (sourceNode) {
      sourceNode.stop();
      sourceNode.disconnect();
      sourceNode = null;
    }
    if (gainNode) {
      gainNode.disconnect();
      gainNode = null;
    }
    if (cycleTimer) clearTimeout(cycleTimer);
    if (fadeTimer) clearTimeout(fadeTimer);
  };

  const isSpeaking = () => speaking;

  return [dest, cleanup, isSpeaking];
}
