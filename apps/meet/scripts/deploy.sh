#!/bin/bash
set -euo pipefail

# Deploy MOQ Meet app to mocha-net.dev web server
# Uses the webinar.mocha-net.dev slot in Caddy

WEB_HOST="${MOCHA_WEB_HOST:-100.23.225.210}"
KEY="${MOCHA_SSH_KEY:-$HOME/.ssh/mocha-deploy}"
DEPLOY_DIR="/srv/moq-meet"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"

echo "=== Deploying MOQ Meet ==="

# Step 1: Build the app
echo "[1/3] Building meet app..."
cd "$REPO_ROOT"
MOQT_VERSION=draft-16 pnpm --filter @moq-web/meet build

# Step 2: Create deploy dir on remote if needed
echo "[2/3] Preparing remote directory..."
ssh -i "$KEY" "ubuntu@$WEB_HOST" "sudo mkdir -p $DEPLOY_DIR && sudo chown ubuntu:ubuntu $DEPLOY_DIR"

# Step 3: Deploy
echo "[3/3] Deploying to $WEB_HOST:$DEPLOY_DIR..."
scp -i "$KEY" -r "$APP_DIR/dist/"* "ubuntu@$WEB_HOST:$DEPLOY_DIR/"

echo ""
echo "Done! Meet app deployed to https://meet.mocha-net.dev"
echo ""
echo "NOTE: You need to add a Caddy site block for meet.mocha-net.dev"
echo "and a DNS record. See instructions below."
echo ""
cat << 'INSTRUCTIONS'
--- ONE-TIME SETUP (if not already done) ---

1. Add DNS record:
   aws route53 change-resource-record-sets --profile mocha --hosted-zone-id Z0266168Z19ONTNCUE5O --change-batch '{
     "Changes": [{"Action": "UPSERT", "ResourceRecordSet": {
       "Name": "meet.mocha-net.dev", "Type": "A", "TTL": 300,
       "ResourceRecords": [{"Value": "100.23.225.210"}]
     }}]
   }'

2. Add Caddy site block (SSH to web host and edit /etc/caddy/Caddyfile):
   meet.mocha-net.dev {
       root * /srv/moq-meet
       try_files {path} /index.html
       file_server
       encode gzip
   }

3. Reload Caddy:
   sudo systemctl reload caddy

INSTRUCTIONS
