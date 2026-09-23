// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import React from 'react';
import { ThemeSwitch } from './ThemeSwitch.js';
import { DraftSwitch } from '../transport/DraftSwitch.js';

export interface AppShellProps {
  title: string;
  tagline?: string;
  actions?: React.ReactNode;
  /** Show the MoQT draft (d16/d18) switch in the header. Defaults to true. */
  showDraftSwitch?: boolean;
  children: React.ReactNode;
}

export function AppShell({ title, tagline, actions, showDraftSwitch = true, children }: AppShellProps) {
  return (
    <div className="ak-app">
      <header
        className="ak-glass"
        style={{
          margin: '20px 20px 0 20px',
          padding: '18px 24px',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          borderRadius: 20,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
          <div className="ak-caption">moq-web · app-kit</div>
          <div className="ak-title">{title}</div>
          {tagline && <div className="ak-subtle">{tagline}</div>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {actions}
          {showDraftSwitch && <DraftSwitch />}
          <ThemeSwitch />
        </div>
      </header>
      <main style={{ padding: 20 }}>{children}</main>
    </div>
  );
}
