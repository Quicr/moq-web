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

Results of every run are published to the **interop report**,
<https://quicr.github.io/moq-web/interop/>: the relay × draft matrix, recent
runs, and for each test what it expects, its inputs, what it found, the
failure and the log lines it printed. The page can start a run, re-run failed
jobs, or test a relay of your own.

Relays the nightly matrix runs against are listed in `.github/e2e-relays.json`
(read by `.github/workflows/session-e2e.yml` and by the report page). To add
yours permanently, open a PR adding an entry there; for a one-off run, use
*Test your relay* on the report page or the workflow's `relay_url` input.

| Relay | `RELAY_URL` | Drafts |
|---|---|---|
| openmoq | `https://moqx-main.ci.openmoq.org:4433/moq-relay` | d22, d18, d16 experimental (unreachable from runners as of 2026-11-11) |
| Cloudflare | `https://moq-ng.cloudflare.mediaoverquic.com` | d22; d23 experimental |
| Meta (mvfst) | `https://fb.mvfst.net:9448/moq-relay` | d22; d23 experimental |
| lminiero | `https://lminiero.it:9000` | d23 experimental |

As of 2026-11-10 neither Cloudflare nor Meta offers `moqt-23` in
WT-Available-Protocols (offered both, they select `moqt-22`), so draft-23 runs
fail at the WebTransport handshake until the relays add it. Known relay-side
failures on draft-22, also seen on `main`: Cloudflare returns only part of a
large-payload FETCH (09-fetch); Meta does not resume delivery after a
REQUEST_UPDATE resume (06) and misses catalogs in the 4-peer fan-out (32).
On Cloudflare, 06 is flaky under full-suite load (passes when run alone).

lminiero (no path) offers `moqt-23`; as of 2026-11-11 it passes 64 of 70
draft-23 tests. The failures are relay-side: its NAMESPACE omits the Number
of Parameters that draft-23 added (#1858), so the subscriber closes with
PROTOCOL_VIOLATION (04, 30, 31, 32); and its FETCH Object ID Delta still uses
the draft-22 rule instead of prior + delta + 2 (#2006), so IDs come out shifted
(34).

Both env vars are optional overrides for what's in the profile JSON. `MOQ_AUTH_TOKEN`
is read from the environment and never committed — profiles reference it by name.

## Layout

- `profiles/*.json` — test inputs. `chat-stream.json` and `chat-datagram.json` exercise the two delivery modes.
- `lib/` — session factory, profile loader, chat payload generator, verifiers.
- `lib/record.ts` — `record(task, { expected, inputs, observed })`: what a test expects, the inputs it chose and what it saw, for the interop report. Record `observed` before the assertions so a failure still reports it.
- `lib/report-reporter.ts` — with `E2E_REPORT=<path>`, writes the run as JSON: each file's header comment as its description, and each test's state, record, failure and last log lines (auth token redacted).
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
