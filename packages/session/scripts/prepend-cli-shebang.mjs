// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause
//
// Post-build shim: prepend a Node shebang and chmod +x the compiled
// interop CLI so `pnpm exec moq-web-interop` (or a bare `./dist/cli/interop-cli.js`)
// works. tsc does not emit shebangs, and preserving them in the .ts source
// leaks into other build tooling (worker bundling, docs) — so we patch
// after emit instead.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, '..', 'dist', 'cli', 'interop-cli.js');

const shebang = '#!/usr/bin/env node\n';

try {
  const contents = await fs.readFile(target, 'utf8');
  if (!contents.startsWith('#!')) {
    await fs.writeFile(target, shebang + contents, 'utf8');
  }
  await fs.chmod(target, 0o755);
  // eslint-disable-next-line no-console
  console.log(`[session] shebang + chmod applied to ${path.relative(process.cwd(), target)}`);
} catch (err) {
  if (err && err.code === 'ENOENT') {
    // eslint-disable-next-line no-console
    console.warn(`[session] no CLI at ${target}, skipping shebang patch`);
    process.exit(0);
  }
  throw err;
}
