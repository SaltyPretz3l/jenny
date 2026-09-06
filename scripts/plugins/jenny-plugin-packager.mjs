#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
export const FIXTURE_NAME = 'stage4b-owner-smoke';
export const PUBLISHER_ID = 'jenny-official';
export const PLUGIN_ID = 'stage4b-owner-smoke';
export const PACKAGE_VERSION = '1.0.0';
export const CURRENT_KEY_ID = '7ed60652328f0fbbdb7417c97a9fbd4f2f54ef223af774e9d83ddf213a1291f5';
const SIGNATURE_BUNDLE_PATH = 'META-JENNY/signature-bundle.json';
const SMOKE_WORKSPACE_PATH = 'stage4b-smoke.txt';
const CANONICALIZATION_VERSION = 1;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const UTF8_FLAG = 0x0800;
const FIXED_DOS_TIME = 0x0000;
const FIXED_DOS_DATE = 0x0021;
const SAFE_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function packagerError(code, message) {
  return Object.assign(new Error(message), { code });
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalBytes(value) {
  return Buffer.from(stableStringify(value), 'utf8');
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function content(contributionId, payload) {
  return {
    content_schema_version: 2,
    publisher_id: PUBLISHER_ID,
    plugin_id: PLUGIN_ID,
    contribution_id: contributionId,
    payload,
  };
}

const THEME_TOKENS = Object.freeze([
  ['surface.chat', '#000000'],
  ['surface.message_user', '#000000'],
  ['surface.message_assistant', '#000000'],
  ['surface.tool', '#000000'],
  ['text.primary', '#FFFFFF'],
  ['text.muted', '#B3B3B3'],
  ['text.link', '#66CCFF'],
  ['border.default', '#777777'],
  ['border.focus', '#00FFFF'],
  ['color.accent', '#005FCC'],
  ['color.accent_text', '#FFFFFF'],
]);

function contributionDefinitions() {
  return [
    {
      kind: 'skill',
      contributionId: 'skill-main',
      name: 'Owner Smoke Guidance',
      payload: {
        kind: 'skill',
        instructions: 'Use the local workspace carefully and keep all plugin actions read-only.',
      },
    },
    {
      kind: 'prompt',
      contributionId: 'prompt-main',
      name: 'Owner Smoke Prompt',
      payload: {
        kind: 'prompt',
        template: 'Prepare to read the Stage 4B owner-smoke workspace file at {{path}}.',
        placeholders: ['path'],
      },
    },
    {
      kind: 'settings_schema',
      contributionId: 'settings-main',
      name: 'Owner Smoke Settings',
      payload: {
        kind: 'settings_schema',
        fields: [{
          type: 'string',
          key: 'path',
          label: 'Workspace file',
          default: SMOKE_WORKSPACE_PATH,
          max_length: 240,
        }],
      },
    },
    {
      kind: 'theme',
      contributionId: 'theme-main',
      name: 'Owner Smoke Theme',
      payload: {
        kind: 'theme',
        tokens: THEME_TOKENS.map(([token, value]) => ({ token, value })),
      },
    },
    {
      kind: 'workflow',
      contributionId: 'workflow-read',
      name: 'Owner Smoke Read Workflow',
      payload: {
        kind: 'workflow',
        entry_node_id: 'prepare',
        nodes: [
          {
            type: 'prompt',
            node_id: 'prepare',
            target_contribution_id: 'prompt-main',
            bindings: [{
              target: 'path',
              value: { source: 'setting', settings_contribution_id: 'settings-main', key: 'path' },
            }],
            max_attempts: 1,
            timeout_ms: 60_000,
          },
          {
            type: 'tool',
            node_id: 'read',
            tool_id: 'read_file',
            bindings: [{
              target: 'path',
              value: { source: 'setting', settings_contribution_id: 'settings-main', key: 'path' },
            }],
            max_attempts: 1,
            timeout_ms: 120_000,
          },
        ],
        edges: [{ from_node_id: 'prepare', to_node_id: 'read' }],
        total_timeout_ms: 240_000,
      },
    },
    {
      kind: 'command',
      contributionId: 'command-prompt',
      name: 'Run Owner Smoke Prompt',
      payload: {
        kind: 'command',
        target_kind: 'prompt',
        target_contribution_id: 'prompt-main',
        inputs: [{
          type: 'string',
          key: 'path',
          label: 'Workspace file',
          default: SMOKE_WORKSPACE_PATH,
          max_length: 240,
        }],
      },
    },
    {
      kind: 'command',
      contributionId: 'command-workflow',
      name: 'Run Owner Smoke Workflow',
      payload: {
        kind: 'command',
        target_kind: 'workflow',
        target_contribution_id: 'workflow-read',
        inputs: [],
      },
    },
    {
      kind: 'mcp_descriptor',
      contributionId: 'mcp-inspect',
      name: 'Owner Smoke MCP Metadata',
      payload: {
        kind: 'mcp_descriptor',
        display_name: 'Owner Smoke MCP Metadata',
        transport_class: 'native_stdio',
        capabilities: ['tools.list'],
      },
    },
  ];
}

export function createOwnerSmokeFixture() {
  const definitions = contributionDefinitions();
  const contentEntries = definitions.map((definition) => {
    const entryPath = `content/${definition.contributionId}.json`;
    const bytes = jsonBytes(content(definition.contributionId, definition.payload));
    return { path: entryPath, bytes, definition };
  });
  const manifest = {
    manifest_schema_version: 2,
    publisher_id: PUBLISHER_ID,
    plugin_id: PLUGIN_ID,
    name: 'Stage 4B Owner Smoke',
    version: PACKAGE_VERSION,
    contract_versions: {
      manifest: 2,
      declarative_content: 2,
      operation_receipt: 1,
      cleanup_state: 1,
    },
    contributions: contentEntries.map(({ path: contentPath, bytes, definition }) => ({
      kind: definition.kind,
      contribution_id: definition.contributionId,
      name: definition.name,
      content_path: contentPath,
      content_sha256: sha256Hex(bytes),
    })),
    requested_permissions: [],
  };
  const payloadEntries = [
    { path: 'plugin.json', bytes: jsonBytes(manifest) },
    ...contentEntries.map(({ path: entryPath, bytes }) => ({ path: entryPath, bytes })),
  ];
  const signedPayload = {
    canonicalization_version: CANONICALIZATION_VERSION,
    publisher_id: PUBLISHER_ID,
    plugin_id: PLUGIN_ID,
    package_version: PACKAGE_VERSION,
    contract_versions: {
      package_semver: PACKAGE_VERSION,
      manifest_schema_version: 2,
      contribution_contract_version: 2,
      capability_abi_version: 1,
      data_schema_version: 1,
    },
    entries: payloadEntries
      .map((entry) => ({ path: entry.path, sha256: sha256Hex(entry.bytes) }))
      .sort((left, right) => compareUtf8(left.path, right.path)),
  };
  return { manifest, payloadEntries, signedPayload };
}

const CRC32_TABLE = Object.freeze(Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
}));

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function validateArchiveEntry(entry) {
  if (!entry || typeof entry.path !== 'string' || !Buffer.isBuffer(entry.bytes)) {
    throw packagerError('invalid_archive_entry', 'The generated package contains an invalid entry.');
  }
  if (
    entry.path.length === 0
    || Buffer.byteLength(entry.path, 'utf8') > 240
    || entry.path.normalize('NFC') !== entry.path
    || entry.path.includes('\\')
    || entry.path.startsWith('/')
    || entry.path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw packagerError('invalid_archive_path', 'The generated package contains an unsafe entry path.');
  }
  if (entry.bytes.length > MAX_ENTRY_BYTES) {
    throw packagerError('entry_budget_exceeded', 'A generated package entry exceeds its size budget.');
  }
}

