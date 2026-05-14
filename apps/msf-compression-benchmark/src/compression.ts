export async function compressGzip(data: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const inputBytes = encoder.encode(data);

  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(inputBytes);
  writer.close();

  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

export interface CompressionResult {
  originalSize: number;
  compressedSize: number;
  ratio: number;
  savings: number;
}

export async function benchmark(json: string): Promise<CompressionResult> {
  const encoder = new TextEncoder();
  const originalBytes = encoder.encode(json);
  const originalSize = originalBytes.length;

  const compressed = await compressGzip(json);
  const compressedSize = compressed.length;

  const ratio = compressedSize / originalSize;
  const savings = ((originalSize - compressedSize) / originalSize) * 100;

  return {
    originalSize,
    compressedSize,
    ratio,
    savings,
  };
}
