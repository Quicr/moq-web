# GroupArbiter: Deadline-Based Multi-Group Ordering

## Overview

When receiving media over MOQT, multiple QUIC streams can deliver groups concurrently. Due to QUIC's parallel stream delivery, a newer group (N+1) can start arriving before an older group (N) completes. This causes decode errors when P-frames arrive before their keyframe.

**The Problem:**
```
Timeline:
T=0ms:   Group 1471666579, Object 0 (keyframe) arrives
T=5ms:   Group 1471666578, Object 56 arrives (old group, interleaved)
T=10ms:  Group 1471666578, Object 57 arrives
...
T=74ms:  Group 1471666579, Object 1 (P-frame) arrives

Without GroupArbiter: P-frame decoded before keyframe = decode error
With GroupArbiter: Frames buffered and output in correct (groupId, objectId) order
```

**GroupArbiter** solves this by:
1. Buffering frames from multiple concurrent groups
2. Outputting frames in strict (groupId, objectId) order
3. Using deadlines to skip stale groups when latency becomes too high
4. Ensuring keyframes always precede their P-frames

## Quick Start

### Enable via MediaConfig

```typescript
import { MediaSession } from '@web-moq/media';

const session = new MediaSession(transport);
await session.setup();

// Subscribe with GroupArbiter enabled
const subscriptionId = await session.subscribe(
  ['conference', 'room1'],
  'video',
  {
    videoBitrate: 2_000_000,
    videoResolution: '720p',
    // GroupArbiter settings
    useGroupArbiter: true,
    maxLatency: 500,        // Skip to keyframe if group exceeds 500ms
    estimatedGopDuration: 1000,  // Initial GOP estimate (auto-adapts)
  }
);
```

### Direct Usage (Advanced)

```typescript
import { GroupArbiter, MonotonicTickProvider } from '@web-moq/media';

const ticker = new MonotonicTickProvider();
const arbiter = new GroupArbiter<Uint8Array>({
  maxLatency: 500,
  jitterDelay: 50,
  estimatedGopDuration: 1000,
  allowPartialGroupDecode: true,
  skipOnlyToKeyframe: true,
}, ticker);

// Add frames as they arrive
arbiter.addFrame({
  groupId: 100,
  objectId: 0,
  data: keyframeData,
  isKeyframe: true,
  locTimestamp: captureTimestamp,  // Optional, improves GOP estimation
});

// Poll for ready frames (call in render loop)
const frames = arbiter.getReadyFrames(5);
for (const frame of frames) {
  decoder.decode(frame.data);
}
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `useGroupArbiter` | boolean | false | Enable GroupArbiter (vs legacy JitterBuffer) |
| `maxLatency` | number | 500 | Max acceptable latency (ms) before skipping to next keyframe |
| `estimatedGopDuration` | number | 1000 | Initial GOP duration estimate (ms), auto-adapts at runtime |
| `jitterDelay` | number | 50 | Per-frame jitter buffer delay (ms) |
| `catalogFramerate` | number | - | Framerate hint from catalog (improves estimation) |
| `catalogTimescale` | number | - | Timescale hint (e.g., 90000 for RTP video) |

### Advanced Options (TimingConfig)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `deadlineExtension` | number | 200 | Extra time (ms) when extending deadline for partial decode |
| `maxActiveGroups` | number | 4 | Max concurrent groups to track |
| `maxFramesPerGroup` | number | 120 | Max frames per group (prevents memory bloat) |
| `allowPartialGroupDecode` | boolean | true | Output partial groups (keyframe + available P-frames) |
| `skipOnlyToKeyframe` | boolean | true | Only skip to groups that have a keyframe |

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                         GroupArbiter                                │
├────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    TimingEstimator                           │   │
│  │  - Tracks GOP duration from keyframe intervals               │   │
│  │  - Uses catalog hints as initial estimate                    │   │
│  │  - Adapts via EMA smoothing                                  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ Group N  │  │ Group N+1│  │ Group N+3│  │ Group N+4│  (sparse) │
│  │ status:  │  │ status:  │  │ status:  │  │ status:  │           │
│  │ active   │  │ pending  │  │ pending  │  │ pending  │           │
│  │ deadline:│  │ deadline:│  │ deadline:│  │ deadline:│           │
│  │ T+500    │  │ T+600    │  │ T+800    │  │ T+900    │           │
│  └────┬─────┘  └──────────┘  └──────────┘  └──────────┘           │
│       │                                                             │
│       ▼                                                             │
│  Output in (groupId, objectId) order → Decoder                     │
└────────────────────────────────────────────────────────────────────┘
```

### Group States

| State | Description |
|-------|-------------|
| `receiving` | Actively receiving frames |
| `active` | Currently being output (lowest incomplete groupId) |
| `complete` | All frames output successfully |
| `expired` | Deadline passed, frames dropped |
| `skipped` | Skipped to reach a newer keyframe group |

### MonotonicTickProvider

To avoid `performance.now()` overhead in the hot path, GroupArbiter uses a monotonic tick counter:

