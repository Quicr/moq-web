# MOQT TypeScript Library - Design Document

## Overview

This document describes the architecture and design of the MOQT (Media over QUIC Transport) TypeScript library. Built with WebTransport and WebCodecs for browser-based real-time media applications, this library provides a complete implementation of the MOQT protocol with optional Web Worker offloading for high-performance media streaming.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Web Application                                    │
│                        (@web-moq/client React)                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                      @web-moq/media (Media Layer)                            │
│  ┌────────────────┐  ┌─────────────────┐  ┌───────────────────────────────┐ │
│  │ MediaSession   │  │ PublishPipeline │  │     SubscribePipeline         │ │
│  └────────────────┘  └─────────────────┘  └───────────────────────────────┘ │
│  ┌────────────────┐  ┌─────────────────┐  ┌───────────────────────────────┐ │
│  │  H264Encoder   │  │   H264Decoder   │  │       JitterBuffer            │ │
│  │  OpusEncoder   │  │   OpusDecoder   │  │   BackpressureController      │ │
│  └────────────────┘  └─────────────────┘  └───────────────────────────────┘ │
│  ┌────────────────┐  ┌─────────────────┐                                    │
│  │  LOCPackager   │  │  LOCUnpackager  │   (LOC Container Format)           │
│  └────────────────┘  └─────────────────┘                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                    @web-moq/session (Session Layer)                          │
│  ┌────────────────┐  ┌─────────────────┐  ┌───────────────────────────────┐ │
│  │  MOQTSession   │  │  ObjectRouter   │  │    SubscriptionManager        │ │
│  └────────────────┘  └─────────────────┘  └───────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                      PublicationManager                                 │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────────────┤
│                 @web-moq/core (Protocol + Transport)                         │
│  ┌────────────────┐  ┌─────────────────┐  ┌───────────────────────────────┐ │
│  │  MOQTransport  │  │  StreamManager  │  │     DatagramManager           │ │
│  └────────────────┘  └─────────────────┘  └───────────────────────────────┘ │
│  ┌────────────────┐  ┌─────────────────┐  ┌───────────────────────────────┐ │
│  │  MessageCodec  │  │  TrackManager   │  │  ConnectionStateMachine       │ │
│  │  ObjectCodec   │  │ PriorityScheduler│  │  SubscriptionStateMachine    │ │
│  └────────────────┘  └─────────────────┘  └───────────────────────────────┘ │
│  ┌────────────────┐  ┌─────────────────┐  ┌───────────────────────────────┐ │
│  │    VarInt      │  │  MessageTypes   │  │        Logger                 │ │
│  │  BufferReader  │  │    Version      │  │     BufferPool                │ │
│  └────────────────┘  └─────────────────┘  └───────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────────────┤
│                          WebTransport API                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Package Structure

### @web-moq/core

Core protocol implementation and transport layer.

**Protocol Encoding**
- `MessageCodec` - Encodes/decodes all MOQT control messages
- `ObjectCodec` - Encodes/decodes data stream objects
- `VarInt` - QUIC-style variable-length integer encoding
- `BufferReader/BufferWriter` - Binary buffer manipulation

**Transport**
- `MOQTransport` - High-level WebTransport wrapper with event emission
- `StreamManager` - Unidirectional stream lifecycle management
- `DatagramManager` - Datagram send/receive with size validation

**Protocol Types**
- `MessageType` - All MOQT message type constants (Draft-14 and Draft-16)
- `Version` - Protocol version constants (0xff00000e, 0xff000010)
- `SetupParameter`, `RequestParameter` - Parameter enums
- `SessionErrorCode`, `SubscribeErrorCode` - Error code enums

**State Management**
- `ConnectionStateMachine` - Connection state transitions
- `SubscriptionStateMachine` - Subscription lifecycle states
- `AnnouncementStateMachine` - Announcement state tracking

**Track Management**
- `TrackManager` - Track name to alias mapping
- `PriorityScheduler` - 4-level priority scheduling for objects

**Utilities**
- `Logger` - Configurable multi-level logging with namespace filtering
- `BufferPool` - Efficient buffer reuse to reduce GC pressure
- `RingBuffer` - Circular buffer for queuing
- `CityHash64` - Track alias hashing for LAPS compatibility

**Version Selection**
- `IS_DRAFT_14`, `IS_DRAFT_16` - Build-time version constants
- `MOQT_VERSION` - Current protocol version
- `getCurrentALPNProtocol()` - Version-appropriate ALPN string

### @web-moq/session

Generic MOQT session management without media dependencies.

