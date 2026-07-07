/**
 * MoQ C4M Auth Demo — 3 panels
 *
 * 1. Publisher: Google IDP → moat token (publish scope) → publishes video via relay
 * 2. Authorized Subscriber: Google IDP → moat token (subscribe scope) → subscribes OK
 * 3. Denied Subscriber: Invalid token → relay rejects subscribe
 */

import { MOQTransport } from '@web-moq/core';
import { MOQTSession } from '@web-moq/session';
import { MediaSession, type MediaConfig } from '@web-moq/media';
import {
  CatTokenDecoder,
  CatTokenBuilder,
  MoqtAction,
  CoseAlgorithm,
  base64urlDecode,
  base64urlEncode,
  generateTestKeyPair,
  generateTestCatToken,
  catTokenToBase64url,
  type CatToken,
  type MoqtScope,
} from '@web-moq/cat';

// ============================================================================
// Types
// ============================================================================

interface TimelineEvent {
  time: Date;
  type: 'send' | 'recv' | 'error' | 'wait';
  label: string;
  detail?: string;
}

interface DecodedTokenView {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  raw: string;
  scopes: string[];
  isExpired: boolean;
}

// ============================================================================
// Config
// ============================================================================

const GOOGLE_CLIENT_ID = '671105403127-u8qe711ovdobtgh2hsfb91u6m7k3qgu9.apps.googleusercontent.com';

const MEDIA_CONFIG: MediaConfig = {
  videoBitrate: 1_500_000,
  audioBitrate: 64_000,
  videoResolution: '480p',
  keyframeInterval: 2,
  deliveryTimeout: 5000,
  deliveryMode: 'stream',
  audioEnabled: false,
};

// ============================================================================
// State
// ============================================================================

let pubMoatSession: string | null = null;
let subMoatSession: string | null = null;

let pubMediaSession: MediaSession | null = null;
let subMediaSession: MediaSession | null = null;

// ============================================================================
// DOM Helpers
// ============================================================================

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function getRelayUrl(): string {
  return (document.getElementById('relay-url') as HTMLInputElement).value.trim();
}

function getTokenServiceUrl(): string {
  return (document.getElementById('token-service-url') as HTMLInputElement).value.trim();
}

function getRoomId(): string {
  return (document.getElementById('room-id') as HTMLInputElement).value.trim();
}

function getNamespace(): string[] {
  return ['mocha', getRoomId()];
}

// ============================================================================
// Timeline
// ============================================================================

function addEvent(panelId: string, ev: TimelineEvent) {
  const el = $(`timeline-${panelId}`);
  const timeStr = ev.time.toLocaleTimeString('en-US', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    fractionalSecondDigits: 3,
  } as Intl.DateTimeFormatOptions);
  const icons: Record<string, string> = {
    send: 'arrow_upward', recv: 'arrow_downward', error: 'close', wait: 'hourglass_empty',
  };
  const html = `
    <div class="timeline-event">
      <div class="timeline-dot ${ev.type}">
        <span class="material-icons-outlined" style="font-size:9px">${icons[ev.type]}</span>
      </div>
      <div class="timeline-content">
        <div class="timeline-label">${ev.label}</div>
        ${ev.detail ? `<div class="timeline-detail">${escapeHtml(ev.detail)}</div>` : ''}
      </div>
      <div class="timeline-time">${timeStr}</div>
    </div>`;
  el.insertAdjacentHTML('beforeend', html);
  el.scrollTop = el.scrollHeight;
}

function setStatus(panelId: string, text: string, cls: string) {
  const el = $(`status-${panelId}`);
  el.textContent = text;
  el.className = `badge badge-${cls}`;
}

// ============================================================================
// Token helpers (using @web-moq/cat library)
// ============================================================================

const MOQT_ACTION_NAMES: Record<number, string> = {
  0: 'ClientSetup', 1: 'ServerSetup', 2: 'PublishNamespace',
  3: 'SubscribeNamespace', 4: 'Subscribe', 5: 'RequestUpdate',
  6: 'Publish', 7: 'Fetch', 8: 'TrackStatus',
};

