# @web-moq Package Publishing Guide

## Package Overview

| Package | Description | Dependencies |
|---------|-------------|--------------|
| `@web-moq/core` | Protocol types, encoding, transport | None |
| `@web-moq/session` | MOQT session management | core |
| `@web-moq/media` | WebCodecs, LOC container, pipelines | core, session |
| `@web-moq/msf` | MOQT Streaming Format catalogs | core, session |

---

## Build Instructions

### Prerequisites
```bash
# Node.js 20+
node --version  # v20.x.x or higher

# pnpm 9+
corepack enable && corepack prepare pnpm@9 --activate
```

### Build All Packages
```bash
# Install dependencies
pnpm install

# Build for draft-16 (default)
pnpm run build

# Build for draft-14
pnpm run build:draft-14

# Run tests
pnpm run test
```

### Build Individual Package
```bash
# Build specific package
pnpm --filter @web-moq/core run build
pnpm --filter @web-moq/session run build
pnpm --filter @web-moq/media run build
pnpm --filter @web-moq/msf run build
```

---

## Publishing Steps

### 1. Authenticate
```bash
npm login
```

### 2. Version Bump
```bash
# Patch version (0.1.0 -> 0.1.1)
pnpm -r exec -- npm version patch

# Minor version (0.1.0 -> 0.2.0)
pnpm -r exec -- npm version minor

# Major version (0.1.0 -> 1.0.0)
pnpm -r exec -- npm version major
```

### 3. Publish (in dependency order)
```bash
pnpm --filter @web-moq/core publish --access public
pnpm --filter @web-moq/session publish --access public
pnpm --filter @web-moq/media publish --access public
pnpm --filter @web-moq/msf publish --access public
```

### 4. Tag Release
```bash
git add .
git commit -m "Release v0.2.0"
git tag v0.2.0
git push && git push --tags
```

---

## Package Usage Examples

### @web-moq/core

Core MOQT protocol types, encoding, state management, and WebTransport layer.

**Install:**
```bash
npm install @web-moq/core
```

**Usage:**
```typescript
import {
  // Transport
  MOQTransport,
  StreamManager,
  DatagramManager,

  // Message encoding
  MessageCodec,
  MessageType,
  Version,
  SetupParameter,

  // Track management
  TrackManager,

  // Logging
  Logger,
  LogLevel,

  // Version detection
  IS_DRAFT_16,
  IS_DRAFT_14,

  // VarInt encoding
  VarInt,
  BufferReader,
  BufferWriter,
} from '@web-moq/core';

// Configure logging
Logger.setLevel(LogLevel.DEBUG);

// Check build version
console.log('Draft-16 build:', IS_DRAFT_16);

// Create WebTransport connection
const transport = new MOQTransport();
await transport.connect('https://relay.example.com/moq', {
  serverCertificateHashes: [/* for local dev */],
});

// Listen for events
transport.on('connected', () => console.log('Connected!'));
transport.on('error', (err) => console.error('Error:', err));

// Create stream/datagram managers
const streams = new StreamManager(transport);
const datagrams = new DatagramManager(transport);

// Encode a CLIENT_SETUP message
const setupBytes = MessageCodec.encode({
  type: MessageType.CLIENT_SETUP,
  supportedVersions: [Version.DRAFT_16],
  parameters: new Map([[SetupParameter.PATH, '/moq']]),
});

// Send on control stream
const controlStream = await streams.openBidirectional();
await controlStream.write(setupBytes);

// Track management
const trackManager = new TrackManager();
trackManager.on('track-added', (track) => {
  console.log('New track:', track.namespace, track.name);
});
```

---

### @web-moq/session

Generic MOQT session management - subscribe/publish without media dependencies.

**Install:**
```bash
npm install @web-moq/session @web-moq/core
```

