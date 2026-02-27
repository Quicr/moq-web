# Build stage
FROM oven/bun:latest AS builder

WORKDIR /app

# Copy package files
COPY package.json bun.lockb ./
COPY packages/core/package.json ./packages/core/
COPY packages/session/package.json ./packages/session/
COPY packages/media/package.json ./packages/media/
COPY packages/client/package.json ./packages/client/

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY packages/ ./packages/
COPY tsconfig.json ./

# Build for draft-16
ENV MOQT_VERSION=draft-16
RUN bun run build

# Production stage - Caddy for automatic HTTPS
FROM caddy:alpine

# Copy built client files
COPY --from=builder /app/packages/client/dist /srv

# Copy Caddyfile
COPY Caddyfile /etc/caddy/Caddyfile

EXPOSE 80 443

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile"]
