# Cloudflare relay tokens in Studio

Running Studio against a Cloudflare MoQ relay involves several credentials. They come from
different places, travel in different parts of the connection, and answer different questions.
You only ever paste **one** of them into the app.

## At a glance

| # | Credential | Looks like | Issued by | Answers | Needed when | Pasted into Studio? |
|---|---|---|---|---|---|---|
| 1 | Cloudflare account API token | `cfat_…` / `cfut_…` | Cloudflare dashboard | "May this admin manage the account's relays?" | Only to mint #2 | **No, never** |
| 2 | Relay connection token | `eyJ….eyJ….sig` (JWT) | Cloudflare API, using #1 | "Which tenant relay is this connection for?" | Always, for a Cloudflare relay | **Yes**, in *Relay connection token* |
| 3 | Moat session token | opaque string | moat (`/v1/auth/guest`, `/v1/auth/google`) | "Who is this user?" | *Require C4M* on | No, Studio gets it when you sign in |
| 4 | CAT (Common Access Token) | CBOR/COSE, never shown | moat (`/v1/token`), using #3 | "May this user publish and subscribe in this room?" | *Require C4M* on | No, Studio requests it on *Join room* |

## How they fit together

```
 Operator, once, outside the app
   #1 cfat_… ──POST /accounts/:acct/moq/relays/:relay/tokens──► #2 relay JWT (eyJ…)
                                                                   │ paste into settings
                                                                   ▼
 Studio ──── WebTransport https://<relay-host>/<#2 JWT> ─────────► Cloudflare relay
        └─── MoQT SETUP, AUTHORIZATION_TOKEN (type 1) = #4 CAT ──►   (C4M only)
              ▲
              │ POST /v1/token {room_id, role: "pubsub"}  (Bearer #3)
             moat ◄── sign in (Google ID token or guest name) → #3 session token
```

## 1. Cloudflare account API token (`cfat_…`)

- **What it is:** an admin key for your Cloudflare account, created in the dashboard under
  *Manage account → API Tokens*. It needs permission to edit MoQ relays.
- **Where it is used:** only for calls to `api.cloudflare.com`, to list relays and mint relay
  connection tokens. No Studio code reads it, and the relay rejects it.
- **Why it can't live in the browser:** `api.cloudflare.com` sends no CORS headers, so a page
  can't call it. Even if it could, putting an account key in a page or a share link would leak it.
- **Where to keep it:** `~/.config/cf-moq.env` (mode `600`), not in the repo or chat:

  ```sh
  CF_ACCT=<account id>
  CF_TOKEN=<cfat_… account API token>
  CF_RELAY=<relay uid>
  ```

- **Check that it still works:**

  ```sh
  . ~/.config/cf-moq.env
  curl -sS "https://api.cloudflare.com/client/v4/accounts/$CF_ACCT/tokens/verify" \
    -H "Authorization: Bearer $CF_TOKEN"
  ```

  `Invalid API Token` (code 1000) or `Authentication error` (code 10000) means the token was
  revoked or rotated. Create a new one and update `CF_TOKEN`.

## 2. Relay connection token (JWT)

- **What it is:** a JWT signed by Cloudflare. Its claims:
  - `sub`: the relay UID, which selects your tenant relay
  - `operations`: `["publish", "subscribe"]`. Studio needs both.
  - `jti`, `iat`, `exp`: ID, issued-at and expiry. Tokens are valid for about a year.
- **Where it is used:** the Cloudflare auth adapter
  (`packages/app-kit/src/auth/adapters/cloudflare.ts`) puts it in the first path segment of the
  WebTransport URL: `https://<relay-host>/<jwt>`.
- **When it is needed:** on every connection to a Cloudflare relay, with or without C4M. If it
  is missing, expired or for the wrong relay, the relay closes the session with
  `scope resolution failed` (code 3).
