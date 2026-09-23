// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { useState } from 'react';
import { GlassPanel } from '@moq-web/app-kit/shell';
import type { TimelineEvent } from '../moqt';

interface Props {
  onEmit: (kind: TimelineEvent['kind'], label: string) => void;
  disabled: boolean;
}

const PRESETS: { kind: TimelineEvent['kind']; label: string; hint: string }[] = [
  { kind: 'delta', label: 'Bitrate step-up', hint: 'ABR ladder change' },
  { kind: 'meta', label: 'Slide change', hint: 'Presenter switched slide' },
  { kind: 'meta', label: 'Q&A open', hint: 'Chat / Q&A moderation' },
];

/**
 * Free-form event input plus quick presets. Emits an event onto the
 * `timeline` track when the user hits Enter or Send.
 */
export function EventComposer({ onEmit, disabled }: Props) {
  const [kind, setKind] = useState<TimelineEvent['kind']>('meta');
  const [label, setLabel] = useState('');

  const commit = () => {
    const trimmed = label.trim();
    if (!trimmed) return;
    onEmit(kind, trimmed);
    setLabel('');
  };

  return (
    <GlassPanel padding="md">
      <div className="ak-row-between" style={{ marginBottom: 10 }}>
        <div className="ak-heading">Emit event</div>
        <div className="ak-subtle" style={{ fontSize: 11 }}>
          Publishes onto <code>timeline</code>
        </div>
      </div>
      <div className="ak-row" style={{ gap: 8, alignItems: 'stretch' }}>
        <select
          className="ak-select"
          value={kind}
          onChange={(e) => setKind(e.target.value as TimelineEvent['kind'])}
          disabled={disabled}
          style={{ maxWidth: 120 }}
        >
          <option value="meta">meta</option>
          <option value="delta">delta</option>
          <option value="join">join</option>
        </select>
        <input
          className="ak-input"
          placeholder="Event label (e.g. Chapter break)"
          value={label}
          disabled={disabled}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
          style={{ flex: 1 }}
        />
        <button
          className="ak-btn ak-btn-primary"
          onClick={commit}
          disabled={disabled || label.trim() === ''}
        >
          Send
        </button>
      </div>
      <div className="ak-row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            className="ak-btn ak-btn-ghost"
            style={{ fontSize: 11 }}
            disabled={disabled}
            onClick={() => onEmit(p.kind, p.label)}
            title={p.hint}
          >
            + {p.label}
          </button>
        ))}
      </div>
    </GlassPanel>
  );
}