```typescript
// Tick increment: ~1 CPU cycle (vs ~50+ cycles for performance.now())
ticker.tick();  // Called once per frame

// Periodic wall-clock sync (every ~100 frames)
ticker.sync();  // Recalibrates ticks-to-ms conversion
```

Benchmarks show 7-10x speedup vs wall-clock timing.

## Deadline Logic

When a group's deadline expires:

1. **Partial decode available?** If group has keyframe and some frames output, extend deadline slightly to finish
2. **Next keyframe group available?** Skip to the next group that has a keyframe
3. **No keyframe available?** Extend deadline and wait

This ensures:
- Smooth playback when network is stable
- Quick recovery (skip to keyframe) when latency spikes
- No decode errors from missing keyframes

## Statistics

```typescript
const stats = arbiter.getStats();
console.log({
  groupsReceived: stats.groupsReceived,
  groupsCompleted: stats.groupsCompleted,
  groupsSkipped: stats.groupsSkipped,      // Groups skipped due to deadline
  groupsExpired: stats.groupsExpired,
  framesOutput: stats.framesOutput,
  droppedLateFrames: stats.droppedLateFrames,
  avgOutputLatency: stats.avgOutputLatency,  // ms
  estimatedGopDuration: stats.estimatedGopDuration,  // ms
});
```

## Integration Points

### Worker Mode (Recommended)

GroupArbiter runs inside the decode worker for best performance:

```typescript
// MediaSession automatically uses GroupArbiter in worker when enabled
const session = new MediaSession({
  workers: {
    decodeWorker: new Worker(
      new URL('@web-moq/media/codec-decode-worker', import.meta.url),
      { type: 'module' }
    ),
  },
});

await session.subscribe(namespace, trackName, {
  useGroupArbiter: true,
  // ... other config
});
```

### Main Thread Mode

For debugging or when workers aren't available:

```typescript
const session = new MediaSession(transport);  // No workers

await session.subscribe(namespace, trackName, {
  useGroupArbiter: true,
  // GroupArbiter runs on main thread in SubscribePipeline
});
```

## Detailed Examples with ASCII Art

This section explains how jitter buffering and GroupArbiter work together with concrete examples.

### Settings Reference for Examples

```
Jitter Buffer Delay: 100ms  (per-frame hold time)
Max Latency: 500ms          (group deadline from capture time)
GOP Duration: 1000ms        (1 second between keyframes)
Skip to Latest: OFF         (unless noted)
```

---

### Example 1: Normal Flow (Frames Arrive In Order)

**Scenario:** Network is stable, frames arrive in order with slight jitter.

```
CAPTURE TIMELINE (Publisher)
════════════════════════════════════════════════════════════════════════════
GOP 1 (Group 100)                    GOP 2 (Group 101)
├─K─┬─P─┬─P─┬─P─┤                    ├─K─┬─P─┬─P─┬─P─┤
0  33  66  99 132                  1000 1033 1066 1099
                   (capture time in ms)

NETWORK ARRIVAL (Subscriber) - ~50ms network delay + jitter
════════════════════════════════════════════════════════════════════════════
Time    Frame Arrives        Action
────────────────────────────────────────────────────────────────────────────
 50ms   G100/O0 (K)         → Add to arbiter, hold for jitter delay
 85ms   G100/O1 (P)         → Add to arbiter, hold for jitter delay
118ms   G100/O2 (P)         → Add to arbiter, hold for jitter delay
155ms   G100/O3 (P)         → Add to arbiter, hold for jitter delay

JITTER BUFFER (inside GroupArbiter)
════════════════════════════════════════════════════════════════════════════
           ┌─────────────────────────────────────────────────┐
           │  Jitter Buffer Window (100ms hold time)          │
           └─────────────────────────────────────────────────┘

Time: 50ms   [K₀-------waiting 100ms-------]
Time: 85ms   [K₀----][P₁-------waiting-------]
Time: 118ms  [K₀][P₁----][P₂-------waiting---]
Time: 150ms  → K₀ released (held 100ms) → DECODE
Time: 155ms  [P₁--][P₂---][P₃-------waiting--]
Time: 185ms  → P₁ released → DECODE
Time: 218ms  → P₂ released → DECODE
Time: 255ms  → P₃ released → DECODE

RENDER BUFFER (what user sees)
════════════════════════════════════════════════════════════════════════════
Time: 150ms   [K₀]                    ← First frame displayed
Time: 185ms   [K₀][P₁]                ← Smooth playback
Time: 218ms   [K₀][P₁][P₂]            ← Continuous
Time: 255ms   [K₀][P₁][P₂][P₃]        ← GOP 1 complete

Result: ✅ SMOOTH - Frames displayed at ~33ms intervals (30fps)
End-to-end latency: ~150ms (50ms network + 100ms jitter buffer)
```

---

### Example 2: Frames Delayed/Reordered (Jitter Buffer Saves the Day)

**Scenario:** Frame P₁ arrives late due to network jitter.

