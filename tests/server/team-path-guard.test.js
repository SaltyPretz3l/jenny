'use strict';

// Team slice 1e: the reparse-point guard the hosted stores use because
// `durable-json.js` follows junctions on Windows (no O_NOFOLLOW there).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { HOST_ERROR_CODES } = require('../../services/backend/error-codes');
const { IS_WINDOWS, fileSymlinkSkip, linkDirectory } = require('../helpers/platform-skips');
const { assertSafeDirectory, assertSafeFile } = require('../../services/host/path-guard');

function fixture(t) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-path-guard-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const unsafe = (error) => error.code === HOST_ERROR_CODES.CONFLICT && error.reason === 'unsafe_path';

test('a plain directory passes, with or without a trailing separator', (t) => {
  const root = fixture(t);
  assertSafeDirectory(root);
  assertSafeDirectory(`${root}${path.sep}`);
  const nested = path.join(root, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  assertSafeDirectory(nested);
});

test('Windows spellings that differ only in letter case pass', { skip: IS_WINDOWS ? false : 'Windows only: case-insensitive paths' }, (t) => {
  const root = fixture(t);
  assertSafeDirectory(root.toUpperCase());
  assertSafeDirectory(root.toLowerCase());
});

test('a missing path and a file are not a safe directory', (t) => {
  const root = fixture(t);
  assert.throws(() => assertSafeDirectory(path.join(root, 'absent')), unsafe);
  fs.writeFileSync(path.join(root, 'plain.txt'), 'x');
  assert.throws(() => assertSafeDirectory(path.join(root, 'plain.txt')), unsafe);
  assert.throws(() => assertSafeDirectory(''), unsafe);
});

test('a directory link or junction is refused, as the directory itself or anywhere above it', (t) => {
  const root = fixture(t);
  const target = path.join(root, 'target');
  fs.mkdirSync(path.join(target, 'inner'), { recursive: true });
  const link = path.join(root, 'link');
  linkDirectory(target, link);
  assert.throws(() => assertSafeDirectory(link), unsafe);
  assert.throws(() => assertSafeDirectory(path.join(link, 'inner')), unsafe, 'a link in an ancestor changes the real path');
  assertSafeDirectory(target);
});

test('a regular file passes and a missing file is allowed', (t) => {
  const root = fixture(t);
  const file = path.join(root, 'members.json');
  assertSafeFile(file);
  fs.writeFileSync(file, '{}');
  assertSafeFile(file);
});

test('a file whose parent is missing, a link or a junction is refused', (t) => {
  const root = fixture(t);
  assert.throws(() => assertSafeFile(path.join(root, 'absent', 'members.json')), unsafe);
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'members.json'), '{}');
  const link = path.join(root, 'link');
  linkDirectory(target, link);
  assert.throws(() => assertSafeFile(path.join(link, 'members.json')), unsafe);
});

test('a directory or a junction in place of a store file is refused', (t) => {
  const root = fixture(t);
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  fs.mkdirSync(path.join(root, 'members.json'));
  assert.throws(() => assertSafeFile(path.join(root, 'members.json')), unsafe);
  const junction = path.join(root, 'audit.json');
  linkDirectory(target, junction);
  assert.throws(() => assertSafeFile(junction), unsafe);
});

test('a symbolic link to a file is refused', { skip: fileSymlinkSkip() }, (t) => {
  const root = fixture(t);
  const target = path.join(root, 'real.json');
  fs.writeFileSync(target, '{}');
  const link = path.join(root, 'members.json');
  fs.symlinkSync(target, link, 'file');
  assert.throws(() => assertSafeFile(link), unsafe);
  assertSafeFile(target);
});

test('a file with a second hard link is refused', (t) => {
  const root = fixture(t);
  const file = path.join(root, 'members.json');
  fs.writeFileSync(file, '{}');
  fs.linkSync(file, path.join(root, 'alias.json'));
  assert.throws(() => assertSafeFile(file), unsafe);
  fs.rmSync(path.join(root, 'alias.json'));
  assertSafeFile(file);
});
