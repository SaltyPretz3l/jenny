'use strict';

// Slice 3-8a, T2: the upload manifest. Every cap at its edge and one past it,
// duplicates by case and by Unicode normalization, file-and-directory
// collisions, malformed hashes and unknown keys.

const assert = require('node:assert/strict');
const test = require('node:test');

const { ERROR_CODES } = require('../../server/api-contract');
const { TRANSFER_LIMITS, validateManifest } = require('../../server/team/transfer-manifest');

const HASH = 'a'.repeat(64);
const MIB = 1024 * 1024;

function file(path, size = 1, sha256 = HASH) {
  return { path, size, sha256 };
}

function many(count, size = 0) {
  return Array.from({ length: count }, (_, index) => file(`d${Math.floor(index / 1000)}/f${index}`, size));
}

function refused(result, kind, reason) {
  assert.equal(result.ok, false, `expected ${reason}`);
  assert.equal(result.error.code, ERROR_CODES[kind]);
  assert.equal(result.error.reason, reason);
}

test('the defaults are the E26 caps', () => {
  assert.equal(TRANSFER_LIMITS.maxFileBytes, 64 * MIB);
  assert.equal(TRANSFER_LIMITS.maxUploadBytes, 512 * MIB);
  assert.equal(TRANSFER_LIMITS.maxFiles, 10_000);
  assert.equal(TRANSFER_LIMITS.maxPartBytes, 4 * MIB);
  assert.equal(TRANSFER_LIMITS.maxUploadsPerOwner, 2);
  assert.equal(TRANSFER_LIMITS.idleMs, 60 * 60 * 1000);
  assert.ok(Number.isSafeInteger(TRANSFER_LIMITS.maxUploads) && TRANSFER_LIMITS.maxUploads >= 2);
  assert.equal(TRANSFER_LIMITS.maxReservedBytes, 2 * 1024 * MIB);
  assert.ok(Object.isFrozen(TRANSFER_LIMITS));
});

test('a valid manifest answers frozen copies and the total', () => {
  const input = [file('src/a.js', 10), file('src/b.js', 0, 'b'.repeat(64)), file('README.md', 5)];
  const result = validateManifest(input);
  assert.equal(result.ok, true);
  assert.equal(result.totalBytes, 15);
  assert.deepEqual(result.files, input);
  assert.notEqual(result.files[0], input[0]);
  assert.ok(Object.isFrozen(result.files) && Object.isFrozen(result.files[0]));
});

// ------------------------------------------------------------------ caps

test('file count: 10,000 is accepted and 10,001 is refused', () => {
  assert.equal(validateManifest(many(10_000)).ok, true);
  refused(validateManifest(many(10_001)), 'limit', 'team_upload_file_limit');
});

test('file count under a lower caller limit: at the edge and one past', () => {
  assert.equal(validateManifest(many(3), { maxFiles: 3 }).ok, true);
  refused(validateManifest(many(4), { maxFiles: 3 }), 'limit', 'team_upload_file_limit');
});

test('file size: 64 MiB is accepted and one byte more is refused', () => {
  assert.equal(validateManifest([file('big.bin', 64 * MIB)]).ok, true);
  refused(validateManifest([file('big.bin', 64 * MIB + 1)]), 'limit', 'team_upload_size_limit');
});

test('upload size: 512 MiB is accepted and one byte more is refused', () => {
  const full = Array.from({ length: 8 }, (_, index) => file(`part${index}.bin`, 64 * MIB));
  const atEdge = validateManifest(full);
  assert.equal(atEdge.ok, true);
  assert.equal(atEdge.totalBytes, 512 * MIB);
  refused(validateManifest([...full, file('one-more.bin', 1)]), 'limit', 'team_upload_size_limit');
});

test('a caller limit above the default never raises a cap', () => {
  refused(validateManifest([file('big.bin', 65 * MIB)], { maxFileBytes: 1e12 }), 'limit', 'team_upload_size_limit');
  refused(validateManifest(many(10_001), { maxFiles: 1e9 }), 'limit', 'team_upload_file_limit');
  const full = Array.from({ length: 9 }, (_, index) => file(`part${index}.bin`, 64 * MIB));
  refused(validateManifest(full, { maxUploadBytes: 1e12 }), 'limit', 'team_upload_size_limit');
});

test('a lower caller total is honoured at its edge and one past', () => {
  const limits = { maxUploadBytes: 100 };
  assert.equal(validateManifest([file('a', 60), file('b', 40)], limits).ok, true);
  refused(validateManifest([file('a', 60), file('b', 41)], limits), 'limit', 'team_upload_size_limit');
});

