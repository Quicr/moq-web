/**
 * MoQ C4M Auth Debug Room
 *
 * Demonstrates C4M authorization flows:
 * - Panel A: Google IDP sign-in → moat session → ES256-signed C4M token → relay accepts
 * - Panel B: Invalid tokens (expired, bad-sig, wrong-scope, guest) → relay denies
 */

// ============================================================================
// Types
// ============================================================================

interface PanelState {
  id: 'a' | 'b';
  token: string | null;
  tokenDecoded: DecodedToken | null;
  transport: WebTransport | null;
  stream: MediaStream | null;
  timeline: TimelineEvent[];
  status: 'disconnected' | 'connecting' | 'connected' | 'denied' | 'error';
}

interface DecodedToken {
  raw: string;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: string;
  isExpired: boolean;
  expiresAt: Date | null;
  issuedAt: Date | null;
  scopes: string[];
}

interface TimelineEvent {
  time: Date;
  type: 'send' | 'recv' | 'error' | 'wait';
  label: string;
  detail?: string;
}

interface GoogleUser {
  name: string;
  email: string;
  picture: string;
  idToken: string;
}

// ============================================================================
// State
// ============================================================================

const panels: Record<string, PanelState> = {
  a: { id: 'a', token: null, tokenDecoded: null, transport: null, stream: null, timeline: [], status: 'disconnected' },
  b: { id: 'b', token: null, tokenDecoded: null, transport: null, stream: null, timeline: [], status: 'disconnected' },
};

let googleUser: GoogleUser | null = null;
let moatSessionToken: string | null = null;

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

// ============================================================================
// Google Sign-In
// ============================================================================

// Expose globally for Google's callback
(window as any).handleGoogleCredential = function (response: any) {
  const idToken = response.credential;
  const payload = JSON.parse(atob(idToken.split('.')[1]));

  googleUser = {
    name: payload.name || payload.email,
    email: payload.email,
    picture: payload.picture || '',
    idToken,
  };

  // Exchange Google ID token for moat session
  exchangeGoogleForMoatSession(idToken);
};

async function exchangeGoogleForMoatSession(idToken: string) {
  const baseUrl = getTokenServiceUrl();
  const panel = panels.a;

  addTimelineEvent(panel, { time: new Date(), type: 'send', label: 'Google → moat', detail: `POST ${baseUrl}/auth/google` });

  try {
    const res = await fetch(`${baseUrl}/auth/google`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`moat Google login failed: ${res.status} ${text}`);
    }

    const data = await res.json();
    moatSessionToken = data.session_token;

    addTimelineEvent(panel, {
      time: new Date(),
      type: 'recv',
      label: 'moat session OK',
      detail: `user_id=${data.user_id}, provider=google`,
    });

    // Update UI
    $('google-signin-container').style.display = 'none';
    $('google-user-info').style.display = 'block';
    $('google-user-name').textContent = `${googleUser!.name} (${googleUser!.email})`;
  } catch (err: any) {
    addTimelineEvent(panel, { time: new Date(), type: 'error', label: 'Google login failed', detail: err.message });
    moatSessionToken = null;
  }
}

function googleLogout() {
  googleUser = null;
  moatSessionToken = null;
  $('google-signin-container').style.display = 'block';
  $('google-user-info').style.display = 'none';
  panels.a.timeline = [];
  renderTimeline(panels.a);
}

// ============================================================================
// Token Operations
// ============================================================================

function decodeJwtLike(token: string): DecodedToken | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const header = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')));
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    const signature = parts[2];

    const exp = payload.exp ? new Date(payload.exp * 1000) : null;
    const iat = payload.iat ? new Date(payload.iat * 1000) : null;
    const isExpired = exp ? exp < new Date() : false;

    const scopes: string[] = [];
    if (payload.moqt && Array.isArray(payload.moqt)) {
      for (const scope of payload.moqt) {
        if (scope.actions) {
          scopes.push(...scope.actions.map((a: string) => a));
        }
      }
    }
    if (payload.scopes) {
      scopes.push(...payload.scopes);
    }

    return { raw: token, header, payload, signature, isExpired, expiresAt: exp, issuedAt: iat, scopes };
  } catch {
    return null;
  }
}

