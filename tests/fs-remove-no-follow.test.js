'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeFile, removeFileSync, removeTree, removeTreeSync } = require('../services/fs-remove-no-follow');

function sandbox(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-remove-no-follow-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const outside = path.join(temp, 'outside');
  fs.mkdirSync(path.join(outside, 'deep'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'keep'), 'untouched');
  fs.writeFileSync(path.join(outside, 'deep', 'keep'), 'untouched');
  const tree = path.join(temp, 'tree');
  fs.mkdirSync(path.join(tree, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'a', 'b', 'file'), 'remove me');
  fs.writeFileSync(path.join(tree, 'top'), 'remove me');
  fs.symlinkSync(outside, path.join(tree, 'link'), 'junction');
  fs.symlinkSync(outside, path.join(tree, 'a', 'b', 'nested-link'), 'junction');
  return { temp, outside, tree };
}

function assertOutsideIntact(outside) {
  assert.deepEqual(fs.readdirSync(outside).sort(), ['deep', 'keep']);
  assert.equal(fs.readFileSync(path.join(outside, 'deep', 'keep'), 'utf8'), 'untouched');
}

const isLink = (file) => { try { return fs.lstatSync(file).isSymbolicLink(); } catch (_error) { return false; } };
const eperm = () => Object.assign(new Error('transient lock'), { code: 'EPERM' });

// Every link fails its first unlink, as a briefly held junction does on Windows.
function flakyLinkFs(failed) {
  return {
    ...fs,
    unlinkSync(file) {
      if (isLink(file) && !failed.has(file)) { failed.add(file); throw eperm(); }
      return fs.unlinkSync(file);
    },
    promises: {
      ...fs.promises,
      async unlink(file) {
        if (isLink(file) && !failed.has(file)) { failed.add(file); throw eperm(); }
        return fs.promises.unlink(file);
      },
    },
  };
}

for (const [name, run] of [['async', (target, options) => removeTree(target, options)],
  ['sync', async (target, options) => removeTreeSync(target, options)]]) {
  test(`${name}: removes a tree, unlinking junctions without entering them`, async (t) => {
    const { outside, tree } = sandbox(t);
    await run(tree);
    assert.equal(fs.existsSync(tree), false);
    assertOutsideIntact(outside);
  });

  test(`${name}: a transient EPERM on a junction is retried, never followed`, async (t) => {
    const { outside, tree } = sandbox(t);
    const failed = new Set();
    await run(tree, { fsImpl: flakyLinkFs(failed), retryDelayMs: 1 });
    assert.deepEqual([...failed].sort(), [path.join(tree, 'a', 'b', 'nested-link'), path.join(tree, 'link')].sort());
    assert.equal(fs.existsSync(tree), false);
    assertOutsideIntact(outside);
  });

  test(`${name}: a junction as the target is removed alone`, async (t) => {
    const { outside, temp } = sandbox(t);
    const link = path.join(temp, 'top-link');
    fs.symlinkSync(outside, link, 'junction');
    await run(link, { fsImpl: flakyLinkFs(new Set()), retryDelayMs: 1 });
    assert.equal(isLink(link) || fs.existsSync(link), false);
    assertOutsideIntact(outside);
  });

  test(`${name}: missing targets and files are fine, and read-only files are removed`, async (t) => {
    const { temp } = sandbox(t);
    await run(path.join(temp, 'missing'));
    const file = path.join(temp, 'read-only');
    fs.writeFileSync(file, 'x');
    fs.chmodSync(file, 0o444);
    await run(file);
    assert.equal(fs.existsSync(file), false);
    const dir = path.join(temp, 'read-only-dir');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'child'), 'x');
    fs.chmodSync(path.join(dir, 'child'), 0o444);
    await run(dir);
    assert.equal(fs.existsSync(dir), false);
  });

  test(`${name}: persistent non-transient errors propagate`, async (t) => {
    const { tree } = sandbox(t);
    const denied = Object.assign(new Error('denied'), { code: 'EINVAL' });
    const fsImpl = { ...fs, unlinkSync() { throw denied; },
      promises: { ...fs.promises, async unlink() { throw denied; } } };
    await assert.rejects(run(tree, { fsImpl, retryDelayMs: 1 }), (error) => error === denied);
  });
}

test('async: an entry created after the first listing is removed on the retry', async (t) => {
  const { outside, tree } = sandbox(t);
  let created = false;
  const fsImpl = { ...fs, promises: { ...fs.promises,
    async readdir(dir) {
      const names = await fs.promises.readdir(dir);
      if (dir === tree && !created) { created = true; fs.writeFileSync(path.join(tree, 'late'), 'late writer'); }
      return names;
    } } };
  await removeTree(tree, { fsImpl, retryDelayMs: 1 });
  assert.equal(created, true);
  assert.equal(fs.existsSync(tree), false);
  assertOutsideIntact(outside);
});

