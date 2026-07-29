# Top-N + SSTS (DTS) Implementation Plan

## Goal

Implement the full Top-N + SSTS demo as described in the IETF presentation:
- Each participant publishes **3 video qualities** (720p, 360p, 180p)
- Subscriber displays a **configurable grid** (1x2 or 2x2)
- Top-N selects the **active speakers** (WHICH sources)
- SSTS/DTS selects the **quality per source** (WHAT quality)
- Leftmost speaker = loudest = highest rank = best quality
- Demonstrate degraded quality under network constraints

---

## Architecture Summary

```
Publisher (per participant):
  NS: (<room-id>, "720p", <participant>) Track: "video"   pri=1  (2 Mbps)
  NS: (<room-id>, "360p", <participant>) Track: "video"   pri=2  (1 Mbps)
  NS: (<room-id>, "180p", <participant>) Track: "video"   pri=3  (500 kbps)
  NS: (<room-id>, "audio", <participant>) Track: "opus48k" pri=0  (critical)

Subscriber:
  3× SUBSCRIBE_NAMESPACE (one per rendition prefix) + TOP_TRACKS_FILTER{N=4}
  On incoming PUBLISH → assigns SWITCHING-SET per source (grouped by participant)
  Left-most slot = Rank 0 (highest priority), others = Rank 1

Relay (moqtail):
  TopNCoordinator: ranks by LOUDNESS on video objects → selects top-N sources
  DTS Allocator: per switching set, picks ONE rendition based on bandwidth budget
  Group-boundary switching: seamless quality transitions
```

---

## Namespace Redesign

### Current (single rendition)

```
NS: [<room-id>, <participant>]   Track: "video"
NS: [<room-id>, <participant>]   Track: "audio"
```

### New (rendition in namespace)

```
NS: [<room-id>, "720p", <participant>]   Track: "video"    pri=1, bitrate=2000kbps
NS: [<room-id>, "360p", <participant>]   Track: "video"    pri=2, bitrate=1000kbps
NS: [<room-id>, "180p", <participant>]   Track: "video"    pri=3, bitrate=500kbps
NS: [<room-id>, "audio", <participant>]  Track: "opus48k"  pri=0
```

This ensures Top-N evaluates **one track per source per rendition** — no wasted slots.

---

## Changes Required

### Phase 1: Simulcast Publishing (moq-web-tail)

#### 1.1 `packages/media/src/pipeline/publish-pipeline.ts`

**Change:** Support multiple simultaneous video encoders (simulcast).

- Add `SimulcastConfig` to `PublishPipelineConfig`:
  ```typescript
  interface SimulcastLayer {
    label: string;       // "720p" | "360p" | "180p"
    width: number;
    height: number;
    bitrate: number;
    framerate: number;
    priority: number;    // publisher priority (1=lowest, 3=highest)
  }

  interface PublishPipelineConfig {
    // existing single-layer config (backward compat)
    video?: VideoEncoderConfig;
    audio?: OpusEncoderOptions;
    // new: simulcast layers
    simulcast?: SimulcastLayer[];
    ...
  }
  ```

- Create one `H264Encoder` per layer, each encoding from the same source
  `MediaStreamTrack` (use `MediaStreamTrackProcessor` → `ReadableStream` →
  fan-out to N encoders, or clone track at different resolutions via
  `CanvasCaptureMediaStreamTrack` / `VideoTrackGenerator`)
- Emit `'video-object'` events tagged with the layer label:
  ```typescript
  pipeline.on('video-object', (obj, layer: string) => { ... });
  ```

#### 1.2 `apps/meet/src/hooks/usePublish.ts`

**Change:** Publish 3 video tracks under separate namespaces per rendition.

```typescript
const LAYERS: SimulcastLayer[] = [
  { label: '720p', width: 1280, height: 720, bitrate: 2_000_000, framerate: 30, priority: 1 },
  { label: '360p', width: 640,  height: 360, bitrate: 1_000_000, framerate: 30, priority: 2 },
  { label: '180p', width: 320,  height: 180, bitrate: 500_000,   framerate: 30, priority: 3 },
];

// Publish each layer under its own namespace
for (const layer of LAYERS) {
  const ns = [roomId, layer.label, displayName];
  const alias = await session.publish(ns, 'video', {
    deliveryMode: 'stream',
    priority: layer.priority,
  });
  // Wire pipeline layer → session.sendObject(alias, ...)
  // Attach SPEECH_ACTIVITY extension to ALL layers (same value)
}

// Audio under its own rendition namespace
const audioNs = [roomId, 'audio', displayName];
const audioAlias = await session.publish(audioNs, 'opus48k', {
  deliveryMode: 'stream',
  priority: 0, // critical
});
```

