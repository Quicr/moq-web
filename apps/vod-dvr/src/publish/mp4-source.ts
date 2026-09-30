// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * MP4 → encoded AVC sample stream via MP4Box.js.
 *
 * Accepts a File (from an <input type="file">) or a URL. Emits one
 * {@link Mp4Sample} per video sample in decode order along with an
 * `avcC` config record (SPS/PPS) parsed from the file's stsd entry — the
 * viewer's WebCodecs decoder needs that for `description`.
 *
 * Only the video track is exposed. Audio is dropped for the first cut.
 */

import MP4Box, { type MP4BoxFile, type MP4BoxInfo, type MP4BoxSample } from 'mp4box';

export interface Mp4Sample {
  /** Sample decode order index (0-based, monotonically increasing). */
  index: number;
  /** Encoded H.264 payload in AVCC (length-prefixed NAL units). */
  data: Uint8Array;
  /** Presentation timestamp in milliseconds. */
  ptsMs: number;
  /** Sample duration in milliseconds (may be 0 for the last sample). */
  durationMs: number;
  /** True if this sample is a keyframe (SPS boundary). */
  isKeyframe: boolean;
}

export interface Mp4TrackInfo {
  /** WebCodecs codec string (e.g. `avc1.42E01E`). */
  codec: string;
  width: number;
  height: number;
  /** Timescale in units-per-second. */
  timescale: number;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Number of video samples in the track. */
  sampleCount: number;
  /** avcC decoder configuration record (SPS/PPS bundle). */
  description: Uint8Array;
}

export interface Mp4Source {
  /** Track metadata; available once `open()` resolves. */
  info: Mp4TrackInfo;
  /** Async iterator of samples in decode order. */
  samples: () => AsyncIterable<Mp4Sample>;
  /** Aborts pending reads and releases MP4Box state. */
  close: () => void;
}

const CHUNK_SIZE = 1 << 20; // 1 MiB

/**
 * Build the AVCDecoderConfigurationRecord bytes from the parsed SPS/PPS lists
 * MP4Box exposes on the stsd entry. Format per ISO/IEC 14496-15 §5.3.3.1.2.
 */
function buildAvcC(
  sps: Array<{ nalu: Uint8Array; length: number }>,
  pps: Array<{ nalu: Uint8Array; length: number }>,
): Uint8Array {
  if (sps.length === 0 || pps.length === 0) {
    throw new Error('MP4 track missing SPS or PPS');
  }
  const spsNalu = sps[0].nalu;
  // AVCProfileIndication / profile_compatibility / AVCLevelIndication live at
  // bytes 1..3 of the SPS RBSP (after the 1-byte NAL header).
  const profile = spsNalu[1];
  const compat = spsNalu[2];
  const level = spsNalu[3];

  const spsBlob = new Uint8Array(2 + sps[0].length);
  new DataView(spsBlob.buffer).setUint16(0, sps[0].length);
  spsBlob.set(spsNalu, 2);
  const ppsBlob = new Uint8Array(2 + pps[0].length);
  new DataView(ppsBlob.buffer).setUint16(0, pps[0].length);
  ppsBlob.set(pps[0].nalu, 2);

  const header = new Uint8Array([
    0x01,           // configurationVersion
    profile,        // AVCProfileIndication
    compat,         // profile_compatibility
    level,          // AVCLevelIndication
    0xff,           // reserved(6) + lengthSizeMinusOne(2)=3 (4-byte NAL length)
    0xe1,           // reserved(3) + numOfSequenceParameterSets(5)=1
  ]);

  const numPps = new Uint8Array([0x01]);
  const out = new Uint8Array(
    header.length + spsBlob.length + numPps.length + ppsBlob.length,
  );
  let off = 0;
  out.set(header, off); off += header.length;
  out.set(spsBlob, off); off += spsBlob.length;
  out.set(numPps, off); off += numPps.length;
  out.set(ppsBlob, off);
  return out;
}

function codecStringFromAvcC(avcC: Uint8Array): string {
  // avcC bytes: 0=version, 1=profile, 2=compat, 3=level.
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `avc1.${hex(avcC[1])}${hex(avcC[2])}${hex(avcC[3])}`;
}

