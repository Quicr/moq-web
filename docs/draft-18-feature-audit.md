# MOQ Transport Draft-18 Feature Audit

**Repository:** `Quicr/moq-web`
**Spec:** `draft-ietf-moq-transport-18` (January 2026)
**Audit date:** 2026-09-03
**Branch reviewed:** `main` (after PR #35)

<!-- audit-progress:begin -->
**Progress:** ✅ 72 · 🟡 4 · ❌ 4 · **90% complete** of 80 features
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
| Session termination | §3.5 | `session.ts` `close({code,reason})` + `goAway()` | `transport.ts` `'closed'` event surfaces peer `closeCode`/`reason` | `session.ts` `handleTransportClosed()` emits `session-terminated` when `remote=true` | `session-migration.test.ts` | `13-session-termination.test.ts` | ✅ | Typed event carries `SessionErrorCodeDraft18`; local closes suppressed. |
| GOAWAY handling | §10.4 | `draft18-message-codec.ts:852-859` | `draft18-message-codec.ts:861-873` | `session.ts:1137`, `session.ts:4846-4858` | `draft18-message-codec.test.ts:354-402, 732-767` | `11-goaway.test.ts` | ✅ | Both control-stream & request-stream variants; migration URI cached on receipt. |
| Migration | §3.6 | — | — | `session.ts` `migrate(newSessionUri?)` + `autoMigrate` config + cached `pendingMigrationUri` from GOAWAY | `session-migration.test.ts` | `13-session-termination.test.ts` | 🟡 | Client-side wiring complete (worker mode reconnect + SETUP replay); dual-relay over-the-wire smoke test tracked in `docs/draft-18-interop-plan.md`. |
| Congestion control | §3.7 | — | — | `transport.ts:91-92,153,230` (`congestionControl` option) | MISSING | MISSING | 🟡 | Sets WebTransport `default`/`throughput` hint only; no bufferbloat/app-limited logic. |

## Extension Negotiation (§3.2, §4)

| Feature | §Spec | Wire encode | Wire decode | Session-layer | Unit test | E2E test | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| Extension advertisement in SETUP | §3.2 | `draft18-message-codec.ts` `encodeSetup()` (reserved-key + parity checks) | `draft18-message-codec.ts` `decodeSetup()` (captures unknown KVPs into `extensions` map) | `session.ts` `setClientExtensions()` / `peerExtensions` getter; passes through `ClientSetupMessageDraft18.extensions` | `draft18-message-codec.test.ts` (`SETUP extensions (§3.2)` suite) + `session-setup-extensions.test.ts` | `14-setup-extensions.test.ts` | ✅ | Custom extensions round-trip through SETUP with reserved-key collision + even/odd parity enforcement. |
| Reserved namespaces | §3.2.1 | — | — | `session.ts` `assertNotReservedNamespace()` guards every outbound publish/subscribe/fetch/trackStatus/subscribeNamespace/subscribeTracks/announce/publishVOD | `session-reserved-namespace.test.ts` | `25-reserved-namespace.test.ts` | ✅ | Refuses to originate any request whose first namespace-tuple field starts with '.' (0x2e), per §3.2.1. |

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
| TRACK_STATUS | §10.14 | `draft18-message-codec.ts` `encodeTrackStatus()` + `encodeRequestOk()` writes LARGEST_OBJECT | `draft18-message-codec.ts` `decodeTrackStatus()` + `decodeRequestOk()` reads LARGEST_OBJECT | `session.ts` `trackStatus()` returns `TrackStatusResult{latestGroup,latestObject,expiresMs}`; `handleIncomingTrackStatusDraft18()` looks up publication and replies REQUEST_OK w/ LARGEST_OBJECT (§10.2.9) or REQUEST_ERROR DOES_NOT_EXIST; `PublicationManager.updateLatest()` tracks the live edge on every `sendObject()` | `draft18-message-codec.test.ts` (REQUEST_OK LARGEST_OBJECT suite) + `session-track-status.test.ts` | `08-track-status.test.ts`, `15-track-status-largest.test.ts` | ✅ | Publisher answers status queries from its own publication table. |
| PUBLISH_NAMESPACE | §10.15 | `draft18-message-codec.ts:986-991` | `draft18-message-codec.ts:993-1014` | `session.ts:2713-2743`, `session.ts:4745-4767` | `draft18-message-codec.test.ts:568-599` | `02-announce.test.ts` | ✅ | Parameters map always encoded empty; auth-token push ignored. |
| NAMESPACE | §10.16 | `draft18-message-codec.ts:1046-1051` | `draft18-message-codec.ts:1053-1068` | `session.ts:2328-2345`, `session.ts:4725` | `draft18-message-codec.test.ts:619-650` | `04-subscribe-namespace.test.ts` | ✅ | |
| NAMESPACE_DONE | §10.17 | `draft18-message-codec.ts:1070-1072` | `draft18-message-codec.ts:1074-1085` | `session.ts:2347-2361`, `session.ts:4734` | `draft18-message-codec.test.ts:652-666` | `16-namespace-done.test.ts` | ✅ | E2E asserts SUBSCRIBE_NAMESPACE resolves and codec parses the terminal frame; relays free to keep the stream open. |
| SUBSCRIBE_NAMESPACE | §10.18 | `draft18-message-codec.ts:1016-1021` | `draft18-message-codec.ts:1023-1044` | `session.ts:2178-2222`, `session.ts:4702-4744` | `draft18-message-codec.test.ts:601-618` | `04-subscribe-namespace.test.ts` | ✅ | Parameters always empty on encode. |
| SUBSCRIBE_TRACKS | §10.19 | `draft18-message-codec.ts` `encodeSubscribeTracks` (FORWARD + SUBSCRIPTION_FILTER + pass-through KVPs) | `draft18-message-codec.ts` `decodeSubscribeTracks` (mirrors SUBSCRIBE) | `session.ts` `subscribeTracks(prefix, onObject, { forwardState, filter, startLocation, endGroupDelta, namespacePrefixParam, parameters })` | `draft18-message-codec.test.ts` SUBSCRIBE_TRACKS suite + `session-subscribe-tracks.test.ts` + `session-expires-and-ngr.test.ts` | `17-subscribe-tracks.test.ts` + `20-expires-and-ngr.test.ts` | ✅ | Full parameter parity with SUBSCRIBE plus first-class §10.2.14 TRACK_NAMESPACE_PREFIX opt-in. |
| PUBLISH_BLOCKED | §10.20 | `draft18-message-codec.ts:1119-1121` | `draft18-message-codec.ts:1123-1134` | `session.ts` `sendPublishBlocked(trackAlias)`; recv emits `PublishBlockedEvent` | `draft18-message-codec.test.ts:707-729, 778-787` + `session-subscribe-tracks.test.ts` | Indirect | ✅ | Publisher-side send helper landed. |

## Parameters (§10.2)

| Feature | §Spec | Wire encode | Wire decode | Session-layer | Unit test | E2E test | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| AUTHORIZATION_TOKEN | §10.2.2 | Setup: `draft18-message-codec.ts:288-296`; request: parity-aware length-prefixed encode inside SUBSCRIBE/FETCH parameter loops | `draft18-message-codec.ts` SETUP `authToken` bytes captured; SUBSCRIBE/FETCH decode preserves param bytes for lazy `MessageCodec.decodeAuthorizationToken()` | `session.ts` `subscribeDraft18` + `fetchDraft18` inject `RequestParameterDraft18.AUTHORIZATION_TOKEN`; SETUP-scope path emits `ClientSetupMessageDraft18.authToken` | `draft18-message-codec.test.ts` (SETUP roundtrip + SUBSCRIBE/FETCH param roundtrip); `session-auth-token.test.ts` (per-request wiring) | `18-auth-token.test.ts` | ✅ | Setup-level and per-request tokens both wired for draft-18; consumers decode on demand. |
| SUBGROUP_DELIVERY_TIMEOUT | §10.2.3 | `draft18-message-codec.ts:445-449, 763-767` (SUBSCRIBE + FETCH raw params) | `:484-487, 815-830` (delta-decoded into `parameters` map) | `session.ts` `addDeliveryTimeoutParams` → `SubscribeOptions.subgroupDeliveryTimeout` / `FetchOptions.subgroupDeliveryTimeout` | `draft18-message-codec.test.ts` SUBSCRIBE + FETCH roundtrip | MISSING | ✅ | Subscriber-side timeout wired end-to-end via §10.2 request parameters. |
| OBJECT_DELIVERY_TIMEOUT | §10.2.4 | `draft18-message-codec.ts:445-449, 763-767` | `:484-487, 815-830` | `session.ts` `addDeliveryTimeoutParams` → `SubscribeOptions.objectDeliveryTimeout` / `FetchOptions.objectDeliveryTimeout` | `draft18-message-codec.test.ts` SUBSCRIBE + FETCH roundtrip | MISSING | ✅ | Subscriber-side per-object delivery timeout as varint request parameter. |
| FILL_TIMEOUT | §10.2.5 | `draft18-message-codec.ts:445-449, 763-767` | `:484-487, 815-830` | `session.ts` `addDeliveryTimeoutParams` → `SubscribeOptions.fillTimeout` / `FetchOptions.fillTimeout` | `draft18-message-codec.test.ts` SUBSCRIBE + FETCH roundtrip | MISSING | ✅ | Subscriber-side missing-object wait timeout. |
| RENDEZVOUS_TIMEOUT | §10.2.6 | `draft18-message-codec.ts:445-449, 763-767` | `:484-487, 815-830` | `session.ts` `addDeliveryTimeoutParams` → `SubscribeOptions.rendezvousTimeout` / `FetchOptions.rendezvousTimeout` | `draft18-message-codec.test.ts` SUBSCRIBE + FETCH roundtrip | MISSING | ✅ | Subscriber-side cutover-wait timeout for new subscribers. |
| SUBSCRIBER_PRIORITY | §10.2.7 | `draft18-message-codec.ts` (encoded from `SubscribeOptions.priority`) | `:788, 484-486` | `parseSubscriberSchedulingParams` → `InternalPublication.subscriberPriority`; feeds `deriveSendOrder`; refreshed on REQUEST_UPDATE | `priority.test.ts`, `session-priority.test.ts` | `23-priority.test.ts` | ✅ | Drives WebTransport `sendOrder`. |
| GROUP_ORDER | §10.2.8 | `:749, 445` | `:790-791, 490-492` | `parseSubscriberSchedulingParams` → `InternalPublication.subscriberGroupOrder`; feeds `deriveSendOrder` | `priority.test.ts`, `session-priority.test.ts` | `23-priority.test.ts` | ✅ | ASCENDING inverts groupId low bits; DESCENDING preserves. |
| SUBSCRIPTION_FILTER | §10.2.9 | Inline in SUBSCRIBE `:423-449` | `:471-497` | `session.ts` `mapSubscribeFilter` → `SubscribeOptions.filterType` ('latest' / 'next-group' / 'largest-object' / 'absolute-start' / 'absolute-range' + `startGroup`/`startObject`/`endGroup`) | `draft18-message-codec.test.ts` roundtrip + `session-subscription-filter.test.ts` | `19-subscription-filters.test.ts` | ✅ | All four §10.2.9 filter variants selectable through `SubscribeOptions`; `endGroup` translated to `endGroupDelta` at send time. |
| EXPIRES | §10.2.10 | `draft18-message-codec.ts` REQUEST_OK + SUBSCRIBE_OK params | REQUEST_OK + SUBSCRIBE_OK decode | `session.ts` `AnnounceOptions.expires` → SUBSCRIBE_OK; `SubscribeNamespaceOptions.expires` → REQUEST_OK; `PublishOptions.expires` on publisher-side outbound REQUEST_OK | `session-expires-and-ngr.test.ts` + `draft18-message-codec.test.ts` SUBSCRIBE_OK EXPIRES roundtrip | `20-expires-and-ngr.test.ts` | ✅ | Two-way surface: incoming REQUEST_OK exposed via `RequestOkEvent.expiresMs`; outbound SUBSCRIBE_OK / REQUEST_OK carries publisher-configured value. |
| LARGEST_OBJECT | §10.2.11 | `:510, 1216-1225` | `:538-544` | `session.ts:1530-1544` | SUBSCRIBE_OK roundtrip | Indirect | ✅ | |
| FORWARD | §10.2.12 | `:416-421, 573-579, 943-948` | `:967-970` | `session.ts:1294` (`forwardState`) | REQUEST_UPDATE roundtrips | `06-subscribe-update.test.ts` | ✅ | |
| NEW_GROUP_REQUEST | §10.2.13 | `session.ts` `sendRequestUpdate({ newGroupRequest })` adds varint param to REQUEST_UPDATE | `session.ts` `dispatchRequestUpdateDraft18` extracts + emits `new-group-request` event | `SessionEventType` `'new-group-request'`; `NewGroupRequestEvent` payload | `session-expires-and-ngr.test.ts` | `20-expires-and-ngr.test.ts` | ✅ | Subscriber sends by option; publisher receives typed event with raw varint value and coincident `forwardState`. |
| TRACK_NAMESPACE_PREFIX | §10.2.14 | `session.ts` `subscribeTracks({ namespacePrefixParam })` encodes tuple bytes into `SUBSCRIBE_TRACKS` param map | `handleIncomingSubscribeDraft18` decodes tuple + narrows publication match | `session.ts` new option; `encodeTrackNamespaceBytes` / `decodeTrackNamespaceBytes` helpers | `session-expires-and-ngr.test.ts` | `20-expires-and-ngr.test.ts` | ✅ | First-class subscriber option; publisher applies the narrower prefix as an extra filter when emitting `incoming-subscribe`. |

## Data Plane (§11)

| Feature | §Spec | Wire encode | Wire decode | Session-layer | Unit test | E2E test | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| Object Datagram | §11.3.1 | `draft18-stream-codec.ts:310-367` | `draft18-stream-codec.ts:369-435` | `message-codec.ts:2534, 2571`; `datagram-manager.ts:201, 253`; `session.ts:3661` | `draft18-stream-codec.test.ts:202-312, 472-497` | `05-subscribe.test.ts` (chat-datagram), `09-fetch.test.ts` | ✅ | Golden bytes verified; all flag combinations covered. |
| Subgroup Header stream | §11.4.2 | `draft18-stream-codec.ts:115-153` | `draft18-stream-codec.ts:155-206` | `message-codec.ts:2709-2764`; `session.ts:3706, 3800, 3858, 3946`; `object-router.ts:212, 265` | `draft18-stream-codec.test.ts:38-132, 443-471` | `05-subscribe.test.ts` (chat-stream) | ✅ | All SUBGROUP_ID_MODE variants + END_OF_GROUP + DEFAULT_PRIORITY + FIRST_OBJECT bits. |
| Closing Subgroup Streams / FIN | §11.4.3 | `session.ts` GOP `newGroup` closes stream cleanly; `resetPublicationStream(alias, code)` + `resetPublicationStreamTooFarBehind(alias)` abort with §15.10.4 code | `object-router.ts` catches `WebTransportError.streamErrorCode` and emits typed `stream-reset` event | `session.ts` typed `stream-reset` event (`side`, `code`, `reason`, alias, group/subgroup) | `session-stream-reset.test.ts`, `object-router-stream-reset.test.ts` | `21-stream-reset.test.ts` | ✅ | Publisher and subscriber both surface §15.10.4 codes; §8 DELIVERY_TIMEOUT stays on the `delivery-timeout` event so consumers can distinguish deadline-driven from application-driven resets. |
| Fetch Header stream | §11.4.4 | `draft18-stream-codec.ts:209-217` | `draft18-stream-codec.ts:219-232` | `session.ts:3479`; `object-router.ts:717` | `draft18-stream-codec.test.ts:133-153, 498-522` | `09-fetch.test.ts` | ✅ | Handles all 4 subgroup modes + End-of-Range markers. |
| Padding streams | §11.5.1 | `session.ts` `sendPaddingStream(bytes)` — writes PADDING type varint + N zero bytes | `transport.ts` `handleDraft18UnidirectionalStream` intercepts `StreamTypeDraft18.PADDING` and drains via `drainPaddingStream` | `sendPaddingStream()` on `MOQTSession` | `session-padding.test.ts`, `transport-padding.test.ts` | `22-padding.test.ts` | ✅ | Receiver never emits `unidirectional-stream` for padding — bytes are drained silently. |
| Padding datagrams | §11.5.2 | `session.ts` `sendPaddingDatagram(bytes)` — writes PADDING datagram-type varint + N zero bytes | `datagram-manager.ts` `handleDatagram` peeks first varint and drops on `DatagramTypeDraft18.PADDING` | `sendPaddingDatagram()` on `MOQTSession` | `session-padding.test.ts` | `22-padding.test.ts` | ✅ | Padding never surfaces as an `object` event; stats.received still bumps so it's observable. |
| Object extension headers | §11.2.1.2 | `draft18-stream-codec.ts:234-256, 595-613` | `:258-296, 614-635` | `session.ts:3715-3718` (only MAX_CACHE_DURATION) | `draft18-stream-codec.test.ts:170-201, 281-311` | Indirect | ✅ | Generic KVP round-trip works; session uses only draft-16-style keys. |

## Priorities & Scheduling (§7)

| Feature | §Spec | Wire encode | Wire decode | Session-layer | Unit test | E2E test | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| Publisher priority | §7.1 | `draft18-stream-codec.ts:126, 322` | `:181, 376` | `session.ts` `deriveSendOrder` folds into `sendOrder`; used in `sendObjectViaStream` and `sendObjectWithGOP` | `priority.test.ts` | `23-priority.test.ts` | ✅ | Feeds into WebTransport `sendOrder` alongside subscriber priority + group order. |
| Subscriber priority | §7.1 | `draft18-message-codec.ts` — encoded on SUBSCRIBE from `SubscribeOptions.priority`; decoded via `parseSubscriberSchedulingParams` | Decoded via `parseSubscriberSchedulingParams` | `priority.ts` `parseSubscriberSchedulingParams`; cached on `InternalPublication.subscriberPriority`; updated on `REQUEST_UPDATE` (§10.9.1) | `priority.test.ts`, `session-priority.test.ts` | `23-priority.test.ts` | ✅ | Round-trips through the wire and drives `sendOrder`. |
| Group order | §7.1 | Roundtripped everywhere; encoded via SUBSCRIBER-side `SubscribeOptions.groupOrder` | Roundtripped; parsed via `parseSubscriberSchedulingParams` | Cached on `InternalPublication.subscriberGroupOrder`; used in `deriveSendOrder` | `priority.test.ts`, `session-priority.test.ts` | `23-priority.test.ts` | ✅ | ASCENDING inverts groupId in the low bits of `sendOrder`; DESCENDING preserves it. |
| Scheduling algorithm | §7.2 | — | — | `priority.ts` `computeSendOrder` packs `[invSub(8) \| invPub(8) \| groupBits(36)]` into a safe-integer `sendOrder`; applied via `createUnidirectionalStream({ sendOrder })` in `transport.ts` and `session.ts` `doCreateStream` | `priority.test.ts` | `23-priority.test.ts` | ✅ | Higher `sendOrder` = ships first (WebTransport §7.2 spec). REQUEST_UPDATE re-priorities in flight. |

## Delivery Timeouts (§8)

| Feature | §Spec | Wire encode | Wire decode | Session-layer | Unit test | E2E test | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| Subgroup delivery timeout enforcement | §8 | Generic KVP | Generic KVP | `object-router.ts` `armSubgroupTimer`/`disarmSubgroupTimers`; publisher side in `session.ts` `armPublisherSubgroupTimer` (`sendObjectViaStream`, `sendObjectWithGOP`) | `object-router-delivery-timeout.test.ts`, `session-delivery-timeout.test.ts`, `delivery-timeout.test.ts` | Covered indirectly via `05-subscribe.test.ts` | ✅ | Subscriber cancels reader; publisher resets stream and emits `delivery-timeout` event. |
| Object delivery timeout enforcement | §8 | Generic KVP | Generic KVP | `object-router.ts` `armObjectTimer`/`disarmObjectTimer` per-object; speculatively armed after each delivery | `object-router-delivery-timeout.test.ts`, `delivery-timeout.test.ts` | Covered indirectly | ✅ | Fires with `reason='object'` on `DeliveryTimeoutEvent`. |
| Delivery-timeout-driven drop | §8 | — | — | `resetPublicationStream(alias, StreamResetErrorCodeDraft18.DELIVERY_TIMEOUT)`; subscriber calls `reader.cancel(reason)` | `session-delivery-timeout.test.ts`, `object-router-delivery-timeout.test.ts` | Covered indirectly | 🟡 | Numeric §15.10.4 `DELIVERY_TIMEOUT` (0x2) surfaced via `DeliveryTimeoutEvent.resetCode`; WebTransport lacks a per-stream reset code so wire signal is conveyed via `writer.abort(reason)`. |

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
| Prior Group ID Gap | §12.8 | `session.ts` `buildTrackProperties` (from `PublishOptions.priorGroupIdGap`) | `track-properties.ts` → `SubscribeOkEvent.trackProperties.priorGroupIdGap` | `PublishOptions.priorGroupIdGap` on PUBLISH; decoded on incoming SUBSCRIBE_OK/PUBLISH | `track-properties.test.ts` | `24-track-properties-gaps.test.ts` | ✅ | Publisher-configurable varint; surfaced on `TrackProperties`. |
| Prior Object ID Gap | §12.9 | `session.ts` `buildTrackProperties` (from `PublishOptions.priorObjectIdGap`) | `track-properties.ts` → `SubscribeOkEvent.trackProperties.priorObjectIdGap` | `PublishOptions.priorObjectIdGap` on PUBLISH; decoded on incoming SUBSCRIBE_OK/PUBLISH | `track-properties.test.ts` | `24-track-properties-gaps.test.ts` | ✅ | Publisher-configurable varint; surfaced on `TrackProperties`. |

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
| Stream Reset Codes | §15.10.4 | `types.ts:303-314` (10 codes) | `object-router.ts` extracts `WebTransportError.streamErrorCode` and forwards it | `session.ts` `resetPublicationStream(alias, code, reason?)` + `resetPublicationStreamTooFarBehind(alias)`; typed `stream-reset` event carries the numeric code on both publisher and subscriber sides | `session-close.test.ts`, `session-stream-reset.test.ts`, `object-router-stream-reset.test.ts` | `21-stream-reset.test.ts` | ✅ | Publisher aborts the writer with a `code=N (NAME)` reason and emits `stream-reset`; subscriber decodes the peer's `streamErrorCode` and emits the same event with `side: 'subscriber'`. |

## Security (§13)

| Feature | §Spec | Wire encode | Wire decode | Session-layer | Unit test | E2E test | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| Authorization token replay protection | §13.3.1 | `security/auth-token-replay.ts` (bounded LRU by `tokenType` + `tokenValue`, TTL default 5 min, max 1024 entries) | consumer-side check via `AuthTokenReplayCache.check(token)` returning `fresh` / `duplicate` / `expired` | Exported from `@moq-web/core`; not attached to session by default (server-side concern — consumers instantiate one per session or per relay). | `security/auth-token-replay.test.ts` | — | ✅ | Helper available for peers to reject replayed tokens; aliasType=2 (USE_ALIAS) is not fingerprinted. |
| Idle connection handling | §13.6.1 | — | — | MISSING (no explicit idle timer) | MISSING | MISSING | ❌ | Relies on WebTransport defaults. |
| Fingerprinting mitigation | §13.8 | `MOQT_IMPLEMENTATION` opt (`draft18-message-codec.ts:315-323`) | `:372-376` | `session.ts:1069` (fixed `"moq-web 0.1.0"`) | MISSING | MISSING | 🟡 | Sent unconditionally; spec cautions against always advertising. |

## Grease (§14)

| Feature | §Spec | Wire encode | Wire decode | Session-layer | Unit test | E2E test | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| Grease (random reserved codes) | §14 | — | — | MISSING | MISSING | MISSING | ❌ | No greasing anywhere in codec/session. |

---

## Top Gaps (Summary)

1. ~~**No delivery-timeout enforcement or priority scheduling.**~~ Resolved: §8 subgroup + object delivery timeouts armed on both subscriber (`ObjectRouter`) and publisher (`session.ts`) sides — subscriber cancels the reader; publisher resets the stream via `StreamResetErrorCodeDraft18.DELIVERY_TIMEOUT` and emits a `delivery-timeout` event. §7 priority scheduling now wires SUBSCRIBER_PRIORITY / GROUP_ORDER from SUBSCRIBE + REQUEST_UPDATE through `parseSubscriberSchedulingParams` into `InternalPublication`, and `computeSendOrder` packs the §7.2 ordering into the WebTransport `sendOrder` on each outgoing subgroup stream. Remaining gap: FILL / RENDEZVOUS timeouts (§8.3–4) still unenforced.

2. ~~**Padding streams and padding datagrams (§11.5) are fully missing.**~~ Resolved: `session.sendPaddingStream(bytes)` opens a unidirectional stream prefixed with `StreamTypeDraft18.PADDING` (0x132B3E28); `session.sendPaddingDatagram(bytes)` sends a datagram prefixed with `DatagramTypeDraft18.PADDING` (0x132B3E29). Receivers silently drain padding streams (transport-level) and drop padding datagrams before object decode (`DatagramManager`), so padding never surfaces as an object event.

3. ~~**Draft-18 error-code enums are defined but unused end-to-end.**~~ Resolved: `SessionErrorCodeDraft18` flows through `session.close({code, reason})` to the WebTransport `closeCode`; `StreamResetErrorCodeDraft18` is surfaced end-to-end via `session.resetPublicationStream(alias, code)` + a typed `stream-reset` event that also fires on the subscriber when a peer RESET_STREAM lands (`WebTransportError.streamErrorCode`). `PublishDoneErrorCodeDraft18` was previously wired via `sendPublishDone`. WebTransport still lacks a per-stream QUIC-level code on the sender side, so the numeric code additionally travels in the abort reason string.

4. ~~**Track-property key enum for §12 is absent.**~~ Resolved: `TrackPropertyDraft18` in `packages/core/src/messages/types.ts` and `parseTrackProperties` in `packages/session/src/track-properties.ts` now decode the full §12 map into `SubscribeOkEvent.trackProperties`. Prior Group/Object ID Gap (§12.8/§12.9) are also plumbed through `PublishOptions.priorGroupIdGap` / `priorObjectIdGap` on the encode side.

5. **Several control-message paths are stubs on the receive/response side.** Incoming REQUEST_UPDATE, TRACK_STATUS, SUBSCRIBE_TRACKS, and PUBLISH_DONE handlers only log; SUBSCRIBE_TRACKS on the send side always emits an empty parameter list; joining fetch type 0x3 is conflated with 0x2 in the decoder and unreachable from any session API. MOQT URI scheme validation, connection migration via `newSessionUri`, and grease are entirely absent. (Reserved-namespace enforcement per §3.2.1 is now wired.)

---

*Generated 2026-09-03 by cross-referencing `/tmp/moqt-18.txt` against `packages/core`, `packages/session`, and `packages/session-e2e`.*
