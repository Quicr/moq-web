# Group-Aware Deadline-Based Jitter Buffer Design

## Problem Statement

In MOQT, multiple QUIC streams can deliver groups for the same track concurrently. Due to QUIC's parallel stream delivery, a newer group (N+1) can start arriving before an older group (N) completes. The system must:

1. Ensure correct decode order (older groups before newer)
2. Minimize latency (don't wait indefinitely for delayed groups)
3. Support partial group decode (keyframe + some P-frames is valid)
4. Handle dynamic GOP sizes (NewGroupRequest triggers new keyframes)
5. Handle gaps in groupId sequence
6. Maintain high performance (minimize per-frame overhead)

## Design Principles

1. **Use existing LOC properties** - No new extensions needed
2. **Leverage MOQT groupId/objectId** - Already provides ordering
3. **Catalog-informed, runtime-adaptive** - Use catalog hints, detect actual behavior
4. **Graceful degradation** - Work without timing info, improve with it
5. **Performance-first** - Use monotonic counters, avoid syscalls in hot path

---

## LOC Properties Available (draft-ietf-moq-loc-02)

| Property | ID | Type | Purpose |
|----------|-----|------|---------|
| Timestamp | 0x06 | vi64 | Frame capture time |
| Timescale | 0x08 | vi64 | Units per second (default: 1,000,000 = microseconds) |
| Video Frame Marking | 0x04 | vi64 | Independent/discardable/base-layer flags |
| Audio Level | 0x06 | vi64 | Audio level + VAD |

**Key insight**: With `Timestamp` and `Timescale`, we can compute:
- Presentation time: `timestamp / timescale` (seconds)
- Frame interval: `(timestamp[n+1] - timestamp[n]) / timescale`
- GOP duration: Detected from keyframe-to-keyframe interval

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────────┐
│                    GroupAwareJitterBuffer                          │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    TimingEstimator                           │   │
│  │  - Tracks GOP duration from keyframe intervals               │   │
│  │  - Uses catalog hints as initial estimate                    │   │
│  │  - Adapts to actual observed intervals                       │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│                              ▼                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ Group N  │  │ Group N+1│  │ Group N+3│  │ Group N+4│  (sparse) │
│  │ state:   │  │ state:   │  │ state:   │  │ state:   │           │
│  │ active   │  │ pending  │  │ pending  │  │ pending  │           │
│  │ deadline:│  │ deadline:│  │ deadline:│  │ deadline:│           │
│  │ T+100    │  │ T+200    │  │ T+400    │  │ T+500    │           │
│  │ frames:  │  │ frames:  │  │ frames:  │  │ frames:  │           │
│  │ [0,1,2]  │  │ [0,1]    │  │ [0]      │  │ []       │           │
│  └────┬─────┘  └──────────┘  └──────────┘  └──────────┘           │
│       │                                                             │
│       ▼                                                             │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                     OutputScheduler                          │   │
│  │  - Outputs frames from active group in objectId order        │   │
│  │  - Checks deadlines using monotonic tick counter             │   │
│  │  - Promotes next group when active completes/expires         │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│                              ▼                                      │
│                        To Decoder                                   │
└────────────────────────────────────────────────────────────────────┘
```

---

## Core Data Structures

### 1. GroupState

```typescript
interface GroupState<T> {
  groupId: number;

  // Frame storage - sparse array indexed by objectId
  frames: Map<number, FrameEntry<T>>;

  // Timing
  firstFrameReceivedTick: number;   // Monotonic tick when first frame arrived
  locTimestampBase: number;         // LOC timestamp of first frame (if available)
  locTimescale: number;             // LOC timescale (default: 1_000_000)
  deadlineTick: number;             // Tick by which group must complete

  // State tracking
  hasKeyframe: boolean;             // Received objectId=0?
  highestObjectId: number;          // Highest objectId seen
  outputObjectId: number;           // Next objectId to output (-1 = not started)
  frameCount: number;               // Total frames received

  // Status
  status: 'receiving' | 'active' | 'complete' | 'expired' | 'skipped';
}

interface FrameEntry<T> {
  data: T;
  objectId: number;
  receivedTick: number;             // Monotonic tick
  locTimestamp?: number;            // LOC timestamp (optional)
  isKeyframe: boolean;
  isDiscardable: boolean;           // From LOC Video Frame Marking
}
```

### 2. TimingConfig

```typescript
interface TimingConfig {
  // From catalog (initial estimates)
  catalogFramerate?: number;        // e.g., 30
  catalogTimescale?: number;        // e.g., 90000

  // Derived/configured
  estimatedGopDuration: number;     // ms, initial estimate
  maxLatency: number;               // ms, maximum acceptable e2e delay
  jitterDelay: number;              // ms, per-frame buffer delay
  deadlineExtension: number;        // ms, extension when no keyframe available

  // Limits
  maxActiveGroups: number;          // Max groups to track (default: 4)
  maxFramesPerGroup: number;        // Max frames per group (default: 120)

  // Behavior flags
  allowPartialGroupDecode: boolean; // Output partial groups (default: true)
  skipOnlyToKeyframe: boolean;      // Only skip to groups with keyframe (default: true)
}
```

### 3. TickProvider (Performance Optimization)

```typescript
/**
 * Monotonic tick provider to avoid performance.now() in hot path.
 *
 * performance.now() involves:
 * - Potential syscall overhead
 * - Floating-point operations
 * - Security mitigations (reduced precision)
 *
 * Instead, use a tick counter incremented by the processing loop.
 * Periodically sync with wall clock for deadline calculations.
 */
interface TickProvider {
  currentTick: number;              // Monotonic counter
  ticksPerMs: number;               // Calibrated ticks per millisecond
  lastSyncTime: number;             // Last wall-clock sync
  lastSyncTick: number;             // Tick at last sync

  /** Increment tick (call once per processing cycle) */
  tick(): void;

  /** Convert ticks to milliseconds (approximate) */
  ticksToMs(ticks: number): number;

  /** Convert milliseconds to ticks */
  msToTicks(ms: number): number;

  /** Sync with wall clock (call periodically, e.g., every 100 frames) */
  sync(): void;
}

// Implementation
class MonotonicTickProvider implements TickProvider {
  currentTick = 0;
  ticksPerMs = 1;                   // 1 tick = 1ms initially
  lastSyncTime = performance.now();
  lastSyncTick = 0;

  tick(): void {
    this.currentTick++;
  }

  ticksToMs(ticks: number): number {
    return ticks / this.ticksPerMs;
  }

  msToTicks(ms: number): number {
    return Math.round(ms * this.ticksPerMs);
  }

  sync(): void {
    const now = performance.now();
    const elapsed = now - this.lastSyncTime;
    const ticksElapsed = this.currentTick - this.lastSyncTick;

    if (elapsed > 100 && ticksElapsed > 0) {
      // Recalibrate
      this.ticksPerMs = ticksElapsed / elapsed;
      this.lastSyncTime = now;
      this.lastSyncTick = this.currentTick;
    }
  }
}
```

---

## GOP Duration Estimation

### Three Sources (Priority Order)

1. **LOC Timestamps** (most accurate)
   - Detect keyframe-to-keyframe interval from actual timestamps
   - Adapts to dynamic GOP sizes automatically

2. **Catalog Hints** (initial estimate)
   - `framerate` + assumed GOP length (e.g., 1 second)
   - Used until runtime detection kicks in

3. **Configuration** (fallback)
   - Default: 1000ms GOP, configurable per use case

### TimingEstimator

```typescript
class TimingEstimator {
  private config: TimingConfig;
  private lastKeyframeTimestamp: number = -1;
  private lastKeyframeGroupId: number = -1;
  private gopDurationSamples: number[] = [];
  private estimatedGopDuration: number;

  constructor(config: TimingConfig) {
    this.config = config;
    // Initialize from catalog or default
    this.estimatedGopDuration = this.calculateInitialEstimate();
  }

  private calculateInitialEstimate(): number {
    if (this.config.catalogFramerate) {
      // Assume 1-second GOP as starting point
      return 1000;
    }
    return this.config.estimatedGopDuration;
  }

  /**
   * Update estimate when keyframe received
   */
  onKeyframe(groupId: number, locTimestamp?: number, locTimescale?: number): void {
    if (locTimestamp !== undefined && this.lastKeyframeTimestamp >= 0) {
      const scale = locTimescale ?? 1_000_000;
      const durationMs = ((locTimestamp - this.lastKeyframeTimestamp) / scale) * 1000;

      // Sanity check: 100ms < duration < 10s
      if (durationMs > 100 && durationMs < 10000) {
        this.gopDurationSamples.push(durationMs);

        // Keep last 5 samples for averaging
        if (this.gopDurationSamples.length > 5) {
          this.gopDurationSamples.shift();
        }

        // Update estimate (exponential moving average)
        const avg = this.gopDurationSamples.reduce((a, b) => a + b, 0) /
                    this.gopDurationSamples.length;
        this.estimatedGopDuration = 0.7 * this.estimatedGopDuration + 0.3 * avg;
      }
    }

    this.lastKeyframeTimestamp = locTimestamp ?? -1;
    this.lastKeyframeGroupId = groupId;
  }

  /**
   * Calculate deadline for a group
   */
  calculateDeadline(
    group: GroupState<unknown>,
    tickProvider: TickProvider
  ): number {
    const gopMs = this.estimatedGopDuration;
    const maxLatencyMs = this.config.maxLatency;

    // Deadline = arrival + GOP duration + max latency
    const deadlineMs = tickProvider.ticksToMs(group.firstFrameReceivedTick) +
                       gopMs + maxLatencyMs;

    return tickProvider.msToTicks(deadlineMs);
  }

  getEstimatedGopDuration(): number {
    return this.estimatedGopDuration;
  }
}
```

---

## Group Arbiter Algorithm

### Core Logic

```typescript
class GroupArbiter<T> {
  private groups: Map<number, GroupState<T>> = new Map();
  private activeGroupId: number = -1;
  private tickProvider: TickProvider;
  private timingEstimator: TimingEstimator;
  private config: TimingConfig;
  private stats: ArbiterStats;

  /**
   * Add a frame - called for each received frame
   */
  addFrame(
    groupId: number,
    objectId: number,
    data: T,
    isKeyframe: boolean,
    locTimestamp?: number,
    locTimescale?: number,
    isDiscardable?: boolean
  ): void {
    // Tick once per frame (amortized timing)
    this.tickProvider.tick();

    // Get or create group
    let group = this.groups.get(groupId);

    if (!group) {
      // Check if this is an old group we already passed
      if (this.activeGroupId >= 0 && groupId < this.activeGroupId) {
        this.stats.droppedLateFrames++;
        return; // Drop frame from old group
      }

      group = this.createGroup(groupId);
      this.groups.set(groupId, group);
      this.pruneOldGroups();
    }

    // Don't accept frames for terminal groups
    if (group.status === 'expired' || group.status === 'skipped' ||
        group.status === 'complete') {
      this.stats.droppedLateFrames++;
      return;
    }

    // Store frame
    group.frames.set(objectId, {
      data,
      objectId,
      receivedTick: this.tickProvider.currentTick,
      locTimestamp,
      isKeyframe,
      isDiscardable: isDiscardable ?? false,
    });

    group.frameCount++;
    group.highestObjectId = Math.max(group.highestObjectId, objectId);

    if (isKeyframe) {
      group.hasKeyframe = true;
      this.timingEstimator.onKeyframe(groupId, locTimestamp, locTimescale);
    }

    // Update LOC timing if available
    if (locTimestamp !== undefined && group.locTimestampBase < 0) {
      group.locTimestampBase = locTimestamp;
      group.locTimescale = locTimescale ?? 1_000_000;
    }

    // Activate first group if none active
    if (this.activeGroupId < 0) {
      this.activeGroupId = groupId;
      group.status = 'active';
    }
  }

  /**
   * Get frames ready for output
   */
  getReadyFrames(): FrameEntry<T>[] {
    const result: FrameEntry<T>[] = [];

    // Periodic sync (every ~100 ticks)
    if (this.tickProvider.currentTick % 100 === 0) {
      this.tickProvider.sync();
    }

    // Update group states (check deadlines)
    this.updateGroupStates();

    // Get active group
    const activeGroup = this.groups.get(this.activeGroupId);
    if (!activeGroup || activeGroup.status !== 'active') {
      // Try to find next active group
      this.promoteNextGroup();
      return result;
    }

    // Output frames in objectId order
    const startObjectId = activeGroup.outputObjectId < 0 ? 0 : activeGroup.outputObjectId;

    for (let objId = startObjectId; objId <= activeGroup.highestObjectId; objId++) {
      const frame = activeGroup.frames.get(objId);

      if (!frame) {
        // Gap in sequence
        if (this.shouldWaitForMissingFrame(activeGroup, objId)) {
          break; // Wait for missing frame
        }
        // Skip missing frame (deadline pressure)
        this.stats.skippedMissingFrames++;
        continue;
      }

      // Check jitter delay
      const jitterTicks = this.tickProvider.msToTicks(this.config.jitterDelay);
      if (frame.receivedTick + jitterTicks > this.tickProvider.currentTick) {
        break; // Not ready yet
      }

      result.push(frame);
      activeGroup.frames.delete(objId);
      activeGroup.outputObjectId = objId + 1;
    }

    // Check if group is complete (all frames output)
    if (activeGroup.frames.size === 0 && activeGroup.outputObjectId > 0) {
      activeGroup.status = 'complete';
      this.stats.groupsCompleted++;
      this.promoteNextGroup();
    }

    return result;
  }

  /**
   * Update group states based on deadlines
   */
  private updateGroupStates(): void {
    const now = this.tickProvider.currentTick;

    for (const [groupId, group] of this.groups) {
      if (group.status !== 'receiving' && group.status !== 'active') {
        continue;
      }

      // Check deadline
      if (now > group.deadlineTick) {
        if (groupId === this.activeGroupId) {
          // Active group expired - decide what to do
          this.handleExpiredActiveGroup(group);
        } else if (groupId < this.activeGroupId) {
          // Old group we already passed
          group.status = 'expired';
          this.stats.groupsExpired++;
        }
        // Future groups: let them continue receiving
      }
    }
  }

  /**
   * Handle expired active group
   */
  private handleExpiredActiveGroup(group: GroupState<T>): void {
    // Option 1: If we have partial content and allowPartialGroupDecode, keep outputting
    if (this.config.allowPartialGroupDecode &&
        group.hasKeyframe &&
        group.outputObjectId >= 0) {
      // Extend deadline slightly to finish partial output
      group.deadlineTick = this.tickProvider.currentTick +
                           this.tickProvider.msToTicks(this.config.deadlineExtension);
      this.stats.deadlinesExtended++;
      return;
    }

    // Option 2: Find next group with keyframe to skip to
    if (this.config.skipOnlyToKeyframe) {
      const nextKeyframeGroup = this.findNextKeyframeGroup(group.groupId);
      if (nextKeyframeGroup) {
        group.status = 'skipped';
        this.activeGroupId = nextKeyframeGroup.groupId;
        nextKeyframeGroup.status = 'active';
        this.stats.groupsSkipped++;
        return;
      }
    }

    // Option 3: No keyframe available - extend deadline
    group.deadlineTick = this.tickProvider.currentTick +
                         this.tickProvider.msToTicks(this.config.deadlineExtension);
    this.stats.deadlinesExtended++;
  }

  /**
   * Find next group (by groupId) that has a keyframe
   * Handles gaps in groupId sequence
   */
  private findNextKeyframeGroup(afterGroupId: number): GroupState<T> | null {
    let candidate: GroupState<T> | null = null;
    let candidateGroupId = Infinity;

    for (const [groupId, group] of this.groups) {
      if (groupId > afterGroupId &&
          groupId < candidateGroupId &&
          group.hasKeyframe &&
          group.status === 'receiving') {
        candidate = group;
        candidateGroupId = groupId;
      }
    }

    return candidate;
  }

  /**
   * Decide whether to wait for a missing frame
   */
  private shouldWaitForMissingFrame(group: GroupState<T>, objectId: number): boolean {
    const now = this.tickProvider.currentTick;
    const timeUntilDeadline = group.deadlineTick - now;

    // If plenty of time, wait
    if (timeUntilDeadline > this.tickProvider.msToTicks(this.config.jitterDelay * 2)) {
      return true;
    }

    // If it's objectId 0 (keyframe), must wait (can't decode without it)
    if (objectId === 0) {
      return true;
    }

    // Otherwise, skip if under deadline pressure
    return false;
  }

  /**
   * Create a new group
   */
  private createGroup(groupId: number): GroupState<T> {
    const tick = this.tickProvider.currentTick;

    const group: GroupState<T> = {
      groupId,
      frames: new Map(),
      firstFrameReceivedTick: tick,
      locTimestampBase: -1,
      locTimescale: 1_000_000,
      deadlineTick: 0, // Set below
      hasKeyframe: false,
      highestObjectId: -1,
      outputObjectId: -1,
      frameCount: 0,
      status: 'receiving',
    };

    // Calculate deadline
    group.deadlineTick = this.timingEstimator.calculateDeadline(group, this.tickProvider);

    return group;
  }

  /**
   * Promote next group to active
   */
  private promoteNextGroup(): void {
    // Find lowest groupId > activeGroupId with status 'receiving'
    let nextGroup: GroupState<T> | null = null;
    let nextGroupId = Infinity;

    for (const [groupId, group] of this.groups) {
      if (groupId > this.activeGroupId &&
          groupId < nextGroupId &&
          (group.status === 'receiving' || group.status === 'active')) {
        nextGroup = group;
        nextGroupId = groupId;
      }
    }

    if (nextGroup) {
      this.activeGroupId = nextGroupId;
      nextGroup.status = 'active';
    }
  }

  /**
   * Prune old groups to limit memory
   */
  private pruneOldGroups(): void {
    if (this.groups.size <= this.config.maxActiveGroups) {
      return;
    }

    // Remove oldest groups that are complete/expired/skipped
    const sortedGroups = [...this.groups.entries()].sort(([a], [b]) => a - b);

    for (const [groupId, group] of sortedGroups) {
      if (this.groups.size <= this.config.maxActiveGroups) break;

      if (group.status === 'complete' ||
          group.status === 'expired' ||
          group.status === 'skipped') {
        this.groups.delete(groupId);
      }
    }
  }
}
```

---

## Statistics

```typescript
interface ArbiterStats {
  // Group-level
  groupsReceived: number;
  groupsCompleted: number;
  groupsExpired: number;
  groupsSkipped: number;
  deadlinesExtended: number;

  // Frame-level
  framesReceived: number;
  framesOutput: number;
  droppedLateFrames: number;
  skippedMissingFrames: number;

  // Timing
  avgGopDuration: number;
  avgOutputLatency: number;
}
```

---

## Integration with Existing Code

### Changes to codec-decode-worker.ts

```typescript
// Replace per-channel sequence counters with GroupArbiter
interface DecodeChannel {
  // ... existing fields ...

  // Remove: videoSequence, audioSequence
  // Add:
  videoArbiter?: GroupArbiter<VideoBufferData>;
  audioArbiter?: GroupArbiter<AudioBufferData>;
}

// In processMediaFrame:
function processMediaFrame(channelId: number, frame: ReceivedFrame): void {
  const channel = channels.get(channelId);
  if (!channel) return;

  const locFrame = unpackager.unpackage(frame.payload);

  if (locFrame.header.mediaType === MediaType.VIDEO && channel.videoArbiter) {
    channel.videoArbiter.addFrame(
      frame.groupId,
      frame.objectId,
      {
        data: locFrame.payload,
        isKeyframe: locFrame.header.isKeyframe,
        codecDescription: locFrame.codecDescription,
        arrivedAt: performance.now(),
      },
      locFrame.header.isKeyframe,
      locFrame.captureTimestamp,
      undefined, // timescale from catalog
      locFrame.frameMarking?.discardable
    );
  }
  // Similar for audio
}
```

### Changes to JitterBuffer

The existing `JitterBuffer` can be kept for simple use cases. `GroupArbiter` is a higher-level component that replaces `JitterBuffer` when group-aware ordering is needed.

---

## Phased Implementation Plan

### Phase 1: Foundation (Week 1)

**Goal**: Core data structures and tick provider without changing existing behavior.

1. **Create `TickProvider` class**
   - `packages/media/src/pipeline/tick-provider.ts`
   - Unit tests for calibration accuracy

2. **Create `GroupState` and `ArbiterStats` types**
   - `packages/media/src/pipeline/group-arbiter-types.ts`

3. **Create `TimingEstimator` class**
   - `packages/media/src/pipeline/timing-estimator.ts`
   - Unit tests for GOP detection

**Deliverable**: New files with tests, no integration yet.

---

### Phase 2: GroupArbiter Core (Week 2)

**Goal**: Working GroupArbiter with basic group ordering.

1. **Implement `GroupArbiter` class**
   - `packages/media/src/pipeline/group-arbiter.ts`
   - `addFrame()` - basic frame storage
   - `getReadyFrames()` - simple FIFO per group
   - Group creation and pruning

2. **Unit tests**
   - Single group ordering
   - Multiple concurrent groups
   - Group gaps handling

**Deliverable**: GroupArbiter that orders by (groupId, objectId).

---

### Phase 3: Deadline Logic (Week 3)

**Goal**: Add deadline-based skip/expire logic.

1. **Integrate TimingEstimator into GroupArbiter**
   - Deadline calculation
   - GOP duration detection from LOC timestamps

2. **Implement deadline handling**
   - `updateGroupStates()` with deadline checks
   - `handleExpiredActiveGroup()` with skip-to-keyframe
   - `findNextKeyframeGroup()` with gap handling

3. **Unit tests**
   - Expired group handling
   - Skip to keyframe scenarios
   - Deadline extension

**Deliverable**: Full deadline-based logic.

---

### Phase 4: Worker Integration (Week 4)

**Goal**: Replace JitterBuffer with GroupArbiter in codec-decode-worker.

1. **Add config support**
   - Pass timing config from catalog
   - Add `useGroupArbiter` flag for gradual rollout

2. **Integrate in codec-decode-worker.ts**
   - Create GroupArbiter per channel
   - Wire up frame processing
   - Wire up output loop

3. **Integration tests**
   - End-to-end with simulated out-of-order groups
   - Performance benchmarks

**Deliverable**: Working integration behind feature flag.

---

### Phase 5: LOC Enhancement (Week 5)

**Goal**: Use LOC timescale from catalog, add diagnostics.

1. **Pass timescale from catalog**
   - Thread through from MSF catalog to decode worker

2. **Add LOC Timescale tracking**
   - Store per-track timescale
   - Convert timestamps correctly

3. **Add observability**
   - Stats reporting
   - Debug logging
   - Latency metrics

**Deliverable**: Full LOC timestamp support.

---

### Phase 6: Polish & Optimization (Week 6)

**Goal**: Performance tuning and edge cases.

1. **Performance optimization**
   - Profile hot paths
   - Reduce allocations in `addFrame()`
   - Optimize Map operations

2. **Edge cases**
   - Very long GOP (10+ seconds)
   - Very short GOP (< 100ms)
   - Rapid group ID jumps
   - NewGroupRequest mid-stream

3. **Documentation**
   - Update README
   - Add architecture docs
   - Add configuration guide

**Deliverable**: Production-ready feature.

---

## Performance Considerations

### Hot Path Analysis

| Operation | Frequency | Current | Proposed |
|-----------|-----------|---------|----------|
| Add frame | Per frame (~30-60/sec) | `performance.now()` | Tick increment (++counter) |
| Get ready frames | Per poll (~60/sec) | Multiple `performance.now()` | Tick comparison |
| Deadline check | Per poll | N/A | Integer comparison |
| Wall-clock sync | Every ~100 frames | N/A | Single `performance.now()` |

### Memory

- Per group: ~200 bytes overhead + frame storage
- Max groups: 4 default = ~800 bytes overhead
- Frames use existing buffers (no copy)

### CPU

- Tick increment: ~1 CPU cycle
- Map lookup: O(1)
- Group iteration: O(n) where n <= 4

---

## Configuration Defaults

```typescript
const DEFAULT_CONFIG: TimingConfig = {
  // Timing
  estimatedGopDuration: 1000,       // 1 second
  maxLatency: 500,                  // 500ms max e2e
  jitterDelay: 50,                  // 50ms per-frame buffer
  deadlineExtension: 200,           // 200ms extension

  // Limits
  maxActiveGroups: 4,
  maxFramesPerGroup: 120,           // 4 seconds at 30fps

  // Behavior
  allowPartialGroupDecode: true,
  skipOnlyToKeyframe: true,
};
```

---

## Open Questions / Future Work

1. **Audio-video sync**: Should audio follow video group decisions?
   - Recommendation: Keep audio independent, sync at renderer level

2. **SVC layers**: How to handle temporal/spatial layers?
   - Use LOC Video Frame Marking for layer info
   - Potentially drop higher layers under pressure

3. **ABR integration**: How does this interact with quality switching?
   - Group boundaries align with quality switch points
   - NewGroupRequest triggers new keyframe at new quality

4. **Metrics export**: What metrics to expose?
   - GOP duration histogram
   - Skip/expire rates
   - Output latency percentiles
