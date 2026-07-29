# How It Works: MOQ Meet Top-N Demo

## Overview

The Top-N demo is a multi-participant video conferencing system where a relay
server selectively forwards only the most active speakers' media to each
subscriber, rather than forwarding all tracks to everyone.

Two repos power this:

- **moq-web-tail** (`/Users/snk/work/tech/moq/moq-web-tail`) — TypeScript/React
  web client ("Meet app") and supporting packages
- **moqtail** (`/Users/snk/work/tech/moq/moqtail`) — Rust relay server with
  Top-N coordinator logic

---

## Deployment

### Infrastructure

| Service | URL | Host | Region |
|---------|-----|------|--------|
| Meet App | https://meet.mocha-net.dev | 100.23.225.210 | us-east-1 |
| Relay | https://relay.mocha-net.dev | 44.233.114.143 | us-west-2 |

The Meet App is served by **Caddy** (static files from `/srv/moq-meet/`).
The Relay runs as a **systemd service** (`moq-relay`) on port 443 (QUIC/WebTransport).

### Deploying the Meet App

```bash
cd /Users/snk/work/tech/moq/moq-web-tail
pnpm install
MOQT_VERSION=draft-16 pnpm --filter @moq-web/meet build
scp -i ~/.ssh/mocha-deploy -r apps/meet/dist/* ubuntu@100.23.225.210:/srv/moq-meet/
```

Or use the one-step script:

```bash
cd apps/meet && ./scripts/deploy.sh
```

### Deploying the MOQTail Relay

Cross-compiled for ARM64 Linux via Docker + `cross`:

```bash
cd /Users/snk/work/tech/moq/moqtail
cross build --release --target aarch64-unknown-linux-gnu -p relay

scp -i ~/.ssh/mocha-deploy \
  target/aarch64-unknown-linux-gnu/release/relay \
  ubuntu@44.233.114.143:/opt/moq-relay/moq-relay.new

ssh -i ~/.ssh/mocha-deploy ubuntu@44.233.114.143 \
  "sudo systemctl stop moq-relay && \
   mv /opt/moq-relay/moq-relay.new /opt/moq-relay/moq-relay && \
   chmod +x /opt/moq-relay/moq-relay && \
   sudo systemctl start moq-relay"
```

### Relay CLI Arguments

```
--host 0.0.0.0
--port 443
--cert-file /etc/letsencrypt/live/relay.mocha-net.dev/fullchain.pem
--key-file  /etc/letsencrypt/live/relay.mocha-net.dev/privkey.pem
--top-n-tick-interval-ms 250    # Re-rank every 250ms
--top-n-dwell-ticks 2           # ~500ms dwell before dropping a track
```

### Prerequisites

- SSH key: `~/.ssh/mocha-deploy`
- Docker running (for `cross`)
- `pnpm` installed
- `cross` installed (`cargo install cross`)
- AWS CLI with `mocha` profile (for DNS)

---

## Architecture

