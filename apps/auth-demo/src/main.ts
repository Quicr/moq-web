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

// ============================================================================
// Types
// ============================================================================

interface TimelineEvent {
  time: Date;
  type: 'send' | 'recv' | 'error' | 'wait';
  label: string;
  detail?: string;
}

interface DecodedToken {
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
// Token helpers
// ============================================================================

function base64UrlDecode(s: string): Uint8Array {
  const padded = s + '='.repeat((4 - s.length % 4) % 4);
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeCbor(data: Uint8Array): { value: any; bytesRead: number } {
  let offset = 0;

  function readByte(): number {
    return data[offset++];
  }

  function readUint(additionalInfo: number): number {
    if (additionalInfo < 24) return additionalInfo;
    if (additionalInfo === 24) return readByte();
    if (additionalInfo === 25) {
      const v = (data[offset] << 8) | data[offset + 1];
      offset += 2;
      return v;
    }
    if (additionalInfo === 26) {
      const v = (data[offset] << 24) | (data[offset+1] << 16) | (data[offset+2] << 8) | data[offset+3];
      offset += 4;
      return v >>> 0;
    }
    return 0;
  }

  function decode(): any {
    const initial = readByte();
    const majorType = initial >> 5;
    const additionalInfo = initial & 0x1f;

    switch (majorType) {
      case 0: return readUint(additionalInfo); // unsigned int
      case 1: return -1 - readUint(additionalInfo); // negative int
      case 2: { // byte string
        const len = readUint(additionalInfo);
        const bytes = data.slice(offset, offset + len);
        offset += len;
        return bytes;
      }
      case 3: { // text string
        const len = readUint(additionalInfo);
        const bytes = data.slice(offset, offset + len);
        offset += len;
        return new TextDecoder().decode(bytes);
      }
      case 4: { // array
        const len = readUint(additionalInfo);
        const arr: any[] = [];
        for (let i = 0; i < len; i++) arr.push(decode());
        return arr;
      }
      case 5: { // map
        const len = readUint(additionalInfo);
        const map: Record<string, any> = {};
        for (let i = 0; i < len; i++) {
          const key = decode();
          const val = decode();
          map[String(key)] = val;
        }
        return map;
      }
      case 7: { // simple/float
        if (additionalInfo === 20) return false;
        if (additionalInfo === 21) return true;
        if (additionalInfo === 22) return null;
        return additionalInfo;
      }
      default: return null;
    }
  }

  const value = decode();
  return { value, bytesRead: offset };
}

// CWT claim keys
const CWT_CLAIMS: Record<string, string> = {
  '1': 'iss', '2': 'sub', '3': 'aud', '4': 'exp', '5': 'nbf', '6': 'iat', '7': 'cti',
  '327': 'moqt', '65000': 'moqt',
};
const COSE_HEADER: Record<string, string> = {
  '1': 'alg', '3': 'cty', '4': 'kid', '16': 'token_type',
};
const COSE_ALG: Record<number, string> = { [-7]: 'ES256', [-35]: 'ES384', [-36]: 'ES512' };

function decodeC4mToken(token: string): DecodedToken | null {
  try {
    let headerBytes: Uint8Array;
    let payloadBytes: Uint8Array;

    if (token.includes('.')) {
      // Legacy dot-separated format: base64url(header).base64url(payload).base64url(sig)
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      headerBytes = base64UrlDecode(parts[0]);
      payloadBytes = base64UrlDecode(parts[1]);
    } else {
      // Standard COSE_Sign1: base64url(CBOR array [protected, unprotected, payload, sig])
      const coseBytes = base64UrlDecode(token);
      const cose = decodeCbor(coseBytes).value;
      if (!Array.isArray(cose) || cose.length < 4) return null;
      // cose[0] = protected header (bstr containing CBOR map)
      // cose[2] = payload (bstr containing CBOR map)
      if (!(cose[0] instanceof Uint8Array) || !(cose[2] instanceof Uint8Array)) return null;
      headerBytes = cose[0];
      payloadBytes = cose[2];
    }

    const headerRaw = decodeCbor(headerBytes).value;
    const payloadRaw = decodeCbor(payloadBytes).value;

    if (!headerRaw || !payloadRaw) return null;
    if (typeof headerRaw !== 'object' || typeof payloadRaw !== 'object') return null;

    // Map numeric keys to named claims
    const header: Record<string, any> = {};
    for (const [k, v] of Object.entries(headerRaw)) {
      const name = COSE_HEADER[k] || k;
      header[name] = name === 'alg' ? (COSE_ALG[v as number] || v) : v;
    }

    const payload: Record<string, any> = {};
    for (const [k, v] of Object.entries(payloadRaw)) {
      const name = CWT_CLAIMS[k] || k;
      payload[name] = v;
    }

    const exp = payload.exp ? new Date(payload.exp * 1000) : null;
    const isExpired = exp ? exp < new Date() : false;

    // Decode MoQT claim: may be bstr-wrapped CBOR or direct array
    const moqtValue = payload.moqt;
    let moqtScopes: any[] | null = null;
    if (moqtValue instanceof Uint8Array) {
      try { moqtScopes = decodeCbor(moqtValue).value; } catch {}
    } else if (Array.isArray(moqtValue)) {
      moqtScopes = moqtValue;
    }

    const MOQT_ACTIONS: Record<number, string> = {
      0: 'ClientSetup', 1: 'ServerSetup', 2: 'PublishNamespace',
      3: 'SubscribeNamespace', 4: 'Subscribe', 5: 'RequestUpdate',
      6: 'Publish', 7: 'Fetch', 8: 'TrackStatus',
    };

    const scopes: string[] = [];
    if (Array.isArray(moqtScopes)) {
      for (const scope of moqtScopes) {
        if (Array.isArray(scope) && Array.isArray(scope[0])) {
          const actionNames = scope[0].map((a: number) => MOQT_ACTIONS[a] || `action(${a})`);
          scopes.push(...actionNames);
        }
      }
      // Replace raw bytes in payload with decoded scopes for display
      payload.moqt = moqtScopes.map((scope: any) => {
        if (!Array.isArray(scope)) return scope;
        const actions = Array.isArray(scope[0]) ? scope[0].map((a: number) => MOQT_ACTIONS[a] || a) : scope[0];
        return { actions, ns_match: scope[1] ?? null, track_match: scope[2] ?? null };
      });
    }

    return { header, payload, raw: token, scopes, isExpired };
  } catch {
    return null;
  }
}

function decodeJwt(token: string): DecodedToken | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')));
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    const exp = payload.exp ? new Date(payload.exp * 1000) : null;
    const isExpired = exp ? exp < new Date() : false;
    const scopes: string[] = [];
    if (payload.moqt && Array.isArray(payload.moqt)) {
      for (const scope of payload.moqt) {
        if (scope.actions) scopes.push(...scope.actions);
      }
    }
    return { header, payload, raw: token, scopes, isExpired };
  } catch {
    return null;
  }
}

