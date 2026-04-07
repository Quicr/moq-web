# Catalog-Driven Media System Design

## Overview

This document outlines the UX design and implementation plan for a catalog-driven media system using MSF (MOQT Streaming Format). The system supports two primary use cases:

1. **VOD/DVR Publishing** - Publisher creates catalog with VOD and live tracks
2. **Video Conferencing** - Shared catalog for dynamic participant management

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    MSF Catalog-Driven Architecture                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                        Catalog Track                             │    │
│  │  namespace/{.catalog}                                            │    │
│  │  - Full catalog (object 0 in each group)                         │    │
│  │  - Delta updates (subsequent objects)                            │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                              │                                           │
│            ┌─────────────────┼─────────────────┐                        │
│            ▼                 ▼                 ▼                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                   │
│  │ Video Track  │  │ Audio Track  │  │ Subtitle     │                   │
│  │ (VOD/Live)   │  │ (VOD/Live)   │  │ Track        │                   │
│  └──────────────┘  └──────────────┘  └──────────────┘                   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Use Case 1: VOD/DVR Publishing

### Publisher Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      CATALOG BUILDER PANEL                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Namespace: [ conference/room-1/media                              ]    │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │ TRACKS                    [+ VOD] [+ Live] [+ Subtitle] [+ Audio] │ │
│  ├────────────────────────────────────────────────────────────────────┤ │
│  │                                                                    │ │
│  │  ┌──────────────────────────────────────────────────────────────┐ │ │
│  │  │ 🎬 VOD: main-video                                    [≡] [✕]│ │ │
│  │  │ ┌────────────────────────────────────────────────────────┐  │ │ │
│  │  │ │ URL: https://example.com/bigbunny.mp4                  │  │ │ │
│  │  │ │ Status: ████████████ 100% Loaded (5:00)                │  │ │ │
│  │  │ │ Codec: H.264 | 1080p@30fps | 4Mbps                     │  │ │ │
│  │  │ │ Experience: [Streaming ▼]  DVR: [✓]  Loop: [ ]         │  │ │ │
│  │  │ └────────────────────────────────────────────────────────┘  │ │ │
│  │  │              [▶ Start Publishing]  [Preview]                │ │ │
│  │  └──────────────────────────────────────────────────────────────┘ │ │
│  │                                                                    │ │
│  │  ┌──────────────────────────────────────────────────────────────┐ │ │
│  │  │ 📹 Live: camera-video                                 [≡] [✕]│ │ │
│  │  │ ┌────────────────────────────────────────────────────────┐  │ │ │
│  │  │ │ Source: [Front Camera ▼]                               │  │ │ │
│  │  │ │ Resolution: [720p ▼]  Framerate: [30 ▼]                │  │ │ │
│  │  │ │ Experience: [Interactive ▼]                            │  │ │ │
│  │  │ └────────────────────────────────────────────────────────┘  │ │ │
│  │  │              [▶ Start Publishing]  [Preview]                │ │ │
│  │  └──────────────────────────────────────────────────────────────┘ │ │
│  │                                                                    │ │
│  │  ┌──────────────────────────────────────────────────────────────┐ │ │
│  │  │ 🎧 Audio: main-audio                                  [≡] [✕]│ │ │
│  │  │ ┌────────────────────────────────────────────────────────┐  │ │ │
│  │  │ │ Source: [Microphone ▼]  Codec: [Opus ▼]                │  │ │ │
│  │  │ │ Channels: [Stereo ▼]  Bitrate: [128kbps ▼]             │  │ │ │
│  │  │ └────────────────────────────────────────────────────────┘  │ │ │
│  │  │              [▶ Start Publishing]                           │ │ │
│  │  └──────────────────────────────────────────────────────────────┘ │ │
│  │                                                                    │ │
│  │  ┌──────────────────────────────────────────────────────────────┐ │ │
│  │  │ 📝 Subtitle: en-subtitles                             [≡] [✕]│ │ │
│  │  │ ┌────────────────────────────────────────────────────────┐  │ │ │
│  │  │ │ Language: [English ▼]  Format: [WebVTT ▼]              │  │ │ │
│  │  │ │ File: [Choose File...] or [Generate from audio]        │  │ │ │
│  │  │ └────────────────────────────────────────────────────────┘  │ │ │
│  │  └──────────────────────────────────────────────────────────────┘ │ │
│  │                                                                    │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌─ CATALOG PREVIEW ──────────────────────────────────────────────────┐ │
│  │ {                                                                  │ │
│  │   "version": 1,                                                    │ │
│  │   "tracks": [                                                      │ │
│  │     { "name": "main-video", "isLive": false, "targetLatency": 500, │ │
│  │       "codec": "avc1.640033", "width": 1920, "height": 1080, ... } │ │
│  │     { "name": "camera-video", "isLive": true, "targetLatency": 50, │ │
│  │       "codec": "avc1.42E01F", "width": 1280, "height": 720, ... }  │ │
│  │     ...                                                            │ │
│  │   ]                                                                │ │
│  │ }                                                                  │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│           [📤 Publish Catalog]  [💾 Save Template]  [📂 Load Template]  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Add Track Modals