**Usage:**
```typescript
import { MOQTSession } from '@web-moq/session';
import { MOQTransport } from '@web-moq/core';

// Create transport and session
const transport = new MOQTransport();
await transport.connect('https://relay.example.com/moq');

const session = new MOQTSession(transport);

// Setup the session (client/server handshake)
await session.setup();

// Listen for session events
session.on('state-change', (state) => console.log('Session state:', state));
session.on('error', (err) => console.error('Session error:', err));

// Subscribe to a track
const subscriptionId = await session.subscribe(
  ['conference', 'room-123'],  // namespace
  'video',                      // track name
  {
    startGroup: 'latest',       // or specific group number
    endGroup: 'none',           // stream forever
  },
  (data, groupId, objectId, timestamp) => {
    console.log(`Received object: group=${groupId}, obj=${objectId}, size=${data.byteLength}`);
    // Process the raw bytes...
  }
);

// Publish to a track
const trackAlias = await session.publish(
  ['conference', 'room-123'],
  'my-video'
);

// Send objects
await session.sendObject(trackAlias, new Uint8Array([1, 2, 3, 4]), {
  groupId: 0,
  objectId: 0,
  priority: 0,
});

// Unsubscribe when done
await session.unsubscribe(subscriptionId);

// Close session
await session.close();
```

**Worker-based Transport:**
```typescript
import { MOQTSession } from '@web-moq/session';

// Use worker for transport (offload from main thread)
const worker = new Worker(
  new URL('@web-moq/session/worker', import.meta.url),
  { type: 'module' }
);

const session = new MOQTSession({ worker });
await session.connect('https://relay.example.com/moq');
await session.setup();
// ... same API as above
```

---

### @web-moq/media

WebCodecs encoding/decoding with LOC container format for media streaming.

**Install:**
```bash
npm install @web-moq/media @web-moq/session @web-moq/core
```

**High-Level MediaSession (Recommended):**
```typescript
import { MediaSession, getResolutionConfig } from '@web-moq/media';

// Create media session
const session = new MediaSession({
  relayUrl: 'https://relay.example.com/moq',
});

await session.connect();

// Get user media
const stream = await navigator.mediaDevices.getUserMedia({
  video: { width: 1280, height: 720 },
  audio: true,
});

// Start publishing
await session.publish(
  ['conference', 'room-123'],
  'participant-1',
  stream,
  {
    video: getResolutionConfig('720p'),
    audio: { sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 },
  }
);

// Subscribe to another participant
await session.subscribe(
  ['conference', 'room-123'],
  'participant-2',
  document.getElementById('remoteVideo') as HTMLVideoElement,
  {
    jitterBufferDelay: 100,
  }
);

// Stop when done
await session.stopPublishing();
await session.disconnect();
```

