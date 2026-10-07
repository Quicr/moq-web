// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { useEffect, useMemo, useState } from 'react';
import type { SettingsPanelProps } from '../types.js';
import {
  createCloudflareToken,
  listCloudflareRelays,
  parseCloudflareJwt,
  relayUrlFromRelay,
  runtimeCache,
  type CloudflareCachedToken,
  type CloudflareRelay,
  type CloudflareState,
} from './cloudflare.js';

type Step = 'credentials' | 'relay' | 'tokens';
type AuthMode = 'api' | 'preminted';

export function CloudflareAuthPanel({ state, updateState, resetState }: SettingsPanelProps) {
  const s = state as CloudflareState;
  const mode: AuthMode = s.authMode === 'preminted' ? 'preminted' : 'api';
  const [apiTokenDraft, setApiTokenDraft] = useState(s.apiToken ?? '');
  const [accountIdDraft, setAccountIdDraft] = useState(s.accountId ?? '');
  const [relays, setRelays] = useState<CloudflareRelay[] | null>(null);
  const [loading, setLoading] = useState<null | 'relays' | 'publish' | 'subscribe'>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);

  // Preminted-mode drafts. Seeded from persisted state so re-opening the panel
  // shows the previously saved values.
  const [preRelayUrlDraft, setPreRelayUrlDraft] = useState(s.relayUrl ?? '');
  const [preRelayIdDraft, setPreRelayIdDraft] = useState(s.relayId ?? '');
  const [prePublishJwtDraft, setPrePublishJwtDraft] = useState('');
  const [preSubscribeJwtDraft, setPreSubscribeJwtDraft] = useState('');

  const step: Step = useMemo(() => {
    if (!s.apiToken || !s.accountId) return 'credentials';
    if (!s.relayId) return 'relay';
    return 'tokens';
  }, [s.apiToken, s.accountId, s.relayId]);

  // Reconcile any tokens minted on-demand by connectMoqtSession into
  // persisted state so a page reload doesn't re-mint.
  useEffect(() => {
    if (runtimeCache.length === 0) return;
    const existing = s.tokens ?? [];
    const merged = [...existing];
    let changed = false;
    for (const t of runtimeCache) {
      if (!merged.find((m) => m.jti === t.jti)) {
        merged.push(t);
        changed = true;
      }
    }
    if (changed) updateState({ tokens: merged });

  }, []);

  const saveCredentials = () => {
    setError(null);
    updateState({
      apiToken: apiTokenDraft.trim(),
      accountId: accountIdDraft.trim(),
    });
  };

  const loadRelays = async () => {
    if (!s.apiToken || !s.accountId) return;
    setLoading('relays');
    setError(null);
    try {
      const list = await listCloudflareRelays(s.accountId, s.apiToken);
      setRelays(list);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(null);
    }
  };

  const pickRelay = (relay: CloudflareRelay) => {
    const url = relayUrlFromRelay(relay);
    updateState({ relayId: relay.uid, relayUrl: url ?? undefined });
  };

  const mint = async (op: 'publish' | 'subscribe') => {
    if (!s.apiToken || !s.accountId || !s.relayId) return;
    setLoading(op);
    setError(null);
    try {
      const fresh = await createCloudflareToken(
        s.accountId,
        s.relayId,
        [op],
        s.apiToken,
        undefined,
        `moq-web ${op} ${new Date().toISOString().slice(0, 19)}`,
      );
      const next = [...(s.tokens ?? []).filter((t) => t.jti !== fresh.jti), fresh];
      updateState({ tokens: next });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(null);
    }
  };

  const removeToken = (jti: string) => {
    const next = (s.tokens ?? []).filter((t) => t.jti !== jti);
    updateState({ tokens: next });
  };

  const setMode = (next: AuthMode) => {
    if (next === mode) return;
    // Switching modes clears the error banner but preserves cached tokens so a
    // user who went 'api' → mint → switch to 'preminted' doesn't lose them.
    setError(null);
    updateState({ authMode: next });
  };

  // Attempt to extract the sub claim from a pasted JWT and auto-populate the
  // Relay ID field. Called from either JWT textarea onChange — the sub claim
  // is the Cloudflare relay UUID, so re-typing it in the dedicated field is
  // pure friction. Only fills when the Relay ID field is currently empty, so
  // user edits aren't clobbered.
  const maybeAutofillRelayId = (jwtDraft: string) => {
    if (preRelayIdDraft.trim()) return;
    const trimmed = jwtDraft.trim();
    if (!trimmed) return;
    try {
      const info = parseCloudflareJwt(trimmed);
      if (info.sub) setPreRelayIdDraft(info.sub);
    } catch {
      /* ignore — user may still be mid-paste */
    }
  };

  const setPublishJwtWithAutofill = (v: string) => {
    setPrePublishJwtDraft(v);
    maybeAutofillRelayId(v);
  };
  const setSubscribeJwtWithAutofill = (v: string) => {
    setPreSubscribeJwtDraft(v);
    maybeAutofillRelayId(v);
  };

  const savePreminted = () => {
    setError(null);
    setStatus(null);
    const relayUrl = preRelayUrlDraft.trim();
    const relayId = preRelayIdDraft.trim();
    if (!relayUrl || !relayId) {
      setError('Relay URL and relay ID are both required.');
      return;
    }
    const parsed: CloudflareCachedToken[] = [];
    try {
      for (const raw of [prePublishJwtDraft.trim(), preSubscribeJwtDraft.trim()]) {
        if (!raw) continue;
        const info = parseCloudflareJwt(raw);
        parsed.push({ ...info, jwt: raw });
      }
    } catch (err) {
      setError(`Failed to parse JWT: ${(err as Error).message}`);
      return;
    }
    if (parsed.length === 0) {
      setError('Paste at least one JWT (publish and/or subscribe).');
      return;
    }
    const existing = (s.tokens ?? []).filter(
      (t) => !parsed.some((p) => p.jti === t.jti),
    );
    const nextTokens = [...existing, ...parsed];
    updateState({
      authMode: 'preminted',
      relayUrl,
      relayId,
      tokens: nextTokens,
    });
    setPrePublishJwtDraft('');
    setPreSubscribeJwtDraft('');
    setStatus(`Saved ${parsed.length} token(s). Cache has ${nextTokens.length}.`);
  };

  return (
    <div className="ak-stack" style={{ gap: 12 }}>
      {error ? (
        <div
          className="ak-caption"
          style={{ color: 'var(--ak-danger)', fontSize: 12 }}
        >
          {error}
        </div>
      ) : null}
      {status ? (
        <div
          className="ak-caption"
          style={{ color: 'var(--ak-accent)', fontSize: 12 }}
        >
          {status}
        </div>
      ) : null}

      <ModeToggle mode={mode} onChange={setMode} />

      {mode === 'preminted' ? (
        <PremintedForm
          relayUrl={preRelayUrlDraft}
          relayId={preRelayIdDraft}
          publishJwt={prePublishJwtDraft}
          subscribeJwt={preSubscribeJwtDraft}
          cachedTokens={s.tokens ?? []}
          setRelayUrl={setPreRelayUrlDraft}
          setRelayId={setPreRelayIdDraft}
          setPublishJwt={setPublishJwtWithAutofill}
          setSubscribeJwt={setSubscribeJwtWithAutofill}
          onSave={savePreminted}
          onRemoveToken={removeToken}
          onReset={resetState}
        />
      ) : (
        <ApiModeBody />
      )}
    </div>
  );

  function ApiModeBody() {
  return (
    <>
      <StepIndicator step={step} />

      {step === 'credentials' && (
        <div className="ak-stack" style={{ gap: 8 }}>
          <label>
            <div className="ak-caption" style={{ marginBottom: 4 }}>
              Cloudflare API token
            </div>
            <div className="ak-row" style={{ gap: 6 }}>
              <input
                className="ak-input ak-input-mono"
                type={showToken ? 'text' : 'password'}
                placeholder="cf-api-token"
                value={apiTokenDraft}
                onChange={(e) => setApiTokenDraft(e.target.value)}
                style={{ flex: 1, fontSize: 12 }}
              />
              <button
                className="ak-btn ak-btn-ghost"
                onClick={() => setShowToken((v) => !v)}
                type="button"
                title={showToken ? 'Hide' : 'Show'}
                style={{ padding: '4px 8px' }}
              >
                {showToken ? '👁' : '👁‍🗨'}
              </button>
            </div>
            <div className="ak-caption" style={{ fontSize: 10, marginTop: 4 }}>
              Needs <code>MoQ:Edit</code> permission. Create at
              dash.cloudflare.com ▸ My Profile ▸ API Tokens.
            </div>
          </label>
          <label>
            <div className="ak-caption" style={{ marginBottom: 4 }}>
              Cloudflare account ID
            </div>
            <input
              className="ak-input ak-input-mono"
              placeholder="32-hex-char-account-id"
              value={accountIdDraft}
              onChange={(e) => setAccountIdDraft(e.target.value)}
              style={{ fontSize: 12, width: '100%' }}
            />
          </label>
          <div className="ak-row" style={{ justifyContent: 'flex-end' }}>
            <button
              className="ak-btn ak-btn-primary"
              onClick={saveCredentials}
              disabled={!apiTokenDraft.trim() || !accountIdDraft.trim()}
            >
              Save & continue
            </button>
          </div>
        </div>
      )}

      {step === 'relay' && (
        <div className="ak-stack" style={{ gap: 8 }}>
          <div className="ak-caption" style={{ fontSize: 12 }}>
            Pick a relay to connect and mint tokens against.
          </div>
          <div className="ak-row" style={{ gap: 6 }}>
            <button
              className="ak-btn"
              onClick={() => void loadRelays()}
              disabled={loading === 'relays'}
            >
              {loading === 'relays' ? 'Loading…' : relays ? 'Refresh relays' : 'Load relays'}
            </button>
            <button className="ak-btn ak-btn-ghost" onClick={resetState}>
              Change credentials
            </button>
          </div>
          {relays && relays.length === 0 ? (
            <div className="ak-caption" style={{ fontSize: 12 }}>
              No relays found. Create one at{' '}
              <a
                href="https://developers.cloudflare.com/api/resources/moq/subresources/relays/methods/create/"
                target="_blank"
                rel="noreferrer"
              >
                Cloudflare API
              </a>
              .
            </div>
          ) : null}
          {relays?.map((r) => (
            <button
              key={r.uid}
              className="ak-btn"
              onClick={() => pickRelay(r)}
              style={{ textAlign: 'left', padding: 10 }}
            >
              <div style={{ fontWeight: 600, fontSize: 12 }}>{r.name}</div>
              <div className="ak-subtle" style={{ fontSize: 10 }}>
                {relayUrlFromRelay(r) ?? '(no upstream URL)'}
              </div>
              <div className="ak-caption" style={{ fontSize: 10 }}>
                uid: <code>{r.uid}</code>
              </div>
            </button>
          ))}
        </div>
      )}

      {step === 'tokens' && (
        <div className="ak-stack" style={{ gap: 8 }}>
          <div className="ak-caption" style={{ fontSize: 12 }}>
            Relay <code>{s.relayId}</code> selected. Mint the tokens this app
            will need — publish for broadcast, subscribe for viewer-only.
          </div>
          {s.relayUrl ? (
            <div className="ak-caption" style={{ fontSize: 11 }}>
              WebTransport endpoint: <code>{s.relayUrl}</code>
            </div>
          ) : null}
          <div className="ak-row" style={{ gap: 6 }}>
            <button
              className="ak-btn ak-btn-primary"
              onClick={() => void mint('publish')}
              disabled={loading !== null}
            >
              {loading === 'publish' ? 'Minting…' : 'Mint publish token'}
            </button>
            <button
              className="ak-btn"
              onClick={() => void mint('subscribe')}
              disabled={loading !== null}
            >
              {loading === 'subscribe' ? 'Minting…' : 'Mint subscribe token'}
            </button>
            <button className="ak-btn ak-btn-ghost" onClick={resetState}>
              Reset
            </button>
          </div>
          {(s.tokens ?? []).length === 0 ? (
            <div className="ak-caption" style={{ fontSize: 11 }}>
              No cached tokens yet. Tokens are also minted on demand at
              connect time.
            </div>
          ) : (
            <div className="ak-stack" style={{ gap: 4 }}>
              {(s.tokens ?? []).map((t) => (
                <div
                  key={t.jti}
                  className="ak-row"
                  style={{
                    gap: 6,
                    padding: '6px 8px',
                    border: '1px solid var(--ak-border)',
                    borderRadius: 6,
                    fontSize: 11,
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div>
                      <b>{t.operations.join(' + ')}</b> · jti{' '}
                      <code>{t.jti.slice(0, 12)}…</code>
                    </div>
                    <div className="ak-subtle" style={{ fontSize: 10 }}>
                      expires {formatExpiry(t.expiresAt)}
                    </div>
                  </div>
                  <button
                    className="ak-btn ak-btn-ghost"
                    onClick={() => removeToken(t.jti)}
                    title="Remove from local cache (does not revoke on Cloudflare)"
                    style={{ padding: '2px 6px', color: 'var(--ak-danger)' }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
  }
}

interface ModeToggleProps {
  mode: AuthMode;
  onChange: (next: AuthMode) => void;
}

function ModeToggle({ mode, onChange }: ModeToggleProps) {
  const btn = (id: AuthMode, label: string) => (
    <button
      type="button"
      className="ak-btn"
      onClick={() => onChange(id)}
      style={{
        padding: '4px 10px',
        fontSize: 11,
        background:
          mode === id ? 'var(--ak-accent-soft)' : 'var(--ak-bg-elev-strong)',
        border:
          mode === id
            ? '1px solid var(--ak-accent)'
            : '1px solid var(--ak-border)',
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="ak-row" style={{ gap: 6 }}>
      {btn('api', 'Mint via API')}
      {btn('preminted', 'Pre-minted tokens')}
    </div>
  );
}

interface PremintedFormProps {
  relayUrl: string;
  relayId: string;
  publishJwt: string;
  subscribeJwt: string;
  cachedTokens: CloudflareCachedToken[];
  setRelayUrl: (v: string) => void;
  setRelayId: (v: string) => void;
  setPublishJwt: (v: string) => void;
  setSubscribeJwt: (v: string) => void;
  onSave: () => void;
  onRemoveToken: (jti: string) => void;
  onReset: () => void;
}

function PremintedForm(p: PremintedFormProps) {
  return (
    <div className="ak-stack" style={{ gap: 8 }}>
      <div className="ak-caption" style={{ fontSize: 12 }}>
        Paste JWTs you minted out-of-band (via the Cloudflare dashboard, CLI,
        or a direct API call). The adapter will serve them from cache and will
        not call the Cloudflare REST API.
      </div>

      <label>
        <div className="ak-caption" style={{ marginBottom: 4 }}>
          Relay WebTransport URL
        </div>
        <input
          className="ak-input ak-input-mono"
          placeholder="https://draft-18.cloudflare.mediaoverquic.com"
          value={p.relayUrl}
          onChange={(e) => p.setRelayUrl(e.target.value)}
          style={{ fontSize: 12, width: '100%' }}
        />
        <div className="ak-caption" style={{ fontSize: 10, marginTop: 4 }}>
          Written to <code>relayUrl</code>. You also need to add this URL to
          the relay list in the Transport tab.
        </div>
      </label>

      <label>
        <div className="ak-caption" style={{ marginBottom: 4 }}>
          Relay ID (JWT <code>sub</code> claim)
        </div>
        <input
          className="ak-input ak-input-mono"
          placeholder="dc5826e468a4f3df1cb4393d394b6092"
          value={p.relayId}
          onChange={(e) => p.setRelayId(e.target.value)}
          style={{ fontSize: 12, width: '100%' }}
        />
      </label>

      <label>
        <div className="ak-caption" style={{ marginBottom: 4 }}>
          Publish JWT (optional)
        </div>
        <textarea
          className="ak-input ak-input-mono"
          placeholder="eyJhbGciOi…"
          value={p.publishJwt}
          onChange={(e) => p.setPublishJwt(e.target.value)}
          rows={3}
          style={{ fontSize: 10, width: '100%', fontFamily: 'monospace' }}
        />
      </label>

      <label>
        <div className="ak-caption" style={{ marginBottom: 4 }}>
          Subscribe JWT (optional)
        </div>
        <textarea
          className="ak-input ak-input-mono"
          placeholder="eyJhbGciOi…"
          value={p.subscribeJwt}
          onChange={(e) => p.setSubscribeJwt(e.target.value)}
          rows={3}
          style={{ fontSize: 10, width: '100%', fontFamily: 'monospace' }}
        />
      </label>

      <div className="ak-row" style={{ gap: 6, justifyContent: 'flex-end' }}>
        <button className="ak-btn ak-btn-ghost" onClick={p.onReset}>
          Reset
        </button>
        <button
          className="ak-btn ak-btn-primary"
          onClick={p.onSave}
          disabled={
            !p.relayUrl.trim() ||
            !p.relayId.trim() ||
            (!p.publishJwt.trim() && !p.subscribeJwt.trim())
          }
        >
          Save tokens
        </button>
      </div>

      {p.cachedTokens.length === 0 ? (
        <div className="ak-caption" style={{ fontSize: 11 }}>
          No cached tokens yet.
        </div>
      ) : (
        <div className="ak-stack" style={{ gap: 4 }}>
          <div className="ak-caption" style={{ fontSize: 11 }}>
            Cached tokens
          </div>
          {p.cachedTokens.map((t) => (
            <div
              key={t.jti}
              className="ak-row"
              style={{
                gap: 6,
                padding: '6px 8px',
                border: '1px solid var(--ak-border)',
                borderRadius: 6,
                fontSize: 11,
              }}
            >
              <div style={{ flex: 1 }}>
                <div>
                  <b>{t.operations.join(' + ')}</b> · jti{' '}
                  <code>{t.jti.slice(0, 12)}…</code>
                </div>
                <div className="ak-subtle" style={{ fontSize: 10 }}>
                  expires {formatExpiry(t.expiresAt)}
                </div>
              </div>
              <button
                className="ak-btn ak-btn-ghost"
                onClick={() => p.onRemoveToken(t.jti)}
                title="Remove from local cache"
                style={{ padding: '2px 6px', color: 'var(--ak-danger)' }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StepIndicator({ step }: { step: Step }) {
  const steps: Array<{ id: Step; label: string }> = [
    { id: 'credentials', label: '1. Credentials' },
    { id: 'relay', label: '2. Pick relay' },
    { id: 'tokens', label: '3. Mint tokens' },
  ];
  return (
    <div className="ak-row" style={{ gap: 4, fontSize: 11 }}>
      {steps.map((s, i) => (
        <span
          key={s.id}
          className="ak-chip"
          style={{
            padding: '2px 8px',
            background:
              s.id === step ? 'var(--ak-accent-soft)' : 'var(--ak-bg-elev-strong)',
            border:
              s.id === step
                ? '1px solid var(--ak-accent)'
                : '1px solid var(--ak-border)',
            borderRadius: 999,
            color: 'var(--ak-fg)',
            opacity: stepIndex(s.id) <= stepIndex(step) ? 1 : 0.5,
          }}
        >
          {s.label}
          {i < steps.length - 1 ? ' ›' : ''}
        </span>
      ))}
    </div>
  );
}

function stepIndex(s: Step): number {
  return s === 'credentials' ? 0 : s === 'relay' ? 1 : 2;
}

function formatExpiry(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return 'unknown';
  const delta = epochMs - Date.now();
  if (delta < 0) return `expired ${new Date(epochMs).toLocaleString()}`;
  const hours = Math.round(delta / 3_600_000);
  if (hours < 48) return `in ${hours}h (${new Date(epochMs).toLocaleString()})`;
  const days = Math.round(hours / 24);
  return `in ${days}d (${new Date(epochMs).toLocaleDateString()})`;
}
