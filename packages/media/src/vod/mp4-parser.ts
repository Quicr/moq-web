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
 * Audio track information
 */
export interface AudioTrackInfo {
  /** Track ID */
  trackId: number;
  /** Codec string (e.g., 'mp4a.40.2' for AAC-LC) */
  codec: string;
  /** Is AAC? */
  isAAC: boolean;
  /** Sample rate in Hz (e.g., 48000, 44100) */
  sampleRate: number;
  /** Number of channels (1=mono, 2=stereo) */
  channelCount: number;
  /** Timescale (units per second) */
  timescale: number;
  /** Duration in timescale units */
  duration: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** AAC decoder config (AudioSpecificConfig from esds) */
  aacConfig?: Uint8Array;
  /** Sample entries */
  samples: SampleEntry[];
}

/**
 * MP4 Parser Result
 */
export interface MP4ParseResult {
  /** Video track info (if found) */
  videoTrack?: VideoTrackInfo;
  /** Audio track info (if found) */
  audioTrack?: AudioTrackInfo;
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
      const { videoTrack, audioTrack } = this.findTracks();

      if (!videoTrack) {
        return {
          audioTrack,
          canRemux: false,
          remuxReason: 'No video track found',
        };
      }

      if (!videoTrack.isH264) {
        return {
          videoTrack,
          audioTrack,
          canRemux: false,
          remuxReason: `Codec ${videoTrack.codec} is not H.264, re-encoding required`,
        };
      }

      if (!videoTrack.avcConfig) {
        return {
          videoTrack,
          audioTrack,
          canRemux: false,
          remuxReason: 'No AVC decoder config found',
        };
      }

      log.info('MP4 parsed successfully', {
        videoCodec: videoTrack.codec,
        resolution: `${videoTrack.width}x${videoTrack.height}`,
        duration: `${(videoTrack.durationMs / 1000).toFixed(1)}s`,
        videoSamples: videoTrack.samples.length,
        keyframes: videoTrack.samples.filter(s => s.isKeyframe).length,
        hasAudio: !!audioTrack,
        audioCodec: audioTrack?.codec,
        audioSamples: audioTrack?.samples.length,
      });