test('an empty manifest or a non-array is invalid', () => {
  for (const value of [[], undefined, null, {}, 'a', { length: 1, 0: file('a') }]) {
    refused(validateManifest(value), 'invalid', 'team_upload_manifest_invalid');
  }
});

// ------------------------------------------------------------------ records

test('an entry with an unknown or a missing key is invalid', () => {
  refused(validateManifest([{ ...file('a'), mode: 0o644 }]), 'invalid', 'team_upload_manifest_invalid');
  refused(validateManifest([{ path: 'a', size: 1 }]), 'invalid', 'team_upload_manifest_invalid');
  refused(validateManifest([null]), 'invalid', 'team_upload_manifest_invalid');
  refused(validateManifest([['a', 1, HASH]]), 'invalid', 'team_upload_manifest_invalid');
  const inherited = Object.create({ extra: 1 });
  Object.assign(inherited, file('a'));
  refused(validateManifest([inherited]), 'invalid', 'team_upload_manifest_invalid');
});

test('a malformed hash is invalid', () => {
  for (const sha256 of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), '', 7, null, ` ${'a'.repeat(63)}`]) {
    refused(validateManifest([file('a', 1, sha256)]), 'invalid', 'team_upload_manifest_invalid');
  }
});

test('a size that is not a non-negative safe integer is invalid', () => {
  for (const size of [-1, 1.5, '1', null, Number.NaN, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
    refused(validateManifest([file('a', size)]), 'invalid', 'team_upload_manifest_invalid');
  }
});

test('a path refused by the segment rules answers team_project_path_invalid', () => {
  for (const path of ['../a', '/etc/passwd', 'C:/a', 'a\\b', 'CON', 'a.', 'a/b ', 'a\u0000', 7]) {
    refused(validateManifest([file(path)]), 'invalid', 'team_project_path_invalid');
  }
});

test('E69: a path with a sensitive segment at any depth answers team_project_path_invalid; other dot names pass', () => {
  for (const path of ['.git/config', '.GIT/HEAD', 'src/.github/workflows/ci.yml', 'a/.VSCode/tasks.json', '.env',
    'deep/er/.env', '.jenny/memory.json']) {
    refused(validateManifest([file('ok.txt'), file(path)]), 'invalid', 'team_project_path_invalid');
  }
  const kept = validateManifest([file('.gitignore'), file('.editorconfig'), file('src/.envrc'), file('.env.local')]);
  assert.equal(kept.ok, true, JSON.stringify(kept));
});

// ------------------------------------------------------------------ collisions

test('duplicate paths are refused exactly, by case and by Unicode normalization', () => {
  const duplicates = [
    ['src/a.js', 'src/a.js'],
    ['README.md', 'readme.MD'],
    ['Src/A.js', 'src/a.js'],
    ['caf\u00e9.txt', 'cafe\u0301.txt'],
    ['CAF\u00c9/x', 'cafe\u0301/x'],
    // Final sigma: 'A\u03a3' lower-cases to a final '\u03c2', NTFS upper-cases both to '\u03a3'.
    ['A\u03a3', 'a\u03c3'],
    ['a\u03c2.txt', 'A\u03a3.TXT'],
    // Dotless i upper-cases to 'I'.
    ['\u0131', 'I'],
    // A false collision is acceptable and stays refused.
    ['stra\u00dfe', 'strasse'],
  ];
  for (const [left, right] of duplicates) {
    refused(validateManifest([file(left), file(right)]), 'invalid', 'team_upload_manifest_invalid');
  }
});

test('a path that is both a file and a directory of another entry is refused, in either order', () => {
  refused(validateManifest([file('src'), file('src/a.js')]), 'invalid', 'team_upload_manifest_invalid');
  refused(validateManifest([file('src/a.js'), file('src')]), 'invalid', 'team_upload_manifest_invalid');
  refused(validateManifest([file('a/b/c'), file('A/B')]), 'invalid', 'team_upload_manifest_invalid');
  assert.equal(validateManifest([file('src/a.js'), file('src/b.js'), file('srcx')]).ok, true);
});

test('a failure never echoes a path or a hash', () => {
  const result = validateManifest([file('secret-dir/name.txt'), file('Secret-Dir/NAME.txt', 1, 'c'.repeat(64))]);
  const text = JSON.stringify(result);
  assert.equal(/secret|name\.txt|cccc/iu.test(text), false);
  assert.deepEqual(Object.keys(result.error).sort(), ['code', 'reason', 'retryable']);
});
