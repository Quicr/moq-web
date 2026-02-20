// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Transport Worker Entry Point
 *
 * Wrapper that imports the transport worker from the session package.
 * This file exists because Vite's worker plugin needs a relative file path.
 */

// Import runs the transport worker in this worker context
// Using relative path to compiled dist because TSC doesn't allow imports outside rootDir
import '../../../session/dist/workers/transport-worker.js';