```
NETWORK ARRIVAL - P₁ delayed by 80ms
════════════════════════════════════════════════════════════════════════════
Time    Frame Arrives
────────────────────────────
 50ms   G100/O0 (K)
165ms   G100/O2 (P) ← P₂ arrives BEFORE P₁!
170ms   G100/O1 (P) ← P₁ finally arrives (was delayed)
180ms   G100/O3 (P)

JITTER BUFFER - Reorders frames
════════════════════════════════════════════════════════════════════════════

Time: 50ms    Buffer: [K₀]           waiting...
Time: 150ms   K₀ ready but... waiting for jitter window
              Actually, K₀ held since T=50, so at T=150 it's released

Time: 150ms   → K₀ released → DECODE
              Buffer: []

Time: 165ms   Buffer: [P₂]           P₂ arrived, but can't release (need P₁ first!)
                                     GroupArbiter tracks objectId order

Time: 170ms   Buffer: [P₁, P₂]       P₁ arrives! Now in correct order
                      ↑    ↑
                    obj1  obj2

Time: 270ms   → P₁ released (held 100ms from T=170) → DECODE
Time: 270ms   → P₂ also ready (held >100ms) → DECODE
Time: 280ms   → P₃ released → DECODE

RENDER BUFFER
════════════════════════════════════════════════════════════════════════════
Time: 150ms   [K₀]
Time: 270ms   [K₀][P₁][P₂]           ← P₁ and P₂ released together
Time: 280ms   [K₀][P₁][P₂][P₃]

Result: ✅ SMOOTH but with a gap
        - 120ms gap between K₀ and P₁ (vs normal 33ms)
        - Jitter buffer absorbed the reordering
        - No decode errors!
```

---

### Example 3: Group Doesn't Finish Before Deadline (SKIP)

**Scenario:** GOP 1 frames get stuck, GOP 2 arrives first.

```
SETTINGS:
  Max Latency: 500ms
  GOP Duration: 1000ms
  Skip to Latest: OFF

TIMELINE
════════════════════════════════════════════════════════════════════════════

Capture Time:     0ms (G100 K)    1000ms (G101 K)
                    ↓                ↓

Network Problems: GOP 100 stuck on slow path!

ARRIVAL TIMELINE
────────────────────────────────────────────────────────────────────────────
Time      Event
────────────────────────────────────────────────────────────────────────────
  50ms    G100/O0 (K) arrives → Active group = 100
                                Deadline = captureTime + GOP + maxLatency
                                         = 0 + 1000 + 500 = 1500ms

 100ms    G100/O1 (P) arrives

 ~~~~ Network congestion - G100 frames stuck ~~~~

1050ms    G101/O0 (K) arrives → New group! But G100 is still active
                                G101 deadline = 1000 + 1000 + 500 = 2500ms

1100ms    G101/O1 (P) arrives → Buffered, waiting for G100 to complete

1200ms    G101/O2 (P) arrives
1300ms    G101/O3 (P) arrives → G101 is complete but can't output!

~~~~~~~ Still waiting for G100 ~~~~~~~

1500ms    ⏰ G100 DEADLINE EXPIRES!

          Decision tree:
          1. Has G100 keyframe? YES
          2. Started outputting G100? YES (K₀, P₁ output)
          3. Allow partial decode? YES → Extend deadline +200ms

1700ms    ⏰ Extended deadline expires

          Decision tree:
          1. More frames arrived for G100? NO
          2. Next group (G101) has keyframe? YES
          3. → SKIP G100, activate G101

          Stats: groupsSkipped++

GROUP STATE DIAGRAM
════════════════════════════════════════════════════════════════════════════

Time: 50ms
┌─────────────┐
│ Group 100   │ ◄── ACTIVE
│ status: act │
│ frames: K,P₁│
│ deadline:   │
│   1500ms    │
└─────────────┘

Time: 1050ms
┌─────────────┐     ┌─────────────┐
│ Group 100   │ ◄── │ Group 101   │
│ status: act │     │ status: recv│
│ frames: K,P₁│     │ frames: K   │
│ deadline:   │     │ deadline:   │
│   1500ms    │     │   2500ms    │
└─────────────┘     └─────────────┘

Time: 1700ms (after skip)
┌─────────────┐     ┌─────────────┐
│ Group 100   │     │ Group 101   │ ◄── ACTIVE
│ status:SKIP │     │ status: act │
│ ❌ dropped  │     │ frames:K,P₁ │
└─────────────┘     │      P₂,P₃ │
                    └─────────────┘

RENDER BUFFER - What user sees
════════════════════════════════════════════════════════════════════════════
Time     Display
─────────────────────────────────────────────────
 150ms   [G100:K₀]              ← GOP 100 starts
 185ms   [G100:K₀][G100:P₁]     ← Partial GOP 100

 ... long pause (~1.5 seconds) ...

1800ms   [G101:K₀]              ← JUMP to GOP 101 (visual discontinuity!)
1833ms   [G101:K₀][G101:P₁]     ← Smooth from here
1866ms   [G101:K₀][G101:P₁][G101:P₂]

Result: ⚠️ VISIBLE JUMP
        - User sees GOP 100 freeze for ~1.5s
        - Then jumps to GOP 101
        - Better than infinite freeze!
```

