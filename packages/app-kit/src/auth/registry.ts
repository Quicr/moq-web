// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import type { AuthAdapter } from './types.js';

const registry = new Map<string, AuthAdapter>();

/** Register an adapter so it appears in the settings dropdown. */
export function registerAuthAdapter(adapter: AuthAdapter): void {
  registry.set(adapter.id, adapter);
}

export function getAuthAdapter(id: string | null | undefined): AuthAdapter | null {
  if (!id) return null;
  return registry.get(id) ?? null;
}

export function listAuthAdapters(): AuthAdapter[] {
  return Array.from(registry.values());
}
