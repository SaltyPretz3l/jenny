'use strict';

// new-test-file: services/gguf-place.js is a new module (extracted from Move and add, row 123 slice 6-4).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPlaceFile, noHardLinkCodes } = require('../services/gguf-place');

const SUFFIX = '.jenny-moving';

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-gguf-place-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const from = path.join(dir, 'src', 'model.gguf');
  const to = path.join(dir, 'dst', 'model.gguf');
  fs.mkdirSync(path.dirname(from));
  fs.mkdirSync(path.dirname(to));
  fs.writeFileSync(from, 'weights');
  const logs = [];
  const fsImpl = { ...fs, ...overrides };
  const placeFile = createPlaceFile({
    fs: fsImpl, platform: process.platform, stagedSuffix: SUFFIX, restoreFailedEvent: 'test.restore_failed',
    log: (...entry) => logs.push(entry),
  });
  return { dir, from, to, placeFile, logs, fsImpl };
}

test('links into place, then unlinks the staged name', (t) => {
  const calls = [];
  const { from, to, placeFile } = setup(t, {
    linkSync: (a, b) => { calls.push(['link', path.basename(a), path.basename(b)]); return fs.linkSync(a, b); },
    unlinkSync: (a) => { calls.push(['unlink', path.basename(a)]); return fs.unlinkSync(a); },
  });
  placeFile(from, to);
  assert.equal(fs.readFileSync(to, 'utf8'), 'weights');
  assert.equal(fs.existsSync(from), false);
  assert.equal(fs.existsSync(`${from}${SUFFIX}`), false);
  assert.equal(fs.statSync(to).nlink, 1);
  assert.deepEqual(calls, [['link', `model.gguf${SUFFIX}`, 'model.gguf'], ['unlink', `model.gguf${SUFFIX}`]]);
});

test('a target that exists answers EEXIST and the source is put back untouched', (t) => {
  const { from, to, placeFile } = setup(t);
  fs.writeFileSync(to, 'theirs');
  assert.throws(() => placeFile(from, to), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(to, 'utf8'), 'theirs');
  assert.equal(fs.readFileSync(from, 'utf8'), 'weights');
  assert.equal(fs.existsSync(`${from}${SUFFIX}`), false);
});

test('a leftover staged name answers EEXIST before anything moves', (t) => {
  const { from, to, placeFile } = setup(t);
  fs.writeFileSync(`${from}${SUFFIX}`, 'leftover');
  assert.throws(() => placeFile(from, to), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(from, 'utf8'), 'weights');
  assert.equal(fs.readFileSync(`${from}${SUFFIX}`, 'utf8'), 'leftover');
  assert.equal(fs.existsSync(to), false);
});

test('a source held open answers EINUSE and nothing moves', (t) => {
  const { from, to, placeFile } = setup(t, {
    renameSync: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); },
  });
  assert.throws(() => placeFile(from, to), { code: 'EINUSE' });
  assert.equal(fs.existsSync(from), true);
  assert.equal(fs.existsSync(to), false);
});

for (const code of noHardLinkCodes(process.platform)) {
  test(`a volume with no hard links (${code}) falls back to a checked rename`, (t) => {
    const { from, to, placeFile } = setup(t, {
      linkSync: () => { throw Object.assign(new Error('no links'), { code }); },
    });
    placeFile(from, to);
    assert.equal(fs.readFileSync(to, 'utf8'), 'weights');
    assert.equal(fs.existsSync(from), false);
    assert.equal(fs.existsSync(`${from}${SUFFIX}`), false);
  });
}

test('the rename fallback still refuses a target that exists', (t) => {
  const { from, to, placeFile } = setup(t, {
    linkSync: () => { throw Object.assign(new Error('no links'), { code: 'EPERM' }); },
  });
  fs.writeFileSync(to, 'theirs');
  assert.throws(() => placeFile(from, to), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(to, 'utf8'), 'theirs');
  assert.equal(fs.readFileSync(from, 'utf8'), 'weights');
});

test('a cross-device link (EXDEV) is thrown for the caller to copy, with the source put back', (t) => {
  const { from, to, placeFile } = setup(t, {
    linkSync: () => { throw Object.assign(new Error('cross'), { code: 'EXDEV' }); },
  });
  assert.throws(() => placeFile(from, to), { code: 'EXDEV' });
  assert.equal(fs.readFileSync(from, 'utf8'), 'weights');
  assert.equal(fs.existsSync(to), false);
});

test('a failure after the link rolls back: the target is removed and the source restored', (t) => {
  let unlinks = 0;
  const { from, to, placeFile } = setup(t, {
    unlinkSync: (target) => {
      unlinks += 1;
      if (unlinks === 1) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
      return fs.unlinkSync(target);
    },
  });
  assert.throws(() => placeFile(from, to), { code: 'EBUSY' });
  assert.equal(fs.existsSync(to), false);
  assert.equal(fs.readFileSync(from, 'utf8'), 'weights');
  assert.equal(fs.existsSync(`${from}${SUFFIX}`), false);
});

test('a failed restore is logged by code only, under the caller\'s event', (t) => {
  const { from, to, placeFile, logs, dir } = setup(t, {
    unlinkSync: () => { throw Object.assign(new Error(`locked ${dir}`), { code: 'EBUSY' }); },
  });
  assert.throws(() => placeFile(from, to), { code: 'EBUSY' });
  assert.deepEqual(logs, [['WARN', 'test.restore_failed', { code: 'EBUSY' }]]);
  assert.equal(JSON.stringify(logs).includes('model.gguf'), false);
});