**Low-Level Pipeline API:**
```typescript
import {
  // Encoders
  H264Encoder,
  OpusEncoder,

  // Decoders
  H264Decoder,
  OpusDecoder,

  // LOC container
  LOCPackager,
  LOCUnpackager,
  MediaType,

  // Pipelines
  PublishPipeline,
  SubscribePipeline,

  // Jitter buffer
  JitterBuffer,
} from '@web-moq/media';

// === PUBLISHING ===

// Create video encoder
const videoEncoder = new H264Encoder({
  width: 1280,
  height: 720,
  bitrate: 2_000_000,
  framerate: 30,
  keyFrameInterval: 60,
});

// Create audio encoder
const audioEncoder = new OpusEncoder({
  sampleRate: 48000,
  numberOfChannels: 2,
  bitrate: 128000,
});

// Create LOC packager
const packager = new LOCPackager();

// Encode and package video
videoEncoder.on('frame', (encodedFrame) => {
  const locPacket = packager.packageVideo(encodedFrame.data, {
    timestamp: encodedFrame.timestamp,
    isKeyFrame: encodedFrame.isKeyFrame,
  });
  // Send locPacket over MOQT...
});

// Start encoding from MediaStream
const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
const videoTrack = stream.getVideoTracks()[0];
const processor = new MediaStreamTrackProcessor({ track: videoTrack });
const reader = processor.readable.getReader();

while (true) {
  const { value: frame, done } = await reader.read();
  if (done) break;
  await videoEncoder.encode(frame);
  frame.close();
}

// === SUBSCRIBING ===

// Create decoders
const videoDecoder = new H264Decoder({
  codec: 'avc1.4D401E',
  codedWidth: 1280,
  codedHeight: 720,
});

const audioDecoder = new OpusDecoder({
  sampleRate: 48000,
  numberOfChannels: 2,
});

// Create LOC unpackager
const unpackager = new LOCUnpackager();

// Create jitter buffer
const jitterBuffer = new JitterBuffer({
  targetDelay: 100,  // ms
  maxDelay: 500,
});

// Process received LOC packets
function onReceivedObject(data: Uint8Array, groupId: number, objectId: number) {
  const frame = unpackager.unpackage(data);
  jitterBuffer.push({
    data: frame.data,
    timestamp: frame.timestamp,
    sequence: objectId,
    isKeyFrame: frame.isKeyFrame,
  });
}

// Decode from jitter buffer
videoDecoder.on('frame', (videoFrame) => {
  // Render to canvas
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(videoFrame, 0, 0);
  videoFrame.close();
});

// Poll jitter buffer
setInterval(() => {
  const frame = jitterBuffer.pop();
  if (frame) {
    videoDecoder.decode(frame.data, frame.timestamp);
  }
}, 16);  // ~60fps
```

**Using Workers:**
```typescript
import {
  CodecEncodeWorkerClient,
  CodecDecodeWorkerClient,
} from '@web-moq/media';

// Create encode worker (WebCodecs + LOC in worker thread)
const encodeWorker = new CodecEncodeWorkerClient({
  video: {
    width: 1280,
    height: 720,
    bitrate: 2_000_000,
    framerate: 30,
  },
  audio: {
    sampleRate: 48000,
    numberOfChannels: 2,
    bitrate: 128000,
  },
});

encodeWorker.on('video-encoded', (result) => {
  // result.data is LOC-packaged bytes ready to send
  session.sendObject(trackAlias, result.data, {
    groupId: result.groupId,
    objectId: result.objectId,
  });
});

// Send VideoFrame to worker
encodeWorker.encodeVideo(videoFrame);

// Create decode worker
const decodeWorker = new CodecDecodeWorkerClient({
  video: {
    codec: 'avc1.4D401E',
    codedWidth: 1280,
    codedHeight: 720,
  },
  audio: {
    sampleRate: 48000,
    numberOfChannels: 2,
  },
});

decodeWorker.on('video-decoded', (result) => {
  // result.frame is a VideoFrame ready to render
  ctx.drawImage(result.frame, 0, 0);
  result.frame.close();
});

// Send received LOC data to worker
decodeWorker.decodeVideo(locData, timestamp);
```

---

### @web-moq/msf

MOQT Streaming Format - JSON catalogs for LOC-compliant media delivery.

**Install:**
```bash
npm install @web-moq/msf @web-moq/session @web-moq/core
```

**Building Catalogs:**
```typescript
import {
  createCatalog,
  parseCatalog,
  serializeCatalog,
  MSF_VERSION,
} from '@web-moq/msf';

// Build a full catalog
const catalog = createCatalog()
  .generatedAt()                     // Set generation timestamp
  .commonTrackFields({               // Fields shared by all tracks
    packaging: 'loc',
    renderGroup: 1,
  })
  .addVideoTrack({
    name: 'video-main',
    codec: 'avc1.4D401E',
    width: 1280,
    height: 720,
    framerate: 30,
    bitrate: 2_000_000,
    isLive: true,
  })
  .addVideoTrack({
    name: 'video-thumbnail',
    codec: 'avc1.4D401E',
    width: 320,
    height: 180,
    framerate: 15,
    bitrate: 200_000,
    isLive: true,
  })
  .addAudioTrack({
    name: 'audio-main',
    codec: 'opus',
    samplerate: 48000,
    channelConfig: 'stereo',
    bitrate: 128000,
    isLive: true,
  })
  .build();

// Serialize to JSON
const json = serializeCatalog(catalog);
console.log(json);

// Serialize to bytes for transmission
import { serializeCatalogToBytes } from '@web-moq/msf';
const bytes = serializeCatalogToBytes(catalog);

// Parse received catalog
const parsed = parseCatalog(json);
console.log('Tracks:', parsed.tracks.length);
```

