#!/usr/bin/env node
/* global process */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOfflineSigning } from './sign-stage8-conformance-request.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function options(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!value) throw new Error('argument_value_missing');
    if (key === '--request') parsed.requestName = value;
    else if (key === '--private-key') parsed.privateKeyName = value;
    else if (key === '--output') parsed.outputName = value;
    else throw new Error('argument_unknown');
  }
  if (!parsed.privateKeyName) throw new Error('argument_value_missing');
  return parsed;
}

if (path.resolve(process.argv[1] || '') === path.resolve(SCRIPT_PATH)) {
  try {
    const parsed = options(process.argv.slice(2));
    await runOfflineSigning({
      ...parsed,
      signingDirectory: path.dirname(SCRIPT_PATH),
      signerBytes: fs.readFileSync(SCRIPT_PATH),
      expectedPluginId: 'local-image-generation',
      outputName: parsed.outputName || 'returned-local-image-signature.json',
      successLabel: 'Local image generation signature response',
    });
  } catch (error) {
    const code = String(error?.code || error?.message || 'signing_failed')
      .replace(/[^a-z0-9_]/gi, '').slice(0, 64) || 'signing_failed';
    process.stderr.write(`Local image signing failed [${code}]. No signature was written.\n`);
    process.exitCode = 1;
  }
}
