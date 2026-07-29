# MOQ Meet — Top-N Conferencing App Plan

## Overview

A professional video conferencing app under `apps/meet/` that leverages the relay's **top-N track filtering** for active-speaker video selection and client-side **audio mixing** of 3 streams. Follows the [draft-jennings-moq-mocha-meetings](https://datatracker.ietf.org/doc/draft-jennings-moq-mocha-meetings/) subscribe-namespace design.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  MOQ Meet Client (React + Tailwind)                              │
│                                                                  │
│  ┌─────────────┐  ┌────────────────────┐  ┌──────────────────┐  │
│  │ Publish     │  │ Subscribe (Video)  │  │ Subscribe (Audio)│  │
│  │ Pipeline    │  │ SubscribeNamespace │  │ SubscribeNS      │  │
│  │ + VAD       │  │ + TrackFilter(N)   │  │ (top-3 mix)      │  │
│  └─────────────┘  └────────────────────┘  └──────────────────┘  │
│        │                    │                       │             │
└────────┼────────────────────┼───────────────────────┼────────────┘
         │                    │                       │
         ▼                    ▼                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  MOQTail Relay (top_n_coordinator)                               │
│                                                                  │
│  - Observes SPEECH_ACTIVITY (0x12) extension on audio objects    │
│  - Ranks tracks by speech activity value                         │
│  - Publishes top-N video tracks to subscriber                    │
│  - Publishes top-3 audio tracks to subscriber                    │
│  - Dwell debounce prevents flapping (250ms tick, 2 dwell ticks) │
└──────────────────────────────────────────────────────────────────┘
```

---

## Namespace Design (per mocha-meetings draft)

```
Namespace structure:
  /<conference-id>/<participant-id>/video   — video track
  /<conference-id>/<participant-id>/audio   — audio track

Subscribe namespace prefix:
  /<conference-id>/                         — discovers all participant tracks

TrackFilter parameter on SUBSCRIBE_NAMESPACE:
  Video subscription: property_type=0x12, max_selected=N (1 or 2)
  Audio subscription: property_type=0x12, max_selected=3
```

Each publisher announces `/<conference-id>/<participant-id>` and publishes both `video` and `audio` tracks under it. The audio track objects carry SPEECH_ACTIVITY extension headers (value 0=SILENT, 1=SPEAKING, 2=SPEECH_START) which the relay observes to rank active speakers.

---

## Key Protocol Integration: TrackFilter Parameter

The relay's `subscribe_namespace_handler.rs` parses the TrackFilter from the `SUBSCRIBE_NAMESPACE` message parameters:

```
Wire format (MessageParameterType = 0x12):
  value = (property_type << 8) | max_selected
  
Example: top-2 by speech activity
  property_type = 0x12 (SPEECH_ACTIVITY_KEY)
  max_selected = 2
  value = (0x12 << 8) | 0x02 = 0x1202
```

The web session layer already supports `parameters?: Map<number, Uint8Array>` on `SubscribeNamespaceMessage`. We encode the TrackFilter value as a varint into this map.

---

## Implementation Steps

### Phase 1: Protocol Layer — Add TrackFilter Support to `@moq-web/session`

**File: `packages/session/src/session.ts`**

1. Extend `SubscribeNamespaceOptions` (in `types.ts`) with:
   ```typescript
   export interface SubscribeNamespaceOptions {
     priority?: number;
     onObject?: (...) => void;
     /** Top-N track filter: relay selects at most N tracks ranked by propertyType */
     trackFilter?: { propertyType: number; maxSelected: number };
   }
   ```

2. In `subscribeNamespace()`, encode the TrackFilter parameter into the message:
   ```typescript
   const TRACK_FILTER_PARAM = 0x12;
   if (_options?.trackFilter) {
     const { propertyType, maxSelected } = _options.trackFilter;
     const value = (propertyType << 8) | (maxSelected & 0xFF);
     const params = new Map<number, Uint8Array>();
     params.set(TRACK_FILTER_PARAM, encodeVarInt(value));
     message.parameters = params;
   }
   ```

### Phase 2: Media Layer — Speech Activity Extension on Publish

**File: `packages/media/src/pipeline/publish-pipeline.ts`** (or new helper)

The publish pipeline needs to attach the SPEECH_ACTIVITY object extension (key 0x12) to audio objects based on the VAD state:
- 0 = SILENT
- 1 = SPEAKING
- 2 = SPEECH_START (transition from silent → speaking)

The VAD infrastructure already exists (`packages/media/src/vad/`). Wire it so that:
1. Each audio frame is processed through the VAD
2. The resulting speech state is attached as an object extension header (key 0x12) on the outgoing MoQ object

This lets the relay observe the extension and feed its top-N ranker.

### Phase 3: Audio Mixing

Client-side audio mixing of the top-3 audio streams using Web Audio API:

```typescript
class AudioMixer {
  private ctx: AudioContext;
  private destination: MediaStreamAudioDestinationNode;
  private sources: Map<string, MediaStreamAudioSourceNode>;
  