#### VOD Track Modal
```
┌─────────────────────────────────────────────────────────────────┐
│ Add VOD Track                                              [✕] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Track Name:    [main-video                                  ] │
│                                                                 │
│  ─── VIDEO SOURCE ───────────────────────────────────────────  │
│  Video URL:     [https://example.com/video.mp4               ] │
│                 [Load Video]                                    │
│                                                                 │
│  Status:        ████████████████ Loading... 45%                │
│                                                                 │
│  ─── DETECTED SETTINGS ──────────────────────────────────────  │
│  Codec:         H.264 (avc1.640033)                            │
│  Resolution:    1920 × 1080                                    │
│  Framerate:     30 fps                                         │
│  Duration:      5:32                                           │
│                                                                 │
│  ─── ENCODING OPTIONS ───────────────────────────────────────  │
│  Output Codec:  [H.264 (avc1) ▼]   Bitrate:  [4 Mbps       ▼] │
│  GOP Size:      [30 frames   ▼]    (1 second)                  │
│                                                                 │
│  ─── EXPERIENCE PROFILE ─────────────────────────────────────  │
│  ○ Interactive   (target: 50ms, aggressive catch-up)           │
│  ● Streaming     (target: 500ms, quality buffering)            │
│  ○ Broadcast     (target: 2000ms, maximum buffer)              │
│                                                                 │
│  ─── DVR OPTIONS ────────────────────────────────────────────  │
│  [✓] Enable DVR (allow seeking/rewind)                         │
│  [ ] Loop playback (repeat when finished)                      │
│                                                                 │
│                         [Cancel]  [Add Track]                   │
└─────────────────────────────────────────────────────────────────┘
```

#### Live Track Modal
```
┌─────────────────────────────────────────────────────────────────┐
│ Add Live Track                                             [✕] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Track Name:    [camera-video                                ] │
│                                                                 │
│  ─── CAPTURE SOURCE ─────────────────────────────────────────  │
│  Device:        [Front Camera                             ▼]  │
│                 [Refresh Devices]                               │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                     [PREVIEW]                           │   │
│  │                                                         │   │
│  │                        📹                               │   │
│  │                                                         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ─── ENCODING OPTIONS ───────────────────────────────────────  │
│  Resolution:    [720p (1280×720)  ▼]                           │
│  Framerate:     [30 fps           ▼]                           │
│  Codec:         [H.264 (avc1)     ▼]                           │
│  Bitrate:       [2 Mbps           ▼]                           │
│                                                                 │
│  ─── EXPERIENCE PROFILE ─────────────────────────────────────  │
│  ● Interactive   (target: 50ms, aggressive catch-up)           │
│  ○ Streaming     (target: 500ms, quality buffering)            │
│  ○ Broadcast     (target: 2000ms, maximum buffer)              │
│                                                                 │
│                         [Cancel]  [Add Track]                   │
└─────────────────────────────────────────────────────────────────┘
```

