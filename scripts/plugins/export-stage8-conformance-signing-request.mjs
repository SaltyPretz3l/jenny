#!/usr/bin/env node
/* global process */
import fs from 'node:fs';
import path from 'node:path';
const kit = path.resolve(process.argv[process.argv.indexOf('--kit') + 1] || '');
try {
  const request = fs.readFileSync(path.join(kit, 'signing-request.json'));
  process.stdout.write(request);
} catch (_error) { process.stderr.write('Stage 8 signing request unavailable.\n'); process.exitCode = 1; }

