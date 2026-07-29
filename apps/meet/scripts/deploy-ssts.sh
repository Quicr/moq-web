#!/bin/bash
set -euo pipefail

# Deploy Top-N + SSTS/DTS demo (both relay and meet app)
#
# Usage:
#   ./deploy-ssts.sh              # Full deploy (relay + meet)
#   ./deploy-ssts.sh --meet-only  # Only deploy meet app
#   ./deploy-ssts.sh --relay-only # Only deploy relay
#   ./deploy-ssts.sh --verify     # Only run verification checks

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
WEB_REPO="$(cd "$APP_DIR/../.." && pwd)"
RELAY_REPO="${MOQTAIL_REPO:-/Users/snk/work/tech/moq/moqtail}"

WEB_HOST="${MOCHA_WEB_HOST:-100.23.225.210}"
RELAY_HOST="${MOCHA_RELAY_HOST:-44.233.114.143}"
KEY="${MOCHA_SSH_KEY:-$HOME/.ssh/mocha-deploy}"
LIVE_VIEW_PORT=9091
MEET_URL="https://meet.mocha-net.dev"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; ERRORS=$((ERRORS + 1)); }
info() { echo -e "  ${YELLOW}→${NC} $1"; }
step() { echo -e "\n${CYAN}${BOLD}[$1/$TOTAL]${NC} $2"; }

ERRORS=0
DEPLOY_RELAY=true
DEPLOY_MEET=true
VERIFY_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --meet-only)  DEPLOY_RELAY=false ;;
    --relay-only) DEPLOY_MEET=false ;;
    --verify)     VERIFY_ONLY=true; DEPLOY_RELAY=false; DEPLOY_MEET=false ;;
  esac
done

if [ "$VERIFY_ONLY" = true ]; then
  TOTAL=1
else
  TOTAL=0
  [ "$DEPLOY_RELAY" = true ] && TOTAL=$((TOTAL + 3))
  [ "$DEPLOY_MEET" = true ] && TOTAL=$((TOTAL + 2))
  TOTAL=$((TOTAL + 1))  # verification step
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Top-N + SSTS/DTS Deploy"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  Web repo:   $WEB_REPO"
echo "  Relay repo: $RELAY_REPO"
echo "  Meet host:  $WEB_HOST"
echo "  Relay host: $RELAY_HOST"
echo ""

STEP=0

# ─────────────────────────────────────────────────────────────────
# RELAY BUILD & DEPLOY
# ─────────────────────────────────────────────────────────────────

if [ "$DEPLOY_RELAY" = true ]; then

  STEP=$((STEP + 1))
  step $STEP "Cross-compiling relay for ARM64 Linux"

  if ! command -v cross &> /dev/null; then
    fail "'cross' not found. Install with: cargo install cross"
    echo "   Skipping relay deploy."
    DEPLOY_RELAY=false
  elif ! docker info &> /dev/null 2>&1; then
    fail "Docker is not running. 'cross' requires Docker."
    echo "   Skipping relay deploy."
    DEPLOY_RELAY=false
  else
    cd "$RELAY_REPO"
    cross build --release --target aarch64-unknown-linux-gnu -p relay
    pass "Relay built: target/aarch64-unknown-linux-gnu/release/relay"
  fi
fi

if [ "$DEPLOY_RELAY" = true ]; then

  STEP=$((STEP + 1))
  step $STEP "Uploading relay binary"

  scp -i "$KEY" \
    "$RELAY_REPO/target/aarch64-unknown-linux-gnu/release/relay" \
    "ubuntu@$RELAY_HOST:/opt/moq-relay/moq-relay.new"
  pass "Binary uploaded"

  STEP=$((STEP + 1))
  step $STEP "Updating systemd service and restarting relay"

  # Write the updated service file with DTS flags
  ssh -i "$KEY" "ubuntu@$RELAY_HOST" bash -s << 'REMOTE_SCRIPT'
set -e

# Update systemd service with DTS flags
sudo tee /etc/systemd/system/moq-relay.service > /dev/null << 'SERVICE'
[Unit]
Description=MoQ Transport Relay
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/moq-relay
ExecStart=/opt/moq-relay/moq-relay \
  --host 0.0.0.0 \
  --port 443 \
  --cert-file /etc/letsencrypt/live/relay.mocha-net.dev/fullchain.pem \
  --key-file /etc/letsencrypt/live/relay.mocha-net.dev/privkey.pem \
  --enable-dts \
  --dts-default-budget-kbps 6000 \
  --live-view-port 9091
Restart=always
RestartSec=5
Environment="RUST_LOG=info"
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
SERVICE

# Swap binary and restart
sudo systemctl stop moq-relay || true
mv /opt/moq-relay/moq-relay.new /opt/moq-relay/moq-relay
chmod +x /opt/moq-relay/moq-relay
sudo systemctl daemon-reload
sudo systemctl start moq-relay

# Wait for service to stabilize
sleep 2
systemctl is-active moq-relay
REMOTE_SCRIPT

  pass "Relay restarted with DTS enabled"
fi

# ─────────────────────────────────────────────────────────────────
# MEET APP BUILD & DEPLOY
# ─────────────────────────────────────────────────────────────────

