// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { useEffect } from 'react';
import { getBundledDraft, switchDraftInBrowser } from '../moqt/version.js';
import { useTransportActions, useTransportConfig } from './state.js';

const DRAFTS: { id: 'draft-16' | 'draft-18'; label: string }[] = [
  { id: 'draft-16', label: 'd16' },
  { id: 'draft-18', label: 'd18' },
];

/**
 * Draft selector. The MoQT codec is compile-time bundled, so switching drafts
 * navigates the browser to the sibling build (`/` ↔ `/18/`) rather than
 * flipping a runtime flag.
 */
export function DraftSwitch() {
  const cfg = useTransportConfig();
  const { setRelay } = useTransportActions();
  const bundled = getBundledDraft();

  useEffect(() => {
    if (cfg.relay.draft !== bundled) {
      setRelay({ draft: bundled });
    }
  }, [bundled, cfg.relay.draft, setRelay]);

  return (
    <div className="ak-tabs" role="tablist" aria-label="MoQT draft version">
      {DRAFTS.map((d) => {
        const selected = bundled === d.id;
        return (
          <button
            key={d.id}
            role="tab"
            aria-selected={selected}
            className="ak-tab"
            onClick={() => {
              setRelay({ draft: d.id });
              switchDraftInBrowser(d.id);
            }}
            title={`MoQT ${d.id}${selected ? ' (bundled)' : ' — reload into sibling build'}`}
          >
            {d.label}
          </button>
        );
      })}
    </div>
  );
}