const COSE_ALG_NAMES: Record<number, string> = { [-7]: 'ES256', [-35]: 'ES384', [-36]: 'ES512' };

function decodeTokenForDisplay(token: string): DecodedTokenView | null {
  try {
    // Try CWT/COSE (C4M) decoding via library
    let catToken: CatToken;
    if (token.includes('.')) {
      catToken = CatTokenDecoder.decodeFromDotSeparated(token);
    } else {
      catToken = CatTokenDecoder.decodeFromBase64url(token);
    }

    // Convert to display format
    const header: Record<string, unknown> = {};
    for (const [k, v] of catToken.header) {
      if (k === 1) header['alg'] = COSE_ALG_NAMES[v as number] ?? v;
      else if (k === 3) header['cty'] = v;
      else if (k === 4) header['kid'] = v;
      else if (k === 16) header['token_type'] = v;
      else header[String(k)] = v;
    }

    const claims = catToken.claims;
    const payload: Record<string, unknown> = {};
    if (claims.iss) payload.iss = claims.iss;
    if (claims.sub) payload.sub = claims.sub;
    if (claims.aud) payload.aud = claims.aud;
    if (claims.exp) payload.exp = claims.exp;
    if (claims.nbf) payload.nbf = claims.nbf;
    if (claims.iat) payload.iat = claims.iat;
    if (claims.cti) payload.cti = claims.cti;

    const scopes: string[] = [];
    if (claims.moqt) {
      payload.moqt = claims.moqt.map(scope => ({
        actions: scope.actions.map(a => MOQT_ACTION_NAMES[a] ?? `action(${a})`),
        ns_match: scope.namespaceMatch ?? null,
        track_match: scope.trackMatch ?? null,
      }));
      for (const scope of claims.moqt) {
        scopes.push(...scope.actions.map(a => MOQT_ACTION_NAMES[a] ?? `action(${a})`));
      }
    }

    const isExpired = claims.exp ? (claims.exp * 1000 < Date.now()) : false;

    return { header, payload, raw: token, scopes, isExpired };
  } catch {
    return null;
  }
}

function renderToken(panelId: string, token: string) {
  const el = $(`token-${panelId}`);
  const decoded = decodeTokenForDisplay(token);
  if (!decoded) {
    el.innerHTML = `<div class="token-raw">${escapeHtml(token)}</div>`;
    return;
  }

  const formatLabel = 'C4M (CWT/CBOR)';

  const iss = decoded.payload.iss instanceof Uint8Array
    ? new TextDecoder().decode(decoded.payload.iss)
    : decoded.payload.iss;
  const sub = decoded.payload.sub instanceof Uint8Array
    ? new TextDecoder().decode(decoded.payload.sub)
    : decoded.payload.sub;
  const aud = Array.isArray(decoded.payload.aud)
    ? decoded.payload.aud.map((a: any) => a instanceof Uint8Array ? new TextDecoder().decode(a) : a).join(', ')
    : decoded.payload.aud instanceof Uint8Array
      ? new TextDecoder().decode(decoded.payload.aud)
      : decoded.payload.aud;

  const exp = decoded.payload.exp ? new Date((decoded.payload.exp as number) * 1000).toISOString() : 'none';

  el.innerHTML = `
    <div class="token-part">
      <div class="token-label">Format</div>
      <div class="token-value">${formatLabel}</div>
    </div>
    <div class="token-part">
      <div class="token-label">Algorithm</div>
      <div class="token-value">${decoded.header.alg || 'unknown'} ${decoded.header.alg === 'ES256' ? '(valid asymmetric)' : '(invalid/fake)'}</div>
    </div>
    <div class="token-part">
      <div class="token-label">Issuer</div>
      <div class="token-value">${escapeHtml(String(iss || 'none'))}</div>
    </div>
    <div class="token-part">
      <div class="token-label">Subject</div>
      <div class="token-value">${escapeHtml(String(sub || 'none'))}</div>
    </div>
    <div class="token-part">
      <div class="token-label">Audience</div>
      <div class="token-value">${escapeHtml(String(aud || 'none'))}</div>
    </div>
    <div class="token-part">
      <div class="token-label">Expires</div>
      <div class="token-value">${exp}${decoded.isExpired ? ' <span style="color:var(--red)">(EXPIRED)</span>' : ''}</div>
    </div>
    ${decoded.scopes.length ? `
    <div class="token-part">
      <div class="token-label">Scopes</div>
      <div>${decoded.scopes.map(s => `<span class="scope-chip ${s.includes('pub') ? 'publish' : 'subscribe'}">${s}</span>`).join('')}</div>
    </div>` : ''}
    <div class="token-part">
      <div class="token-label">Claims (decoded)</div>
      <div class="token-raw">${escapeHtml(JSON.stringify(decoded.payload, replacer, 2))}</div>
    </div>
    <div class="token-part">
      <div class="token-label">Raw Token</div>
      <div class="token-raw">${escapeHtml(decoded.raw.slice(0, 120))}...</div>
    </div>
  `;
}

