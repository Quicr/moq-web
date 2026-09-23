#!/usr/bin/env bash
set -euo pipefail

# Deploy moq-chat to snk-dev-1-m01x.org
# Run from repo root: ./apps/moq-chat/deploy/deploy.sh

SERVER="snk-dev-1-m01x.org"
DEPLOY_DIR="/opt/moq-chat"

echo "==> Building SPA..."
cd apps/moq-chat
pnpm install
pnpm build

echo "==> Syncing to server..."
rsync -avz --delete dist/ "${SERVER}:${DEPLOY_DIR}/dist/"
rsync -avz server/ "${SERVER}:${DEPLOY_DIR}/server/"
rsync -avz deploy/nginx-moq-chat.conf "${SERVER}:/etc/nginx/sites-available/moq-chat.conf"

echo "==> Configuring server..."
ssh "${SERVER}" << 'REMOTE'
  # Symlink nginx config
  ln -sf /etc/nginx/sites-available/moq-chat.conf /etc/nginx/sites-enabled/
  nginx -t && systemctl reload nginx

  # Install/restart token service
  cp /opt/moq-chat/server/../deploy/moq-chat-token.service /etc/systemd/system/ 2>/dev/null || true
  systemctl daemon-reload
  systemctl enable moq-chat-token
  systemctl restart moq-chat-token

  echo "Token service status:"
  systemctl status moq-chat-token --no-pager -l
REMOTE

echo "==> Done! App live at https://${SERVER}"
