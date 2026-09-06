#!/usr/bin/env node
/* global Buffer, process */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import intake from '../../services/plugins/package/local-package-intake.js';
import publisherRoots from '../../services/plugins/package/trusted-publisher-roots.js';
import { readStableBoundedFile } from './bounded-file-read.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function fail(code) { throw Object.assign(new Error('Local image package verification failed.'), { code }); }

function stablePackage(packagePath) {
  const read = readStableBoundedFile(packagePath, 300 * 1024 * 1024);
  if (!read.ok) fail(read.reason === 'changed'
    ? 'package_changed_during_read'
    : read.reason === 'unavailable' ? 'package_unavailable' : 'package_file_invalid');
  return read.bytes;
}

export async function verifyLocalImageGenerationPackage({ packagePath, trustRoots = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'config', 'plugins', 'trusted-publishers.json'), 'utf8')
), now = new Date().toISOString() } = {}) {
  const resolved = path.resolve(packagePath || '');
  const bytes = stablePackage(resolved);
  const roots = trustRoots?.ok === true ? trustRoots : publisherRoots.validateTrustedPublisherRoots(trustRoots);
  if (!roots.ok) fail(`trust_roots_${roots.reason}`);
  const admitted = await intake.verifyLocalPackage({ bytes,
    sourcePathDigest: digest(Buffer.from(resolved, 'utf8')), trustRoots: roots, now });
  if (!admitted.ok) fail(`production_intake_${admitted.reason || 'rejected'}`);
  const contributions = admitted.manifest.contributions;
  const panel = contributions.find((item) => item.kind === 'panel');
  const provider = contributions.find((item) => item.kind === 'session_provider');
  if (admitted.publisher_id !== 'jenny-official'
    || admitted.plugin_id !== 'local-image-generation' || admitted.version !== '1.0.0'
    || contributions.length !== 2 || !panel || !provider
    || JSON.stringify(admitted.manifest.requested_permissions) !== JSON.stringify(['ui.view', 'runtime.full_host'])
    || admitted.full_host_contents.length !== 1 || admitted.executable_object_bytes.length !== 1
    || admitted.view_asset_bytes?.length !== 3 || admitted.full_host_contents[0].platform !== 'win32'
    || admitted.full_host_contents[0].architecture !== 'x64') {
    fail('local_image_package_identity_mismatch');
  }
  return Object.freeze({ sha256: admitted.archive_digest,
    bytes: admitted.package_record.size_evidence.archive_bytes,
    executableSha256: provider.executable_sha256 });
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  const index = process.argv.indexOf('--package');
  try {
    const result = await verifyLocalImageGenerationPackage({ packagePath: process.argv[index + 1] });
    process.stdout.write(`Local image generation production intake: PASS\nPackage SHA-256: ${result.sha256}\n`);
  } catch (error) {
    process.stderr.write(`Local image production intake failed [${error?.code || 'verification_failed'}].\n`);
    process.exitCode = 1;
  }
}
