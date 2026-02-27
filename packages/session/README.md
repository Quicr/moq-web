# @web-moq/session

Generic MOQT session management - protocol layer without media-specific dependencies.

## Overview

This package provides a complete MOQT session implementation:

- **Session Management**: Connection setup, teardown, and state handling
- **Subscribe Flow**: Subscribe to tracks, receive objects, manage subscriptions
- **Publish Flow**: Publish to tracks, send objects with various delivery modes
- **Announce Flow**: Announce namespaces and handle incoming subscriptions
- **Worker Support**: Optional off-main-thread transport for better performance

## Installation

```bash
bun add @web-moq/session
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

### Basic Session (Main Thread)

```typescript
import { MOQTSession } from '@web-moq/session';
import { MOQTransport } from '@web-moq/core';

// Create and connect transport
const transport = new MOQTransport();
await transport.connect('https://relay.example.com/moq', {
  serverCertificateHashes: [fingerprintBuffer],
});

// Create session
const session = new MOQTSession(transport);
await session.setup();

console.log('Session ready:', session.isReady);
```

### Worker-Based Session

```typescript
import { MOQTSession } from '@web-moq/session';

// Create transport worker
const worker = new Worker(
  new URL('@web-moq/session/worker', import.meta.url),
  { type: 'module' }
);

// Create session with worker
const session = new MOQTSession({
  worker,
  serverCertificateHashes: [fingerprintBuffer],
  connectionTimeout: 10000,
});

// Connect via worker
await session.connect('https://relay.example.com/moq');
await session.setup();
```

### Subscribing to Tracks

```typescript
// Subscribe to a track
const subscriptionId = await session.subscribe(
  ['conference', 'room-1'],  // namespace
  'video',                    // track name
  {
    priority: 128,
    groupOrder: GroupOrder.ASCENDING,
  },
  (data, groupId, objectId, timestamp) => {
    console.log('Received object:', { groupId, objectId, bytes: data.length });
  }
);

// Listen for object events
session.on('object', (event) => {
  console.log('Object received:', {
    subscriptionId: event.subscriptionId,
    groupId: event.groupId,
    objectId: event.objectId,
  });
});

// Pause/resume subscription
await session.pauseSubscription(subscriptionId);
await session.resumeSubscription(subscriptionId);

// Unsubscribe
await session.unsubscribe(subscriptionId);
```

### Publishing to Tracks

```typescript
// Publish to a track
const trackAlias = await session.publish(
  ['conference', 'room-1'],  // namespace
  'video',                    // track name
  {
    priority: 128,
    deliveryTimeout: 5000,
    deliveryMode: 'stream',   // 'stream' or 'datagram'
  }
);

// Send objects
await session.sendObject(trackAlias, videoData, {
  type: 'video',
  groupId: 0,
  objectId: 0,
  isKeyframe: true,
  timestamp: Date.now(),
});

// Send via specific method
await session.sendObjectViaStream(trackAlias, data, metadata, priority);
await session.sendObjectViaDatagram(trackAlias, data, metadata, priority);

// Stop publishing
await session.unpublish(trackAlias);
```

### Announce Flow (Publisher-Initiated)

```typescript
// Announce a namespace
await session.announceNamespace(['conference', 'room-1', 'media'], {
  priority: 128,
  deliveryMode: 'stream',
});

// Listen for incoming subscriptions
session.on('incoming-subscribe', async (event) => {
  console.log('Subscriber wants:', event.trackName);
  console.log('Track alias assigned:', event.trackAlias);

  // Start sending media for this track
  await session.sendObject(event.trackAlias, data, {
    groupId: 0,
    objectId: 0,
    type: 'video',
  });
});

// Get current subscribers
const subscribers = session.getSubscribers(['conference', 'room-1', 'media']);

// Cancel announcement
await session.cancelAnnounce(['conference', 'room-1', 'media']);
```

### Event Handling

```typescript
// State changes
session.on('state-change', (state) => {
  console.log('Session state:', state);
});

// Errors
session.on('error', (error) => {
  console.error('Session error:', error);
});

// Publish stats
session.on('publish-stats', (stats) => {
  console.log('Published:', stats.bytes, 'bytes');
});

// Subscribe stats
session.on('subscribe-stats', (stats) => {
  console.log('Received:', stats.bytes, 'bytes');
});
```

### Closing the Session

```typescript
// Close cleanly (stops all subscriptions and publications)
await session.close();
```

## API Reference

### MOQTSession

Main session class supporting both main thread and worker modes.

**Constructor:**
- `new MOQTSession(transport: MOQTransport)` - Main thread mode
- `new MOQTSession(config: MOQTSessionConfig)` - Worker mode

**Properties:**
- `state: SessionState` - Current session state
- `isReady: boolean` - Whether session is ready for operations
- `maxDatagramSize: number` - Maximum datagram size in bytes

**Methods:**
- `connect(url: string)` - Connect (worker mode only)
- `setup()` - Perform MOQT handshake
- `close()` - Close session
- `subscribe(...)` - Subscribe to a track
- `unsubscribe(subscriptionId)` - Cancel subscription
- `publish(...)` - Publish to a track
- `unpublish(trackAlias)` - Stop publishing
- `sendObject(...)` - Send an object
- `announceNamespace(...)` - Announce namespace
- `cancelAnnounce(...)` - Cancel announcement

### Types

```typescript
type SessionState = 'none' | 'setup' | 'ready' | 'error';

interface SubscribeOptions {
  priority?: number;
  groupOrder?: GroupOrder;
}

interface PublishOptions {
  priority?: number;
  groupOrder?: GroupOrder;
  deliveryTimeout?: number;
  deliveryMode?: 'stream' | 'datagram';
}

interface ObjectMetadata {
  type?: 'video' | 'audio' | 'data';
  groupId: number;
  objectId: number;
  isKeyframe?: boolean;
  timestamp?: number;
}
```

## License

BSD-2-Clause
