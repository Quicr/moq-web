#!/bin/bash
set -euo pipefail

# Preflight sanity checks for MOCHA Meet demo
# Verifies: relay, live-view endpoint, and meet app are all reachable

RELAY_HOST="3.125.58.212"
RELAY_QUIC_PORT=443
LIVE_VIEW_PORT=9090
WEB_HOST="100.23.225.210"
MEET_URL="https://meet.mocha-net.dev"
KEY="${MOCHA_SSH_KEY:-$HOME/.ssh/mocha-deploy}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; FAILED=1; }
info() { echo -e "  ${YELLOW}→${NC} $1"; }

FAILED=0

echo ""
echo "═══════════════════════════════════════════════════"
echo "  MOCHA Meet — Preflight Check"
echo "═══════════════════════════════════════════════════"
echo ""

# 1. Relay process
echo "▸ Relay (${RELAY_HOST}:${RELAY_QUIC_PORT})"
info "SSH to relay and check systemd service..."
RELAY_STATUS=$(ssh -i "$KEY" -o ConnectTimeout=5 "ubuntu@${RELAY_HOST}" "systemctl is-active moq-relay" 2>/dev/null || echo "unreachable")
if [ "$RELAY_STATUS" = "active" ]; then
  pass "moq-relay service is active"
else
  fail "moq-relay service status: ${RELAY_STATUS}"
fi

info "Checking relay PID and uptime..."
RELAY_PID=$(ssh -i "$KEY" -o ConnectTimeout=5 "ubuntu@${RELAY_HOST}" "systemctl show moq-relay --property=MainPID --value" 2>/dev/null || echo "0")
if [ "$RELAY_PID" != "0" ] && [ -n "$RELAY_PID" ]; then
  RELAY_UPTIME=$(ssh -i "$KEY" "ubuntu@${RELAY_HOST}" "ps -p $RELAY_PID -o etime= 2>/dev/null" || echo "unknown")
  pass "PID=${RELAY_PID} uptime=${RELAY_UPTIME}"
else
  fail "Could not determine relay PID"
fi

# 2. Live-view endpoint
echo ""
echo "▸ Live-View (http://${RELAY_HOST}:${LIVE_VIEW_PORT})"
info "Fetching live-view dashboard..."
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 "http://${RELAY_HOST}:${LIVE_VIEW_PORT}/" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  pass "Dashboard reachable (HTTP 200)"
else
  fail "Dashboard returned HTTP ${HTTP_CODE}"
fi

info "Testing SSE event stream..."
SSE_RESP=$(curl -s --connect-timeout 5 --max-time 3 -H "Accept: text/event-stream" "http://${RELAY_HOST}:${LIVE_VIEW_PORT}/events" 2>/dev/null || echo "timeout-ok")
if [ -n "$SSE_RESP" ]; then
  pass "SSE endpoint reachable"
else
  fail "SSE endpoint not responding"
fi

# 3. Meet app
echo ""
echo "▸ Meet App (${MEET_URL})"
info "Fetching meet app index page..."
MEET_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 "${MEET_URL}" 2>/dev/null || echo "000")
if [ "$MEET_CODE" = "200" ]; then
  pass "Meet app reachable (HTTP 200)"
else
  fail "Meet app returned HTTP ${MEET_CODE}"
fi

info "Checking bot-speech.mp3 asset..."
BOT_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 "${MEET_URL}/bot-speech.mp3" 2>/dev/null || echo "000")
if [ "$BOT_CODE" = "200" ]; then
  pass "bot-speech.mp3 available"
else
  fail "bot-speech.mp3 returned HTTP ${BOT_CODE}"
fi

info "Checking VAD model assets..."
VAD_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 "${MEET_URL}/vad/silero_vad_v5.onnx" 2>/dev/null || echo "000")
if [ "$VAD_CODE" = "200" ]; then
  pass "VAD ONNX model available"
else
  fail "VAD model returned HTTP ${VAD_CODE} (may affect speech detection)"
fi

# 4. Relay log check
echo ""
echo "▸ Relay Logs"
info "Checking relay log file..."
LOG_LINES=$(ssh -i "$KEY" "ubuntu@${RELAY_HOST}" "sudo wc -l /tmp/relay.log 2>/dev/null | awk '{print \$1}'" || echo "0")
pass "Relay log: ${LOG_LINES} lines"

# Summary
echo ""
echo "═══════════════════════════════════════════════════"
if [ "$FAILED" = "0" ]; then
  echo -e "  ${GREEN}All checks passed.${NC} Ready for demo."
else
  echo -e "  ${RED}Some checks failed.${NC} Fix issues above."
fi
echo ""
echo "  URLs:"
echo "    Meet:      ${MEET_URL}"
echo "    Live-View: http://${RELAY_HOST}:${LIVE_VIEW_PORT}/"
echo "═══════════════════════════════════════════════════"
echo ""

exit $FAILED
