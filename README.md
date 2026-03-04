<p align="center">
  <img src="logo.svg" alt="MOQ Web Logo" width="150" height="150">
</p>

<p align="center">
  <a href="https://github.com/Quicr/moq-web/actions/workflows/ci.yml"><img src="https://github.com/Quicr/moq-web/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/Quicr/moq-web/actions/workflows/deploy.yml"><img src="https://github.com/Quicr/moq-web/actions/workflows/deploy.yml/badge.svg?branch=main" alt="Deploy"></a>
</p>

# MOQ Web

A browser-based implementation of Media over QUIC Transport (MOQT) for real-time media streaming.
Built on WebTransport and WebCodecs for low-latency video/audio delivery.

## Quick Start

1. **Install pnpm** (if not installed):
   ```bash
   corepack enable && corepack prepare pnpm@9 --activate
   ```

2. **Install dependencies**:
   ```bash
   pnpm install
   ```

3. **Generate certificates** for local WebTransport:
   ```bash
   ./scripts/create_server_cert.sh
   ```

4. **Build and run**:
   ```bash
   pnpm run build
   pnpm run dev
   ```

5. Open https://localhost:5173

> **Note:** You need a MOQT relay server to connect to. Enable "Local Development" in settings to use self-signed certificates.

## Protocol Support

| Draft | Status | Notes |
|-------|--------|-------|
| Draft-16 | Default | Full support |
| Draft-15 | Included with Draft-16 | ALPN negotiation |
| Draft-14 | Build-time flag | Full support |

Build for draft-14:

```bash
pnpm run build:draft-14
pnpm run dev:draft-14
```

## Architecture

```
┌─────────────────────────────────────────┐
│              Browser                     │
│  ┌───────────────────────────────────┐  │
│  │         @web-moq/client           │  │
│  │        (React UI App)             │  │
│  └─────────────┬─────────────────────┘  │
│                │                         │
│  ┌─────────────▼─────────────────────┐  │
│  │         @web-moq/media            │  │
│  │   (WebCodecs, LOC, Pipelines)     │  │
│  └─────────────┬─────────────────────┘  │
│                │                         │
│  ┌─────────────▼─────────────────────┐  │
│  │        @web-moq/session           │  │
│  │    (Protocol, Subscriptions)      │  │
│  └─────────────┬─────────────────────┘  │
│                │                         │
│  ┌─────────────▼─────────────────────┐  │
│  │         @web-moq/core             │  │
│  │   (Types, Codecs, Transport)      │  │
│  └───────────────────────────────────┘  │
└──────────────────┬──────────────────────┘
                   │ WebTransport
                   ▼
            ┌────────────┐
            │ MOQT Relay │
            └────────────┘
```

For detailed design documentation, see [docs/design.md](docs/design.md).

## Project Structure

```
packages/
├── core       # Protocol types, encoding, state machines, transport
├── session    # MOQT session management, subscriptions, publications
├── media      # WebCodecs, LOC container, media pipelines
└── client     # React web application
```

## Prerequisites

- Node.js 20+
- pnpm 9+ (`corepack enable && corepack prepare pnpm@9 --activate`)

## Using Bun (Alternative)

If you prefer bun over pnpm, use the `bun:` prefixed scripts:

```bash
bun install
bun run bun:build
bun run bun:dev
bun run bun:test
```

## Clean Build

To completely clean and rebuild from scratch:

```bash
# Remove all node_modules and build artifacts
rm -rf node_modules packages/*/node_modules packages/*/dist packages/*/.tsbuildinfo

# Clear pnpm cache
pnpm store prune

# Fresh install and build
pnpm install
pnpm run build
```

One-liner:
```bash
rm -rf node_modules packages/*/node_modules packages/*/dist packages/*/.tsbuildinfo && pnpm store prune && pnpm install && pnpm run build
```

If using bun:
```bash
rm -rf node_modules packages/*/node_modules packages/*/dist packages/*/.tsbuildinfo && bun pm cache rm && bun install && bun run bun:build
```

## Test

```bash
pnpm run test              # Run all tests
pnpm run test:draft-14     # Test with draft-14
```

## License

This project is licensed under [BSD-2-Clause](LICENSE).
