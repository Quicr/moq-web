// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { useTheme, type ThemeMode } from './ThemeProvider.js';

const MODES: { id: ThemeMode; label: string; glyph: string }[] = [
  { id: 'light', label: 'Light', glyph: '☀' },
  { id: 'dark', label: 'Dark', glyph: '☾' },
  { id: 'system', label: 'Auto', glyph: '⚙' },
];

export function ThemeSwitch() {
  const { mode, setMode } = useTheme();
  return (
    <div className="ak-tabs" role="tablist" aria-label="Theme">
      {MODES.map((m) => (
        <button
          key={m.id}
          role="tab"
          aria-selected={mode === m.id}
          className="ak-tab"
          onClick={() => setMode(m.id)}
          title={m.label}
        >
          <span aria-hidden="true" style={{ marginRight: 6 }}>{m.glyph}</span>
          {m.label}
        </button>
      ))}
    </div>
  );
}