function replacer(_key: string, value: any): any {
  if (value instanceof Uint8Array) {
    // Try to decode as UTF-8 string
    try {
      const str = new TextDecoder().decode(value);
      if (/^[\x20-\x7e]+$/.test(str)) return str;
    } catch { /* fall through */ }
    return `<${value.length} bytes>`;
  }
  return value;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================================
// Moat API
// ============================================================================

async function moatGoogleLogin(idToken: string, panelId: string): Promise<string> {
  const baseUrl = getTokenServiceUrl();
  addEvent(panelId, { time: new Date(), type: 'send', label: 'POST /auth/google', detail: 'Exchange Google ID token for moat session' });

  const res = await fetch(`${baseUrl}/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
  });
  if (!res.ok) throw new Error(`Google login failed: ${res.status}`);
  const data = await res.json();

  addEvent(panelId, { time: new Date(), type: 'recv', label: 'Session OK', detail: `user=${data.user_id}` });
  return data.session_token;
}

async function ensureRoom(): Promise<void> {
  const baseUrl = getTokenServiceUrl();
  const roomId = getRoomId();

  // Check if room already exists
  const listRes = await fetch(`${baseUrl}/rooms`);
  if (listRes.ok) {
    const rooms = await listRes.json();
    if (rooms.some((r: { name: string }) => r.name === roomId)) {
      return; // room exists
    }
  }

  // Try to create
  const res = await fetch(`${baseUrl}/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: roomId, namespace_prefix: `mocha/${roomId}`, visibility: 'public' }),
  });
  if (!res.ok && res.status !== 409 && res.status !== 500) {
    throw new Error(`Room creation failed: ${res.status}`);
  }
}

async function mintToken(sessionToken: string, role: string, panelId: string): Promise<string> {
  const baseUrl = getTokenServiceUrl();
  const roomId = getRoomId();

  await ensureRoom();

  addEvent(panelId, { time: new Date(), type: 'send', label: 'POST /token', detail: `role=${role}, room=${roomId}` });

  const res = await fetch(`${baseUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
    body: JSON.stringify({ room_id: roomId, role: role === 'pubsub' ? undefined : role }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token mint failed: ${res.status} ${text}`);
  }
  const data = await res.json();

  addEvent(panelId, { time: new Date(), type: 'recv', label: 'Token minted (ES256)', detail: `expires_at=${data.expires_at}` });
  return data.token;
}

// ============================================================================
// Fake token generators (for denied panel)
// ============================================================================

// Cached test key pair for generating fake tokens
let testKeyPairPromise: Promise<CryptoKeyPair> | null = null;
function getTestKeyPair(): Promise<CryptoKeyPair> {
  if (!testKeyPairPromise) {
    testKeyPairPromise = generateTestKeyPair();
  }
  return testKeyPairPromise;
}

