// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

declare module 'mp4box' {
  export interface MP4BoxSample {
    number: number;
    track_id: number;
    description_index: number;
    description: unknown;
    is_rap: boolean;
    is_sync: boolean;
    is_leading: number;
    depends_on: number;
    is_depended_on: number;
    has_redundancy: number;
    timescale: number;
    dts: number;
    cts: number;
    duration: number;
    size: number;
    data: Uint8Array;
    offset: number;
  }

  export interface MP4BoxVideoInfo {
    id: number;
    codec: string;
    timescale: number;
    nb_samples: number;
    duration: number; // in track timescale
    video: { width: number; height: number };
    /** avcC (SPS/PPS) box bytes are exposed via getTrackById(id).avcC. */
  }

  export interface MP4BoxAudioInfo {
    id: number;
    codec: string;
    timescale: number;
    nb_samples: number;
    duration: number;
    audio: { sample_rate: number; channel_count: number };
  }

  export interface MP4BoxInfo {
    duration: number; // in movie timescale
    timescale: number; // movie timescale
    videoTracks: MP4BoxVideoInfo[];
    audioTracks: MP4BoxAudioInfo[];
    tracks: (MP4BoxVideoInfo | MP4BoxAudioInfo)[];
  }

  export interface MP4BoxFile {
    onReady: ((info: MP4BoxInfo) => void) | null;
    onSamples: ((id: number, user: unknown, samples: MP4BoxSample[]) => void) | null;
    onError: ((error: string) => void) | null;
    setExtractionOptions(
      id: number,
      user: unknown,
      options: { nbSamples?: number; rapAlignement?: boolean },
    ): void;
    start(): void;
    stop(): void;
    flush(): void;
    appendBuffer(buffer: ArrayBuffer & { fileStart: number }): number;
    getTrackById(id: number): {
      mdia: {
        minf: {
          stbl: {
            stsd: {
              entries: Array<{
                avcC?: {
                  SPS: Array<{ nalu: Uint8Array; length: number }>;
                  PPS: Array<{ nalu: Uint8Array; length: number }>;
                };
                type: string;
              }>;
            };
          };
        };
      };
    };
  }

  export function createFile(keepMdatData?: boolean, stream?: unknown): MP4BoxFile;

  const _default: { createFile: typeof createFile };
  export default _default;
}