- `setOwnNamespacePrefix` needs to filter across all renditions — use `roomId + '/' + displayName` substring match or set multiple prefixes.

#### 1.3 `apps/meet/src/hooks/useBotPublish.ts` & `useSyntheticParticipant.ts`

**Change:** Same simulcast publishing for bots. Canvas source scaled to 3 resolutions.

- Bot publishes 3 video tracks (same namespace scheme)
- Speech activity attached to all 3 video tracks identically
- Use different canvas sizes or downscale from 720p source

#### 1.4 `packages/session/src/session.ts`

**Change:** Support multiple `setOwnNamespacePrefix` values (or prefix-match logic)
so that all 3 renditions of self are filtered from incoming-publish events.

---

### Phase 2: Per-Rendition Subscribe + Top-N (moq-web-tail)

#### 2.1 `apps/meet/src/hooks/useSubscribe.ts`

**Change:** Send 3× `subscribeNamespace` (one per rendition prefix) with Top-N filter.

```typescript
const renditions = ['720p', '360p', '180p'];
for (const r of renditions) {
  await session.subscribeNamespace([roomId, r], {
    trackFilter: {
      propertyType: SPEECH_ACTIVITY_KEY,
      maxSelected: gridSize, // 2 for 1x2, 4 for 2x2
    },
  });
}
// Also subscribe audio
await session.subscribeNamespace([roomId, 'audio'], {});
```

#### 2.2 Switching Set Assignment (PUBLISH_OK response)

**Change:** When `incoming-publish` fires for a new source, assign a switching set.

- Extract participant ID from namespace: `namespace[namespace.length - 1]`
- Extract rendition from namespace: `namespace[namespace.length - 2]`
- Group all renditions of the same participant into ONE switching set
- Assign `switchingSetId` based on grid position (1-based)
- Use **hdev_id** (hash of participant ID) as a stable switching set ID:
  ```typescript
  const setId = hashParticipantToSetId(participantId);
  ```
- Left-to-right assignment: loudest speaker → leftmost grid slot → `rank=0`
  Others → `rank=1`

```typescript
// On incoming-publish for a video track:
const participantId = namespace[namespace.length - 1];
const rendition = namespace[namespace.length - 2]; // "720p" | "360p" | "180p"
const setId = getOrAssignSetId(participantId);
const gridPosition = getGridPosition(participantId); // 0=left-most
const rank = gridPosition === 0 ? 0 : 1;

const dtsAssignment = serializeSwitchingSetAssignment({
  switchingSetId: setId,
  throughputThresholdKbps: THRESHOLD_MAP[rendition], // 2000, 1000, 500
  setThroughputFraction: 5,
  activateSwitching: isLastRenditionForThisSource(participantId, rendition),
  setRank: rank,
});

// Send PUBLISH_OK with SWITCHING_SET_ASSIGNMENT parameter
session.sendPublishOk(requestId, {
  parameters: new Map([[RequestParameter.SWITCHING_SET_ASSIGNMENT, dtsAssignment]]),
});
```

#### 2.3 Grid Position → Rank Mapping

```
Grid layout (2x2):
  ┌────────┬────────┐
  │ Pos 0  │ Pos 1  │   Pos 0 = loudest = rank 0
  │ rank=0 │ rank=1 │   Pos 1-3 = rank 1
  ├────────┼────────┤
  │ Pos 2  │ Pos 3  │
  │ rank=1 │ rank=1 │
  └────────┴────────┘

Grid layout (1x2):
  ┌────────┬────────┐
  │ Pos 0  │ Pos 1  │   Pos 0 = loudest = rank 0
  │ rank=0 │ rank=1 │   Pos 1 = rank 1
  └────────┴────────┘
```

When speaker ranking changes (Top-N coordinator swaps a source), re-assign
ranks via `REQUEST_UPDATE` with updated `SWITCHING_SET_ASSIGNMENT`.

#### 2.4 `packages/session/src/session.ts`

**New API needed:**
- `sendPublishOk(requestId, options)` — include SWITCHING_SET_ASSIGNMENT parameter
- `sendRequestUpdate(requestId, options)` — update rank/threshold when grid position changes

---

