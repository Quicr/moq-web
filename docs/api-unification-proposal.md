# MOQT Unified API Proposal

## Executive Summary

This proposal outlines a clean, version-agnostic public API for moq-web that:
- Eliminates `*Draft18` naming from public exports
- Separates **request types** (public API) from **wire types** (internal)
- Makes dropping old drafts a clean delete operation
- Follows draft-16's Request/RequestOk/RequestError naming pattern

---

## Problem Statement

### Current State

The public API exposes draft-specific naming:

```typescript
// Current exports (cluttered)
import {
  MessageTypeDraft18,
  SubscribeMessageDraft18,
  SubscribeOkMessageDraft18,
  RequestErrorMessageDraft18,
  Draft18MessageCodec,
  // ... 20+ Draft18 types
} from '@web-moq/core';
```

### Issues

1. **API Clutter** - Consumers must know which draft they're using
2. **Interspersed Fields** - Mixing `// d14` and `// d18` comments in shared interfaces
3. **Cleanup Burden** - Dropping d14 requires hunting through shared types
4. **Type Safety Gap** - Can't enforce "field X required if d18"

---

## Design Principles

### 1. Request/Wire Separation

```
┌─────────────────────────────────────────────────────────┐
│                    PUBLIC API LAYER                      │
│  SubscribeRequest, PublishRequest, FetchRequest, etc.   │
│  (Version-agnostic, stable, what app code uses)         │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                   SESSION/CODEC LAYER                    │
│  Maps requests to version-specific wire format          │
│  Build-time selection via __MOQT_VERSION__              │
└─────────────────────────────────────────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
┌─────────────────────────┐ ┌─────────────────────────┐
│   INTERNAL: Wire V14    │ │   INTERNAL: Wire V18    │
│   (Not exported)        │ │   (Not exported)        │
│   Delete when retiring  │ │   Delete when retiring  │
└─────────────────────────┘ └─────────────────────────┘
```

### 2. Draft-16 Naming Convention

Draft-16 introduced cleaner naming that we adopt:

| Old (d14) | Unified (d16 style) |
|-----------|---------------------|
| SUBSCRIBE_ERROR | REQUEST_ERROR |
| SUBSCRIBE_UPDATE | REQUEST_UPDATE |
| PUBLISH_NAMESPACE_OK | REQUEST_OK |
| Various *_ERROR | REQUEST_ERROR |

### 3. Clean Deprecation Path

Dropping draft-14 becomes:
```bash
rm src/encoding/wire-v14.ts
rm src/encoding/wire-v14.test.ts
# Done. No hunting through shared interfaces.
```

---

## Public API Types

### Core Types

```typescript
/** Track namespace (path segments) */
type TrackNamespace = string[];

/** Location within a track */
interface Location {
  group: bigint;
  object: bigint;
}

/** Full track identifier */
interface FullTrackName {
  namespace: TrackNamespace;
  name: string;
}

/** Track/request properties (key-value pairs) */
type Properties = Map<number, Uint8Array>;
```

### Enums

```typescript
/** Subscription filter types */
enum SubscriptionFilter {
  LATEST_GROUP = 1,
  LATEST_OBJECT = 2,
  ABSOLUTE_START = 3,
  ABSOLUTE_RANGE = 4,
}

/** Group ordering preference */
enum GroupOrder {
  DEFAULT = 0,
  ASCENDING = 1,
  DESCENDING = 2,
}

/** Object delivery status */
enum ObjectStatus {
  NORMAL = 0,
  OBJECT_NOT_EXISTS = 1,
  GROUP_NOT_EXISTS = 2,
  END_OF_GROUP = 3,
  END_OF_TRACK = 4,
}

/** Connection role (d18+) */
enum Role {
  PUBLISHER = 1,
  SUBSCRIBER = 2,
  PUBSUB = 3,
}
```

---

## Request Types (Public API)

These are the types application code interacts with. They contain only semantically meaningful fields.

### Subscribe Flow

