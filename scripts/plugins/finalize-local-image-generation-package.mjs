#!/usr/bin/env node
/* global Buffer, process */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalizeV6Payload,
  finalizeV6Package,
  verifiedStoredEntries,
} from './jenny-plugin-v6-packager.mjs';

function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}
function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? path.resolve(process.argv[index + 1] || '') : '';
}

function trustedKey(signature, roots) {
  if (!exactKeys(signature, ['key_id', 'public_key_spki_der_base64', 'signature_base64'])) {
    throw new Error('local_image_signature_response_shape_invalid');
  }
  const publisher = roots.publishers?.find((item) => item.publisher_id === 'jenny-official');
  const key = publisher?.keys?.find((item) => item.key_id === publisher.current_key_id
    && item.status === 'active');
  if (!key || signature.key_id !== publisher.current_key_id
    || signature.public_key_spki_der_base64 !== key.public_key_spki_der_base64) {
    throw new Error('local_image_signing_root_mismatch');
  }
  return key;
}

export function finalizeLocalImageGeneration({ kit, signaturePath, output,
  rootsPath = path.resolve('config/plugins/trusted-publishers.json') } = {}) {
  if (!kit || !signaturePath || !output) throw new Error('local_image_finalize_arguments_invalid');
  const stored = JSON.parse(fs.readFileSync(path.join(kit, 'unsigned-fixture.json'), 'utf8'));
  const request = JSON.parse(fs.readFileSync(path.join(kit, 'signing-request.json'), 'utf8'));
  if (request.publisher_id !== 'jenny-official' || request.plugin_id !== 'local-image-generation') {
    throw new Error('local_image_signing_request_identity_mismatch');
  }
  const canonicalBytes = Buffer.from(request.canonical_payload_base64, 'base64');
  const expectedCanonical = Buffer.from(canonicalizeV6Payload(stored.signed_payload), 'utf8');
  if (!canonicalBytes.length || canonicalBytes.toString('base64') !== request.canonical_payload_base64
    || digest(canonicalBytes) !== request.canonical_payload_sha256
    || !canonicalBytes.equals(expectedCanonical)) {
    throw new Error('local_image_signing_request_mismatch');
  }
  const signature = JSON.parse(fs.readFileSync(signaturePath, 'utf8'));
  trustedKey(signature, JSON.parse(fs.readFileSync(rootsPath, 'utf8')));
  const publicKey = crypto.createPublicKey({
    key: Buffer.from(signature.public_key_spki_der_base64, 'base64'), format: 'der', type: 'spki',
  });
  if (digest(publicKey.export({ format: 'der', type: 'spki' })) !== signature.key_id) {
    throw new Error('local_image_signing_key_identity_mismatch');
  }
  const fixture = {
    manifest: stored.manifest,
    signedPayload: stored.signed_payload,
    signedEntries: verifiedStoredEntries(stored.entries, stored.signed_payload,
      'local_image_stored_entries_mismatch'),
    canonicalBytes,
  };
  const finalized = finalizeV6Package({ fixture,
    keyId: signature.key_id, publicKey,
    signature: Buffer.from(signature.signature_base64, 'base64') });
  if (finalized.bytes.length > 300 * 1024 * 1024) throw new Error('local_image_package_oversize');
  fs.writeFileSync(output, finalized.bytes, { flag: 'wx', mode: 0o600 });
  return finalized;
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = finalizeLocalImageGeneration({
      kit: argument('--kit'), signaturePath: argument('--signature'), output: argument('--output'),
    });
    process.stdout.write(`Local image generation package SHA-256: ${result.sha256}\n`);
  } catch (error) {
    process.stderr.write(`Local image finalization failed [${String(error?.message || 'failed').slice(0, 80)}].\n`);
    process.exitCode = 1;
  }
}
