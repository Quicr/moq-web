export interface NegotiateConfig {
  host: string;
  port: string;
  meetingId: string;
  participantLang: string;
  sampleRate?: number;
}

export interface MOQSessionInfo {
  relayUrl: string;
  app: string;
  sessionId: string;
  transport: string;
  endpointId: string;
}

export async function negotiateMOQSession(config: NegotiateConfig): Promise<MOQSessionInfo> {
  const s2sId = `s2s-web-${Date.now().toString(16)}`;
  const participantId = `participant-${config.participantLang}`;

  const configPayload = encodeStreamingS2SRequest(
    s2sId,
    participantId,
    config.participantLang,
    config.sampleRate ?? 48000,
    config.meetingId,
  );

  const protocol = config.port === '443' ? 'wss' : 'ws';
  const wsUrl = `${protocol}://${config.host}:${config.port}/ws/s2s`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Negotiation timed out (10s)'));
    }, 10000);

    ws.onopen = () => {
      ws.send(configPayload);
    };

    ws.onmessage = (event) => {
      try {
        const data = new Uint8Array(event.data as ArrayBuffer);
        const info = decodeStreamingS2SResponse(data);
        if (info) {
          clearTimeout(timeout);
          ws.close();
          resolve(info);
        }
      } catch (e) {
        clearTimeout(timeout);
        ws.close();
        reject(e);
      }
    };

    ws.onerror = (e) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket error: ${e}`));
    };

    ws.onclose = (e) => {
      clearTimeout(timeout);
      if (e.code !== 1000 && e.code !== 1005) {
        reject(new Error(`WebSocket closed: ${e.reason || e.code}`));
      }
    };
  });
}

// --- Minimal protobuf encoder/decoder for the two messages we need ---

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return new Uint8Array(bytes);
}

function encodeTag(fieldNumber: number, wireType: number): Uint8Array {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeString(fieldNumber: number, value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  const tag = encodeTag(fieldNumber, 2);
  const len = encodeVarint(encoded.length);
  const result = new Uint8Array(tag.length + len.length + encoded.length);
  result.set(tag, 0);
  result.set(len, tag.length);
  result.set(encoded, tag.length + len.length);
  return result;
}

function encodeVarintField(fieldNumber: number, value: number): Uint8Array {
  const tag = encodeTag(fieldNumber, 0);
  const val = encodeVarint(value);
  const result = new Uint8Array(tag.length + val.length);
  result.set(tag, 0);
  result.set(val, tag.length);
  return result;
}

function encodeMessage(fieldNumber: number, content: Uint8Array): Uint8Array {
  const tag = encodeTag(fieldNumber, 2);
  const len = encodeVarint(content.length);
  const result = new Uint8Array(tag.length + len.length + content.length);
  result.set(tag, 0);
  result.set(len, tag.length);
  result.set(content, tag.length + len.length);
  return result;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

function encodeStreamingS2SRequest(
  s2sId: string,
  participantId: string,
  language: string,
  sampleRate: number,
  meetingId: string,
): Uint8Array {
  // ParticipantConfig: field1=participant_id, field2=language
  const participantConfig = concat(
    encodeString(1, participantId),
    encodeString(2, language),
  );

  // S2SConfig: field1=s2s_id, field2=participant_configs(repeated), field3=sample_rate,
  //            field4=audio_format(OPUS=2), field6=transport_mode(MOQ=1), field7=meeting_id
  const s2sConfig = concat(
    encodeString(1, s2sId),
    encodeMessage(2, participantConfig),
    encodeVarintField(3, sampleRate),
    encodeVarintField(4, 2), // AUDIO_FORMAT_OPUS
    encodeVarintField(6, 1), // TRANSPORT_MODE_MOQ
    encodeString(7, meetingId),
  );

  // StreamingS2SRequest: field1=streaming_config (oneof streaming_request)
  return encodeMessage(1, s2sConfig);
}

function decodeStreamingS2SResponse(data: Uint8Array): MOQSessionInfo | null {
  // StreamingS2SResponse → field3 (event) → S2SEvent → field4 (moq_session_info) → MOQSessionInfo
  const response = decodeFields(data);
  const eventFields = response.get(3);
  if (!eventFields || eventFields.length === 0) return null;

  const event = decodeFields(eventFields[0]);
  const moqInfoFields = event.get(4);
  if (!moqInfoFields || moqInfoFields.length === 0) return null;

  const moqInfo = decodeFields(moqInfoFields[0]);

  const relayUrl = decodeStringField(moqInfo, 1) ?? '';
  const namespacePrefixParts = decodeRepeatedStringField(moqInfo, 2);
  const app = namespacePrefixParts.length > 0 ? namespacePrefixParts[0] : 'ezdubs';
  const sessionId = decodeStringField(moqInfo, 3) ?? '';
  const transport = decodeStringField(moqInfo, 4) ?? '';
  const endpointId = decodeStringField(moqInfo, 5) ?? '';

  return { relayUrl, app, sessionId, transport, endpointId };
}

type FieldMap = Map<number, Uint8Array>;
type RepeatedFieldMap = Map<number, Uint8Array[]>;

function decodeFields(data: Uint8Array): RepeatedFieldMap {
  const fields: RepeatedFieldMap = new Map();
  let offset = 0;

  while (offset < data.length) {
    const [tag, newOffset] = readVarint(data, offset);
    offset = newOffset;
    const fieldNumber = tag >> 3;
    const wireType = tag & 0x07;

    let value: Uint8Array;
    if (wireType === 0) {
      // Varint
      const [val, nextOffset] = readVarint(data, offset);
      offset = nextOffset;
      // Store varint as a simple byte representation
      value = encodeVarint(val);
    } else if (wireType === 2) {
      // Length-delimited
      const [len, lenOffset] = readVarint(data, offset);
      offset = lenOffset;
      value = data.slice(offset, offset + len);
      offset += len;
    } else {
      break; // Unsupported wire type
    }

    if (!fields.has(fieldNumber)) {
      fields.set(fieldNumber, []);
    }
    fields.get(fieldNumber)!.push(value);
  }

  return fields;
}

function readVarint(data: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  while (offset < data.length) {
    const byte = data[offset++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result >>> 0, offset];
}

function decodeStringField(fields: RepeatedFieldMap, fieldNumber: number): string | undefined {
  const values = fields.get(fieldNumber);
  if (!values || values.length === 0) return undefined;
  return new TextDecoder().decode(values[0]);
}

function decodeRepeatedStringField(fields: RepeatedFieldMap, fieldNumber: number): string[] {
  const values = fields.get(fieldNumber);
  if (!values) return [];
  return values.map(v => new TextDecoder().decode(v));
}
