# @web-moq/core

Core MOQT (Media over QUIC Transport) protocol types, encoding, state management, and transport layer.

## Overview

This package provides the fundamental building blocks for implementing MOQT in TypeScript:

- **Protocol Types**: Message types, enums, and interfaces for MOQT Draft-14 and Draft-16
- **Encoding/Decoding**: VarInt encoding, message codec for serializing/deserializing MOQT messages
- **State Machines**: Connection, subscription, and announcement state management
- **Transport Layer**: WebTransport wrapper, stream management, and datagram handling
- **Track Management**: Track naming, aliasing, and priority scheduling
- **Utilities**: Logging, buffer pooling, CityHash64 for track alias computation

## Installation

```bash
bun add @web-moq/core
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

# Run tests with Draft-16
MOQT_VERSION=draft-16 bun test
```

## Usage

### Basic Message Encoding/Decoding

```typescript
import {
  MessageCodec,
  MessageType,
  Version,
  SetupParameter,
} from '@web-moq/core';

// Encode a CLIENT_SETUP message
const clientSetup = {
  type: MessageType.CLIENT_SETUP,
  supportedVersions: [Version.DRAFT_14],
  parameters: new Map([[SetupParameter.PATH, '/moq']]),
};

const bytes = MessageCodec.encode(clientSetup);

// Decode a message
const [message, bytesRead] = MessageCodec.decode(bytes);
```

### WebTransport Connection

```typescript
import { MOQTransport, Logger, LogLevel } from '@web-moq/core';

// Configure logging
Logger.setLevel(LogLevel.DEBUG);

// Create and connect transport
const transport = new MOQTransport();
await transport.connect('https://relay.example.com/moq', {
  serverCertificateHashes: [fingerprintBuffer],
});

// Listen for events
transport.on('control-message', (data) => {
  console.log('Received control message:', data.length, 'bytes');
});

transport.on('unidirectional-stream', (stream) => {
  console.log('Received incoming stream');
});

// Send control messages
await transport.sendControl(messageBytes);

// Create outgoing stream
const stream = await transport.createUnidirectionalStream();
const writer = stream.getWriter();
await writer.write(data);
await writer.close();

// Send datagrams
await transport.sendDatagram(data);
```

### Track Management

```typescript
import { TrackManager, trackNameToKey } from '@web-moq/core';

const trackManager = new TrackManager();

// Add a published track
trackManager.addPublishedTrack({
  namespace: ['conference', 'room-1'],
  trackName: 'video',
  priority: 128,
});

// Generate track key
const key = trackNameToKey(['conference', 'room-1'], 'video');
```

### VarInt Encoding

```typescript
import { VarInt, BufferWriter, BufferReader } from '@web-moq/core';

// Encode a varint
const encoded = VarInt.encode(12345n);

// Decode a varint
const [value, bytesRead] = VarInt.decode(encoded);

// Use BufferWriter for multiple values
const writer = new BufferWriter();
writer.writeVarInt(100);
writer.writeString('hello');
writer.writeBytes(new Uint8Array([1, 2, 3]));
const bytes = writer.toUint8Array();

// Use BufferReader for reading
const reader = new BufferReader(bytes);
const num = reader.readVarInt();
const str = reader.readString();
const data = reader.readBytes(3);
```

## API Reference

### Message Types

- `MessageType` - Enum of all MOQT message types
- `Version` - Supported MOQT versions (DRAFT_14, DRAFT_15, DRAFT_16)
- `GroupOrder` - Object delivery order (ASCENDING, DESCENDING)
- `FilterType` - Subscription filter types
- `ObjectStatus` - Object status codes

### Transport

- `MOQTransport` - WebTransport wrapper with event handling
- `StreamManager` - Manages bidirectional and unidirectional streams
- `DatagramManager` - Handles datagram send/receive

### Encoding

- `MessageCodec` - Encode/decode MOQT control messages
- `ObjectCodec` - Encode/decode MOQT objects
- `VarInt` - Variable-length integer encoding
- `BufferWriter` / `BufferReader` - Binary serialization utilities

### State Management

- `ConnectionStateMachine` - Connection state transitions
- `SubscriptionStateMachine` - Subscription lifecycle
- `AnnouncementStateMachine` - Announcement lifecycle

### Utilities

- `Logger` - Configurable logging with levels
- `BufferPool` - Efficient buffer allocation
- `cityHash64` - CityHash64 for track alias computation

## License

BSD-2-Clause
