import { SPEECH_ACTIVITY_KEY, TRACK_FILTER_PARAM } from './constants';

export function encodeTrackFilterParam(
  maxSelected: number,
  propertyType: number = SPEECH_ACTIVITY_KEY
): Map<number, Uint8Array> {
  const value = (propertyType << 8) | (maxSelected & 0xff);
  const params = new Map<number, Uint8Array>();
  params.set(TRACK_FILTER_PARAM, encodeVarInt(value));
  return params;
}

function encodeVarInt(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return new Uint8Array(bytes);
}
