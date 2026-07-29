export const SPEECH_ACTIVITY_KEY = 0x12;
export const TRACK_FILTER_PARAM = 0x12;

export interface SimulcastLayer {
  label: string;
  width: number;
  height: number;
  bitrate: number;
  framerate: number;
  priority: number;
  thresholdKbps: number;
}

export const SIMULCAST_LAYERS: SimulcastLayer[] = [
  { label: '720p', width: 1280, height: 720, bitrate: 2_000_000, framerate: 30, priority: 1, thresholdKbps: 2000 },
  { label: '360p', width: 640,  height: 360, bitrate: 1_000_000, framerate: 30, priority: 2, thresholdKbps: 1000 },
  { label: '180p', width: 320,  height: 180, bitrate: 500_000,   framerate: 30, priority: 3, thresholdKbps: 500 },
];

export const DEFAULTS = {
  relayUrl: 'auto',
  liveViewUrl: 'http://localhost:9091',
  topNVideo: 2,
  topNAudio: 3,
  gridLayout: '1x2' as '1x2' | '2x2',
  videoWidth: 1280,
  videoHeight: 720,
  videoBitrate: 2_500_000,
  videoFramerate: 30,
  audioSampleRate: 48000,
  audioChannels: 1,
  audioBitrate: 128_000,
};