export function assembleStoredZip(inputEntries) {
  if (!Array.isArray(inputEntries) || inputEntries.length < 1 || inputEntries.length > 32) {
    throw packagerError('entry_count_invalid', 'The generated package entry count is invalid.');
  }
  for (const entry of inputEntries) validateArchiveEntry(entry);
  const entries = inputEntries.map((entry) => ({ path: entry.path, bytes: Buffer.from(entry.bytes) }))
    .sort((left, right) => compareUtf8(left.path, right.path));
  const seen = new Set();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    if (seen.has(entry.path)) {
      throw packagerError('duplicate_archive_path', 'The generated package contains a duplicate entry path.');
    }
    seen.add(entry.path);
    const name = Buffer.from(entry.path, 'utf8');
    const checksum = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(FIXED_DOS_TIME, 10);
    local.writeUInt16LE(FIXED_DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(FIXED_DOS_TIME, 12);
    central.writeUInt16LE(FIXED_DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.bytes.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, name, entry.bytes);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.bytes.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...localParts, centralDirectory, eocd]);
  if (archive.length > MAX_ARCHIVE_BYTES) {
    throw packagerError('archive_budget_exceeded', 'The generated package exceeds its archive size budget.');
  }
  return archive;
}

function keyIdentity(publicKey) {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return sha256Hex(der);
}

