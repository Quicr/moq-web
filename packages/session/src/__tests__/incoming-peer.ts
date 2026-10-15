// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Test harness for the responder side: a session in the ready state and
 * request streams the "peer" opens to it.
 */

import { MOQTransport, type ControlMessageDraft18 } from '@moq-web/core';

import { MOQTSession } from '../session.js';

export type Draft = 'draft-18' | 'draft-22';

type Stream = { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };

export interface SessionInternals {
  codec: {
    encodeControlMessage: (m: unknown) => Uint8Array;
    decodeControlMessage: (b: Uint8Array) => [ControlMessageDraft18, number];
  };
  announcedNamespaces: Map<string, unknown>;
  activeRequestStreams: Map<bigint, unknown>;
  publicationManager: {
    add: (p: unknown) => void;
    getByRequestId: (id: bigint) => Record<string, unknown> | undefined;
    getByTrackName: (ns: string[], name: string) => Record<string, unknown> | undefined;
    updateLatest: (alias: bigint, group: bigint, object: bigint) => void;
  };
  processIncomingBidiStream: (s: Stream) => Promise<void>;
}

export interface IncomingPeer {
  /** Messages we wrote on the stream, in order. */
  written: () => ControlMessageDraft18[];
  send: (...messages: unknown[]) => void;
  fin: () => void;
  closed: () => boolean;
  opened: Promise<void>;
}

export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export function makeSession(
  draft: Draft,
  onClose: (options: unknown) => void = () => {},
): { session: MOQTSession; internals: SessionInternals } {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: () => Promise<void> }).close = () => Promise.resolve();
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  (session as unknown as { close: (o: unknown) => Promise<void> }).close = (options) => {
    onClose(options);
    return Promise.resolve();
  };

  return { session, internals: session as unknown as SessionInternals };
}

export function announce(internals: SessionInternals, namespace: string[], options: object = {}): void {
  internals.announcedNamespaces.set(namespace.join('/'), { namespace, options, subscribers: new Map() });
}

/** Open a request stream from the peer whose first message is `first`. */
export function openIncoming(internals: SessionInternals, first: unknown): IncomingPeer {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encode = (m: unknown) => internals.codec.encodeControlMessage(m);
  const readable = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
      c.enqueue(encode(first));
    },
  });
  const chunks: Uint8Array[] = [];
  let isClosed = false;
  const writable = new WritableStream<Uint8Array>({
    write: (chunk) => {
      chunks.push(chunk);
    },
    close: () => {
      isClosed = true;
    },
  });
  const opened = internals.processIncomingBidiStream({ readable, writable });

  return {
    opened,
    written: () => chunks.map((chunk) => internals.codec.decodeControlMessage(chunk)[0]),
    send: (...messages) => messages.forEach((m) => controller.enqueue(encode(m))),
    fin: () => controller.close(),
    closed: () => isClosed,
  };
}
