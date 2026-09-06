#!/usr/bin/env node
/* global process */

import fs from 'node:fs';
import path from 'node:path';

try {
  const kit = path.resolve(process.argv[process.argv.indexOf('--kit') + 1] || '');
  process.stdout.write(fs.readFileSync(path.join(kit, 'signing-request.json')));
} catch (_error) {
  process.stderr.write('Local image generation signing request unavailable.\n');
  process.exitCode = 1;
}
