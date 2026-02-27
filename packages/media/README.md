# @web-moq/media

WebCodecs encoding/decoding with LOC (Low Overhead Container) format for MOQT media streaming.

## Overview

This package provides complete media capture, encoding, packaging, decoding, and playback pipelines:

- **WebCodecs Encoders**: H.264 video encoder, Opus audio encoder
- **WebCodecs Decoders**: H.264 video decoder, Opus audio decoder
- **LOC Container**: Low-overhead media container format for MOQT
- **Pipelines**: High-level publish and subscribe pipelines
- **MediaSession**: Complete media streaming session with automatic codec handling
- **Web Workers**: Off-main-thread encoding/decoding for better performance

## Installation

```bash
bun add @web-moq/media
```

## Building

```bash
# Build the package
bun build

# Build with Draft-16 support
MOQT_VERSION=draft-16 bun build

# Clean build artifacts
bun clean
```

## Testing

```bash
# Run tests
bun test

# Run tests in watch mode
bun test:watch
```

## Usage

### MediaSession (High-Level API)

```typescript
import { MediaSession } from '@web-moq/media';

// Create media session
const session = new MediaSession({
  url: 'https://relay.example.com/moq',
  serverCertificateHashes: [fingerprintBuffer],
});

// Connect
await session.connect();

// Publish media from camera/microphone
const stream = await navigator.mediaDevices.getUserMedia({
  video: { width: 1280, height: 720 },
  audio: true,
});

await session.publish(['room', 'user-1'], 'camera', stream, {
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

// Subscribe to remote media
const remoteStream = await session.subscribe(
  ['room', 'user-2'],
  'camera',
  {
    video: { codec: 'avc1.4D401E', codedWidth: 1280, codedHeight: 720 },
    audio: { sampleRate: 48000, numberOfChannels: 2 },
  }
);

// Attach to video element
videoElement.srcObject = remoteStream;

// Close session
await session.close();
```

### PublishPipeline

```typescript
import { PublishPipeline } from '@web-moq/media';

const pipeline = new PublishPipeline({
  video: {
    width: 1280,
    height: 720,
    bitrate: 2_000_000,
    framerate: 30,
    keyFrameInterval: 2, // seconds
  },
  audio: {
    sampleRate: 48000,
    numberOfChannels: 2,
    bitrate: 128000,
  },
});

// Listen for encoded objects
pipeline.on('video-object', (obj) => {
  console.log('Video object:', obj.groupId, obj.objectId, obj.data.length);
  // Send via session.sendObject(...)
});

pipeline.on('audio-object', (obj) => {
  console.log('Audio object:', obj.groupId, obj.objectId, obj.data.length);
});

// Start with media stream
const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
await pipeline.start(stream);

// Stop
await pipeline.stop();
```

### SubscribePipeline

```typescript
import { SubscribePipeline } from '@web-moq/media';

const pipeline = new SubscribePipeline({
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

// Listen for decoded frames
pipeline.on('video-frame', (frame) => {
  // Render VideoFrame to canvas
  ctx.drawImage(frame, 0, 0);
  frame.close();
});

pipeline.on('audio-data', (data) => {
  // Process AudioData
});

// Start pipeline
await pipeline.start();

// Feed received objects
pipeline.pushVideoObject(data, groupId, objectId);
pipeline.pushAudioObject(data, groupId, objectId);

// Stop
await pipeline.stop();
```

### Video Encoder

```typescript
import { H264Encoder, H264Profiles } from '@web-moq/media';

const encoder = new H264Encoder({
  width: 1280,
  height: 720,
  bitrate: 2_000_000,
  framerate: 30,
  profile: H264Profiles.HIGH,
  keyFrameInterval: 2,
});

encoder.on('frame', (frame) => {
  console.log('Encoded frame:', {
    isKeyframe: frame.isKeyframe,
    timestamp: frame.timestamp,
    data: frame.data.length,
  });
});

await encoder.configure();
await encoder.encode(videoFrame);
await encoder.close();
```

### Audio Encoder

```typescript
import { OpusEncoder } from '@web-moq/media';

const encoder = new OpusEncoder({
  sampleRate: 48000,
  numberOfChannels: 2,
  bitrate: 128000,
});

encoder.on('frame', (frame) => {
  console.log('Encoded audio:', frame.data.length, 'bytes');
});

await encoder.configure();
await encoder.encode(audioData);
await encoder.close();
```

### LOC Container

```typescript
import { LOCPackager, LOCUnpackager, MediaType } from '@web-moq/media';

// Package video frame
const packager = new LOCPackager();
const locPacket = packager.packageVideo(encodedFrame, {
  width: 1280,
  height: 720,
  isKeyframe: true,
  timestamp: Date.now(),
});

// Unpackage
const unpackager = new LOCUnpackager();
const frame = unpackager.unpackage(locPacket);
console.log('Media type:', frame.mediaType === MediaType.VIDEO ? 'video' : 'audio');
```

### Web Workers

```typescript
import {
  CodecEncodeWorkerClient,
  CodecDecodeWorkerClient,
} from '@web-moq/media';

// Create encode worker client
const encodeWorker = new CodecEncodeWorkerClient(
  new Worker(new URL('@web-moq/media/codec-encode-worker', import.meta.url))
);

await encodeWorker.configure({
  video: { width: 1280, height: 720, bitrate: 2_000_000 },
  audio: { sampleRate: 48000, numberOfChannels: 2 },
});

encodeWorker.on('video-encoded', (result) => {
  console.log('Encoded in worker:', result.data.length);
});

// Send frame to worker
encodeWorker.encodeVideo(videoFrame);

// Create decode worker client
const decodeWorker = new CodecDecodeWorkerClient(
  new Worker(new URL('@web-moq/media/codec-decode-worker', import.meta.url))
);

await decodeWorker.configure({
  video: { codec: 'avc1.4D401E', codedWidth: 1280, codedHeight: 720 },
});

decodeWorker.on('video-decoded', (result) => {
  ctx.drawImage(result.frame, 0, 0);
  result.frame.close();
});
```

## API Reference

### MediaSession

High-level media streaming session.

**Methods:**
- `connect()` - Connect to relay
- `publish(namespace, trackName, stream, config)` - Publish media stream
- `subscribe(namespace, trackName, config)` - Subscribe to remote media
- `unpublish(trackAlias)` - Stop publishing
- `unsubscribe(subscriptionId)` - Stop subscription
- `close()` - Close session

### Encoders

- `H264Encoder` - Hardware-accelerated H.264 encoding
- `OpusEncoder` - Opus audio encoding

### Decoders

- `H264Decoder` - H.264 video decoding
- `OpusDecoder` - Opus audio decoding

### Pipelines

- `PublishPipeline` - Complete capture → encode → package pipeline
- `SubscribePipeline` - Complete unpackage → decode → render pipeline

### LOC Container

- `LOCPackager` - Package encoded frames into LOC format
- `LOCUnpackager` - Unpackage LOC packets
- `MediaType` - Enum for video/audio
- `LOCExtensionType` - Extension types for metadata

### Utilities

- `JitterBuffer` - Adaptive jitter buffer for smooth playback
- `BackpressureController` - Queue management with backpressure

## Resolution Presets

```typescript
import { getResolutionConfig } from '@web-moq/media';

// Get preset configuration
const config = getResolutionConfig('720p');
// { width: 1280, height: 720, bitrate: 2_500_000, framerate: 30 }

// Available presets: '360p', '480p', '720p', '1080p', '4k'
```

## License

BSD-2-Clause
