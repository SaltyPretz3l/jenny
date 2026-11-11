'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { stageMirrorSync } = require('../services/execution/sandbox-mirror-sync');
const { applyWriteBack, readOutbox, WRITE_BACK_LIMITS } = require('../services/execution/sandbox-write-back');

const JOB = '11111111-2222-4333-8444-555555555555';
const sha = (text) => createHash('sha256').update(text).digest('hex');
async function write(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-write-back-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace');
  await write(path.join(root, 'a.txt'), 'alpha');
  await write(path.join(root, 'del.txt'), 'delete me');
  await write(path.join(root, 'src', 'keep.js'), 'keep');
  await write(path.join(root, '.git', 'config'), '[core]\n\thooksPath = tools/hooks\n');
  await write(path.join(root, '.husky', 'pre-commit'), 'npm test\n');
  await write(path.join(root, 'tools', 'hooks', 'h.sh'), '#!/bin/sh\n');
  await fs.mkdir(path.join(root, 'olddir'));
  const stage = await stageMirrorSync({ root, stagingRoot: path.join(base, 'staging'), indexFile: path.join(base, 'index.json') });
  const outbox = path.join(base, 'outbox');
  await fs.mkdir(path.join(outbox, 'files'), { recursive: true });
  let next = 0;
  // Builds changes.json; an entry with `text` gets its bytes written as an outbox file.
  async function changes(entries, extra = {}) {
    const listed = [];
    for (const entry of entries) {
      const { text, ...rest } = entry;
      if (text !== undefined) {
        const file = String(next++);
        await fs.writeFile(path.join(outbox, 'files', file), text);
        listed.push({ kind: 'file', file, size: Buffer.byteLength(text), sha256: sha(text), ...rest });
      } else listed.push({ kind: 'file', ...rest });
    }
    await fs.writeFile(path.join(outbox, 'changes.json'), JSON.stringify({ schema_version: 1, job_id: JOB, status: 'ok', entries: listed, ...extra }));
  }
  return { base, root, stage, outbox, changes };
}
const run = (setup, options = {}) => applyWriteBack({ root: setup.root, outbox: setup.outbox, jobId: JOB, stage: setup.stage, ...options });
const reasons = (result) => Object.fromEntries(result.refused.map((item) => [item.path, item.reason]));

test('added, modified and deleted regular files land in the folder and the index follows', async (t) => {
  const setup = await fixture(t);
  await setup.changes([
    { path: 'a.txt', change: 'modified', text: 'alpha two' },
    { path: 'src/new/deep.js', change: 'added', text: 'deep' },
    { path: 'del.txt', change: 'deleted' },
    { path: 'made', change: 'added', kind: 'directory' },
    { path: 'olddir', change: 'deleted', kind: 'directory' },
  ]);
  const result = await run(setup);
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.refused, []);
  assert.equal(await fs.readFile(path.join(setup.root, 'a.txt'), 'utf8'), 'alpha two');
  assert.equal(await fs.readFile(path.join(setup.root, 'src', 'new', 'deep.js'), 'utf8'), 'deep');
  await assert.rejects(fs.lstat(path.join(setup.root, 'del.txt')), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(path.join(setup.root, 'olddir')), { code: 'ENOENT' });
  assert.equal((await fs.lstat(path.join(setup.root, 'made'))).isDirectory(), true);
  assert.equal(result.index.get('a.txt').sha256, sha('alpha two'));
  assert.equal(result.index.has('del.txt'), false);
  assert.equal(result.index.get('src/new').dir, true);
  const modified = result.applied.find((item) => item.path === 'a.txt');
  assert.equal(modified.before.toString(), 'alpha');
  assert.equal(modified.after.toString(), 'alpha two');
  assert.deepEqual((await fs.readdir(path.join(setup.root, 'src'))).sort(), ['keep.js', 'new']);
});

test('protected names, every P0a alias and unsafe paths are refused, listed and resynced', async (t) => {
  const setup = await fixture(t);
  const paths = ['.git/config', '.GIT/config', '.Git/hooks/pre-commit', 'GIT~1/config', '.git./config', '.HUSKY/x',
    'NODE_MODULES/x.js', 'pkg/node_modules/y.js', 'tools/hooks/h.sh', 'TOOLS/HOOKS/new.sh', 'CON', 'nul.txt',
    'a~1.txt', '../escape.txt', '/abs.txt', 'a\\b.txt', 'sub/.git', '.venv/x', 'trail. /x'];
  await setup.changes(paths.map((relative) => ({ path: relative, change: 'added', text: 'payload' })));
  const before = await fs.readFile(path.join(setup.root, '.git', 'config'), 'utf8');
  const result = await run(setup);
  const refused = reasons(result);
  // A protected path is listed once at its protected root; each other refusal at its own path.
  const listed = (relative) => [1, 2, 3].map((n) => relative.split('/').slice(0, n).join('/')).find((key) => refused[key]);
  for (const relative of paths) assert.ok(listed(relative), relative);
  assert.equal(refused['.GIT'], 'protected');
  assert.equal(refused['.GIT/config'], undefined);
  assert.equal(refused['GIT~1/config'], 'path_short_name');
  assert.equal(refused.CON, 'path_reserved_name');
  assert.equal(result.applied.length, 0);
  assert.equal(await fs.readFile(path.join(setup.root, '.git', 'config'), 'utf8'), before);
  // Resync one level below the protected root, so a cache write never restages a whole tree.
  assert.ok(result.trees.has('.GIT/config'));
  assert.ok(result.trees.has('NODE_MODULES/x.js'));
  assert.ok(result.trees.has('pkg/node_modules/y.js'));
  assert.ok(result.trees.has('GIT~1'));
  await assert.rejects(fs.lstat(path.join(setup.base, 'escape.txt')), { code: 'ENOENT' });
});