**Session**
- `MOQTSession` - Session setup and protocol orchestration
  - Dual-mode: main thread or worker-based transport
  - Methods: `connect()`, `setup()`, `publish()`, `subscribe()`, `sendObject()`
  - Events: `state-change`, `error`, `publish-stats`, `subscribe-stats`

**Managers**
- `SubscriptionManager` - Track subscription lifecycle and routing
- `PublicationManager` - Track publication lifecycle and forwarding
- `ObjectRouter` - Routes received objects to active subscriptions

**Transport Worker**
- `transport-worker.ts` - Worker implementation running WebTransport off main thread
- `TransportWorkerClient` - RPC client for communicating with transport worker
- Full session protocol runs in worker for main thread responsiveness

### @web-moq/media

WebCodecs integration with LOC container format.

**WebCodecs Wrappers**
- `H264Encoder` - VideoEncoder wrapper for H.264 encoding
- `H264Decoder` - VideoDecoder wrapper for H.264 decoding
- `OpusEncoder` - AudioEncoder wrapper for Opus encoding
- `OpusDecoder` - AudioDecoder wrapper for Opus decoding

**LOC Container**
- `LOCPackager` - Packages encoded frames into LOC format
- `LOCUnpackager` - Extracts frames from LOC containers
- Extensions: CAPTURE_TIMESTAMP, VIDEO_FRAME_MARKING, AUDIO_LEVEL, CODEC_DATA

**Pipelines**
- `PublishPipeline` - Capture → Encode → Package → Publish
- `SubscribePipeline` - Receive → Unpack → Decode → Render
- `JitterBuffer` - Reordering buffer for smooth playback
- `BackpressureController` - Queue pressure management

**Media Session**
- `MediaSession` - High-level media session wrapping MOQTSession
  - Dual-mode: main thread transport or worker-based transport
  - Integrates publish and subscribe pipelines
  - Events: `video-frame`, `audio-data`, `state-change`, `error`

**Codec Workers**
- `codec-encode-worker.ts` - WebCodecs encoding + LOC packaging in worker
- `codec-decode-worker.ts` - LOC unpacking + WebCodecs decoding in worker
- `CodecEncodeWorkerClient` / `CodecDecodeWorkerClient` - Worker RPC clients

### @web-moq/client

React web application for MOQT testing and demonstration.

**State Management (Zustand)**
- `ConnectionSlice` - Transport and session state, connect/disconnect
- `PublishSlice` - Published tracks, local stream, encoding settings
- `SubscribeSlice` - Subscribed tracks, available tracks
- `ChatSlice` - Real-time messaging state
- `SettingsSlice` - Theme, codecs, delivery mode, worker toggle

**Components**
- `ConnectionPanel` - Server URL, local dev toggle, worker toggle
- `PublishPanel` - Media capture, start/stop publishing
- `SubscribePanel` - Track browser, subscription management
- `VideoRenderer` - Canvas-based video playback
- `AudioPlayer` - Audio playback component
- `StatusPanel` - Protocol version badge, worker mode indicator
- `SettingsPanel` - Codec and delivery configuration
- `DevSettingsPanel` - Debug settings (log level)

## Protocol Compatibility

### Supported Versions

| Draft | Version Number | ALPN String | Build Flag |
|-------|---------------|-------------|------------|
| Draft-14 | 0xff00000e | `moqt-14` | Default |
| Draft-16 | 0xff000010 | `moqt` | `MOQT_VERSION=draft-16` |

### Build-Time Version Selection

The protocol version is selected at build time via environment variable:

```bash
# Build for Draft-14 (default)
pnpm build

# Build for Draft-16
MOQT_VERSION=draft-16 pnpm build
```

The build system uses conditional compilation to include only the relevant protocol code, eliminating dead code from the bundle.

### Draft-16 Changes

Key differences from Draft-14:
- Version negotiation via ALPN (no version list in CLIENT_SETUP/SERVER_SETUP)
- Request ID parity: clients use even (0, 2, 4...), servers use odd (1, 3, 5...)
- New message types: REQUEST_OK, REQUEST_ERROR, NAMESPACE, NAMESPACE_DONE
- Expanded request parameters: SUBSCRIPTION_FILTER, GROUP_ORDER, SUBSCRIBER_PRIORITY
- Three-state ObjectExistence enum (UNKNOWN, EXISTS, DOES_NOT_EXIST)
- Authorization token with alias support

## Web Workers Architecture

