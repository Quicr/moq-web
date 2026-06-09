# MOCHA Infrastructure & Operations Guide

**MOCHA** — MoQ Open Communication & Hosting Architecture

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         mocha.dev (DNS)                              │
│                                                                     │
│  chat.mocha.dev        api.mocha.dev        relay.mocha.dev         │
│  webinar.mocha.dev                                                  │
│       │                     │                      │                │
│       ▼                     ▼                      ▼                │
│  ┌──────────────────────────────┐    ┌─────────────────────────┐   │
│  │  Instance 1 (web/api)        │    │  Instance 2 (relay)     │   │
│  │  t3.medium                   │    │  t3.medium              │   │
│  │                              │    │                         │   │
│  │  Caddy (:443 TCP)            │    │  moq-rs (:443 UDP)     │   │
│  │    chat.mocha.dev → static   │    │    WebTransport (h3)   │   │
│  │    api.mocha.dev → moat:3200 │    │    Raw QUIC (moq-00)   │   │
│  │                              │    │    TLS: Let's Encrypt   │   │
│  │  Moat (:3200 internal)       │    │                         │   │
│  │    Auth (guest, Google)      │    │  certbot (DNS-01)       │   │
│  │    Token minting (ES256)     │    │                         │   │
│  │    Room management           │    │                         │   │
│  └──────────────────────────────┘    └─────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Part 1: Initial Setup (One-Time)

### 1.1 Prerequisites

- AWS account (new or existing)
- Domain name `mocha.dev` registered (Cloudflare Registrar or Namecheap)
- GitHub repo for infrastructure code
- Local tools installed:
  ```bash
  brew install terraform awscli gh jq
  ```

### 1.2 AWS Account Setup

#### Create IAM User for Terraform

1. Log into AWS Console → IAM → Users → Create User
2. User name: `mocha-terraform`
3. Attach policies:
   - `AmazonEC2FullAccess`
   - `AmazonRoute53FullAccess`
   - `SecretsManagerReadWrite`
   - `AmazonVPCFullAccess`
   - `IAMFullAccess` (for instance profiles)
4. Create access key → Download CSV
5. Configure locally:
   ```bash
   aws configure --profile mocha
   # AWS Access Key ID: <from CSV>
   # AWS Secret Access Key: <from CSV>
   # Default region: us-west-2
   # Default output format: json
   ```

#### Create IAM User for GitHub Actions (Deploy)

1. IAM → Users → Create User: `mocha-deploy`
2. Attach policies:
   - `AmazonEC2FullAccess` (for SSH/deploy)
   - `SecretsManagerReadWrite`
3. Create access key → Save for GitHub Secrets

### 1.3 Register Domain & Configure DNS

#### Option A: Cloudflare (recommended for registration)