```
Browser A (Alice)                    Browser B (Bob)
    │                                     │
    │ PUBLISH_NAMESPACE                   │ PUBLISH_NAMESPACE
    │ [room-id, Alice]                    │ [room-id, Bob]
    │                                     │
    │ SUBSCRIBE_NAMESPACE                 │ SUBSCRIBE_NAMESPACE
    │ [room-id]                           │ [room-id]
    │ TrackFilter(0x12, max=2)            │ TrackFilter(0x12, max=2)
    │                                     │
    ▼                                     ▼
┌─────────────────────────────────────────────────────────────┐
│  relay.mocha-net.dev:443 (QUIC/WebTransport)                │
│                                                             │
│  TopNCoordinator:                                           │
│  - Observes SPEECH_ACTIVITY (0x12) on video+audio objects   │
│  - Ranks: SPEECH_START(2) > SPEAKING(1) > SILENT(0)         │
│  - Self-exclusion: Alice doesn't see Alice's own tracks     │
│  - Pushes top-N video tracks to each subscriber             │
│  - Dwell debounce: ~500ms before removing a track           │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

**Publishing (local → relay):**

1. `getUserMedia()` → MediaStream (camera + mic)
2. Video → `PublishPipeline` → H.264 encoded → LOC packaged → MoQ objects
3. Audio → `PublishPipeline` → Opus encoded → LOC packaged → MoQ objects
4. Audio also feeds VAD (`@ricky0123/vad-web` / Silero) → speech state →
   attached as object extension key `0x12` on video objects
5. Objects published to `/<room-id>/<participant-id>/video` and
   `/<room-id>/<participant-id>/audio`

**Subscribing (relay → local):**

1. Client sends `subscribeNamespace(['<room-id>'], { trackFilter: { propertyType: 0x12, maxSelected: 2 } })`
2. Relay's TopNCoordinator ranks participants by speech activity value
3. Top-N video tracks are pushed to each subscriber
4. Top-3 audio tracks are mixed client-side via Web Audio API

### Speech Activity Extension

Key `0x12` (decimal 18) carried on video objects:

| Value | Meaning |
|-------|---------|
| 0 | SILENT |
| 1 | SPEAKING |
| 2 | SPEECH_START |

The relay ranks `SPEECH_START > SPEAKING > SILENT` and uses dwell-based
debouncing to avoid flickering.

---

## Agent (Bot) as Participant

The agent/bot is implemented **entirely client-side** — no separate server
process. It uses the exact same protocol path as a human participant.

### Implementation

Two React hooks in `apps/meet/src/hooks/`:

| Hook | Purpose |
|------|---------|
| `useBotPublish.ts` | Single bot participant |
| `useSyntheticParticipant.ts` | Multiple named bots with configurable speech modes |

### How the Bot Publishes Video

1. Creates an HTML5 `<canvas>` element
2. Draws animated gradients + a text label (bot name) at 30fps
3. Captures the canvas as a `MediaStream` via `canvas.captureStream()`
4. Feeds the stream into `PublishPipeline` which encodes it as H.264

### How the Bot Publishes Audio

1. Loads `/bot-speech.mp3` via Web Audio API (`AudioContext`)
2. Plays the clip in intermittent bursts (10s speaking, 10–12s pauses)
3. Applies fade-in/fade-out gain transitions
4. Captures the audio node output as a `MediaStreamTrack`
5. Feeds into `PublishPipeline` which encodes it as Opus

### How the Bot Signals Speech Activity

A state machine mimics real VAD behavior:

```
SILENT (0) → SPEECH_START (2) → SPEAKING (1) → ... → SILENT (0)
```

The speech activity value is attached as object extension key `0x12` on video
objects — identical to how real participants attach VAD output. The relay's
TopNCoordinator treats bot tracks the same as human tracks.

### Publishing Flow (code path)

```typescript
// 1. Set namespace
const namespace = [roomId, botName];
session.setOwnNamespacePrefix(namespace.join('/'));

// 2. Publish tracks
const videoAlias = await session.publish(namespace, 'video', {
  deliveryMode: 'stream',
});
const audioAlias = await session.publish(namespace, 'audio', {
  deliveryMode: 'stream',
  audioDeliveryMode: 'stream',
});

// 3. Send encoded objects with speech activity extension
session.sendObject(videoAlias, objectData, {
  extensions: { [SPEECH_ACTIVITY_KEY]: speechState },
});
```

### UI Integration

- On the Join Screen, toggling "Join as Bot" auto-generates a name like `bot-xxxx`
- The meeting room header shows "BOT MODE"
- `useSyntheticParticipant` supports adding multiple bots with modes:
  - `'always'` — continuously speaking
  - `'intermittent'` — periodic bursts

### Configuration

From `apps/meet/src/lib/constants.ts`:

```typescript
export const DEFAULTS = {
  videoWidth: 1280,
  videoHeight: 720,
  videoBitrate: 2_500_000,
  videoFramerate: 30,
  audioSampleRate: 48000,
  audioChannels: 1,
  audioBitrate: 128_000,
};
export const SPEECH_ACTIVITY_KEY = 0x12;
```

---

## Running the Demo

### Quick Start

1. Ensure relay is running: `ssh -i ~/.ssh/mocha-deploy ubuntu@44.233.114.143 "systemctl is-active moq-relay"`
2. Open https://meet.mocha-net.dev in two separate browser profiles (or devices)
3. Both join the same Room ID with different display names
4. When one speaks, the relay pushes their video to the other participant
5. Remote video appears with a green speaking indicator

### Preflight Check

```bash
cd apps/meet && ./scripts/preflight.sh
```

### Verifying Top-N in Relay Logs

```bash
ssh -i ~/.ssh/mocha-deploy ubuntu@44.233.114.143 "journalctl -u moq-relay -f"
```

Look for:
```
TopNCoordinator: registered subscriber ... property_type=18, max_selected=2
TopNCoordinator: tick: subscriber ... to_add=[...] to_remove=[...]
```

### Local Development

```bash
cd apps/meet
pnpm dev
# Starts HTTPS dev server on port 5176
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| No video | Check browser console for WebTransport errors; some networks block UDP 443 |
| Cert errors | Caddy auto-provisions TLS; wait 2-3 min after DNS changes |
| Relay won't start | `journalctl -u moq-relay -n 20 --no-pager` |
| Cert expired on relay | `sudo certbot renew && sudo systemctl restart moq-relay` |

---

## CI / GitHub Actions

- `deploy.yml` — deploys to GitHub Pages on push to `main` (draft-16 + draft-14 variants)
- `deploy-branch.yml` — manual workflow_dispatch to preview any branch
- The `apps/meet` app is deployed **manually** to `meet.mocha-net.dev` (not via CI)
