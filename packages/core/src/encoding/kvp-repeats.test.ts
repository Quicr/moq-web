// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import { Draft18BufferReader } from './protocol-codec';
import { decodeKeyValuePairsToEnd, repeatedKeys } from './codec-helpers';
import { Draft18StreamCodec } from './draft18-stream-codec';

describe('repeatedKeys (draft-23 §8.4)', () => {
  it('records a key decoded more than once, and keeps the last value', () => {
    // 0x02=1, 0x02=2 (delta 0), 0x04=3
    const pairs = decodeKeyValuePairsToEnd(new Draft18BufferReader(new Uint8Array([0x02, 0x01, 0x00, 0x02, 0x02, 0x03]), 0));
    expect([...(repeatedKeys(pairs) ?? [])]).toEqual([2]);
    expect(pairs.get(2)).toEqual(new Uint8Array([0x02]));
  });

  it('records nothing without repeats', () => {
    const pairs = decodeKeyValuePairsToEnd(new Draft18BufferReader(new Uint8Array([0x02, 0x01, 0x02, 0x03]), 0));
    expect(repeatedKeys(pairs)).toBeUndefined();
  });

  it('records repeats in Object Properties', () => {
    // Object ID Delta 0, Properties Length 4: 0x50=1, then 0x50=2 (delta 0), Payload Length 0
    const props = [0x50, 0x01, 0x00, 0x02];
    const bytes = new Uint8Array([0x00, props.length, ...props, 0x00]);
    const [decoded] = Draft18StreamCodec.decodeObjectHeader(bytes, 0, true);
    expect([...(repeatedKeys(decoded.objectProperties!) ?? [])]).toEqual([0x50]);
  });
});
