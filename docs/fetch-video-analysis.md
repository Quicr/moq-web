# VOD FETCH Video Playback Analysis

## 1. Source File Analysis: `bbb_sunflower_1080p_30fps_normal.mp4`

### Stream Info

```bash
ffprobe -show_streams -select_streams v:0 bbb_sunflower_1080p_30fps_normal.mp4
```

| Property | Value |
|----------|-------|
| Codec | H.264 (AVC) |
| Profile | High |
| Level | 4.1 |
| Resolution | 1920x1080 |
| Framerate | 30 fps |
| Pixel Format | yuv420p |
| **has_b_frames** | **2** |
| Reference Frames | 4 |

### SPS/Slice Header Analysis

```bash
ffmpeg -i bbb_sunflower_1080p_30fps_normal.mp4 -c copy -bsf:v trace_headers -f null - 2>&1 \
  | grep -E "pic_order_cnt|max_num_reorder|max_num_ref"
```

| SPS Field | Value | Meaning |
|-----------|-------|---------|
| `pic_order_cnt_type` | 0 | Uses POC LSB for frame ordering |
| `log2_max_pic_order_cnt_lsb_minus4` | 4 | Max POC LSB = 2^(4+4) = 256 |
| `max_num_ref_frames` | 4 | Up to 4 reference frames |
| **`max_num_reorder_frames`** | **2** | Decoder must buffer 2 frames for reordering |

**Conclusion: The source file HAS B-frames with max reorder depth of 2.**

### DTS vs PTS Analysis (Decode Order vs Presentation Order)

```bash
ffprobe -show_entries packet=dts_time,pts_time,flags -select_streams v:0 \
  -read_intervals "%+#25" -of csv=p=0 bbb_sunflower_1080p_30fps_normal.mp4
```

| # | PTS (display) | DTS (decode) | Flags | Notes |
|---|---------------|--------------|-------|-------|
| 0 | 0.067 | 0.000 | K | I-frame (keyframe) |
| 1 | 0.100 | 0.033 | | I-frame |
| 2 | 0.133 | 0.067 | | P-frame |
| 3 | **0.200** | 0.100 | | P-frame — PTS jumps ahead |
| 4 | **0.167** | 0.133 | | B-frame — PTS goes backward |
| 5 | 0.233 | 0.167 | | P-frame |
| 6 | **0.700** | 0.200 | | P-frame — PTS 15 frames ahead! |
| 7 | 0.467 | 0.233 | | B-frame |
| 8 | 0.267 | 0.267 | | B-frame |

**Key observation**: Packet 6 has PTS=0.700 but DTS=0.200 — it's decoded 15 frames before it's displayed. This means **up to 15 B-frames can arrive between a P-frame's decode and display times**, far exceeding a reorder buffer depth of 4.

---

## 2. Publisher Remux Pipeline

### What happens when a file is uploaded

**File**: `packages/media/src/vod/vod-loader.ts`

When a user uploads an MP4 file, the VOD loader has two paths:

#### Fast Remux Path (H.264 sources) — lines 464-595
- **No re-encoding**. The original H.264 NAL units are extracted directly from the MP4 container.
- The MP4 parser reads the sample table (`stbl` box) to find each frame's offset, size, DTS, and composition time offset (ctOffset = PTS - DTS).
- Frames are **grouped into GOPs** by keyframes. Each GOP becomes a MoQ Transport group.
- Within each group, frames are numbered as `objectId = 0, 1, 2, ...` in **sample table order** (which is decode order / DTS order).
- Each frame is wrapped in LOC (Low Overhead Container) format with its `captureTimestamp` set to the **DTS-based timestamp** from the sample table.

#### Transcode Path (non-H.264 sources) — lines 600-797
- Falls back to WebCodecs VideoEncoder for decode + re-encode.
- Profile is auto-selected: High Level 5.1 (`avc1.640033`) for 4K, Baseline for smaller.
- **Not user-configurable** — profile is determined by resolution.

### Frame ordering on publish

**Frames are published in MP4 sample table order = decode order (DTS).**

The MP4 parser (`packages/media/src/vod/mp4-parser.ts`) extracts:
- `sample.dts` — decode timestamp from `stts` box (lines 582-600)
- `sample.ctOffset` — composition time offset from `ctts` box (lines 602-616)
- Presentation time = DTS + ctOffset

Samples are iterated in their original MP4 order (decode order), grouped by keyframes, and published as MoQ objects.

---