---

### Example 4: Skip to Latest Group (Aggressive Catch-up)

**Scenario:** Same as above but with `skipToLatestGroup: true, skipGraceFrames: 3`

```
SETTINGS:
  Max Latency: 500ms
  GOP Duration: 1000ms
  Skip to Latest: ON ✓
  Grace Frames: 3

ARRIVAL TIMELINE
────────────────────────────────────────────────────────────────────────────
Time      Event
────────────────────────────────────────────────────────────────────────────
  50ms    G100/O0 (K) arrives → Active group = 100
 100ms    G100/O1 (P) arrives

 ~~~~ Network congestion ~~~~

1050ms    G101/O0 (K) arrives → pendingSkipGroupId = 101
                                pendingSkipFrameCount = 1 (has keyframe!)

1100ms    G101/O1 (P) arrives → pendingSkipFrameCount = 2
1200ms    G101/O2 (P) arrives → pendingSkipFrameCount = 3 ← GRACE REACHED!

          🚀 IMMEDIATE SKIP TRIGGERED (don't wait for deadline!)

          → Mark G100 as SKIPPED
          → Activate G101
          → Start outputting G101 frames

COMPARISON: Without vs With Skip-to-Latest
════════════════════════════════════════════════════════════════════════════

WITHOUT skipToLatestGroup:
─────────────────────────────────────────
Time     Render
─────────────────────────────────────────
 150ms   [G100:K₀]
 185ms   [G100:P₁]
         ... wait for deadline (1500ms) ...
         ... extend deadline (+200ms) ...
1700ms   [G101:K₀] ← Finally! 1.5s delay
─────────────────────────────────────────
Total delay: ~1550ms


WITH skipToLatestGroup + graceFrames=3:
─────────────────────────────────────────
Time     Render
─────────────────────────────────────────
 150ms   [G100:K₀]
 185ms   [G100:P₁]
         ... G101 arrives with 3 frames ...
1300ms   [G101:K₀] ← Skip immediately!
1333ms   [G101:P₁]
─────────────────────────────────────────
Total delay: ~1150ms (saved 400ms!)

Result: ✅ FASTER RECOVERY but more skips
        - Trades smoothness for lower latency
        - Good for real-time/interactive
        - Bad for broadcast (visible jumps)
```

---

### Example 5: Jitter Buffer Too Small (Decode Errors)

**Scenario:** Jitter buffer set too low, frames can't reorder.

```
SETTINGS:
  Jitter Buffer: 20ms  ← TOO LOW!

ARRIVAL (with typical ~30ms jitter)
────────────────────────────────────────────────────────────────────────────
Time      Frame           Buffer State
────────────────────────────────────────────────────────────────────────────
 50ms     G100/O0 (K)     [K₀]
 70ms     K₀ released     [] → DECODE K₀ ✓
 85ms     G100/O2 (P)     [P₂] ← P₂ arrived before P₁!
105ms     P₂ released     → DECODE P₂ ❌ ERROR! (need P₁ first)
110ms     G100/O1 (P)     [P₁] ← P₁ finally arrives
130ms     P₁ released     → DECODE P₁ (too late, decoder broken)

RENDER BUFFER - Broken!
════════════════════════════════════════════════════════════════════════════
 70ms    [K₀]           ✓
105ms    [K₀][????]     ❌ Decode error - P₂ without P₁

         Decoder may:
         - Show corrupted frame
         - Show nothing (black)
         - Crash/reset

Result: ❌ DECODE ERRORS
        Fix: Increase jitter buffer to > network jitter
             Typically 50-100ms for most networks
```

---

### Example 6: Complete Flow Diagram

