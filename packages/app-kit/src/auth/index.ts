// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { registerAuthAdapter } from './registry.js';
import { cloudflareAdapter } from './adapters/cloudflare.js';

// Register built-in adapters at module load. Additional adapters can be
// registered by app code via `registerAuthAdapter` before opening a session.
registerAuthAdapter(cloudflareAdapter);

export type {
  AuthAdapter,
  AuthOperation,
  MintContext,
  MintedAuthToken,
  ProviderState,
  SettingsPanelProps,
} from './types.js';
export { registerAuthAdapter, getAuthAdapter, listAuthAdapters } from './registry.js';
export { cloudflareAdapter } from './adapters/cloudflare.js';
export type {
  CloudflareState,
  CloudflareRelay,
  CloudflareCachedToken,
} from './adapters/cloudflare.js';
