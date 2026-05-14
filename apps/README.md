# MoQ Web Apps

Standalone demo applications for Media over QUIC Transport built over packages from moq-web.

Each app is a self-contained web application that can be built and deployed independently. Apps are intended to demonstrate, test, or benchmark specific aspects of MoQ protocols and formats.

## Apps

### msf-compression-benchmark

Benchmark tool for testing GZIP compression effectiveness on MSF catalogs, media timelines, and event timelines.

**Packages used:** None (standalone, uses browser-native CompressionStream API)

## Development

From the repo root:

```bash
# Install dependencies
pnpm install

# Run a specific app in dev mode
cd apps/<app-name>
pnpm dev
```

The dev server will display the URL to access the app (e.g., `http://localhost:5173/apps/<app-name>/`).

To view the apps landing page, open `apps/index.html` directly in a browser or serve it via a local HTTP server.

## Adding a new app

1. Create a new folder under `apps/`
2. Add a `package.json` with the app name following the pattern `@web-moq/<app-name>`
3. Add the app to the landing page (`apps/index.html`)
