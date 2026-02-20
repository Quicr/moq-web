// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Codec Decode Worker Entry Point
 *
 * Wrapper that imports the codec decode worker from the media package.
 * This file exists because Vite's worker plugin needs a relative file path.
 */

// Import runs the codec decode worker in this worker context
// Using relative path to compiled dist because TSC doesn't allow imports outside rootDir
import '../../../media/dist/workers/codec-decode-worker.js';
