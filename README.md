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

Implements [draft-ietf-moq-transport](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/):

| Draft | Status | Notes |
|-------|--------|-------|
| Draft-22 | Supported | Build with `MOQT_VERSION=draft-22` |
| Draft-18 | **Default** | Full support |
| Draft-17 | Supported | Included with draft-18 codec path |
| Draft-16 | Supported | Build with `MOQT_VERSION=draft-16` |

Build for a specific draft:

```bash
pnpm run build:draft-18    # default
pnpm run build:draft-16
pnpm run build:draft-22
```

## Architecture

```
┌─────────────────────────────────────────┐
│              Browser                     │
│  ┌───────────────────────────────────┐  │
│  │         @moq-web/client           │  │
│  │        (React UI App)             │  │
│  └─────────────┬─────────────────────┘  │
│                │                         │
│  ┌─────────────▼─────────────────────┐  │
│  │         @moq-web/media            │  │
│  │   (WebCodecs, LOC, Pipelines)     │  │
│  └─────────────┬─────────────────────┘  │
│                │                         │
│  ┌─────────────▼─────────────────────┐  │
│  │        @moq-web/session           │  │
│  │    (Protocol, Subscriptions)      │  │
│  └─────────────┬─────────────────────┘  │
│                │                         │
│  ┌─────────────▼─────────────────────┐  │
│  │         @moq-web/core             │  │
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

## Packages

| Package | Version | Description |
|---------|---------|-------------|
| `@moq-web/core` | 0.2.0 | Protocol types, encoding, state machines, transport |
| `@moq-web/session` | 0.2.0 | MOQT session management, subscriptions, publications |
| `@moq-web/media` | 0.2.0 | WebCodecs, LOC container, media pipelines |
| `@moq-web/cat` | 0.2.0 | Common Authorization Token (CAT) for MOQT auth |
| `@moq-web/secure-objects` | 0.2.0 | End-to-end encryption for MOQT objects |
| `@moq-web/msf` | 0.2.0 | Media Switching Framework |
| `@moq-web/app-kit` | 0.1.0 | High-level React components and helpers |

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
pnpm run test              # Run all tests (draft-18)
pnpm run test:draft-18     # Test with draft-18
pnpm run test:draft-16     # Test with draft-16
pnpm run test:draft-22     # Test with draft-22
```

## License

This project is licensed under [BSD-2-Clause](LICENSE).
