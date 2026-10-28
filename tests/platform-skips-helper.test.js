'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const skips = require('./helpers/platform-skips');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-platform-skips-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('platform predicates return false or a reason naming the platform', () => {
  assert.equal(skips.windowsOnly('named pipes'), skips.IS_WINDOWS ? false : 'Windows only: named pipes');
  assert.equal(skips.posixOnly('dir_fd'), skips.IS_WINDOWS ? 'POSIX only: dir_fd' : false);
  assert.equal(skips.linuxOnly('flock'), process.platform === 'linux' ? false : 'Linux only: flock');
});

test('linkDirectory reaches the target and reads back as a link', (t) => {
  const root = tempDir(t);
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'inside.txt'), 'hi');
  const link = path.join(root, 'link');

  skips.linkDirectory(target, link);

  assert.equal(fs.readFileSync(path.join(link, 'inside.txt'), 'utf8'), 'hi');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(link), fs.realpathSync(target));
});

test('linkDirectory throws instead of skipping when the link path is taken', (t) => {
  const root = tempDir(t);
  const target = path.join(root, 'target');
  const occupied = path.join(root, 'occupied');
  fs.mkdirSync(target);
  fs.mkdirSync(occupied);

  assert.throws(() => skips.linkDirectory(target, occupied), { code: 'EEXIST' });
});

test('fileSymlinkSkip matches a real file symlink attempt', (t) => {
  const root = tempDir(t);
  const target = path.join(root, 't.txt');
  fs.writeFileSync(target, '');
  let refused = false;
  try {
    fs.symlinkSync(target, path.join(root, 'l.txt'), 'file');
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    refused = true;
  }

  assert.equal(skips.fileSymlinkSkip(), refused ? skips.FILE_SYMLINK_REASON : false);
});
