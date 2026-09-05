// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Variable substitution for MSF (§8).
 *
 * Track/catalog strings may embed `%varName%` tokens that are resolved against
 * key/value pairs supplied on the URL fragment. This module implements the
 * §8 rules:
 *
 * - Variable names: alphanumeric, `-`, `_` (charset `[A-Za-z0-9_-]`).
 * - Variable values: alphanumeric, `-`, `_`, `@` (charset `[A-Za-z0-9_@-]`).
 * - Separators in fragment: `&` between pairs, `=` between key and value.
 * - `?` is reserved for server-side use and is REJECTED here.
 */

/**
 * Error thrown when a %var% token cannot be resolved or a value violates
 * §8 charset rules.
 */
export class VariableSubstitutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VariableSubstitutionError';
  }
}

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const VALUE_RE = /^[A-Za-z0-9_@-]+$/;
const TOKEN_RE = /%([^%]+)%/g;

export function isValidVariableName(name: string): boolean {
  return NAME_RE.test(name);
}

export function isValidVariableValue(value: string): boolean {
  return VALUE_RE.test(value);
}

/**
 * Parse an MSF fragment variable string (`k=v&k=v&...`) into a map.
 *
 * @throws {VariableSubstitutionError} on malformed pairs, duplicate keys,
 *   forbidden `?`, or charset violations.
 */
export function parseFragmentVariables(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (input === '') return result;

  if (input.includes('?')) {
    throw new VariableSubstitutionError(
      "'?' is reserved for server-side use in MSF fragments (§8)"
    );
  }

  for (const pair of input.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    if (eq < 0) {
      throw new VariableSubstitutionError(
        `Fragment variable missing '=': ${pair}`
      );
    }
    const name = pair.substring(0, eq);
    const value = pair.substring(eq + 1);
    if (!isValidVariableName(name)) {
      throw new VariableSubstitutionError(
        `Invalid variable name '${name}' (allowed: [A-Za-z0-9_-])`
      );
    }
    if (!isValidVariableValue(value)) {
      throw new VariableSubstitutionError(
        `Invalid value for '${name}': '${value}' (allowed: [A-Za-z0-9_@-])`
      );
    }
    if (name in result) {
      throw new VariableSubstitutionError(
        `Duplicate variable name '${name}' in fragment`
      );
    }
    result[name] = value;
  }
  return result;
}

/**
 * Serialize a variable map into a fragment `k=v&k=v` string.
 *
 * @throws {VariableSubstitutionError} on names/values that violate §8.
 */
export function serializeFragmentVariables(
  vars: Record<string, string>
): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(vars)) {
    if (!isValidVariableName(name)) {
      throw new VariableSubstitutionError(
        `Invalid variable name '${name}' (allowed: [A-Za-z0-9_-])`
      );
    }
    if (!isValidVariableValue(value)) {
      throw new VariableSubstitutionError(
        `Invalid value for '${name}': '${value}' (allowed: [A-Za-z0-9_@-])`
      );
    }
    parts.push(`${name}=${value}`);
  }
  return parts.join('&');
}

/**
 * Substitute every `%name%` token in `template` with the matching value.
 *
 * @param template - Source string possibly containing `%name%` tokens.
 * @param vars - Values to substitute.
 * @param options.allowUnresolved - If true, leave unknown tokens untouched
 *   instead of throwing.
 * @throws {VariableSubstitutionError} when a referenced variable is missing
 *   and `allowUnresolved` is false (default).
 */
export function substituteVariables(
  template: string,
  vars: Record<string, string>,
  options: { allowUnresolved?: boolean } = {}
): string {
  return template.replace(TOKEN_RE, (match, name: string) => {
    if (!isValidVariableName(name)) {
      if (options.allowUnresolved) return match;
      throw new VariableSubstitutionError(
        `Invalid variable name in template: '${name}'`
      );
    }
    if (name in vars) return vars[name];
    if (options.allowUnresolved) return match;
    throw new VariableSubstitutionError(
      `Unresolved variable '%${name}%' in template`
    );
  });
}

/**
 * Recursively walk a JSON-like structure and substitute `%var%` tokens on
 * every string. Non-string leaves are passed through unchanged.
 */
export function substituteVariablesDeep<T>(
  value: T,
  vars: Record<string, string>,
  options: { allowUnresolved?: boolean } = {}
): T {
  if (typeof value === 'string') {
    return substituteVariables(value, vars, options) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) =>
      substituteVariablesDeep(v, vars, options)
    ) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteVariablesDeep(v, vars, options);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Return the set of variable names referenced by a template string.
 */
export function extractVariableNames(template: string): string[] {
  const names = new Set<string>();
  for (const m of template.matchAll(TOKEN_RE)) {
    if (isValidVariableName(m[1])) names.add(m[1]);
  }
  return [...names];
}
