# Testing VOD, Subtitles, and Timeline (Phase 6 & 7)

This guide provides comprehensive steps to verify and test the catalog-driven VOD publishing system with subtitle support and media timeline for accurate seeking.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Testing Workflow](#testing-workflow)
  - [Step 1: Connect to Relay](#step-1-connect-to-relay)
  - [Step 2: Publish VOD Catalog](#step-2-publish-vod-catalog)
  - [Step 3: Subscribe to Catalog](#step-3-subscribe-to-catalog)
  - [Step 4: Test VOD Player Features](#step-4-test-vod-player-features)
  - [Step 5: Test Multi-Language Subtitles](#step-5-test-multi-language-subtitles)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Troubleshooting](#troubleshooting)
- [Verification Checklist](#verification-checklist)

---

## Prerequisites

### Required Software

- Node.js 20+
- pnpm 9+ (`corepack enable && corepack prepare pnpm@9 --activate`)
- A MOQT relay server (e.g., [moq-rs](https://github.com/kixelated/moq-rs))
- Chrome browser (for WebTransport support)

### Test Assets

You'll need:
- A CORS-enabled video URL (MP4 or WebM)
- Subtitle content in WebVTT or SRT format

**Sample Video URLs:**
```
https://test-streams.mux.dev/x36xhzz/x36xhzz.mp4
https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4
```

---

## Setup

### 1. Install Dependencies

```bash
cd /path/to/moq-web
pnpm install
```

### 2. Generate Certificates

For local development with WebTransport, generate self-signed certificates:

```bash
./scripts/create_server_cert.sh
```

This creates:
- `certs/certificate.pem` - Self-signed certificate
- `certs/certificate.key` - Private key
- `certs/certificate_fingerprint.hex` - SHA-256 fingerprint

The fingerprint is automatically copied to `packages/client/public/`.

> **Note:** Certificates expire after 14 days. Regenerate if you see connection errors.

### 3. Start the MOQT Relay Server

#### Option A: Using moq-rs (Recommended)

```bash
# Clone and build moq-rs
git clone https://github.com/kixelated/moq-rs
cd moq-rs
cargo build --release

# Run with certificates from moq-web
./target/release/moq-relay \
  --cert /path/to/moq-web/certs/certificate.pem \
  --key /path/to/moq-web/certs/certificate.key \
  --bind 0.0.0.0:4443
```

#### Option B: Using Docker

If moq-rs provides a Docker image:
```bash
docker run -p 4443:4443 \
  -v /path/to/moq-web/certs:/certs \
  moq-relay --cert /certs/certificate.pem --key /certs/certificate.key
```

### 4. Build and Start the Client

```bash
# Build all packages
pnpm run build

# Start development server
pnpm run dev
```

The client will be available at https://localhost:5173

---

## Testing Workflow

### Step 1: Connect to Relay

1. Open Chrome and navigate to https://localhost:5173
2. Accept any certificate warnings for localhost

3. Configure connection settings:
   - Click the **Settings** icon (gear)
   - Enable **"Local Development"** (for self-signed certificates)
   - Set **Server URL** to: `https://localhost:4443/moq`

4. Click **Connect**

5. Verify connection status:
   - Transport state: "Connected"
   - Session state: "Ready"

---

### Step 2: Publish VOD Catalog

1. Navigate to the **Catalog** panel/tab
2. Select **"Build & Publish Catalog"** mode
3. Set the catalog namespace (e.g., `vod/demo/media`)

#### Add a VOD Video Track

1. Click **"Add Track"**
2. Select **"VOD Video"** as track type
3. Configure the track:

   | Field | Value |
   |-------|-------|
   | Track Name | `video` |
   | Video URL | `https://test-streams.mux.dev/x36xhzz/x36xhzz.mp4` |
   | Enable DVR | Checked |
   | Loop Playback | Optional |

4. Click **"Load Info"** to probe video metadata
5. Verify detected values:
   - Resolution (e.g., 1280x720)
   - Duration (e.g., 5:32)
6. Click **"Add Track"**

#### Add a Subtitle Track

1. Click **"Add Track"**
2. Select **"Subtitle"** as track type
3. Configure the track:

   | Field | Value |
   |-------|-------|
   | Track Name | `en-subtitles` |
   | Language Code | `en` |
   | Display Label | `English` |
   | Format | WebVTT |

4. Add subtitle content (paste or load from URL):

   ```
   WEBVTT

   00:00:01.000 --> 00:00:04.000
   Welcome to the VOD demo!

   00:00:05.000 --> 00:00:08.000
   This tests subtitle publishing and display.

   00:00:10.000 --> 00:00:15.000
   Try seeking - timeline data enables accurate positioning.

   00:00:20.000 --> 00:00:25.000
   Press 'C' to toggle subtitles on and off.
   ```

5. Click **"Add Track"**

#### Add a Timeline Track

1. Click **"Add Track"**
2. Select **"Media Timeline"** as track type
3. Keep default settings:

   | Field | Value |
   |-------|-------|
   | Track Name | `timeline` |
   | Timescale | 1000 (milliseconds) |

4. Click **"Add Track"**

#### Publish the Catalog

1. Review all tracks in the catalog builder
2. Click **"Publish Catalog"**
3. Monitor the browser console for publishing logs:

   ```
   [CatalogPanel] Publishing catalog: {tracks: 3, ...}
   [CatalogPanel] Loading VOD: https://...
   [CatalogPanel] VOD loaded: {duration: 332000, frames: 9960}
   [CatalogPanel] Catalog track started
   [CatalogPanel] Catalog published to: vod/demo/media
   [CatalogPanel] Publishing VOD track: video
   [CatalogPanel] VOD track published: {name: "video", trackAlias: "1"}
   [CatalogPanel] Publishing subtitle track: en-subtitles
   [CatalogPanel] Subtitle track published: {name: "en-subtitles", size: 285}
   [CatalogPanel] Publishing timeline track: timeline
   [CatalogPanel] Timeline track published: {entries: 333, duration: 332000}
   ```

4. Verify status banner shows **"Catalog Published"** with track count

---

### Step 3: Subscribe to Catalog

Open a **new browser tab** for the subscriber (or use a second browser):

1. Navigate to https://localhost:5173
2. Connect to the relay (same settings as publisher)
3. Go to the **Catalog** panel
4. Select **"Subscribe to Catalog"** mode
5. Enter the same namespace: `vod/demo/media`
6. Click **"Subscribe"**

#### Verify Catalog Reception

The panel should display:
- **"Catalog Received"** status with generation timestamp
- List of tracks with metadata badges:
  - Video track: codec, resolution, framerate, bitrate, "VOD" badge
  - Subtitle track: language code, format
  - Timeline track: timescale

#### Subscribe to Individual Tracks

1. **Video Track**: Click **"Subscribe"**
   - Video player should appear
   - Playback begins automatically

2. **Subtitle Track**: 
   - Click **"Subscribe"** to load subtitles
   - Click **"Use"** to activate (button turns green, shows "Active")

3. **Timeline Track**: Click **"Load"**
   - Console shows: `[CatalogSubscriber] Parsed timeline: {...}`
   - Player shows orange **"TL"** badge

#### Console Verification

```
[CatalogSubscriber] Received catalog: {tracks: 3, isIndependent: true}
[CatalogSubscriber] Subscribed to track: video
[CatalogSubscriber] Received subtitle data: {trackName: "en-subtitles", size: 285}
[CatalogSubscriber] Parsed subtitle cues: {trackName: "en-subtitles", cueCount: 4}
[CatalogSubscriber] Received timeline data: {trackName: "timeline", size: 12500}
[CatalogSubscriber] Parsed timeline: {duration: 332000, entries: 333, framerate: 30}
```

---

### Step 4: Test VOD Player Features

Once subscribed, the VODVideoPlayer displays with full controls.

#### Visual Indicators

| Indicator | Meaning |
|-----------|---------|
| Purple **"VOD"** badge | Video-on-demand content |
| Orange **"TL"** badge | Timeline data loaded for accurate seeking |
| Blue subtitle button | Subtitles available |
| Highlighted subtitle button | Subtitles currently active |

#### Basic Playback Controls

- **Play/Pause**: Center overlay button or bottom control bar
- **Seek**: Drag the progress bar slider
- **Time Display**: Shows `current / total` (e.g., `1:23 / 5:32`)

#### Playback Speed

1. Click the speed button (shows current speed, e.g., "1x")
2. Select from: 0.5x, 0.75x, 1x, 1.25x, 1.5x, 2x
3. Playback adjusts immediately

#### Subtitle Display

- Subtitles appear as text overlay at bottom of video
- Synced to video playback time
- Toggle with subtitle button or `C` key

#### Seeking with Timeline

When timeline is loaded:
1. Seek to any position using the progress bar
2. Console logs accurate position:
   ```
   [VODVideoPlayer] Seeking with timeline: {timeMs: 65000, groupId: 65, objectId: 0}
   ```
3. Video resumes from exact position

#### Fullscreen Mode

- Click fullscreen button (expand icon)
- Or press `F` key
- All controls remain functional in fullscreen

---

### Step 5: Test Multi-Language Subtitles

#### Add Additional Subtitle Track (Publisher)

1. In the publisher tab, click **"Add Track"** → **"Subtitle"**
2. Configure Spanish subtitles:

   | Field | Value |
   |-------|-------|
   | Track Name | `es-subtitles` |
   | Language Code | `es` |
   | Display Label | `Spanish` |

3. Add Spanish content:

   ```
   WEBVTT

   00:00:01.000 --> 00:00:04.000
   ¡Bienvenido a la demo de VOD!

   00:00:05.000 --> 00:00:08.000
   Esto prueba la publicación de subtítulos.

   00:00:10.000 --> 00:00:15.000
   Intenta buscar - los datos de la línea de tiempo permiten una posición precisa.

   00:00:20.000 --> 00:00:25.000
   Presiona 'C' para activar o desactivar los subtítulos.
   ```

4. Re-publish the catalog

#### Switch Languages (Subscriber)

1. Refresh or re-subscribe to the catalog
2. Subscribe to both subtitle tracks
3. Use the **"Use"** / **"Active"** button to switch:
   - Active track shows green button with "Active" label
   - Inactive subscribed tracks show "Use" button
4. Subtitles update immediately when switching

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` or `K` | Play / Pause |
| `J` or `←` | Rewind 10 seconds |
| `L` or `→` | Forward 10 seconds |
| `Home` | Jump to beginning |
| `End` | Jump to end |
| `F` | Toggle fullscreen |
| `C` | Toggle subtitles |
| `Shift` + `<` | Decrease playback speed |
| `Shift` + `>` | Increase playback speed |

> **Note:** Keyboard shortcuts only work when no input field is focused.

---

## Troubleshooting

### Connection Issues

**Problem:** Cannot connect to relay
- Verify relay server is running on correct port
- Check "Local Development" is enabled in settings
- Regenerate certificates if expired (14-day maximum validity)
- Ensure server URL matches relay address

**Problem:** `ERR_QUIC_HANDSHAKE_FAILED`
- Certificate expired - run `./scripts/create_server_cert.sh`
- Ensure certificate fingerprint is copied to `packages/client/public/`

### Video Issues

**Problem:** Video URL fails to load
- Verify URL supports CORS (Cross-Origin Resource Sharing)
- Check browser console for fetch/network errors
- Try a different video source
- Ensure URL is HTTPS (not HTTP)

**Problem:** Video plays but no picture
- Check codec compatibility (H.264/VP9/AV1)
- Verify WebCodecs is supported in browser
- Check console for decode errors

### Subtitle Issues

**Problem:** Subtitles not appearing
- Verify subtitle content is valid WebVTT or SRT format
- Check console for parsing errors
- Ensure subtitle track is subscribed AND set as active
- Verify video playback time matches cue times

**Problem:** Subtitles out of sync
- Check cue timestamps in subtitle content
- Verify timescale matches (milliseconds vs seconds)

### Timeline Issues

**Problem:** Timeline not loading
- Ensure timeline track is published with catalog
- Check console for JSON parsing errors
- Verify timeline track is subscribed

**Problem:** Seeking not accurate
- Confirm "TL" badge appears in player (timeline loaded)
- Check console for `[VODVideoPlayer] Seeking with timeline` logs
- Ensure timeline entries cover full video duration

### Catalog Issues

**Problem:** Catalog not publishing
- Verify session is in "Ready" state
- Check namespace format (use `/` separators)
- Monitor console for publish errors

**Problem:** Tracks not appearing in subscriber
- Ensure using same namespace as publisher
- Wait for catalog data to arrive (may take a moment)
- Re-subscribe if catalog was updated

---

## Verification Checklist

Use this checklist to verify all features are working:

### Publisher Side

- [ ] Connected to relay successfully
- [ ] VOD video track added with probed metadata
- [ ] Subtitle track added with content
- [ ] Timeline track added
- [ ] Catalog published (status shows "Published")
- [ ] Console shows all tracks published with aliases

### Subscriber Side

- [ ] Connected to relay successfully
- [ ] Catalog received with correct track count
- [ ] Track metadata displayed (codec, resolution, etc.)
- [ ] Video track subscribed and playing
- [ ] Subtitle track subscribed and activated
- [ ] Timeline track loaded ("TL" badge visible)

### VOD Player Features

- [ ] Play/Pause works (button and keyboard)
- [ ] Progress bar shows correct time
- [ ] Seeking works via progress bar drag
- [ ] Timeline-based seeking shows in console
- [ ] Playback speed selector works
- [ ] Fullscreen toggle works
- [ ] Subtitles display at correct times
- [ ] Subtitle toggle works (button and `C` key)
- [ ] All keyboard shortcuts functional

### Multi-Language

- [ ] Multiple subtitle tracks can be subscribed
- [ ] Can switch between subtitle languages
- [ ] Active track indicator shows correctly
- [ ] Subtitles update when switching languages

---

## Architecture Reference

```
Publisher                          Relay                         Subscriber
─────────                          ─────                         ──────────
                                     │
[Catalog Builder]                    │                    [Catalog Subscriber]
     │                               │                           │
     ├── VOD Track ─────────────────►│◄───────────────────────── Subscribe
     │   (video frames via FETCH)    │                           │
     │                               │                           ▼
     ├── Subtitle Track ────────────►│◄─────────── [SubtitleOverlay]
     │   (WebVTT content)            │             (parse & display)
     │                               │                           │
     └── Timeline Track ────────────►│◄─────────── [VODVideoPlayer]
         (group→timestamp mapping)   │             (accurate seeking)
```

---

## Related Documentation

- [Catalog Implementation Plan](./catalog-implementation-plan.md) - Full implementation details
- [MSF Specification](https://datatracker.ietf.org/doc/draft-ietf-moq-streaming-format/) - MOQT Streaming Format
- [WebVTT Standard](https://www.w3.org/TR/webvtt1/) - Subtitle format specification