async function generateInvalidToken(mode: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const roomId = getRoomId();
  const keyPair = await getTestKeyPair();

  switch (mode) {
    case 'wrong-scope': {
      const { tokenBytes } = await generateTestCatToken({
        keyPair,
        scopes: [{
          actions: [MoqtAction.Subscribe],
          namespaceMatch: ['mocha', `WRONG-ROOM-${Date.now().toString(36)}`],
        }],
        claims: { sub: 'wrong-scope-user', aud: ['moq-relay'] },
      });
      return catTokenToBase64url(tokenBytes);
    }
    case 'expired': {
      const { tokenBytes } = await generateTestCatToken({
        keyPair,
        expired: true,
        claims: { sub: 'expired-user', aud: ['moq-relay'] },
      });
      return catTokenToBase64url(tokenBytes);
    }
    case 'bad-sig': {
      // Sign with proper format, then corrupt signature
      const { tokenBytes } = await generateTestCatToken({
        keyPair,
        scopes: [{
          actions: [MoqtAction.Subscribe],
          namespaceMatch: ['mocha', roomId],
        }],
        claims: { sub: 'badsig-user', aud: ['moq-relay'] },
      });
      // Corrupt last 16 bytes of the token (part of signature)
      const corrupted = new Uint8Array(tokenBytes);
      for (let i = corrupted.length - 16; i < corrupted.length; i++) {
        corrupted[i] ^= 0xff;
      }
      return catTokenToBase64url(corrupted);
    }
    case 'guest': {
      // Generate a valid-format token but from a self-signed key (relay won't trust it)
      const guestKeyPair = await generateTestKeyPair();
      const { tokenBytes } = await generateTestCatToken({
        keyPair: guestKeyPair,
        claims: {
          iss: 'anonymous',
          sub: `guest-${Date.now().toString(36)}`,
          aud: ['moq-relay'],
          exp: now + 300,
        },
        scopes: [{
          actions: [MoqtAction.Subscribe],
          namespaceMatch: ['mocha', roomId],
        }],
      });
      return catTokenToBase64url(tokenBytes);
    }
    case 'no-token':
    default:
      return '';
  }
}

// ============================================================================
// MOQT Connection
// ============================================================================

/** Convert a token string to RequestAuthToken bytes for per-request auth */
function tokenToRequestAuth(token: string): { tokenBytes: Uint8Array; tokenType: number } | undefined {
  if (!token) return undefined;
  return { tokenBytes: base64urlDecode(token), tokenType: 0x63346d };
}

async function createMediaSession(token: string, panelId: string): Promise<MediaSession> {
  const relayUrl = getRelayUrl();

  addEvent(panelId, { time: new Date(), type: 'send', label: 'WebTransport CONNECT', detail: relayUrl });

  const transport = new MOQTransport();
  await transport.connect(relayUrl);

  addEvent(panelId, { time: new Date(), type: 'recv', label: 'WebTransport Ready' });

  const session = new MOQTSession(transport);
  if (token) {
    session.setAuthToken(token, 0x63346d);
  }

  addEvent(panelId, { time: new Date(), type: 'send', label: 'CLIENT_SETUP', detail: `token_type=0x63346d (c4m)` });

  await session.setup();

  addEvent(panelId, { time: new Date(), type: 'recv', label: 'SERVER_SETUP', detail: 'Authorized - session established' });

  const mediaSession = new MediaSession({ session });
  return mediaSession;
}

// ============================================================================
// Publisher flow
// ============================================================================

