// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Voice Activity Detection Module
 *
 * Exports VAD types, implementations, and factory functions.
 */

export type { VAD, VADConfig, VADResult, VADEvents, VADProvider } from './types.js';
export { BaseVAD } from './base-vad.js';
export { LibfvadVAD } from './libfvad-vad.js';
export type { LibfvadModule } from './libfvad-vad.js';
export { SileroVAD } from './silero-vad.js';
export type { SileroVADFactory } from './silero-vad.js';
