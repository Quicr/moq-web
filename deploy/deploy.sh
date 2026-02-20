#!/bin/bash
# Deployment script for web-moq with Caddy
# Usage: ./deploy.sh [domain]

set -e

DOMAIN="${1:-localhost}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "=== Web-MoQ Deployment ==="
echo "Domain: $DOMAIN"
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "Error: Docker is not installed. Please install Docker first."
    exit 1
fi

# Export domain for docker-compose
export DOMAIN="$DOMAIN"

# Build and start the container
echo "Building and starting Docker container..."

if command -v docker-compose &> /dev/null; then
    docker-compose up -d --build
else
    docker compose up -d --build
fi

echo ""
echo "=== Deployment Complete ==="
echo ""
if [ "$DOMAIN" = "localhost" ]; then
    echo "Web-MoQ is running at: https://localhost/"
    echo "(You'll need to accept the self-signed certificate warning)"
else
    echo "Web-MoQ is running at: https://$DOMAIN/"
    echo "Caddy will automatically provision Let's Encrypt certificates."
fi
echo ""
echo "Commands:"
echo "  View logs:     docker-compose logs -f"
echo "  Stop:          docker-compose down"
echo "  Restart:       docker-compose restart"