async function readStream(
  file: File | ReadableStream<Uint8Array>,
  onChunk: (buf: ArrayBuffer & { fileStart: number }, done: boolean) => void,
): Promise<void> {
  if (file instanceof File) {
    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(offset + CHUNK_SIZE, file.size);
      const slice = await file.slice(offset, end).arrayBuffer();
      const tagged = slice as ArrayBuffer & { fileStart: number };
      tagged.fileStart = offset;
      onChunk(tagged, end === file.size);
      offset = end;
    }
    return;
  }
  const reader = file.getReader();
  let offset = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      // MP4Box needs a flush hint via a zero-length buffer with the final
      // fileStart to know sample extraction can finalise.
      onChunk(
        Object.assign(new ArrayBuffer(0), { fileStart: offset }),
        true,
      );
      return;
    }
    const buf = value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    ) as ArrayBuffer & { fileStart: number };
    buf.fileStart = offset;
    onChunk(buf, false);
    offset += value.byteLength;
  }
}

/**
 * Open an MP4 file for streaming demux. Resolves once the moov box has been
 * parsed and `info` is populated; samples flow via {@link Mp4Source.samples}.
 */
export async function openMp4Source(
  input: File | { url: string; signal?: AbortSignal },
): Promise<Mp4Source> {
  const mp4: MP4BoxFile = MP4Box.createFile();
  let aborted = false;
  let feedError: Error | null = null;

  const infoP = new Promise<MP4BoxInfo>((resolve, reject) => {
    mp4.onReady = (info) => resolve(info);
    mp4.onError = (err) => reject(new Error(err));
  });

  // Buffered samples between MP4Box callback and the consumer iterator.
  const buffered: Mp4Sample[] = [];
  let resolveNext: (() => void) | null = null;
  let finished = false;
  const wake = () => {
    const r = resolveNext;
    resolveNext = null;
    if (r) r();
  };

  const feed = async () => {
    try {
      if (input instanceof File) {
        await readStream(input, (buf, done) => {
          mp4.appendBuffer(buf);
          if (done) mp4.flush();
        });
      } else {
        const resp = await fetch(input.url, { signal: input.signal });
        if (!resp.ok || !resp.body) {
          throw new Error(`Fetch ${input.url} failed: ${resp.status}`);
        }
        await readStream(resp.body, (buf, done) => {
          if (aborted) return;
          if (buf.byteLength > 0) mp4.appendBuffer(buf);
          if (done) mp4.flush();
        });
      }
    } catch (err) {
      feedError = err instanceof Error ? err : new Error(String(err));
    } finally {
      finished = true;
      wake();
    }
  };

  // Kick off the feed so onReady can fire.
  const feedDone = feed();

  const info = await infoP;
  const track = info.videoTracks[0];
  if (!track) throw new Error('MP4 has no video track');

  const trak = mp4.getTrackById(track.id);
  const stsdEntry = trak.mdia.minf.stbl.stsd.entries[0];
  if (!stsdEntry?.avcC) {
    throw new Error(`Unsupported video codec (need AVC): ${track.codec}`);
  }
  const avcC = buildAvcC(stsdEntry.avcC.SPS, stsdEntry.avcC.PPS);
  const durationMs = (info.duration / info.timescale) * 1000;

  const trackInfo: Mp4TrackInfo = {
    codec: codecStringFromAvcC(avcC) || track.codec,
    width: track.video.width,
    height: track.video.height,
    timescale: track.timescale,
    durationMs,
    sampleCount: track.nb_samples,
    description: avcC,
  };

  let sampleIndex = 0;
  mp4.setExtractionOptions(track.id, null, { nbSamples: 32, rapAlignement: true });
  mp4.onSamples = (_id, _user, samples: MP4BoxSample[]) => {
    for (const s of samples) {
      buffered.push({
        index: sampleIndex++,
        data: s.data,
        ptsMs: (s.cts / s.timescale) * 1000,
        durationMs: (s.duration / s.timescale) * 1000,
        isKeyframe: s.is_sync,
      });
    }
    wake();
  };
  mp4.start();

  return {
    info: trackInfo,
    samples: async function* () {
      try {
        while (true) {
          if (buffered.length > 0) {
            yield buffered.shift()!;
            continue;
          }
          if (feedError) throw feedError;
          if (finished) return;
          await new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
        }
      } finally {
        aborted = true;
      }
    },
    close: () => {
      aborted = true;
      wake();
      mp4.stop();
      void feedDone;
    },
  };
}