async function startPublish() {
  const panelId = 'pub';
  try {
    setStatus(panelId, 'CONNECTING', 'yellow');

    const token = await mintToken(pubMoatSession!, 'publisher', panelId);
    renderToken(panelId, token);

    pubMediaSession = await createMediaSession(token, panelId);

    // Get camera
    addEvent(panelId, { time: new Date(), type: 'wait', label: 'getUserMedia', detail: 'Requesting camera...' });
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: false,
    });

    const video = $('video-pub') as HTMLVideoElement;
    video.srcObject = stream;
    $('overlay-pub').classList.add('hidden');
    $('video-status-pub').innerHTML = '<span class="badge badge-green" style="font-size:9px">PUBLISHING</span>';

    // Publish via MOQT
    const ns = getNamespace();
    addEvent(panelId, { time: new Date(), type: 'send', label: 'PUBLISH', detail: `namespace=[${ns.join('/')}], track=video` });

    await pubMediaSession.publish(ns, 'video', stream, {
      ...MEDIA_CONFIG,
      authToken: tokenToRequestAuth(token),
    });

    addEvent(panelId, { time: new Date(), type: 'recv', label: 'Publishing active', detail: 'Video flowing to relay' });
    setStatus(panelId, 'PUBLISHING', 'green');

    ($('btn-publish') as HTMLButtonElement).disabled = true;
    ($('btn-stop-pub') as HTMLButtonElement).disabled = false;
  } catch (err: any) {
    addEvent(panelId, { time: new Date(), type: 'error', label: 'Publish failed', detail: err.message });
    setStatus(panelId, 'ERROR', 'red');
  }
}

async function stopPublish() {
  if (pubMediaSession) {
    await pubMediaSession.close();
    pubMediaSession = null;
  }
  const video = $('video-pub') as HTMLVideoElement;
  if (video.srcObject) {
    (video.srcObject as MediaStream).getTracks().forEach(t => t.stop());
    video.srcObject = null;
  }
  $('overlay-pub').classList.remove('hidden');
  $('video-status-pub').innerHTML = '';
  setStatus('pub', 'IDLE', 'yellow');
  ($('btn-publish') as HTMLButtonElement).disabled = false;
  ($('btn-stop-pub') as HTMLButtonElement).disabled = true;
  addEvent('pub', { time: new Date(), type: 'send', label: 'Stopped publishing' });
}

// ============================================================================
// Authorized subscriber flow
// ============================================================================

async function startSubscribe() {
  const panelId = 'sub';
  try {
    setStatus(panelId, 'CONNECTING', 'yellow');

    const token = await mintToken(subMoatSession!, 'subscriber', panelId);
    renderToken(panelId, token);

    subMediaSession = await createMediaSession(token, panelId);

    const ns = getNamespace();
    addEvent(panelId, { time: new Date(), type: 'send', label: 'SUBSCRIBE', detail: `namespace=[${ns.join('/')}], track=video` });

    const video = $('video-sub') as HTMLVideoElement;

    subMediaSession.on('video-frame', ({ frame }: { subscriptionId: number; frame: VideoFrame }) => {
      if (!video.srcObject) {
        const generator = new MediaStreamTrackGenerator({ kind: 'video' });
        const writable = generator.writable.getWriter();
        video.srcObject = new MediaStream([generator]);
        $('overlay-sub').classList.add('hidden');
        $('video-status-sub').innerHTML = '<span class="badge badge-green" style="font-size:9px">RECEIVING</span>';
        setStatus(panelId, 'SUBSCRIBED', 'green');
        addEvent(panelId, { time: new Date(), type: 'recv', label: 'First frame received', detail: `${frame.displayWidth}x${frame.displayHeight}` });
        (video as any)._frameWriter = writable;
      }
      (video as any)._frameWriter?.write(frame).catch(() => {});
    });

    await subMediaSession.subscribe(ns, 'video', {
      ...MEDIA_CONFIG,
      authToken: tokenToRequestAuth(token),
    }, 'video');

    addEvent(panelId, { time: new Date(), type: 'recv', label: 'Subscribe accepted', detail: 'Waiting for video frames...' });

    ($('btn-subscribe') as HTMLButtonElement).disabled = true;
    ($('btn-stop-sub') as HTMLButtonElement).disabled = false;
  } catch (err: any) {
    addEvent(panelId, { time: new Date(), type: 'error', label: 'Subscribe failed', detail: err.message });
    setStatus(panelId, 'ERROR', 'red');
  }
}

async function stopSubscribe() {
  if (subMediaSession) {
    await subMediaSession.close();
    subMediaSession = null;
  }
  const video = $('video-sub') as HTMLVideoElement;
  video.srcObject = null;
  (video as any)._frameWriter = null;
  $('overlay-sub').classList.remove('hidden');
  $('video-status-sub').innerHTML = '';
  setStatus('sub', 'IDLE', 'yellow');
  ($('btn-subscribe') as HTMLButtonElement).disabled = false;
  ($('btn-stop-sub') as HTMLButtonElement).disabled = true;
  addEvent('sub', { time: new Date(), type: 'send', label: 'Stopped subscribing' });
}

