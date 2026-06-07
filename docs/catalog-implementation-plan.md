# Catalog-Driven Media System - Implementation Plan

## Overview

Build a comprehensive catalog-driven media system using MSF (MOQT Streaming Format) that supports:
- VOD publishing with DVR/seeking
- Live streaming
- Video conferencing (shared room template)
- Multi-quality ABR publishing
- Subtitles
- Media timeline for seeking

## MSF Catalog Structure (per spec)

### VOD Catalog Example
```json
{
  "version": 1,
  "generatedAt": 1712505600000,
  "isComplete": true,
  "tracks": [
    {
      "name": "video-1080p",
      "packaging": "loc",
      "isLive": false,
      "trackDuration": 332000,
      "codec": "avc1.640033",
      "width": 1920,
      "height": 1080,
      "framerate": 30,
      "bitrate": 4000000,
      "renderGroup": 1,
      "altGroup": 1,
      "role": "main"
    },
    {
      "name": "video-720p",
      "packaging": "loc",
      "isLive": false,
      "trackDuration": 332000,
      "codec": "avc1.42E01F",
      "width": 1280,
      "height": 720,
      "framerate": 30,
      "bitrate": 2000000,
      "renderGroup": 1,
      "altGroup": 1,
      "role": "alternate"
    },
    {
      "name": "audio",
      "packaging": "loc",
      "isLive": false,
      "trackDuration": 332000,
      "codec": "opus",
      "samplerate": 48000,
      "channelConfig": "stereo",
      "bitrate": 128000,
      "renderGroup": 1
    },
    {
      "name": "timeline",
      "packaging": "mediatimeline",
      "isLive": false,
      "trackDuration": 332000,
      "timescale": 1000
    },
    {
      "name": "en-subtitles",
      "packaging": "loc",
      "isLive": false,
      "role": "subtitle",
      "lang": "en"
    }
  ]
}
```

### Live Streaming Catalog Example
```json
{
  "version": 1,
  "generatedAt": 1712505600000,
  "tracks": [
    {
      "name": "video",
      "packaging": "loc",
      "isLive": true,
      "targetLatency": 50,
      "codec": "avc1.42E01F",
      "width": 1280,
      "height": 720,
      "framerate": 30,
      "bitrate": 2000000,
      "renderGroup": 1
    },
    {
      "name": "audio",
      "packaging": "loc",
      "isLive": true,
      "targetLatency": 50,
      "codec": "opus",
      "samplerate": 48000,
      "channelConfig": "mono",
      "bitrate": 64000,
      "renderGroup": 1
    }
  ]
}
```

### Video Conferencing (Room Template) Catalog
```json
{
  "version": 1,
  "generatedAt": 1712505600000,
  "tracks": [
    {
      "name": "video",
      "packaging": "loc",
      "isLive": true,
      "targetLatency": 50,
      "codec": "avc1.42E01F",
      "width": 1280,
      "height": 720,
      "framerate": 30,
      "bitrate": 2000000
    },
    {
      "name": "audio",
      "packaging": "loc",
      "isLive": true,
      "targetLatency": 50,
      "codec": "opus",
      "samplerate": 48000,
      "channelConfig": "mono",
      "bitrate": 64000
    }
  ]
}
```

---

## Phase 1: Core Types & Components

### Goal
Establish foundation types and basic UI components for catalog building.

### Tasks
- [x] Define `CatalogTrackConfig` types for all track types
- [x] Add `altGroup`, `renderGroup`, `label` support for ABR
- [x] Create `TrackCard` component for displaying tracks
- [ ] Create `AddTrackModal` component with forms for each track type
- [ ] Create `ExperienceProfileSelector` component
- [ ] Add track type icons and badges

### Files
```
packages/client/src/components/catalog/
├── types.ts                    [x] Done
├── TrackCard.tsx               [x] Done
├── AddTrackModal.tsx           [ ] TODO
├── ExperienceProfileSelector.tsx [ ] TODO
└── index.ts                    [ ] TODO
```

---

## Phase 2: Catalog Builder Panel

### Goal
Complete UI for building catalogs with all track types.

### Tasks
- [x] Create `CatalogBuilderPanel` component
- [ ] Implement VOD track editor (URL input, video loading)
- [ ] Implement Live track editor (device selection, preview)
- [ ] Implement Audio track editor
- [ ] Implement Subtitle track editor
- [ ] Implement Timeline track editor
- [ ] Add catalog JSON preview
- [ ] Integrate with existing `VODLoader`

### VOD Track Editor Features
- Video URL input with load button
- Auto-detect codec, resolution, framerate, duration
- Progress indicator during video loading
- DVR toggle (enable seeking)
- Loop playback toggle
- Experience profile selector
- altGroup assignment for multi-quality

