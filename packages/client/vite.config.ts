// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import path from 'path';

// MOQT version selection at build time
// Default to 'draft-16', can be set via MOQT_VERSION env var
const moqtVersion = process.env.MOQT_VERSION || 'draft-16';
console.log(`Building with MOQT_VERSION=${moqtVersion}`);

export default defineConfig({
  plugins: [react(), basicSsl()],
  base: process.env.BASE_URL || '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  define: {
    // Build-time constant for MOQT version selection
    // Sets __MOQT_VERSION__ which is used by @web-moq/core
    __MOQT_VERSION__: JSON.stringify(moqtVersion),
    // Also set as VITE env for runtime access
    'import.meta.env.VITE_MOQT_VERSION': JSON.stringify(moqtVersion),
  },
  server: {
    port: 5173,
    host: true,
  },
  build: {
    target: 'esnext',
    sourcemap: true,
  },
  worker: {
    format: 'es',
    rollupOptions: {
      // Ensure workers can resolve workspace packages
      external: [],
    },
  },
  optimizeDeps: {
    // Include workspace packages in pre-bundling for dev mode
    include: ['@web-moq/core', '@web-moq/session', '@web-moq/media'],
  },
});