// ============================================================================
// Denied subscriber flow
// ============================================================================

/**
 * "Bad Subscribe Token" mode:
 * 1. Mint a VALID token and use it for CLIENT_SETUP (session establishes OK)
 * 2. Generate an INVALID token and send it as per-request AUTHORIZATION_TOKEN in SUBSCRIBE
 * 3. Tests whether the relay enforces per-action auth, not just session-level
 */
async function tryBadSubscribeToken(panelId: string) {
  // Step 1: Get a valid subscriber session (reuse existing or create new)
  const moatSession = subMoatSession ?? pubMoatSession;
  if (!moatSession) {
    addEvent(panelId, { time: new Date(), type: 'error', label: 'Sign in first', detail: 'Need Google sign-in to get a valid session token' });
    setStatus(panelId, 'ERROR', 'red');
    return;
  }

  // Step 2: Mint a VALID token for CLIENT_SETUP
  const validToken = await mintToken(moatSession, 'subscriber', panelId);
  addEvent(panelId, { time: new Date(), type: 'send', label: 'Minted VALID token', detail: 'For CLIENT_SETUP (session-level auth)' });

  // Step 3: Create session with valid token
  const relayUrl = getRelayUrl();
  addEvent(panelId, { time: new Date(), type: 'send', label: 'WebTransport CONNECT', detail: relayUrl });

  const transport = new MOQTransport();
  await transport.connect(relayUrl);
  addEvent(panelId, { time: new Date(), type: 'recv', label: 'WebTransport Ready' });

  const session = new MOQTSession(transport);
  session.setAuthToken(validToken, 0x63346d);

  addEvent(panelId, { time: new Date(), type: 'send', label: 'CLIENT_SETUP', detail: 'Using VALID token — should succeed' });
  await session.setup();
  addEvent(panelId, { time: new Date(), type: 'recv', label: 'SERVER_SETUP OK', detail: 'Session established with valid token' });

  // Step 4: Generate an INVALID token for the SUBSCRIBE request parameter
  const invalidToken = await generateInvalidToken('bad-sig');
  const invalidTokenBytes = base64urlDecode(invalidToken);
  addEvent(panelId, { time: new Date(), type: 'send', label: 'Generated INVALID token', detail: 'Bad signature — will send in SUBSCRIBE request parameter' });

  // Show both tokens in the inspector
  renderToken(panelId, invalidToken);

  // Step 5: Subscribe with invalid per-request auth token
  const ns = getNamespace();
  addEvent(panelId, { time: new Date(), type: 'send', label: 'SUBSCRIBE', detail: `namespace=[${ns.join('/')}], track=video\n⚠ Per-request AUTHORIZATION_TOKEN = INVALID (bad-sig)` });

  const mediaSession = new MediaSession({ session });
  await mediaSession.subscribe(ns, 'video', {
    ...MEDIA_CONFIG,
    authToken: { tokenBytes: invalidTokenBytes, tokenType: 0x63346d },
  }, 'video');

  // If we got here, relay didn't check per-request token
  addEvent(panelId, { time: new Date(), type: 'recv', label: 'Subscribe accepted (!)', detail: 'Relay did NOT check per-request AUTHORIZATION_TOKEN in SUBSCRIBE' });
  setStatus(panelId, 'UNEXPECTED', 'yellow');

  await mediaSession.close();
}