## 3. Encoding: Is H.264 profile user-selected?

**No.** For the fast remux path (H.264 source files), there is **zero re-encoding**. The original codec parameters, profile, B-frame structure, and NAL units are preserved exactly.

For the transcode path (non-H.264 sources), the H.264 profile is auto-selected based on resolution:
- ≤ 1920x1080: Baseline/Main profile
- \> 1920x1080: High Level 5.1 (`avc1.640033`)

The user cannot select the H.264 profile. The encoder is configured at `vod-loader.ts` lines 696-749:
```typescript
encoder.configure({
  codec,  // Auto-selected based on resolution
  width, height,
  bitrate: this.options.bitrate,
  framerate: this.options.framerate,
  latencyMode: 'quality',
  avc: { format: 'annexb' },
});
```

---

## 4. Decoder → Renderer: Frame Ordering Issue

### The Pipeline

```
MoQ FETCH → LOC unpack → PlayoutBuffer (objectId order = DTS order)
  → VodReleasePolicy (releases by objectId sequentially)
  → VideoDecoder.decode() (in decode/DTS order)
  → VideoFrame output (with PTS as frame.timestamp)
  → PresentationReorderBuffer (sorts by PTS, depth=4)
  → Frame Queue → RAF render
```

### Where reordering happens

1. **PlayoutBuffer** (`packages/media/src/pipeline/playout-buffer.ts`): Stores and releases frames by `objectId` (decode order). The `outputSequentialFrames()` method iterates objectIds 0, 1, 2, 3... sequentially.

2. **WebCodecs VideoDecoder**: Receives frames in decode order, outputs `VideoFrame` objects. The `frame.timestamp` is the **presentation timestamp (PTS)**, not DTS.

3. **PresentationReorderBuffer** (`packages/media/src/pipeline/presentation-reorder-buffer.ts`): Created for VOD content (`isLive === false`). Collects decoded VideoFrames and sorts by `frame.timestamp` (PTS) before releasing to the frame queue.
   - **Config**: `bufferDepth: 4, maxHoldTimeMs: 200ms`
   - Created at `subscribe-pipeline.ts` line 378
   - Worker-decoded frames route through it at line 393-394

### The Problem: Buffer Depth Too Small

The source file has `max_num_reorder_frames = 2` in the SPS, but the actual PTS-DTS gap in the bitstream shows P-frames that are decoded **15 frames before they are displayed** (PTS=0.700, DTS=0.200).

The `PresentationReorderBuffer` has `bufferDepth: 4`. This means:
- It only holds 4 frames before releasing the oldest
- If a P-frame is decoded that should display 15 frames later, it will be force-released after only 4 more frames arrive
- This causes **out-of-order display** — P-frames appear too early, B-frames appear too late

This is the root cause of the "shaking" during high-motion scenes:
- Low-motion scenes: B-frames are small, DTS≈PTS, reorder depth is shallow → smooth
- High-motion scenes: Large P-frames have deep reorder requirements → buffer overflow → wrong display order → visible jitter

### Fixes Applied

1. **Buffer depth**: Now derived dynamically from SPS `max_num_reorder_frames` via H.264 SPS parser (`h264-sps-parser.ts`). Default is 16 until SPS is parsed. The decode worker sends `sps-info` message to main thread when codec description arrives.

2. **PTS vs DTS bug (CRITICAL)**: The publisher was storing **DTS** as `captureTimestamp` in the LOC container (`vod-loader.ts:556`). On the subscriber side, this DTS was passed to the WebCodecs decoder as the frame timestamp. The `PresentationReorderBuffer` sorted by `frame.timestamp` — but since that was DTS (already in decode order), **no actual reordering happened**. Fixed by computing PTS = DTS + ctOffset on the publisher side.

---

## Summary of Issues

| Issue | Severity | Location |
|-------|----------|----------|
| Reorder buffer depth (4) too small for B-frame content with deep reordering | **HIGH** | `subscribe-pipeline.ts:380` |
| Publisher sends frames in DTS order (correct) | OK | `vod-loader.ts:546-588` |
| No re-encoding for H.264 (preserves B-frames) | OK | `vod-loader.ts:473-595` |
| PresentationReorderBuffer exists for VOD | OK | `subscribe-pipeline.ts:375-381` |
| Worker-decoded frames route through reorder buffer | OK | `subscribe-pipeline.ts:393-394` |
| H.264 profile not user-configurable | Minor | `vod-loader.ts:667-680` |
