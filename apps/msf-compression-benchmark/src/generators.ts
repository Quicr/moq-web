import {
  createCatalog,
  serializeCatalog,
  serializeMediaTimeline,
  serializeEventTimeline,
  type MediaTimelinePoint,
  type EventTimelinePoint,
} from '@web-moq/msf';

export interface CatalogOptions {
  numTracks: number;
  includeInitData: boolean;
  initDataSize: number;
}

export function generateCatalog(options: CatalogOptions): string {
  const builder = createCatalog().generatedAt().isComplete(true);

  for (let i = 0; i < options.numTracks; i++) {
    const isVideo = i % 2 === 0;

    if (isVideo) {
      let initData: string | undefined;
      if (options.includeInitData) {
        const initBytes = new Uint8Array(options.initDataSize);
        for (let j = 0; j < options.initDataSize; j++) {
          initBytes[j] = Math.floor(Math.random() * 256);
        }
        initData = btoa(String.fromCharCode(...initBytes));
      }

      builder.addVideoTrack({
        name: `video${Math.floor(i / 2)}`,
        codec: 'avc1.64001f',
        width: 1920,
        height: 1080,
        framerate: 30,
        bitrate: 5000000,
        isLive: true,
        initData,
      });
    } else {
      builder.addAudioTrack({
        name: `audio${Math.floor(i / 2)}`,
        codec: 'mp4a.40.2',
        samplerate: 48000,
        channelConfig: 'stereo',
        bitrate: 128000,
        isLive: true,
      });
    }
  }

  return serializeCatalog(builder.build(), { pretty: true });
}

export interface MediaTimelineOptions {
  numEntries: number;
  format: 'explicit' | 'template' | 'mixed';
  gopDuration: number;
}

export function generateMediaTimeline(options: MediaTimelineOptions): string {
  if (options.format === 'template') {
    return JSON.stringify({
      template: {
        startPts: 0,
        startGroup: 0,
        gopDuration: options.gopDuration,
        numGroups: options.numEntries,
        wallclockStart: Date.now() - options.numEntries * options.gopDuration,
      }
    }, null, 2);
  }

  const points: MediaTimelinePoint[] = [];
  let pts = 0;
  const wallclockStart = Date.now() - options.numEntries * options.gopDuration;

  for (let i = 0; i < options.numEntries; i++) {
    points.push({
      mediaPTS: pts,
      groupId: i,
      objectId: 0,
      wallclockTime: wallclockStart + i * options.gopDuration,
    });
    pts += options.gopDuration;
  }

  if (options.format === 'mixed') {
    const halfPoints = points.slice(0, Math.floor(points.length / 2));
    return JSON.stringify({
      entries: JSON.parse(serializeMediaTimeline(halfPoints)),
      template: {
        startPts: pts / 2,
        startGroup: Math.floor(options.numEntries / 2),
        gopDuration: options.gopDuration,
        numGroups: Math.ceil(options.numEntries / 2),
        wallclockStart: wallclockStart + Math.floor(options.numEntries / 2) * options.gopDuration,
      }
    }, null, 2);
  }

  return serializeMediaTimeline(points);
}

export interface EventTimelineOptions {
  numEvents: number;
  eventType: 'sports' | 'gps' | 'speaker';
}

export function generateEventTimeline(options: EventTimelineOptions): string {
  const points: EventTimelinePoint[] = [];
  const baseTime = Date.now() - options.numEvents * 1000;

  for (let i = 0; i < options.numEvents; i++) {
    let data: Record<string, unknown>;

    switch (options.eventType) {
      case 'sports':
        data = {
          homeScore: Math.floor(i / 10),
          awayScore: Math.floor(i / 15),
          period: Math.floor(i / 100) + 1,
          clock: `${Math.floor((i % 100) / 60)}:${String(i % 60).padStart(2, '0')}`,
          event: i % 20 === 0 ? 'goal' : i % 5 === 0 ? 'foul' : 'play',
        };
        break;
      case 'gps':
        data = {
          lat: 37.7749 + (Math.random() - 0.5) * 0.01,
          lng: -122.4194 + (Math.random() - 0.5) * 0.01,
          speed: 50 + Math.random() * 50,
          heading: Math.random() * 360,
          altitude: 10 + Math.random() * 5,
        };
        break;
      case 'speaker':
        data = {
          speakerId: `participant-${(i % 5) + 1}`,
          speaking: i % 3 !== 0,
          volume: Math.random() * 100,
        };
        break;
    }

    points.push({
      wallclockTime: baseTime + i * 1000,
      data,
    });
  }

  return serializeEventTimeline(points);
}
