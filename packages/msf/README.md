# @web-moq/msf

MOQT Streaming Format (MSF) implementation - JSON catalogs for LOC-compliant media delivery over MOQT.

Based on the [MSF specification](https://github.com/moq-wg/msf).

## Installation

```bash
pnpm add @web-moq/msf
```

## Build

```bash
pnpm build
```

## Test

```bash
pnpm test           # Run tests once
pnpm test:watch     # Run tests in watch mode
```

## Usage

### Creating a Catalog

```typescript
import { createCatalog } from '@web-moq/msf';

const catalog = createCatalog()
  .generatedAt()
  .addVideoTrack({
    name: 'video-main',
    codec: 'avc1.4D401E',
    width: 1280,
    height: 720,
    framerate: 30,
    bitrate: 2_000_000,
    isLive: true,
  })
  .addAudioTrack({
    name: 'audio-main',
    codec: 'opus',
    samplerate: 48000,
    channelConfig: 'stereo',
    isLive: true,
  })
  .build();
```

### Parsing and Validating Catalogs

```typescript
import { parseCatalog, parseFullCatalog } from '@web-moq/msf';

// Parse any catalog (full or delta)
const catalog = parseCatalog(jsonString);

// Parse specifically a full catalog
const fullCatalog = parseFullCatalog(jsonString);

// Parse from bytes
import { parseCatalogFromBytes } from '@web-moq/msf';
const catalog = parseCatalogFromBytes(uint8Array);
```

### Delta Updates

```typescript
import { generateDelta, applyDelta, createDelta } from '@web-moq/msf';

// Generate delta between two catalogs
const delta = generateDelta(oldCatalog, newCatalog);

// Apply delta to a catalog
const updatedCatalog = applyDelta(baseCatalog, delta);

// Build a delta manually
const delta = createDelta()
  .add({ name: 'new-track', packaging: 'loc', isLive: true })
  .remove('old-track')
  .clone('video-main', 'video-copy', { bitrate: 1_000_000 })
  .build();
```

### Media Timelines

```typescript
import {
  encodeMediaTimeline,
  decodeMediaTimeline,
  findLocationForTime,
  MediaTimelineCalculator,
} from '@web-moq/msf';

// Explicit timeline entries
const points = [
  { mediaPTS: 0, groupId: 0, objectId: 0 },
  { mediaPTS: 3000, groupId: 0, objectId: 1 },
];
const encoded = encodeMediaTimeline(points);

// Template-based timeline (for constant framerate)
const calc = new MediaTimelineCalculator({
  startMediaTime: 0,
  deltaMediaTime: 3000, // 30fps at 90kHz
  startGroupId: 0,
  startObjectId: 0,
  deltaGroupId: 0,
  deltaObjectId: 1,
});

const location = calc.locationForTime(90000); // [0, 30]
const time = calc.timeForLocation(0, 15);     // 45000
```

### Event Timelines

```typescript
import {
  createWallclockEvent,
  createLocationEvent,
  createMediaTimeEvent,
  encodeEventTimeline,
} from '@web-moq/msf';

const events = [
  createWallclockEvent(Date.now(), { type: 'ad-start' }),
  createLocationEvent(5, 0, { type: 'keyframe' }),
  createMediaTimeEvent(90000, { type: 'chapter' }),
];

const encoded = encodeEventTimeline(events);
```

### URL Encoding

```typescript
import { generateMsfUrl, parseMsfUrl, generateCatalogUrl } from '@web-moq/msf';

// Generate URL for a track
const url = generateMsfUrl(
  'https://relay.example.com/moq',
  ['conference', 'room-123'],
  'video-main'
);
// => 'https://relay.example.com/moq#conference-room.2d123--video.2dmain'

// Parse URL
const parsed = parseMsfUrl(url);
// => { namespace: ['conference', 'room-123'], trackName: 'video-main', ... }

// Catalog URL
const catalogUrl = generateCatalogUrl(
  'https://relay.example.com/moq',
  ['conference', 'room-123']
);
```

### Session Integration

```typescript
import { createMSFSession } from '@web-moq/msf';

// Create MSF session from MOQT session
const msfSession = createMSFSession(moqtSession, ['conference', 'room-1']);

// Publish catalogs
await msfSession.startCatalogPublishing();
await msfSession.publishCatalog(catalog);

// Subscribe to catalogs
await msfSession.subscribeToCatalog((catalog, isDelta) => {
  console.log('Received catalog:', catalog);
});
```

### Encryption Support

```typescript
const catalog = createCatalog()
  .addVideoTrack({
    name: 'video-encrypted',
    codec: 'avc1.4D401E',
    width: 1920,
    height: 1080,
    isLive: true,
    encryptionScheme: 'moq-secure-objects',
    cipherSuite: 'aes-128-gcm-sha256',
    keyId: 'base64-encoded-key-id',
  })
  .build();
```

## License

BSD-2-Clause
