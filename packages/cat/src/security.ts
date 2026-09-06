// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/** Composed CAT, DPoP, replay, and request-policy validation. */

import { CatTokenDecoder } from './cat.js';
import { resolveCatVerificationKey, type CatKeyResolver } from './keys.js';
import { evaluateCatPolicy, type CatPolicyOptions, type CatRequestContext } from './policy.js';
import { acceptCatReplay, acceptDpopReplay, type ReplayStore } from './replay.js';
import { validateCatDpopBinding, validateDpopProof, type DpopValidationOptions, type DpopValidationResult } from './dpop.js';
import type { CatValidationOptions, CatValidationResult, CwtClaims } from './types.js';

export interface CatSecurityValidationOptions extends CatValidationOptions {
  dpopProof?: Uint8Array;
  dpop?: Omit<DpopValidationOptions, 'expectedJkt' | 'expectedCkt'>;
  replayStore?: ReplayStore;
  request?: CatRequestContext;
  policy?: CatPolicyOptions;
}

export interface CatSecurityValidationResult extends CatValidationResult {
  policy?: { allowed: boolean; reason?: string };
  dpop?: DpopValidationResult;
  replayChecked?: boolean;
}

export async function validateCatRequest(data: Uint8Array, verificationKey: CryptoKey, options: CatSecurityValidationOptions = {}): Promise<CatSecurityValidationResult> {
  const tokenResult = await CatTokenDecoder.validate(data, verificationKey, options);
  if (!tokenResult.valid || !tokenResult.token) return tokenResult;
  const claims = tokenResult.token.claims;

  const catReplayRequired = claims.catreplay === 1 || claims.catreplay === 2;
  if (catReplayRequired) {
    if (!(claims.cti instanceof Uint8Array) || claims.cti.length === 0) {
      return { ...tokenResult, valid: false, error: 'Replay-protected CAT is missing cti', replayChecked: false };
    }
    if (!options.replayStore) return { ...tokenResult, valid: false, error: 'Replay protection is required', replayChecked: false };
  }

  const jkt = claims.cnf?.get(323);
  const ckt = claims.cnf?.get(5);
  const bound = jkt instanceof Uint8Array || ckt instanceof Uint8Array;
  if (bound && !options.dpopProof) return { ...tokenResult, valid: false, error: 'DPoP proof is required', dpop: { valid: false, error: 'Missing proof' } };
  let dpopResult: DpopValidationResult | undefined;
  let dpopProof: DpopValidationResult['proof'];
  if (options.dpopProof) {
    if (!bound) return { ...tokenResult, valid: false, error: 'DPoP proof supplied for an unbound CAT', dpop: { valid: false, error: 'CAT is not DPoP-bound' } };
    const configuredWindow = claims.catdpop?.get(0);
    const maxAge = typeof configuredWindow === 'number' && Number.isSafeInteger(configuredWindow) ? Math.min(configuredWindow, options.dpop?.maxAgeSeconds ?? configuredWindow) : options.dpop?.maxAgeSeconds;
    dpopResult = await validateDpopProof(options.dpopProof, {
      ...options.dpop,
      maxAgeSeconds: maxAge,
      expectedJkt: jkt instanceof Uint8Array ? jkt : undefined,
      expectedCkt: ckt instanceof Uint8Array ? ckt : undefined,
    });
    if (!dpopResult.valid || !dpopResult.proof) return { ...tokenResult, valid: false, error: dpopResult.error ?? 'DPoP validation failed', dpop: dpopResult };
    dpopProof = dpopResult.proof;
    if (!(await validateCatDpopBinding(claims, dpopProof))) return { ...tokenResult, valid: false, error: 'DPoP key binding failed', dpop: { valid: false, error: 'Key binding failed' } };
  }

  let policy: CatSecurityValidationResult['policy'];
  if (options.request) {
    policy = await evaluateCatPolicy(claims, options.request, options.policy);
    if (!policy.allowed) return { ...tokenResult, valid: false, error: policy.reason ?? 'CAT policy rejected request', policy };
  }

  // Consume replay identifiers only after every stateless check has passed.
  // This prevents malformed/unauthorized presentations from burning a valid
  // one-time CAT or DPoP proof before the legitimate request arrives.
  let replayChecked = false;
  if (catReplayRequired) {
    if (!(await acceptCatReplay(claims, { store: options.replayStore!, now: options.now }))) return { ...tokenResult, valid: false, error: 'Token replay detected', dpop: dpopResult, policy, replayChecked: true };
    replayChecked = true;
  }
  const jtiSetting = claims.catdpop?.get(1);
  if (dpopProof && jtiSetting === 1) {
    if (!options.replayStore) return { ...tokenResult, valid: false, error: 'DPoP replay protection is required', dpop: dpopResult, policy, replayChecked: false };
    if (!(await acceptDpopReplay({ store: options.replayStore!, id: prefixReplayId(dpopProof.claims.cti!), issuedAt: dpopProof.claims.iat!, windowSeconds: maxAgeForDpop(claims, options.dpop?.maxAgeSeconds), now: options.now }))) return { ...tokenResult, valid: false, error: 'DPoP replay detected', dpop: dpopResult, policy, replayChecked: true };
    replayChecked = true;
  }
  return { ...tokenResult, dpop: dpopResult, policy, replayChecked: replayChecked || undefined };
}

function maxAgeForDpop(claims: CwtClaims, configuredMaxAge?: number): number {
  const configuredWindow = claims.catdpop?.get(0);
  return typeof configuredWindow === 'number' && Number.isSafeInteger(configuredWindow)
    ? Math.min(configuredWindow, configuredMaxAge ?? configuredWindow)
    : configuredMaxAge ?? 300;
}

/** Validate a CAT after resolving its verification key from the protected kid. */
export async function validateCatRequestWithResolver(data: Uint8Array, resolver: CatKeyResolver, options: CatSecurityValidationOptions = {}): Promise<CatSecurityValidationResult> {
  try {
    const key = await resolveCatVerificationKey(data, resolver);
    return validateCatRequest(data, key, options);
  } catch {
    return { valid: false, error: 'CAT verification key resolution failed' };
  }
}

function prefixReplayId(id: Uint8Array): Uint8Array {
  const result = new Uint8Array(id.length + 1);
  result[0] = 0xd;
  result.set(id, 1);
  return result;
}