export function buildOwnerSmokePackage({ privateKey, expectedKeyId = CURRENT_KEY_ID }) {
  if (!(privateKey instanceof crypto.KeyObject) || privateKey.type !== 'private') {
    throw packagerError('private_key_invalid', 'The signing key is not a private key.');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw packagerError('private_key_type_invalid', 'The signing key must be Ed25519.');
  }
  const publicKey = crypto.createPublicKey(privateKey);
  const actualKeyId = keyIdentity(publicKey);
  if (!/^[0-9a-f]{64}$/.test(expectedKeyId) || actualKeyId !== expectedKeyId) {
    throw packagerError('current_key_mismatch', 'The signing key is not Jenny\'s current jenny-official key.');
  }

  const fixture = createOwnerSmokeFixture();
  const message = canonicalBytes(fixture.signedPayload);
  const signatureBytes = crypto.sign(null, message, privateKey);
  if (signatureBytes.length !== 64 || !crypto.verify(null, message, publicKey, signatureBytes)) {
    throw packagerError('signature_self_check_failed', 'The generated package signature failed its local self-check.');
  }
  const signatureBundle = {
    signature_bundle_version: 1,
    signed_payload: fixture.signedPayload,
    signatures: [{
      algorithm: 'ed25519',
      key_id: actualKeyId,
      canonicalization_version: CANONICALIZATION_VERSION,
      signature: signatureBytes.toString('base64'),
    }],
  };
  const archive = assembleStoredZip([
    ...fixture.payloadEntries,
    { path: SIGNATURE_BUNDLE_PATH, bytes: jsonBytes(signatureBundle) },
  ]);
  return {
    bytes: archive,
    archiveDigest: sha256Hex(archive),
    manifest: fixture.manifest,
    signedPayload: fixture.signedPayload,
    keyId: actualKeyId,
  };
}

function parseArgs(argv) {
  const options = {
    fixture: FIXTURE_NAME,
    privateKeyName: 'jenny-official-ed25519-private.pem',
    outputName: 'stage4b-owner-smoke.jenny-plugin',
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw packagerError('argument_value_missing', 'A command-line option is missing its value.');
    }
    if (token === '--fixture') options.fixture = value;
    else if (token === '--private-key') options.privateKeyName = value;
    else if (token === '--output') options.outputName = value;
    else throw packagerError('argument_unknown', 'An unsupported command-line option was provided.');
    index += 1;
  }
  if (options.fixture !== FIXTURE_NAME) {
    throw packagerError('fixture_unknown', 'Only the stage4b-owner-smoke fixture is supported.');
  }
  if (!SAFE_FILENAME_RE.test(options.privateKeyName) || !SAFE_FILENAME_RE.test(options.outputName)) {
    throw packagerError('filename_invalid', 'Key and output arguments must be plain sibling filenames.');
  }
  if (!options.outputName.toLowerCase().endsWith('.jenny-plugin')) {
    throw packagerError('output_extension_invalid', 'The output filename must end in .jenny-plugin.');
  }
  if (options.privateKeyName === options.outputName) {
    throw packagerError('filename_collision', 'The key and output filenames must be different.');
  }
  return options;
}

function usage() {
  return [
    'Jenny Stage 4B owner package generator',
    '',
    'Place this script beside the private key, then run:',
    '  node .\\jenny-plugin-packager.mjs --private-key KEY.pem --output stage4b-owner-smoke.jenny-plugin',
    '',
    'Options:',
    `  --fixture ${FIXTURE_NAME}`,
    '  --private-key FILENAME   sibling PEM key file',
    '  --output FILENAME        new sibling .jenny-plugin file',
    '  --help',
    '',
    'The output file must not already exist. No key or passphrase is accepted via environment variables.',
  ].join('\n');
}

function siblingPath(directory, filename) {
  const resolvedDirectory = path.resolve(directory);
  const resolved = path.resolve(resolvedDirectory, filename);
  if (path.dirname(resolved) !== resolvedDirectory || path.basename(resolved) !== filename) {
    throw packagerError('path_outside_signing_directory', 'Key and output files must be beside the packager.');
  }
  return resolved;
}