```typescript
/** Request to subscribe to a track */
interface SubscribeRequest {
  trackNamespace: TrackNamespace;
  trackName: string;
  filter: SubscriptionFilter;
  startLocation?: Location;
  endGroup?: bigint;
  subscriberPriority?: number;
  groupOrder?: GroupOrder;
  parameters?: Properties;
}

/** Successful subscription response */
interface SubscribeResponse {
  requestId: bigint;
  contentExists: boolean;
  largestLocation?: Location;
  groupOrder?: GroupOrder;
  expires?: bigint;
  trackProperties?: Properties;
}

/** Active subscription handle */
interface Subscription {
  readonly requestId: bigint;
  readonly track: FullTrackName;
  
  /** Update subscription parameters */
  update(options: SubscribeUpdateOptions): Promise<void>;
  
  /** End the subscription */
  unsubscribe(): Promise<void>;
  
  /** Stream of incoming objects */
  readonly objects: AsyncIterable<MOQTObject>;
}

interface SubscribeUpdateOptions {
  subscriberPriority?: number;
  startLocation?: Location;
  endGroup?: bigint;
}
```

### Publish Flow

```typescript
/** Request to publish to a track */
interface PublishRequest {
  trackNamespace: TrackNamespace;
  trackName: string;
  trackAlias?: bigint;
  subscriberPriority?: number;
  groupOrder?: GroupOrder;
  trackProperties?: Properties;
}

/** Successful publish response */
interface PublishResponse {
  requestId: bigint;
  expires?: bigint;
}

/** Active publication handle */
interface Publication {
  readonly requestId: bigint;
  readonly trackAlias: bigint;
  readonly track: FullTrackName;
  
  /** Send an object */
  sendObject(object: OutgoingObject): Promise<void>;
  
  /** Signal publish completion */
  done(reason?: string): Promise<void>;
}

interface OutgoingObject {
  groupId: bigint;
  subgroupId: bigint;
  objectId: bigint;
  priority?: number;
  status?: ObjectStatus;
  payload: Uint8Array;
}
```

### Fetch Flow

```typescript
/** Request to fetch historical objects */
interface FetchRequest {
  trackNamespace: TrackNamespace;
  trackName: string;
  subscriberPriority: number;
  groupOrder: GroupOrder;
  startLocation: Location;
  endLocation: Location;
  parameters?: Properties;
}

/** Successful fetch response */
interface FetchResponse {
  requestId: bigint;
  endOfTrack: boolean;
  endLocation: Location;
  trackProperties?: Properties;
}

/** Active fetch handle */
interface Fetch {
  readonly requestId: bigint;
  
  /** Cancel the fetch */
  cancel(): Promise<void>;
  
  /** Stream of fetched objects */
  readonly objects: AsyncIterable<MOQTObject>;
}
```

---

## Namespace Operations (Public API)

### Key Difference Between Draft Versions

**Draft-14/15/16:** Single `SUBSCRIBE_NAMESPACE` message with `subscribeOptions`:
- `NAMESPACE` = discover track names only
- `PUBLISH` = auto-subscribe to track data only  
- `BOTH` = discover names AND auto-subscribe to data

**Draft-17/18:** Split into two separate operations:
- `SUBSCRIBE_NAMESPACE` = discover track names only
- `SUBSCRIBE_TRACKS` = subscribe to track data (separate message)

The unified API abstracts this difference.

### Subscribe Namespace

Discover and optionally subscribe to tracks within a namespace prefix.

