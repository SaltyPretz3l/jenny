#!/usr/bin/env node
/* global Buffer, process */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_RELATIVE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const EXPECTED_KIT_FILES = Object.freeze([
  'jenny-plugin-v4-packager.mjs',
  'jenny-plugin-v5-packager.mjs',
  'sign-official-chatgpt-package.mjs',
  'chatgpt-subscription/manifest.template.json',
  'chatgpt-subscription/content/provider.json',
  'chatgpt-subscription/content/setup-scene.json',
  'chatgpt-subscription/view/index.html',
  'chatgpt-subscription/view/setup.css',
  'chatgpt-subscription/view/setup.js',
]);

function signingError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value) throw signingError('argument_value_missing');
    if (key === '--expected-kit-sha256') result.expectedKitSha256 = value.toLowerCase();
    else if (key === '--private-key') result.privateKeyName = value;
    else throw signingError('argument_unknown');
  }
  if (!DIGEST.test(result.expectedKitSha256 || '')) throw signingError('kit_digest_invalid');
  if (!SAFE_NAME.test(result.privateKeyName || '')) throw signingError('private_key_name_invalid');
  return result;
}

function readStableFile(filePath, maxBytes) {
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > maxBytes) {
    throw signingError('kit_file_invalid');
  }
  const bytes = fs.readFileSync(filePath);
  const after = fs.lstatSync(filePath);
  if (after.isSymbolicLink() || after.size !== before.size
    || after.dev !== before.dev || after.ino !== before.ino) {
    throw signingError('kit_file_changed');
  }
  return bytes;
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function receiptPayloadBytes(receipt) {
  return Buffer.from(JSON.stringify({
    signing_receipt_schema_version: receipt.signing_receipt_schema_version,
    source_commit: receipt.source_commit,
    publisher_id: receipt.publisher_id,
    plugin_id: receipt.plugin_id,
    package_version: receipt.package_version,
    signing_key_id: receipt.signing_key_id,
    package_name: receipt.package_name,
    package_sha256: receipt.package_sha256,
    signing_kit_sha256: receipt.signing_kit_sha256,
  }), 'utf8');
}

export function verifySigningKit({
  kitRoot = SCRIPT_DIR,
  expectedKitSha256,
} = {}) {
  const manifestBytes = readStableFile(path.join(kitRoot, 'signing-kit.json'), 256 * 1024);
  if (sha256(manifestBytes) !== expectedKitSha256) throw signingError('kit_manifest_digest_mismatch');
  let kit;
  try { kit = JSON.parse(manifestBytes.toString('utf8')); }
  catch (_error) { throw signingError('kit_manifest_json_invalid'); }
  if (!exactKeys(kit, [
    'signing_kit_schema_version', 'source_commit', 'publisher_id', 'plugin_id',
    'package_version', 'signing_key_id', 'output_name', 'receipt_name', 'files',
  ]) || kit.signing_kit_schema_version !== 1
    || !/^[0-9a-f]{40}$/.test(kit.source_commit || '')
    || kit.publisher_id !== 'jenny-official'
    || kit.plugin_id !== 'chatgpt-subscription'
    || !/^\d+\.\d+\.\d+$/.test(kit.package_version || '')
    || !DIGEST.test(kit.signing_key_id || '')
    || !SAFE_NAME.test(kit.output_name || '') || !kit.output_name.endsWith('.jenny-plugin')
    || !SAFE_NAME.test(kit.receipt_name || '') || !kit.receipt_name.endsWith('.json')
    || !Array.isArray(kit.files) || kit.files.length !== 9) {
    throw signingError('kit_manifest_invalid');
  }
  const seen = new Set();
  for (const entry of kit.files) {
    if (!exactKeys(entry, ['path', 'bytes', 'sha256'])
      || !SAFE_RELATIVE.test(entry.path || '') || entry.path.includes('..')
      || !Number.isInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > 4 * 1024 * 1024
      || !DIGEST.test(entry.sha256 || '') || seen.has(entry.path)) {
      throw signingError('kit_file_record_invalid');
    }
    seen.add(entry.path);
    const filePath = path.resolve(kitRoot, ...entry.path.split('/'));
    if (path.relative(kitRoot, filePath).startsWith('..')) throw signingError('kit_file_path_invalid');
    const bytes = readStableFile(filePath, 4 * 1024 * 1024);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      throw signingError('kit_file_digest_mismatch');
    }
  }
  if (EXPECTED_KIT_FILES.some((required) => !seen.has(required))) {
    throw signingError('kit_required_file_missing');
  }
  const sourceManifest = JSON.parse(readStableFile(
    path.join(kitRoot, 'chatgpt-subscription', 'manifest.template.json'),
    256 * 1024
  ));
  if (sourceManifest.version !== kit.package_version) throw signingError('kit_package_version_mismatch');
  return kit;
}