  addStream(participantId: string, stream: MediaStream) { ... }
  removeStream(participantId: string) { ... }
  getOutputElement(): HTMLAudioElement { ... }
}
```

Each decoded audio track (from `SubscribePipeline`) is fed into an `AudioContext` gain node, mixed together, and played through a single `<audio>` element.

### Phase 4: App UI (`apps/meet/`)

**Tech stack**: React 18, Tailwind CSS, Vite (matching existing client app patterns)

**File structure**:
```
apps/meet/
├── index.html
├── package.json
├── vite.config.ts
├── tailwind.config.js
├── postcss.config.js
├── tsconfig.json
├── src/
│   ├── main.tsx                 — React entry
│   ├── App.tsx                  — Root component with room join flow
│   ├── store/
│   │   └── index.ts             — Zustand store (connection, room, participants)
│   ├── components/
│   │   ├── JoinScreen.tsx       — Room ID + display name entry
│   │   ├── MeetingRoom.tsx      — Main meeting view (grid + controls)
│   │   ├── VideoGrid.tsx        — Responsive grid (1 or 2 tiles)
│   │   ├── VideoTile.tsx        — Single participant video + name overlay
│   │   ├── ControlBar.tsx       — Mic/cam toggle, leave, settings
│   │   └── SettingsPanel.tsx    — Top-N selector (1 or 2), relay URL
│   ├── hooks/
│   │   ├── useSession.ts        — Connect/disconnect, session lifecycle
│   │   ├── usePublish.ts        — Publish local camera+mic with VAD
│   │   ├── useSubscribe.ts      — SubscribeNamespace with TrackFilter
│   │   └── useAudioMixer.ts     — Web Audio mixing of decoded audio
│   └── lib/
│       ├── track-filter.ts      — TrackFilter param encoding helper
│       └── constants.ts         — SPEECH_ACTIVITY_KEY, default config
```

**UI Design**:
- Dark theme, rounded corners, subtle shadows
- Center-stage video grid: 1 tile (full width) or 2 tiles (side by side)
- Floating control bar at bottom with pill-shaped buttons
- Active speaker indicator (green ring) based on incoming speech activity
- Minimal chrome — focus on the video content
- Responsive: fills viewport, scales tiles proportionally

---

## Data Flow Summary

### Publishing (local user → relay)

1. `getUserMedia()` → MediaStream (camera + mic)
2. Video → `PublishPipeline` → H.264 encoded → LOC packaged → MoQ objects
3. Audio → `PublishPipeline` → Opus encoded → LOC packaged → MoQ objects
4. Audio also feeds VAD → speech state (0/1/2) → attached as object extension 0x12
5. Objects published to `/<conference-id>/<my-id>/video` and `/<conference-id>/<my-id>/audio`

### Subscribing (relay → local user)

1. `subscribeNamespace(['<conference-id>'], { trackFilter: { propertyType: 0x12, maxSelected: 2 } })`
2. Relay's TopNCoordinator ranks all participants by speech activity
3. Relay pushes PUBLISH messages for top-N video tracks + top-3 audio tracks
4. Client creates `SubscribePipeline` per incoming track → decodes video/audio
5. Video frames rendered to `<canvas>` in VideoTile
6. Audio streams fed into AudioMixer (Web Audio) → single output

### Speaker Switching

1. Participant starts speaking → VAD detects → SPEECH_START (2) extension on audio objects
2. Relay observes extension → ranker updates → next tick, new top-N computed
3. If speaker enters top-N: relay sends PUBLISH for their video to subscriber
4. If speaker exits top-N (after dwell): relay sends PUBLISH_DONE
5. Client sees new incoming-publish → creates new SubscribePipeline
6. Client sees track gone → removes VideoTile from grid
7. Transition time: ~250-500ms (1-2 relay ticks)

---

## What Needs to Be Built vs. What Exists

| Component | Status | Work Needed |
|-----------|--------|-------------|
| MOQTSession + SubscribeNamespace | Exists | Add TrackFilter param encoding |
| PublishPipeline (video + audio) | Exists | Wire VAD → object extension |
| SubscribePipeline (decode) | Exists | Use as-is |
| VAD (libfvad / silero) | Exists | Integrate into publish flow |
| LOC container + extensions | Exists | May need SPEECH_ACTIVITY ext type |
| Object extension on wire | Exists | Verify 0x12 key passes through |
| Audio Mixer | New | ~80 lines, Web Audio API |
| Meet UI app | New | React app, ~600-800 lines total |
| TrackFilter helper | New | ~20 lines, varint encoding |

---

## Configuration Defaults

```typescript
const DEFAULTS = {
  relayUrl: 'https://relay.moq.snandaku.com/moq',
  videoResolution: '720p',      // 1280x720 @ 30fps, 2.5Mbps
  audioConfig: { sampleRate: 48000, channels: 2, bitrate: 128000 },
  topNVideo: 2,                 // Show top-2 active speakers
  topNAudio: 3,                 // Mix top-3 audio streams
  speechActivityKey: 0x12,      // Extension header key for speech activity
  vadProvider: 'libfvad',       // Lightweight VAD
  vadAggressiveness: 2,         // Medium aggressiveness
};
```

---

## Open Questions / Decisions

1. **Separate namespace subscriptions for audio vs video?** — The relay's TrackFilter applies per-namespace-subscription. If we want top-2 video but top-3 audio, we likely need two separate subscribeNamespace calls with different `maxSelected` values, or the relay needs to understand track-type-aware filtering. Alternative: use a single subscription with top-3 and just render the top-2 video tiles (don't render video for the 3rd audio-only participant).

2. **Self-view** — Should we show the local camera preview alongside the remote tiles? Typical conferencing apps show a small self-view PiP. This doesn't come from the relay — just local MediaStream.

3. **Object extension encoding** — The relay expects the SPEECH_ACTIVITY extension as an object-level extension header (key 0x12). Need to verify the web client's object encoding path supports arbitrary extension headers beyond LOCExtensionType.

---

## Next Steps

Once this plan is approved:
1. Add TrackFilter param support to `@moq-web/session`
2. Wire VAD → speech activity object extension in publish flow
3. Scaffold the `apps/meet/` app with UI
4. Implement audio mixer hook
5. Integration test with the relay
