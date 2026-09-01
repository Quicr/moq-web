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

## Profile schema

See `lib/profile.ts` for the full TypeScript definition.
