// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

import { ReportReporter } from './lib/report-reporter.js';

const RELAY_URL =
  process.env.RELAY_URL ?? 'https://moqx-main.ci.openmoq.org:4433/moq-relay';
const AUTH_TOKEN = process.env.MOQ_AUTH_TOKEN ?? '';
const MOQT_VERSION = process.env.MOQT_VERSION ?? 'draft-18';
// E2E_REPORT=<path> also writes a JSON report for the e2e report page
const REPORT_PATH = process.env.E2E_REPORT;

export default defineConfig({
  define: {
    __MOQT_VERSION__: JSON.stringify(MOQT_VERSION),
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    ...(REPORT_PATH ? { reporters: ['default', new ReportReporter(REPORT_PATH)] } : {}),
    env: {
      VITE_RELAY_URL: RELAY_URL,
      VITE_MOQ_AUTH_TOKEN: AUTH_TOKEN,
      VITE_MOQT_VERSION: MOQT_VERSION,
      // 1 = report a relay's known PUBLISH-forwarding gap (35) without failing
      VITE_MOQ_RELAY_KNOWN_NO_PUBLISH_FWD: process.env.MOQ_RELAY_KNOWN_NO_PUBLISH_FWD ?? '',
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
