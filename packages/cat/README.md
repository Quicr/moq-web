# @moq-web/cat

CTA/C4M Common Access Tokens for the MoQ Web stack. The package provides strict CBOR/COSE/CWT encoding, CAT validation, generic CWT DPoP proofs, request-policy evaluation, replay protection, key resolution, and optional encrypted CWT payloads.

## End-to-end CAT + DPoP flow

The issuer signs the CAT. The browser keeps the DPoP private key and sends a proof with the CAT. The relay resolves the issuer key, verifies the CAT and proof, checks replay state, and evaluates the MoQT request scope.

### Issuer

Keep the issuer key in a KMS/HSM or other protected key store in production. This example uses WebCrypto only to keep the flow self-contained.

```ts
import {
  CatTokenBuilder,
  CoseAlgorithm,
  CoseHeaderParam,
  MoqtAction,
  base64urlEncode,
} from '@moq-web/cat';

const issuerKeys = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,
  ['sign', 'verify'],
);
const issuerKid = new TextEncoder().encode('issuer-key-2026-01');

// clientJkt is supplied by the browser during authorization.
export async function issueCat(clientJkt: Uint8Array): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  return new CatTokenBuilder()
    .withAlgorithm(CoseAlgorithm.ES256)
    .issuer('https://auth.example.com')
    .subject('user-123')
    .audience('moq-relay')
    .issuedAt(now)
    .expiration(now + 600)
    .cwtId(crypto.getRandomValues(new Uint8Array(16)))
    .replayPolicy(2)
    .confirmation(new Map([[323, clientJkt]]))
    .dpopSettings(new Map([[0, 300], [1, 1]]))
    .moqtScopes([{
      actions: [MoqtAction.Subscribe],
      namespaceMatch: ['rooms', 'room-42'],
      trackMatch: 'video',
    }])
    .protectedHeader(CoseHeaderParam.KID, issuerKid)
    .signToBase64url(issuerKeys.privateKey);
}

console.log('issuer kid:', base64urlEncode(issuerKid));
```

### Browser client

The generated DPoP private key is non-exportable. Persist it using an appropriate browser key-management strategy if the client must survive reloads.

```ts
import {
  base64urlDecode,
  base64urlEncode,
  createDpopProof,
  generateDpopKeyPair,
  jwkThumbprint,
  moqtAuthorizationContext,
  CoseAlgorithm,
} from '@moq-web/cat';

const dpopKeys = await generateDpopKeyPair(CoseAlgorithm.ES256);
const clientJkt = await jwkThumbprint(dpopKeys.publicKey);

// Send clientJkt to the issuer and receive the CAT.
const catToken = await fetch('/auth/cat', {
  method: 'POST',
  body: JSON.stringify({ jkt: base64urlEncode(clientJkt) }),
}).then(response => response.text());

const authorizationContext = moqtAuthorizationContext({
  action: 'subscribe',
  trackNamespace: ['rooms', 'room-42'],
  trackName: 'video',
});

const dpopProof = await createDpopProof({
  privateKey: dpopKeys.privateKey,
  publicKey: dpopKeys.publicKey,
  authorizationContext,
  accessToken: base64urlDecode(catToken),
  issuedAt: Math.floor(Date.now() / 1000),
});

// Pass these bytes through the MoQ authentication adapter.
const catBytes = base64urlDecode(catToken);
const dpopBytes = dpopProof;

// For an HTTP-style adapter, equivalent values are:
const authorizationHeader = `Bearer ${catToken}`;
const dpopHeader = base64urlEncode(dpopBytes);
```

### Relay

Use a distributed implementation of `ReplayStore` for a multi-instance relay. Its `checkAndStore` operation must be atomic.

```ts
import {
  base64urlDecode,
  base64urlEncode,
  MemoryReplayStore,
  MoqtAction,
  moqtAuthorizationContext,
  staticCatKeyResolver,
  validateCatRequestWithResolver,
} from '@moq-web/cat';

const keyResolver = staticCatKeyResolver(
  new Map([[base64urlEncode(issuerKid), issuerKeys.publicKey]]),
);
const replayStore = new MemoryReplayStore(); // Replace in production.

export async function authorizeMoqRequest(
  catToken: string,
  dpopProof: Uint8Array,
) {
  const expectedContext = moqtAuthorizationContext({
    action: 'subscribe',
    trackNamespace: ['rooms', 'room-42'],
    trackName: 'video',
  });

  return validateCatRequestWithResolver(
    base64urlDecode(catToken),
    keyResolver,
    {
      requiredIssuer: 'https://auth.example.com',
      requiredAudience: 'moq-relay',
      now: Math.floor(Date.now() / 1000),
      replayStore,
      dpopProof,
      dpop: {
        expectedAuthorizationContext: expectedContext,
        expectedContextType: 'moqt',
      },
      request: {
        action: MoqtAction.Subscribe,
        namespace: ['rooms', 'room-42'],
        trackName: 'video',
      },
    },
  );
}

const result = await authorizeMoqRequest(catToken, dpopProof);
if (!result.valid) throw new Error(`Unauthorized: ${result.error}`);
```

`replayPolicy(2)` accepts the CAT once and rejects subsequent presentations. For a CAT intended to authorize multiple independent requests, use `replayPolicy(0)` and retain DPoP proof replay detection with `dpopSettings(new Map([[0, 300], [1, 1]]))`.

## Other APIs

```ts
import {
  CatTokenDecoder,
  decryptCwtClaims,
  encryptCwtClaims,
  generateAesGcmKey,
} from '@moq-web/cat';

// Direct validation when the verification key is already available.
const result = await CatTokenDecoder.validate(catBytes, issuerKeys.publicKey, {
  requiredIssuer: 'https://auth.example.com',
  requiredAudience: 'moq-relay',
});

// Optional encrypted CWT claim payloads.
const encryptionKey = await generateAesGcmKey(3);
const encrypted = await encryptCwtClaims({ sub: 'user-123' }, encryptionKey);
const claims = await decryptCwtClaims(encrypted, encryptionKey);
```

Encryption keys, issuer keys, and replay state must be managed outside the package in production. The package deliberately exposes those boundaries through `CryptoKey`, `CatKeyResolver`, and `ReplayStore`.