```
PUBLISHER SIDE
══════════════════════════════════════════════════════════════════════════════

  Camera    →    Encoder    →    LOC Package    →    MOQT Send
    │              │                  │                   │
    │         [K][P][P][P]      [LOC][LOC][LOC]     Group N, Objects 0-3
    │              │                  │                   │
    └──────────────┴──────────────────┴───────────────────┘
                        GOP N (1 second)


NETWORK (Multiple QUIC Streams)
══════════════════════════════════════════════════════════════════════════════

     ┌─── Stream for Group N ────────────────────┐
     │   [K₀]───────────[P₁]────[P₂]────[P₃]     │  ← May arrive out of order!
     └───────────────────────────────────────────┘

     ┌─── Stream for Group N+1 ──────────────────┐
     │   [K₀]────[P₁]────[P₂]────[P₃]            │  ← Can overtake Group N!
     └───────────────────────────────────────────┘


SUBSCRIBER SIDE
══════════════════════════════════════════════════════════════════════════════

  MOQT Receive    →    GroupArbiter    →    Decoder    →    Render
       │                     │                  │              │
       │         ┌───────────┴───────────┐     │              │
       │         │   ┌─────────────┐     │     │              │
       │         │   │ Jitter Hold │     │     │              │
       │         │   │  (100ms)    │     │     │              │
       │         │   └──────┬──────┘     │     │              │
       │         │          │            │     │              │
       │         │   ┌──────▼──────┐     │     │              │
       │         │   │Group Order  │     │     │              │
       │         │   │(grp,obj)    │     │     │              │
       │         │   └──────┬──────┘     │     │              │
       │         │          │            │     │              │
       │         │   ┌──────▼──────┐     │     │              │
       │         │   │ Deadline    │     │     │              │
       │         │   │ Check       │     │     │              │
       │         │   └──────┬──────┘     │     │              │
       │         │          │            │     │              │
       │         └──────────┼────────────┘     │              │
       │                    │                  │              │
       │              Ready Frames             │              │
       │                    ▼                  │              │
       │              [K₀][P₁][P₂]────────────►│              │
       │                                       │              │
       │                                  VideoFrame         │
       │                                       ▼              │
       │                                   ┌───────┐         │
       │                                   │Canvas │◄────────┘
       │                                   └───────┘
       │
       └───────────────────────────────────────────────────────


LATENCY BREAKDOWN
══════════════════════════════════════════════════════════════════════════════

  Capture ──► Encode ──► Network ──► Jitter ──► Decode ──► Render
    │          │           │          │          │          │
    │   ~10ms  │   ~50ms   │  ~100ms  │  ~10ms   │  ~16ms   │
    │          │           │          │          │          │
    └──────────┴───────────┴──────────┴──────────┴──────────┘

                     Total: ~186ms end-to-end

  ┌────────────────────────────────────────────────────────────────┐
  │ To reduce latency:                                              │
  │  • Lower jitter buffer (but risk reorder failures)             │
  │  • Lower maxLatency (but risk more skips)                       │
  │  • Use skipToLatestGroup (but risk visible jumps)              │
  │                                                                 │
  │ To improve smoothness:                                          │
  │  • Higher jitter buffer (more reorder tolerance)               │
  │  • Higher maxLatency (wait longer for frames)                  │
  │  • Disable skipToLatestGroup (complete each GOP)               │
  └────────────────────────────────────────────────────────────────┘
```

---

### Summary: When to Use Each Setting

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     SETTING DECISION GUIDE                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  USE CASE              JITTER    MAX_LAT   SKIP_LATEST   RESULT         │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│  Video Call            50ms      300ms     ON (grace=2)  Low latency    │
│  (interactive)                                           Some jumps     │
│                                                                          │
│  Gaming Stream         20ms      200ms     ON (grace=0)  Ultra-low lat  │
│  (twitch-style)                                          More jumps     │
│                                                                          │
│  Webinar/Broadcast    150ms      1000ms    OFF           Smooth         │
│  (one-way)                                               Higher delay   │
│                                                                          │
│  Unstable Network     100ms      500ms     ON (grace=5)  Balanced       │
│  (mobile/wifi)                                           Adaptive       │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Deadline Calculation: Interactive vs Streaming Mode

### The `useLatencyDeadline` Configuration

The GroupArbiter supports two deadline calculation modes controlled by `useLatencyDeadline`:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      DEADLINE CALCULATION MODES                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  useLatencyDeadline: true  (INTERACTIVE MODE)                               │
│  ─────────────────────────────────────────────                              │
│  deadline = captureTime + maxLatency                                        │
│                                                                              │
│  Example: maxLatency=50ms                                                   │
│           → Frame captured at T=0 expires at T=50ms                         │
│           → Ultra-low latency, good for video calls                         │
│                                                                              │
│  useLatencyDeadline: false  (STREAMING MODE - default)                      │
│  ──────────────────────────────────────────────────                         │
│  deadline = captureTime + gopDuration + maxLatency                          │
│                                                                              │
│  Example: gopDuration=1000ms, maxLatency=500ms                              │
│           → Frame captured at T=0 expires at T=1500ms                       │
│           → More tolerant, good for broadcast                               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Why Two Modes?

**Problem with Streaming Mode for Conferencing:**

In video conferencing, GOPs are often dynamic:
- Keyframes sent on scene changes
- Keyframes sent on receiver request
- GOP duration can vary from 100ms to 30+ seconds

With `gopDuration=5000ms` and `maxLatency=50ms`:
```
Streaming mode: deadline = 0 + 5000 + 50 = 5050ms  ← 5 seconds of latency!
Interactive mode: deadline = 0 + 50 = 50ms         ← What you actually want
```

**When to Use Each Mode:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  INTERACTIVE MODE (useLatencyDeadline: true)                                │
│  ───────────────────────────────────────────                                │
│  ✓ Video conferencing                                                       │
│  ✓ Interactive streaming (gaming)                                           │
│  ✓ Any two-way communication                                                │
│  ✓ When GOPs are dynamic/unpredictable                                      │
│                                                                              │
│  STREAMING MODE (useLatencyDeadline: false)                                 │
│  ──────────────────────────────────────────                                 │
│  ✓ Broadcast/webinar (one-way)                                              │
│  ✓ VOD playback                                                             │
│  ✓ When GOP duration is fixed and known                                     │
│  ✓ When smoothness matters more than latency                                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### Example 7: Interactive Mode - Fast Deadline Expiration

