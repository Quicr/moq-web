// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview State of the SUBSCRIBE_NAMESPACE requests a peer made to us.
 *
 * Each accepted request is told about the namespaces that match its prefix and
 * about later changes to that set (draft-22 §4.2, draft-18 §10.18). A
 * NAMESPACE_DONE only follows a NAMESPACE for the same suffix, so every
 * subscription remembers which suffixes it has been told about.
 */

import { namespacePrefixMatches } from './session-helpers.js';

/** What happened to a namespace we announce. */
export enum NamespaceChange {
  ANNOUNCED = 'announced',
  WITHDRAWN = 'withdrawn',
}

/** A NAMESPACE or NAMESPACE_DONE to send: the suffix after the prefix (draft-22 §9.16, §9.17). */
export interface NamespaceNotice {
  requestId: bigint;
  change: NamespaceChange;
  suffix: string[];
}

interface Subscription {
  prefix: string[];
  /** Namespaces (as full tuples) sent in a NAMESPACE and not yet ended by a NAMESPACE_DONE */
  announced: Set<string>;
}

export class IncomingNamespaceSubscriptions {
  private readonly subscriptions = new Map<bigint, Subscription>();

  /**
   * Whether `prefix` shares a common prefix with an established
   * subscription: one is a prefix of the other, or they are equal
   * (draft-22 §4.2, PREFIX_OVERLAP). A request updating its own prefix is
   * left out of the comparison via `except`.
   */
  overlaps(prefix: string[], except?: bigint): boolean {
    for (const [requestId, subscription] of this.subscriptions) {
      if (requestId === except) {
        continue;
      }
      if (namespacePrefixMatches(subscription.prefix, prefix) || namespacePrefixMatches(prefix, subscription.prefix)) {
        return true;
      }
    }

    return false;
  }

  add(requestId: bigint, prefix: string[]): void {
    this.subscriptions.set(requestId, { prefix, announced: new Set() });
  }

  /**
   * Change the prefix of a request (draft-22 §9.5.2). What was announced
   * stays announced if the new prefix matches it, so it is not announced
   * again, and is forgotten otherwise.
   */
  update(requestId: bigint, prefix: string[]): void {
    const subscription = this.subscriptions.get(requestId);
    if (!subscription) {
      return;
    }

    subscription.prefix = prefix;
    for (const key of subscription.announced) {
      if (!namespacePrefixMatches(prefix, JSON.parse(key) as string[])) {
        subscription.announced.delete(key);
      }
    }
  }

  remove(requestId: bigint): void {
    this.subscriptions.delete(requestId);
  }

  clear(): void {
    this.subscriptions.clear();
  }

  /**
   * Record that `namespace` changed and return what each subscription must
   * be sent. A subscription is not told twice about a namespace, nor told a
   * namespace is done that it never heard of.
   */
  record(namespace: string[], change: NamespaceChange): NamespaceNotice[] {
    const notices: NamespaceNotice[] = [];
    for (const [requestId, subscription] of this.subscriptions) {
      if (!namespacePrefixMatches(subscription.prefix, namespace)) {
        continue;
      }

      const suffix = namespace.slice(subscription.prefix.length);
      const key = JSON.stringify(namespace);
      if (change === NamespaceChange.WITHDRAWN && !subscription.announced.delete(key)) {
        continue;
      }
      if (change === NamespaceChange.ANNOUNCED) {
        if (subscription.announced.has(key)) {
          continue;
        }
        subscription.announced.add(key);
      }

      notices.push({ requestId, change, suffix });
    }

    return notices;
  }
}