function generateMockExpiredToken(): string {
  const header = { alg: 'HS256', typ: 'CAT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'moat-demo',
    aud: ['moq-relay'],
    sub: 'demo-user-expired',
    iat: now - 7200,
    exp: now - 3600,
    moqt: [{ actions: ['publish', 'subscribe'], namespace: `mocha/${getRoomId()}` }],
  };
  return encodeFakeJwt(header, payload);
}

function generateBadSignatureToken(): string {
  const header = { alg: 'ES256', typ: 'CAT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'https://api.mocha-net.dev',
    aud: ['moq-relay'],
    sub: 'demo-user-badsig',
    iat: now,
    exp: now + 3600,
    moqt: [{ actions: ['publish', 'subscribe'], namespace: `mocha/${getRoomId()}` }],
  };
  const h = btoa(JSON.stringify(header)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const p = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const sig = 'INVALID_SIGNATURE_AAABBBCCC111222333_NOT_ES256';
  return `${h}.${p}.${sig}`;
}

function generateWrongScopeToken(): string {
  const header = { alg: 'HS256', typ: 'CAT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'moat-demo',
    aud: ['moq-relay'],
    sub: 'demo-user-wrongscope',
    iat: now,
    exp: now + 3600,
    moqt: [{ actions: ['subscribe'], namespace: `mocha/wrong-room-xyz` }],
  };
  return encodeFakeJwt(header, payload);
}

function generateGuestToken(): string {
  const header = { alg: 'HS256', typ: 'CAT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'moat-anonymous',
    aud: ['moq-relay'],
    sub: `guest-${Date.now().toString(36)}`,
    iat: now,
    exp: now + 300,
    moqt: [{ actions: ['subscribe'], namespace: `mocha/${getRoomId()}` }],
  };
  return encodeFakeJwt(header, payload);
}

function encodeFakeJwt(header: object, payload: object): string {
  const h = btoa(JSON.stringify(header)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const p = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const fakeBytes = new Uint8Array(32);
  crypto.getRandomValues(fakeBytes);
  const sig = btoa(String.fromCharCode(...fakeBytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${h}.${p}.${sig}`;
}

async function ensureRoomExists(roomId: string): Promise<void> {
  const baseUrl = getTokenServiceUrl();
  const res = await fetch(`${baseUrl}/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: roomId,
      namespace_prefix: `mocha/${roomId}`,
      visibility: 'public',
    }),
  });
  // 409 = already exists, which is fine
  if (!res.ok && res.status !== 409) {
    const text = await res.text();
    throw new Error(`Room creation failed: ${res.status} ${text}`);
  }
}