      return {
        videoTrack,
        audioTrack,
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
   * Find and parse all tracks (video and audio)
   */
  private findTracks(): { videoTrack?: VideoTrackInfo; audioTrack?: AudioTrackInfo } {
    // Find moov box
    const moov = this.findBox(0, this.data.length, 'moov');
    if (!moov) {
      throw new Error('No moov box found');
    }

    let videoTrack: VideoTrackInfo | undefined;
    let audioTrack: AudioTrackInfo | undefined;

    // Find trak boxes within moov
    let offset = moov.offset + moov.headerSize;
    const moovEnd = moov.offset + moov.size;

    while (offset < moovEnd) {
      const box = this.readBoxHeader(offset);
      if (!box) break;

      if (box.type === 'trak') {
        const result = this.parseTrack(offset, box.size);
        if (result) {
          if (result.type === 'video' && result.video) {
            videoTrack = result.video;
          } else if (result.type === 'audio' && result.audio) {
            audioTrack = result.audio;
          }
        }
      }

      offset += box.size;
    }

    return { videoTrack, audioTrack };
  }

  /**
   * Track parsing result
   */
  private parseTrack(trakOffset: number, trakSize: number): { type: 'video'; video: VideoTrackInfo } | { type: 'audio'; audio: AudioTrackInfo } | undefined {
    const trakEnd = trakOffset + trakSize;
    const trakHeader = this.readBoxHeader(trakOffset);
    if (!trakHeader) return undefined;

    let offset = trakOffset + trakHeader.headerSize;

    let trackId = 0;
    let timescale = 0;
    let duration = 0;
    let width = 0;
    let height = 0;
    let handlerType = '';

    // Video-specific
    let videoCodec = '';
    let isH264 = false;
    let avcConfig: Uint8Array | undefined;
    let nalLengthSize = 4;

    // Audio-specific
    let audioCodec = '';
    let isAAC = false;
    let sampleRate = 0;
    let channelCount = 0;
    let aacConfig: Uint8Array | undefined;

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
            // Handler - identify track type (vide or soun)
            handlerType = this.readString(mdiaOffset + 16, 4);
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
                    if (handlerType === 'vide') {
                      const result = this.parseVideoStsd(stblOffset, stblBox.size);
                      videoCodec = result.codec;
                      isH264 = result.isH264;
                      avcConfig = result.avcConfig;
                      nalLengthSize = result.nalLengthSize;
                      if (result.width) width = result.width;
                      if (result.height) height = result.height;
                    } else if (handlerType === 'soun') {
                      const result = this.parseAudioStsd(stblOffset, stblBox.size);
                      audioCodec = result.codec;
                      isAAC = result.isAAC;
                      sampleRate = result.sampleRate;
                      channelCount = result.channelCount;
                      aacConfig = result.aacConfig;
                    }
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

    // Build sample table
    const samples = this.buildSampleTable(
      sampleSizes,
      chunkOffsets,
      samplesPerChunk,
      syncSamples,
      sampleDurations,
      compositionOffsets
    );

    // Return video track
    if (handlerType === 'vide' && videoCodec) {
      return {
        type: 'video',
        video: {
          trackId,
          codec: videoCodec,
          isH264,
          width,
          height,
          timescale,
          duration,
          durationMs: (duration / timescale) * 1000,
          avcConfig,
          nalLengthSize,
          samples,
        },
      };
    }

    // Return audio track
    if (handlerType === 'soun' && audioCodec) {
      return {
        type: 'audio',
        audio: {
          trackId,
          codec: audioCodec,
          isAAC,
          sampleRate,
          channelCount,
          timescale,
          duration,
          durationMs: (duration / timescale) * 1000,
          aacConfig,
          samples,
        },
      };
    }

    return undefined;
  }

  /**
   * Parse stsd (sample description) box for video
   */
  private parseVideoStsd(offset: number, _size: number): {
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
   * Parse stsd (sample description) box for audio
   */
  private parseAudioStsd(offset: number, _size: number): {
    codec: string;
    isAAC: boolean;
    sampleRate: number;
    channelCount: number;
    aacConfig?: Uint8Array;
  } {
    const entryCount = this.view.getUint32(offset + 12, false);
    if (entryCount === 0) {
      return { codec: '', isAAC: false, sampleRate: 0, channelCount: 0 };
    }

    // First entry starts at offset + 16
    const entryOffset = offset + 16;
    const entrySize = this.view.getUint32(entryOffset, false);
    const entryType = this.readString(entryOffset + 4, 4);

    // Check for AAC (mp4a)
    const isAAC = entryType === 'mp4a';

    // Audio sample entry structure (ISO 14496-12):
    // 8 bytes: size + type
    // 6 bytes: reserved
    // 2 bytes: data reference index
    // For mp4a in ISO base media file format (not QuickTime):
    // 8 bytes: reserved (all zeros in ISO, version/revision/vendor in QT)
    // 2 bytes: channel count
    // 2 bytes: sample size
    // 2 bytes: pre_defined (compression ID in QT)
    // 2 bytes: reserved (packet size in QT)
    // 4 bytes: sample rate as 16.16 fixed point

    // Check if this is QuickTime style (version field) or ISO style
    // In ISO format, bytes at offset +16 are reserved (usually 0)
    // In QuickTime, offset +16 is version (0, 1, or 2)
    const possibleVersion = this.view.getUint16(entryOffset + 16, false);

    let channelCount = 0;
    let sampleRate = 0;
    let extendedOffset = 0;

    // ISO 14496-12 style: always at fixed offsets, no version field
    // Channel count at +16+8 = +24, sample rate at +16+16 = +32
    // But first check if there's a non-zero value at the expected sampleRate position
    const sampleRateFixed = this.view.getUint32(entryOffset + 28, false);
    const sampleRateISO = sampleRateFixed >> 16;

    // Also check QuickTime v0/v1 position
    const sampleRateQT = this.view.getUint32(entryOffset + 32, false) >> 16;

    // Debug: log what we find
    console.warn('[MP4Parser] Audio stsd entry:', {
      entryType,
      entrySize,
      possibleVersion,
      channelCountAt24: this.view.getUint16(entryOffset + 24, false),
      sampleRateAt28: sampleRateISO,
      sampleRateAt32: sampleRateQT,
      bytes16to36: Array.from(this.data.slice(entryOffset + 16, entryOffset + 36)).map(b => b.toString(16).padStart(2, '0')).join(' '),
    });

    // Use whichever position has a valid sample rate (> 0 and < 200000)
    if (sampleRateQT > 0 && sampleRateQT < 200000) {
      // QuickTime style at offset +32
      channelCount = this.view.getUint16(entryOffset + 24, false);
      sampleRate = sampleRateQT;
      extendedOffset = entryOffset + 36;

      if (possibleVersion === 1) {
        extendedOffset = entryOffset + 36 + 16;
      } else if (possibleVersion === 2) {
        const sampleRateFloat = this.view.getFloat64(entryOffset + 40, false);
        sampleRate = Math.round(sampleRateFloat);
        channelCount = this.view.getUint32(entryOffset + 48, false);
        extendedOffset = entryOffset + 72;
      }
    } else if (sampleRateISO > 0 && sampleRateISO < 200000) {
      // ISO style at offset +28
      channelCount = this.view.getUint16(entryOffset + 24, false);
      sampleRate = sampleRateISO;
      extendedOffset = entryOffset + 36;
    } else {
      // Fallback: try to find sample rate in AudioSpecificConfig later
      channelCount = this.view.getUint16(entryOffset + 24, false);
      extendedOffset = entryOffset + 36;
    }

    let codec = entryType;
    let aacConfig: Uint8Array | undefined;
    const isAC3 = entryType === 'ac-3' || entryType === 'ec-3';

    // Find codec-specific boxes within the entry
    let subOffset = extendedOffset;
    const entryEnd = entryOffset + entrySize;

    while (subOffset < entryEnd) {
      const subBox = this.readBoxHeader(subOffset);
      if (!subBox) break;

      if (subBox.type === 'esds' && isAAC) {
        // Parse esds to extract AudioSpecificConfig for AAC
        const esdsResult = this.parseEsds(subOffset + 8, subBox.size - 8);
        if (esdsResult.audioSpecificConfig) {
          aacConfig = esdsResult.audioSpecificConfig;
          // Build codec string: mp4a.40.{objectType}
          // ObjectType is in first 5 bits of AudioSpecificConfig
          const objectType = (aacConfig[0] >> 3) & 0x1f;
          codec = `mp4a.40.${objectType}`;
        }
      } else if (subBox.type === 'dac3' && isAC3) {
        // Parse dac3 box for AC-3 sample rate
        // dac3 structure (3 bytes):
        // - 2 bits: fscod (sample rate code)
        // - 5 bits: bsid
        // - 3 bits: bsmod
        // - 3 bits: acmod (channel config)
        // - 1 bit: lfeon
        // - 5 bits: bit_rate_code
        // - 5 bits: reserved
        const dac3Data = this.view.getUint8(subOffset + 8);
        const fscod = (dac3Data >> 6) & 0x03;
        // AC-3 sample rates: 0=48kHz, 1=44.1kHz, 2=32kHz
        const ac3SampleRates = [48000, 44100, 32000];
        if (fscod < 3) {
          sampleRate = ac3SampleRates[fscod];
        }
        codec = 'ac-3';
      } else if (subBox.type === 'dec3' && entryType === 'ec-3') {
        // Parse dec3 box for E-AC-3 (Enhanced AC-3)
        // E-AC-3 is more complex, but we can assume 48kHz for most content
        sampleRate = 48000;
        codec = 'ec-3';
      }

      subOffset += subBox.size;
    }

    return { codec, isAAC, sampleRate, channelCount, aacConfig };
  }

  /**
   * Parse esds box to extract AudioSpecificConfig
   */
  private parseEsds(offset: number, size: number): { audioSpecificConfig?: Uint8Array } {
    // esds structure:
    // 4 bytes: version/flags
    // ES_Descriptor (tag 0x03)
    //   DecoderConfigDescriptor (tag 0x04)
    //     DecoderSpecificInfo (tag 0x05) - contains AudioSpecificConfig

    let pos = offset + 4; // Skip version/flags
    const endPos = offset + size;

    // Find ES_Descriptor (tag 0x03)
    while (pos < endPos) {
      const tag = this.data[pos];
      pos++;

      // Read descriptor length (variable size, up to 4 bytes with high bit continuation)
      let descLen = 0;
      for (let i = 0; i < 4; i++) {
        const b = this.data[pos++];
        descLen = (descLen << 7) | (b & 0x7f);
        if ((b & 0x80) === 0) break;
      }

      if (tag === 0x03) {
        // ES_Descriptor: skip ES_ID (2 bytes) and flags (1 byte)
        pos += 3;
        continue;
      } else if (tag === 0x04) {
        // DecoderConfigDescriptor: skip objectTypeIndication (1), streamType (1),
        // bufferSizeDB (3), maxBitrate (4), avgBitrate (4) = 13 bytes
        pos += 13;
        continue;
      } else if (tag === 0x05) {
        // DecoderSpecificInfo - this is the AudioSpecificConfig
        return { audioSpecificConfig: this.data.slice(pos, pos + descLen) };
      } else {
        // Skip unknown descriptors
        pos += descLen;
      }
    }

    return {};
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
