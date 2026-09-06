'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const {
  readJsonFile,
  writeJsonFileAtomic,
  writeTextFileAtomic,
  appendJsonLine,
  readJsonLines,
  parseJsonLines,
  buildTempName,
} = require('../../../services/plugins/store/json-file-io');

test('buildTempName always ends in .tmp and stays unique across calls', () => {
  const first = buildTempName('control-plane.json');
  const second = buildTempName('control-plane.json');
  assert.match(first, /\.tmp$/);
  assert.notEqual(first, second);
});

test('readJsonFile distinguishes missing from corrupted from ok', async () => {
  const facade = createMemoryFsFacade();
  const missing = await readJsonFile(facade, 'dir/file.json');
  assert.deepEqual(missing, { status: 'missing', value: null, error: null });

  await facade.mkdir('dir');
  await facade.writeFile('dir/bad.json', '{not valid json');
  const corrupted = await readJsonFile(facade, 'dir/bad.json');
  assert.equal(corrupted.status, 'corrupted');
  assert.equal(corrupted.value, null);
  assert.ok(corrupted.error.length > 0);

  await facade.writeFile('dir/good.json', '{"a":1}');
  const ok = await readJsonFile(facade, 'dir/good.json');
  assert.deepEqual(ok, { status: 'ok', value: { a: 1 }, error: null });
});

test('writeJsonFileAtomic creates the parent directory and round-trips the value', async () => {
  const facade = createMemoryFsFacade();
  const { filePath } = await writeJsonFileAtomic(facade, 'plugins', 'active-generation.json', { revision: 1 });
  assert.equal(filePath, 'plugins/active-generation.json');
  const read = await readJsonFile(facade, filePath);
  assert.deepEqual(read.value, { revision: 1 });
  // No stray temp file left behind after a successful write.
  const names = await facade.list('plugins');
  assert.deepEqual(names, ['active-generation.json']);
});

test('writeJsonFileAtomic overwrites an existing file via the rename step', async () => {
  const facade = createMemoryFsFacade();
  await writeJsonFileAtomic(facade, 'plugins', 'file.json', { v: 1 });
  await writeJsonFileAtomic(facade, 'plugins', 'file.json', { v: 2 });
  const read = await readJsonFile(facade, 'plugins/file.json');
  assert.deepEqual(read.value, { v: 2 });
  assert.deepEqual(await facade.list('plugins'), ['file.json']);
});

test('writeTextFileAtomic cleans up its temp file when the write step fails and never creates the real path', async () => {
  const facade = createMemoryFsFacade();
  const originalWriteFile = facade.writeFile.bind(facade);
  facade.writeFile = async (path, contents) => {
    if (path.endsWith('.tmp')) {
      throw new Error('simulated disk-full mid-write');
    }
    return originalWriteFile(path, contents);
  };
  await assert.rejects(() => writeTextFileAtomic(facade, 'plugins', 'file.json', 'hello'), /simulated disk-full/);
  const stat = await facade.stat('plugins/file.json');
  assert.equal(stat.exists, false);
  // mkdir happened, but no temp file survives the failure.
  assert.deepEqual(await facade.list('plugins'), []);
});

test('writeTextFileAtomic cleans up its temp file when the rename step fails', async () => {
  const facade = createMemoryFsFacade();
  const error = Object.assign(new Error('rename blocked'), { code: 'EACCES' });
  facade.renameFile = async () => { throw error; };

  await assert.rejects(
    () => writeTextFileAtomic(facade, 'plugins', 'file.json', 'hello'),
    (caught) => caught === error
  );
  assert.deepEqual(await facade.list('plugins'), []);
});

test('appendJsonLine appends and readJsonLines/parseJsonLines round-trip the entries in order', async () => {
  const facade = createMemoryFsFacade();
  await appendJsonLine(facade, 'plugins', 'journal.jsonl', { kind: 'a', seq: 1 });
  await appendJsonLine(facade, 'plugins', 'journal.jsonl', { kind: 'b', seq: 2 });
  const { entries, corruptCount } = await readJsonLines(facade, 'plugins', 'journal.jsonl');
  assert.deepEqual(entries, [{ kind: 'a', seq: 1 }, { kind: 'b', seq: 2 }]);
  assert.equal(corruptCount, 0);
});

test('appendJsonLine bounds the file to maxLines, dropping the oldest entries first', async () => {
  const facade = createMemoryFsFacade();
  for (let i = 0; i < 5; i += 1) {
    await appendJsonLine(facade, 'plugins', 'journal.jsonl', { seq: i }, { maxLines: 3 });
  }
  const { entries } = await readJsonLines(facade, 'plugins', 'journal.jsonl');
  assert.deepEqual(entries.map((e) => e.seq), [2, 3, 4]);
});

test('parseJsonLines tolerates a torn trailing line instead of throwing', () => {
  const { entries, corruptCount } = parseJsonLines('{"a":1}\n{"b":2}\n{not json\n');
  assert.deepEqual(entries, [{ a: 1 }, { b: 2 }]);
  assert.equal(corruptCount, 1);
});
