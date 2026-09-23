// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

export type StatusState = 'idle' | 'connecting' | 'ready' | 'error';

export interface StatusDotProps {
  state: StatusState;
  label?: string;
}

export function StatusDot({ state, label }: StatusDotProps) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span className="ak-badge-dot" data-state={state === 'ready' ? 'ready' : state} />
      {label && <span className="ak-subtle" style={{ fontWeight: 500 }}>{label}</span>}
    </span>
  );
}
