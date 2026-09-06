'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FACADE_METHODS,
  createMemoryFsFacade,
  joinPath,
  normalizePath,
  parentOf,
  baseNameOf,
} = require('../../../services/plugins/store/fs-facade');

test('joinPath and normalizePath strip separators and dot segments', () => {
  assert.equal(joinPath('plugins', 'generations', 'gen-1'), 'plugins/generations/gen-1');
  assert.equal(normalizePath('/plugins/generations/'), 'plugins/generations');
  assert.equal(normalizePath('.'), '');
  assert.equal(normalizePath(''), '');
});

test('parentOf and baseNameOf split a normalized path', () => {
  assert.equal(parentOf('plugins/generations/gen-1'), 'plugins/generations');
  assert.equal(parentOf('top-level.json'), '');
  assert.equal(baseNameOf('plugins/generations/gen-1'), 'gen-1');
});

test('MemoryFsFacade implements every facet named in FACADE_METHODS', () => {
  const facade = createMemoryFsFacade();
  for (const method of FACADE_METHODS) {
    assert.equal(typeof facade[method], 'function', `missing facade method ${method}`);
  }
});

test('writeFile requires the parent directory to already exist', async () => {
  const facade = createMemoryFsFacade();
  await assert.rejects(
    () => facade.writeFile('a/b/file.json', '{}'),
    (error) => error.code === 'ENOENT'
  );
  await facade.mkdir('a/b');
  await facade.writeFile('a/b/file.json', '{"ok":true}');
  const readBack = await facade.readFile('a/b/file.json');
  assert.equal(readBack, '{"ok":true}');
});

test('readFile rejects ENOENT for an unknown path', async () => {
  const facade = createMemoryFsFacade();
  await assert.rejects(() => facade.readFile('nope.json'), (error) => error.code === 'ENOENT');
});

test('fsyncFile requires the file to exist', async () => {
  const facade = createMemoryFsFacade();
  await assert.rejects(() => facade.fsyncFile('missing.json'), (error) => error.code === 'ENOENT');
  await facade.mkdir('dir');
  await facade.writeFile('dir/file.json', '{}');
  await facade.fsyncFile('dir/file.json');
  assert.equal(facade.callCounts.fsyncFile, 2);
});

test('renameFile requires an existing source and an existing destination directory', async () => {
  const facade = createMemoryFsFacade();
  await facade.mkdir('dir');
  await facade.writeFile('dir/old.json', '{"v":1}');
  await assert.rejects(
    () => facade.renameFile('dir/nope.json', 'dir/new.json'),
    (error) => error.code === 'ENOENT'
  );
  await assert.rejects(
    () => facade.renameFile('dir/old.json', 'missing-dir/new.json'),
    (error) => error.code === 'ENOENT'
  );
  await facade.renameFile('dir/old.json', 'dir/new.json');
  assert.equal(await facade.readFile('dir/new.json'), '{"v":1}');
  await assert.rejects(() => facade.readFile('dir/old.json'), (error) => error.code === 'ENOENT');
});

test('renameFile atomically replaces an existing destination', async () => {
  const facade = createMemoryFsFacade();
  await facade.mkdir('dir');
  await facade.writeFile('dir/src.json', '{"v":"new"}');
  await facade.writeFile('dir/dest.json', '{"v":"old"}');
  await facade.renameFile('dir/src.json', 'dir/dest.json');
  assert.equal(await facade.readFile('dir/dest.json'), '{"v":"new"}');
});

test('fsyncDir never throws, even for an unknown directory', async () => {
  const facade = createMemoryFsFacade();
  await facade.fsyncDir('never-created');
  assert.equal(facade.callCounts.fsyncDir, 1);
});

test('list returns [] for a directory that does not exist', async () => {
  const facade = createMemoryFsFacade();
  assert.deepEqual(await facade.list('nowhere'), []);
});

test('list returns immediate children only, sorted, deduplicated across files and dirs', async () => {
  const facade = createMemoryFsFacade();
  await facade.mkdir('root/child-dir');
  await facade.writeFile('root/child-dir/deep.json', '{}');
  await facade.mkdir('root');
  await facade.writeFile('root/a.json', '{}');
  await facade.writeFile('root/b.json', '{}');
  assert.deepEqual(await facade.list('root'), ['a.json', 'b.json', 'child-dir']);
  assert.deepEqual(await facade.list('root/child-dir'), ['deep.json']);
});

test('remove is idempotent and rejects removing a directory', async () => {
  const facade = createMemoryFsFacade();
  await facade.remove('never-existed.json');
  await facade.mkdir('dir');
  await facade.writeFile('dir/file.json', '{}');
  await facade.remove('dir/file.json');
  await assert.rejects(() => facade.readFile('dir/file.json'), (error) => error.code === 'ENOENT');
  await assert.rejects(() => facade.remove('dir'), (error) => error.code === 'EISDIR');
});

test('stat reports exists/isFile/isDirectory/size correctly for file, dir, and missing paths', async () => {
  const facade = createMemoryFsFacade();
  await facade.mkdir('dir');
  await facade.writeFile('dir/file.json', 'abcd');
  assert.deepEqual(await facade.stat('dir/file.json'), { exists: true, isFile: true, isDirectory: false, size: 4 });
  assert.deepEqual(await facade.stat('dir'), { exists: true, isFile: false, isDirectory: true, size: 0 });
  assert.deepEqual(await facade.stat('missing'), { exists: false, isFile: false, isDirectory: false, size: 0 });
});

test('mkdir is idempotent and materializes ancestor directories', async () => {
  const facade = createMemoryFsFacade();
  await facade.mkdir('a/b/c');
  await facade.mkdir('a/b/c');
  assert.deepEqual(await facade.stat('a'), { exists: true, isFile: false, isDirectory: true, size: 0 });
  assert.deepEqual(await facade.stat('a/b'), { exists: true, isFile: false, isDirectory: true, size: 0 });
  assert.deepEqual(await facade.stat('a/b/c'), { exists: true, isFile: false, isDirectory: true, size: 0 });
});
