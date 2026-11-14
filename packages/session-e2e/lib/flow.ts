// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Helpers for the scenario tests: the draft under test, a timestamped trace
 * of each session's control messages and events (printed and recorded, so a
 * failure in the interop report shows what each side saw), publishing a run
 * of groups, and waiting with a deadline.
 */

import { isDraftAtLeast, PublishDoneErrorCodeDraft18, RequestErrorCodeDraft18, type DraftVersion } from '@moq-web/core';
import type { MOQTSession } from '@moq-web/session';

const ENV = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
export const MOQT_VERSION = ENV.VITE_MOQT_VERSION ?? 'draft-18';
/** The scenario tests target draft-22 and draft-23 */
export const isDraft22 = isDraftAtLeast(MOQT_VERSION as DraftVersion, 22);
export const isDraft23 = isDraftAtLeast(MOQT_VERSION as DraftVersion, 23);

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `promise`, or a rejection naming `what` after `ms` */
export function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms} ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

/** Poll until `done()` holds or `ms` passes; whether it held */
export async function waitUntil(done: () => boolean, ms: number, everyMs = 50): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() >= deadline) return false;
    await sleep(everyMs);
  }

  return true;
}

/** A request error code by name, e.g. DOES_NOT_EXIST (0x10) */
export function requestErrorName(code: number | undefined): string {
  if (code === undefined) return 'none';
  return `${RequestErrorCodeDraft18[code] ?? 'unknown'} (0x${code.toString(16)})`;
}

/** A PUBLISH_DONE status code by name, e.g. TRACK_ENDED (0x2) */
export function publishDoneName(code: number | undefined): string {
  if (code === undefined) return 'none';
  return `${PublishDoneErrorCodeDraft18[code] ?? 'unknown'} (0x${code.toString(16)})`;
}

/** Session events worth a line in a trace */
const TRACED = [
  'message-sent', 'message-received', 'request-ok', 'namespace-acknowledged', 'namespace-announced',
  'namespace-done', 'namespace-error', 'incoming-publish', 'incoming-subscribe', 'publish-done', 'subscribe-ok',
  'subscribe-error', 'subscription-cancelled', 'stream-reset', 'forward-state-change', 'new-group-request',
  'fetch-complete', 'fetch-error', 'goaway', 'session-terminated', 'error',
] as const;
/** Events that mean something went wrong on a session */
const UNEXPECTED = new Set(['namespace-error', 'subscribe-error', 'subscription-cancelled', 'stream-reset', 'fetch-error', 'session-terminated', 'error']);

function describeEvent(event: string, data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>;
  if (event === 'message-sent' || event === 'message-received') {
    return `${event === 'message-sent' ? '→' : '←'} ${String(d.messageType)} ${String(d.summary ?? '')}`;
  }
  const fields = ['requestKind', 'requestId', 'namespace', 'trackName', 'trackAlias', 'forward', 'errorCode', 'reasonPhrase',
    'reason', 'statusCode', 'finalGroupId', 'largestGroupId', 'code', 'message', 'value']
    .filter((k) => d[k] !== undefined)
    .map((k) => `${k}=${Array.isArray(d[k]) ? (d[k] as unknown[]).join('/') : String(d[k])}`);

  return `[${event}] ${fields.join(' ')}`;
}

/**
 * Each session's control messages and events with a timestamp. `unexpected`
 * collects error events, except those a test says it expects and our own
 * publisher-side stream resets (a relay pausing a track with no subscriber).
 */
export class Trace {
  readonly lines: string[] = [];
  readonly unexpected: string[] = [];
  private readonly start = Date.now();
  private readonly expected = new Set<string>();
  tearingDown = false;

  /** Error events of this name are part of the scenario, not a fault */
  expect(event: string): void {
    this.expected.add(event);
  }

  note(who: string, text: string): void {
    this.lines.push(`+${String(Date.now() - this.start).padStart(5)}ms ${who} ${text}`);
  }

  attach(who: string, session: MOQTSession): void {
    for (const event of TRACED) {
      (session.on as (e: string, h: (data: unknown) => void) => void)(event, (data) => {
        const text = describeEvent(event, data);
        this.note(who, text);
        const ownReset = event === 'stream-reset' && (data as { side?: string } | undefined)?.side === 'publisher';
        if (UNEXPECTED.has(event) && !this.expected.has(event) && !ownReset && !this.tearingDown) {
          this.unexpected.push(`${who} ${text}`);
        }
      });
    }
  }

  /** Print the trace; the report keeps the last lines of a failed test */
  print(summary?: string): void {
    if (summary) console.warn(summary);
    console.warn(this.lines.join('\n'));
  }
}

/** The payload of (group, object): short text naming both */
export function payloadOf(group: number, object: number): Uint8Array {
  return new TextEncoder().encode(`g${group}/o${object}`);
}

export interface PublishedRun {
  /** Every (group/object) sent, in order */
  keys: string[];
  largest: { group: number; object: number };
}

/** Send groups [first, first + groups) of `perGroup` objects each on `alias` */
export async function publishGroups(
  session: MOQTSession,
  alias: bigint,
  options: { groups: number; perGroup: number; first?: number; gapMs?: number; properties?: (g: number, o: number) => ReadonlyMap<number, number | Uint8Array> | undefined },
): Promise<PublishedRun> {
  const first = options.first ?? 0;
  const keys: string[] = [];
  for (let g = first; g < first + options.groups; g++) {
    for (let o = 0; o < options.perGroup; o++) {
      await session.sendObject(alias, payloadOf(g, o), { groupId: g, objectId: o, properties: options.properties?.(g, o) });
      keys.push(`${g}/${o}`);
    }
    if (options.gapMs) await sleep(options.gapMs);
  }

  return { keys, largest: { group: first + options.groups - 1, object: options.perGroup - 1 } };
}

/** Collects (group/object) keys and checks each payload against `payloadOf` */
export class Received {
  readonly keys: string[] = [];
  readonly corrupt: string[] = [];
  readonly onObject = (data: Uint8Array, groupId: number, objectId: number): void => {
    const key = `${groupId}/${objectId}`;
    this.keys.push(key);
    if (new TextDecoder().decode(data) !== `g${groupId}/o${objectId}`) this.corrupt.push(key);
  };

  has(key: string): boolean {
    return this.keys.includes(key);
  }

  /** The groups seen, in arrival order of their first object */
  groups(): number[] {
    return [...new Set(this.keys.map((k) => Number(k.split('/')[0])))];
  }
}
