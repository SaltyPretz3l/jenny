'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assembleZip,
  readLocalFileHeader,
} = require('../../helpers/plugins/hostile-archive-builder');
const {
  LIMITS,
  SIGNATURES,
  validateZipStructure,
} = require('../../../services/plugins/package/zip-structure-validator');

function oneEntry(name = 'plugin.json', data = Buffer.from('{}')) {
  return assembleZip([{ name, data }]).bytes;
}

function findSignature(bytes, signature, start = 0) {
  for (let offset = start; offset <= bytes.length - 4; offset += 1) {
    if (bytes.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

test('valid bounded ZIP32 structure reports exact entry ranges', () => {
  const bytes = oneEntry();
  const result = validateZipStructure(bytes);
  assert.equal(result.ok, true);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].path, 'plugin.json');
  assert.equal(result.totalUncompressedBytes, 2);
  assert.equal(result.eocdOffset + 22, bytes.length);
});

test('encryption, data descriptors, unsupported methods, and directory entries fail closed', () => {
  for (const [label, mutate, reason] of [
    ['encryption', (bytes, central) => { bytes.writeUInt16LE(1, 6); bytes.writeUInt16LE(1, central + 8); }, 'encrypted_entry_rejected'],
    ['descriptor', (bytes, central) => { bytes.writeUInt16LE(8, 6); bytes.writeUInt16LE(8, central + 8); }, 'data_descriptor_rejected'],
    ['method', (bytes, central) => { bytes.writeUInt16LE(99, 8); bytes.writeUInt16LE(99, central + 10); }, 'compression_method_rejected'],
  ]) {
    const bytes = oneEntry();
    const central = findSignature(bytes, SIGNATURES.central);
    mutate(bytes, central);
    assert.equal(validateZipStructure(bytes).reason, reason, label);
  }
  assert.equal(validateZipStructure(oneEntry('folder/')).reason, 'directory_entry_rejected');
});

test('ZIP64, multi-disk, archive comments, and trailing polyglot bytes are rejected', () => {
  const zip64 = oneEntry();
  const zip64Eocd = findSignature(zip64, SIGNATURES.eocd);
  zip64.writeUInt16LE(0xffff, zip64Eocd + 8);
  zip64.writeUInt16LE(0xffff, zip64Eocd + 10);
  assert.equal(validateZipStructure(zip64).reason, 'zip64_rejected');

  const multi = oneEntry();
  const multiEocd = findSignature(multi, SIGNATURES.eocd);
  multi.writeUInt16LE(1, multiEocd + 4);
  assert.equal(validateZipStructure(multi).reason, 'multi_disk_archive_rejected');

  const withComment = Buffer.concat([oneEntry(), Buffer.from('x')]);
  const commentEocd = withComment.length - 23;
  withComment.writeUInt16LE(1, commentEocd + 20);
  assert.equal(validateZipStructure(withComment).reason, 'archive_comment_rejected');

  const trailing = assembleZip([{ name: 'plugin.json', data: Buffer.from('{}') }], {
    trailingBytes: Buffer.from('polyglot'),
  }).bytes;
  assert.equal(validateZipStructure(trailing).reason, 'eocd_missing_or_trailing_bytes');
});

test('unsupported general-purpose flags are rejected in both headers', () => {
  const result = validateZipStructure(assembleZip([{
    name: 'plugin.json',
    data: Buffer.from('{}'),
    generalPurposeBitFlag: 0x0010,
  }]).bytes);
  assert.equal(result.reason, 'unsupported_general_purpose_flags');
});

test('Windows reparse metadata is rejected independently of Unix mode bits', () => {
  const bytes = oneEntry();
  const central = findSignature(bytes, SIGNATURES.central);
  bytes.writeUInt32LE(0x0400, central + 38);
  assert.equal(validateZipStructure(bytes).reason, 'link_or_special_file_rejected');
});

test('central/local disagreement and overlapping entry ranges are rejected before streaming', () => {
  const mismatch = oneEntry();
  const mismatchCentral = findSignature(mismatch, SIGNATURES.central);
  mismatch.writeUInt32LE(123, mismatchCentral + 16);
  assert.equal(validateZipStructure(mismatch).reason, 'central_local_header_mismatch');

  const built = assembleZip([
    { name: 'a.json', data: Buffer.from('a') },
    { name: 'b.json', data: Buffer.from('b') },
  ]);
  const overlap = Buffer.from(built.bytes);
  const first = readLocalFileHeader(overlap, built.localHeaderOffsets[0]);
  const firstCentral = findSignature(overlap, SIGNATURES.central);
  const enlarged = first.compressedSize + 5;
  overlap.writeUInt32LE(enlarged, built.localHeaderOffsets[0] + 18);
  overlap.writeUInt32LE(enlarged, firstCentral + 20);
  assert.equal(validateZipStructure(overlap).reason, 'overlapping_entry_ranges');
});

test('unclaimed bytes between entries or before the central directory are rejected', () => {
  const built = assembleZip([
    { name: 'a.json', data: Buffer.from('a') },
    { name: 'b.json', data: Buffer.from('b') },
  ]);
  const originalCentral = findSignature(built.bytes, SIGNATURES.central);

  const interEntryOffset = built.localHeaderOffsets[1];
  const interEntryGap = Buffer.concat([
    built.bytes.subarray(0, interEntryOffset),
    Buffer.from([0]),
    built.bytes.subarray(interEntryOffset),
  ]);
  const firstCentral = findSignature(interEntryGap, SIGNATURES.central);
  const secondCentral = findSignature(interEntryGap, SIGNATURES.central, firstCentral + 4);
  const interEntryEocd = findSignature(interEntryGap, SIGNATURES.eocd);
  interEntryGap.writeUInt32LE(interEntryOffset + 1, secondCentral + 42);
  interEntryGap.writeUInt32LE(originalCentral + 1, interEntryEocd + 16);
  assert.equal(validateZipStructure(interEntryGap).reason, 'unclaimed_archive_bytes');

  const beforeCentralGap = Buffer.concat([
    built.bytes.subarray(0, originalCentral),
    Buffer.from([0]),
    built.bytes.subarray(originalCentral),
  ]);
  const beforeCentralEocd = findSignature(beforeCentralGap, SIGNATURES.eocd);
  beforeCentralGap.writeUInt32LE(originalCentral + 1, beforeCentralEocd + 16);
  assert.equal(validateZipStructure(beforeCentralGap).reason, 'unclaimed_archive_bytes');
});

test('archive, entry, aggregate, and compression-ratio ceilings are enforced', () => {
  const bytes = oneEntry('large.json', Buffer.alloc(10));
  assert.equal(validateZipStructure(bytes, { limits: { maxArchiveBytes: bytes.length - 1 } }).reason, 'archive_size_budget_exceeded');
  assert.equal(validateZipStructure(bytes, { limits: { maxEntries: 0 } }).reason, 'entry_count_budget_exceeded');
  assert.equal(validateZipStructure(bytes, { limits: { maxEntryUncompressedBytes: 9 } }).reason, 'entry_size_budget_exceeded');
  assert.equal(validateZipStructure(bytes, { limits: { maxTotalUncompressedBytes: 9 } }).reason, 'total_uncompressed_budget_exceeded');

  const ratio = oneEntry('ratio.json', Buffer.alloc(10));
  const central = findSignature(ratio, SIGNATURES.central);
  ratio.writeUInt32LE(1, 18);
  ratio.writeUInt32LE(1, central + 20);
  assert.equal(validateZipStructure(ratio, { limits: { maxCompressionRatio: 5 } }).reason, 'compression_ratio_exceeded');
  assert.equal(LIMITS.maxCompressionRatio, 100);
});
