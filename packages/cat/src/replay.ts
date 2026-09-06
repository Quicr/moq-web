// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/** Replay protection primitives. A replay decision must be stateful and atomic. */

import type { CwtClaims } from './types.js';

export interface ReplayStore {
  /** Returns true only for the first presentation of id before expiry. */
  checkAndStore(id: Uint8Array, expiresAt: number): Promise<boolean>;
}

export interface ReplayStoreOptions {
  maxEntries?: number;
  now?: () => number;
}

export class MemoryReplayStore implements ReplayStore {
  private readonly entries = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: ReplayStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 100_000;
    this.now = options.now ?? (() => Date.now() / 1000);
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries <= 0) throw new ReplayError('maxEntries must be a positive integer');
  }

  async checkAndStore(id: Uint8Array, expiresAt: number): Promise<boolean> {
    if (!(id instanceof Uint8Array) || id.length === 0 || !Number.isFinite(expiresAt)) throw new ReplayError('Invalid replay entry');
    this.removeExpired();
    const key = bytesToHex(id);
    if (this.entries.has(key)) return false;
    if (this.entries.size >= this.maxEntries) this.evictOne();
    this.entries.set(key, expiresAt);
    return true;
  }

  get size(): number { this.removeExpired(); return this.entries.size; }

  private removeExpired(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.entries) if (expiresAt <= now) this.entries.delete(key);
  }

  private evictOne(): void {
    const first = this.entries.keys().next();
    if (!first.done) this.entries.delete(first.value);
  }
}

export interface CatReplayOptions {
  store: ReplayStore;
  now?: number;
  expiresAt?: number;
}

export async function acceptCatReplay(claims: CwtClaims, options: CatReplayOptions): Promise<boolean> {
  if (!(claims.cti instanceof Uint8Array) || claims.cti.length === 0) return true;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const expiresAt = options.expiresAt ?? claims.exp ?? now + 300;
  return options.store.checkAndStore(claims.cti, expiresAt);
}

export interface DpopReplayOptions {
  store: ReplayStore;
  id: Uint8Array;
  issuedAt: number;
  windowSeconds: number;
  now?: number;
}

export async function acceptDpopReplay(options: DpopReplayOptions): Promise<boolean> {
  if (!Number.isFinite(options.issuedAt) || !Number.isFinite(options.windowSeconds) || options.windowSeconds < 0) throw new ReplayError('Invalid DPoP replay window');
  const now = options.now ?? Math.floor(Date.now() / 1000);
  return options.store.checkAndStore(options.id, options.issuedAt + options.windowSeconds > now ? options.issuedAt + options.windowSeconds : now + options.windowSeconds);
}

function bytesToHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  return result;
}

export class ReplayError extends Error { constructor(message: string) { super(message); this.name = 'ReplayError'; } }
