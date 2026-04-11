// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MP4 Parser for VOD Streaming
 *
 * Parses MP4/MOV containers to extract:
 * - Codec information (is it H.264?)
 * - Sample table (frame offsets, sizes, keyframes)
 * - Allows direct extraction of encoded NAL units without re-encoding
 */

import { Logger } from '@web-moq/core';

const log = Logger.create('moqt:media:mp4-parser');

/**
 * MP4 Box header
 */
interface BoxHeader {
  size: number;
  type: string;
  headerSize: number;
}

/**
 * Sample entry from the sample table
 */
export interface SampleEntry {
  /** Offset in file */
  offset: number;
  /** Size in bytes */
  size: number;
  /** Decode timestamp (in timescale units) */
  dts: number;
  /** Composition time offset */
  ctOffset: number;
  /** Duration (in timescale units) */
  duration: number;
  /** Is this a sync sample (keyframe)? */
  isKeyframe: boolean;
}

/**
 * Video track information
 */
export interface VideoTrackInfo {
  /** Track ID */
  trackId: number;
  /** Codec string (e.g., 'avc1.64001f') */
  codec: string;
  /** Is H.264/AVC? */
  isH264: boolean;
  /** Width in pixels */
  width: number;
  /** Height in pixels */
  height: number;
  /** Timescale (units per second) */
  timescale: number;
  /** Duration in timescale units */
  duration: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** AVC decoder config (SPS/PPS) */
  avcConfig?: Uint8Array;
  /** NAL unit length size (1, 2, or 4 bytes) */
  nalLengthSize: number;
  /** Sample entries */
  samples: SampleEntry[];
}

/**
 * MP4 Parser Result
 */
export interface MP4ParseResult {
  /** Video track info (if found) */
  videoTrack?: VideoTrackInfo;
  /** Whether we can remux (H.264 source) */
  canRemux: boolean;
  /** Reason if we can't remux */
  remuxReason?: string;
}

/**
 * MP4 Parser
 *
 * Parses MP4/MOV files to extract video track information and sample tables.
 * Enables direct NAL unit extraction for H.264 sources (no re-encoding needed).
 */
export class MP4Parser {
  private data: Uint8Array;
  private view: DataView;

  constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  /**
   * Parse the MP4 file
   */
  parse(): MP4ParseResult {
    log.info('Parsing MP4 file', { size: this.data.length });

    try {
      const videoTrack = this.findVideoTrack();

      if (!videoTrack) {
        return {
          canRemux: false,
          remuxReason: 'No video track found',
        };
      }

      if (!videoTrack.isH264) {
        return {
          videoTrack,
          canRemux: false,
          remuxReason: `Codec ${videoTrack.codec} is not H.264, re-encoding required`,
        };
      }

      if (!videoTrack.avcConfig) {
        return {
          videoTrack,
          canRemux: false,
          remuxReason: 'No AVC decoder config found',
        };
      }

      log.info('MP4 parsed successfully', {
        codec: videoTrack.codec,
        resolution: `${videoTrack.width}x${videoTrack.height}`,
        duration: `${(videoTrack.durationMs / 1000).toFixed(1)}s`,
        samples: videoTrack.samples.length,
        keyframes: videoTrack.samples.filter(s => s.isKeyframe).length,
      });

      return {
        videoTrack,
        canRemux: true,
      };
    } catch (err) {
      log.error('Failed to parse MP4', { error: (err as Error).message });
      return {
        canRemux: false,
        remuxReason: `Parse error: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Find and parse the video track
   */
  private findVideoTrack(): VideoTrackInfo | undefined {
    // Find moov box
    const moov = this.findBox(0, this.data.length, 'moov');
    if (!moov) {
      throw new Error('No moov box found');
    }

    // Find trak boxes within moov
    let offset = moov.offset + moov.headerSize;
    const moovEnd = moov.offset + moov.size;

    while (offset < moovEnd) {
      const box = this.readBoxHeader(offset);
      if (!box) break;

      if (box.type === 'trak') {
        const track = this.parseTrack(offset, box.size);
        if (track && track.codec) {
          return track;
        }
      }

      offset += box.size;
    }

    return undefined;
  }

  /**
   * Parse a trak box
   */
  private parseTrack(trakOffset: number, trakSize: number): VideoTrackInfo | undefined {
    const trakEnd = trakOffset + trakSize;
    const trakHeader = this.readBoxHeader(trakOffset);
    if (!trakHeader) return undefined;

    let offset = trakOffset + trakHeader.headerSize;

    let trackId = 0;
    let timescale = 0;
    let duration = 0;
    let width = 0;
    let height = 0;
    let codec = '';
    let isH264 = false;
    let avcConfig: Uint8Array | undefined;
    let nalLengthSize = 4;

    // Sample table data
    let sampleSizes: number[] = [];
    let chunkOffsets: number[] = [];
    let samplesPerChunk: Array<{ firstChunk: number; samplesPerChunk: number; sampleDescIdx: number }> = [];
    let syncSamples: Set<number> = new Set();
    let sampleDurations: Array<{ count: number; delta: number }> = [];
    let compositionOffsets: Array<{ count: number; offset: number }> = [];

    while (offset < trakEnd) {
      const box = this.readBoxHeader(offset);
      if (!box) break;

      if (box.type === 'tkhd') {
        // Track header - get track ID and dimensions
        const version = this.data[offset + 8];
        const tkhdOffset = offset + 8 + (version === 1 ? 20 : 12);
        trackId = this.view.getUint32(tkhdOffset, false);
        // Width and height are at end, as 16.16 fixed point
        const whOffset = offset + box.size - 8;
        width = this.view.getUint32(whOffset, false) >> 16;
        height = this.view.getUint32(whOffset + 4, false) >> 16;
      } else if (box.type === 'mdia') {
        // Media box - contains mdhd and minf
        let mdiaOffset = offset + box.headerSize;
        const mdiaEnd = offset + box.size;

        while (mdiaOffset < mdiaEnd) {
          const mdiaBox = this.readBoxHeader(mdiaOffset);
          if (!mdiaBox) break;

          if (mdiaBox.type === 'mdhd') {
            // Media header - get timescale and duration
            const version = this.data[mdiaOffset + 8];
            if (version === 1) {
              timescale = this.view.getUint32(mdiaOffset + 28, false);
              duration = Number(this.view.getBigUint64(mdiaOffset + 32, false));
            } else {
              timescale = this.view.getUint32(mdiaOffset + 20, false);
              duration = this.view.getUint32(mdiaOffset + 24, false);
            }
          } else if (mdiaBox.type === 'hdlr') {
            // Handler - check if this is video
            const handlerType = this.readString(mdiaOffset + 16, 4);
            if (handlerType !== 'vide') {
              return undefined; // Not a video track
            }
          } else if (mdiaBox.type === 'minf') {
            // Media info - contains stbl
            let minfOffset = mdiaOffset + mdiaBox.headerSize;
            const minfEnd = mdiaOffset + mdiaBox.size;

            while (minfOffset < minfEnd) {
              const minfBox = this.readBoxHeader(minfOffset);
              if (!minfBox) break;

              if (minfBox.type === 'stbl') {
                // Sample table
                let stblOffset = minfOffset + minfBox.headerSize;
                const stblEnd = minfOffset + minfBox.size;

                while (stblOffset < stblEnd) {
                  const stblBox = this.readBoxHeader(stblOffset);
                  if (!stblBox) break;

                  if (stblBox.type === 'stsd') {
                    // Sample description - get codec info
                    const result = this.parseStsd(stblOffset, stblBox.size);
                    codec = result.codec;
                    isH264 = result.isH264;
                    avcConfig = result.avcConfig;
                    nalLengthSize = result.nalLengthSize;
                    if (result.width) width = result.width;
                    if (result.height) height = result.height;
                  } else if (stblBox.type === 'stsz' || stblBox.type === 'stz2') {
                    // Sample sizes
                    sampleSizes = this.parseStsz(stblOffset, stblBox.size);
                  } else if (stblBox.type === 'stco') {
                    // Chunk offsets (32-bit)
                    chunkOffsets = this.parseStco(stblOffset, stblBox.size, false);
                  } else if (stblBox.type === 'co64') {
                    // Chunk offsets (64-bit)
                    chunkOffsets = this.parseStco(stblOffset, stblBox.size, true);
                  } else if (stblBox.type === 'stsc') {
                    // Sample-to-chunk
                    samplesPerChunk = this.parseStsc(stblOffset, stblBox.size);
                  } else if (stblBox.type === 'stss') {
                    // Sync samples (keyframes)
                    syncSamples = this.parseStss(stblOffset, stblBox.size);
                  } else if (stblBox.type === 'stts') {
                    // Time-to-sample (durations)
                    sampleDurations = this.parseStts(stblOffset, stblBox.size);
                  } else if (stblBox.type === 'ctts') {
                    // Composition time offsets
                    compositionOffsets = this.parseCtts(stblOffset, stblBox.size);
                  }

                  stblOffset += stblBox.size;
                }
              }

              minfOffset += minfBox.size;
            }
          }

          mdiaOffset += mdiaBox.size;
        }
      }

      offset += box.size;
    }

    if (!codec) {
      return undefined;
    }

    // Build sample table
    const samples = this.buildSampleTable(
      sampleSizes,
      chunkOffsets,
      samplesPerChunk,
      syncSamples,
      sampleDurations,
      compositionOffsets
    );

    return {
      trackId,
      codec,
      isH264,
      width,
      height,
      timescale,
      duration,
      durationMs: (duration / timescale) * 1000,
      avcConfig,
      nalLengthSize,
      samples,
    };
  }

  /**
   * Parse stsd (sample description) box
   */
  private parseStsd(offset: number, _size: number): {
    codec: string;
    isH264: boolean;
    avcConfig?: Uint8Array;
    nalLengthSize: number;
    width?: number;
    height?: number;
  } {
    const entryCount = this.view.getUint32(offset + 12, false);
    if (entryCount === 0) {
      return { codec: '', isH264: false, nalLengthSize: 4 };
    }

    // First entry starts at offset + 16
    let entryOffset = offset + 16;
    const entrySize = this.view.getUint32(entryOffset, false);
    const entryType = this.readString(entryOffset + 4, 4);

    // Check for H.264 (avc1, avc3) or HEVC (hvc1, hev1)
    const isH264 = entryType === 'avc1' || entryType === 'avc3';

    // Visual sample entry: 78 bytes of fixed fields
    // Width at offset 24, height at offset 26 (from entry start + 8)
    const width = this.view.getUint16(entryOffset + 32, false);
    const height = this.view.getUint16(entryOffset + 34, false);

    let codec = entryType;
    let avcConfig: Uint8Array | undefined;
    let nalLengthSize = 4;

    if (isH264) {
      // Find avcC box within the entry
      let subOffset = entryOffset + 86; // After visual sample entry fixed fields
      const entryEnd = entryOffset + entrySize;

      while (subOffset < entryEnd) {
        const subBox = this.readBoxHeader(subOffset);
        if (!subBox) break;

        if (subBox.type === 'avcC') {
          // Parse AVC decoder config
          const configStart = subOffset + 8;
          // configVersion at configStart (unused but documented)
          const profileIdc = this.data[configStart + 1];
          const profileCompat = this.data[configStart + 2];
          const levelIdc = this.data[configStart + 3];

          // Build codec string: avc1.PPCCLL
          codec = `avc1.${profileIdc.toString(16).padStart(2, '0')}${profileCompat.toString(16).padStart(2, '0')}${levelIdc.toString(16).padStart(2, '0')}`;

          // NAL length size is (value & 0x03) + 1
          nalLengthSize = (this.data[configStart + 4] & 0x03) + 1;

          // Store the entire avcC contents for decoder config
          avcConfig = this.data.slice(configStart, subOffset + subBox.size);
          break;
        }

        subOffset += subBox.size;
      }
    }

    return { codec, isH264, avcConfig, nalLengthSize, width, height };
  }

  /**
   * Parse stsz (sample sizes) box
   */
  private parseStsz(offset: number, _size: number): number[] {
    const sampleSize = this.view.getUint32(offset + 12, false);
    const sampleCount = this.view.getUint32(offset + 16, false);

    const sizes: number[] = [];

    if (sampleSize !== 0) {
      // All samples have the same size
      for (let i = 0; i < sampleCount; i++) {
        sizes.push(sampleSize);
      }
    } else {
      // Variable sizes
      let tableOffset = offset + 20;
      for (let i = 0; i < sampleCount; i++) {
        sizes.push(this.view.getUint32(tableOffset, false));
        tableOffset += 4;
      }
    }

    return sizes;
  }

  /**
   * Parse stco/co64 (chunk offsets) box
   */
  private parseStco(offset: number, _size: number, is64bit: boolean): number[] {
    const entryCount = this.view.getUint32(offset + 12, false);
    const offsets: number[] = [];

    let tableOffset = offset + 16;
    for (let i = 0; i < entryCount; i++) {
      if (is64bit) {
        offsets.push(Number(this.view.getBigUint64(tableOffset, false)));
        tableOffset += 8;
      } else {
        offsets.push(this.view.getUint32(tableOffset, false));
        tableOffset += 4;
      }
    }

    return offsets;
  }

  /**
   * Parse stsc (sample-to-chunk) box
   */
  private parseStsc(offset: number, _size: number): Array<{ firstChunk: number; samplesPerChunk: number; sampleDescIdx: number }> {
    const entryCount = this.view.getUint32(offset + 12, false);
    const entries: Array<{ firstChunk: number; samplesPerChunk: number; sampleDescIdx: number }> = [];

    let tableOffset = offset + 16;
    for (let i = 0; i < entryCount; i++) {
      entries.push({
        firstChunk: this.view.getUint32(tableOffset, false),
        samplesPerChunk: this.view.getUint32(tableOffset + 4, false),
        sampleDescIdx: this.view.getUint32(tableOffset + 8, false),
      });
      tableOffset += 12;
    }

    return entries;
  }

  /**
   * Parse stss (sync samples) box
   */
  private parseStss(offset: number, _size: number): Set<number> {
    const entryCount = this.view.getUint32(offset + 12, false);
    const syncSamples = new Set<number>();

    let tableOffset = offset + 16;
    for (let i = 0; i < entryCount; i++) {
      syncSamples.add(this.view.getUint32(tableOffset, false));
      tableOffset += 4;
    }

    return syncSamples;
  }

  /**
   * Parse stts (time-to-sample) box
   */
  private parseStts(offset: number, _size: number): Array<{ count: number; delta: number }> {
    const entryCount = this.view.getUint32(offset + 12, false);
    const entries: Array<{ count: number; delta: number }> = [];

    let tableOffset = offset + 16;
    for (let i = 0; i < entryCount; i++) {
      entries.push({
        count: this.view.getUint32(tableOffset, false),
        delta: this.view.getUint32(tableOffset + 4, false),
      });
      tableOffset += 8;
    }

    return entries;
  }

  /**
   * Parse ctts (composition time offsets) box
   */
  private parseCtts(offset: number, _size: number): Array<{ count: number; offset: number }> {
    const version = this.data[offset + 8];
    const entryCount = this.view.getUint32(offset + 12, false);
    const entries: Array<{ count: number; offset: number }> = [];

    let tableOffset = offset + 16;
    for (let i = 0; i < entryCount; i++) {
      const count = this.view.getUint32(tableOffset, false);
      // Version 0: unsigned, Version 1: signed
      const ctOffset = version === 0
        ? this.view.getUint32(tableOffset + 4, false)
        : this.view.getInt32(tableOffset + 4, false);
      entries.push({ count, offset: ctOffset });
      tableOffset += 8;
    }

    return entries;
  }

  /**
   * Build the sample table from parsed box data
   */
  private buildSampleTable(
    sampleSizes: number[],
    chunkOffsets: number[],
    samplesPerChunk: Array<{ firstChunk: number; samplesPerChunk: number; sampleDescIdx: number }>,
    syncSamples: Set<number>,
    sampleDurations: Array<{ count: number; delta: number }>,
    compositionOffsets: Array<{ count: number; offset: number }>
  ): SampleEntry[] {
    const samples: SampleEntry[] = [];
    const noSyncTable = syncSamples.size === 0; // If no stss, all samples are sync

    // Build sample offsets from chunk offsets and samples-per-chunk
    let sampleIndex = 0;
    let currentChunkSamples = 0;
    let stscIndex = 0;

    for (let chunkIndex = 0; chunkIndex < chunkOffsets.length; chunkIndex++) {
      // Determine samples per chunk for this chunk
      const chunkNum = chunkIndex + 1; // 1-based
      while (stscIndex + 1 < samplesPerChunk.length &&
             samplesPerChunk[stscIndex + 1].firstChunk <= chunkNum) {
        stscIndex++;
      }
      currentChunkSamples = samplesPerChunk[stscIndex]?.samplesPerChunk ?? 1;

      let offsetInChunk = 0;
      for (let i = 0; i < currentChunkSamples && sampleIndex < sampleSizes.length; i++) {
        const size = sampleSizes[sampleIndex];
        const offset = chunkOffsets[chunkIndex] + offsetInChunk;

        samples.push({
          offset,
          size,
          dts: 0, // Will be filled in below
          ctOffset: 0,
          duration: 0,
          isKeyframe: noSyncTable || syncSamples.has(sampleIndex + 1), // stss is 1-based
        });

        offsetInChunk += size;
        sampleIndex++;
      }
    }

    // Fill in DTS from stts
    let dts = 0;
    let sttsIndex = 0;
    let sttsCount = 0;

    for (let i = 0; i < samples.length; i++) {
      samples[i].dts = dts;

      // Get duration for this sample
      while (sttsIndex < sampleDurations.length && sttsCount >= sampleDurations[sttsIndex].count) {
        sttsIndex++;
        sttsCount = 0;
      }

      const duration = sampleDurations[sttsIndex]?.delta ?? 0;
      samples[i].duration = duration;
      dts += duration;
      sttsCount++;
    }

    // Fill in composition time offsets from ctts
    let cttsIndex = 0;
    let cttsCount = 0;

    for (let i = 0; i < samples.length && cttsIndex < compositionOffsets.length; i++) {
      while (cttsIndex < compositionOffsets.length && cttsCount >= compositionOffsets[cttsIndex].count) {
        cttsIndex++;
        cttsCount = 0;
      }

      if (cttsIndex < compositionOffsets.length) {
        samples[i].ctOffset = compositionOffsets[cttsIndex].offset;
        cttsCount++;
      }
    }

    return samples;
  }

  /**
   * Find a box by type
   */
  private findBox(start: number, end: number, type: string): { offset: number; size: number; headerSize: number } | undefined {
    let offset = start;

    while (offset < end) {
      const box = this.readBoxHeader(offset);
      if (!box) break;

      if (box.type === type) {
        return { offset, size: box.size, headerSize: box.headerSize };
      }

      offset += box.size;
    }

    return undefined;
  }

  /**
   * Read a box header at the given offset
   */
  private readBoxHeader(offset: number): BoxHeader | undefined {
    if (offset + 8 > this.data.length) {
      return undefined;
    }

    let size = this.view.getUint32(offset, false);
    const type = this.readString(offset + 4, 4);
    let headerSize = 8;

    if (size === 1) {
      // Extended size (64-bit)
      if (offset + 16 > this.data.length) {
        return undefined;
      }
      size = Number(this.view.getBigUint64(offset + 8, false));
      headerSize = 16;
    } else if (size === 0) {
      // Box extends to end of file
      size = this.data.length - offset;
    }

    return { size, type, headerSize };
  }

  /**
   * Read a string from the buffer
   */
  private readString(offset: number, length: number): string {
    let str = '';
    for (let i = 0; i < length; i++) {
      str += String.fromCharCode(this.data[offset + i]);
    }
    return str;
  }

  /**
   * Extract a sample's raw data (length-prefixed NAL units, avc format)
   * This is the format expected by WebCodecs when avcC description is provided
   */
  extractSampleRaw(sample: SampleEntry): Uint8Array {
    return this.data.slice(sample.offset, sample.offset + sample.size);
  }

  /**
   * Extract a sample's NAL units from the file
   * Converts from length-prefixed to Annex B format
   */
  extractSampleAsAnnexB(sample: SampleEntry, nalLengthSize: number): Uint8Array {
    const sampleData = this.data.slice(sample.offset, sample.offset + sample.size);

    // Convert length-prefixed NAL units to Annex B format
    const nalUnits: Uint8Array[] = [];
    const startCode = new Uint8Array([0, 0, 0, 1]);
    let offset = 0;

    while (offset < sampleData.length) {
      // Read NAL unit length
      let nalLength = 0;
      for (let i = 0; i < nalLengthSize; i++) {
        nalLength = (nalLength << 8) | sampleData[offset + i];
      }
      offset += nalLengthSize;

      if (offset + nalLength > sampleData.length) {
        log.warn('NAL unit extends beyond sample', { nalLength, remaining: sampleData.length - offset });
        break;
      }

      // Extract NAL unit
      const nalUnit = sampleData.slice(offset, offset + nalLength);
      nalUnits.push(startCode);
      nalUnits.push(nalUnit);
      offset += nalLength;
    }

    // Combine all NAL units
    const totalLength = nalUnits.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let resultOffset = 0;
    for (const unit of nalUnits) {
      result.set(unit, resultOffset);
      resultOffset += unit.length;
    }

    return result;
  }

  /**
   * Convert avcC config to Annex B format (SPS/PPS with start codes)
   */
  extractAvcConfigAsAnnexB(avcConfig: Uint8Array): Uint8Array {
    const startCode = new Uint8Array([0, 0, 0, 1]);
    const nalUnits: Uint8Array[] = [];

    // avcC format:
    // 1 byte version
    // 1 byte profile
    // 1 byte profile compat
    // 1 byte level
    // 1 byte NAL length size - 1 (6 bits reserved + 2 bits)
    // 1 byte num SPS (3 bits reserved + 5 bits)
    // For each SPS: 2 bytes length, then SPS data
    // 1 byte num PPS
    // For each PPS: 2 bytes length, then PPS data

    let offset = 5;

    // SPS
    const numSps = avcConfig[offset] & 0x1f;
    offset++;

    for (let i = 0; i < numSps; i++) {
      const spsLength = (avcConfig[offset] << 8) | avcConfig[offset + 1];
      offset += 2;
      nalUnits.push(startCode);
      nalUnits.push(avcConfig.slice(offset, offset + spsLength));
      offset += spsLength;
    }

    // PPS
    const numPps = avcConfig[offset];
    offset++;

    for (let i = 0; i < numPps; i++) {
      const ppsLength = (avcConfig[offset] << 8) | avcConfig[offset + 1];
      offset += 2;
      nalUnits.push(startCode);
      nalUnits.push(avcConfig.slice(offset, offset + ppsLength));
      offset += ppsLength;
    }

    // Combine
    const totalLength = nalUnits.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let resultOffset = 0;
    for (const unit of nalUnits) {
      result.set(unit, resultOffset);
      resultOffset += unit.length;
    }

    return result;
  }
}