**Scenario:** Interactive mode with 50ms maxLatency, network delays a group.

```
SETTINGS:
  useLatencyDeadline: true  ← INTERACTIVE MODE
  Max Latency: 50ms
  GOP Duration: 5000ms (ignored for deadline!)

TIMELINE
════════════════════════════════════════════════════════════════════════════

Capture Timeline:
  G100 captured at T=0ms
  G101 captured at T=5000ms

Network Arrival:
────────────────────────────────────────────────────────────────────────────
Time      Event
────────────────────────────────────────────────────────────────────────────
 30ms     G100/O0 (K) arrives
          Deadline = 0 + 50 = 50ms  ← Only 20ms left!

 45ms     G100/O1 (P) arrives

 50ms     ⏰ DEADLINE EXPIRES!

          Interactive mode: We don't wait the full GOP duration
          Decision: Skip immediately if newer keyframe available

 55ms     G101/O0 (K) arrives → SKIP G100, activate G101

DEADLINE COMPARISON
════════════════════════════════════════════════════════════════════════════

                    Interactive Mode          Streaming Mode
                    useLatencyDeadline:true   useLatencyDeadline:false
────────────────────────────────────────────────────────────────────────────
Deadline formula    captureTime + maxLatency  captureTime + GOP + maxLatency
Example values      0 + 50 = 50ms             0 + 5000 + 50 = 5050ms
Frame expires at    50ms                      5050ms
Latency ceiling     50ms                      5050ms
Skip behavior       Aggressive                Tolerant
Use case            Video calls               Broadcast

Result: ✅ Interactive mode keeps latency at 50ms even with 5s GOP
```

---

### Example 8: Deadline Expires, No Next Group Yet

**Scenario:** What happens when deadline expires but the next group hasn't arrived?

```
SETTINGS:
  useLatencyDeadline: true
  Max Latency: 100ms

TIMELINE
════════════════════════════════════════════════════════════════════════════

Time      Event
────────────────────────────────────────────────────────────────────────────
  0ms     G100/O0 (K) arrives → deadline = 100ms
 30ms     G100/O1 (P) arrives

100ms     ⏰ DEADLINE EXPIRES!

          Check: Is there a newer group with keyframe? NO

          Decision tree:
          ┌─────────────────────────────────────────────────────────┐
          │ 1. Deadline expired                                      │
          │ 2. No newer keyframe group available                     │
          │    → Cannot skip (skipOnlyToKeyframe: true)              │
          │ 3. Has partial output started?                           │
          │    YES → Extend deadline +200ms (deadlineExtension)      │
          │    NO  → Keep waiting for newer keyframe                 │
          └─────────────────────────────────────────────────────────┘

150ms     Still waiting... G100 stays active (no choice)

200ms     G101/O0 (K) arrives! NOW we can skip!

          → Mark G100 as SKIPPED
          → Activate G101
          → Output G101 keyframe after jitter delay

RENDER BUFFER - What user sees
════════════════════════════════════════════════════════════════════════════
Time      Display
────────────────────────────────────────────────────────────────────────────
100ms     [G100:K₀]           ← Only keyframe rendered
130ms     [G100:P₁]           ← P-frame rendered (partial GOP)

          ... FREEZE for ~100ms ...

300ms     [G101:K₀]           ← Jump to new GOP

Result: ⚠️ SHORT FREEZE
        - Without newer keyframe, must wait
        - skipOnlyToKeyframe prevents jumping to group without keyframe
        - User sees brief freeze then catches up
```

---

## Catch-Up Mode: Buffer Flush with Selective Rendering

### The Problem

When buffer gets deep (many frames waiting), the decoder falls behind and latency increases.

```
SCENARIO: Decoder slower than network, buffer fills up
════════════════════════════════════════════════════════════════════════════

Time     Network                  Buffer                 Decoder
────────────────────────────────────────────────────────────────────────────
 0ms     Frame 0 arrives         [F0]                   idle
10ms     Frame 1 arrives         [F0,F1]                decoding F0...
20ms     Frame 2 arrives         [F0,F1,F2]             still decoding F0
30ms     Frame 3 arrives         [F0,F1,F2,F3]          still...
40ms     Frame 4 arrives         [F0,F1,F2,F3,F4]       F0 done, start F1
50ms     Frame 5 arrives         [F1,F2,F3,F4,F5]       decoding F1
...

PROBLEM: Buffer keeps growing, latency keeps increasing!
```

### The Solution: Catch-Up Mode

When buffer exceeds threshold, flush all frames to decoder but only **render the last one**.