### Subscriber Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      CATALOG SUBSCRIBER PANEL                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Namespace: [ conference/room-1/media                              ]    │
│                        [Subscribe to Catalog]                            │
│                                                                          │
│  ─── RECEIVED CATALOG ─────────────────────────────────────────────────  │
│  Status: ● Connected    Tracks: 4    Last Update: 2 seconds ago         │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                                                                    │ │
│  │    ┌──────────────────────────────────────────────────────────┐   │ │
│  │    │                                                          │   │ │
│  │    │                   [VIDEO PLAYER]                         │   │ │
│  │    │                                                          │   │ │
│  │    │   ▶ 01:23 ════════════════●═══════════════════ 05:32    │   │ │
│  │    │   [CC]  [🔊]  [⚙️ Quality]                      [VOD]    │   │ │
│  │    │                                                          │   │ │
│  │    │   Subtitles: This is an example subtitle text...         │   │ │
│  │    │                                                          │   │ │
│  │    └──────────────────────────────────────────────────────────┘   │ │
│  │                                                                    │ │
│  │    ─── AVAILABLE TRACKS ─────────────────────────────────────────  │ │
│  │                                                                    │ │
│  │    ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐   │ │
│  │    │ 🎬 main-video   │ │ 📹 camera-video │ │ 🎧 main-audio   │   │ │
│  │    │ VOD • streaming │ │ LIVE • interact │ │ LIVE • interact │   │ │
│  │    │ 1080p@30 • 4Mbps│ │ 720p@30 • 2Mbps │ │ Opus • 128kbps  │   │ │
│  │    │ [Playing ▶]     │ │ [Subscribe]     │ │ [Playing 🔊]    │   │ │
│  │    └─────────────────┘ └─────────────────┘ └─────────────────┘   │ │
│  │                                                                    │ │
│  │    ┌─────────────────┐                                            │ │
│  │    │ 📝 en-subtitles │                                            │ │
│  │    │ Subtitle • EN   │                                            │ │
│  │    │ [On ✓]          │                                            │ │
│  │    └─────────────────┘                                            │ │
│  │                                                                    │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ─── EXPERIENCE PROFILE (auto-selected from catalog) ──────────────────  │
│  Current: Streaming    Target Latency: 500ms    Buffer: 2.3s            │
│  [Override: Custom ▼]                                                    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Use Case 2: Video Conferencing

### Room Catalog Structure

For video conferencing, the catalog describes the room and all participants:

```json
{
  "version": 1,
  "generatedAt": 1712505600000,
  "isComplete": true,
  "tracks": [
    {
      "name": "alice/video",
      "isLive": true,
      "codec": "avc1.42E01F",
      "width": 1280,
      "height": 720,
      "framerate": 30,
      "targetLatency": 50,
      "renderGroup": 1,
      "label": "Alice's Camera"
    },
    {
      "name": "alice/audio",
      "isLive": true,
      "codec": "opus",
      "samplerate": 48000,
      "channelConfig": "mono",
      "targetLatency": 50,
      "renderGroup": 1,
      "label": "Alice's Microphone"
    },
    {
      "name": "bob/video",
      "isLive": true,
      ...
    },
    {
      "name": "bob/audio",
      ...
    }
  ]
}
```

### Conferencing UI

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Room: conference/meeting-123                    Participants: 4          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐        │
│  │    [Alice]       │ │     [Bob]        │ │    [Carol]       │        │
│  │   ┌────────┐     │ │   ┌────────┐     │ │   ┌────────┐     │        │
│  │   │ VIDEO  │     │ │   │ VIDEO  │     │ │   │ VIDEO  │     │        │
│  │   │        │     │ │   │        │     │ │   │        │     │        │
│  │   └────────┘     │ │   └────────┘     │ │   └────────┘     │        │
│  │   🎤 Speaking    │ │   🔇 Muted       │ │   🎤 Speaking    │        │
│  └──────────────────┘ └──────────────────┘ └──────────────────┘        │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                            [YOU]                                  │   │
│  │   ┌─────────────────────────────────────────────────────────┐    │   │
│  │   │                      YOUR VIDEO                          │    │   │
│  │   │                                                          │    │   │
│  │   └─────────────────────────────────────────────────────────┘    │   │
│  │                                                                   │   │
│  │   [🎤 Mute]  [📹 Camera Off]  [🖥️ Share Screen]  [🚪 Leave]      │   │
│  │                                                                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ─── Room Catalog ──────────────────────────────────────────────────────  │
│  Tracks: 8 (4 video, 4 audio)    Last Update: just now                   │
│  [View Raw Catalog]                                                      │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Delta Updates for Participant Join/Leave

When participants join or leave, delta catalogs are sent:

**Join (add tracks):**
```json
{
  "version": 1,
  "deltaUpdate": true,
  "addTracks": [
    { "name": "dave/video", "isLive": true, ... },
    { "name": "dave/audio", "isLive": true, ... }
  ]
}
```

**Leave (remove tracks):**
```json
{
  "version": 1,
  "deltaUpdate": true,
  "removeTracks": ["carol/video", "carol/audio"]
}
```

## Component Architecture

### New Components