### Live Track Editor Features
- Device selector (camera dropdown)
- Live preview
- Resolution/framerate/bitrate config
- Experience profile (default: interactive)
- renderGroup assignment

### Files
```
packages/client/src/components/catalog/
├── CatalogBuilderPanel.tsx     [x] Started
├── VODTrackEditor.tsx          [ ] TODO
├── LiveTrackEditor.tsx         [ ] TODO
├── AudioTrackEditor.tsx        [ ] TODO
├── SubtitleTrackEditor.tsx     [ ] TODO
└── TimelineTrackEditor.tsx     [ ] TODO
```

---

## Phase 3: Store Integration

### Goal
Add catalog state management to the Zustand store.

### Tasks
- [ ] Create `CatalogSlice` in store
- [ ] Track publishing state per track
- [ ] VOD loader integration (progress tracking)
- [ ] Persist catalog templates to localStorage
- [ ] Add catalog publish/unpublish actions

### Store Shape
```typescript
interface CatalogSlice {
  // Builder state
  catalogNamespace: string;
  catalogTracks: CatalogTrackConfig[];
  
  // Publishing state
  publishedCatalog: FullCatalog | null;
  catalogPublishStatus: 'idle' | 'publishing' | 'published';
  
  // VOD loaders (keyed by track ID)
  vodLoaders: Map<string, VODLoader>;
  
  // Actions
  addCatalogTrack: (type: CatalogTrackType) => string;
  updateCatalogTrack: (id: string, updates: Partial<CatalogTrackConfig>) => void;
  removeCatalogTrack: (id: string) => void;
  loadVODTrack: (id: string, url: string) => Promise<void>;
  publishCatalog: () => Promise<void>;
  startTrackPublishing: (id: string) => Promise<void>;
  stopTrackPublishing: (id: string) => Promise<void>;
}
```

---

## Phase 4: MSF Publishing Integration

### Goal
Wire up catalog building to actual MSF publishing.

### Tasks
- [ ] Integrate `MSFSession` from `@web-moq/msf`
- [ ] Publish catalog track on namespace
- [ ] Start media track publishing based on catalog
- [ ] Handle VOD frame serving via FETCH
- [ ] Handle live camera/mic capture
- [ ] Support altGroup track switching (ABR)

### Flow
```
User clicks "Publish Catalog"
    │
    ├── Build FullCatalog from track configs
    │
    ├── Create MSFSession with namespace
    │
    ├── Publish catalog track (.catalog)
    │
    └── For each track in catalog:
        ├── VOD: Start VODPublisher with loaded frames
        ├── Live: Start MediaSession.publish with camera
        └── Audio: Start audio capture and publish
```

---

## Phase 5: Catalog Subscriber

### Goal
Build UI that reacts to received catalogs.

### Tasks
- [ ] Create `CatalogSubscriberPanel` component
- [ ] Subscribe to catalog track
- [ ] Parse and display received catalog
- [ ] Auto-subscribe to tracks based on catalog
- [ ] Apply experience profiles from `targetLatency`
- [ ] Show track quality options (altGroup variants)

### Subscriber Features
- Catalog status indicator
- Track list with metadata
- Track subscription toggles
- Quality selector for altGroup tracks
- Experience profile badges (auto-detected)

### Files
```
packages/client/src/components/catalog/
├── CatalogSubscriberPanel.tsx  [ ] TODO
├── ReceivedCatalogView.tsx     [ ] TODO
└── TrackSubscriptionCard.tsx   [ ] TODO
```

---

## Phase 6: Enhanced VOD Player

### Goal
Full DVR controls for VOD content.

### Tasks
- [x] Create `VODVideoPlayer` component with controls
- [x] Add seek bar with progress
- [x] Add play/pause controls
- [x] Add time display
- [ ] Wire up to media timeline track
- [ ] Implement seeking via FETCH
- [ ] Show buffered ranges
- [ ] Add playback speed control

### Already Done
- `VODVideoPlayer.tsx` created
- Basic play/pause, seek, time display
- VOD/LIVE badge indicator

### Remaining
- Media timeline integration for accurate seeking
- Buffered range visualization
- Keyboard shortcuts (space, arrows)

---

## Phase 7: Subtitle Support

### Goal
Display subtitles over video.

### Tasks
- [ ] Create `SubtitleOverlay` component
- [ ] Subscribe to subtitle track
- [ ] Parse WebVTT/SRT format
- [ ] Sync subtitles with video playback
- [ ] Add subtitle toggle in player
- [ ] Support multiple languages
- [ ] Style options (size, background, position)

### Subtitle Track Flow
```
Catalog contains subtitle track
    │
    ├── Subscriber auto-subscribes to subtitle track
    │
    ├── Receive subtitle cues as objects
    │
    ├── Parse WebVTT timing/text
    │
    └── Render in SubtitleOverlay synced to video time
```

