// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { useState } from 'react';
import type { SettingsPanelProps } from '../types.js';
import { parseCloudflareJwt, type CloudflareState } from './cloudflare.js';

/**
 * Cloudflare settings: the relay connection JWT and whether the relay
 * requires a CAT. Login, rooms and CAT minting are app UX, not settings.
 */
export function CloudflareAuthPanel({ state, updateState, resetState }: SettingsPanelProps) {
  const s = state as CloudflareState;
  const [jwtDraft, setJwtDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  let saved: ReturnType<typeof parseCloudflareJwt> | null = null;
  try {
    saved = s.relayJwt ? parseCloudflareJwt(s.relayJwt) : null;
  } catch {
    saved = null;
  }

  const save = () => {
    setError(null);
    const raw = jwtDraft.trim();
    try {
      const info = parseCloudflareJwt(raw);
      if (info.expiresAt <= Date.now()) {
        setError(`Token expired ${new Date(info.expiresAt).toLocaleString()}`);
        return;
      }
    } catch (err) {
      setError(`Failed to parse JWT: ${(err as Error).message}`);
      return;
    }
    updateState({ relayJwt: raw, tokens: undefined });
    setJwtDraft('');
  };

  return (
    <div className="ak-stack" style={{ gap: 12 }}>
      {error ? (
        <div className="ak-caption" style={{ color: 'var(--ak-danger)', fontSize: 12 }}>
          {error}
        </div>
      ) : null}

      <label>
        <div className="ak-caption" style={{ marginBottom: 4 }}>
          Relay connection token (JWT from Cloudflare)
        </div>
        <textarea
          className="ak-input ak-input-mono"
          placeholder="eyJhbGciOi…"
          value={jwtDraft}
          onChange={(e) => setJwtDraft(e.target.value)}
          rows={3}
          style={{ fontSize: 10, width: '100%', fontFamily: 'monospace' }}
        />
        <div className="ak-caption" style={{ fontSize: 10, marginTop: 4 }}>
          Sent as the first URL path segment. Set the relay URL (e.g.{' '}
          <code>https://draft-18.cloudflare.mediaoverquic.com</code>) in the Relay tab.
        </div>
      </label>

      <div className="ak-row" style={{ gap: 6, justifyContent: 'flex-end' }}>
        <button className="ak-btn ak-btn-ghost" onClick={resetState}>
          Reset
        </button>
        <button className="ak-btn ak-btn-primary" onClick={save} disabled={!jwtDraft.trim()}>
          Save token
        </button>
      </div>

      {saved ? (
        <div
          style={{
            padding: '6px 8px',
            border: '1px solid var(--ak-border)',
            borderRadius: 6,
            fontSize: 11,
          }}
        >
          <div>
            <b>{saved.operations.join(' + ')}</b> · relay <code>{saved.sub ?? '?'}</code>
          </div>
          <div className="ak-subtle" style={{ fontSize: 10 }}>
            expires {formatExpiry(saved.expiresAt)}
          </div>
        </div>
      ) : (
        <div className="ak-caption" style={{ fontSize: 11 }}>
          No relay token saved.
        </div>
      )}

      <div
        className="ak-row-between"
        style={{ borderTop: '1px solid var(--ak-border)', paddingTop: 12 }}
      >
        <div>
          <div className="ak-heading" style={{ fontSize: 13 }}>Require C4M (CAT)</div>
          <div className="ak-subtle" style={{ fontSize: 11 }}>
            Relay has CAT authorization enabled — sign-in and rooms are required to connect
          </div>
        </div>
        <label className="ak-toggle">
          <input
            type="checkbox"
            checked={!!s.catEnabled}
            onChange={(e) => updateState({ catEnabled: e.target.checked })}
          />
          <span />
        </label>
      </div>
    </div>
  );
}

function formatExpiry(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return 'unknown';
  const delta = epochMs - Date.now();
  if (delta < 0) return `expired ${new Date(epochMs).toLocaleString()}`;
  const hours = Math.round(delta / 3_600_000);
  if (hours < 48) return `in ${hours}h (${new Date(epochMs).toLocaleString()})`;
  return `in ${Math.round(hours / 24)}d (${new Date(epochMs).toLocaleString()})`;
}
