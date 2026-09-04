# MOQ Transport Draft-18 Feature Audit

**Repository:** `Quicr/moq-web`
**Spec:** `draft-ietf-moq-transport-18` (January 2026)
**Audit date:** 2026-09-03
**Branch reviewed:** `main` (after PR #35)

<!-- audit-progress:begin -->
**Progress:** ✅ 49 · 🟡 17 · ❌ 14 · **61% complete** of 80 features
<!-- audit-progress:end -->

> This is a **living document**. Regenerate the progress line with `scripts/audit-progress.sh -w`. Each row's Status column is the source of truth — update it as features land.

---

## Legend

- **Status**
  - ✅ **Complete** — implemented end-to-end with tests.
  - 🟡 **Partial** — some layer (wire, session, or test) present, others missing or stubbed.
  - ❌ **Missing** — not implemented.
  - **N/A** — does not apply to this client.
- **Locations** use `file:line` format, resolved from repo root.

---

## Session / Framing (§3)

| Feature | §Spec | Wire encode | Wire decode | Session-layer | Unit test | E2E test | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| Session establishment via WebTransport | §3.1.3 | `session.ts:1053-1082` | `draft18-message-codec.ts:236-247` | `session.ts:1053` (`setup()`) | `draft18-message-codec.test.ts:34-82` | `01-setup.test.ts` | ✅ | WebTransport-only client. |
| MOQT URI scheme (`moqt://`) | §3.1.1 | — | — | MISSING | MISSING | MISSING | ❌ | No scheme validation; callers pass `https://` URLs. |
| Native QUIC transport | §3.1.4 | — | — | MISSING | MISSING | MISSING | ❌ | Browser-only; native QUIC path not applicable. |
| Session termination | §3.5 | `session.ts:4257+` | via setup reader `session.ts:4297+` | state machine `setState('closing')` | MISSING | `11-goaway.test.ts` (partial) | 🟡 | No distinct session-error path using `SessionErrorCodeDraft18`. |
| GOAWAY handling | §10.4 | `draft18-message-codec.ts:852-859` | `draft18-message-codec.ts:861-873` | `session.ts:1137`, `session.ts:4846-4858` | `draft18-message-codec.test.ts:354-402, 732-767` | `11-goaway.test.ts` | ✅ | Both control-stream & request-stream variants; no migration handler. |
| Migration | §3.6 | — | — | MISSING | MISSING | MISSING | ❌ | `newSessionUri` event surfaced but no reconnect logic. |
| Congestion control | §3.7 | — | — | `transport.ts:91-92,153,230` (`congestionControl` option) | MISSING | MISSING | 🟡 | Sets WebTransport `default`/`throughput` hint only; no bufferbloat/app-limited logic. |

## Extension Negotiation (§3.2, §4)

| Feature | §Spec | Wire encode | Wire decode | Session-layer | Unit test | E2E test | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| Extension advertisement in SETUP | §3.2 | `draft18-message-codec.ts:273-333` | `draft18-message-codec.ts:339-397` | fixed option set (`session.ts:1063-1082`) | `draft18-message-codec.test.ts:34-82` | `01-setup.test.ts` | 🟡 | Unknown options skipped on decode, no API to advertise custom extensions. |
| Reserved namespaces | §3.2.1 | — | — | MISSING | MISSING | MISSING | ❌ | No enforcement of `moq-ext` reserved namespace. |

## Control Messages (§10.3–10.20)

| Feature | §Spec | Wire encode | Wire decode | Session-layer | Unit test | E2E test | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| SETUP (CLIENT_SETUP + SERVER_SETUP) | §10.3 | `draft18-message-codec.ts:273-334` | `draft18-message-codec.ts:339-397` | `session.ts:1063-1090`, `session.ts:4257-4360` | `draft18-message-codec.test.ts:34-82` | `01-setup.test.ts` | ✅ | Unified message. |
| GOAWAY | §10.4 | `draft18-message-codec.ts:852-859` | `draft18-message-codec.ts:861-873` | `session.ts:1137`, `session.ts:4846` | `draft18-message-codec.test.ts:354-402` | `11-goaway.test.ts` | ✅ | Golden-byte tests present. |
| REQUEST_OK | §10.5 | `draft18-message-codec.ts:680-690` | `draft18-message-codec.ts:692-716` | `session.ts:4624-4671` | `draft18-message-codec.test.ts:258-286, 768-777` | Indirect (03/05/09) | ✅ | Includes optional `expires` parameter. |
| REQUEST_ERROR (+ Redirect §10.6.1) | §10.6 | `draft18-message-codec.ts:627-671` | `draft18-message-codec.ts:645-678` | `session.ts:4871-4899` | `draft18-message-codec.test.ts:173-257` | Implicit (`08-track-status`) | ✅ | Redirect struct roundtrips; `retry_interval` decoded but ignored. |
| SUBSCRIBE | §10.7 | `draft18-message-codec.ts:403-452` | `draft18-message-codec.ts:454-500` | `session.ts:1443-1561`, `session.ts:4508-4583` | `draft18-message-codec.test.ts:84-146` | `05-subscribe.test.ts` | ✅ | Public API only uses `NEXT_GROUP_START`; `ABSOLUTE_RANGE` codec-only. |
| SUBSCRIBE_OK | §10.8 | `draft18-message-codec.ts:502-523` | `draft18-message-codec.ts:525-561` | `session.ts:1527-1548` | `draft18-message-codec.test.ts:129-147` | `05-subscribe.test.ts` | ✅ | Track properties encoded as generic KVP; no key-specific validation. |
| REQUEST_UPDATE (§10.9.1 + §10.9.2) | §10.9 | `draft18-message-codec.ts:934-954` | `draft18-message-codec.ts:956-984` | `session.ts:1283-1323` (send); `session.ts` `dispatchRequestUpdateDraft18` routes to `forward-paused`/`-resumed` (§10.9.1) or `namespace-forward-paused`/`-resumed` (§10.9.2) via `incomingRequestKinds` lookup | `draft18-message-codec.test.ts:519-566` | `06-subscribe-update.test.ts` | ✅ | Inbound REQUEST_UPDATE is dispatched to typed events per variant; namespace-scoped updates emit `NamespaceForwardEvent`. |
| PUBLISH | §10.10 | `draft18-message-codec.ts:563-587` | `draft18-message-codec.ts:590-624` | `session.ts:1563-1612`, `session.ts:4585-4671` | `draft18-message-codec.test.ts:148-172` | `03-publish.test.ts` | ✅ | |
| PUBLISH_DONE | §10.11 | `draft18-message-codec.ts:908-913` | `draft18-message-codec.ts:915-932` | `session.ts` send (`sendPublishDone`), recv emits `publish-done` (finalGroup/Object, statusCode, reason, streamCount) | `draft18-message-codec.test.ts:479-517` | MISSING | ✅ | Typed `PublishDoneEvent` includes optional `PublishDoneErrorCodeDraft18` status. |
| FETCH (standalone §10.12.1) | §10.12 | `draft18-message-codec.ts:721-754` | `draft18-message-codec.ts:756-809` | `session.ts:1777-1867` | `draft18-message-codec.test.ts:287-333` | `09-fetch.test.ts` | ✅ | `endLocation = endObject + 1` (exclusive). |
| FETCH — Joining relative (type 0x2) | §10.12.2 | `draft18-message-codec.ts:722-751` | `draft18-message-codec.ts:770-838` | `session.ts:1807-1897` (via `FetchOptions.fetchType`) | `draft18-message-codec.test.ts` | MISSING | ✅ | `FetchTypeDraft18` enum distinguishes 0x1/0x2/0x3; session API accepts `fetchType`, `subscribeRequestId`, `joiningStart`. |
| FETCH — Joining absolute (type 0x3) | §10.12.2 | `draft18-message-codec.ts:722-751` | `draft18-message-codec.ts:770-838` | `session.ts:1807-1897` (via `FetchOptions.fetchType`) | `draft18-message-codec.test.ts` | MISSING | ✅ | Codec validates fetchType and throws `Draft18CodecError` on invalid; session API supports both variants. |
| Fetch cancellation | §10.12 / §3.3.2 | `session.ts:1885` (via REQUEST_UPDATE with `forwardState=false`) | — | `session.ts:1871-1911` (`cancelFetch`) | MISSING | `10-fetch-cancel.test.ts` | ✅ | Draft-18 removed FETCH_CANCEL; uses REQUEST_UPDATE. |
| FETCH_OK | §10.13 | `draft18-message-codec.ts:811-819` | `draft18-message-codec.ts:821-849` | `session.ts:1820-1840` | `draft18-message-codec.test.ts:335-353` | `09-fetch.test.ts` | ✅ | |
| TRACK_STATUS | §10.14 | `draft18-message-codec.ts:875-881` | `draft18-message-codec.ts:883-906` | `session.ts:1165-1201`, `session.ts:4686-4700` (log-only) | `draft18-message-codec.test.ts:404-422` | `08-track-status.test.ts` | 🟡 | Response via REQUEST_OK/REQUEST_ERROR; incoming request stub only. |
| PUBLISH_NAMESPACE | §10.15 | `draft18-message-codec.ts:986-991` | `draft18-message-codec.ts:993-1014` | `session.ts:2713-2743`, `session.ts:4745-4767` | `draft18-message-codec.test.ts:568-599` | `02-announce.test.ts` | ✅ | Parameters map always encoded empty; auth-token push ignored. |
| NAMESPACE | §10.16 | `draft18-message-codec.ts:1046-1051` | `draft18-message-codec.ts:1053-1068` | `session.ts:2328-2345`, `session.ts:4725` | `draft18-message-codec.test.ts:619-650` | `04-subscribe-namespace.test.ts` | ✅ | |
| NAMESPACE_DONE | §10.17 | `draft18-message-codec.ts:1070-1072` | `draft18-message-codec.ts:1074-1085` | `session.ts:2347-2361`, `session.ts:4734` | `draft18-message-codec.test.ts:652-666` | MISSING | 🟡 | No e2e; codec emits final namespace only. |
| SUBSCRIBE_NAMESPACE | §10.18 | `draft18-message-codec.ts:1016-1021` | `draft18-message-codec.ts:1023-1044` | `session.ts:2178-2222`, `session.ts:4702-4744` | `draft18-message-codec.test.ts:601-618` | `04-subscribe-namespace.test.ts` | ✅ | Parameters always empty on encode. |
| SUBSCRIBE_TRACKS | §10.19 | `draft18-message-codec.ts:1087-1092` | `draft18-message-codec.ts:1094-1117` | `session.ts:1212-1256`, `session.ts:4771-4806` (stub) | `draft18-message-codec.test.ts:668-706` | MISSING | 🟡 | Encoder emits only prefix + empty params; no filter/startLocation/pattern. |
| PUBLISH_BLOCKED | §10.20 | `draft18-message-codec.ts:1119-1121` | `draft18-message-codec.ts:1123-1134` | `session.ts` recv emits `PublishBlockedEvent` | `draft18-message-codec.test.ts:707-729, 778-787` | MISSING | 🟡 | Typed event now surfaced; send helper still missing. |

## Parameters (§10.2)

| Feature | §Spec | Wire encode | Wire decode | Session-layer | Unit test | E2E test | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| AUTHORIZATION_TOKEN | §10.2.2 | Setup: `draft18-message-codec.ts:288-296`; request: via `MessageCodec.encodeAuthorizationToken` `message-codec.ts:602-641` | `draft18-message-codec.ts:362-366` (SETUP); request skips value `:1226-1232` | `session.ts:309-315, 436-475, 1091-1098` | Setup path in `draft18-message-codec.test.ts:46-82` | MISSING | 🟡 | Token aliasing in shared codec; not wired into draft-18 decoder path. |
| SUBGROUP_DELIVERY_TIMEOUT | §10.2.3 | `draft18-message-codec.ts:445-449, 763-767` (SUBSCRIBE + FETCH raw params) | `:484-487, 815-830` (delta-decoded into `parameters` map) | `session.ts` `addDeliveryTimeoutParams` → `SubscribeOptions.subgroupDeliveryTimeout` / `FetchOptions.subgroupDeliveryTimeout` | `draft18-message-codec.test.ts` SUBSCRIBE + FETCH roundtrip | MISSING | ✅ | Subscriber-side timeout wired end-to-end via §10.2 request parameters. |
| OBJECT_DELIVERY_TIMEOUT | §10.2.4 | `draft18-message-codec.ts:445-449, 763-767` | `:484-487, 815-830` | `session.ts` `addDeliveryTimeoutParams` → `SubscribeOptions.objectDeliveryTimeout` / `FetchOptions.objectDeliveryTimeout` | `draft18-message-codec.test.ts` SUBSCRIBE + FETCH roundtrip | MISSING | ✅ | Subscriber-side per-object delivery timeout as varint request parameter. |
| FILL_TIMEOUT | §10.2.5 | `draft18-message-codec.ts:445-449, 763-767` | `:484-487, 815-830` | `session.ts` `addDeliveryTimeoutParams` → `SubscribeOptions.fillTimeout` / `FetchOptions.fillTimeout` | `draft18-message-codec.test.ts` SUBSCRIBE + FETCH roundtrip | MISSING | ✅ | Subscriber-side missing-object wait timeout. |
| RENDEZVOUS_TIMEOUT | §10.2.6 | `draft18-message-codec.ts:445-449, 763-767` | `:484-487, 815-830` | `session.ts` `addDeliveryTimeoutParams` → `SubscribeOptions.rendezvousTimeout` / `FetchOptions.rendezvousTimeout` | `draft18-message-codec.test.ts` SUBSCRIBE + FETCH roundtrip | MISSING | ✅ | Subscriber-side cutover-wait timeout for new subscribers. |
| SUBSCRIBER_PRIORITY | §10.2.7 | `draft18-message-codec.ts:743, 449` | `:788, 484-486` | `session.ts:1460, 1794, 2494` | Roundtrip | Indirect | ✅ | Values pass through; not used for local scheduling. |
| GROUP_ORDER | §10.2.8 | `:749, 445` | `:790-791, 490-492` | `session.ts:1795` etc. | Roundtrip | Indirect | ✅ | |
| SUBSCRIPTION_FILTER | §10.2.9 | Inline in SUBSCRIBE `:423-449` | `:471-497` | `session.ts:1509` (hardcoded NEXT_GROUP_START) | `test.ts:107-127` | MISSING | 🟡 | Other filters codec-only. |
| EXPIRES | §10.2.10 | `:685` (REQUEST_OK), `:1209` | `:703-705` | `session.ts` REQUEST_OK sites emit `request-ok` with `expiresMs` (PUBLISH, PUBLISH_NAMESPACE, FETCH, SUBSCRIBE_NAMESPACE, TRACK_STATUS) | `test.ts:272-286` | MISSING | ✅ | Surface via `RequestOkEvent`; undefined = parameter omitted, 0 = no expiration. |
| LARGEST_OBJECT | §10.2.11 | `:510, 1216-1225` | `:538-544` | `session.ts:1530-1544` | SUBSCRIBE_OK roundtrip | Indirect | ✅ | |
| FORWARD | §10.2.12 | `:416-421, 573-579, 943-948` | `:967-970` | `session.ts:1294` (`forwardState`) | REQUEST_UPDATE roundtrips | `06-subscribe-update.test.ts` | ✅ | |
| NEW_GROUP_REQUEST | §10.2.13 | Generic KVP | Generic KVP | MISSING | MISSING | MISSING | 🟡 | Enum only. |
| TRACK_NAMESPACE_PREFIX | §10.2.14 | Generic KVP | Generic KVP | MISSING | MISSING | MISSING | ❌ | Not applied — SUBSCRIBE_TRACKS always emits empty params. |

## Data Plane (§11)

| Feature | §Spec | Wire encode | Wire decode | Session-layer | Unit test | E2E test | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| Object Datagram | §11.3.1 | `draft18-stream-codec.ts:310-367` | `draft18-stream-codec.ts:369-435` | `message-codec.ts:2534, 2571`; `datagram-manager.ts:201, 253`; `session.ts:3661` | `draft18-stream-codec.test.ts:202-312, 472-497` | `05-subscribe.test.ts` (chat-datagram), `09-fetch.test.ts` | ✅ | Golden bytes verified; all flag combinations covered. |
| Subgroup Header stream | §11.4.2 | `draft18-stream-codec.ts:115-153` | `draft18-stream-codec.ts:155-206` | `message-codec.ts:2709-2764`; `session.ts:3706, 3800, 3858, 3946`; `object-router.ts:212, 265` | `draft18-stream-codec.test.ts:38-132, 443-471` | `05-subscribe.test.ts` (chat-stream) | ✅ | All SUBGROUP_ID_MODE variants + END_OF_GROUP + DEFAULT_PRIORITY + FIRST_OBJECT bits. |
| Closing Subgroup Streams / FIN | §11.4.3 | `session.ts:3711, 3805` (END_OF_GROUP) | — | `session.ts:574, 779` (`closeStream`) | MISSING | Indirect | 🟡 | No RESET_STREAM with specific error codes; TOO_FAR_BEHIND missing. |
| Fetch Header stream | §11.4.4 | `draft18-stream-codec.ts:209-217` | `draft18-stream-codec.ts:219-232` | `session.ts:3479`; `object-router.ts:717` | `draft18-stream-codec.test.ts:133-153, 498-522` | `09-fetch.test.ts` | ✅ | Handles all 4 subgroup modes + End-of-Range markers. |
| Padding streams | §11.5.1 | MISSING | MISSING | MISSING | MISSING | MISSING | ❌ | Enum entry only (`types.ts:208`); no logic. |
| Padding datagrams | §11.5.2 | MISSING | MISSING | MISSING | MISSING | MISSING | ❌ | |
| Object extension headers | §11.2.1.2 | `draft18-stream-codec.ts:234-256, 595-613` | `:258-296, 614-635` | `session.ts:3715-3718` (only MAX_CACHE_DURATION) | `draft18-stream-codec.test.ts:170-201, 281-311` | Indirect | ✅ | Generic KVP round-trip works; session uses only draft-16-style keys. |

## Priorities & Scheduling (§7)

| Feature | §Spec | Wire encode | Wire decode | Session-layer | Unit test | E2E test | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| Publisher priority | §7.1 | `draft18-stream-codec.ts:126, 322` | `:181, 376` | `session.ts:3657, 3710, 3804, 3862, 3950` | Header roundtrips | Indirect | 🟡 | Transmitted; not used to order local writes. |
| Subscriber priority | §7.1 | `draft18-message-codec.ts:743` | `:788` | `session.ts:1794` (`options.priority`) | Roundtrip | Indirect | 🟡 | No local send scheduling. |
| Group order | §7.1 | Roundtripped everywhere | Roundtripped | `session.ts:1795` etc. | Roundtrip | Indirect | ✅ | Pure pass-through. |
| Scheduling algorithm | §7.2 | — | — | MISSING | MISSING | MISSING | ❌ | `StreamManager` stores priority but never orders writes. |

## Delivery Timeouts (§8)

| Feature | §Spec | Wire encode | Wire decode | Session-layer | Unit test | E2E test | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| Subgroup delivery timeout enforcement | §8 | Generic KVP | Generic KVP | MISSING | MISSING | MISSING | ❌ | No timer, no drop logic. |
| Object delivery timeout enforcement | §8 | Generic KVP | Generic KVP | MISSING | MISSING | MISSING | ❌ | Same. |
| Delivery-timeout-driven drop | §8 | — | — | MISSING | MISSING | MISSING | ❌ | No stream-reset with `DELIVERY_TIMEOUT` code. |

## Track Properties (§12)

| Feature | §Spec | Wire encode | Wire decode | Session-layer | Unit test | E2E test | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| SUBGROUP_DELIVERY_TIMEOUT | §12.1 | Generic KVP | Generic KVP | `track-properties.ts` → `SubscribeOkEvent.trackProperties.subgroupDeliveryTimeoutMs` | `track-properties.test.ts` | MISSING | ✅ | Typed key + parsed value on SUBSCRIBE_OK. |
| OBJECT_DELIVERY_TIMEOUT | §12.2 | Generic KVP | Generic KVP | `track-properties.ts` → `SubscribeOkEvent.trackProperties.objectDeliveryTimeoutMs` | `track-properties.test.ts` | MISSING | ✅ | Typed key + parsed value on SUBSCRIBE_OK. |
| MAX_CACHE_DURATION | §12.3 | Generic KVP | Generic KVP | `track-properties.ts` + object-level (`session.ts:3717`) | `track-properties.test.ts` | MISSING | ✅ | Track- and object-level both surfaced. |
| DEFAULT_PUBLISHER_PRIORITY | §12.4 | Generic KVP | Generic KVP | `track-properties.ts` → `SubscribeOkEvent.trackProperties.defaultPublisherPriority` | `track-properties.test.ts` | MISSING | ✅ | |
| DEFAULT_PUBLISHER_GROUP_ORDER | §12.5 | Generic KVP | Generic KVP | `track-properties.ts` → `SubscribeOkEvent.trackProperties.defaultPublisherGroupOrder` | `track-properties.test.ts` | MISSING | ✅ | Out-of-range values dropped silently. |
| DYNAMIC_GROUPS | §12.6 | Generic KVP | Generic KVP | `track-properties.ts` → `SubscribeOkEvent.trackProperties.dynamicGroups` | `track-properties.test.ts` | MISSING | ✅ | Bool derived from varint. |
| IMMUTABLE_PROPERTIES | §12.7 | Generic KVP | Generic KVP | `track-properties.ts` → `SubscribeOkEvent.trackProperties.immutablePropertiesBitmap` | `track-properties.test.ts` | MISSING | ✅ | Raw bitmap surfaced as bigint. |
| Prior Group ID Gap | §12.8 | Generic KVP | Generic KVP | Enum key only (`TrackPropertyDraft18.PRIOR_GROUP_ID_GAP`) | MISSING | MISSING | 🟡 | Not yet plumbed into an event surface. |
| Prior Object ID Gap | §12.9 | Generic KVP | Generic KVP | Enum key only (`TrackPropertyDraft18.PRIOR_OBJECT_ID_GAP`) | MISSING | MISSING | 🟡 | Not yet plumbed into an event surface. |

## Namespace Discovery (§6)

| Feature | §Spec | Wire encode | Wire decode | Session-layer | Unit test | E2E test | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| Subscribing to namespaces | §6.1 | `draft18-message-codec.ts:1016` | `:1023` | `session.ts:2178-2306` (`readNamespaceSubscriptionStreamDraft18`) | `test.ts:601-618` | `04-subscribe-namespace.test.ts` | ✅ | Handles NAMESPACE/NAMESPACE_DONE/PUBLISH. |
| Publishing namespaces | §6.2 | `draft18-message-codec.ts:986` | `:993` | `session.ts:2713-2743`, `session.ts:4745-4767` | `test.ts:568-599` | `02-announce.test.ts` | ✅ | |

## Fetch Behavior (§5.2, §10.12)

| Feature | §Spec | Wire encode | Wire decode | Session-layer | Unit test | E2E test | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| Standalone fetch | §10.12.1 | `draft18-message-codec.ts:731-737` | `:767-772` | `session.ts:1777-1867` | `test.ts:288-312` | `09-fetch.test.ts` | ✅ | |
| Joining fetch (absolute, 0x3) | §10.12.2 | `:722-751` | `:770-838` | `session.ts:1807-1897` | `test.ts` | MISSING | ✅ | `FetchTypeDraft18.JOINING_ABSOLUTE`. |
| Joining fetch (relative, 0x2) | §10.12.2 | `:722-751` | `:770-838` | `session.ts:1807-1897` | `test.ts` | MISSING | ✅ | `FetchTypeDraft18.JOINING_RELATIVE`. |
| Fetch cancellation | §10.12 | REQUEST_UPDATE (`session.ts:1885`) | — | `session.ts:1871-1911` | MISSING | `10-fetch-cancel.test.ts` | ✅ | |

## Error Codes (§15.10)

| Feature | §Spec | Wire encode | Wire decode | Session-layer | Unit test | E2E test | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| Session Termination Codes | §15.10.1 | `types.ts:277-298` (all 20 codes) | — | `session.ts` `close({code, reason})` plumbs `SessionErrorCodeDraft18` into `transport.close(code, reason)` / `worker.disconnect(code, reason)` | `session-close.test.ts` | `12-session-close.test.ts` | ✅ | Numeric code forwarded to WebTransport `closeCode`. |
| REQUEST_ERROR Codes | §15.10.2 | `types.ts:319-338` (17 codes) | Full enum roundtripped | Session uses `RequestErrorCodeDraft18` (NOT_SUPPORTED / DOES_NOT_EXIST / UNINTERESTED) instead of hardcoded 0x01 | REDIRECT tested | Indirect | ✅ | Enum exported from `@moq-web/core`; incoming-stream error paths use spec-appropriate codes. |
| PUBLISH_DONE Codes | §15.10.3 | `types.ts:343-354` (10 codes) | Read as `bigint` | `sendPublishDone(..., statusCode)` accepts `PublishDoneErrorCodeDraft18`; `unpublish()` sends TRACK_ENDED | Field roundtrip | MISSING | ✅ | Both send and receive paths surface the typed enum. |
| Stream Reset Codes | §15.10.4 | `types.ts:303-314` (10 codes) | — | `session.ts` `resetPublicationStream(alias, code, reason?)` — aborts the active subgroup writer with a code-derived reason | `session-close.test.ts` | MISSING | 🟡 | Public API surfaces the enum; WebTransport lacks a per-stream reset code, so codes are surfaced via the abort reason for now. |

## Security (§13)

| Feature | §Spec | Wire encode | Wire decode | Session-layer | Unit test | E2E test | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| Authorization token replay protection | §13.3.1 | — | — | MISSING (cache at `session.ts:313`, no nonce/expiry) | MISSING | MISSING | ❌ | Tokens stored/forwarded verbatim. |
| Idle connection handling | §13.6.1 | — | — | MISSING (no explicit idle timer) | MISSING | MISSING | ❌ | Relies on WebTransport defaults. |
| Fingerprinting mitigation | §13.8 | `MOQT_IMPLEMENTATION` opt (`draft18-message-codec.ts:315-323`) | `:372-376` | `session.ts:1069` (fixed `"moq-web 0.1.0"`) | MISSING | MISSING | 🟡 | Sent unconditionally; spec cautions against always advertising. |

## Grease (§14)

| Feature | §Spec | Wire encode | Wire decode | Session-layer | Unit test | E2E test | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| Grease (random reserved codes) | §14 | — | — | MISSING | MISSING | MISSING | ❌ | No greasing anywhere in codec/session. |

---

## Top Gaps (Summary)

1. **No delivery-timeout enforcement or priority scheduling.** SUBGROUP/OBJECT/FILL/RENDEZVOUS timeout parameters have enum entries but no timer or drop logic; SUBSCRIBER/publisher priorities are transmitted but `StreamManager` never orders local writes (§7.2, §8).

2. **Padding streams and padding datagrams (§11.5) are fully missing.** `StreamTypeDraft18.PADDING = 0x132b3e28` is defined in `types.ts:208` but there is no encoder, decoder, or session handler.

3. ~~**Draft-18 error-code enums are defined but unused end-to-end.**~~ Partially resolved: `SessionErrorCodeDraft18` flows through `session.close({code, reason})` to the WebTransport `closeCode`; `StreamResetErrorCodeDraft18` is exposed via `session.resetPublicationStream(alias, code)`. `PublishDoneErrorCodeDraft18` was previously wired via `sendPublishDone`. Remaining gap: WebTransport lacks a per-stream reset code, so §11.4.3 stream-level `DELIVERY_TIMEOUT` / `TOO_FAR_BEHIND` are conveyed via the abort reason string only.

4. ~~**Track-property key enum for §12 is absent.**~~ Resolved: `TrackPropertyDraft18` in `packages/core/src/messages/types.ts` and `parseTrackProperties` in `packages/session/src/track-properties.ts` now decode the §12 map into `SubscribeOkEvent.trackProperties`. Only Prior Group/Object ID Gap remain enum-only.

5. **Several control-message paths are stubs on the receive/response side.** Incoming REQUEST_UPDATE, TRACK_STATUS, SUBSCRIBE_TRACKS, and PUBLISH_DONE handlers only log; SUBSCRIBE_TRACKS on the send side always emits an empty parameter list; joining fetch type 0x3 is conflated with 0x2 in the decoder and unreachable from any session API. MOQT URI scheme validation, connection migration via `newSessionUri`, reserved-namespace enforcement, and grease are entirely absent.

---

*Generated 2026-09-03 by cross-referencing `/tmp/moqt-18.txt` against `packages/core`, `packages/session`, and `packages/session-e2e`.*