```
SETTINGS:
  enableCatchUp: true
  catchUpThreshold: 5  (frames)

CATCH-UP FLOW
════════════════════════════════════════════════════════════════════════════

Time     Buffer State              Action
────────────────────────────────────────────────────────────────────────────
         [F0,F1,F2,F3,F4,F5]       6 frames ready (> threshold of 5)

         🚨 CATCH-UP MODE TRIGGERED!

         Output frames with shouldRender flag:
         ┌─────────────────────────────────────────────────────────┐
         │  F0: shouldRender = false  → Decode but don't display   │
         │  F1: shouldRender = false  → Decode but don't display   │
         │  F2: shouldRender = false  → Decode but don't display   │
         │  F3: shouldRender = false  → Decode but don't display   │
         │  F4: shouldRender = false  → Decode but don't display   │
         │  F5: shouldRender = true   → Decode AND display! ✓      │
         └─────────────────────────────────────────────────────────┘

         Buffer after: []  (empty, caught up!)

WHY DECODE ALL?
────────────────────────────────────────────────────────────────────────────
P-frames depend on previous frames for decoding. Skipping decode would break
the chain:

  [K]───►[P]───►[P]───►[P]───►[P]───►[P]
   ↑      ↑      ↑      ↑      ↑      ↑
   │      │      │      │      │      └── Must decode this
   │      │      │      │      └── Needs previous P
   │      │      │      └── Needs previous P
   │      │      └── Needs previous P
   │      └── Needs keyframe
   └── Required base

So we decode all frames to maintain decoder state, but only render the last
one to skip ahead visually.
```

### Example 9: Catch-Up Mode in Action

```
SETTINGS:
  enableCatchUp: true
  catchUpThreshold: 5
  maxLatency: 500ms

TIMELINE - Network burst causes buffer backup
════════════════════════════════════════════════════════════════════════════

Time      Event                           Buffer      Latency
────────────────────────────────────────────────────────────────────────────
  0ms     F0 arrives                      [F0]        ~50ms (normal)
 33ms     F1 arrives                      [F0,F1]     ~80ms
 66ms     F2 arrives                      [F0,F1,F2]  ~110ms

          ~~ NETWORK BURST: 6 frames arrive at once ~~

100ms     F3,F4,F5,F6,F7,F8 arrive!       [F0..F8]    ~300ms 😱

          Buffer has 9 frames > threshold (5)!

          🚨 CATCH-UP TRIGGERED

          Output:
          ┌────────────────────────────────────────┐
          │ F0: decode, shouldRender=false         │
          │ F1: decode, shouldRender=false         │
          │ F2: decode, shouldRender=false         │
          │ F3: decode, shouldRender=false         │
          │ F4: decode, shouldRender=false         │
          │ F5: decode, shouldRender=false         │
          │ F6: decode, shouldRender=false         │
          │ F7: decode, shouldRender=false         │
          │ F8: decode, shouldRender=TRUE ✓        │
          └────────────────────────────────────────┘

          Stats: catchUpEvents++, framesFlushed += 8

150ms     Buffer empty, latency back to ~50ms ✅

RENDER TIMELINE - What user sees
════════════════════════════════════════════════════════════════════════════

Without catch-up:
─────────────────────────────────────────────────────
F0 → F1 → F2 → ... wait for decode ... → F8
│                                          │
└── High latency persists ─────────────────┘

With catch-up:
─────────────────────────────────────────────────────
F0 → F1 → F2 → ~~~skip~~~jump~~~to~~~ → F8
│                                        │
└── Latency spike absorbed ──────────────┘

Result: ✅ INSTANT CATCH-UP
        - Visual jump from F2 to F8
        - Latency recovered immediately
        - Decoder state maintained (no corruption)
```

---

## Combined Mode Matrix: User Experience Guide

This matrix shows expected behavior for all combinations of settings:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    USER EXPERIENCE BY MODE COMBINATION                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  useLatency  skipToLatest  enableCatch  Expected Behavior                   │
│  Deadline    Group         Up                                                │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                              │
│  false       false         false        ULTRA-SMOOTH, HIGH LATENCY          │
│  (streaming)                            - Wait full GOP+maxLatency           │
│                                         - No skips, no jumps                 │
│                                         - Latency: seconds                   │
│                                         - Use: VOD, broadcast                │
│                                                                              │
│  false       false         true         SMOOTH + CATCH-UP                   │
│  (streaming)                            - Wait for GOPs normally             │
│                                         - Jump forward on buffer backup      │
│                                         - Latency: moderate                  │
│                                         - Use: webinar with variable network │
│                                                                              │
│  false       true          false        FAST SKIP, JUMPY                    │
│                                         - Skip to new GOP when available     │
│                                         - But still uses GOP deadline        │
│                                         - Latency: moderate-high             │
│                                                                              │
│  false       true          true         SKIP + CATCH-UP                     │
│                                         - Skip GOPs aggressively             │
│                                         - Catch-up within GOP                │
│                                         - Latency: moderate                  │
│                                                                              │
│  true        false         false        STRICT DEADLINE, NO RECOVERY        │
│  (interactive)                          - Expire at maxLatency only          │
│                                         - No skip, no catch-up               │
│                                         - May freeze if behind               │
│                                         - Use: testing                       │
│                                                                              │
│  true        false         true         ★ RECOMMENDED FOR CONFERENCING ★    │
│  (interactive)                          - Tight deadline (maxLatency only)   │
│                                         - Catch-up on buffer overflow        │
│                                         - No aggressive GOP skipping         │
│                                         - Latency: <100ms achievable         │
│                                         - Use: video calls, interactive      │
│                                                                              │
│  true        true          false        AGGRESSIVE LOW LATENCY               │
│  (interactive)                          - Tight deadline + skip to latest    │
│                                         - May have visible jumps             │
│                                         - Latency: ultra-low                 │
│                                         - Use: gaming, real-time             │
│                                                                              │
│  true        true          true         ★ MAXIMUM RESPONSIVENESS ★          │
│  (interactive)                          - All features enabled               │
│                                         - Skip GOPs + catch-up in GOP        │
│                                         - Most aggressive                    │
│                                         - Use: gaming with poor network      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### Recommended Presets

