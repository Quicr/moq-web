import { useRef, useCallback } from 'react';
import { MOQTSession } from '@moq-web/session';
import { PublishPipeline } from '@moq-web/media';
import { DEFAULTS, SPEECH_ACTIVITY_KEY, SIMULCAST_LAYERS } from '../lib/constants';

interface BotLayerState {
  label: string;
  pipeline: PublishPipeline;
  trackAlias: bigint;
  canvas: HTMLCanvasElement;
}

interface BotState {
  layers: BotLayerState[];
  audioPipeline: PublishPipeline | null;
  audioAlias: bigint | null;
  animFrame: number | null;
  audioCtx: AudioContext | null;
  audioCleanup: (() => void) | null;
  isSpeaking: () => boolean;
}

export function useSyntheticParticipant() {
  const botsRef = useRef<Map<string, BotState>>(new Map());

  const addBot = useCallback(
    async (session: MOQTSession, roomId: string, botName: string, mode: 'always' | 'intermittent' = 'intermittent') => {
      if (botsRef.current.has(botName)) return;

      const audioCtx = new AudioContext({ sampleRate: DEFAULTS.audioSampleRate });
      const [audioDest, audioCleanup, isSpeaking] = await createSpeechAudio(audioCtx, mode);

      // Speech state machine
      let speechState: 'silent' | 'start' | 'speaking' = 'silent';
      let speechStartTime = 0;
      const START_HOLD_MS = 300;
      const layers: BotLayerState[] = [];

      const getSpeechValue = (): number => {
        const speaking = isSpeaking();
        const now = Date.now();

        if (speaking) {
          if (speechState === 'silent') {
            speechState = 'start';
            speechStartTime = now;
            for (const l of layers) l.pipeline.forceKeyframe();
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

      // Create simulcast video layers
      for (const layer of SIMULCAST_LAYERS) {
        const canvas = document.createElement('canvas');
        canvas.width = layer.width;
        canvas.height = layer.height;

        const namespace = [roomId, layer.label, botName];
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
        layers.push({ label: layer.label, pipeline, trackAlias, canvas });
      }

      // Audio
      const audioNamespace = [roomId, 'audio', botName];
      const audioAlias = await session.publish(audioNamespace, 'opus48k', {
        deliveryMode: 'stream',
        audioDeliveryMode: 'stream',
        priority: 0,
      });

      const audioPipeline = new PublishPipeline({
        audio: {
          sampleRate: DEFAULTS.audioSampleRate,
          numberOfChannels: DEFAULTS.audioChannels,
          bitrate: DEFAULTS.audioBitrate,
        },
      });

      audioPipeline.on('audio-object', (obj) => {
        session.sendObject(audioAlias, obj.data, {
          groupId: obj.groupId,
          objectId: obj.objectId,
          type: 'audio',
        });
      });

      const audioStream = new MediaStream([...audioDest.stream.getAudioTracks()]);
      await audioPipeline.start(audioStream);

      // Animate canvases
      const animate = () => {
        const now = Date.now();
        const hue = (now / 50) % 360;
        for (const layer of layers) {
          drawBotCanvas(layer.canvas, layer.label, botName, mode, hue, now);
        }
        const state = botsRef.current.get(botName);
        if (state) {
          state.animFrame = requestAnimationFrame(animate);
        }
      };
      const animFrame = requestAnimationFrame(animate);

      botsRef.current.set(botName, {
        layers,
        audioPipeline,
        audioAlias,
        animFrame,
        audioCtx,
        audioCleanup,
        isSpeaking,
      });
    },
    []
  );

  const removeBot = useCallback((botName: string) => {
    const state = botsRef.current.get(botName);
    if (!state) return;

    for (const layer of state.layers) {
      layer.pipeline.stop();
    }
    state.audioPipeline?.stop();
    if (state.animFrame) cancelAnimationFrame(state.animFrame);
    state.audioCleanup?.();
    state.audioCtx?.close();
    botsRef.current.delete(botName);
  }, []);

  const removeAllBots = useCallback(() => {
    for (const name of botsRef.current.keys()) {
      removeBot(name);
    }
  }, [removeBot]);

  return { addBot, removeBot, removeAllBots };
}

function drawBotCanvas(
  canvas: HTMLCanvasElement,
  layerLabel: string,
  botName: string,
  mode: string,
  hue: number,
  now: number
) {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;

  ctx.fillStyle = `hsl(${hue}, 60%, 25%)`;
  ctx.fillRect(0, 0, w, h);

  // Fine-detail grid
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

  const fontSize = Math.max(16, Math.floor(w / 15));
  ctx.fillStyle = 'white';
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(botName, w / 2, h / 2 - fontSize);

  const labelSize = Math.max(12, Math.floor(w / 20));
  ctx.font = `bold ${labelSize}px monospace`;
  ctx.fillStyle = layerLabel === '720p' ? '#4ade80' : layerLabel === '360p' ? '#facc15' : '#f87171';
  ctx.fillText(`${w}x${h} [${layerLabel}]`, w / 2, h / 2 + labelSize);

  ctx.font = `${Math.max(10, Math.floor(w / 25))}px monospace`;
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText(`${mode} | ${new Date(now).toLocaleTimeString()}`, w / 2, h / 2 + fontSize + labelSize);

  // Small text for resolution comparison
  ctx.font = '10px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.textAlign = 'left';
  for (let i = 0; i < 6; i++) {
    ctx.fillText(
      `line ${i}: The quick brown fox jumps (${layerLabel})`,
      10,
      h - 80 + i * 12
    );
  }
}

async function createSpeechAudio(
  audioCtx: AudioContext,
  mode: 'always' | 'intermittent'
): Promise<[MediaStreamAudioDestinationNode, () => void, () => boolean]> {
  const dest = audioCtx.createMediaStreamDestination();
  let stopped = false;
  let speaking = false;

  const response = await fetch('/bot-speech.mp3');
  const arrayBuffer = await response.arrayBuffer();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

  let sourceNode: AudioBufferSourceNode | null = null;
  let cycleTimer: ReturnType<typeof setTimeout> | null = null;
  let playbackOffset = 0;

  const startSpeaking = () => {
    if (stopped) return;
    speaking = true;
    sourceNode = audioCtx.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.loop = true;
    sourceNode.connect(dest);
    sourceNode.start(0, playbackOffset % audioBuffer.duration);
  };

  const stopSpeaking = () => {
    speaking = false;
    if (sourceNode) {
      sourceNode.stop();
      sourceNode.disconnect();
      sourceNode = null;
    }
  };

  const cycle = () => {
    if (stopped) return;
    startSpeaking();
    const speakDuration = mode === 'always' ? (8000 + Math.random() * 4000) : (3000 + Math.random() * 12000);
    cycleTimer = setTimeout(() => {
      if (stopped) return;
      playbackOffset += speakDuration / 1000;
      stopSpeaking();
      const pause = mode === 'always' ? (500 + Math.random() * 1000) : (3000 + Math.random() * 12000);
      cycleTimer = setTimeout(cycle, pause);
    }, speakDuration);
  };

  cycleTimer = setTimeout(cycle, 1000);

  const cleanup = () => {
    stopped = true;
    stopSpeaking();
    if (cycleTimer) clearTimeout(cycleTimer);
  };

  return [dest, cleanup, () => speaking];
}