```typescript
/** What to receive from namespace subscription */
enum NamespaceSubscribeMode {
  /** Discover track/namespace names only (all drafts) */
  DISCOVER = 'discover',
  /** Auto-subscribe to track data only (d14/16: PUBLISH option) */
  SUBSCRIBE = 'subscribe',
  /** Both discover and subscribe (d14/16: BOTH option) */
  BOTH = 'both',
}

/** Request to subscribe to namespace announcements */
interface SubscribeNamespaceRequest {
  trackNamespacePrefix: TrackNamespace;
  
  /** 
   * What to receive (default: DISCOVER)
   * - d14/16: maps to SubscribeNamespaceOptions enum
   * - d18: DISCOVER uses SUBSCRIBE_NAMESPACE; SUBSCRIBE/BOTH also opens SUBSCRIBE_TRACKS
   */
  mode?: NamespaceSubscribeMode;
  
  /** Track name pattern filter (d18 SUBSCRIBE_TRACKS, ignored in DISCOVER mode) */
  trackNamePattern?: string;
  
  /** Subscription filter (for SUBSCRIBE/BOTH modes) */
  filter?: SubscriptionFilter;
  startLocation?: Location;
  endGroup?: bigint;
  
  parameters?: Properties;
}

/** Namespace subscription handle */
interface NamespaceSubscription {
  readonly requestId: bigint;
  readonly prefix: TrackNamespace;
  readonly mode: NamespaceSubscribeMode;
  
  /** Unsubscribe from namespace */
  unsubscribe(): Promise<void>;
  
  /** 
   * Stream of discovered namespaces/tracks 
   * (available in DISCOVER and BOTH modes)
   */
  readonly namespaces: AsyncIterable<AnnouncedNamespace>;
  
  /**
   * Stream of track data objects
   * (available in SUBSCRIBE and BOTH modes)
   */
  readonly objects?: AsyncIterable<TrackObject>;
}

/** An announced namespace/track within the subscription */
interface AnnouncedNamespace {
  namespace: TrackNamespace;
  trackName?: string;  // If announcing a specific track
  properties?: Properties;
}

/** Object received from auto-subscribed track */
interface TrackObject {
  track: FullTrackName;
  object: MOQTObject;
}

/** Namespace subscription ended */
interface NamespaceDone {
  finalNamespace: TrackNamespace;
  statusCode?: number;
  reason?: string;
}
```

### Usage Examples

```typescript
// Discovery only (works on all drafts)
const discovery = await session.subscribeNamespace({
  trackNamespacePrefix: ['conference', 'room-1'],
  mode: NamespaceSubscribeMode.DISCOVER,
});

for await (const ns of discovery.namespaces) {
  console.log('Found:', ns.namespace, ns.trackName);
}

// Discovery + auto-subscribe (d14/16: BOTH option; d18: opens both streams)
const fullSub = await session.subscribeNamespace({
  trackNamespacePrefix: ['conference', 'room-1'],
  mode: NamespaceSubscribeMode.BOTH,
  filter: SubscriptionFilter.LATEST_GROUP,
});

// Process discovered tracks
for await (const ns of fullSub.namespaces) {
  console.log('Track available:', ns.trackName);
}

// Process incoming objects (runs concurrently)
for await (const { track, object } of fullSub.objects!) {
  console.log('Data from', track.name, ':', object.payload);
}
```

### Publish Namespace

Announce availability of tracks within a namespace.

```typescript
/** Request to publish a namespace */
interface PublishNamespaceRequest {
  trackNamespacePrefix: TrackNamespace;
  parameters?: Properties;
}

/** Namespace publication handle */
interface NamespacePublication {
  readonly requestId: bigint;
  readonly prefix: TrackNamespace;
  
  /** Announce a namespace within the prefix */
  announce(namespace: TrackNamespace, properties?: Properties): Promise<void>;
  
  /** Signal namespace publication is done */
  done(finalNamespace: TrackNamespace): Promise<void>;
  
  /** Cancel namespace publication */
  cancel(): Promise<void>;
}
```

---

## Wire Format Mapping (Internal)

The session layer maps the unified API to draft-specific wire formats:

| Unified API | Draft-14/16 Wire | Draft-18 Wire |
|-------------|------------------|---------------|
| `subscribeNamespace({ mode: DISCOVER })` | `SUBSCRIBE_NAMESPACE` + `options: NAMESPACE` | `SUBSCRIBE_NAMESPACE` |
| `subscribeNamespace({ mode: SUBSCRIBE })` | `SUBSCRIBE_NAMESPACE` + `options: PUBLISH` | `SUBSCRIBE_TRACKS` |
| `subscribeNamespace({ mode: BOTH })` | `SUBSCRIBE_NAMESPACE` + `options: BOTH` | `SUBSCRIBE_NAMESPACE` + `SUBSCRIBE_TRACKS` |

