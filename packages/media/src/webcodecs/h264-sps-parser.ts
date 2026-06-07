// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Minimal H.264 SPS parser
 *
 * Parses the Sequence Parameter Set (SPS) NAL unit from H.264 codec
 * descriptions to extract fields needed for playback configuration,
 * specifically `max_num_reorder_frames` for B-frame reordering.
 *
 * Supports both AVC decoder configuration record (avcC box) and
 * raw Annex-B SPS NAL units.
 */

/**
 * Parsed SPS fields relevant to playback
 */
export interface H264SPSInfo {
  profileIdc: number;
  levelIdc: number;
  maxNumRefFrames: number;
  maxNumReorderFrames: number;
  picWidthInMbs: number;
  picHeightInMapUnits: number;
  frameMbsOnlyFlag: boolean;
}

/**
 * Exponential-Golomb bitstream reader
 */
class BitReader {
  private data: Uint8Array;
  private byteOffset = 0;
  private bitOffset = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  readBit(): number {
    if (this.byteOffset >= this.data.length) return 0;
    const bit = (this.data[this.byteOffset] >> (7 - this.bitOffset)) & 1;
    this.bitOffset++;
    if (this.bitOffset === 8) {
      this.bitOffset = 0;
      this.byteOffset++;
    }
    return bit;
  }

  readBits(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) {
      value = (value << 1) | this.readBit();
    }
    return value;
  }

  /** Read unsigned Exp-Golomb coded value */
  readUE(): number {
    let leadingZeros = 0;
    while (this.readBit() === 0 && leadingZeros < 32) {
      leadingZeros++;
    }
    if (leadingZeros === 0) return 0;
    return (1 << leadingZeros) - 1 + this.readBits(leadingZeros);
  }

  /** Read signed Exp-Golomb coded value */
  readSE(): number {
    const value = this.readUE();
    return (value & 1) ? ((value + 1) >> 1) : -(value >> 1);
  }

  get bitsRemaining(): number {
    return (this.data.length - this.byteOffset) * 8 - this.bitOffset;
  }
}

/**
 * Remove emulation prevention bytes (0x00 0x00 0x03 → 0x00 0x00)
 */
function removeEmulationPrevention(data: Uint8Array): Uint8Array {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i + 2 < data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 3) {
      result.push(0, 0);
      i += 2; // skip the 0x03
    } else {
      result.push(data[i]);
    }
  }
  return new Uint8Array(result);
}

/**
 * Extract SPS NAL unit from an AVC decoder configuration record (avcC box)
 */
function extractSPSFromAVCC(data: Uint8Array): Uint8Array | null {
  // avcC format: version(1) + profile(1) + compat(1) + level(1) + lengthSize(1)
  //              + numSPS(1) + spsLength(2) + spsData(...)
  if (data.length < 8) return null;

  const version = data[0];
  if (version !== 1) return null;

  const numSPS = data[5] & 0x1f;
  if (numSPS < 1) return null;

  const spsLength = (data[6] << 8) | data[7];
  if (data.length < 8 + spsLength) return null;

  return data.slice(8, 8 + spsLength);
}

/**
 * Extract SPS NAL unit from Annex-B format data
 */
function extractSPSFromAnnexB(data: Uint8Array): Uint8Array | null {
  for (let i = 0; i < data.length - 4; i++) {
    // Look for start code (0x00 0x00 0x01 or 0x00 0x00 0x00 0x01)
    let nalStart = -1;
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      nalStart = i + 3;
    } else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
      nalStart = i + 4;
    }

    if (nalStart >= 0 && nalStart < data.length) {
      const nalType = data[nalStart] & 0x1f;
      if (nalType === 7) { // SPS
        // Find end of NAL (next start code or end of data)
        let nalEnd = data.length;
        for (let j = nalStart + 1; j < data.length - 2; j++) {
          if (data[j] === 0 && data[j + 1] === 0 && (data[j + 2] === 1 || (data[j + 2] === 0 && j + 3 < data.length && data[j + 3] === 1))) {
            nalEnd = j;
            break;
          }
        }
        return data.slice(nalStart, nalEnd);
      }
    }
  }
  return null;
}