The library supports offloading CPU-intensive work to Web Workers for improved main thread responsiveness.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Main Thread                                       │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │  @web-moq/client (React UI)                                             ││
│  │    ↓ MediaStream                    ↑ VideoFrame/AudioData              ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │  MediaSession                                                           ││
│  │    ├── TransportWorkerClient ←──────────────────┐                       ││
│  │    ├── CodecEncodeWorkerClient ←────────────┐   │                       ││
│  │    └── CodecDecodeWorkerClient ←────────┐   │   │                       ││
│  └─────────────────────────────────────────│───│───│───────────────────────┘│
└────────────────────────────────────────────│───│───│───────────────────────-┘
                                             │   │   │
              ┌──────────────────────────────┘   │   │
              │   ┌──────────────────────────────┘   │
              │   │   ┌──────────────────────────────┘
              ▼   ▼   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Worker Threads                                     │
│  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────────────┐│
│  │ Decode Worker     │  │ Encode Worker     │  │ Transport Worker          ││
│  │ ┌───────────────┐ │  │ ┌───────────────┐ │  │ ┌───────────────────────┐ ││
│  │ │LOCUnpackager  │ │  │ │ H264Encoder   │ │  │ │ MOQTransport          │ ││
│  │ │H264Decoder    │ │  │ │ OpusEncoder   │ │  │ │ MOQTSession           │ ││
│  │ │OpusDecoder    │ │  │ │ LOCPackager   │ │  │ │ StreamManager         │ ││
│  │ │JitterBuffer   │ │  │ └───────────────┘ │  │ │ DatagramManager       │ ││
│  │ └───────────────┘ │  │                   │  │ └───────────────────────┘ ││
│  └───────────────────┘  └───────────────────┘  └───────────────────────────┘│
│        ↓ VideoFrame          ↓ LOC Packet           ↓ WebTransport          │
│        ↓ AudioData                                  ↓ QUIC                  │
└─────────────────────────────────────────────────────────────────────────────┘
                    Transferable ArrayBuffers (zero-copy)
```

### Worker Configuration

Workers are configured via `WorkerConfig`:

```typescript
interface WorkerConfig {
  transportWorker?: Worker;  // WebTransport + MOQT session
  encodeWorker?: Worker;     // H.264/Opus encoding + LOC packaging
  decodeWorker?: Worker;     // LOC unpacking + H.264/Opus decoding
}
```

### Operation Modes

**Main Thread Mode** (workers disabled):
- All processing on main thread
- Simpler debugging
- May cause UI jank with high-resolution video

**Worker Mode** (workers enabled):
- Transport runs in dedicated worker (WebTransport + MOQT session)
- Main thread stays responsive for WebTransport operations
- Zero-copy ArrayBuffer transfers between threads

**Current Limitation:**
Codec workers (encode/decode) are not currently shared between multiple tracks because
the worker has single global state. Each track uses main thread encoding/decoding to
ensure proper isolation. Future improvements could implement:
1. Per-track codec workers
2. Multiplexed worker protocol with track ID routing

### Client Worker Toggle

The client application provides a UI toggle for enabling/disabling workers:

```
┌─────────────────────────────────────────┐
│ Connection                              │
│ ─────────────────────────────────────── │
│ Relay URL: https://localhost:4443/moq   │
│ Local Development: [ON]                 │
│ Use Web Workers:   [ON]                 │
│                                         │
│ [Connect]                               │
└─────────────────────────────────────────┘
```

When workers are enabled:
- Status panel shows "Workers" badge (green)
- Transport, encoding, and decoding all run off main thread

When workers are disabled:
- Status panel shows "Main Thread" badge (gray)
- All processing happens on main thread

## Data Flow

### Session Setup Flow

```
Client                          Relay
  │                               │
  │─── WebTransport Connect ─────▶│
  │                               │
  │─── CLIENT_SETUP ─────────────▶│
  │    (versions, params)         │
  │                               │
  │◀───────── SERVER_SETUP ───────│
  │    (selected version, params) │
  │                               │
  │      (Session Ready)          │
```

### Publishing Flow

```
Client                          Relay
  │                               │
  │─── PUBLISH ──────────────────▶│
  │    (namespace, trackName)     │
  │                               │
  │◀──────── PUBLISH_OK ──────────│
  │    (trackAlias)               │
  │                               │
  │─── stream/datagram ──────────▶│
  │    (video/audio objects)      │
```

**Publish Pipeline:**

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Camera/   │───▶│  WebCodecs  │───▶│     LOC     │───▶│   MOQT      │
│   Mic       │    │  Encoder    │    │  Packager   │    │  Session    │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
     │                   │                   │                  │
  VideoFrame        EncodedChunk        LOC Packet         Stream/
  AudioData                                               Datagram
```

