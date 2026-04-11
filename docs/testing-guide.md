# MOQT Client Testing Guide

This guide covers testing the MSF Catalog, DVR/VOD, and Catalog-driven Pub/Sub flows.

## Prerequisites

1. **MOQT Relay Server** running (e.g., `moq-rs` or your relay implementation)
2. **CORS-enabled video** for DVR testing (see [CORS Video Sources](#cors-enabled-video-sources))
3. **Two browser tabs/windows** for pub/sub testing

---

## 1. Testing Catalog Flow

The Catalog tab allows you to build and publish MSF (MOQT Streaming Format) catalogs that describe available media tracks.

### 1.1 Build a Catalog (Publisher Side)

1. Open the app and go to **Catalog** tab
2. Select **Build & Publish** sub-tab
3. Configure the **Namespace** (e.g., `conference/room-1/media`)
4. Add tracks using the buttons:

   **Add a VOD Video Track:**
   - Click **VOD** button
   - Enter track name (e.g., `main-video`)
   - Enter video URL (must be CORS-enabled MP4)
   - Set resolution, framerate, bitrate
   - Choose Experience Profile (Interactive/Streaming/Broadcast)
   - Click **Save**

   **Add a Live Video Track:**
   - Click **Live** button
   - Enter track name (e.g., `camera-1`)
   - Configure resolution/framerate/bitrate
   - Click **Save**

   **Add an Audio Track:**
   - Click **Audio** button
   - Configure codec, sample rate, channels
   - Click **Save**

   **Add Subtitles:**
   - Click **Subtitle** button
   - Set language, label, format (WebVTT/SRT)
   - Click **Save**

   **Add Timeline (for VOD seeking):**
   - Click **Timeline** button
   - Set timescale
   - Click **Save**

5. Review the **Catalog Preview** (click "Show JSON")
6. Click **Connect & Publish** (or **Publish Catalog** if already connected)

### 1.2 Subscribe to a Catalog (Subscriber Side)

1. Open second browser tab
2. Go to **Catalog** tab → **Subscribe** sub-tab
3. Enter the same **Namespace** as publisher (e.g., `conference/room-1/media`)
4. Click **Connect & Subscribe** (or **Subscribe** if connected)
5. The catalog should appear showing all available tracks
6. Select tracks to subscribe to using checkboxes
7. Click **Subscribe Selected**

---

## 2. Testing DVR Flow (VOD with Scrubbing)

DVR mode allows playback of pre-recorded video with seeking/scrubbing support.

### 2.1 CORS-Enabled Video Sources

You need videos served with proper CORS headers. Options:

**Public Test Videos:**
```
# Big Buck Bunny (Blender Foundation)
https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4

# Sintel trailer
https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4

# Tears of Steel
https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4
```

**Self-hosted (local development):**
```bash
# Using Python with CORS
python3 -c "
from http.server import HTTPServer, SimpleHTTPRequestHandler
class CORSHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Range')
        self.send_header('Access-Control-Expose-Headers', 'Content-Length, Content-Range')
        super().end_headers()
HTTPServer(('localhost', 8080), CORSHandler).serve_forever()
"
# Then use: http://localhost:8080/your-video.mp4
```

### 2.2 Publish VOD Content

**Option A: Via Catalog Tab**
1. Go to **Catalog** → **Build & Publish**
2. Click **VOD** to add a VOD track
3. Enter the CORS-enabled video URL
4. Enable **DVR** checkbox
5. Optionally enable **Loop** for continuous playback
6. Publish the catalog

**Option B: Via Publish Tab (Legacy)**
1. Go to **Publish** tab
2. Enable **VOD Publishing** in Settings first (`Settings` → `Playback` → `Enable VOD Publishing`)
3. In Add Track section, check **VOD Track**
4. Enter video URL
5. Configure resolution/bitrate to match source
6. Add track, then start publishing

### 2.3 Subscribe and Test DVR Controls

1. Open subscriber tab
2. Subscribe to the catalog or track
3. The VOD player should appear with:
   - **Play/Pause** button
   - **Timeline scrubber** - drag to seek
   - **Time display** - current time / duration
   - **VOD badge** indicator

**Test Scrubbing:**
1. Click anywhere on the timeline to seek
2. Drag the scrubber handle to scrub through video
3. Verify video jumps to the correct position
4. Check that audio stays in sync (if present)

**Test DVR Rewind:**
1. During playback, drag scrubber backwards
2. Video should rewind and continue from new position
3. Verify no artifacts or freezing

---

## 3. Catalog-Driven Pub/Sub Flow

This flow uses the MSF catalog to discover and subscribe to tracks dynamically.

### 3.1 Publisher Setup

1. **Configure Catalog:**
   ```
   Namespace: conference/demo/media
   ```

2. **Add Multiple Tracks:**
   - Video track: `presenter/video` (Live, 720p, 30fps)
   - Audio track: `presenter/audio` (Opus, 48kHz, stereo)
   - Video track: `slides/video` (VOD, for presentation slides)
   - Subtitle track: `captions/en` (English captions)

3. **Publish Catalog:**
   - Click **Connect & Publish**
   - Verify "Catalog Published" success message

### 3.2 Subscriber Discovery

1. **Subscribe to Catalog:**
   ```
   Namespace: conference/demo/media
   ```
   - Click **Connect & Subscribe**

2. **View Available Tracks:**
   - Catalog panel shows all tracks with metadata:
     - Track type (Video/Audio/Subtitle/Timeline)
     - Codec, resolution, bitrate
     - Experience profile (latency target)

3. **Select Tracks:**
   - Check tracks you want to receive
   - Can select multiple tracks (e.g., video + audio)

4. **Subscribe:**
   - Click **Subscribe Selected**
   - Video/audio players appear for subscribed tracks

### 3.3 Multi-Track Synchronization

When subscribing to related tracks (video + audio):

1. Both tracks use same `renderGroup` in catalog
2. GroupArbiter synchronizes playback
3. Audio should stay in sync with video

**Verify Sync:**
- Watch lip-sync on presenter video
- Check timeline alignment in stats (if debug enabled)

### 3.4 Quality Switching (ABR)

If catalog includes multiple quality variants:

1. Tracks with same `altGroup` are quality alternatives
2. Subscriber can switch between them
3. Switch should be seamless at GOP boundaries

---

## 4. Troubleshooting

### Video Not Loading
- Check CORS headers on video URL
- Open browser DevTools → Network tab
- Look for blocked requests or CORS errors
- Verify video URL is accessible directly in browser

### Catalog Not Appearing
- Verify publisher and subscriber use same namespace
- Check relay connection status
- Look for errors in browser console
- Ensure relay supports catalog track type

### DVR Seeking Not Working
- Confirm VOD track has timeline track
- Check that video was fully loaded before seeking
- Verify MediaTimeline data is being published

### Audio/Video Out of Sync
- Enable GroupArbiter in Settings
- Check both tracks have same renderGroup
- Adjust jitter buffer in Experience Profile

### Connection Timeouts
- Use "Connect & Go" pattern (configure offline first)
- Check relay is running and accessible
- Verify WebTransport is supported in browser

---

## 5. Debug Mode

Enable debug mode for detailed stats:

1. Add `?debug=1` to URL
2. Dev Settings panel appears at bottom
3. Shows:
   - Group/Object IDs
   - Jitter stats
   - Buffer levels
   - Frame timing

---

## 6. Experience Profiles Quick Reference

| Profile | Target Latency | Use Case |
|---------|---------------|----------|
| Interactive | 50-100ms | Gaming, real-time collaboration |
| Streaming | 500ms | Live streaming, webinars |
| Broadcast | 2000ms | Traditional broadcast, maximum quality |

Choose based on your latency vs. quality tradeoff needs.
