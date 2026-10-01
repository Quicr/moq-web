// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { useEffect, useMemo, useState } from 'react';
import type { SettingsPanelProps } from '../types.js';
import {
  createCloudflareToken,
  listCloudflareRelays,
  relayUrlFromRelay,
  runtimeCache,
  type CloudflareRelay,
  type CloudflareState,
} from './cloudflare.js';

type Step = 'credentials' | 'relay' | 'tokens';

export function CloudflareAuthPanel({ state, updateState, resetState }: SettingsPanelProps) {
  const s = state as CloudflareState;
  const [apiTokenDraft, setApiTokenDraft] = useState(s.apiToken ?? '');
  const [accountIdDraft, setAccountIdDraft] = useState(s.accountId ?? '');
  const [relays, setRelays] = useState<CloudflareRelay[] | null>(null);
  const [loading, setLoading] = useState<null | 'relays' | 'publish' | 'subscribe'>(null);
  const [error, setError] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
