export interface CatalogOptions {
  numTracks: number;
  includeInitData: boolean;
  initDataSize: number;
}

export function generateCatalog(options: CatalogOptions): string {
  const tracks = [];

  for (let i = 0; i < options.numTracks; i++) {
    const isVideo = i % 2 === 0;
    const track: Record<string, unknown> = {
      name: isVideo ? `video${Math.floor(i / 2)}` : `audio${Math.floor(i / 2)}`,
      packaging: "loc",
      renderGroup: isVideo ? 1 : 2,
      mimeType: isVideo ? "video/mp4" : "audio/mp4",
      codec: isVideo ? "avc1.64001f" : "mp4a.40.2",
    };

    if (isVideo) {
      track.width = 1920;
      track.height = 1080;
      track.frameRate = 30;
      track.bitrate = 5000000;
    } else {
      track.sampleRate = 48000;
      track.channelCount = 2;
      track.bitrate = 128000;
    }

    if (options.includeInitData) {
      const initBytes = new Uint8Array(options.initDataSize);
      for (let j = 0; j < options.initDataSize; j++) {
        initBytes[j] = Math.floor(Math.random() * 256);
      }
      track.initData = btoa(String.fromCharCode(...initBytes));
    }

    tracks.push(track);
  }

  const catalog = {
    version: 1,
    generatedAt: Date.now(),
    isComplete: true,
    tracks,
  };

  return JSON.stringify(catalog, null, 2);
}

export interface MediaTimelineOptions {
  numEntries: number;
  format: "explicit" | "template" | "mixed";
  gopDuration: number;
}

export function generateMediaTimeline(options: MediaTimelineOptions): string {
  if (options.format === "template") {
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

  const entries = [];
  let pts = 0;
  const wallclockStart = Date.now() - options.numEntries * options.gopDuration;

  for (let i = 0; i < options.numEntries; i++) {
    entries.push([
      pts,
      [i, 0],
      wallclockStart + i * options.gopDuration
    ]);
    pts += options.gopDuration;
  }

  if (options.format === "mixed") {
    return JSON.stringify({
      entries: entries.slice(0, Math.floor(entries.length / 2)),
      template: {
        startPts: pts / 2,
        startGroup: Math.floor(options.numEntries / 2),
        gopDuration: options.gopDuration,
        numGroups: Math.ceil(options.numEntries / 2),
        wallclockStart: wallclockStart + Math.floor(options.numEntries / 2) * options.gopDuration,
      }
    }, null, 2);
  }

  return JSON.stringify(entries, null, 2);
}

export interface EventTimelineOptions {
  numEvents: number;
  eventType: "sports" | "gps" | "speaker";
}

export function generateEventTimeline(options: EventTimelineOptions): string {
  const events = [];
  const baseTime = Date.now() - options.numEvents * 1000;

  for (let i = 0; i < options.numEvents; i++) {
    let data: Record<string, unknown>;

    switch (options.eventType) {
      case "sports":
        data = {
          homeScore: Math.floor(i / 10),
          awayScore: Math.floor(i / 15),
          period: Math.floor(i / 100) + 1,
          clock: `${Math.floor((i % 100) / 60)}:${String(i % 60).padStart(2, '0')}`,
          event: i % 20 === 0 ? "goal" : i % 5 === 0 ? "foul" : "play",
        };
        break;
      case "gps":
        data = {
          lat: 37.7749 + (Math.random() - 0.5) * 0.01,
          lng: -122.4194 + (Math.random() - 0.5) * 0.01,
          speed: 50 + Math.random() * 50,
          heading: Math.random() * 360,
          altitude: 10 + Math.random() * 5,
        };
        break;
      case "speaker":
        data = {
          speakerId: `participant-${(i % 5) + 1}`,
          speaking: i % 3 !== 0,
          volume: Math.random() * 100,
        };
        break;
    }

    events.push({
      t: baseTime + i * 1000,
      data,
    });
  }

  return JSON.stringify(events, null, 2);
}
