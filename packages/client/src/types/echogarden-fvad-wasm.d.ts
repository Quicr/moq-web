// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Type declarations for @echogarden/fvad-wasm
 */

declare module '@echogarden/fvad-wasm' {
  interface FvadModule {
    _fvad_new(): number;
    _fvad_free(inst: number): void;
    _fvad_reset(inst: number): void;
    _fvad_set_mode(inst: number, mode: number): number;
    _fvad_set_sample_rate(inst: number, rate: number): number;
    _fvad_process(inst: number, frame: number, length: number): number;
    _malloc(size: number): number;
    _free(ptr: number): void;
    HEAP16: Int16Array;
  }

  function fvad(): Promise<FvadModule>;
  export default fvad;
}