async function trySubscribeDenied() {
  const panelId = 'denied';
  const mode = (document.getElementById('denied-mode') as HTMLSelectElement).value;

  try {
    setStatus(panelId, 'CONNECTING', 'yellow');

    // "bad-subscribe" mode: valid CLIENT_SETUP, invalid per-request SUBSCRIBE token
    if (mode === 'bad-subscribe') {
      return await tryBadSubscribeToken(panelId);
    }

    const token = await generateInvalidToken(mode);
    if (token) {
      renderToken(panelId, token);
    } else {
      $(`token-${panelId}`).innerHTML = '<span style="color:var(--red)">No token (empty)</span>';
    }

    addEvent(panelId, { time: new Date(), type: 'send', label: 'Using invalid token', detail: `mode=${mode}` });

    // Try to connect with the invalid token
    const relayUrl = getRelayUrl();
    addEvent(panelId, { time: new Date(), type: 'send', label: 'WebTransport CONNECT', detail: relayUrl });

    const transport = new MOQTransport();
    await transport.connect(relayUrl);

    addEvent(panelId, { time: new Date(), type: 'recv', label: 'WebTransport Ready', detail: 'QUIC connected (auth not checked yet)' });

    const session = new MOQTSession(transport);
    if (token) {
      session.setAuthToken(token, 0x63346d);
    }

    addEvent(panelId, { time: new Date(), type: 'send', label: 'CLIENT_SETUP', detail: `token_type=0x63346d, token=${token ? token.slice(0, 20) + '...' : '(none)'}` });

    await session.setup();

    // If setup succeeds, try to subscribe — auth might be per-action
    addEvent(panelId, { time: new Date(), type: 'wait', label: 'SERVER_SETUP received', detail: 'Trying SUBSCRIBE (relay may deny per-action)...' });

    const ns = getNamespace();
    addEvent(panelId, { time: new Date(), type: 'send', label: 'SUBSCRIBE', detail: `namespace=[${ns.join('/')}], track=video` });

    const mediaSession = new MediaSession({ session });
    await mediaSession.subscribe(ns, 'video', MEDIA_CONFIG, 'video');

    // If we got here, the relay didn't deny (unexpected)
    addEvent(panelId, { time: new Date(), type: 'recv', label: 'Subscribe accepted (!)', detail: 'Unexpected - relay should have denied' });
    setStatus(panelId, 'UNEXPECTED', 'yellow');

    await mediaSession.close();
  } catch (err: any) {
    const msg = err.message || String(err);
    const isAuthError = msg.includes('403') || msg.includes('401') || msg.includes('denied') ||
      msg.includes('unauthorized') || msg.includes('Unauthorized') || msg.includes('RESET_STREAM') ||
      msg.includes('Timeout') || msg.includes('timeout') || msg.includes('Connection lost') ||
      msg.includes('close') || msg.includes('rejected') || msg.includes('session');
    if (isAuthError) {
      setStatus(panelId, 'DENIED', 'red');
      addEvent(panelId, { time: new Date(), type: 'error', label: 'AUTHORIZATION DENIED', detail: `Relay rejected connection: ${msg}` });
    } else {
      setStatus(panelId, 'ERROR', 'red');
      addEvent(panelId, { time: new Date(), type: 'error', label: 'Failed', detail: msg });
    }
  }

  ($('btn-stop-denied') as HTMLButtonElement).disabled = false;
}

function resetDenied() {
  $('overlay-denied').classList.remove('hidden');
  $('video-status-denied').innerHTML = '';
  setStatus('denied', 'IDLE', 'yellow');
  ($('btn-stop-denied') as HTMLButtonElement).disabled = true;
  $('timeline-denied').innerHTML = '';
  $('token-denied').innerHTML = '<span style="color:var(--text-dim)">Select mode and click "Try Subscribe"</span>';
}

// ============================================================================
// Google Sign-In
// ============================================================================