```
packages/client/src/components/
├── catalog/
│   ├── CatalogBuilderPanel.tsx      # Publisher catalog builder
│   ├── CatalogSubscriberPanel.tsx   # Subscriber catalog display
│   ├── CatalogPreview.tsx           # JSON preview with syntax highlight
│   ├── TrackCard.tsx                # Track display card
│   ├── TrackEditor.tsx              # Track configuration editor
│   ├── VODTrackEditor.tsx           # VOD-specific editor
│   ├── LiveTrackEditor.tsx          # Live capture editor
│   ├── AudioTrackEditor.tsx         # Audio track editor
│   ├── SubtitleTrackEditor.tsx      # Subtitle track editor
│   ├── ExperienceProfileSelector.tsx # Profile picker with descriptions
│   └── AddTrackModal.tsx            # Modal for adding tracks
├── player/
│   ├── CatalogDrivenPlayer.tsx      # Main player component
│   ├── TrackSelector.tsx            # Track switching UI
│   ├── SubtitleOverlay.tsx          # Subtitle rendering
│   └── QualitySelector.tsx          # ABR quality picker
└── conference/
    ├── ConferenceRoom.tsx           # Main conference view
    ├── ParticipantGrid.tsx          # Video grid layout
    ├── ParticipantTile.tsx          # Single participant view
    └── RoomCatalogManager.tsx       # Catalog updates for room
```

### Store Extensions

```typescript
// packages/client/src/store/catalog-slice.ts

interface CatalogSlice {
  // Publisher state
  catalogTracks: CatalogTrackConfig[];
  publishedCatalog: FullCatalog | null;
  catalogPublishStatus: 'idle' | 'publishing' | 'published';
  
  // Subscriber state
  receivedCatalog: FullCatalog | null;
  subscribedTrackAliases: Map<string, number>;
  autoApplyExperienceProfile: boolean;
  
  // Actions
  addCatalogTrack: (config: CatalogTrackConfig) => void;
  removeCatalogTrack: (trackName: string) => void;
  updateCatalogTrack: (trackName: string, updates: Partial<CatalogTrackConfig>) => void;
  buildAndPublishCatalog: (namespace: string) => Promise<void>;
  subscribeToCatalog: (namespace: string) => Promise<void>;
  subscribeToTrack: (trackName: string) => Promise<number>;
  
  // Experience profile
  getExperienceProfileForTrack: (track: Track) => ExperienceProfileName;
}

interface CatalogTrackConfig {
  id: string;
  type: 'vod' | 'live' | 'audio' | 'subtitle';
  name: string;
  
  // VOD-specific
  videoUrl?: string;
  vodMetadata?: VODMetadata;
  loaderProgress?: VODLoadProgress;
  enableDvr?: boolean;
  loopPlayback?: boolean;
  
  // Live-specific
  deviceId?: string;
  resolution?: '720p' | '1080p' | '480p';
  framerate?: number;
  
  // Audio-specific
  audioDeviceId?: string;
  codec?: string;
  channelConfig?: 'mono' | 'stereo';
  
  // Subtitle-specific
  language?: string;
  subtitleFormat?: 'webvtt' | 'srt';
  subtitleFile?: File;
  
  // Common
  bitrate?: number;
  experienceProfile: ExperienceProfileName;
  publishStatus: 'idle' | 'loading' | 'ready' | 'publishing' | 'error';
  error?: string;
}
```

## Experience Profile Auto-Assignment

The system automatically selects experience profiles based on catalog hints:

```typescript
function getExperienceProfileForTrack(track: Track): ExperienceProfileName {
  // Use explicit targetLatency from catalog
  if (track.targetLatency !== undefined) {
    if (track.targetLatency <= 100) return 'interactive';
    if (track.targetLatency <= 1000) return 'streaming';
    return 'broadcast';
  }
  
  // Infer from isLive flag
  if (track.isLive) {
    return 'interactive'; // Low latency for live
  }
  
  // VOD content gets streaming profile
  return 'streaming';
}
```

## Subtitle Support

### Track Definition
```json
{
  "name": "en-subtitles",
  "packaging": "eventtimeline",
  "isLive": false,
  "role": "subtitle",
  "lang": "en",
  "mimeType": "text/vtt",
  "label": "English Subtitles"
}
```

### Subtitle Events (EventTimeline)
```json
{
  "startTime": 1000,
  "duration": 3000,
  "data": "This is the subtitle text for this segment."
}
```

