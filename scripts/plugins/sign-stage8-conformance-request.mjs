#!/usr/bin/env node
/* global Buffer, process */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const CURRENT_KEY_ID = '7ed60652328f0fbbdb7417c97a9fbd4f2f54ef223af774e9d83ddf213a1291f5';
export const CURRENT_PUBLIC_KEY_SPKI_DER_BASE64 =
  'MCowBQYDK2VwAyEA5Mi+7ByGtEimTxGdbRTTcb5Uwx/tmrn1HeCNNgi3Ijo=';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40,64}$/;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const REDACTED_CODES = new Set([
  'argument_unknown', 'argument_value_missing', 'canonical_payload_invalid',
  'current_key_mismatch', 'encrypted_key_requires_tty', 'filename_invalid',
  'offline_signer_digest_mismatch', 'output_exists', 'private_key_parse_failed',
  'private_key_passphrase_empty', 'private_key_type_invalid', 'private_key_unavailable',
  'request_file_invalid', 'request_shape_invalid', 'signature_self_check_failed',
]);

function signingError(code) {
  return Object.assign(new Error('Stage 8 offline signing failed.'), { code });
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function siblingPath(directory, name) {
  if (!SAFE_NAME.test(name || '')) throw signingError('filename_invalid');
  const root = path.resolve(directory);
  const resolved = path.resolve(root, name);
  if (path.dirname(resolved) !== root) throw signingError('filename_invalid');
  return resolved;
}

function readStableFile(filePath, maxBytes, code) {
  let before;
  try { before = fs.lstatSync(filePath); }
  catch (_error) { throw signingError(code); }
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > maxBytes) {
    throw signingError(code);
  }
  const bytes = fs.readFileSync(filePath);
  const after = fs.lstatSync(filePath);
  if (after.isSymbolicLink() || after.size !== before.size
    || after.dev !== before.dev || after.ino !== before.ino) {
    bytes.fill(0);
    throw signingError(code);
  }
  return bytes;
}

async function hiddenPrompt(question, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY) throw signingError('encrypted_key_requires_tty');
  let muted = false;
  const mutedOutput = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) output.write(chunk, encoding);
      callback();
    },
  });
  const prompt = readline.createInterface({ input, output: mutedOutput, terminal: true });
  output.write(question);
  muted = true;
  try { return await new Promise((resolve) => prompt.question('', resolve)); }
  finally { muted = false; output.write('\n'); prompt.close(); }
}

async function loadPrivateKey(keyPath, readHidden) {
  const keyBytes = readStableFile(keyPath, MAX_PRIVATE_KEY_BYTES, 'private_key_unavailable');
  const encrypted = /BEGIN ENCRYPTED PRIVATE KEY|Proc-Type:\s*4,ENCRYPTED/i.test(
    keyBytes.subarray(0, Math.min(keyBytes.length, 4096)).toString('ascii')
  );
  let passphrase = null;
  try {
    if (encrypted) {
      passphrase = Buffer.from(String(await readHidden('Private-key passphrase: ')), 'utf8');
      if (passphrase.length === 0) throw signingError('private_key_passphrase_empty');
    }
    return crypto.createPrivateKey({ key: keyBytes, format: 'pem',
      ...(passphrase ? { passphrase } : {}) });
  } catch (error) {
    if (String(error?.code || '').startsWith('private_key_')) throw error;
    throw signingError('private_key_parse_failed');
  } finally {
    keyBytes.fill(0);
    if (passphrase) passphrase.fill(0);
  }
}

export function validateSigningRequest(request, {
  signerBytes = fs.readFileSync(SCRIPT_PATH),
  expectedPluginId = 'stage8-conformance',
} = {}) {
  if (!exactKeys(request, [
    'signing_request_schema_version', 'source_commit', 'publisher_id', 'plugin_id',
    'offline_signer_sha256', 'canonical_payload_base64', 'canonical_payload_sha256',
  ]) || request.signing_request_schema_version !== 1
    || !COMMIT.test(request.source_commit || '')
    || request.publisher_id !== 'jenny-official'
    || request.plugin_id !== expectedPluginId
    || !SHA256.test(request.offline_signer_sha256 || '')
    || !SHA256.test(request.canonical_payload_sha256 || '')
    || typeof request.canonical_payload_base64 !== 'string') {
    throw signingError('request_shape_invalid');
  }
  if (digest(signerBytes) !== request.offline_signer_sha256) {
    throw signingError('offline_signer_digest_mismatch');
  }
  const canonicalBytes = Buffer.from(request.canonical_payload_base64, 'base64');
  if (canonicalBytes.length === 0
    || canonicalBytes.toString('base64') !== request.canonical_payload_base64
    || digest(canonicalBytes) !== request.canonical_payload_sha256) {
    throw signingError('canonical_payload_invalid');
  }
  return canonicalBytes;
}

