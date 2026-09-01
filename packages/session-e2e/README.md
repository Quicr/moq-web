# @moq-web/session-e2e

End-to-end MOQT protocol conformance tests. Runs `@moq-web/session` inside
headless Chromium (via Vitest browser mode + Playwright) against a live
relay. Payloads are ASCII chat only in Phase 1; media (WebCodecs/WebCrypto)
comes in a follow-up package.

## Run

```
RELAY_URL=https://moqx-main.ci.openmoq.org:4433/moq-relay \
MOQ_AUTH_TOKEN=<token> \
  pnpm --filter @moq-web/session-e2e test
```

Both env vars are optional overrides for what's in the profile JSON. `MOQ_AUTH_TOKEN`
is read from the environment and never committed — profiles reference it by name.

## Layout

- `profiles/*.json` — test inputs. `chat-stream.json` and `chat-datagram.json` exercise the two delivery modes.
- `lib/` — session factory, profile loader, chat payload generator, verifiers.
- `tests/NN-*.test.ts` — one file per MOQ API. Every applicable test runs against both profiles via `describe.each`, so both delivery paths get coverage.

Current coverage:

- 01-setup — CLIENT_SETUP / SERVER_SETUP round-trip
- 02-announce — PUBLISH_NAMESPACE ack
- 03-publish — PUBLISH ack + track alias assignment
- 04-subscribe-namespace — SUBSCRIBE_NAMESPACE → incoming-publish fan-out
- 05-subscribe — pub/sub with byte-exact object verification
- 06-subscribe-update — REQUEST_UPDATE pause + resume
- 07-unsubscribe — deliveries stop after unsubscribe
- 08-track-status — TRACK_STATUS query (draft-18)
- 09-fetch — FETCH range retrieval with byte-verify
- 10-fetch-cancel — FETCH then FETCH_CANCEL
- 11-goaway — client-initiated GOAWAY drives 'closing' state (draft-18)

## Profile schema

See `lib/profile.ts` for the full TypeScript definition.
