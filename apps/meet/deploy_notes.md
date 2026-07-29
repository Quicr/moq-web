# MOQ Meet — Deployment & Testing Notes

## Live URLs

| Service | URL | Server |
|---------|-----|--------|
| Meet App | https://meet.mocha-net.dev | 100.23.225.210 (web, us-east-1) |
| Relay | https://relay.mocha-net.dev | 44.233.114.143 (relay, us-west-2) |

---

## Deploy from Fresh Build

### Prerequisites

- SSH key: `~/.ssh/mocha-deploy`
- Docker running (for `cross` relay builds)
- `pnpm` installed
- `cross` installed (`cargo install cross`)
- AWS CLI configured with `mocha` profile (for DNS changes)

### Deploy Meet App

```bash
cd /path/to/moq-web-tail

# Install deps (if needed)
pnpm install

# Build
MOQT_VERSION=draft-16 pnpm --filter @moq-web/meet build

# Deploy
scp -i ~/.ssh/mocha-deploy -r apps/meet/dist/* ubuntu@100.23.225.210:/srv/moq-meet/
```

### Deploy Relay (with top-N support)

```bash
cd /path/to/moqtail

# Cross-compile for ARM64 Linux (requires Docker)
cross build --release --target aarch64-unknown-linux-gnu -p relay

# Deploy binary
scp -i ~/.ssh/mocha-deploy \
  target/aarch64-unknown-linux-gnu/release/relay \
  ubuntu@44.233.114.143:/opt/moq-relay/moq-relay.new

# Swap and restart
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

The moqtail relay uses:
```
--host 0.0.0.0
--port 443
--cert-file /etc/letsencrypt/live/relay.mocha-net.dev/fullchain.pem
--key-file /etc/letsencrypt/live/relay.mocha-net.dev/privkey.pem
```

Top-N specific (defaults are fine):
```
--top-n-tick-interval-ms 250    # Re-rank every 250ms
--top-n-dwell-ticks 2           # 2 ticks before removing a track
```

---

## First-Time Server Setup (already done)

These steps are only needed once when setting up a new server.

### Web Server (for meet app)

```bash
ssh -i ~/.ssh/mocha-deploy ubuntu@100.23.225.210

# Create directory
sudo mkdir -p /srv/moq-meet
sudo chown ubuntu:ubuntu /srv/moq-meet

# Add to Caddy (/etc/caddy/Caddyfile)
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

## Testing

### Quick Test (single browser)

1. Open https://meet.mocha-net.dev
2. Enter Room ID (e.g., `test-room`) and Display Name (e.g., `Alice`)
3. Click "Join Meeting"
4. Allow camera/microphone access
5. You should see your self-view (PiP in bottom-right)
6. Status should show "Connecting..." → "Starting media..." → "Subscribing to room..." → clear

### Multi-Participant Test

1. Open https://meet.mocha-net.dev in **two separate browser profiles** (or devices)
2. Both join the same Room ID with different Display Names
3. Both will:
   - Publish video + audio tracks with SPEECH_ACTIVITY extension
   - Subscribe to the room namespace with top-N filter
4. When one participant speaks:
   - Their audio objects carry SPEECH_START (2) / SPEAKING (1) extension
   - Their video objects carry the same speech state
   - Relay ranks their track highest → pushes their video to the other participant
5. The remote video should appear in the grid with a green speaking indicator

### What to Watch For

- **No video?** Check browser console for WebTransport connection errors. The relay uses port 443/UDP (QUIC).
- **Firewall issues?** Some corporate networks block UDP 443. Try from a different network.
- **Cert errors?** Caddy auto-provisions TLS. If DNS just changed, wait 2-3 minutes.
- **Relay logs:** `ssh -i ~/.ssh/mocha-deploy ubuntu@44.233.114.143 "journalctl -u moq-relay -f"`

### Verify Top-N is Working

In relay logs, look for:
```
TopNCoordinator: registered subscriber ... property_type=18, max_selected=2
TopNCoordinator: tick: subscriber ... to_add=[...] to_remove=[...]
```

This confirms the relay is ranking tracks and making selection decisions.

---

## Architecture

```
Browser A (Alice)                    Browser B (Bob)
    │                                     │
    │ PUBLISH_NAMESPACE                   │ PUBLISH_NAMESPACE
    │ [test-room, Alice]                  │ [test-room, Bob]
    │                                     │
    │ SUBSCRIBE_NAMESPACE                 │ SUBSCRIBE_NAMESPACE
    │ [test-room]                         │ [test-room]
    │ TrackFilter(0x12, max=2)            │ TrackFilter(0x12, max=2)
    │                                     │
    ▼                                     ▼
┌─────────────────────────────────────────────────────────────┐
│  relay.mocha-net.dev:443 (QUIC/WebTransport)                │
│                                                             │
│  TopNCoordinator:                                           │
│  - Observes SPEECH_ACTIVITY (0x12) on video+audio objects   │
│  - Ranks: SPEECH_START(2) > SPEAKING(1) > SILENT(0)         │
│  - Self-exclusion: Alice doesn't see Alice's tracks         │
│  - Pushes top-N video tracks to each subscriber             │
│  - Dwell debounce: 500ms before removing a track            │
└─────────────────────────────────────────────────────────────┘
```

---

## Troubleshooting

### Relay won't start
```bash
ssh -i ~/.ssh/mocha-deploy ubuntu@44.233.114.143 "journalctl -u moq-relay -n 20 --no-pager"
```

### Cert expired on relay
```bash
ssh -i ~/.ssh/mocha-deploy ubuntu@44.233.114.143 "sudo certbot renew && sudo systemctl restart moq-relay"
```

### Redeploy everything from scratch
```bash
# 1. Build and deploy relay
cd /path/to/moqtail
cross build --release --target aarch64-unknown-linux-gnu -p relay
scp -i ~/.ssh/mocha-deploy target/aarch64-unknown-linux-gnu/release/relay ubuntu@44.233.114.143:/opt/moq-relay/moq-relay.new
ssh -i ~/.ssh/mocha-deploy ubuntu@44.233.114.143 "sudo systemctl stop moq-relay && mv /opt/moq-relay/moq-relay.new /opt/moq-relay/moq-relay && chmod +x /opt/moq-relay/moq-relay && sudo systemctl start moq-relay"

# 2. Build and deploy meet app
cd /path/to/moq-web-tail
pnpm install
MOQT_VERSION=draft-16 pnpm --filter @moq-web/meet build
scp -i ~/.ssh/mocha-deploy -r apps/meet/dist/* ubuntu@100.23.225.210:/srv/moq-meet/
```