export function signStage8Request({
  request,
  privateKey,
  signerBytes,
  expectedKeyId = CURRENT_KEY_ID,
  expectedPublicKeySpkiDerBase64 = CURRENT_PUBLIC_KEY_SPKI_DER_BASE64,
  expectedPluginId = 'stage8-conformance',
}) {
  const canonicalBytes = validateSigningRequest(request, { signerBytes, expectedPluginId });
  if (!(privateKey instanceof crypto.KeyObject) || privateKey.type !== 'private'
    || privateKey.asymmetricKeyType !== 'ed25519') {
    throw signingError('private_key_type_invalid');
  }
  const publicKey = crypto.createPublicKey(privateKey);
  const publicBytes = publicKey.export({ format: 'der', type: 'spki' });
  const keyId = digest(publicBytes);
  if (keyId !== expectedKeyId
    || publicBytes.toString('base64') !== expectedPublicKeySpkiDerBase64) {
    throw signingError('current_key_mismatch');
  }
  const signature = crypto.sign(null, canonicalBytes, privateKey);
  if (signature.length !== 64 || !crypto.verify(null, canonicalBytes, publicKey, signature)) {
    throw signingError('signature_self_check_failed');
  }
  return Object.freeze({
    key_id: keyId,
    public_key_spki_der_base64: publicBytes.toString('base64'),
    signature_base64: signature.toString('base64'),
  });
}

function assertOutputAbsent(outputPath) {
  try { fs.lstatSync(outputPath); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw signingError('output_exists');
}

function publishNoClobber(outputPath, bytes) {
  const temporary = path.join(path.dirname(outputPath),
    `.jenny-stage8-signature-${crypto.randomBytes(12).toString('hex')}.partial`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    fs.linkSync(temporary, outputPath);
  } catch (error) {
    if (error?.code === 'EEXIST') throw signingError('output_exists');
    throw error;
  } finally {
    try { fs.unlinkSync(temporary); } catch (_error) { /* best effort */ }
  }
}

export async function runOfflineSigning({
  signingDirectory = path.dirname(SCRIPT_PATH),
  requestName = 'signing-request.json',
  privateKeyName,
  outputName = 'returned-stage8-signature.json',
  signerBytes = fs.readFileSync(SCRIPT_PATH),
  expectedKeyId = CURRENT_KEY_ID,
  expectedPublicKeySpkiDerBase64 = CURRENT_PUBLIC_KEY_SPKI_DER_BASE64,
  expectedPluginId = 'stage8-conformance',
  successLabel = 'Stage 8 signature response',
  readHidden = (question) => hiddenPrompt(question),
  stdout = process.stdout,
} = {}) {
  const requestPath = siblingPath(signingDirectory, requestName);
  const keyPath = siblingPath(signingDirectory, privateKeyName);
  const outputPath = siblingPath(signingDirectory, outputName);
  assertOutputAbsent(outputPath);
  const requestBytes = readStableFile(requestPath, MAX_REQUEST_BYTES, 'request_file_invalid');
  let request;
  try { request = JSON.parse(requestBytes.toString('utf8')); }
  catch (_error) { throw signingError('request_file_invalid'); }
  const privateKey = await loadPrivateKey(keyPath, readHidden);
  const response = signStage8Request({ request, privateKey, signerBytes,
    expectedKeyId, expectedPublicKeySpkiDerBase64, expectedPluginId });
  publishNoClobber(outputPath, Buffer.from(`${JSON.stringify(response, null, 2)}\n`, 'utf8'));
  stdout.write(`${successLabel}: ${outputName}\n`);
  return response;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!value) throw signingError('argument_value_missing');
    if (key === '--request') options.requestName = value;
    else if (key === '--private-key') options.privateKeyName = value;
    else if (key === '--output') options.outputName = value;
    else throw signingError('argument_unknown');
  }
  if (!options.privateKeyName) throw signingError('argument_value_missing');
  return options;
}

if (path.resolve(process.argv[1] || '') === path.resolve(SCRIPT_PATH)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    await runOfflineSigning(options);
  } catch (error) {
    const code = REDACTED_CODES.has(error?.code) ? error.code : 'signing_failed';
    process.stderr.write(`Stage 8 offline signing failed [${code}]. No signature was written.\n`);
    process.exitCode = 1;
  }
}
