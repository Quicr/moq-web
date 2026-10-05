// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { useState, useRef } from 'react';

export type StatusState = 'idle' | 'connecting' | 'ready' | 'error';

export interface StatusDotProps {
  state: StatusState;
  label?: string;
  /** Relay URL currently connected to (shown in hover tooltip). */
  relayUrl?: string | null;
  /** Active MoQT draft version (shown in hover tooltip). */
  draft?: string | null;
  /** Error message if state is 'error'. */
  error?: string | null;
}

const stateLabel: Record<StatusState, string> = {
  idle: 'Disconnected',
  connecting: 'Connecting…',
  ready: 'Connected',
  error: 'Error',
};

function formatRelayHost(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + (u.port ? `:${u.port}` : '');
  } catch {
    return url;
  }
}

export function StatusDot({ state, label, relayUrl, draft, error }: StatusDotProps) {
  const [hovering, setHovering] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const hasTooltip = relayUrl || draft || error;

  return (
    <span
      ref={ref}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8, position: 'relative', cursor: hasTooltip ? 'default' : undefined }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <span className="ak-badge-dot" data-state={state === 'ready' ? 'ready' : state} />
      {label && <span className="ak-subtle" style={{ fontWeight: 500 }}>{label}</span>}

      {hovering && hasTooltip && (
        <span
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 8,
            padding: '10px 14px',
            borderRadius: 8,
            background: 'var(--ak-glass-bg, rgba(30, 30, 40, 0.92))',
            backdropFilter: 'blur(12px)',
            border: '1px solid var(--ak-border, rgba(255,255,255,0.1))',
            color: 'var(--ak-text, #e0e0e0)',
            fontSize: 12,
            lineHeight: 1.6,
            whiteSpace: 'nowrap',
            zIndex: 100,
            pointerEvents: 'none',
            boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
            minWidth: 180,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', opacity: 0.6 }}>
            Connection
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <span className="ak-badge-dot" data-state={state === 'ready' ? 'ready' : state} style={{ width: 6, height: 6, flexShrink: 0 }} />
            <span>{stateLabel[state]}</span>
          </div>
          {relayUrl && (
            <div style={{ opacity: 0.7, fontFamily: 'var(--ak-font-mono, monospace)', fontSize: 11 }}>
              {formatRelayHost(relayUrl)}
            </div>
          )}
          {draft && (
            <div style={{ opacity: 0.7, marginTop: 2 }}>
              Draft: {draft.replace('draft-', 'd')}
            </div>
          )}
          {error && state === 'error' && (
            <div style={{ color: 'var(--ak-danger, #ef4444)', marginTop: 4, fontSize: 11, maxWidth: 260, whiteSpace: 'normal' }}>
              {error}
            </div>
          )}
        </span>
      )}
    </span>
  );
}
