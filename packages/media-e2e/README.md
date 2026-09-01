# @moq-web/media-e2e

End-to-end MOQT media tests. Runs `@moq-web/media` inside headless Chromium
(via Vitest browser mode + Playwright) against a live relay, exercising the
full WebCodecs encode → LOC → MOQT → LOC decode → WebCodecs decode pipeline.

## Run

```
RELAY_URL=https://moqx-main.ci.openmoq.org:4433/moq-relay \
MOQ_AUTH_TOKEN=<token> \
  pnpm --filter @moq-web/media-e2e test
```

Both env vars are optional overrides for what's in the profile JSON.

## Layout

- `profiles/*.json` — track specs (dimensions, framerate, bitrate, delivery mode).
- `lib/session-factory.ts` — connects a MOQTSession and wraps it in a MediaSession.
- `lib/synthetic-source.ts` — canvas-driven MediaStream so tests don't need real hardware.
- `tests/NN-*.test.ts` — one file per scenario.

Current coverage:

- 01-video-roundtrip — publisher pushes a synthetic canvas through the full media pipeline; subscriber receives decoded VideoFrames from a live relay.
