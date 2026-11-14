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
| Cloudflare | `https://moq-ng.cloudflare.mediaoverquic.com` | d22; d18, d23 experimental |
| Meta (mvfst) | `https://fb.mvfst.net:9448/moq-relay` | d22; d23 experimental |
| lminiero | `https://lminiero.it:9000` | d23 experimental |

As of 2026-11-10 neither Cloudflare nor Meta offers `moqt-23` in
WT-Available-Protocols (offered both, they select `moqt-22`), so draft-23 runs
fail at the WebTransport handshake until the relays add it. Known relay-side
failures on draft-22, also seen on `main`: Cloudflare returns only part of a
large-payload FETCH (09-fetch); Meta does not resume delivery after a
REQUEST_UPDATE resume (06) and misses catalogs in the 4-peer fan-out (32).
On Cloudflare, 06 is flaky under full-suite load (passes when run alone).

lminiero (no path) offers `moqt-23`; as of 2026-11-12 it passes 68 of 75
draft-23 tests. The failures are relay-side: its NAMESPACE omits the Number
of Parameters that draft-23 added (#1858), so the subscriber closes with
PROTOCOL_VIOLATION (04, 30); its FETCH Object ID Delta still uses the
draft-22 rule instead of prior + delta + 2 (#2006), so IDs come out shifted
(34); and it refuses a PUBLISH_NAMESPACE after a PUBLISH of the same
namespace (31, 32, 35 case 3).

A relay's `knownIssues` in `.github/e2e-relays.json` name these gaps: the
report labels a failed test with one when its file matches and its error or
log contains the issue's `match` text.

Both env vars are optional overrides for what's in the profile JSON. `MOQ_AUTH_TOKEN`
is read from the environment and never committed — profiles reference it by name.

## Layout

- `profiles/*.json` — test inputs. `chat-stream.json` and `chat-datagram.json` exercise the two delivery modes.
- `lib/` — session factory, profile loader, chat payload generator, verifiers.
- `lib/record.ts` — `record(task, { flow, expected, inputs, observed })`: the steps a test takes (shown first on the report, with a link to the test's source), what it expects, the inputs it chose and what it saw, for the interop report. Record `observed` before the assertions so a failure still reports it.
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
- 35-publish-forwarding — relay forwards PUBLISH to a namespace subscriber: SUBSCRIBE_NAMESPACE (namespaces only) and SUBSCRIBE_TRACKS (PUBLISH for existing and future tracks), subscribe-first and publish-first, with a plain SUBSCRIBE as control. `MOQ_RELAY_KNOWN_NO_PUBLISH_FWD=1` reports a missing forward without failing
- 36-request-errors — SUBSCRIBE, FETCH, TRACK_STATUS for an unknown track get REQUEST_ERROR with the right code; FETCH past the Largest Object or of an empty track gets INVALID_RANGE
- 37-subscribe-ok-largest — SUBSCRIBE_OK Largest Location before and after Objects are published
- 38-publish-namespace-lifecycle — announce, cancel, re-announce as a namespace subscriber sees it (NAMESPACE, NAMESPACE_DONE, NAMESPACE)
- 39-namespace-prefix-update — REQUEST_UPDATE with TRACK_NAMESPACE_PREFIX moves a SUBSCRIBE_NAMESPACE to a new prefix
- 40-concurrent-requests — stream-credit flow control: requests over the open-stream limit fail cleanly and freed streams are reusable; 150 short-lived streams all deliver
- 41-unknown-parameter — an unknown Message Parameter makes the relay close the session (INVALID_PARAMETER on draft-23)
- 42-fill-subscribe — FILL_PARAMETERS on SUBSCRIBE (last N groups, then live) and on REQUEST_UPDATE (an absolute group range)
- 43-fetch-from-cache — FETCH of whole groups, a partial range, descending order, after the publisher left, and across the live edge (ends at the Largest Object)
- 44-new-group-request — NEW_GROUP_REQUEST reaches the publisher, whose new group reaches the subscriber
- 45-namespace-discovery-flow — SUBSCRIBE_NAMESPACE, PUBLISH_NAMESPACE, SUBSCRIBE by name, late namespace subscriber, PUBLISH_DONE, NAMESPACE_DONE, field-wise prefix matching
- 46-subscribe-tracks-flow — SUBSCRIBE_TRACKS forwards each track and its Objects, PUBLISH_DONE, no echo of own tracks, nothing after the cancel
- 47-goaway-flow — subscriber and publisher GOAWAY mid-delivery: delivery continues, then clean close or PUBLISH_DONE
- 48-track-properties — the publisher's Track Properties in SUBSCRIBE_OK and TRACK_STATUS
- 49-object-properties — unknown Object Properties arrive unchanged on every Object
- 50-setup-options-flow — advertised Setup Options are well formed; MAX_REQUEST_UPDATES outstanding REQUEST_UPDATEs are all answered in order

Tests for draft-18 wire features (08, 11-23, 25-28, 33, 35) run on draft-18 and
later, so draft-22 and draft-23 get them too; on draft-16 they skip. 36-50 run
on draft-22 and later; `lib/flow.ts` has their shared helpers (a per-session
trace of control messages, publishing runs of groups, checked receipt). 34
runs only on draft-23. Everything else runs on every draft. Nightly CI runs the
matrix; locally, override with `MOQT_VERSION=draft-16 pnpm --filter
@moq-web/session-e2e test`.

## Profile schema

See `lib/profile.ts` for the full TypeScript definition.
