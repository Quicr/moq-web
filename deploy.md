# Top-N Demo Deployment (MOQ Meet + MOQTail Relay)

## Live URLs

| Service | URL | Server |
|---------|-----|--------|
| Meet App | https://meet.mocha-net.dev | 100.23.225.210 (web, us-east-1) |
| Relay | https://relay.mocha-net.dev | 44.233.114.143 (relay, us-west-2) |

---

## Prerequisites

- SSH key: `~/.ssh/mocha-deploy`
- Docker running (required by `cross` for relay cross-compilation)
- `pnpm` installed
- `cross` installed: `cargo install cross`
- AWS CLI configured with a `mocha` profile (for DNS changes)

---

## Build & Deploy the Meet App

```bash
cd /path/to/moq-web-tail

# Install deps (if needed)
pnpm install

# Build (MOQT_VERSION=draft-16 is required)
MOQT_VERSION=draft-16 pnpm --filter @moq-web/meet build

# Deploy
scp -i ~/.ssh/mocha-deploy -r apps/meet/dist/* ubuntu@100.23.225.210:/srv/moq-meet/
```

Or use the deploy script directly:

```bash
cd apps/meet
./scripts/deploy.sh
```

The script builds and deploys in one step. It respects the `MOCHA_WEB_HOST` and
`MOCHA_SSH_KEY` environment variables if you need to override the defaults.

---

## Build & Deploy the Relay (with Top-N support)

The relay lives in the separate `moqtail` repo. It must be cross-compiled for
ARM64 Linux using Docker + `cross`.

```bash
cd /path/to/moqtail

# Cross-compile for ARM64 Linux (requires Docker to be running)
cross build --release --target aarch64-unknown-linux-gnu -p relay

# Upload new binary
scp -i ~/.ssh/mocha-deploy \
  target/aarch64-unknown-linux-gnu/release/relay \
  ubuntu@44.233.114.143:/opt/moq-relay/moq-relay.new

# Swap binary and restart the service
ssh -i ~/.ssh/mocha-deploy ubuntu@44.233.114.143 \
  "sudo systemctl stop moq-relay && \
   mv /opt/moq-relay/moq-relay.new /opt/moq-relay/moq-relay && \
   chmod +x /opt/moq-relay/moq-relay && \
   sudo systemctl start moq-relay"

# Verify
ssh -i ~/.ssh/mocha-deploy ubuntu@44.233.114.143 \
  "systemctl is-active moq-relay && journalctl -u moq-relay -n 3 --no-pager"
```

### Relay CLI Arguments

```
--host 0.0.0.0
--port 443
--cert-file /etc/letsencrypt/live/relay.mocha-net.dev/fullchain.pem
--key-file  /etc/letsencrypt/live/relay.mocha-net.dev/privkey.pem
```

Top-N tuning (defaults are fine for the demo):

```
--top-n-tick-interval-ms 250    # Re-rank every 250ms
--top-n-dwell-ticks 2           # 2 ticks (~500ms) before dropping a track
```

---

## Redeploy Everything from Scratch

```bash
# 1. Relay
cd /path/to/moqtail
cross build --release --target aarch64-unknown-linux-gnu -p relay
scp -i ~/.ssh/mocha-deploy \
  target/aarch64-unknown-linux-gnu/release/relay \
  ubuntu@44.233.114.143:/opt/moq-relay/moq-relay.new
ssh -i ~/.ssh/mocha-deploy ubuntu@44.233.114.143 \
  "sudo systemctl stop moq-relay && \
   mv /opt/moq-relay/moq-relay.new /opt/moq-relay/moq-relay && \
   chmod +x /opt/moq-relay/moq-relay && \
   sudo systemctl start moq-relay"

# 2. Meet app
cd /path/to/moq-web-tail
pnpm install
MOQT_VERSION=draft-16 pnpm --filter @moq-web/meet build
scp -i ~/.ssh/mocha-deploy -r apps/meet/dist/* ubuntu@100.23.225.210:/srv/moq-meet/
```

---

## One-Time Server Setup (already done)

### Web Server

