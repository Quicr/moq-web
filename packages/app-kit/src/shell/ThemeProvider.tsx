// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'ak.theme';

function resolveMode(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  return mode;
}

export interface ThemeProviderProps {
  defaultMode?: ThemeMode;
  children: React.ReactNode;
}

export function ThemeProvider({ defaultMode = 'system', children }: ThemeProviderProps) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') return defaultMode;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
    return defaultMode;
  });

  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveMode(mode));

  useEffect(() => {
    const applied = resolveMode(mode);
    setResolved(applied);
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = applied;
      document.documentElement.classList.toggle('dark', applied === 'dark');
    }
    window.localStorage?.setItem(STORAGE_KEY, mode);
  }, [mode]);

  useEffect(() => {
    if (mode !== 'system') return;
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const listener = () => setResolved(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', listener);
    return () => mq.removeEventListener('change', listener);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => setModeState(next), []);
  const toggle = useCallback(() => setModeState((cur) => (cur === 'dark' ? 'light' : 'dark')), []);

  const value = useMemo(() => ({ mode, resolved, setMode, toggle }), [mode, resolved, setMode, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