async function mintMoatToken(role: 'publisher' | 'subscriber' | 'pubsub'): Promise<string> {
  if (!moatSessionToken) {
    throw new Error('Sign in with Google first to get a moat session');
  }

  const baseUrl = getTokenServiceUrl();
  const roomId = getRoomId();

  await ensureRoomExists(roomId);

  const res = await fetch(`${baseUrl}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${moatSessionToken}`,
    },
    body: JSON.stringify({ room_id: roomId, role: role === 'pubsub' ? undefined : role }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token mint failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.token;
}

// ============================================================================
// Timeline / UI Updates
// ============================================================================

function addTimelineEvent(panel: PanelState, event: TimelineEvent) {
  panel.timeline.push(event);
  renderTimeline(panel);
}

function renderTimeline(panel: PanelState) {
  const el = $(`timeline-${panel.id}`);
  el.innerHTML = panel.timeline.map(ev => {
    const timeStr = ev.time.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 } as Intl.DateTimeFormatOptions);
    return `
      <div class="timeline-event">
        <div class="timeline-dot ${ev.type}">
          <span class="material-icons-outlined" style="font-size:10px">
            ${ev.type === 'send' ? 'arrow_upward' : ev.type === 'recv' ? 'arrow_downward' : ev.type === 'error' ? 'close' : 'hourglass_empty'}
          </span>
        </div>
        <div class="timeline-content">
          <div class="timeline-label">${ev.label}</div>
          ${ev.detail ? `<div class="timeline-detail">${escapeHtml(ev.detail)}</div>` : ''}
        </div>
        <div class="timeline-time">${timeStr}</div>
      </div>
    `;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function renderTokenInspector(panel: PanelState) {
  const el = $(`token-inspector-${panel.id}`);

  if (!panel.token) {
    el.innerHTML = '<div style="color: var(--text-dim)">No token yet</div>';
    return;
  }

  const decoded = panel.tokenDecoded;
  if (!decoded) {
    el.innerHTML = `
      <div class="token-part">
        <div class="token-label">Raw Token (not decodable)</div>
        <div class="token-raw">${escapeHtml(panel.token)}</div>
      </div>
    `;
    return;
  }

  const expClass = decoded.isExpired ? 'expired' : '';
  const expLabel = decoded.isExpired ? ' (EXPIRED)' : '';

  el.innerHTML = `
    <div class="token-part">
      <div class="token-label">Header</div>
      <div class="token-value">${syntaxHighlight(decoded.header)}</div>
    </div>
    <div class="token-part">
      <div class="token-label">Payload</div>
      <div class="token-value">${syntaxHighlight(decoded.payload)}</div>
    </div>
    <div class="token-part">
      <div class="token-label">Expiry</div>
      <div class="token-value ${expClass}">
        ${decoded.expiresAt ? decoded.expiresAt.toISOString() + expLabel : 'none'}
      </div>
    </div>
    <div class="token-part">
      <div class="token-label">Scopes</div>
      <div>
        ${decoded.scopes.length > 0
          ? decoded.scopes.map(s => `<span class="scope-chip ${s.includes('pub') ? 'publish' : 'subscribe'}">${s}</span>`).join('')
          : '<span style="color:var(--text-dim)">none</span>'
        }
      </div>
    </div>
    <div class="token-part">
      <div class="token-label">Signature Algorithm</div>
      <div class="token-value">${decoded.header.alg || 'unknown'} ${decoded.header.alg === 'ES256' ? '<span style="color:var(--green)">(asymmetric - valid)</span>' : '<span style="color:var(--yellow)">(symmetric/fake)</span>'}</div>
    </div>
    <div class="token-part">
      <div class="token-label">Raw</div>
      <div class="token-raw">${escapeHtml(decoded.raw)}</div>
    </div>
  `;
}

function updateStatus(panel: PanelState) {
  const el = $(`status-${panel.id}`);
  const labels: Record<string, [string, string]> = {
    disconnected: ['DISCONNECTED', 'badge-yellow'],
    connecting: ['CONNECTING...', 'badge-yellow'],
    connected: ['CONNECTED', 'badge-green'],
    denied: ['DENIED', 'badge-red'],
    error: ['ERROR', 'badge-red'],
  };
  const [text, cls] = labels[panel.status] || ['UNKNOWN', 'badge-yellow'];
  el.textContent = text;
  el.className = `badge ${cls}`;

  const disconnBtn = $(`btn-disconnect-${panel.id}`) as HTMLButtonElement;
  disconnBtn.disabled = panel.status !== 'connected' && panel.status !== 'connecting';
}

// ============================================================================
// WebTransport Connection
// ============================================================================

async function connectToRelay(panel: PanelState) {
  if (panel.token === null) {
    addTimelineEvent(panel, { time: new Date(), type: 'error', label: 'No token available', detail: 'Get a token first' });
    return;
  }

  panel.status = 'connecting';
  updateStatus(panel);

  const relayUrl = getRelayUrl();

  addTimelineEvent(panel, { time: new Date(), type: 'send', label: 'WebTransport CONNECT', detail: relayUrl });

  try {
    const url = panel.token
      ? `${relayUrl}?token=${encodeURIComponent(panel.token)}`
      : relayUrl;

    addTimelineEvent(panel, { time: new Date(), type: 'wait', label: 'QUIC Handshake + TLS', detail: 'Establishing WebTransport session...' });

    const transport = new WebTransport(url);
    panel.transport = transport;

    await transport.ready;

    addTimelineEvent(panel, { time: new Date(), type: 'recv', label: 'WebTransport Ready', detail: 'QUIC connection established' });

    addTimelineEvent(panel, { time: new Date(), type: 'send', label: 'CLIENT_SETUP', detail: `token_type=0x63346d (c4m), token=${panel.token ? panel.token.slice(0, 20) + '...' : 'none'}` });

    panel.status = 'connected';
    updateStatus(panel);
    addTimelineEvent(panel, { time: new Date(), type: 'recv', label: 'SERVER_SETUP', detail: 'Session established - authorized' });

    await startCamera(panel);

    transport.closed.then((info) => {
      addTimelineEvent(panel, { time: new Date(), type: 'error', label: 'Transport closed', detail: `reason: ${(info as any)?.reason || 'unknown'}, code: ${(info as any)?.closeCode || 'n/a'}` });
      panel.status = 'disconnected';
      updateStatus(panel);
      stopCamera(panel);
    }).catch((err) => {
      addTimelineEvent(panel, { time: new Date(), type: 'error', label: 'Transport closed (error)', detail: err.message });
      panel.status = 'error';
      updateStatus(panel);
      stopCamera(panel);
    });

  } catch (err: any) {
    const msg = err.message || String(err);

    if (msg.includes('403') || msg.includes('401') || msg.includes('denied') || msg.includes('unauthorized')) {
      panel.status = 'denied';
      addTimelineEvent(panel, { time: new Date(), type: 'error', label: 'Authorization DENIED', detail: msg });
    } else if (msg.includes('close') || msg.includes('rejected')) {
      panel.status = 'denied';
      addTimelineEvent(panel, { time: new Date(), type: 'error', label: 'Connection Rejected', detail: `Relay refused connection: ${msg}` });
    } else {
      panel.status = 'error';
      addTimelineEvent(panel, { time: new Date(), type: 'error', label: 'Connection Failed', detail: msg });
    }

    updateStatus(panel);
  }
}

function disconnect(panel: PanelState) {
  if (panel.transport) {
    try {
      panel.transport.close();
    } catch { /* ignore */ }
    panel.transport = null;
  }
  stopCamera(panel);
  panel.status = 'disconnected';
  updateStatus(panel);
  addTimelineEvent(panel, { time: new Date(), type: 'send', label: 'Disconnected', detail: 'User initiated disconnect' });
}

// ============================================================================
// Camera
// ============================================================================

async function startCamera(panel: PanelState) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: true,
    });
    panel.stream = stream;

    const video = $(`video-${panel.id}`) as HTMLVideoElement;
    video.srcObject = stream;

    const overlay = $(`video-overlay-${panel.id}`);
    overlay.classList.add('hidden');

    const statusEl = $(`video-status-${panel.id}`);
    statusEl.innerHTML = '<span class="badge badge-green" style="font-size:9px">LIVE</span>';

    addTimelineEvent(panel, { time: new Date(), type: 'recv', label: 'Camera started', detail: `${stream.getVideoTracks()[0]?.getSettings().width}x${stream.getVideoTracks()[0]?.getSettings().height}` });
  } catch (err: any) {
    addTimelineEvent(panel, { time: new Date(), type: 'error', label: 'Camera failed', detail: err.message });
  }
}