**Delta Updates:**
```typescript
import {
  createDelta,
  generateDelta,
  applyDelta,
} from '@web-moq/msf';

// Create delta manually
const delta = createDelta()
  .addTrack({
    name: 'video-simulcast-low',
    codec: 'avc1.4D401E',
    width: 640,
    height: 360,
    framerate: 30,
    bitrate: 500_000,
    isLive: true,
  })
  .removeTrack('video-thumbnail')
  .build();

// Or generate delta from two catalogs
const autoDelta = generateDelta(oldCatalog, newCatalog);

// Apply delta to get updated catalog
const updatedCatalog = applyDelta(oldCatalog, delta);
```

**Session Integration:**
```typescript
import {
  createMSFSession,
  createCatalogSubscriber,
  createCatalogPublisher,
} from '@web-moq/msf';
import { MOQTSession } from '@web-moq/session';
import { MOQTransport } from '@web-moq/core';

// Setup MOQT session
const transport = new MOQTransport();
await transport.connect('https://relay.example.com/moq');
const moqtSession = new MOQTSession(transport);
await moqtSession.setup();

// Create MSF session wrapper
const msfSession = createMSFSession(moqtSession, ['conference', 'room-123']);

// === PUBLISHER SIDE ===

// Start catalog publishing
await msfSession.startCatalogPublishing();

// Publish initial catalog
const catalog = createCatalog()
  .addVideoTrack({ name: 'video', codec: 'avc1.4D401E', width: 1280, height: 720, framerate: 30, bitrate: 2_000_000, isLive: true })
  .addAudioTrack({ name: 'audio', codec: 'opus', samplerate: 48000, channelConfig: 'stereo', isLive: true })
  .build();

await msfSession.publishCatalog(catalog);

// Later, publish delta update
const delta = createDelta()
  .addTrack({ name: 'video-low', codec: 'avc1.4D401E', width: 640, height: 360, framerate: 30, bitrate: 500_000, isLive: true })
  .build();

await msfSession.publishDelta(delta);

// === SUBSCRIBER SIDE ===

// Subscribe to catalog
const catalogSubscriber = createCatalogSubscriber(moqtSession, ['conference', 'room-123']);

catalogSubscriber.on('catalog', (catalog) => {
  console.log('Received catalog version:', catalog.version);

  for (const track of catalog.tracks) {
    console.log(`Track: ${track.name}, codec: ${track.codec}`);

    if ('width' in track) {
      console.log(`  Video: ${track.width}x${track.height}`);
    }
    if ('samplerate' in track) {
      console.log(`  Audio: ${track.samplerate}Hz`);
    }
  }
});

catalogSubscriber.on('delta', (delta, newCatalog) => {
  console.log('Catalog updated, added tracks:', delta.addTracks?.length);
});

await catalogSubscriber.start();
```

