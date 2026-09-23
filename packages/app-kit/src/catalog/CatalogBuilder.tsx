// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { useMemo, useState } from 'react';
import { GlassPanel } from '../shell/GlassPanel.js';

export interface CatalogFieldSpec {
  id: string;
  label: string;
  description?: string;
  defaultValue?: string | number | boolean;
  type: 'string' | 'number' | 'boolean';
}

export interface CatalogBuilderProps {
  fields: CatalogFieldSpec[];
  onPublish: (values: Record<string, string | number | boolean>) => void | Promise<void>;
  title?: string;
}

export function CatalogBuilder({ fields, onPublish, title = 'Catalog builder' }: CatalogBuilderProps) {
  const initial = useMemo(() => {
    const out: Record<string, string | number | boolean> = {};
    for (const f of fields) out[f.id] = f.defaultValue ?? (f.type === 'boolean' ? false : f.type === 'number' ? 0 : '');
    return out;
  }, [fields]);
  const [values, setValues] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  return (
    <GlassPanel padding="md">
      <div className="ak-row-between" style={{ marginBottom: 16 }}>
        <div className="ak-heading">{title}</div>
        {status && <span className="ak-chip ak-chip-success">{status}</span>}
      </div>
      <div className="ak-grid-2">
        {fields.map((f) => (
          <label key={f.id}>
            <div className="ak-caption" style={{ marginBottom: 6 }}>{f.label}</div>
            {f.type === 'boolean' ? (
              <select
                className="ak-select"
                value={String(values[f.id])}
                onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value === 'true' }))}
              >
                <option value="false">false</option>
                <option value="true">true</option>
              </select>
            ) : (
              <input
                className="ak-input"
                type={f.type === 'number' ? 'number' : 'text'}
                value={String(values[f.id])}
                onChange={(e) =>
                  setValues((v) => ({
                    ...v,
                    [f.id]: f.type === 'number' ? Number(e.target.value) : e.target.value,
                  }))
                }
              />
            )}
            {f.description && <div className="ak-subtle" style={{ marginTop: 4 }}>{f.description}</div>}
          </label>
        ))}
      </div>
      <div className="ak-row" style={{ marginTop: 20, justifyContent: 'flex-end' }}>
        <button
          className="ak-btn ak-btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setStatus(null);
            try {
              await onPublish(values);
              setStatus('published');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Publishing…' : 'Publish catalog'}
        </button>
      </div>
    </GlassPanel>
  );
}
