import { OpusEncoder, OpusDecoder } from '@web-moq/media';

export interface AudioPipelineConfig {
  sampleRate: number;
  channels: number;
  bitrate: number;
  onEncodedFrame: (frame: Uint8Array) => void;
}

export class AudioCapturePipeline {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private encoder: OpusEncoder | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private config: AudioPipelineConfig;

  constructor(config: AudioPipelineConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: this.config.sampleRate,
        channelCount: this.config.channels,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.audioContext = new AudioContext({ sampleRate: this.config.sampleRate });

    this.encoder = new OpusEncoder({
      sampleRate: this.config.sampleRate,
      numberOfChannels: this.config.channels,
      bitrate: this.config.bitrate,
      application: 'voip',
    });

    this.encoder.on('frame', (frame: { data: Uint8Array }) => {
      this.config.onEncodedFrame(frame.data);
    });

    await this.encoder.start();

    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    const analyser = this.audioContext.createAnalyser();
    source.connect(analyser);

    // Use ScriptProcessor for encoding (AudioWorklet would be better but more complex)
    const bufferSize = 960; // 20ms at 48kHz, will be resampled
    const scriptNode = this.audioContext.createScriptProcessor(
      bufferSize > 256 ? bufferSize : 4096,
      this.config.channels,
      this.config.channels
    );

    scriptNode.onaudioprocess = (event) => {
      const inputData = event.inputBuffer.getChannelData(0);
      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate: this.config.sampleRate,
        numberOfFrames: inputData.length,
        numberOfChannels: this.config.channels,
        timestamp: event.playbackTime * 1_000_000,
        data: inputData.buffer,
      });
      this.encoder?.encode(audioData);
      audioData.close();
    };

    source.connect(scriptNode);
    scriptNode.connect(this.audioContext.destination);
  }

  async stop(): Promise<void> {
    if (this.encoder) {
      await this.encoder.close();
      this.encoder = null;
    }
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
  }
}

export class AudioPlaybackPipeline {
  private audioContext: AudioContext;
  private decoder: OpusDecoder | null = null;
  private nextPlayTime = 0;
  private frameDuration = 0.02; // 20ms default

  constructor(sampleRate: number) {
    this.audioContext = new AudioContext({ sampleRate });
  }

  async start(sampleRate: number, channels: number): Promise<void> {
    this.decoder = new OpusDecoder();
    await this.decoder.start({
      sampleRate,
      numberOfChannels: channels,
    });

    this.decoder.on('frame', (audioData: AudioData) => {
      this.playAudioData(audioData);
    });

    this.nextPlayTime = this.audioContext.currentTime + 0.1; // 100ms buffer
  }

  decode(opusFrame: Uint8Array, timestamp: number): void {
    if (!this.decoder) return;
    this.decoder.decode(opusFrame, timestamp, 20_000); // 20ms duration
  }

  private playAudioData(audioData: AudioData): void {
    const numFrames = audioData.numberOfFrames;
    const numChannels = audioData.numberOfChannels;
    const buffer = this.audioContext.createBuffer(numChannels, numFrames, audioData.sampleRate);

    for (let ch = 0; ch < numChannels; ch++) {
      const channelData = new Float32Array(numFrames);
      audioData.copyTo(channelData, { planeIndex: ch, format: 'f32-planar' });
      buffer.copyToChannel(channelData, ch);
    }
    audioData.close();

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);

    const now = this.audioContext.currentTime;
    if (this.nextPlayTime < now) {
      this.nextPlayTime = now + 0.05; // re-sync with 50ms buffer
    }
    source.start(this.nextPlayTime);
    this.nextPlayTime += buffer.duration;
  }

  async stop(): Promise<void> {
    if (this.decoder) {
      await this.decoder.close();
      this.decoder = null;
    }
    await this.audioContext.close();
  }

  resume(): Promise<void> {
    return this.audioContext.resume();
  }
}