function stopCamera(panel: PanelState) {
  if (panel.stream) {
    panel.stream.getTracks().forEach(t => t.stop());
    panel.stream = null;
  }
  const video = $(`video-${panel.id}`) as HTMLVideoElement;
  video.srcObject = null;
  const overlay = $(`video-overlay-${panel.id}`);
  overlay.classList.remove('hidden');
  const statusEl = $(`video-status-${panel.id}`);
  statusEl.innerHTML = '';
}

// ============================================================================
// Utilities
// ============================================================================

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function syntaxHighlight(obj: unknown): string {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/(".*?")(\s*:\s*)/g, '<span class="key">$1</span>$2')
    .replace(/:\s*(".*?")/g, ': <span class="string">$1</span>')
    .replace(/:\s*(\d+)/g, ': <span class="number">$1</span>')
    .replace(/:\s*(true|false|null)/g, ': <span class="number">$1</span>');
}

// ============================================================================
// Event Wiring
// ============================================================================

function setupPanelA() {
  const panel = panels.a;

  const modeSelect = $('token-mode-a') as HTMLSelectElement;
  const customInput = $('custom-token-a') as HTMLInputElement;

  modeSelect.addEventListener('change', () => {
    customInput.style.display = modeSelect.value === 'custom' ? 'block' : 'none';
  });

  // Google logout
  $('btn-google-logout').addEventListener('click', googleLogout);

  // Mint token (requires Google sign-in first)
  $('btn-get-token-a').addEventListener('click', async () => {
    const mode = modeSelect.value;

    if (mode !== 'custom' && !moatSessionToken) {
      addTimelineEvent(panel, { time: new Date(), type: 'error', label: 'Not signed in', detail: 'Sign in with Google to mint an ES256 C4M token from moat' });
      return;
    }

    addTimelineEvent(panel, { time: new Date(), type: 'send', label: 'Token Mint Request', detail: `POST /token, mode=${mode}` });

    try {
      let token: string;

      switch (mode) {
        case 'real-pubsub':
          token = await mintMoatToken('pubsub');
          break;
        case 'real-sub':
          token = await mintMoatToken('subscriber');
          break;
        case 'real-pub':
          token = await mintMoatToken('publisher');
          break;
        case 'custom':
          token = customInput.value.trim();
          break;
        default:
          token = '';
      }

      panel.token = token;
      panel.tokenDecoded = token ? decodeJwtLike(token) : null;

      addTimelineEvent(panel, {
        time: new Date(),
        type: 'recv',
        label: 'Token Minted (ES256)',
        detail: panel.tokenDecoded
          ? `iss=${panel.tokenDecoded.payload.iss}, sub=${panel.tokenDecoded.payload.sub}, alg=${panel.tokenDecoded.header.alg}`
          : token ? 'Not decodable' : 'Empty',
      });

      renderTokenInspector(panel);
    } catch (err: any) {
      addTimelineEvent(panel, { time: new Date(), type: 'error', label: 'Token Mint Error', detail: err.message });
    }
  });

  $('btn-connect-a').addEventListener('click', () => connectToRelay(panel));
  $('btn-disconnect-a').addEventListener('click', () => disconnect(panel));
}