---

## Generic Request Lifecycle

These types handle responses that apply across request types.

```typescript
/** Generic error response (replaces SubscribeError, PublishError, etc.) */
interface RequestError {
  requestId: bigint;
  errorCode: number;
  reasonPhrase: string;
}

/** Generic success acknowledgement */
interface RequestOk {
  requestId: bigint;
  expires?: bigint;
}

/** Request update (for active subscriptions/publications) */
interface RequestUpdate {
  requestId: bigint;
  // Fields depend on request type
}
```

---

## Session API

The main entry point for applications.

```typescript
interface Session {
  /** Session state */
  readonly state: SessionState;
  readonly version: Version;
  
  // ─────────────────────────────────────────────────────
  // Track Operations
  // ─────────────────────────────────────────────────────
  
  /** Subscribe to a track */
  subscribe(request: SubscribeRequest): Promise<Subscription>;
  
  /** Publish to a track */
  publish(request: PublishRequest): Promise<Publication>;
  
  /** Fetch historical objects */
  fetch(request: FetchRequest): Promise<Fetch>;
  
  // ─────────────────────────────────────────────────────
  // Namespace Operations
  // ─────────────────────────────────────────────────────
  
  /** Subscribe to namespace announcements */
  subscribeNamespace(request: SubscribeNamespaceRequest): Promise<NamespaceSubscription>;
  
  /** Publish namespace availability */
  publishNamespace(request: PublishNamespaceRequest): Promise<NamespacePublication>;
  
  // ─────────────────────────────────────────────────────
  // Multi-Track Operations (d18 only)
  // ─────────────────────────────────────────────────────
  
  /** Subscribe to multiple tracks (throws if not d18) */
  subscribeTracks(request: SubscribeTracksRequest): Promise<TracksSubscription>;
  
  // ─────────────────────────────────────────────────────
  // Session Lifecycle
  // ─────────────────────────────────────────────────────
  
  /** Graceful shutdown */
  goAway(newSessionUri?: string): Promise<void>;
  
  /** Close the session */
  close(): Promise<void>;
  
  // ─────────────────────────────────────────────────────
  // Events
  // ─────────────────────────────────────────────────────
  
  on(event: 'error', handler: (error: RequestError) => void): void;
  on(event: 'goaway', handler: (uri?: string) => void): void;
  on(event: 'close', handler: () => void): void;
}

type SessionState = 'connecting' | 'connected' | 'closing' | 'closed';
```

---

## Internal Wire Types (Not Exported)

These types are internal implementation details. Each version has its own complete set.

### Wire V14/V16 (internal)

```typescript
// src/internal/wire-v14.ts

interface SubscribeWireV14 {
  type: 0x03;  // Wire value
  subscribeId: number;
  trackAlias: number;
  trackNamespace: string[];
  trackName: string;
  subscriberPriority: number;
  groupOrder: number;
  filterType: number;
  startGroup?: number;
  startObject?: number;
  endGroup?: number;
  endObject?: number;
  parameters: Map<number, Uint8Array>;
}

interface SubscribeOkWireV14 {
  type: 0x04;
  subscribeId: number;
  expires: number;
  groupOrder: number;
  contentExists: boolean;
  largestGroupId?: number;
  largestObjectId?: number;
}

// ... complete set for v14
```

### Wire V18 (internal)

```typescript
// src/internal/wire-v18.ts

interface SubscribeWireV18 {
  type: 0x03;  // Same logical type, different wire encoding
  requestId: bigint;
  trackNamespace: string[];
  trackName: string;
  forwardState: boolean;
  filter: number;
  startLocation?: { group: bigint; object: bigint };
  endGroupDelta?: bigint;
  parameters: Map<number, Uint8Array>;  // Delta-encoded
}

interface SubscribeOkWireV18 {
  type: 0x04;
  requestId: bigint;
  largestLocation: { group: bigint; object: bigint };
  trackProperties: Map<number, Uint8Array>;  // Delta-encoded
}

interface SubscribeTracksWireV18 {
  type: 0x14;
  requestId: bigint;
  trackNamespacePrefix: string[];
  trackNamePattern?: string;
  forwardState: boolean;
  filter: number;
  startLocation?: { group: bigint; object: bigint };
  endGroupDelta?: bigint;
  parameters: Map<number, Uint8Array>;
}

// ... complete set for v18
```