async function hiddenPrompt(question, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY) {
    throw packagerError('encrypted_key_requires_tty', 'An encrypted key requires an interactive terminal.');
  }
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
  try {
    return await new Promise((resolve) => prompt.question('', resolve));
  } finally {
    muted = false;
    output.write('\n');
    prompt.close();
  }
}

async function readPrivateKey(keyPath, readHidden) {
  let handle = null;
  let keyBytes;
  try {
    const before = await fs.promises.lstat(keyPath);
    if (!before.isFile() || before.isSymbolicLink() || before.size === 0
      || before.size > MAX_PRIVATE_KEY_BYTES) throw new Error('unsafe');
    handle = await fs.promises.open(keyPath, 'r');
    const opened = await handle.stat();
    const after = await fs.promises.lstat(keyPath);
    if (!opened.isFile() || after.isSymbolicLink() || opened.size > MAX_PRIVATE_KEY_BYTES
      || opened.dev !== after.dev || opened.ino !== after.ino) throw new Error('unsafe');
    keyBytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < keyBytes.length) {
      const { bytesRead } = await handle.read(keyBytes, offset, keyBytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const afterRead = await handle.stat();
    if (offset !== keyBytes.length || afterRead.size !== opened.size) throw new Error('unsafe');
  } catch (_error) {
    throw packagerError('private_key_unavailable', 'The sibling private-key file is unavailable or unsafe.');
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  const header = keyBytes.subarray(0, Math.min(keyBytes.length, 4096)).toString('ascii');
  const encrypted = /BEGIN ENCRYPTED PRIVATE KEY|Proc-Type:\s*4,ENCRYPTED/i.test(header);
  let passphrase = null;
  try {
    if (encrypted) {
      const answer = await readHidden('Private-key passphrase: ');
      passphrase = Buffer.from(String(answer), 'utf8');
      if (passphrase.length === 0) {
        throw packagerError('private_key_passphrase_empty', 'The private-key passphrase cannot be empty.');
      }
    }
    const privateKey = crypto.createPrivateKey({
      key: keyBytes,
      format: 'pem',
      ...(passphrase ? { passphrase } : {}),
    });
    return privateKey;
  } catch (error) {
    if (error?.code?.startsWith?.('private_key_')) throw error;
    throw packagerError('private_key_parse_failed', 'The private key could not be opened as a PEM key.');
  } finally {
    keyBytes.fill(0);
    if (passphrase) passphrase.fill(0);
  }
}

async function assertOutputAbsent(outputPath) {
  try {
    await fs.promises.lstat(outputPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw packagerError('output_check_failed', 'The output destination could not be checked safely.');
  }
  throw packagerError('output_exists', 'The output file already exists; it was not replaced.');
}

async function publishNoClobber(outputPath, bytes) {
  await assertOutputAbsent(outputPath);
  const directory = path.dirname(outputPath);
  const temporaryPath = path.join(directory, `.jenny-package-${crypto.randomBytes(12).toString('hex')}.partial`);
  let handle = null;
  try {
    handle = await fs.promises.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.link(temporaryPath, outputPath);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw packagerError('output_exists', 'The output file already exists; it was not replaced.');
    }
    if (error?.code?.startsWith?.('output_')) throw error;
    throw packagerError('atomic_publish_failed', 'The package could not be published atomically.');
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temporaryPath).catch(() => {});
  }
}

export async function runCli(argv, {
  scriptDirectory = path.dirname(fileURLToPath(import.meta.url)),
  expectedKeyId = CURRENT_KEY_ID,
  readHidden = (question) => hiddenPrompt(question),
  stdout = process.stdout,
} = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    stdout.write(`${usage()}\n`);
    return { ok: true, help: true };
  }
  const keyPath = siblingPath(scriptDirectory, options.privateKeyName);
  const outputPath = siblingPath(scriptDirectory, options.outputName);
  await assertOutputAbsent(outputPath);
  const privateKey = await readPrivateKey(keyPath, readHidden);
  const result = buildOwnerSmokePackage({ privateKey, expectedKeyId });
  await publishNoClobber(outputPath, result.bytes);
  stdout.write(`Created ${options.outputName}\n`);
  stdout.write(`Package SHA-256: ${result.archiveDigest}\n`);
  return { ok: true, outputName: options.outputName, archiveDigest: result.archiveDigest };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  runCli(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : 'The package generator failed.';
    process.stderr.write(`Packager failed: ${message}\n`);
    process.exitCode = 1;
  });
}