1. Go to Cloudflare → Registrar → Register `mocha.dev`
2. After purchase, go to DNS settings
3. Change nameservers to AWS Route 53 (we'll manage DNS via Terraform):
   - Route 53 → Create hosted zone: `mocha.dev`
   - Copy the 4 NS records
   - In Cloudflare registrar, set custom nameservers to these 4 values
   - Wait 24-48h for propagation (usually <1h)

#### Option B: Route 53 registration

1. Route 53 → Registered domains → Register domain: `mocha.dev`
2. Follow prompts, hosted zone is auto-created

### 1.4 Create SSH Key Pair

```bash
ssh-keygen -t ed25519 -f ~/.ssh/mocha-deploy -C "mocha-deploy"
# No passphrase (for automation) or use ssh-agent

# Upload public key to AWS
aws ec2 import-key-pair \
  --profile mocha \
  --key-name mocha-deploy \
  --public-key-material fileb://~/.ssh/mocha-deploy.pub \
  --region us-west-2
```

### 1.5 Store Secrets in AWS Secrets Manager

```bash
# Moat ES256 signing key (generate if you don't have one)
openssl ecparam -name prime256v1 -genkey -noout -out moat-signing-key.pem

# Store in Secrets Manager
aws secretsmanager create-secret \
  --profile mocha \
  --name mocha/moat-signing-key \
  --secret-string file://moat-signing-key.pem \
  --region us-west-2

# Store Google OAuth Client Secret (if using Google IdP)
aws secretsmanager create-secret \
  --profile mocha \
  --name mocha/google-oauth \
  --secret-string '{"client_id":"YOUR_ID.apps.googleusercontent.com","client_secret":"YOUR_SECRET"}' \
  --region us-west-2

# Store Moat DB password (if using postgres)
aws secretsmanager create-secret \
  --profile mocha \
  --name mocha/moat-db \
  --secret-string '{"password":"GENERATE_A_STRONG_PASSWORD"}' \
  --region us-west-2

# Clean up local key
rm moat-signing-key.pem
```

### 1.6 Store Deploy Secrets in GitHub

Go to your GitHub repo → Settings → Secrets and variables → Actions:

| Secret name | Value |
|---|---|
| `AWS_ACCESS_KEY_ID` | From `mocha-deploy` IAM user |
| `AWS_SECRET_ACCESS_KEY` | From `mocha-deploy` IAM user |
| `SSH_PRIVATE_KEY` | Contents of `~/.ssh/mocha-deploy` |
| `RELAY_HOST` | `relay.mocha.dev` (set after EC2 is up) |
| `WEB_HOST` | `api.mocha.dev` (set after EC2 is up) |

### 1.7 Terraform Infrastructure

Create `infra/` directory in your repo:

```
infra/
├── main.tf
├── variables.tf
├── outputs.tf
├── vpc.tf
├── instances.tf
├── dns.tf
├── security-groups.tf
└── secrets.tf
```

#### infra/variables.tf
```hcl
variable "aws_region" {
  default = "us-west-2"
}

variable "domain" {
  default = "mocha.dev"
}

variable "key_name" {
  default = "mocha-deploy"
}

variable "web_instance_type" {
  default = "t3.medium"
}

variable "relay_instance_type" {
  default = "t3.medium"
}
```

#### infra/main.tf
```hcl
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket  = "mocha-terraform-state"
    key     = "infra/terraform.tfstate"
    region  = "us-west-2"
    profile = "mocha"
  }
}

provider "aws" {
  region  = var.aws_region
  profile = "mocha"
}
```

#### infra/vpc.tf
```hcl
resource "aws_vpc" "mocha" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = "mocha-vpc" }
}

resource "aws_internet_gateway" "mocha" {
  vpc_id = aws_vpc.mocha.id
  tags   = { Name = "mocha-igw" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.mocha.id
  cidr_block              = "10.0.1.0/24"
  map_public_ip_on_launch = true
  availability_zone       = "${var.aws_region}a"

  tags = { Name = "mocha-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.mocha.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.mocha.id
  }

  tags = { Name = "mocha-public-rt" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}
```

#### infra/security-groups.tf
```hcl
resource "aws_security_group" "web" {
  name   = "mocha-web"
  vpc_id = aws_vpc.mocha.id

  # SSH
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTP (redirect to HTTPS)
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTPS
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "mocha-web-sg" }
}

resource "aws_security_group" "relay" {
  name   = "mocha-relay"
  vpc_id = aws_vpc.mocha.id

  # SSH
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # QUIC/WebTransport (UDP)
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTPS for cert validation (TCP 443 needed for Let's Encrypt HTTP-01)
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "mocha-relay-sg" }
}
```

#### infra/instances.tf
```hcl
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-arm64/ubuntu-noble-24.04-*"]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }
}

resource "aws_eip" "web" {
  domain = "vpc"
  tags   = { Name = "mocha-web-eip" }
}

resource "aws_eip" "relay" {
  domain = "vpc"
  tags   = { Name = "mocha-relay-eip" }
}

resource "aws_instance" "web" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.web_instance_type
  key_name               = var.key_name
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.web.id]
  iam_instance_profile   = aws_iam_instance_profile.mocha.name

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
  }

  tags = { Name = "mocha-web" }
}

resource "aws_instance" "relay" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.relay_instance_type
  key_name               = var.key_name
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.relay.id]
  iam_instance_profile   = aws_iam_instance_profile.mocha.name

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
  }

  tags = { Name = "mocha-relay" }
}

resource "aws_eip_association" "web" {
  instance_id   = aws_instance.web.id
  allocation_id = aws_eip.web.id
}

resource "aws_eip_association" "relay" {
  instance_id   = aws_instance.relay.id
  allocation_id = aws_eip.relay.id
}
```

#### infra/dns.tf
```hcl
data "aws_route53_zone" "mocha" {
  name = var.domain
}

resource "aws_route53_record" "root" {
  zone_id = data.aws_route53_zone.mocha.zone_id
  name    = var.domain
  type    = "A"
  ttl     = 300
  records = [aws_eip.web.public_ip]
}

resource "aws_route53_record" "chat" {
  zone_id = data.aws_route53_zone.mocha.zone_id
  name    = "chat.${var.domain}"
  type    = "A"
  ttl     = 300
  records = [aws_eip.web.public_ip]
}

resource "aws_route53_record" "api" {
  zone_id = data.aws_route53_zone.mocha.zone_id
  name    = "api.${var.domain}"
  type    = "A"
  ttl     = 300
  records = [aws_eip.web.public_ip]
}

resource "aws_route53_record" "relay" {
  zone_id = data.aws_route53_zone.mocha.zone_id
  name    = "relay.${var.domain}"
  type    = "A"
  ttl     = 300
  records = [aws_eip.relay.public_ip]
}

resource "aws_route53_record" "webinar" {
  zone_id = data.aws_route53_zone.mocha.zone_id
  name    = "webinar.${var.domain}"
  type    = "A"
  ttl     = 300
  records = [aws_eip.web.public_ip]
}
```

#### infra/secrets.tf
```hcl
resource "aws_iam_role" "mocha" {
  name = "mocha-instance-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "secrets_access" {
  name = "mocha-secrets-access"
  role = aws_iam_role.mocha.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret"
      ]
      Resource = "arn:aws:secretsmanager:${var.aws_region}:*:secret:mocha/*"
    }]
  })
}

resource "aws_iam_instance_profile" "mocha" {
  name = "mocha-instance-profile"
  role = aws_iam_role.mocha.name
}
```

#### infra/outputs.tf
```hcl
output "web_ip" {
  value = aws_eip.web.public_ip
}

output "relay_ip" {
  value = aws_eip.relay.public_ip
}

output "web_instance_id" {
  value = aws_instance.web.id
}

output "relay_instance_id" {
  value = aws_instance.relay.id
}
```

#### Deploy Terraform

```bash
# Create S3 bucket for state (one-time)
aws s3 mb s3://mocha-terraform-state --profile mocha --region us-west-2

cd infra/
terraform init
terraform plan
terraform apply
```

### 1.8 Provision Web Instance

SSH in and run the setup script:

```bash
ssh -i ~/.ssh/mocha-deploy ubuntu@<web_ip>
```

```bash
#!/bin/bash
# provision-web.sh — run on the web instance

set -euo pipefail

# === System packages ===
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl jq unzip awscli

# === Install Caddy ===
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

# === Create app directories ===
sudo mkdir -p /srv/mocha-chat
sudo mkdir -p /srv/mocha-webinar
sudo mkdir -p /opt/moat
sudo chown ubuntu:ubuntu /srv/mocha-chat /srv/mocha-webinar /opt/moat

# === Fetch secrets from AWS Secrets Manager ===
REGION="us-west-2"

aws secretsmanager get-secret-value \
  --secret-id mocha/moat-signing-key \
  --region $REGION \
  --query SecretString --output text > /opt/moat/signing-key.pem

chmod 600 /opt/moat/signing-key.pem

# === Install Moat binary ===
# (Copy your built moat binary here, or build on-instance)
# scp moat ubuntu@<web_ip>:/opt/moat/moat
chmod +x /opt/moat/moat

# === Caddy configuration ===
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
chat.mocha.dev {
    root * /srv/mocha-chat
    try_files {path} /index.html
    file_server
    encode gzip

    header {
        X-Frame-Options DENY
        X-Content-Type-Options nosniff
        Referrer-Policy strict-origin-when-cross-origin
    }
}

webinar.mocha.dev {
    root * /srv/mocha-webinar
    try_files {path} /index.html
    file_server
    encode gzip
}

api.mocha.dev {
    reverse_proxy localhost:3200

    header {
        Access-Control-Allow-Origin "https://chat.mocha.dev"
        Access-Control-Allow-Methods "GET, POST, OPTIONS"
        Access-Control-Allow-Headers "Content-Type, Authorization"
    }

    @options method OPTIONS
    respond @options 204
}

mocha.dev {
    respond "MOCHA — MoQ Open Communication & Hosting Architecture" 200
}
EOF

# === Moat systemd service ===
sudo tee /etc/systemd/system/moat.service > /dev/null << 'EOF'
[Unit]
Description=Moat Token Service
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/moat
ExecStart=/opt/moat/moat serve \
  --listen 127.0.0.1:3200 \
  --signing-key /opt/moat/signing-key.pem \
  --issuer https://api.mocha.dev
Restart=always
RestartSec=5
Environment="RUST_LOG=info"

[Install]
WantedBy=multi-user.target
EOF

# === Start services ===
sudo systemctl daemon-reload
sudo systemctl enable caddy moat
sudo systemctl start caddy moat

echo "✓ Web instance provisioned"
echo "  - Caddy: serving chat.mocha.dev, api.mocha.dev"
echo "  - Moat: running on :3200"
```

### 1.9 Provision Relay Instance

```bash
ssh -i ~/.ssh/mocha-deploy ubuntu@<relay_ip>
```

```bash
#!/bin/bash
# provision-relay.sh — run on the relay instance

set -euo pipefail

sudo apt update && sudo apt upgrade -y
sudo apt install -y curl jq awscli certbot

# === Create directories ===
sudo mkdir -p /opt/moq-relay
sudo chown ubuntu:ubuntu /opt/moq-relay

# === Get Let's Encrypt cert (standalone HTTP-01) ===
# Port 80 must be open temporarily
sudo certbot certonly --standalone \
  -d relay.mocha.dev \
  --non-interactive \
  --agree-tos \
  --email ops@mocha.dev

# === Install moq-rs relay binary ===
# (Copy your built binary here)
# scp moq-relay ubuntu@<relay_ip>:/opt/moq-relay/moq-relay
chmod +x /opt/moq-relay/moq-relay

# === Fetch Moat public key for token verification ===
REGION="us-west-2"
aws secretsmanager get-secret-value \
  --secret-id mocha/moat-signing-key \
  --region $REGION \
  --query SecretString --output text > /opt/moq-relay/verify-key.pem

# Extract public key from private key
openssl ec -in /opt/moq-relay/verify-key.pem -pubout -out /opt/moq-relay/verify-key-pub.pem
rm /opt/moq-relay/verify-key.pem
chmod 600 /opt/moq-relay/verify-key-pub.pem

# === moq-relay systemd service ===
sudo tee /etc/systemd/system/moq-relay.service > /dev/null << 'EOF'
[Unit]
Description=MoQ Transport Relay
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/moq-relay
ExecStart=/opt/moq-relay/moq-relay \
  --listen 0.0.0.0:443 \
  --cert /etc/letsencrypt/live/relay.mocha.dev/fullchain.pem \
  --key /etc/letsencrypt/live/relay.mocha.dev/privkey.pem \
  --auth-key /opt/moq-relay/verify-key-pub.pem
Restart=always
RestartSec=5
Environment="RUST_LOG=info"
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF

# === Cert auto-renewal ===
sudo tee /etc/systemd/system/certbot-renew.timer > /dev/null << 'EOF'
[Unit]
Description=Certbot renewal timer

[Timer]
OnCalendar=*-*-* 03:00:00
RandomizedDelaySec=3600
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo tee /etc/systemd/system/certbot-renew.service > /dev/null << 'EOF'
[Unit]
Description=Certbot renewal

[Service]
Type=oneshot
ExecStart=/usr/bin/certbot renew --quiet
ExecStartPost=/bin/systemctl restart moq-relay
EOF

# === Start services ===
sudo systemctl daemon-reload
sudo systemctl enable moq-relay certbot-renew.timer
sudo systemctl start moq-relay certbot-renew.timer

echo "✓ Relay instance provisioned"
echo "  - moq-relay: listening on :443 (UDP)"
echo "  - Cert renewal: daily check, auto-restart on renewal"
```

### 1.10 Update Production Environment

Once instances are up, update `.env.production`:

```bash
# apps/mocha-chat/.env.production
VITE_TOKEN_SERVICE_URL=https://api.mocha.dev
VITE_RELAY_URL=https://relay.mocha.dev/moq
VITE_GOOGLE_CLIENT_ID=your-id.apps.googleusercontent.com
```

### 1.11 First Deploy

```bash
# Build
cd apps/mocha-chat
pnpm build

# Deploy
scp -i ~/.ssh/mocha-deploy -r dist/* ubuntu@<web_ip>:/srv/mocha-chat/
```

### 1.12 Verify

```bash
# Check web instance
curl -sI https://chat.mocha.dev       # Should return 200
curl -s https://api.mocha.dev/rooms    # Should return JSON array

# Check relay
# Open browser to https://chat.mocha.dev
# Login → Join channel → Should connect via WebTransport
```

---

## Part 2: Day-to-Day Operations

### 2.1 Deploy App Updates

#### Manual Deploy

```bash
# From local machine
cd apps/mocha-chat
pnpm build
scp -i ~/.ssh/mocha-deploy -r dist/* ubuntu@chat.mocha.dev:/srv/mocha-chat/
```

#### Automated Deploy (GitHub Actions)

Create `.github/workflows/deploy-chat.yml`:

```yaml
name: Deploy mocha-chat

on:
  push:
    branches: [main]
    paths:
      - 'apps/mocha-chat/**'
      - 'packages/mocha/**'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install

      - name: Build mocha-chat
        run: pnpm --filter @web-moq/mocha-chat build
        env:
          VITE_TOKEN_SERVICE_URL: https://api.mocha.dev
          VITE_RELAY_URL: https://relay.mocha.dev/moq
          VITE_GOOGLE_CLIENT_ID: ${{ secrets.GOOGLE_CLIENT_ID }}

      - name: Deploy to server
        uses: appleboy/scp-action@v0.1.7
        with:
          host: ${{ secrets.WEB_HOST }}
          username: ubuntu
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          source: "apps/mocha-chat/dist/*"
          target: "/srv/mocha-chat"
          strip_components: 3
```

### 2.2 Deploy Relay Updates

```bash
# Build moq-rs (on local or CI)
cd /path/to/moq-rs
cargo build --release --target aarch64-unknown-linux-gnu

# Deploy binary
scp -i ~/.ssh/mocha-deploy \
  target/aarch64-unknown-linux-gnu/release/moq-relay \
  ubuntu@relay.mocha.dev:/opt/moq-relay/moq-relay.new

# Swap and restart (brief downtime ~2s)
ssh -i ~/.ssh/mocha-deploy ubuntu@relay.mocha.dev << 'EOF'
sudo systemctl stop moq-relay
mv /opt/moq-relay/moq-relay.new /opt/moq-relay/moq-relay
sudo systemctl start moq-relay
echo "Relay restarted: $(systemctl is-active moq-relay)"
EOF
```

### 2.3 Deploy Moat Updates

```bash
# Build
cd /path/to/moat
cargo build --release --target aarch64-unknown-linux-gnu

# Deploy
scp -i ~/.ssh/mocha-deploy \
  target/aarch64-unknown-linux-gnu/release/moat \
  ubuntu@chat.mocha.dev:/opt/moat/moat.new

ssh -i ~/.ssh/mocha-deploy ubuntu@chat.mocha.dev << 'EOF'
sudo systemctl stop moat
mv /opt/moat/moat.new /opt/moat/moat
sudo systemctl start moat
echo "Moat restarted: $(systemctl is-active moat)"
EOF
```

### 2.4 SSH Access

```bash
# Web instance
ssh -i ~/.ssh/mocha-deploy ubuntu@chat.mocha.dev

# Relay instance
ssh -i ~/.ssh/mocha-deploy ubuntu@relay.mocha.dev
```

### 2.5 View Logs

```bash
# Moat logs
ssh -i ~/.ssh/mocha-deploy ubuntu@chat.mocha.dev \
  "journalctl -u moat -f --no-pager"

# Relay logs
ssh -i ~/.ssh/mocha-deploy ubuntu@relay.mocha.dev \
  "journalctl -u moq-relay -f --no-pager"

# Caddy logs (access + errors)
ssh -i ~/.ssh/mocha-deploy ubuntu@chat.mocha.dev \
  "journalctl -u caddy -f --no-pager"

# Last 100 lines of relay
ssh -i ~/.ssh/mocha-deploy ubuntu@relay.mocha.dev \
  "journalctl -u moq-relay -n 100 --no-pager"
```

### 2.6 Restart Services

```bash
# Single service
ssh -i ~/.ssh/mocha-deploy ubuntu@chat.mocha.dev "sudo systemctl restart moat"
ssh -i ~/.ssh/mocha-deploy ubuntu@chat.mocha.dev "sudo systemctl restart caddy"
ssh -i ~/.ssh/mocha-deploy ubuntu@relay.mocha.dev "sudo systemctl restart moq-relay"

# Check status
ssh -i ~/.ssh/mocha-deploy ubuntu@chat.mocha.dev \
  "systemctl status moat caddy --no-pager"
ssh -i ~/.ssh/mocha-deploy ubuntu@relay.mocha.dev \
  "systemctl status moq-relay --no-pager"
```

### 2.7 Check Certificate Status

```bash
# Relay cert (Let's Encrypt)
ssh -i ~/.ssh/mocha-deploy ubuntu@relay.mocha.dev \
  "sudo certbot certificates"

# Caddy certs (auto-managed, check via Caddy)
ssh -i ~/.ssh/mocha-deploy ubuntu@chat.mocha.dev \
  "curl -s localhost:2019/config/ | jq '.apps.tls'"

# Force renewal (if needed)
ssh -i ~/.ssh/mocha-deploy ubuntu@relay.mocha.dev \
  "sudo certbot renew --force-renewal && sudo systemctl restart moq-relay"
```

### 2.8 Rotate Secrets

#### Rotate Moat Signing Key

```bash
# Generate new key
openssl ecparam -name prime256v1 -genkey -noout -out new-signing-key.pem

# Update in AWS Secrets Manager
aws secretsmanager update-secret \
  --profile mocha \
  --secret-id mocha/moat-signing-key \
  --secret-string file://new-signing-key.pem \
  --region us-west-2

# Deploy to web instance
scp -i ~/.ssh/mocha-deploy new-signing-key.pem ubuntu@chat.mocha.dev:/opt/moat/signing-key.pem
ssh -i ~/.ssh/mocha-deploy ubuntu@chat.mocha.dev "sudo systemctl restart moat"

# Deploy public key to relay
openssl ec -in new-signing-key.pem -pubout -out new-verify-key-pub.pem
scp -i ~/.ssh/mocha-deploy new-verify-key-pub.pem ubuntu@relay.mocha.dev:/opt/moq-relay/verify-key-pub.pem
ssh -i ~/.ssh/mocha-deploy ubuntu@relay.mocha.dev "sudo systemctl restart moq-relay"

# Cleanup
rm new-signing-key.pem new-verify-key-pub.pem
```

### 2.9 Update Environment Variables

```bash
# If you need to change Moat config
ssh -i ~/.ssh/mocha-deploy ubuntu@chat.mocha.dev << 'EOF'
sudo systemctl edit moat
# Add/modify Environment= lines in the override
# Then:
sudo systemctl daemon-reload
sudo systemctl restart moat
EOF
```

### 2.10 Monitor Disk / Memory

```bash
# Quick health check
ssh -i ~/.ssh/mocha-deploy ubuntu@chat.mocha.dev \
  "df -h / && echo '---' && free -h && echo '---' && uptime"

ssh -i ~/.ssh/mocha-deploy ubuntu@relay.mocha.dev \
  "df -h / && echo '---' && free -h && echo '---' && uptime"
```

### 2.11 Manage Rooms/Channels

```bash
# List rooms
curl -s https://api.mocha.dev/rooms | jq

# Create a new room (via Moat API)
curl -s -X POST https://api.mocha.dev/rooms \
  -H "Content-Type: application/json" \
  -d '{"name": "announcements", "namespace_prefix": "mocha/announcements"}' | jq

# Delete a room
curl -s -X DELETE https://api.mocha.dev/rooms/<room-id>
```

### 2.12 Instance Lifecycle

```bash
# Stop instances (save money when not in use)
aws ec2 stop-instances --profile mocha --instance-ids <web_id> <relay_id> --region us-west-2

# Start instances
aws ec2 start-instances --profile mocha --instance-ids <web_id> <relay_id> --region us-west-2
# Note: Elastic IPs remain associated, so DNS still works after restart

# Reboot
aws ec2 reboot-instances --profile mocha --instance-ids <web_id> --region us-west-2
```

### 2.13 Add CORS Origins (for new apps)

When you add `webinar.mocha.dev`, update the Caddyfile:

```bash
ssh -i ~/.ssh/mocha-deploy ubuntu@chat.mocha.dev << 'EOF'
sudo sed -i 's|Access-Control-Allow-Origin "https://chat.mocha.dev"|Access-Control-Allow-Origin "https://chat.mocha.dev, https://webinar.mocha.dev"|' /etc/caddy/Caddyfile
sudo systemctl reload caddy
EOF
```

Or better — switch to dynamic CORS in Caddy that checks against an allowlist.

### 2.14 Backup & Restore

```bash
# Backup Moat DB (if SQLite)
ssh -i ~/.ssh/mocha-deploy ubuntu@chat.mocha.dev \
  "sqlite3 /opt/moat/moat.db '.backup /tmp/moat-backup.db'" && \
scp -i ~/.ssh/mocha-deploy ubuntu@chat.mocha.dev:/tmp/moat-backup.db ./backups/

# Snapshot EC2 volumes (for full instance backup)
aws ec2 create-snapshot --profile mocha --region us-west-2 \
  --volume-id <vol-id> \
  --description "mocha-web-$(date +%Y%m%d)"
```

### 2.15 Troubleshooting Quick Reference

| Symptom | Check |
|---------|-------|
| Chat app won't load | `curl -I https://chat.mocha.dev` — check Caddy |
| Login fails | `journalctl -u moat -n 50` — check Moat logs |
| WebTransport won't connect | Confirm UDP 443 open: `nc -zuv relay.mocha.dev 443` |
| Token rejected by relay | Compare token issuer vs relay's `--auth-key`. Check clock skew. |
| Cert expired | `sudo certbot certificates` on relay; Caddy auto-renews for web |
| Instance unreachable | Check security group, elastic IP, instance state in AWS Console |
| High memory on relay | `journalctl -u moq-relay -n 200` — check for connection leaks |

---

## Part 3: Cost Estimate

| Resource | Monthly |
|----------|---------|
| EC2 t3.medium × 2 (on-demand) | ~$60 |
| Elastic IPs × 2 (while attached) | $0 |
| Route 53 hosted zone | $0.50 |
| Domain (mocha.dev) | ~$1/mo ($12/yr) |
| Data transfer (first 100GB free) | $0 |
| Secrets Manager (3 secrets) | ~$1.20 |
| S3 (terraform state) | ~$0.02 |
| **Total** | **~$63/mo** |

To cut costs during dev: stop instances when not in use (Elastic IPs cost $3.60/mo each when *not* attached to a running instance, so keep them running or release and re-allocate).

---

## Part 4: Adding a New App (e.g., webinar.mocha.dev)

1. Add DNS record (already in Terraform — just `terraform apply`)
2. Add Caddy block:
   ```
   webinar.mocha.dev {
       root * /srv/mocha-webinar
       try_files {path} /index.html
       file_server
       encode gzip
   }
   ```
3. Build and deploy: `scp -r dist/* ubuntu@chat.mocha.dev:/srv/mocha-webinar/`
4. Add CORS origin in the api.mocha.dev block
5. Add Google OAuth origin: `https://webinar.mocha.dev` in Google Console
6. Done — same relay, same Moat, same tokens

---

## Quick Command Cheat Sheet

```bash
# === Deploy ===
pnpm --filter @web-moq/mocha-chat build && scp -i ~/.ssh/mocha-deploy -r apps/mocha-chat/dist/* ubuntu@chat.mocha.dev:/srv/mocha-chat/

# === Logs ===
ssh -i ~/.ssh/mocha-deploy ubuntu@chat.mocha.dev "journalctl -u moat -f"
ssh -i ~/.ssh/mocha-deploy ubuntu@relay.mocha.dev "journalctl -u moq-relay -f"

# === Restart ===
ssh -i ~/.ssh/mocha-deploy ubuntu@chat.mocha.dev "sudo systemctl restart moat caddy"
ssh -i ~/.ssh/mocha-deploy ubuntu@relay.mocha.dev "sudo systemctl restart moq-relay"

# === Status ===
ssh -i ~/.ssh/mocha-deploy ubuntu@chat.mocha.dev "systemctl status moat caddy --no-pager"
ssh -i ~/.ssh/mocha-deploy ubuntu@relay.mocha.dev "systemctl status moq-relay --no-pager"

# === Infra ===
cd infra && terraform plan
cd infra && terraform apply
```
