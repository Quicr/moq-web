// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { useTransportActions, useTransportConfig } from './state.js';

const DRAFTS: { id: 'draft-16' | 'draft-18' | 'draft-22'; label: string }[] = [
  { id: 'draft-16', label: 'd16' },
  { id: 'draft-18', label: 'd18' },
  { id: 'draft-22', label: 'd22' },
];

/**
 * Draft selector. Updates the relay config so the next connection uses the
 * selected draft. The draft is passed at runtime to MOQTransport({ draft }),
 * so no page reload is needed — just reconnect.
 */
export function DraftSwitch() {
  const cfg = useTransportConfig();
  const { setRelay } = useTransportActions();

  return (
    <div className="ak-tabs" role="tablist" aria-label="MoQT draft version">
      {DRAFTS.map((d) => {
        const selected = cfg.relay.draft === d.id;
        return (
          <button
            key={d.id}
            role="tab"
            aria-selected={selected}
            className="ak-tab"
            onClick={() => {
              setRelay({ draft: d.id });
            }}
            title={`MoQT ${d.id}${selected ? ' (active)' : ''}`}
          >
            {d.label}
          </button>
        );
      })}
    </div>
  );
}