function initGoogleSignIn() {
  const initInterval = setInterval(() => {
    if (!(window as any).google?.accounts?.id) return;
    clearInterval(initInterval);

    // Publisher sign-in
    (window as any).google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: async (response: any) => {
        try {
          const idToken = response.credential;
          const payload = JSON.parse(atob(idToken.split('.')[1]));
          pubMoatSession = await moatGoogleLogin(idToken, 'pub');
          $('google-signin-pub').style.display = 'none';
          $('google-user-pub').style.display = 'flex';
          $('google-user-pub').textContent = payload.name || payload.email;
          ($('btn-publish') as HTMLButtonElement).disabled = false;
        } catch (err: any) {
          addEvent('pub', { time: new Date(), type: 'error', label: 'Google login failed', detail: err.message });
        }
      },
    });

    (window as any).google.accounts.id.renderButton($('google-signin-pub'), {
      theme: 'filled_black', size: 'medium', width: 220,
    });

    // For subscriber, we render a second button but reuse the same credential
    // Google GSI only allows one initialize() call, so we'll use a prompt or manual trigger
    const subBtn = document.createElement('button');
    subBtn.className = 'btn-green';
    subBtn.textContent = 'Sign in with Google';
    subBtn.style.fontSize = '12px';
    subBtn.addEventListener('click', () => {
      (window as any).google.accounts.id.prompt((notification: any) => {
        if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
          // Prompt not shown — try using same session as publisher
          if (pubMoatSession) {
            subMoatSession = pubMoatSession;
            $('google-signin-sub').style.display = 'none';
            $('google-user-sub').style.display = 'flex';
            $('google-user-sub').textContent = ($('google-user-pub').textContent || 'User') + ' (shared)';
            ($('btn-subscribe') as HTMLButtonElement).disabled = false;
            addEvent('sub', { time: new Date(), type: 'recv', label: 'Using shared moat session' });
          } else {
            addEvent('sub', { time: new Date(), type: 'error', label: 'Sign in as publisher first' });
          }
        }
      });
    });
    $('google-signin-sub').appendChild(subBtn);

    // Also add a "use same session" shortcut
    const shareBtn = document.createElement('button');
    shareBtn.className = 'btn-outline';
    shareBtn.textContent = 'Use Publisher Session';
    shareBtn.style.fontSize = '11px';
    shareBtn.style.marginLeft = '6px';
    shareBtn.addEventListener('click', () => {
      if (pubMoatSession) {
        subMoatSession = pubMoatSession;
        $('google-signin-sub').style.display = 'none';
        $('google-user-sub').style.display = 'flex';
        $('google-user-sub').textContent = ($('google-user-pub').textContent || 'User') + ' (shared)';
        ($('btn-subscribe') as HTMLButtonElement).disabled = false;
        addEvent('sub', { time: new Date(), type: 'recv', label: 'Reusing publisher moat session' });
      } else {
        addEvent('sub', { time: new Date(), type: 'error', label: 'Publisher not signed in yet' });
      }
    });
    $('google-signin-sub').appendChild(shareBtn);
  }, 200);
}

// ============================================================================
// Panel Selection (detail area switching)
// ============================================================================

// Tab switching within each panel
document.querySelectorAll('.panel-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const targetId = (tab as HTMLElement).dataset.tab!;
    const container = tab.closest('.panel-detail')!;
    container.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
    container.querySelectorAll('.panel-tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(targetId)?.classList.add('active');
  });
});

// ============================================================================
// Event Wiring
// ============================================================================

$('btn-publish').addEventListener('click', startPublish);
$('btn-stop-pub').addEventListener('click', stopPublish);
$('btn-subscribe').addEventListener('click', startSubscribe);
$('btn-stop-sub').addEventListener('click', stopSubscribe);
$('btn-subscribe-denied').addEventListener('click', trySubscribeDenied);
$('btn-stop-denied').addEventListener('click', resetDenied);

$('btn-reset-all').addEventListener('click', async () => {
  // Stop all sessions
  await stopPublish();
  await stopSubscribe();
  resetDenied();

  // Clear timelines and token inspectors
  for (const p of ['pub', 'sub', 'denied']) {
    $(`timeline-${p}`).innerHTML = '';
    $(`token-${p}`).innerHTML = '<span style="color:var(--text-dim)">—</span>';
  }

  // Re-enable buttons
  if (pubMoatSession) {
    ($('btn-publish') as HTMLButtonElement).disabled = false;
  }
  if (subMoatSession) {
    ($('btn-subscribe') as HTMLButtonElement).disabled = false;
  }
});

initGoogleSignIn();