---

## Phase 8: Video Conferencing Mode

### Goal
Shared catalog for multi-participant conferencing.

### Tasks
- [ ] Create `ConferenceRoom` component
- [ ] Room template catalog (defines track types)
- [ ] Participants publish on their namespace
- [ ] Subscribe to room namespace prefix
- [ ] Handle participant join/leave
- [ ] Grid layout for multiple videos
- [ ] Local controls (mute, camera toggle)

### Conferencing Flow
```
Room Catalog (template):
  - video track spec (codec, resolution, latency)
  - audio track spec

Participant joins:
  1. Subscribe to room namespace prefix
  2. Subscribe to room catalog track
  3. Read catalog template
  4. Start publishing on {room}/{participant-id}/video
  5. Start publishing on {room}/{participant-id}/audio
  6. Discover other participants via namespace subscription
```

---

## Phase 9: ABR Quality Switching

### Goal
Support adaptive bitrate with altGroup tracks.

### Tasks
- [ ] Detect tracks with same altGroup
- [ ] Create quality selector UI
- [ ] Implement track switching logic
- [ ] Smooth switching without glitches
- [ ] Auto quality based on bandwidth

### altGroup Usage
```json
{
  "tracks": [
    { "name": "video-1080p", "altGroup": 1, "bitrate": 4000000 },
    { "name": "video-720p", "altGroup": 1, "bitrate": 2000000 },
    { "name": "video-480p", "altGroup": 1, "bitrate": 1000000 }
  ]
}
```

Subscriber can switch between tracks in the same altGroup.

---

## File Structure Summary

```
packages/client/src/components/
├── catalog/
│   ├── types.ts                      [x] Phase 1
│   ├── TrackCard.tsx                 [x] Phase 1
│   ├── AddTrackModal.tsx             [ ] Phase 1
│   ├── ExperienceProfileSelector.tsx [ ] Phase 1
│   ├── CatalogBuilderPanel.tsx       [x] Phase 2
│   ├── VODTrackEditor.tsx            [ ] Phase 2
│   ├── LiveTrackEditor.tsx           [ ] Phase 2
│   ├── AudioTrackEditor.tsx          [ ] Phase 2
│   ├── SubtitleTrackEditor.tsx       [ ] Phase 2
│   ├── TimelineTrackEditor.tsx       [ ] Phase 2
│   ├── CatalogSubscriberPanel.tsx    [ ] Phase 5
│   ├── ReceivedCatalogView.tsx       [ ] Phase 5
│   ├── TrackSubscriptionCard.tsx     [ ] Phase 5
│   └── index.ts
├── player/
│   ├── VODVideoPlayer.tsx            [x] Done
│   ├── SubtitleOverlay.tsx           [ ] Phase 7
│   └── QualitySelector.tsx           [ ] Phase 9
└── conference/
    ├── ConferenceRoom.tsx            [ ] Phase 8
    ├── ParticipantGrid.tsx           [ ] Phase 8
    └── ParticipantTile.tsx           [ ] Phase 8

packages/client/src/store/
└── catalog-slice.ts                  [ ] Phase 3
```

---

## Dependencies

### Existing (already available)
- `@web-moq/msf` - Full MSF catalog support
  - `createCatalog()` - Builder API
  - `CatalogPublisher` / `CatalogSubscriber`
  - `MSFSession` - High-level wrapper
  - Media timeline support
- `@web-moq/media` - VODLoader, experience profiles
- `@web-moq/session` - MOQT session, FETCH support

### To Verify
- [ ] MSFSession.subscribe with object callback
- [ ] Media timeline encoding/decoding
- [ ] Subtitle format parsing (WebVTT)

---

## Success Criteria

### Phase 1-2: Basic Catalog Building
- [ ] Can add/edit/remove tracks of all types
- [ ] Catalog JSON preview shows valid MSF format
- [ ] Experience profiles selectable per track

### Phase 3-4: Publishing Works
- [ ] Catalog published to relay
- [ ] VOD video serves frames via FETCH
- [ ] Live video captures and publishes

### Phase 5-6: Subscribing Works
- [ ] Subscriber receives catalog
- [ ] Auto-subscribes to tracks
- [ ] VOD player shows with DVR controls
- [ ] Seeking works via FETCH

### Phase 7: Subtitles Work
- [ ] Subtitle track publishes
- [ ] Subscriber displays subtitles
- [ ] Subtitles synced with video

### Phase 8: Conferencing Works
- [ ] Multiple participants can join
- [ ] Each sees others' video/audio
- [ ] Participant join/leave updates grid

### Phase 9: ABR Works
- [ ] Quality selector shows variants
- [ ] Can switch quality smoothly