if [ "$DEPLOY_MEET" = true ]; then

  STEP=$((STEP + 1))
  step $STEP "Building meet app"

  cd "$WEB_REPO"
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install
  MOQT_VERSION=draft-16 pnpm --filter @moq-web/meet build
  pass "Meet app built"

  STEP=$((STEP + 1))
  step $STEP "Deploying meet app to $WEB_HOST"

  ssh -i "$KEY" "ubuntu@$WEB_HOST" "sudo mkdir -p /srv/moq-meet && sudo chown ubuntu:ubuntu /srv/moq-meet"
  scp -i "$KEY" -r "$APP_DIR/dist/"* "ubuntu@$WEB_HOST:/srv/moq-meet/"
  pass "Meet app deployed"
fi

# ─────────────────────────────────────────────────────────────────
# VERIFICATION
# ─────────────────────────────────────────────────────────────────

STEP=$((STEP + 1))
step $STEP "Verifying deployment"

echo ""
echo "  ▸ Relay Service"

RELAY_STATUS=$(ssh -i "$KEY" -o ConnectTimeout=5 "ubuntu@$RELAY_HOST" "systemctl is-active moq-relay" 2>/dev/null || echo "unreachable")
if [ "$RELAY_STATUS" = "active" ]; then
  pass "moq-relay service is active"
else
  fail "moq-relay service status: $RELAY_STATUS"
fi

# Check relay logs for DTS init
info "Checking relay started with DTS..."
DTS_LOG=$(ssh -i "$KEY" "ubuntu@$RELAY_HOST" "journalctl -u moq-relay -n 20 --no-pager 2>/dev/null | grep -i 'dts\|live-view\|Starting' | tail -3" || echo "")
if [ -n "$DTS_LOG" ]; then
  pass "Relay logs show startup"
  echo "        $(echo "$DTS_LOG" | head -1)"
else
  info "Could not read relay logs (may need sudo)"
fi

echo ""
echo "  ▸ Live-View + DTS API"

# Check live-view dashboard
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 "http://$RELAY_HOST:$LIVE_VIEW_PORT/" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  pass "Live-view dashboard reachable (HTTP $HTTP_CODE)"
else
  fail "Live-view dashboard returned HTTP $HTTP_CODE"
fi

# Test DTS budget API
DTS_RESP=$(curl -s --connect-timeout 5 -X POST "http://$RELAY_HOST:$LIVE_VIEW_PORT/dts/budget" \
  -H "Content-Type: application/json" \
  -d '{"budget_kbps": 6000}' 2>/dev/null || echo "")
if echo "$DTS_RESP" | grep -q '"ok":true'; then
  pass "DTS budget API working: $DTS_RESP"
else
  fail "DTS budget API failed: $DTS_RESP"
fi

echo ""
echo "  ▸ Meet App"

MEET_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 "$MEET_URL" 2>/dev/null || echo "000")
if [ "$MEET_CODE" = "200" ]; then
  pass "Meet app reachable (HTTP $MEET_CODE)"
else
  fail "Meet app returned HTTP $MEET_CODE"
fi

# Check that the JS bundle exists and contains simulcast code
JS_BUNDLE=$(curl -s --connect-timeout 5 "$MEET_URL" 2>/dev/null | grep -o 'src="/assets/index-[^"]*"' | head -1 | sed 's/src="//;s/"//')
if [ -n "$JS_BUNDLE" ]; then
  BUNDLE_CODE=$(curl -s --connect-timeout 5 "$MEET_URL$JS_BUNDLE" 2>/dev/null | head -c 50000)
  if echo "$BUNDLE_CODE" | grep -q "switchingSetId\|SWITCHING_SET"; then
    pass "JS bundle contains SSTS/DTS code"
  else
    fail "JS bundle does NOT contain SSTS code — old build?"
  fi
else
  info "Could not locate JS bundle for code check"
fi

# ─────────────────────────────────────────────────────────────────
# SUMMARY
# ─────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════"
if [ "$ERRORS" = "0" ]; then
  echo -e "  ${GREEN}${BOLD}All checks passed!${NC} Ready for demo."
else
  echo -e "  ${RED}${BOLD}$ERRORS check(s) failed.${NC} See above."
fi
echo ""
echo "  URLs:"
echo "    Meet App:    $MEET_URL"
echo "    Live-View:   http://$RELAY_HOST:$LIVE_VIEW_PORT/"
echo "    DTS Budget:  curl -X POST http://$RELAY_HOST:$LIVE_VIEW_PORT/dts/budget -H 'Content-Type: application/json' -d '{\"budget_kbps\": 3000}'"
echo ""
echo "  Testing Steps:"
echo "    1. Open $MEET_URL in Chrome"
echo "    2. Join room 'demo' with Simulcast checked"
echo "    3. Click 'Add Bot' 2-3 times to add synthetic participants"
echo "    4. Use the Bandwidth slider to change budget (6000 → 3000 → 1500)"
echo "    5. Watch quality badges change: green=720p, yellow=360p, red=180p"
echo "    6. Toggle 'Speaker Priority' rank — loudest speaker gets best quality"
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo ""

exit $ERRORS
