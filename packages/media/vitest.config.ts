// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { defineConfig } from 'vitest/config';

const moqtVersion = process.env.MOQT_VERSION || 'draft-16';

export default defineConfig({
  define: {
    __MOQT_VERSION__: JSON.stringify(moqtVersion),
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/__tests__/setup.ts'],
  },
});