test('a junction or symlink anywhere in the parent chain refuses the write', async (t) => {
  const setup = await fixture(t);
  const outside = path.join(setup.base, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(setup.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await setup.changes([{ path: 'linked/x.txt', change: 'added', text: 'escape' },
    { path: 'linked/deeper/y.txt', change: 'added', text: 'escape' }]);
  const result = await run(setup);
  assert.equal(reasons(result)['linked/x.txt'], 'parent_invalid');
  assert.equal(reasons(result)['linked/deeper/y.txt'], 'parent_invalid');
  assert.deepEqual(await fs.readdir(outside), []);
});

test('outbox files that are not single regular files of the declared size and hash are refused', async (t) => {
  const setup = await fixture(t);
  await setup.changes([{ path: 'ok.txt', change: 'added', text: 'fine' },
    { path: 'missing.txt', change: 'added', file: '99', size: 1, sha256: sha('x') },
    { path: 'lies.txt', change: 'added', file: '0', size: 4, sha256: sha('nope') },
    { path: 'dir.txt', change: 'added', file: 'adir', size: 0, sha256: sha('') },
    { path: 'eacces.txt', change: 'added', text: 'locked' }]);
  await fs.mkdir(path.join(setup.outbox, 'files', 'adir'));
  const locked = path.join(setup.outbox, 'files', '1');
  const fsImpl = { ...fs, lstat: async (file, options) => {
    if (path.resolve(file) === path.resolve(locked)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return fs.lstat(file, options);
  } };
  const result = await run(setup, { fsImpl });
  assert.deepEqual(reasons(result), { 'missing.txt': 'outbox_invalid', 'lies.txt': 'outbox_invalid',
    'dir.txt': 'outbox_invalid', 'eacces.txt': 'outbox_invalid' });
  assert.equal(await fs.readFile(path.join(setup.root, 'ok.txt'), 'utf8'), 'fine');
  for (const name of ['missing.txt', 'lies.txt', 'dir.txt', 'eacces.txt']) {
    await assert.rejects(fs.lstat(path.join(setup.root, name)), { code: 'ENOENT' });
  }
});

test('a file the user changed during the run is a conflict and is not written', async (t) => {
  const setup = await fixture(t);
  await write(path.join(setup.root, 'a.txt'), 'user edit');
  await write(path.join(setup.root, 'appeared.txt'), 'user made this');
  await fs.writeFile(path.join(setup.root, 'del.txt'), 'user changed it');
  await setup.changes([{ path: 'a.txt', change: 'modified', text: 'command edit' },
    { path: 'appeared.txt', change: 'added', text: 'command made this' },
    { path: 'del.txt', change: 'deleted' },
    { path: 'src', change: 'modified', text: 'file over a folder' }]);
  const result = await run(setup);
  assert.deepEqual(reasons(result), { 'a.txt': 'conflict', 'appeared.txt': 'conflict', 'del.txt': 'conflict', src: 'type_changed' });
  assert.equal(await fs.readFile(path.join(setup.root, 'a.txt'), 'utf8'), 'user edit');
  assert.equal(await fs.readFile(path.join(setup.root, 'appeared.txt'), 'utf8'), 'user made this');
  assert.equal(await fs.readFile(path.join(setup.root, 'del.txt'), 'utf8'), 'user changed it');
  assert.ok(result.resync.has('a.txt') && result.resync.has('del.txt'));
});

test('worker refusals are listed, protected trees resync, and over-cap or foreign outboxes write nothing', async (t) => {
  const setup = await fixture(t);
  await setup.changes([{ path: 'link', change: 'added', refused: 'symlink' },
    { path: 'big.bin', change: 'added', refused: 'hardlink' }]);
  const refused = await run(setup);
  assert.deepEqual(reasons(refused), { link: 'symlink', 'big.bin': 'hardlink' });
  assert.ok(refused.resync.has('link'));

  await setup.changes([{ path: 'a.txt', change: 'modified', text: 'never' }], { status: 'write_back_too_large' });
  const tooLarge = await run(setup);
  assert.equal(tooLarge.status, 'too_large');
  assert.equal(tooLarge.full, true);
  assert.equal(await fs.readFile(path.join(setup.root, 'a.txt'), 'utf8'), 'alpha');

  await fs.writeFile(path.join(setup.outbox, 'changes.json'), JSON.stringify({ schema_version: 1, job_id: randomUUID(), status: 'ok', entries: [] }));
  await assert.rejects(run(setup), /write_back_outbox_invalid/u);
  await fs.writeFile(path.join(setup.outbox, 'changes.json'), '{broken');
  await assert.rejects(readOutbox(setup.outbox, { jobId: JOB }), /write_back_outbox_invalid/u);
  // A refused entry cannot carry a size that cancels real bytes out of the cap.
  for (const size of [-100, 'abc', 1.5]) {
    const entries = [{ path: 'x', change: 'added', kind: 'file', refused: 'symlink', size }];
    await fs.writeFile(path.join(setup.outbox, 'changes.json'), JSON.stringify({ schema_version: 1, job_id: JOB, status: 'ok', entries }));
    await assert.rejects(readOutbox(setup.outbox, { jobId: JOB }), /write_back_outbox_invalid/u);
  }
  const many = Array.from({ length: WRITE_BACK_LIMITS.entries + 1 }, (_, index) => ({ path: 'f' + index, change: 'deleted', kind: 'file' }));
  await fs.writeFile(path.join(setup.outbox, 'changes.json'), JSON.stringify({ schema_version: 1, job_id: JOB, status: 'ok', entries: many }));
  await assert.rejects(readOutbox(setup.outbox, { jobId: JOB }), /write_back_outbox_invalid/u);
});