function renderToken(panelId: string, token: string) {
  const el = $(`token-${panelId}`);
  el.style.display = '';
  // Try C4M (CBOR/CWT) first, then JWT
  const decoded = decodeC4mToken(token) || decodeJwt(token);
  if (!decoded) {
    el.innerHTML = `<div class="token-raw">${escapeHtml(token)}</div>`;
    return;
  }

  const isC4m = decoded.header.token_type !== undefined || decoded.header.alg === 'ES256' && !decoded.header.typ;
  const formatLabel = isC4m ? 'C4M (CWT/CBOR)' : 'JWT';

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

function generateInvalidToken(mode: string): string {
  const now = Math.floor(Date.now() / 1000);
  const roomId = getRoomId();

  switch (mode) {
    case 'wrong-scope': {
      const header = { alg: 'ES256', typ: 'CAT' };
      const payload = {
        iss: 'https://api.mocha-net.dev', aud: ['moq-relay'], sub: 'wrong-scope-user',
        iat: now, exp: now + 3600,
        moqt: [{ actions: ['subscribe'], namespace: `mocha/WRONG-ROOM-${Date.now().toString(36)}` }],
      };
      return fakeJwt(header, payload);
    }
    case 'expired': {
      const header = { alg: 'ES256', typ: 'CAT' };
      const payload = {
        iss: 'https://api.mocha-net.dev', aud: ['moq-relay'], sub: 'expired-user',
        iat: now - 7200, exp: now - 3600,
        moqt: [{ actions: ['subscribe'], namespace: `mocha/${roomId}` }],
      };
      return fakeJwt(header, payload);
    }
    case 'bad-sig': {
      const header = { alg: 'ES256', typ: 'CAT' };
      const payload = {
        iss: 'https://api.mocha-net.dev', aud: ['moq-relay'], sub: 'badsig-user',
        iat: now, exp: now + 3600,
        moqt: [{ actions: ['subscribe'], namespace: `mocha/${roomId}` }],
      };
      const h = btoa(JSON.stringify(header)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const p = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      return `${h}.${p}.INVALID_SIG_xxxxx`;
    }
    case 'guest': {
      const header = { alg: 'HS256', typ: 'CAT' };
      const payload = {
        iss: 'anonymous', aud: ['moq-relay'], sub: `guest-${Date.now().toString(36)}`,
        iat: now, exp: now + 300,
        moqt: [{ actions: ['subscribe'], namespace: `mocha/${roomId}` }],
      };
      return fakeJwt(header, payload);
    }
    case 'no-token':
    default:
      return '';
  }
}

function fakeJwt(header: object, payload: object): string {
  const h = btoa(JSON.stringify(header)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const p = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  const sig = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${h}.${p}.${sig}`;
}

// ============================================================================
// MOQT Connection
// ============================================================================

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

    await pubMediaSession.publish(ns, 'video', stream, MEDIA_CONFIG);

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

    await subMediaSession.subscribe(ns, 'video', MEDIA_CONFIG, 'video');

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

async function trySubscribeDenied() {
  const panelId = 'denied';
  const mode = (document.getElementById('denied-mode') as HTMLSelectElement).value;

  try {
    setStatus(panelId, 'CONNECTING', 'yellow');

    const token = generateInvalidToken(mode);
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
    if (msg.includes('403') || msg.includes('401') || msg.includes('denied') || msg.includes('unauthorized') || msg.includes('Unauthorized') || msg.includes('error')) {
      setStatus(panelId, 'DENIED', 'red');
      addEvent(panelId, { time: new Date(), type: 'error', label: 'AUTHORIZATION DENIED', detail: msg });
    } else if (msg.includes('close') || msg.includes('rejected') || msg.includes('session')) {
      setStatus(panelId, 'DENIED', 'red');
      addEvent(panelId, { time: new Date(), type: 'error', label: 'Connection rejected', detail: msg });
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

let selectedPanel = 'pub';

function selectPanel(panelId: string) {
  selectedPanel = panelId;

  // Update panel borders
  document.querySelectorAll('.video-panel').forEach(el => el.classList.remove('selected'));
  $(`panel-${panelId}`).classList.add('selected');

  // Show/hide timelines and tokens
  const panels = ['pub', 'sub', 'denied'];
  for (const p of panels) {
    $(`timeline-${p}`).style.display = p === panelId ? 'flex' : 'none';
    $(`token-${p}`).style.display = p === panelId ? 'block' : 'none';
  }

  // Update label
  const labels: Record<string, string> = { pub: 'Publisher', sub: 'Subscriber', denied: 'Denied' };
  $('detail-panel-label').textContent = labels[panelId] || '';
}

// Click handlers on panels
document.querySelectorAll('.video-panel').forEach(el => {
  el.addEventListener('click', (e) => {
    // Don't select panel if user clicked a button/select/input inside
    if ((e.target as HTMLElement).closest('button, select, input, .google-row')) return;
    const panelId = (el as HTMLElement).dataset.panel!;
    selectPanel(panelId);
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

initGoogleSignIn();
