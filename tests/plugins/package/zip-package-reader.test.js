'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SIGNATURES } = require('../../../services/plugins/package/zip-structure-validator');
const { readZipPackage } = require('../../../services/plugins/package/zip-package-reader');
const { buildSignedPluginPackage, sha256Hex } = require('../../helpers/plugins/zip-fixture-builder');

function findSignature(bytes, signature) {
  for (let offset = 0; offset <= bytes.length - 4; offset += 1) {
    if (bytes.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

test('reader streams real ZIP bytes, verifies CRC/size, and exposes digests without extraction', async () => {
  const fixture = buildSignedPluginPackage();
  const capturePaths = fixture.archiveEntries.map((entry) => entry.name);
  const result = await readZipPackage(fixture.bytes, { capturePaths });
  assert.equal(result.ok, true);
  assert.deepEqual(result.entries.map((entry) => entry.path), [
    'plugin.json',
    'content/skill-main.json',
    'META-JENNY/signature-bundle.json',
  ]);
  assert.equal(result.archiveDigest, sha256Hex(fixture.bytes));
  assert.equal(await result.digestOf('plugin.json'), sha256Hex(result.bytesOf('plugin.json')));
  assert.equal(result.bytesOf('missing.json'), null);
  assert.equal(result.entryCount, 3);
});

test('reader accepts bounded raw-deflate entries and reconstructs their exact bytes', async () => {
  const fixture = buildSignedPluginPackage({ compressionMethod: 8 });
  const result = await readZipPackage(fixture.bytes, { capturePaths: ['plugin.json'] });

  assert.equal(result.ok, true);
  assert.equal(result.entries.every((entry) => entry.compressionMethod === 8), true);
  assert.deepEqual(JSON.parse(result.bytesOf('plugin.json').toString('utf8')), fixture.manifest);
});

test('capture budget does not weaken streaming digest or size verification', async () => {
  const fixture = buildSignedPluginPackage();
  const result = await readZipPackage(fixture.bytes, {
    capturePaths: ['plugin.json'],
    maxCapturedEntryBytes: 0,
  });
  assert.equal(result.ok, true);
  assert.match(await result.digestOf('plugin.json'), /^[0-9a-f]{64}$/);
  assert.equal(result.bytesOf('plugin.json'), null);
  assert.equal(result.totalUncompressedBytes > 0, true);
  assert.equal((await readZipPackage(fixture.bytes, { maxCapturedEntryBytes: -1 })).reason, 'invalid_capture_budget');
});

test('capture is opt-in and the aggregate budget bounds retained expanded bytes', async () => {
  const fixture = buildSignedPluginPackage({
    extraEntries: Object.fromEntries(
      Array.from({ length: 12 }, (_unused, index) => [`content/extra-${index}.json`, 'x'.repeat(1024)])
    ),
  });
  const none = await readZipPackage(fixture.bytes);
  assert.equal(none.ok, true);
  assert.equal(none.totalCapturedBytes, 0);
  assert.equal(none.bytesOf('plugin.json'), null);

  const selected = fixture.archiveEntries.map((entry) => entry.name);
  const bounded = await readZipPackage(fixture.bytes, {
    capturePaths: selected,
    maxCapturedEntryBytes: 2048,
    maxTotalCapturedBytes: 4096,
  });
  assert.equal(bounded.ok, true);
  assert.ok(bounded.totalCapturedBytes <= 4096);
  assert.ok([...bounded.bytesByPath.values()].reduce((sum, value) => sum + value.length, 0) <= 4096);
});

test('a CRC lie repeated in both headers passes structure but fails measured stream evidence', async () => {
  const fixture = buildSignedPluginPackage();
  const bytes = Buffer.from(fixture.bytes);
  const central = findSignature(bytes, SIGNATURES.central);
  const falseCrc = (bytes.readUInt32LE(14) + 1) >>> 0;
  bytes.writeUInt32LE(falseCrc, 14);
  bytes.writeUInt32LE(falseCrc, central + 16);
  const result = await readZipPackage(bytes);
  assert.equal(result.ok, false);
  assert.ok(['crc32_mismatch', 'entry_stream_failed'].includes(result.reason), result.reason);
});

test('trailing bytes and central/local size disagreement are refused before yauzl runs', async () => {
  const fixture = buildSignedPluginPackage();
  const trailing = Buffer.concat([fixture.bytes, Buffer.from('tail')]);
  assert.equal((await readZipPackage(trailing)).reason, 'eocd_missing_or_trailing_bytes');

  const mismatch = Buffer.from(fixture.bytes);
  const central = findSignature(mismatch, SIGNATURES.central);
  mismatch.writeUInt32LE(mismatch.readUInt32LE(central + 24) + 1, central + 24);
  assert.equal((await readZipPackage(mismatch)).reason, 'central_local_header_mismatch');
});
