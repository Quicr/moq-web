# Web-MoQ Docker Deployment

Uses [Caddy](https://caddyserver.com/) for automatic HTTPS with Let's Encrypt.

## Quick Start (Local)

```bash
./deploy/deploy.sh localhost
```

Open https://localhost/ (accept the self-signed cert warning).

## Deploy to Remote Server

### 1. Install Docker on server

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in
```

### 2. Copy project to server

```bash
rsync -avz --exclude node_modules --exclude dist --exclude .git \
    ./ user@your-server:/opt/web-moq/
```

### 3. Deploy with your domain

```bash
ssh user@your-server
cd /opt/web-moq
./deploy/deploy.sh your-domain.com
```

**That's it!** Caddy automatically:
- Provisions Let's Encrypt certificates
- Renews certificates before expiry
- Redirects HTTP to HTTPS

### 4. Open firewall ports

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

## Commands

```bash
# View logs
docker-compose logs -f

# Stop
docker-compose down

# Restart
docker-compose restart

# Rebuild after code changes
docker-compose up -d --build
```

## Configuration

Set domain via environment variable:
```bash
DOMAIN=example.com docker-compose up -d
```

Or edit `.env` file:
```
DOMAIN=example.com
```

## Troubleshooting

**Certificate not provisioning?**
- Ensure ports 80 and 443 are open
- Ensure DNS points to your server
- Check logs: `docker-compose logs -f`

**Local development with self-signed cert?**
- Use `localhost` as domain
- Accept the browser security warning
