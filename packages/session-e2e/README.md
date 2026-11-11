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

Relays the nightly matrix runs against (`.github/workflows/session-e2e.yml`):

| Relay | `RELAY_URL` | Drafts |
|---|---|---|
| openmoq | `https://moqx-main.ci.openmoq.org:4433/moq-relay` | d22, d18, d16 |
| Cloudflare | `https://moq-ng.cloudflare.mediaoverquic.com` | d22; d23 experimental |
| Meta (mvfst) | `https://fb.mvfst.net:9448/moq-relay` | d22; d23 experimental |

As of 2026-11-10 neither Cloudflare nor Meta offers `moqt-23` in
WT-Available-Protocols (offered both, they select `moqt-22`), so draft-23 runs
fail at the WebTransport handshake until the relays add it. Known relay-side
failures on draft-22, also seen on `main`: Cloudflare returns only part of a
large-payload FETCH (09-fetch); Meta does not resume delivery after a
REQUEST_UPDATE resume (06) and misses catalogs in the 4-peer fan-out (32).
On Cloudflare, 06 is flaky under full-suite load (passes when run alone).

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
- 06-subscribe-update — SUBSCRIBE_UPDATE / REQUEST_UPDATE pause + resume
- 29-subscribe-update-multi-track — pause on one subscription must not stall other publications in the same session
- 07-unsubscribe — deliveries stop after unsubscribe
- 08-track-status — TRACK_STATUS query (draft-18)
- 09-fetch — FETCH range retrieval with byte-verify
- 10-fetch-cancel — FETCH then FETCH_CANCEL
- 11-goaway — client-initiated GOAWAY drives 'closing' state (draft-18)

Tests for draft-18 wire features (08, 11-23, 25-28, 33) run on draft-18 and
later, so draft-22 and draft-23 get them too; on draft-16 they skip. 34 runs
only on draft-23. Everything else runs on every draft. Nightly CI runs the
matrix; locally, override with `MOQT_VERSION=draft-16 pnpm --filter
@moq-web/session-e2e test`.

## Profile schema

See `lib/profile.ts` for the full TypeScript definition.