### Subscribing Flow

```
Client                          Relay
  │                               │
  │─── SUBSCRIBE ────────────────▶│
  │    (namespace, trackName)     │
  │                               │
  │◀───────── SUBSCRIBE_OK ───────│
  │    (trackAlias)               │
  │                               │
  │◀──── stream/datagram ─────────│
  │    (video/audio objects)      │
```

**Subscribe Pipeline:**

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   MOQT      │───▶│   Jitter    │───▶│     LOC     │───▶│  WebCodecs  │
│  Session    │    │   Buffer    │    │ Unpackager  │    │  Decoder    │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
     │                   │                   │                  │
  Stream/           Reordered           Raw Frame          VideoFrame
  Datagram           Frames               Data             AudioData
```

## Track Naming Convention

```
Namespace: ['app', 'room-id', 'type']
TrackName: 'participant-id/media-type'

Example:
  Namespace: ['conference', 'room-123', 'media']
  TrackName: 'user-456/video'
  Full: conference/room-123/media:user-456/video
```

## Delivery Modes

### Stream Mode (Reliable)

- Uses unidirectional QUIC streams
- Subgroup-based delivery (one stream per GOP)
- Guaranteed delivery with retransmission
- Higher latency but no packet loss
- Recommended for: recordings, non-real-time playback

### Datagram Mode (Low-Latency)

- Uses QUIC datagrams
- Best-effort delivery (no retransmission)
- Lowest latency
- May experience packet loss
- Recommended for: live streaming, real-time communication

## LOC Container Format

The library implements the Low Overhead Container (LOC) format per draft-ietf-moq-loc:

```
┌──────────────────────────────────────────────┐
│ LOC Header                                   │
│ ┌──────────────┬───────────────────────────┐ │
│ │ MediaType(1) │ Extensions (variable)     │ │
│ └──────────────┴───────────────────────────┘ │
├──────────────────────────────────────────────┤
│ Payload (encoded frame data)                 │
└──────────────────────────────────────────────┘
```

**Extensions:**
- `CAPTURE_TIMESTAMP` (0x01) - Original capture time
- `VIDEO_FRAME_MARKING` (0x02) - Temporal/spatial layer info
- `AUDIO_LEVEL` (0x03) - Audio level metadata
- `CODEC_DATA` (0x04) - Codec-specific data (SPS/PPS)

## Security Considerations

1. **WebTransport Security**: All connections over HTTPS/TLS 1.3
2. **Origin Validation**: Browser enforces same-origin policy
3. **Certificate Pinning**: Support for self-signed certs in development
4. **Input Validation**: VarInt bounds checking, message size limits
5. **Worker Isolation**: Workers run in separate security contexts

## Performance Considerations

1. **Zero-Copy Transfers**: Transferable ArrayBuffers between workers
2. **Priority Scheduling**: Keyframes get higher priority than delta frames
3. **Jitter Buffer**: Adaptive delay for smooth playback
4. **Hardware Acceleration**: Prefer GPU for encoding/decoding via WebCodecs
5. **Memory Management**: Ring buffers prevent unbounded growth
6. **Buffer Pooling**: Reusable Uint8Array pool reduces GC pressure
7. **Backpressure Control**: Priority queue with adaptive bitrate signaling
8. **Pre-allocated Buffers**: Avoid allocations in hot paths

## Logging

Multi-level logging with namespace filtering:

```typescript
import { Logger, LogLevel } from '@web-moq/core';

// Configure global level
Logger.setLevel(LogLevel.DEBUG);

// Filter by namespace
Logger.configure({
  include: ['moqt:transport:*'],
  exclude: ['moqt:transport:heartbeat'],
});