```typescript
// Video Conferencing (balanced)
{
  useGroupArbiter: true,
  useLatencyDeadline: true,    // Interactive mode
  maxLatency: 100,             // 100ms deadline
  enableCatchUp: true,         // Recover from buffer backup
  catchUpThreshold: 5,         // Catch up when 5+ frames buffered
  skipToLatestGroup: false,    // Don't skip GOPs aggressively
  jitterBufferDelay: 30,       // Light jitter buffer
}

// Gaming/Interactive (ultra-low latency)
{
  useGroupArbiter: true,
  useLatencyDeadline: true,
  maxLatency: 50,              // Aggressive 50ms deadline
  enableCatchUp: true,
  catchUpThreshold: 3,         // Catch up quickly
  skipToLatestGroup: true,     // Skip to newest keyframe
  skipGraceFrames: 2,          // Skip fast
  jitterBufferDelay: 10,       // Minimal jitter buffer
}

// Broadcast/Webinar (smooth)
{
  useGroupArbiter: true,
  useLatencyDeadline: false,   // Streaming mode
  maxLatency: 2000,            // Tolerant deadline
  estimatedGopDuration: 2000,  // Match encoder GOP
  enableCatchUp: false,        // No visual jumps
  skipToLatestGroup: false,
  jitterBufferDelay: 100,      // More buffering
}
```

---

## Common Scenarios

### RTP-Sourced Video (90kHz timescale)

```typescript
{
  useGroupArbiter: true,
  catalogTimescale: 90000,  // RTP clock rate for video
  estimatedGopDuration: 1000,
}
```

### Low-Latency Gaming/Interactive

```typescript
{
  useGroupArbiter: true,
  maxLatency: 200,           // Aggressive skip threshold
  jitterBufferDelay: 20,     // Minimal buffering
  estimatedGopDuration: 500, // Short GOP for frequent keyframes
}
```

### Broadcast/VOD (Smooth Playback)

```typescript
{
  useGroupArbiter: true,
  maxLatency: 2000,          // Tolerant of delays
  jitterBufferDelay: 100,    // More buffering for smoothness
  estimatedGopDuration: 2000, // Longer GOP typical for broadcast
}
```

## Troubleshooting

### Decode Errors Still Occurring

1. Check if `useGroupArbiter: true` is set
2. Verify the decode worker is receiving the config (check logs)
3. Ensure `maxLatency` isn't set too low for your network conditions

### High Latency / Delayed Playback

1. Reduce `maxLatency` to skip stale groups faster
2. Reduce `jitterBufferDelay` for less buffering
3. Check `stats.groupsSkipped` - high values indicate network issues

### Groups Being Skipped Too Aggressively

1. Increase `maxLatency` to be more tolerant
2. Check if `estimatedGopDuration` matches your actual GOP
3. Set `catalogFramerate` if known for better estimation

## API Reference

### GroupArbiter<T>

```typescript
class GroupArbiter<T> {
  constructor(config: Partial<TimingConfig>, tickProvider?: TickProvider);

  /** Add a frame to the arbiter */
  addFrame(input: ArbiterFrameInput<T>): boolean;

  /** Get frames ready for output */
  getReadyFrames(maxFrames?: number): FrameEntry<T>[];

  /** Get current statistics */
  getStats(): ArbiterStats;

  /** Get active group ID (-1 if none) */
  getActiveGroupId(): number;

  /** Reset to initial state */
  reset(): void;
}
```

### ArbiterFrameInput<T>

```typescript
interface ArbiterFrameInput<T> {
  groupId: number;
  objectId: number;
  data: T;
  isKeyframe: boolean;
  locTimestamp?: number;    // LOC timestamp (microseconds)
  locTimescale?: number;    // Units per second (default: 1,000,000)
  isDiscardable?: boolean;  // From LOC Video Frame Marking
}
```

### FrameEntry<T>

```typescript
interface FrameEntry<T> {
  data: T;
  objectId: number;
  receivedTick: number;
  locTimestamp?: number;
  isKeyframe: boolean;
  isDiscardable: boolean;
}
```