### Phase 3: DTS Allocator in Relay (moqtail)

#### 3.1 `libs/moqtail-rs/src/model/control/publish_ok.rs`

**Change:** Parse SWITCHING_SET_ASSIGNMENT parameter (type 0x41 = 65) from PUBLISH_OK.

- Deserialize fields: `switching_set_id`, `throughput_threshold_kbps`,
  `set_throughput_fraction`, `activate_switching`, `set_rank`

#### 3.2 New: `apps/relay/src/server/dts_allocator.rs`

**Create:** DTS bandwidth allocator, triggered on:
- PUBLISH_OK received with `activate_switching=true` (all tracks in set registered)
- Bandwidth estimation changes (QUIC congestion feedback)
- Group boundaries

```rust
struct SwitchingSet {
    set_id: u64,
    rank: u8,
    weight: u8, // derived from set_throughput_fraction
    tracks: Vec<DtsTrack>,
}

struct DtsTrack {
    full_track_name: FullTrackName,
    threshold_kbps: u64,
    currently_forwarding: bool,
}

impl DtsAllocator {
    /// Algorithm 0 (from presentation):
    /// 1. B_total = estimated downstream bandwidth
    /// 2. Group sets by rank (rank 0 first)
    /// 3. Per rank: allocate proportionally by weight
    /// 4. Per set: pick highest threshold ≤ per-set budget
    /// 5. FWD=1 for selected track, FWD=0 for others
    fn allocate(&mut self, b_total_kbps: u64) -> Vec<AllocationDecision> { ... }
}
```

#### 3.3 `apps/relay/src/server/message_handlers/publish_handler.rs`

**Change:** When PUBLISH_OK arrives from subscriber with SWITCHING_SET_ASSIGNMENT:
- Register the track in the DTS allocator under its switching set
- When `activate_switching=true`: run initial allocation, set FWD state

#### 3.4 `apps/relay/src/server/subscription.rs`

**Change:** Add FWD (forward) state per subscription.
- `FWD=1`: relay forwards objects to subscriber
- `FWD=0`: relay suppresses object forwarding (but keeps subscription alive)
- DTS allocator flips FWD at group boundaries

#### 3.5 `apps/relay/src/server/client.rs` — Object Forwarding

**Change:** Check FWD state before forwarding an object to a subscriber.
- On group boundary: check if DTS allocator wants to switch → flip FWD bits
- Emit REQUEST_UPDATE with FWD change to subscriber

#### 3.6 Integration with Top-N

```
TopNCoordinator tick:
  1. Determine top-N sources (unchanged)
  2. PUBLISH new tracks / PUBLISH_DONE old tracks (unchanged)
  3. Subscriber sends PUBLISH_OK with SWITCHING_SET_ASSIGNMENT
  4. DTS allocator registers the set
  5. DTS allocator runs allocation → sets FWD bits
  6. Objects flow only for FWD=1 tracks
```

When Top-N removes a source:
- DTS allocator removes that source's switching set
- Re-runs allocation for remaining sets (may upgrade quality for others)

---

### Phase 4: Bandwidth Estimation & Congestion Response (moqtail)

#### 4.1 `apps/relay/src/server/bandwidth_estimator.rs` (new)

**Create:** Bandwidth estimator using QUIC transport feedback.

```rust
impl BandwidthEstimator {
    /// Estimated available downstream bandwidth per connection
    fn estimate_kbps(&self, connection_id: usize) -> u64 { ... }

    /// External override for testing/demo (CLI or API)
    fn set_override_kbps(&mut self, connection_id: usize, kbps: u64) { ... }
}
```

For demo purposes, also support:
- CLI flag: `--bandwidth-cap-kbps <value>`
- HTTP API endpoint: `POST /api/bandwidth/{conn_id}` with body `{"kbps": 3000}`
- This allows live demo of degradation

#### 4.2 Congestion Response (Layered Defense)

```
Layer 1: Publisher priority (network-level)
  - QUIC drops 720p (pri=1) first, keeps 180p (pri=3)
  - Automatic, no relay logic needed

Layer 2: DTS algorithm (relay-level)
  - Re-run allocation with lower B_total
  - Switch to lower rendition at group boundary

Layer 3: Rank-based starvation (relay-level)
  - If budget insufficient even for 180p for all sets:
  - Rank 1 sets get starved before Rank 0
```

---

### Phase 5: UI Changes (moq-web-tail)

#### 5.1 `apps/meet/src/components/MeetingRoom.tsx`