export async function runOfflineSigning({
  kitRoot = SCRIPT_DIR,
  expectedKitSha256,
  privateKeyName,
  readHidden,
  stdout = process.stdout,
  writeReceipt = fs.writeFileSync,
} = {}) {
  const kit = verifySigningKit({ kitRoot, expectedKitSha256 });
  const receiptPath = path.join(kitRoot, kit.receipt_name);
  try { fs.lstatSync(receiptPath); throw signingError('receipt_exists'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const packager = await import(pathToFileURL(path.join(kitRoot, 'jenny-plugin-v5-packager.mjs')).href);
  let receipt = null;
  const result = await packager.runCli([
    '--private-key', privateKeyName,
    '--output', kit.output_name,
  ], {
    scriptDirectory: kitRoot,
    sourceRoot: path.join(kitRoot, 'chatgpt-subscription'),
    expectedKeyId: kit.signing_key_id,
    ...(typeof readHidden === 'function' ? { readHidden } : {}),
    createAttestationPayload: ({ archiveDigest }) => {
      receipt = {
        signing_receipt_schema_version: 1,
        source_commit: kit.source_commit,
        publisher_id: kit.publisher_id,
        plugin_id: kit.plugin_id,
        package_version: kit.package_version,
        signing_key_id: kit.signing_key_id,
        package_name: kit.output_name,
        package_sha256: archiveDigest,
        signing_kit_sha256: expectedKitSha256,
      };
      return receiptPayloadBytes(receipt);
    },
    stdout,
  });
  if (!receipt || typeof result.attestationSignature !== 'string') {
    throw signingError('receipt_attestation_unavailable');
  }
  receipt.receipt_signature = result.attestationSignature;
  try {
    writeReceipt(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: 'wx', mode: 0o600,
    });
  } catch (error) {
    try {
      const packagePath = path.join(kitRoot, kit.output_name);
      const packageBytes = readStableFile(packagePath, 300 * 1024 * 1024);
      if (sha256(packageBytes) !== result.archiveDigest) {
        throw signingError('receipt_failure_cleanup_digest_mismatch');
      }
      fs.unlinkSync(packagePath);
    } catch (cleanupError) {
      if (cleanupError?.code === 'receipt_failure_cleanup_digest_mismatch') throw cleanupError;
      throw signingError('receipt_failure_cleanup_failed');
    }
    throw error;
  }
  stdout.write(`Signing receipt: ${kit.receipt_name}\n`);
  return Object.freeze({ packageName: kit.output_name, receiptName: kit.receipt_name,
    packageSha256: result.archiveDigest });
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  const args = (() => {
    try { return parseArgs(process.argv.slice(2)); }
    catch (error) {
      process.stderr.write(`Offline signing failed [${error?.code || 'argument_invalid'}].\n`);
      process.exitCode = 1;
      return null;
    }
  })();
  if (args) {
    runOfflineSigning(args).catch((error) => {
      process.stderr.write(`Offline signing failed [${error?.code || 'signing_failed'}].\n`);
      process.exitCode = 1;
    });
  }
}