function setupPanelB() {
  const panel = panels.b;

  const modeSelect = $('token-mode-b') as HTMLSelectElement;
  const customInput = $('custom-token-b') as HTMLInputElement;

  modeSelect.addEventListener('change', () => {
    customInput.style.display = modeSelect.value === 'custom' ? 'block' : 'none';
  });

  $('btn-get-token-b').addEventListener('click', async () => {
    const mode = modeSelect.value;
    panel.timeline = [];
    renderTimeline(panel);

    addTimelineEvent(panel, { time: new Date(), type: 'send', label: 'Token Request', detail: `mode=${mode} (will be rejected by relay)` });

    try {
      let token: string;

      switch (mode) {
        case 'expired':
          token = generateMockExpiredToken();
          break;
        case 'bad-sig':
          token = generateBadSignatureToken();
          break;
        case 'wrong-scope':
          token = generateWrongScopeToken();
          break;
        case 'guest':
          token = generateGuestToken();
          break;
        case 'garbage':
          token = 'this.is.not-a-valid-token-at-all-garbage-data';
          break;
        case 'no-token':
          token = '';
          break;
        case 'custom':
          token = customInput.value.trim();
          break;
        default:
          token = '';
      }

      panel.token = token;
      panel.tokenDecoded = token ? decodeJwtLike(token) : null;

      const reason = {
        'expired': 'Token exp claim is in the past',
        'bad-sig': 'Signature does not verify with any known key',
        'wrong-scope': 'Namespace scope does not match requested resource',
        'guest': 'Guest/anonymous tokens are not accepted (no valid IDP session)',
        'garbage': 'Not a valid JWT structure',
        'no-token': 'No authorization token provided',
      }[mode] || 'Unknown';

      addTimelineEvent(panel, {
        time: new Date(),
        type: panel.tokenDecoded?.isExpired ? 'error' : 'recv',
        label: 'Token Generated (Invalid)',
        detail: `Reason relay will reject: ${reason}`,
      });

      renderTokenInspector(panel);
    } catch (err: any) {
      addTimelineEvent(panel, { time: new Date(), type: 'error', label: 'Token Error', detail: err.message });
    }
  });

  $('btn-connect-b').addEventListener('click', () => connectToRelay(panel));
  $('btn-disconnect-b').addEventListener('click', () => disconnect(panel));
}

// ============================================================================
// Init
// ============================================================================

setupPanelA();
setupPanelB();
