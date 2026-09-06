#!/usr/bin/env node
/* global Buffer, process */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeStage8Package, verifiedStoredEntries } from './jenny-plugin-v6-packager.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

export function validateReturnedSignature(signature, trustedRoots = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'config', 'plugins', 'trusted-publishers.json'), 'utf8')
)) {
  if (!exactKeys(signature, ['key_id', 'public_key_spki_der_base64', 'signature_base64'])) {
    throw new Error('stage8_signature_response_shape_invalid');
  }
  const publisher = trustedRoots.publishers?.find((item) => item.publisher_id === 'jenny-official');
  const trustedKey = publisher?.keys?.find((item) => item.key_id === publisher.current_key_id
    && item.status === 'active');
  if (!trustedKey || signature.key_id !== publisher.current_key_id
    || signature.public_key_spki_der_base64 !== trustedKey.public_key_spki_der_base64) {
    throw new Error('stage8_signing_root_mismatch');
  }
  return trustedKey;
}

function argument(name) { const index = process.argv.indexOf(name); return path.resolve(process.argv[index + 1] || ''); }
export function main() {
 try {
  const kit = argument('--kit'); const returned = argument('--signature'); const output = argument('--output');
  const stored = JSON.parse(fs.readFileSync(path.join(kit, 'unsigned-fixture.json'), 'utf8'));
  const request = JSON.parse(fs.readFileSync(path.join(kit, 'signing-request.json'), 'utf8'));
  const canonicalBytes = Buffer.from(request.canonical_payload_base64, 'base64');
  if (canonicalBytes.length === 0 || canonicalBytes.toString('base64') !== request.canonical_payload_base64
    || digest(canonicalBytes) !== request.canonical_payload_sha256
    || !crypto.timingSafeEqual(canonicalBytes, Buffer.from(stable(stored.signed_payload), 'utf8'))) {
    throw new Error('stage8_signing_request_mismatch');
  }
  const fixture = { manifest: stored.manifest, signedPayload: stored.signed_payload,
    signedEntries: verifiedStoredEntries(stored.entries, stored.signed_payload,
      'stage8_stored_entries_mismatch'),
    canonicalBytes };
  const signature = JSON.parse(fs.readFileSync(returned, 'utf8'));
  validateReturnedSignature(signature);
  const publicKey = crypto.createPublicKey({ key: Buffer.from(signature.public_key_spki_der_base64, 'base64'),
    format: 'der', type: 'spki' });
  const keyId = crypto.createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex');
  if (keyId !== signature.key_id) throw new Error('stage8_key_identity_mismatch');
  const finalized = finalizeStage8Package({ fixture, keyId, publicKey,
    signature: Buffer.from(signature.signature_base64, 'base64') });
  fs.writeFileSync(output, finalized.bytes, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`Stage 8 package SHA-256: ${finalized.sha256}\n`);
 } catch (error) { process.stderr.write(`Stage 8 finalization failed [${error.message}].\n`); process.exitCode = 1; }
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) main();