test('a promises-shaped fs object is accepted and retries are bounded', async (t) => {
  const { tree } = sandbox(t);
  let attempts = 0;
  const fsp = { ...fs.promises, async unlink(file) {
    if (file === path.join(tree, 'top')) { attempts += 1; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }
    return fs.promises.unlink(file);
  } };
  await assert.rejects(removeTree(tree, { fsImpl: fsp, retries: 2, retryDelayMs: 1 }), { code: 'EBUSY' });
  assert.equal(attempts, 3);
});

for (const [name, run] of [['async', (target, options) => removeFile(target, options)],
  ['sync', async (target, options) => removeFileSync(target, options)]]) {
  test(`${name} removeFile: keeps non-recursive rm semantics without following a link`, async (t) => {
    const { outside, temp, tree } = sandbox(t);
    await run(path.join(temp, 'missing'));
    await run(path.join(tree, 'top'));
    assert.equal(fs.existsSync(path.join(tree, 'top')), false);
    await assert.rejects(run(tree), (error) => error.code === 'ERR_FS_EISDIR' && error.path === tree
      && !error.message.includes(tree));
    assert.equal(fs.existsSync(path.join(tree, 'a', 'b', 'file')), true);
    const link = path.join(tree, 'link');
    await run(link, { fsImpl: flakyLinkFs(new Set()), retryDelayMs: 1 });
    assert.equal(isLink(link), false);
    assertOutsideIntact(outside);
  });
}

const fileStat = fs.lstatSync(__filename);

for (const [name, run] of [['async', (target, options) => removeFile(target, options)],
  ['sync', async (target, options) => removeFileSync(target, options)]]) {
  test(`${name} removeFile: a directory that replaced the file after the lstat is never emptied`, async (t) => {
    const { tree } = sandbox(t);
    // Only the first lstat sees a file, as when a directory replaces it right after that check.
    let lies = 1;
    const lie = (file, real) => (file === tree && lies-- > 0 ? fileStat : real(file));
    const lied = { ...fs, lstatSync: (file) => lie(file, fs.lstatSync),
      promises: { ...fs.promises, lstat: async (file) => lie(file, fs.promises.lstat) } };
    await assert.rejects(run(tree, { fsImpl: lied, retryDelayMs: 1 }));
    assert.equal(fs.readFileSync(path.join(tree, 'a', 'b', 'file'), 'utf8'), 'remove me');
  });
}

for (const [name, run] of [['async', (target, options) => removeTree(target, options)],
  ['sync', async (target, options) => removeTreeSync(target, options)]]) {
  test(`${name}: an empty directory that cannot be listed is still removed`, async (t) => {
    const { temp } = sandbox(t);
    const empty = path.join(temp, 'unlistable');
    fs.mkdirSync(empty);
    const denied = () => Object.assign(new Error('listing denied'), { code: 'EACCES' });
    const fsImpl = { ...fs, readdirSync() { throw denied(); },
      promises: { ...fs.promises, async readdir() { throw denied(); } } };
    await run(empty, { fsImpl });
    assert.equal(fs.existsSync(empty), false);
  });
}

test('sync retries do not sleep unless the caller asks', (t) => {
  const { tree } = sandbox(t);
  let attempts = 0;
  const fsImpl = { ...fs, unlinkSync() { attempts += 1; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } };
  const started = Date.now();
  assert.throws(() => removeFileSync(path.join(tree, 'top'), { fsImpl }), { code: 'EBUSY' });
  assert.equal(attempts, 4);
  assert.equal(Date.now() - started < 100, true);
});

test('async: a directory swapped for a junction before its listing is unlinked, not entered', async (t) => {
  const { outside, tree } = sandbox(t);
  let swapped = false;
  const fsImpl = { ...fs, promises: { ...fs.promises, async rmdir(dir) {
    if (dir === tree && !swapped) {
      swapped = true;
      fs.renameSync(tree, `${tree}-real`);
      fs.symlinkSync(outside, tree, 'junction');
      throw Object.assign(new Error('not empty'), { code: 'ENOTEMPTY' });
    }
    return fs.promises.rmdir(dir);
  } } };
  await removeTree(tree, { fsImpl, retryDelayMs: 1 });
  assert.equal(swapped, true);
  assert.equal(isLink(tree) || fs.existsSync(tree), false);
  assertOutsideIntact(outside);
});