### SubtitleOverlay Component
```tsx
interface SubtitleOverlayProps {
  subscriptionId: number;
  enabled: boolean;
  style?: 'default' | 'large' | 'high-contrast';
}

const SubtitleOverlay: React.FC<SubtitleOverlayProps> = ({
  subscriptionId,
  enabled,
  style = 'default',
}) => {
  const [currentSubtitle, setCurrentSubtitle] = useState<string | null>(null);
  
  // Listen for subtitle events from the track
  useEffect(() => {
    if (!enabled) return;
    // Subscribe to subtitle track data...
  }, [subscriptionId, enabled]);
  
  return currentSubtitle ? (
    <div className={`subtitle-overlay subtitle-${style}`}>
      {currentSubtitle}
    </div>
  ) : null;
};
```

## Implementation Phases

### Phase 1: Catalog Builder Foundation
- [ ] Create CatalogBuilderPanel component
- [ ] Implement TrackCard component
- [ ] Add VODTrackEditor with video URL loading
- [ ] Add LiveTrackEditor with device selection
- [ ] Integrate with existing VODLoader
- [ ] Add catalog store slice

### Phase 2: Catalog Publishing
- [ ] Integrate MSF CatalogPublisher
- [ ] Build catalog from track configs
- [ ] Publish catalog track
- [ ] Start media tracks based on catalog
- [ ] Handle track status updates

### Phase 3: Catalog Subscription
- [ ] Create CatalogSubscriberPanel
- [ ] Integrate MSF CatalogSubscriber
- [ ] Parse and display received catalogs
- [ ] Auto-subscribe to tracks
- [ ] Apply experience profiles from catalog

### Phase 4: Enhanced Player
- [ ] Create CatalogDrivenPlayer
- [ ] Implement TrackSelector
- [ ] Add DVR controls for VOD tracks
- [ ] Show track metadata (codec, resolution)
- [ ] Handle track switching

### Phase 5: Subtitle Support
- [ ] Add SubtitleTrackEditor
- [ ] Implement EventTimeline parsing
- [ ] Create SubtitleOverlay component
- [ ] Add subtitle toggle in player
- [ ] Support multiple languages

### Phase 6: Video Conferencing
- [ ] Create ConferenceRoom component
- [ ] Implement ParticipantGrid layout
- [ ] Handle catalog delta updates
- [ ] Add participant join/leave animations
- [ ] Sync render groups

## Data Flow Diagrams

### Publisher Flow
```
User Input → CatalogBuilderPanel → CatalogTrackConfig[]
                                         │
                    ┌────────────────────┴────────────────────┐
                    │                                         │
              VODLoader.load()                        getUserMedia()
                    │                                         │
                    ▼                                         ▼
              VOD frames ready                         Live stream ready
                    │                                         │
                    └────────────────────┬────────────────────┘
                                         │
                                         ▼
                              CatalogBuilder.build()
                                         │
                                         ▼
                              CatalogPublisher.publishFull()
                                         │
                                         ▼
                              Start media track publishing
```

### Subscriber Flow
```
CatalogSubscriber.subscribe() → Receive Full Catalog
                                        │
                                        ▼
                               Parse tracks from catalog
                                        │
                    ┌───────────────────┼───────────────────┐
                    │                   │                   │
                    ▼                   ▼                   ▼
             Video tracks        Audio tracks       Subtitle tracks
                    │                   │                   │
                    ▼                   ▼                   ▼
           Subscribe +           Subscribe +         Subscribe +
           decode pipeline       decode pipeline     event parser
                    │                   │                   │
                    └───────────────────┼───────────────────┘
                                        │
                                        ▼
                              Apply experience profiles
                                        │
                                        ▼
                              Render in CatalogDrivenPlayer
```

## API Reference

### MSF Integration Points

```typescript
import {
  createCatalog,
  createMSFSession,
  type FullCatalog,
  type Track,
} from '@web-moq/msf';

// Build catalog
const catalog = createCatalog()
  .generatedAt()
  .addVideoTrack({
    name: 'main-video',
    codec: 'avc1.640033',
    width: 1920,
    height: 1080,
    framerate: 30,
    bitrate: 4_000_000,
    isLive: false, // VOD
    targetLatency: 500, // streaming profile
  })
  .addAudioTrack({
    name: 'main-audio',
    codec: 'opus',
    samplerate: 48000,
    channelConfig: 'stereo',
    isLive: false,
  })
  .addDataTrack({
    name: 'en-subtitles',
    packaging: 'eventtimeline',
    isLive: false,
    mimeType: 'text/vtt',
    role: 'subtitle',
  })
  .build();

// Publish via MSF session
const msfSession = createMSFSession(moqtSession, namespace);
await msfSession.startCatalogPublishing();
await msfSession.publishCatalog(catalog);
```
