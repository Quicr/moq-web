# MSF Compression Benchmark

A web-based tool for benchmarking GZIP compression effectiveness on MSF (MOQT Streaming Format) JSON payloads.

## Purpose

This tool helps evaluate whether compression is worthwhile for different MSF data types:

- **Catalogs** - Track metadata with optional initialization data
- **Media Timelines** - Seek/random access data in explicit or template format
- **Event Timelines** - Ad-hoc event metadata (sports scores, GPS, active speaker, etc.)

## Features

- Generate synthetic MSF payloads with configurable parameters
- Test compression on custom JSON input
- View compression ratio and savings percentage
- Compare results across different payload sizes and formats

## Usage

```bash
pnpm install
pnpm dev
```

Open the displayed URL (e.g., `http://localhost:5173/apps/msf-compression-benchmark/`).

## Technical Details

Uses the browser-native `CompressionStream` API for GZIP compression. No server-side processing required.

## Packages Used

- `@moq-web/msf` - Catalog builder (`createCatalog`), media timeline serializer (`serializeMediaTimeline`), event timeline serializer (`serializeEventTimeline`)

## Related

- [MSF Specification](https://datatracker.ietf.org/doc/draft-ietf-moq-msf/)
- [MSF Compression Property](https://datatracker.ietf.org/doc/draft-ietf-moq-msf/#section-13.1)
