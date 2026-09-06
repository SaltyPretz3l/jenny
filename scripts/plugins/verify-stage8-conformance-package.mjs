#!/usr/bin/env node
/* global Buffer, process */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import intake from '../../services/plugins/package/local-package-intake.js';
import publisherRoots from '../../services/plugins/package/trusted-publisher-roots.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const EXPECTED_KINDS = Object.freeze(['engine_adapter', 'hook', 'native_mcp', 'session_provider']);

function verificationError(code) {
  return Object.assign(new Error('Stage 8 conformance verification failed.'), { code });
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readStablePackage(packagePath) {
  let before;
  try { before = fs.lstatSync(packagePath); }
  catch (_error) { throw verificationError('package_unavailable'); }
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0
    || before.size > MAX_PACKAGE_BYTES) throw verificationError('package_file_invalid');
  const bytes = fs.readFileSync(packagePath);
  const after = fs.lstatSync(packagePath);
  if (after.isSymbolicLink() || after.size !== before.size
    || after.dev !== before.dev || after.ino !== before.ino) {
    throw verificationError('package_changed_during_read');
  }
  return bytes;
}

export async function verifyStage8ConformancePackage({
  packagePath,
  trustRoots = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'config', 'plugins', 'trusted-publishers.json'), 'utf8'
  )),
  now = new Date().toISOString(),
} = {}) {
  const resolved = path.resolve(packagePath || '');
  const bytes = readStablePackage(resolved);
  const validatedRoots = trustRoots?.ok === true
    ? trustRoots : publisherRoots.validateTrustedPublisherRoots(trustRoots);
  if (!validatedRoots.ok) throw verificationError(`trust_roots_${validatedRoots.reason}`);
  const admitted = await intake.verifyLocalPackage({
    bytes,
    sourcePathDigest: digest(Buffer.from(resolved, 'utf8')),
    trustRoots: validatedRoots,
    now,
  });
  if (!admitted.ok) throw verificationError(`production_intake_${admitted.reason || 'rejected'}`);
  const kinds = admitted.manifest.contributions.map((item) => item.kind).sort();
  if (admitted.manifest.manifest_schema_version !== 6
    || admitted.publisher_id !== 'jenny-official'
    || admitted.plugin_id !== 'stage8-conformance'
    || admitted.version !== '1.0.0'
    || JSON.stringify(kinds) !== JSON.stringify(EXPECTED_KINDS)
    || admitted.full_host_contents.length !== 4
    || admitted.executable_object_bytes.length !== 4) {
    throw verificationError('conformance_identity_mismatch');
  }
  return Object.freeze({ sha256: admitted.archive_digest, contributionCount: kinds.length });
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  const index = process.argv.indexOf('--package');
  try {
    const result = await verifyStage8ConformancePackage({ packagePath: process.argv[index + 1] });
    process.stdout.write(`Stage 8 production intake: PASS\nPackage SHA-256: ${result.sha256}\n`);
  } catch (error) {
    process.stderr.write(`Stage 8 production intake failed [${error?.code || 'verification_failed'}].\n`);
    process.exitCode = 1;
  }
}
