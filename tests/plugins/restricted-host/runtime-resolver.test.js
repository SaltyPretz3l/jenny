'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  HOST_MANIFEST_FILENAME,
  sha256,
  resolveRestrictedHostRuntime,
} = require('../../../services/plugins/restricted-host/runtime-resolver');

const ROOT = path.resolve('C:/restricted-host-fixture');
const BINARY = Buffer.from('verified restricted host');
const COMMIT = '1'.repeat(40);
const ABI = '2'.repeat(64);
const PROTOCOL = '3'.repeat(64);

function manifest(overrides = {}) {
  return {
    api_version: 1,
    target: 'x86_64-pc-windows-msvc',
    commit: COMMIT,
    wasmtime_version: '47.0.3',
    binary_filename: 'jenny-plugin-host.exe',
    binary_sha256: sha256(BINARY),
    abi_sha256: ABI,
    protocol_sha256: PROTOCOL,
    licenses: ['Apache-2.0 WITH LLVM-exception'],
    sbom_filename: 'jenny-plugin-host.sbom.json',
    ...overrides,
  };
}

function fakeFs(document = manifest(), bytes = BINARY, realBinary = null) {
  const binaryPath = path.join(ROOT, document.binary_filename);
  return {
    readFile: async (candidate, encoding) => {
      if (candidate === path.join(ROOT, HOST_MANIFEST_FILENAME)) {
        return encoding ? JSON.stringify(document) : Buffer.from(JSON.stringify(document));
      }
      if (candidate === binaryPath) return bytes;
      throw new Error('missing');
    },
    realpath: async (candidate) => (
      candidate === ROOT ? ROOT : realBinary || binaryPath
    ),
  };
}

test('resolver admits only an exact target/commit/ABI/protocol and binary digest', async () => {
  const result = await resolveRestrictedHostRuntime({
    fs: fakeFs(), rootDir: ROOT, expectedCommit: COMMIT,
    expectedAbiDigest: ABI, expectedProtocolDigest: PROTOCOL,
    platform: 'win32', arch: 'x64',
  });
  assert.equal(result.ok, true);
  assert.equal(result.binary_digest, sha256(BINARY));

  const stale = await resolveRestrictedHostRuntime({
    fs: fakeFs(), rootDir: ROOT, expectedCommit: '4'.repeat(40),
    expectedAbiDigest: ABI, expectedProtocolDigest: PROTOCOL,
    platform: 'win32', arch: 'x64',
  });
  assert.equal(stale.reason, 'restricted_host_manifest_incompatible');

  const corrupt = await resolveRestrictedHostRuntime({
    fs: fakeFs(manifest(), Buffer.from('tampered')), rootDir: ROOT,
    expectedCommit: COMMIT, expectedAbiDigest: ABI, expectedProtocolDigest: PROTOCOL,
    platform: 'win32', arch: 'x64',
  });
  assert.equal(corrupt.reason, 'restricted_host_binary_digest_mismatch');
});

test('resolver rejects a realpath that escapes the packaged runtime directory', async () => {
  const result = await resolveRestrictedHostRuntime({
    fs: fakeFs(manifest(), BINARY, path.resolve('C:/outside/jenny-plugin-host.exe')),
    rootDir: ROOT, expectedCommit: COMMIT,
    expectedAbiDigest: ABI, expectedProtocolDigest: PROTOCOL,
    platform: 'win32', arch: 'x64',
  });
  assert.equal(result.reason, 'restricted_host_binary_escape_rejected');
});