**Changes:**
- Configurable grid: 1x2 or 2x2 (dropdown or toggle)
- Left-to-right ordering: loudest speaker always in position 0
- Quality badge overlay: show current rendition ("720p" / "360p" / "180p") on each tile
- Speaking indicator + loudness rank number

#### 5.2 `apps/meet/src/components/GridTile.tsx` (new)

**Create:** Grid tile component showing:
- Video canvas
- Quality badge (e.g., green "720p", yellow "360p", red "180p")
- Participant name
- Speaking indicator
- Rank indicator (#1, #2, etc.)

#### 5.3 `apps/meet/src/components/NetworkControls.tsx` (new)

**Create:** Demo control panel for simulating network constraints:

```
┌─────────────────────────────────────────────┐
│ Network Simulation                          │
├─────────────────────────────────────────────┤
│ Bandwidth Cap: [━━━━━━━━━●━━] 4000 kbps    │
│                                             │
│ Presets:                                    │
│  [Normal 6Mbps] [Constrained 3Mbps]        │
│  [Severe 1.5Mbps] [Critical 800kbps]       │
│                                             │
│ Rank Mode:                                  │
│  ○ Equal (all rank=0)                       │
│  ● Active Speaker Priority (left=0, rest=1)│
└─────────────────────────────────────────────┘
```

- Sends bandwidth cap to relay via HTTP API or WebTransport control message
- Shows real-time per-participant quality in the grid

#### 5.4 `apps/meet/src/store/index.ts`

**Changes:**
- Add `gridLayout: '1x2' | '2x2'` state
- Add `perParticipantQuality: Map<string, string>` (participant → current rendition)
- Add `networkCap: number` (kbps)
- Add `rankMode: 'equal' | 'speaker-priority'`

---

### Phase 6: Visual Quality Differentiation

#### 6.1 Make Degradation Clearly Visible

For the demo video to clearly show quality differences:

1. **Resolution labels burned into video**: Each encoder layer should burn a
   small label into the video ("720p" / "360p" / "180p") so the actual encoded
   resolution is visible in the decoded output regardless of display scaling.

2. **Color-coded borders**: 
   - 720p = green border
   - 360p = yellow border  
   - 180p = red border

3. **Bot video content**: Use high-detail content (text, fine lines) where
   compression artifacts at 180p are clearly visible vs. 720p.

#### 6.2 For Bot Participants (synthetic video)

Modify canvas rendering to include:
- A grid of small text (readable at 720p, blurry at 180p)
- Fine-line patterns that alias at low resolution
- Burn-in label: "SOURCE: bot-1 @ 720p" (matches actual encode layer)
- Timestamp counter to prove liveness

---

## Testing Plan

### Test 1: Basic Simulcast + Top-N (no DTS)

**Setup:** 1 relay + 3 participants (2 bots + 1 human)
**Verify:**
- Each participant publishes 3 video tracks
- Relay forwards only top-N sources (Top-N working as before)
- All 3 renditions arrive for each selected source (DTS not yet active)

### Test 2: DTS Quality Selection (equal rank)

**Setup:** 1 relay + 4 participants, 2x2 grid, all rank=0
**Steps:**
1. All 4 participants active (720p+360p+180p each)
2. Set bandwidth cap to 6000 kbps → expect 4 × 360p (1000 each, 4000 total)
3. Set bandwidth cap to 3000 kbps → expect 4 × 180p (500 each, 2000 total)
4. Set bandwidth cap to 8000+ kbps → expect 4 × 720p

### Test 3: DTS with Rank Priority (speaker priority)

**Setup:** 1 relay + 4 participants, 2x2 grid, left=rank 0, rest=rank 1
**Steps:**
1. Bandwidth cap = 4000 kbps
2. Expected: Rank 0 (loudest) gets 720p (2000), Rank 1 × 3 get 180p (500 each)
3. Total = 2000 + 1500 = 3500 kbps (within budget)
4. Verify visually: left tile is sharp HD, right tiles are visibly lower quality

### Test 4: Speaker Swap + DTS Re-allocation

**Setup:** Same as Test 3
**Steps:**
1. New participant starts speaking louder → enters top-N
2. Old participant drops out → removed from grid
3. New participant takes rank-0 slot (leftmost) → gets 720p
4. Previous rank-0 speaker shifts right → gets 180p
5. Verify: no glitches during transition (group-boundary switching)

### Test 5: Congestion Cascade

**Setup:** 4 participants, equal rank
**Steps:**
1. Start at 6000 kbps → all 360p
2. Gradually reduce to 2000 → all switch to 180p
3. Reduce to 800 → only 1-2 participants forwarded (top-N effective)
4. Recover to 6000 → smooth upgrade back to 360p/720p

### Test 6: Mixed Synthetic + Human

**Setup:** 2 bots (intermittent speech) + 2 humans
**Steps:**
1. Verify bots cycle through speaking/silent states
2. When bot speaks, it enters top-N and gets a grid slot
3. Bot's canvas content clearly shows resolution difference
4. Human participants experience the same quality adaptation
5. Verify self-exclusion: each participant doesn't see their own tracks

### Test 7: Demo Recording

**Setup:** 2 bots + 1 human, 1x2 grid, speaker priority mode
**Steps for video:**
1. Start with normal bandwidth → both at 360p
2. Show speaker swap (bot starts speaking → takes left slot)
3. Apply bandwidth constraint → left stays 720p, right drops to 180p
4. Show the visual difference clearly (HD vs. pixelated)
5. Release constraint → both recover to 360p
6. Record all of the above as a screen capture

---

## Implementation Order

```
Phase 1 (Publisher simulcast)     ← moq-web-tail only
  ├── 1.1 Multi-encoder PublishPipeline
  ├── 1.2 usePublish: 3 namespaces
  └── 1.3 Bot simulcast

Phase 2 (Subscriber SSTS)        ← moq-web-tail only
  ├── 2.1 3× subscribeNamespace
  ├── 2.2 SWITCHING_SET_ASSIGNMENT in PUBLISH_OK
  ├── 2.3 Grid position / rank logic
  └── 2.4 Session API additions

Phase 3 (Relay DTS)              ← moqtail only
  ├── 3.1 Parse SWITCHING_SET_ASSIGNMENT
  ├── 3.2 DTS allocator
  ├── 3.3 PUBLISH_OK handling
  ├── 3.4 FWD state per subscription
  ├── 3.5 Object forwarding gating
  └── 3.6 Top-N ↔ DTS integration

Phase 4 (Bandwidth + congestion)  ← moqtail
  ├── 4.1 Bandwidth estimator / override API
  └── 4.2 Layered congestion response

Phase 5 (UI)                      ← moq-web-tail
  ├── 5.1 Configurable grid
  ├── 5.2 Quality badge tiles
  ├── 5.3 Network control panel
  └── 5.4 Store updates

Phase 6 (Visual clarity)          ← moq-web-tail
  ├── 6.1 Resolution labels in encoded video
  └── 6.2 Bot high-detail content
```

---

## Key Design Decisions

### Switching Set ID = Hash of Participant ID

Use a deterministic hash so that:
- Same participant always gets same set ID across reconnections
- No coordination needed between relay and subscriber for ID assignment
- Simple: `setId = participantId.hashCode() & 0xFFFF`

Alternatively, assign sequentially (1, 2, 3, 4) based on grid position — simpler
for the demo and aligns with the "left to right = loudest to quietest" requirement.

**Recommendation:** Use grid position (1-4) as set ID. It's simpler, debuggable,
and directly maps to rank assignment. When speakers swap, re-assign set IDs via
REQUEST_UPDATE.

### Why 3 Renditions (Not 2 or 4)

- 720p (2 Mbps): Full quality for active speaker
- 360p (1 Mbps): Reasonable quality for thumbnails
- 180p (500 kbps): Emergency fallback under severe congestion

This gives meaningful visual differentiation at each step.

### Group-Aligned Switching

Publishers start new groups on keyframes. DTS switches only at group boundaries:
- No decoder errors
- No partial group data
- Clean visual transition

The relay buffers the new rendition's group start and switches FWD at that boundary.

### One SUBSCRIBE_NAMESPACE Per Rendition (Not One Big One)

Per the presentation's namespace redesign: separate subscriptions per rendition
ensure Top-N slots are never wasted on duplicate renditions of the same source.
The relay evaluates Top-N **independently per rendition** and selects the same
top-N sources in each.

---

## File Change Summary

### moq-web-tail

| File | Change |
|------|--------|
| `packages/media/src/pipeline/publish-pipeline.ts` | Add simulcast multi-encoder support |
| `packages/media/src/pipeline/publish-pipeline.ts` | New `SimulcastLayer` type, per-layer events |
| `packages/session/src/session.ts` | `sendPublishOk` with params, `sendRequestUpdate`, multi-prefix filter |
| `packages/session/src/types.ts` | Add `PublishOkOptions`, `RequestUpdateOptions` |
| `packages/core/src/encoding/dts.ts` | Already exists — used as-is |
| `apps/meet/src/hooks/usePublish.ts` | 3× publish (per rendition namespace) |
| `apps/meet/src/hooks/useSubscribe.ts` | 3× subscribeNamespace, SSTS assignment logic |
| `apps/meet/src/hooks/useBotPublish.ts` | Simulcast bot publishing |
| `apps/meet/src/hooks/useSyntheticParticipant.ts` | Simulcast synthetic participants |
| `apps/meet/src/components/MeetingRoom.tsx` | Configurable grid, quality badges |
| `apps/meet/src/components/GridTile.tsx` | New: grid tile with quality overlay |
| `apps/meet/src/components/NetworkControls.tsx` | New: bandwidth simulation panel |
| `apps/meet/src/store/index.ts` | Grid config, per-participant quality, rank mode |
| `apps/meet/src/lib/constants.ts` | Add layer configs, threshold map |

### moqtail

| File | Change |
|------|--------|
| `libs/moqtail-rs/src/model/control/publish_ok.rs` | Parse SWITCHING_SET_ASSIGNMENT param |
| `libs/moqtail-rs/src/model/control/request_update.rs` | Parse updated SSTS params |
| `apps/relay/src/server/dts_allocator.rs` | New: DTS bandwidth allocation algorithm |
| `apps/relay/src/server/bandwidth_estimator.rs` | New: BW estimation + override API |
| `apps/relay/src/server/subscription.rs` | Add FWD state, gating logic |
| `apps/relay/src/server/client.rs` | Check FWD before forwarding objects |
| `apps/relay/src/server/message_handlers/publish_handler.rs` | Register tracks in DTS allocator |
| `apps/relay/src/server/top_n_coordinator.rs` | Integration with DTS on add/remove |
| `apps/relay/src/server/config.rs` | `--bandwidth-cap-kbps` flag |
| `apps/relay/src/server/stats_endpoint.rs` | HTTP API for bandwidth override |
| `apps/relay/src/server/mod.rs` | Wire up new modules |

---

## Demo Scenario Script

### Recording: "Top-N + DTS Quality Adaptation"

**Duration:** ~90 seconds

```
0:00 - 0:15   Setup: 4 participants in 2x2 grid, all 360p (normal BW)
              Narration: "4 participants, relay selects quality per source"

0:15 - 0:30   Speaker priority: loudest → left slot → 720p
              Others → 180p. Clearly visible quality difference.
              Narration: "Active speaker gets HD, others get thumbnail quality"

0:30 - 0:45   New speaker: bot-2 starts talking louder
              Swap: bot-2 takes left slot, old speaker shifts right
              Narration: "Seamless speaker swap with quality re-allocation"

0:45 - 1:00   Network constraint applied (3 Mbps cap)
              All degrade equally (all rank=0 mode)
              All switch to 180p simultaneously
              Narration: "Under congestion, all degrade equally"

1:00 - 1:15   Same constraint with speaker priority (rank=0 vs rank=1)
              Left gets 720p, others get 180p
              Narration: "With rank priority, active speaker stays HD"

1:15 - 1:30   Recovery: bandwidth restored → smooth upgrade to 360p/720p
              Narration: "Recovery is seamless at group boundaries"
```

---

## Open Questions

1. **Bandwidth estimation**: Should we use real QUIC congestion control feedback,
   or just the override API for the demo? (Recommendation: override for demo,
   real estimation as stretch goal)

2. **SUBSCRIBE_TRACKS vs SUBSCRIBE_NAMESPACE**: The presentation uses
   `SUBSCRIBE_TRACKS` with namespace prefix. Our current implementation uses
   `subscribeNamespace`. Are these equivalent for this use case? (Yes — both
   select tracks by prefix with a filter)

3. **Switching set activation**: Should we wait for all 3 PUBLISH_OKs (with
   `activate_switching=true` on the last one), or activate per-track as they
   arrive? (Follow spec: activate on last one per set)

4. **Audio track handling under DTS**: Audio is NOT in switching sets — it always
   forwards. Only video quality adapts. Audio uses a separate namespace prefix
   (`[roomId, "audio"]`) with no Top-N filter (all audio forwarded, mixed client-side).