- **What it does *not* do:** it doesn't identify the user or authorize a room. With C4M on, it
  only gets you to the right relay, and the CAT (#4) decides the rest.
- **Sharing:** with C4M on, the *Share* link includes this token so a recipient's fresh browser
  can reach the relay. That's safe only because the relay also requires a CAT, which needs a
  sign-in. With C4M off, Studio leaves the token out of share links.

### Minting one

```sh
. ~/.config/cf-moq.env
curl -sS -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCT/moq/relays/$CF_RELAY/tokens" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{"operations":["publish","subscribe"],"label":"studio"}' |
python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(d["result"]["issuers"][0]["cloudflare_tokens"][0]["secret"] if d.get("success") else d.get("errors"))' |
pbcopy
```

The JWT is now on the clipboard. To list your relays and find `CF_RELAY`, run
`GET /accounts/$CF_ACCT/moq/relays`.

### Pasting it

Settings (gear) → *Auth* → **Cloudflare** → **Relay connection token**. The panel decodes the
JWT locally (it doesn't verify the signature; the relay does that) and shows `jti`, `sub`,
operations and expiry. A parse error such as *JWT must have three dot-separated parts* usually
means you pasted the `cfat_…` key by mistake.

## 3. Moat session token

- **What it is:** moat's login session for a user, created by *Sign in with Google* (moat checks
  the Google ID token) or *Continue as guest*.
- **Where it is used:** as `Authorization: Bearer …` on moat API calls: creating rooms
  (`POST /v1/rooms`) and minting CATs (`POST /v1/token`). Listing rooms doesn't need it.
- **When it is needed:** only with *Require C4M* on. Studio shows the sign-in panel first.
- **Lifetime:** stored in `localStorage` (`moq-web:studio:moat-session`). moat rejects sessions
  older than 24 hours, and Studio drops them after 23. *Sign out* clears it.
- **Guest vs Google:** guests can only create and join **public** rooms. *Sign-in only* rooms
  need a Google sign-in.

## 4. CAT (C4M access token)

- **What it is:** a Common Access Token (draft-ietf-moq-c4m), a CBOR/COSE CWT minted by moat for
  one user in one room. It is scoped to the room's namespace, `studio/<slug>`.
- **Where it is used:** in the MoQT **SETUP** message as `AUTHORIZATION_TOKEN`, token type 1.
  Studio gets it through `mintCat()` in `src/moat.ts` when you click *Join room* and passes it
  as `connectMoqtSession({ authToken })`.
- **When it is needed:** only when the relay is configured to require a CAT, which is what the
  *Require C4M* switch tells Studio. With the switch on, Studio swaps the free-text room field
  for the moat room directory, because a CAT has to name a real moat room.
- **Lifetime:** set by moat. Studio requests a fresh one on every join and room switch, so there
  is nothing to cache or paste.

## Which ones do I need?

| Setup | #1 | #2 | #3 | #4 | What you do in Studio |
|---|---|---|---|---|---|
| Non-Cloudflare relay (moqx, moq-relay-ietf, …) | – | – | – | – | Type a room name, click **Go live** |
| Cloudflare relay, *Require C4M* off | to mint #2 | ✓ | – | – | Paste #2, type a room name, click **Go live** |
| Cloudflare relay, *Require C4M* on | to mint #2 | ✓ | ✓ | ✓ | Paste #2, turn on C4M, sign in, pick or create a room, click **Join room** |

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `scope resolution failed` (code 3) on connect | #2 missing, expired, or minted for a different relay (check `sub`) |
| Panel: *JWT must have three dot-separated parts* | You pasted #1 (`cfat_…`) instead of #2 |
| Panel: *JWT payload missing publish/subscribe operations* | #2 was minted without `operations` |
| Session refused at SETUP with C4M on | No CAT or an invalid one: sign in again, or the room isn't joinable for this user |
| No room list or *Create* button | *Require C4M* is off. Turn it on, or use the header **Room** field. |
| Mint call returns `Authentication error` (10000) | #1 revoked or rotated: create a new one and update `~/.config/cf-moq.env` |

## Hygiene

- Never commit #1. Keep it in `~/.config/cf-moq.env` and out of `.claude/settings*.json`
  allowlists, shell history and chat. If it leaks, rotate it. Relay tokens you've already
  minted keep working after a rotation.
- #2 grants relay access until `exp`. Treat links that carry it as semi-private.
