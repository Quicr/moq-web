// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import { Draft18BufferWriter, utf8Length } from './protocol-codec';
import { MOQTVarInt } from './moqt-varint';

describe('Draft18BufferWriter', () => {
  it('writes the same bytes as concatenating each piece, across scratch growth and referenced runs', () => {
    const writer = new Draft18BufferWriter();
    const expected: number[] = [];
    let state = 7;
    for (let i = 0; i < 3000; i++) {
      state = (state * 1103515245 + 12345) >>> 0;
      switch (state % 4) {
        case 0: {
          const value = state % 1_000_000_000;
          writer.writeVarInt(value);
          expected.push(...MOQTVarInt.encode(value));
          break;
        }
        case 1:
          writer.writeByte(state);
          expected.push(state & 0xff);
          break;
        case 2: {
          const run = new Uint8Array(state % 40).fill(i & 0xff);
          writer.writeBytes(run);
          expected.push(...run);
          break;
        }
        default: {
          const run = new Uint8Array(256 + (state % 300)).fill((i * 3) & 0xff);
          writer.writeBytes(run);
          expected.push(...run);
        }
      }
    }

    expect(writer.length).toBe(expected.length);
    expect(Array.from(writer.toUint8Array())).toEqual(expected);
    const prefixed = writer.toUint8ArrayWithPrefix(new Uint8Array([1, 2]), new Uint8Array([3]));
    expect(Array.from(prefixed.subarray(0, 3))).toEqual([1, 2, 3]);
    expect(prefixed.length).toBe(expected.length + 3);
  });

  it('keeps large runs by reference, so the result is one copy of them', () => {
    const writer = new Draft18BufferWriter();
    const payload = new Uint8Array(4096).fill(9);
    writer.writeVarInt(payload.length);
    writer.writeBytes(payload);
    payload[0] = 1; // changes before toUint8Array are seen: not copied yet
    const out = writer.toUint8Array();
    expect(out[2]).toBe(1);
    expect(out.length).toBe(2 + 4096);
  });

  it('returns an empty array when nothing was written, and is reusable after toUint8Array', () => {
    const writer = new Draft18BufferWriter();
    expect(writer.toUint8Array()).toEqual(new Uint8Array(0));
    writer.writeByte(5);
    expect(writer.toUint8Array()).toEqual(new Uint8Array([5]));
    writer.writeByte(6);
    expect(writer.toUint8Array()).toEqual(new Uint8Array([5, 6]));
  });
});

describe('UTF-8 writes match TextEncoder', () => {
  const TE = new TextEncoder();
  const samples = [
    '', 'video', 'room-1/participant-42', 'café', 'ж', '日本語', '😀', 'a😀b',
    '\ud800', 'x\udc00y', '\ud83d', '\udc00\ud800', 'é'.repeat(300), 'a'.repeat(5000),
  ];

  it.each(samples.map((s) => [JSON.stringify(s).slice(0, 30), s]))('%s', (_label, str) => {
    const expected = TE.encode(str);
    expect(utf8Length(str)).toBe(expected.length);
    const writer = new Draft18BufferWriter();
    writer.writeByte(0xaa);
    writer.writeString(str);
    const out = writer.toUint8Array();
    expect(out[0]).toBe(0xaa);
    const [length, read] = [expected.length, out.length - expected.length - 1];
    expect(out.subarray(1 + read)).toEqual(expected);
    expect(writer.length).toBe(1 + read + length);
  });
});