// Create module logger
const log = Logger.create('moqt:session');
log.debug('Session setup complete', { state: 'ready' });
```

Log levels: `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`

## File Structure

```
packages/
├── core/src/
│   ├── encoding/          # Message and object codecs
│   │   ├── message-codec.ts
│   │   ├── object-codec.ts
│   │   └── varint.ts
│   ├── messages/          # Protocol type definitions
│   │   └── types.ts
│   ├── transport/         # WebTransport wrapper
│   │   └── transport.ts
│   ├── streams/           # Stream management
│   │   └── stream-manager.ts
│   ├── datagrams/         # Datagram management
│   │   └── datagram-manager.ts
│   ├── track/             # Track and priority management
│   │   ├── track-manager.ts
│   │   └── priority-scheduler.ts
│   ├── connection/        # State machines
│   │   └── state-machine.ts
│   ├── buffer/            # Buffer utilities
│   │   ├── buffer-pool.ts
│   │   └── ring-buffer.ts
│   ├── version/           # Version constants
│   │   └── constants.ts
│   └── utils/             # Utilities
│       └── logger.ts
│
├── session/src/
│   ├── session.ts         # MOQTSession main class
│   ├── subscription-manager.ts
│   ├── publication-manager.ts
│   ├── object-router.ts
│   ├── types.ts
│   └── workers/           # Transport worker
│       ├── transport-worker.ts
│       ├── transport-worker-api.ts
│       └── transport-worker-types.ts
│
├── media/src/
│   ├── webcodecs/         # Codec wrappers
│   │   ├── video-encoder.ts
│   │   ├── video-decoder.ts
│   │   ├── audio-encoder.ts
│   │   └── audio-decoder.ts
│   ├── loc/               # LOC container
│   │   └── loc-container.ts
│   ├── pipeline/          # Media pipelines
│   │   ├── publish-pipeline.ts
│   │   ├── subscribe-pipeline.ts
│   │   ├── jitter-buffer.ts
│   │   └── backpressure.ts
│   ├── session/           # Media session
│   │   ├── media-session.ts
│   │   └── types.ts
│   └── workers/           # Codec workers
│       ├── codec-encode-worker.ts
│       ├── codec-encode-worker-api.ts
│       ├── codec-decode-worker.ts
│       └── codec-decode-worker-api.ts
│
└── client/src/
    ├── App.tsx
    ├── main.tsx
    ├── store/             # Zustand state
    │   └── index.ts
    ├── components/        # React components
    │   ├── connection/
    │   ├── publish/
    │   ├── subscribe/
    │   ├── chat/
    │   └── common/
    ├── workers/           # Worker entry points
    │   ├── transport-worker.ts
    │   ├── codec-encode-worker.ts
    │   └── codec-decode-worker.ts
    └── types/
        └── index.ts
```

## Usage Examples

### Basic Publishing

```typescript
import { MOQTransport } from '@web-moq/core';
import { MediaSession } from '@web-moq/media';

// Create transport and session
const transport = new MOQTransport();
await transport.connect('https://relay.example.com/moq');

const session = new MediaSession(transport);
await session.setup();

// Get media stream
const stream = await navigator.mediaDevices.getUserMedia({
  video: { width: 1280, height: 720 },
  audio: true,
});

// Start publishing
const trackAlias = await session.publish(
  ['conference', 'room-1'],
  'video',
  stream,
  {
    videoBitrate: 2_000_000,
    audioBitrate: 128_000,
    videoResolution: '720p',
    deliveryMode: 'stream',
  }
);
```

### Basic Subscribing

```typescript
import { MOQTransport } from '@web-moq/core';
import { MediaSession } from '@web-moq/media';

const transport = new MOQTransport();
await transport.connect('https://relay.example.com/moq');

const session = new MediaSession(transport);
await session.setup();

// Handle video frames
session.on('video-frame', ({ subscriptionId, frame }) => {
  ctx.drawImage(frame, 0, 0);
  frame.close();
});

// Subscribe to track
const subscriptionId = await session.subscribe(
  ['conference', 'room-1'],
  'video',
  { videoBitrate: 2_000_000, audioBitrate: 128_000, videoResolution: '720p' },
  'video'
);
```

### Worker Mode

```typescript
import { MediaSession } from '@web-moq/media';

// Create workers
const transportWorker = new Worker(
  new URL('@web-moq/session/worker', import.meta.url),
  { type: 'module' }
);
const encodeWorker = new Worker(
  new URL('@web-moq/media/codec-encode-worker', import.meta.url),
  { type: 'module' }
);
const decodeWorker = new Worker(
  new URL('@web-moq/media/codec-decode-worker', import.meta.url),
  { type: 'module' }
);

// Create session with workers
const session = new MediaSession({
  workers: { transportWorker, encodeWorker, decodeWorker },
  serverCertificateHashes: [certHash], // For self-signed certs
});

// Connect via worker
await session.connect('https://relay.example.com/moq');
await session.setup();

// Rest of API is identical to main thread mode
```

## Future Considerations

1. **Scalable Video Coding**: SVC support for adaptive bitrate
2. **Congestion Control**: Integration with QUIC CC signals
3. **FEC**: Forward error correction for datagram mode
4. **Multi-track Sync**: A/V synchronization across tracks
5. **Recording**: Local recording support
6. **Simulcast**: Multiple quality layers for adaptive streaming
7. **AV1/VP9**: Additional codec support
8. **E2E Encryption**: End-to-end media encryption