/**
 * Parse H.264 SPS to extract max_num_reorder_frames
 *
 * @param codecDescription - AVC decoder configuration record (avcC) or Annex-B data
 * @returns Parsed SPS info, or null if parsing fails
 */
export function parseH264SPS(codecDescription: Uint8Array): H264SPSInfo | null {
  try {
    // Try avcC format first, then Annex-B
    let spsNAL = extractSPSFromAVCC(codecDescription);
    if (!spsNAL) {
      spsNAL = extractSPSFromAnnexB(codecDescription);
    }
    if (!spsNAL) {
      // Maybe the data IS the raw SPS NAL
      if (codecDescription.length > 0 && (codecDescription[0] & 0x1f) === 7) {
        spsNAL = codecDescription;
      } else {
        return null;
      }
    }

    // Skip NAL header byte
    const rbsp = removeEmulationPrevention(spsNAL.slice(1));
    const reader = new BitReader(rbsp);

    const profileIdc = reader.readBits(8);
    reader.readBits(8); // constraint_set flags + reserved
    const levelIdc = reader.readBits(8);
    reader.readUE(); // seq_parameter_set_id

    // High profile and above have additional fields
    if (profileIdc === 100 || profileIdc === 110 || profileIdc === 122 ||
        profileIdc === 244 || profileIdc === 44 || profileIdc === 83 ||
        profileIdc === 86 || profileIdc === 118 || profileIdc === 128 ||
        profileIdc === 138 || profileIdc === 139 || profileIdc === 134) {
      const chromaFormatIdc = reader.readUE();
      if (chromaFormatIdc === 3) {
        reader.readBits(1); // separate_colour_plane_flag
      }
      reader.readUE(); // bit_depth_luma_minus8
      reader.readUE(); // bit_depth_chroma_minus8
      reader.readBits(1); // qpprime_y_zero_transform_bypass_flag
      const seqScalingMatrixPresent = reader.readBits(1);
      if (seqScalingMatrixPresent) {
        const count = chromaFormatIdc !== 3 ? 8 : 12;
        for (let i = 0; i < count; i++) {
          const seqScalingListPresent = reader.readBits(1);
          if (seqScalingListPresent) {
            const sizeOfScalingList = i < 6 ? 16 : 64;
            let lastScale = 8;
            let nextScale = 8;
            for (let j = 0; j < sizeOfScalingList; j++) {
              if (nextScale !== 0) {
                const deltaScale = reader.readSE();
                nextScale = (lastScale + deltaScale + 256) % 256;
              }
              lastScale = nextScale === 0 ? lastScale : nextScale;
            }
          }
        }
      }
    }

    reader.readUE(); // log2_max_frame_num_minus4
    const picOrderCntType = reader.readUE();

    if (picOrderCntType === 0) {
      reader.readUE(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (picOrderCntType === 1) {
      reader.readBits(1); // delta_pic_order_always_zero_flag
      reader.readSE(); // offset_for_non_ref_pic
      reader.readSE(); // offset_for_top_to_bottom_field
      const numRefFramesInPicOrderCntCycle = reader.readUE();
      for (let i = 0; i < numRefFramesInPicOrderCntCycle; i++) {
        reader.readSE(); // offset_for_ref_frame
      }
    }

    const maxNumRefFrames = reader.readUE();
    reader.readBits(1); // gaps_in_frame_num_value_allowed_flag
    const picWidthInMbs = reader.readUE() + 1;
    const picHeightInMapUnits = reader.readUE() + 1;
    const frameMbsOnlyFlag = reader.readBits(1) === 1;

    if (!frameMbsOnlyFlag) {
      reader.readBits(1); // mb_adaptive_frame_field_flag
    }
    reader.readBits(1); // direct_8x8_inference_flag

    const frameCropping = reader.readBits(1);
    if (frameCropping) {
      reader.readUE(); // crop_left
      reader.readUE(); // crop_right
      reader.readUE(); // crop_top
      reader.readUE(); // crop_bottom
    }

    // VUI parameters — this is where max_num_reorder_frames lives
    let maxNumReorderFrames = maxNumRefFrames; // default per spec
    const vuiParametersPresent = reader.readBits(1);
    if (vuiParametersPresent && reader.bitsRemaining > 0) {
      maxNumReorderFrames = parseVUIForReorderFrames(reader, maxNumRefFrames);
    }

    return {
      profileIdc,
      levelIdc,
      maxNumRefFrames,
      maxNumReorderFrames,
      picWidthInMbs,
      picHeightInMapUnits,
      frameMbsOnlyFlag,
    };
  } catch {
    return null;
  }
}

/**
 * Parse VUI parameters to find max_num_reorder_frames in the bitstream_restriction
 */
function parseVUIForReorderFrames(reader: BitReader, defaultReorder: number): number {
  try {
    // aspect_ratio_info_present_flag
    if (reader.readBits(1)) {
      const aspectRatioIdc = reader.readBits(8);
      if (aspectRatioIdc === 255) { // Extended_SAR
        reader.readBits(32); // sar_width + sar_height
      }
    }
    // overscan_info_present_flag
    if (reader.readBits(1)) {
      reader.readBits(1); // overscan_appropriate_flag
    }
    // video_signal_type_present_flag
    if (reader.readBits(1)) {
      reader.readBits(3); // video_format
      reader.readBits(1); // video_full_range_flag
      if (reader.readBits(1)) { // colour_description_present_flag
        reader.readBits(24); // colour_primaries + transfer + matrix
      }
    }
    // chroma_loc_info_present_flag
    if (reader.readBits(1)) {
      reader.readUE(); // chroma_sample_loc_type_top_field
      reader.readUE(); // chroma_sample_loc_type_bottom_field
    }
    // timing_info_present_flag
    if (reader.readBits(1)) {
      reader.readBits(32); // num_units_in_tick
      reader.readBits(32); // time_scale
      reader.readBits(1);  // fixed_frame_rate_flag
    }
    // nal_hrd_parameters_present_flag
    const nalHrdPresent = reader.readBits(1);
    if (nalHrdPresent) {
      skipHRDParameters(reader);
    }
    // vcl_hrd_parameters_present_flag
    const vclHrdPresent = reader.readBits(1);
    if (vclHrdPresent) {
      skipHRDParameters(reader);
    }
    if (nalHrdPresent || vclHrdPresent) {
      reader.readBits(1); // low_delay_hrd_flag
    }
    reader.readBits(1); // pic_struct_present_flag

    // bitstream_restriction_flag — this contains max_num_reorder_frames
    const bitstreamRestriction = reader.readBits(1);
    if (bitstreamRestriction) {
      reader.readBits(1); // motion_vectors_over_pic_boundaries_flag
      reader.readUE();    // max_bytes_per_pic_denom
      reader.readUE();    // max_bits_per_mb_denom
      reader.readUE();    // log2_max_mv_length_horizontal
      reader.readUE();    // log2_max_mv_length_vertical
      const maxNumReorderFrames = reader.readUE();
      // reader.readUE(); // max_dec_frame_buffering (not needed)
      return maxNumReorderFrames;
    }

    return defaultReorder;
  } catch {
    return defaultReorder;
  }
}

/**
 * Skip HRD parameters in VUI
 */
function skipHRDParameters(reader: BitReader): void {
  const cpbCnt = reader.readUE() + 1;
  reader.readBits(4); // bit_rate_scale
  reader.readBits(4); // cpb_size_scale
  for (let i = 0; i < cpbCnt; i++) {
    reader.readUE(); // bit_rate_value_minus1
    reader.readUE(); // cpb_size_value_minus1
    reader.readBits(1); // cbr_flag
  }
  reader.readBits(5); // initial_cpb_removal_delay_length_minus1
  reader.readBits(5); // cpb_removal_delay_length_minus1
  reader.readBits(5); // dpb_output_delay_length_minus1
  reader.readBits(5); // time_offset_length
}