```bash
ssh -i ~/.ssh/mocha-deploy ubuntu@100.23.225.210

sudo mkdir -p /srv/moq-meet
sudo chown ubuntu:ubuntu /srv/moq-meet

# Add to /etc/caddy/Caddyfile:
# meet.mocha-net.dev {
#     root * /srv/moq-meet
#     try_files {path} /index.html
#     file_server
#     encode gzip
# }

sudo systemctl reload caddy
```

### DNS

```bash
aws route53 change-resource-record-sets --profile mocha \
  --hosted-zone-id Z0266168Z19ONTNCUE5O --change-batch '{
  "Changes": [{"Action": "UPSERT", "ResourceRecordSet": {
    "Name": "meet.mocha-net.dev", "Type": "A", "TTL": 300,
    "ResourceRecords": [{"Value": "100.23.225.210"}]
  }}]
}'
```

---

## Pre-flight Check

Before a demo, run the preflight script to verify all services are up:

```bash
cd apps/meet
./scripts/preflight.sh
```

This checks: relay systemd status, live-view dashboard, meet app HTTP, and VAD
model assets.

---

## Testing Top-N

### Multi-Participant Test

1. Open https://meet.mocha-net.dev in **two separate browser profiles** (or devices)
2. Both join the same Room ID with different display names
3. When one participant speaks:
   - Audio objects carry `SPEECH_ACTIVITY` extension (value 2=SPEECH_START, 1=SPEAKING, 0=SILENT)
   - Relay ranks that track highest and pushes their video to the other participant
4. Remote video appears in the grid with a green speaking indicator

### Verifying Top-N in Relay Logs

```bash
ssh -i ~/.ssh/mocha-deploy ubuntu@44.233.114.143 "journalctl -u moq-relay -f"
```

Look for:

```
TopNCoordinator: registered subscriber ... property_type=18, max_selected=2
TopNCoordinator: tick: subscriber ... to_add=[...] to_remove=[...]
```

---

## Troubleshooting

**No video** — Check browser console for WebTransport errors. The relay uses port 443/UDP (QUIC). Some corporate networks block UDP 443.

**Cert errors** — Caddy auto-provisions TLS. If DNS just changed, wait 2–3 minutes.

**Relay won't start:**
```bash
ssh -i ~/.ssh/mocha-deploy ubuntu@44.233.114.143 "journalctl -u moq-relay -n 20 --no-pager"
```

**Cert expired on relay:**
```bash
ssh -i ~/.ssh/mocha-deploy ubuntu@44.233.114.143 "sudo certbot renew && sudo systemctl restart moq-relay"
```

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

**Publishing (local → relay)**
1. `getUserMedia()` → MediaStream (camera + mic)
2. Video → `PublishPipeline` → H.264 encoded → LOC packaged → MoQ objects
3. Audio → `PublishPipeline` → Opus encoded → LOC packaged → MoQ objects
4. Audio also feeds VAD (`@ricky0123/vad-web` / silero) → speech state → attached as object extension key `0x12`
5. Objects published to `/<room-id>/<participant-id>/video` and `/<room-id>/<participant-id>/audio`

**Subscribing (relay → local)**
1. `subscribeNamespace(['<room-id>'], { trackFilter: { propertyType: 0x12, maxSelected: 2 } })`
2. Relay's `TopNCoordinator` ranks participants by speech activity
3. Top-N video tracks are pushed to each subscriber; top-3 audio tracks are mixed client-side via Web Audio API

---

## CI / GitHub Actions

The main `deploy.yml` workflow deploys to GitHub Pages on every push to `main`
(builds draft-16 + draft-14 variants of the client app).

The `deploy-branch.yml` workflow is a manual `workflow_dispatch` that can
preview any branch at `.../branches/<branch-name>/`.

The `apps/meet` app is **not** deployed via GitHub Actions — it is deployed
manually to `meet.mocha-net.dev` using the steps above.

---

## Local Dev

```bash
# Start the meet app dev server (HTTPS, port 5176)
cd apps/meet
pnpm dev
```

The Vite config (`vite.config.ts`) uses `@vitejs/plugin-basic-ssl` for local
HTTPS (required for WebTransport) and sets `Cross-Origin-Opener-Policy` /
`Cross-Origin-Embedder-Policy` headers needed for SharedArrayBuffer (VAD WASM).