**URL Handling:**
```typescript
import {
  parseMsfUrl,
  generateMsfUrl,
  encodeNamespace,
  decodeNamespace,
} from '@web-moq/msf';

// Parse MSF URL
const url = parseMsfUrl('moqt://relay.example.com/conference/room-123#video-main');
console.log('Host:', url.host);
console.log('Namespace:', url.namespace);  // ['conference', 'room-123']
console.log('Track:', url.trackName);       // 'video-main'

// Generate MSF URL
const newUrl = generateMsfUrl({
  host: 'relay.example.com',
  namespace: ['live', 'stream-456'],
  trackName: 'video',
});
// => 'moqt://relay.example.com/live/stream-456#video'

// URL-safe namespace encoding
const encoded = encodeNamespace(['my namespace', 'with/special']);
// => 'my%20namespace/with%2Fspecial'

const decoded = decodeNamespace(encoded);
// => ['my namespace', 'with/special']
```

**Timeline Operations:**
```typescript
import {
  MediaTimelineCalculator,
  createVideoTemplate,
  encodeMediaTimeline,
  decodeMediaTimeline,
} from '@web-moq/msf';

// Create timeline template for video
const template = createVideoTemplate({
  framerate: 30,
  gopSize: 60,  // keyframe every 2 seconds
});

const calculator = new MediaTimelineCalculator(template);

// Map media time to group/object
const location = calculator.timeToLocation(5000);  // 5 seconds
console.log(`Group: ${location.group}, Object: ${location.object}`);

// Map group/object to media time
const time = calculator.locationToTime({ group: 10, object: 0 });
console.log(`Time: ${time}ms`);

// Encode/decode timeline entries
const entries = [
  { mediaTime: 0, group: 0, object: 0 },
  { mediaTime: 2000, group: 1, object: 0 },
  { mediaTime: 4000, group: 2, object: 0 },
];

const encoded = encodeMediaTimeline(entries);
const decoded = decodeMediaTimeline(encoded);
```

---

## Complete Example: Video Chat Application

```typescript
import { MOQTransport } from '@web-moq/core';
import { MOQTSession } from '@web-moq/session';
import { MediaSession, getResolutionConfig } from '@web-moq/media';
import { createMSFSession, createCatalog } from '@web-moq/msf';

async function startVideoChat(roomId: string, participantId: string) {
  // Create media session
  const session = new MediaSession({
    relayUrl: 'https://relay.example.com/moq',
  });

  await session.connect();

  // Get camera/mic
  const localStream = await navigator.mediaDevices.getUserMedia({
    video: { width: 1280, height: 720 },
    audio: true,
  });

  // Display local preview
  const localVideo = document.getElementById('local') as HTMLVideoElement;
  localVideo.srcObject = localStream;

  // Publish our stream
  const namespace = ['chat', roomId];
  await session.publish(namespace, participantId, localStream, {
    video: getResolutionConfig('720p'),
    audio: { sampleRate: 48000, numberOfChannels: 2 },
  });

  // Publish MSF catalog
  const msfSession = createMSFSession(session.moqtSession!, namespace);
  await msfSession.startCatalogPublishing();

  const catalog = createCatalog()
    .addVideoTrack({
      name: `${participantId}-video`,
      codec: 'avc1.4D401E',
      width: 1280, height: 720,
      framerate: 30, bitrate: 2_000_000,
      isLive: true,
    })
    .addAudioTrack({
      name: `${participantId}-audio`,
      codec: 'opus',
      samplerate: 48000,
      channelConfig: 'stereo',
      isLive: true,
    })
    .build();

  await msfSession.publishCatalog(catalog);

  // Subscribe to other participants
  async function subscribeToParticipant(otherId: string) {
    const remoteVideo = document.createElement('video');
    remoteVideo.id = `remote-${otherId}`;
    remoteVideo.autoplay = true;
    document.getElementById('remotes')!.appendChild(remoteVideo);

    await session.subscribe(namespace, otherId, remoteVideo);
  }

  // Return cleanup function
  return async () => {
    await session.stopPublishing();
    await session.disconnect();
    localStream.getTracks().forEach(t => t.stop());
  };
}

// Usage
const cleanup = await startVideoChat('room-abc', 'alice');
// Later: await cleanup();
```