---

## Codec Architecture

```typescript
/** Public codec interface */
interface IProtocolCodec {
  readonly version: Version;
  readonly capabilities: CodecCapabilities;
}

interface CodecCapabilities {
  /** Uses per-request bidirectional streams (d18) */
  perRequestStreams: boolean;
  
  /** Has SUBSCRIBE_TRACKS support (d18) */
  subscribeTracks: boolean;
  
  /** Uses MOQT varints vs QUIC varints (d18) */
  moqtVarInt: boolean;
  
  /** Has unified REQUEST_ERROR (d16+) */
  unifiedErrors: boolean;
}

/** Build-time selected codec */
export const Codec: IProtocolCodec = IS_DRAFT_18
  ? new CodecV18()
  : new CodecV14();
```

---

## Feature Detection

```typescript
import { 
  MOQT_VERSION,
  IS_DRAFT_18,
  IS_DRAFT_16,
  IS_DRAFT_14,
  Codec,
} from '@web-moq/core';

// Build-time constants (tree-shaken)
console.log(`Built for: ${MOQT_VERSION}`);

// Runtime capability checks
if (Codec.capabilities.subscribeTracks) {
  await session.subscribeTracks({ ... });
}

if (Codec.capabilities.perRequestStreams) {
  // d18: each request opens its own bidi stream
} else {
  // d14/16: all control messages on single control stream
}
```

---

## Migration Path

### Phase 1: Add Unified Types (Non-Breaking)

- Add `*Request`, `*Response` types alongside existing
- Add `Session` API methods
- Keep all `*Draft18` exports

### Phase 2: Internal Migration

- Refactor session to use unified types internally
- Move wire types to `src/internal/`
- Add deprecation warnings to old exports

### Phase 3: Documentation Update

- Update all examples to use unified API
- Document migration for consumers

### Phase 4: Major Version (Breaking)

- Remove `*Draft18` exports
- Remove deprecated exports
- Clean internal structure

---

## Comparison: Before and After

### Before (Current)

```typescript
import {
  IS_DRAFT_18,
  MessageTypeDraft18,
  SubscribeMessageDraft18,
  SubscribeOkMessageDraft18,
  RequestErrorMessageDraft18,
  Draft18MessageCodec,
  Draft18BufferWriter,
} from '@web-moq/core';

if (IS_DRAFT_18) {
  const msg: SubscribeMessageDraft18 = {
    type: MessageTypeDraft18.SUBSCRIBE,
    requestId: BigInt(1),
    trackNamespace: ['conference', 'room-1'],
    trackName: 'video',
    forwardState: true,
    filter: SubscriptionFilterDraft18.LATEST_GROUP,
  };
  const encoded = Draft18MessageCodec.encodeSubscribe(msg);
}
```

### After (Unified)

```typescript
import { Session, SubscriptionFilter } from '@web-moq/core';

const session = await Session.connect('https://relay.example.com/moq');

const subscription = await session.subscribe({
  trackNamespace: ['conference', 'room-1'],
  trackName: 'video',
  filter: SubscriptionFilter.LATEST_GROUP,
});

for await (const object of subscription.objects) {
  // Process objects
}
```

---

## Summary

| Aspect | Before | After |
|--------|--------|-------|
| Public types | 40+ with `*Draft18` | ~15 clean request/response types |
| Wire details | Exposed | Internal only |
| Dropping d14 | Hunt through shared types | Delete `wire-v14.ts` |
| Type safety | Optional fields everywhere | Complete types per version |
| Naming | `SubscribeMessageDraft18` | `SubscribeRequest` |
| Namespace ops | Scattered | Dedicated section |
| Multi-track | `SubscribeTracksMessageDraft18` | `session.subscribeTracks()` |

This design provides a stable, clean API that hides protocol complexity while maintaining full type safety and easy version management.
