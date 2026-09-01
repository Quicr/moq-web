// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

const RELAY_URL =
  process.env.RELAY_URL ?? 'https://moqx-main.ci.openmoq.org:4433/moq-relay';
const AUTH_TOKEN = process.env.MOQ_AUTH_TOKEN ?? '';
const MOQT_VERSION = process.env.MOQT_VERSION ?? 'draft-18';

export default defineConfig({
  define: {
    __MOQT_VERSION__: JSON.stringify(MOQT_VERSION),
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      VITE_RELAY_URL: RELAY_URL,
      VITE_MOQ_AUTH_TOKEN: AUTH_TOKEN,
      VITE_MOQT_VERSION: MOQT_VERSION,
    },
    browser: {
      enabled: true,
      headless: true,
      instances: [
        {
          browser: 'chromium',
          provider: playwright({
            launchOptions: {
              args: [
                '--webtransport-developer-mode',
                '--ignore-certificate-errors',
                '--enable-experimental-web-platform-features',
              ],
            },
          }),
        },
      ],
    },
  },
});
