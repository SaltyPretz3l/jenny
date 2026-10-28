'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { createWorkspaceBackupService } = require('../services/workspace-backup-service');
const { WORKSPACE_BACKUP_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const { getBridgeChannel } = require('../services/ipc-contract');
const { registerWorkspaceIpcHandlers } = require('../services/main/workspace-ipc-registration');

const ROOT_ID = 'root_0123456789abcdef01234567';
const OTHER_ROOT_ID = 'root_fedcba9876543210fedcba98';

const idFor = (relativePath) => createHash('sha256').update(relativePath, 'utf8').digest('hex');

// H1: write/remove carry the root id and generation the renderer captured with the buffer,
// and main passes its own generation. This wrapper acts as an up-to-date renderer.
function scoped(service, generation = 1) {
  const withScope = (rootId, payload) => (payload && typeof payload === 'object' && !Array.isArray(payload)
    ? { expectedRootId: rootId, expectedGeneration: generation, ...payload }
    : payload);
  return {
    write: (rootId, payload) => service.write(rootId, withScope(rootId, payload), generation),
    remove: (rootId, payload) => service.remove(rootId, withScope(rootId, payload), generation),
    list: (rootId) => service.list(rootId),
    read: (rootId, payload) => service.read(rootId, payload),
  };
}

function makeService(options = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-backup-'));
  test.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const raw = createWorkspaceBackupService({ userDataPath, ...options });
  const rootDir = (rootId = ROOT_ID) => path.join(userDataPath, 'workspace-backups', rootId);
  const fileFor = (relativePath, rootId) => path.join(rootDir(rootId), `${idFor(relativePath)}.json`);
  return { service: scoped(raw), raw, userDataPath, rootDir, fileFor };
}

async function pathsOf(service, entries) {
  const out = [];
  for (const entry of entries) out.push((await service.read(ROOT_ID, { id: entry.id })).entry?.path || null);
  return out;
}

test('backup round trip: write then read', async () => {
  const { service, fileFor } = makeService();
  const written = await service.write(ROOT_ID, { path: 'src/a.js', content: 'hello', diskMtimeMs: 12 });
  assert.equal(written.ok, true);
  const stored = JSON.parse(fs.readFileSync(fileFor('src/a.js'), 'utf8'));
  assert.equal(stored.version, 1);
  assert.equal(stored.path, 'src/a.js');
  assert.equal(stored.content, 'hello');
  assert.equal(stored.diskMtimeMs, 12);
  assert.equal(typeof stored.updatedAt, 'number');
  const read = await service.read(ROOT_ID, { path: 'src/a.js' });
  assert.equal(read.ok, true);
  assert.deepEqual(read.entry, {
    path: 'src/a.js', content: 'hello', diskMtimeMs: 12, updatedAt: stored.updatedAt,
  });
  assert.deepEqual(await service.read(ROOT_ID, { path: 'src/missing.js' }), { ok: true, entry: null });
  assert.deepEqual(await service.read(OTHER_ROOT_ID, { path: 'src/a.js' }), { ok: true, entry: null });
});

test('a non-finite diskMtimeMs is stored as 0', async () => {
  const { service } = makeService();
  await service.write(ROOT_ID, { path: 'a.txt', content: 'x', diskMtimeMs: 'soon' });
  assert.equal((await service.read(ROOT_ID, { path: 'a.txt' })).entry.diskMtimeMs, 0);
});

test('list returns newest first with byte sizes, as ids read back by id', async () => {
  let clock = 1000;
  const { service } = makeService({ now: () => clock });
  await service.write(ROOT_ID, { path: 'old.txt', content: 'a', diskMtimeMs: 1 });
  clock = 3000;
  await service.write(ROOT_ID, { path: 'new.txt', content: 'bb', diskMtimeMs: 2 });
  clock = 2000;
  await service.write(ROOT_ID, { path: 'mid.txt', content: 'ccc', diskMtimeMs: 3 });
  const listed = await service.list(ROOT_ID);
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.entries.map((entry) => entry.id), [idFor('new.txt'), idFor('mid.txt'), idFor('old.txt')]);
  assert.deepEqual(await pathsOf(service, listed.entries), ['new.txt', 'mid.txt', 'old.txt']);
  assert.deepEqual(listed.entries.map((entry) => entry.updatedAt), [3000, 2000, 1000]);
  assert.ok(listed.entries.every((entry) => entry.bytes > 0));
  assert.deepEqual(Object.keys(listed.entries[0]).sort(), ['bytes', 'id', 'updatedAt'], 'no path, no content');
  assert.deepEqual(await service.list(OTHER_ROOT_ID), { ok: true, entries: [] });
  for (const bad of ['', 'zz', idFor('a').toUpperCase(), `${idFor('a')}.json`, 7]) {
    assert.equal((await service.read(ROOT_ID, { id: bad })).code, CODES.INVALID_PATH, String(bad));
  }
});

test('H2: listing 200 records parses none', async () => {
  const { service } = makeService({ limits: { maxFiles: 500 } });
  for (let index = 0; index < 200; index += 1) {
    assert.equal((await service.write(ROOT_ID, { path: `f${index}.txt`, content: `c${index}` })).ok, true);
  }
  const realParse = JSON.parse;
  let parses = 0;
  JSON.parse = function countingParse(...args) { parses += 1; return realParse.apply(this, args); };
  let listed;
  try {
    listed = await service.list(ROOT_ID);
  } finally {
    JSON.parse = realParse;
  }
  assert.equal(parses, 0, 'list reads file names and stat only');
  assert.equal(listed.entries.length, 200);
  assert.equal((await service.read(ROOT_ID, { id: idFor('f7.txt') })).entry.content, 'c7', 'a record is parsed when it is read');
});

test('H1: a write for root A arriving after a switch to root B is refused and writes nothing under B', async () => {
  const { raw, userDataPath, rootDir } = makeService();
  const fromA = { path: 'a.js', content: 'root A buffer', diskMtimeMs: 1, expectedRootId: ROOT_ID, expectedGeneration: 1 };
  // Main already committed root B (generation 2) when the write lands.
  const refused = await raw.write(OTHER_ROOT_ID, fromA, 2);
  assert.deepEqual([refused.ok, refused.code], [false, CODES.INVALID_ROOT]);
  assert.equal(fs.existsSync(rootDir(OTHER_ROOT_ID)), false);
  // The same root re-opened under a newer generation, a payload without a scope and a
  // call without main's generation are refused the same way, before any disk access.
  assert.equal((await raw.write(ROOT_ID, fromA, 2)).code, CODES.INVALID_ROOT);
  const { expectedRootId: _rootId, expectedGeneration: _generation, ...unscoped } = fromA;
  assert.equal((await raw.write(ROOT_ID, unscoped, 1)).code, CODES.INVALID_ROOT);
  assert.equal((await raw.write(ROOT_ID, fromA)).code, CODES.INVALID_ROOT);
  assert.equal((await raw.write(ROOT_ID, { ...fromA, expectedGeneration: '1' }, 1)).code, CODES.INVALID_ROOT);
  assert.equal(fs.existsSync(path.join(userDataPath, 'workspace-backups')), false);
  // The matching scope writes; a stale remove keeps the file.
  assert.equal((await raw.write(ROOT_ID, fromA, 1)).ok, true);
  const staleRemove = await raw.remove(ROOT_ID, { path: 'a.js', expectedRootId: ROOT_ID, expectedGeneration: 0 }, 1);
  assert.equal(staleRemove.code, CODES.INVALID_ROOT);
  assert.equal((await raw.read(ROOT_ID, { path: 'a.js' })).entry.content, 'root A buffer');
});

test('an update replaces its own entry', async () => {
  const { service } = makeService();
  await service.write(ROOT_ID, { path: 'a.txt', content: 'one', diskMtimeMs: 1 });
  await service.write(ROOT_ID, { path: 'a.txt', content: 'two', diskMtimeMs: 2 });
  const listed = await service.list(ROOT_ID);
  assert.equal(listed.entries.length, 1);
  assert.equal((await service.read(ROOT_ID, { path: 'a.txt' })).entry.content, 'two');
});

test('remove deletes the entry and a missing file is not an error', async () => {
  const { service, fileFor } = makeService();
  await service.write(ROOT_ID, { path: 'a.txt', content: 'x', diskMtimeMs: 1 });
  assert.deepEqual(await service.remove(ROOT_ID, { path: 'a.txt' }), { ok: true, removed: true });
  assert.equal(fs.existsSync(fileFor('a.txt')), false);
  assert.deepEqual(await service.remove(ROOT_ID, { path: 'a.txt' }), { ok: true, removed: false });
  assert.deepEqual(await service.remove(OTHER_ROOT_ID, { path: 'a.txt' }), { ok: true, removed: false });
});

test('rootId validation', async () => {
  const { service, userDataPath } = makeService();
  const payload = { path: 'a.txt', content: 'x', diskMtimeMs: 1 };
  const badRoots = ['', 'root_', 'root_0123', '../root_0123456789abcdef01234567', 'root_0123456789ABCDEF01234567',
    'root_0123456789abcdef012345678', 'root_0123456789abcdef01234567/..', null, undefined, 42, {}];
  for (const bad of badRoots) {
    for (const result of [
      await service.write(bad, payload),
      await service.remove(bad, { path: 'a.txt' }),
      await service.list(bad),
      await service.read(bad, { path: 'a.txt' }),
    ]) {
      assert.deepEqual([result.ok, result.code], [false, CODES.INVALID_ROOT]);
    }
  }
  assert.equal(fs.existsSync(path.join(userDataPath, 'workspace-backups')), false);
});

test('path validation rejects anything that is not already a normalized relative path', async () => {
  const { service, userDataPath } = makeService();
  const bad = ['', '/etc/passwd', 'C:\\x\\a.js', 'C:/x/a.js', 'c:a.js', '\\\\server\\share\\a.js',
    '//server/share/a.js', '../a.js', 'a/../b.js', 'a/..', 'a\\b.js', './a.js', 'a//b.js', 'a/./b.js', 'a/',
    'a\0b', 'x'.repeat(1025), null, undefined, 7, {}];
  for (const candidate of bad) {
    const results = [
      await service.write(ROOT_ID, { path: candidate, content: 'x', diskMtimeMs: 1 }),
      await service.remove(ROOT_ID, { path: candidate }),
      await service.read(ROOT_ID, { path: candidate }),
    ];
    for (const result of results) {
      assert.deepEqual([result.ok, result.code], [false, CODES.INVALID_PATH], JSON.stringify(candidate));
    }
  }
  assert.equal(fs.existsSync(path.join(userDataPath, 'workspace-backups')), false);
  assert.equal((await service.write(ROOT_ID, { path: 'dir/sub/a b.js', content: 'x', diskMtimeMs: 1 })).ok, true);
});

test('payload validation', async () => {
  const { service } = makeService();
  for (const bad of [null, undefined, 'str', 5, ['a']]) {
    assert.equal((await service.write(ROOT_ID, bad)).code, CODES.INVALID_PAYLOAD);
    assert.equal((await service.remove(ROOT_ID, bad)).code, CODES.INVALID_PAYLOAD);
    assert.equal((await service.read(ROOT_ID, bad)).code, CODES.INVALID_PAYLOAD);
  }
  assert.equal((await service.write(ROOT_ID, { path: 'a.txt', content: 5 })).code, CODES.INVALID_PAYLOAD);
  assert.equal((await service.write(ROOT_ID, { path: 'a.txt' })).code, CODES.INVALID_PAYLOAD);
});

test('the per-file cap counts UTF-8 bytes', async () => {
  const { service } = makeService({ limits: { maxFileBytes: 10 } });
  assert.equal((await service.write(ROOT_ID, { path: 'ok.txt', content: '0123456789' })).ok, true);
  assert.equal((await service.write(ROOT_ID, { path: 'big.txt', content: '01234567890' })).code, CODES.TOO_LARGE);
  // Five 3-byte characters are 15 bytes even though they are 5 UTF-16 units.
  assert.equal((await service.write(ROOT_ID, { path: 'cjk.txt', content: '\u65e5\u672c\u8a9e\u65e5\u672c' })).code, CODES.TOO_LARGE);
  assert.equal((await service.read(ROOT_ID, { path: 'big.txt' })).entry, null);
});

test('the default per-file cap is 5 MiB', async () => {
  const { service } = makeService();
  assert.equal((await service.write(ROOT_ID, { path: 'max.txt', content: 'a'.repeat(5 * 1024 * 1024) })).ok, true);
  assert.equal((await service.write(ROOT_ID, { path: 'over.txt', content: 'a'.repeat(5 * 1024 * 1024 + 1) })).code, CODES.TOO_LARGE);
});

test('at most 50 files per root; an update at the cap still succeeds; nothing is evicted', async () => {
  const { service } = makeService();
  for (let index = 0; index < 50; index += 1) {
    assert.equal((await service.write(ROOT_ID, { path: `f${index}.txt`, content: 'x' })).ok, true);
  }
  const refused = await service.write(ROOT_ID, { path: 'f50.txt', content: 'x' });
  assert.deepEqual([refused.ok, refused.code], [false, CODES.QUOTA_EXCEEDED]);
  assert.equal((await service.write(ROOT_ID, { path: 'f7.txt', content: 'updated' })).ok, true);
  const listed = await service.list(ROOT_ID);
  assert.equal(listed.entries.length, 50);
  assert.equal(listed.entries.some((entry) => entry.id === idFor('f50.txt')), false);
  // Another root has its own budget.
  assert.equal((await service.write(OTHER_ROOT_ID, { path: 'f50.txt', content: 'x' })).ok, true);
});

test('the per-root byte cap includes the new write and an update replaces its own bytes', async () => {
  const { service } = makeService({ limits: { maxFileBytes: 1000, maxRootBytes: 1500 } });
  const first = await service.write(ROOT_ID, { path: 'a.txt', content: 'a'.repeat(300) });
  assert.equal(first.ok, true);
  const overhead = first.bytes - 300; // identical for equal-length paths
  const second = 1500 - first.bytes - overhead; // content length that fills the store exactly
  assert.equal((await service.write(ROOT_ID, { path: 'b.txt', content: 'b'.repeat(second) })).ok, true);
  // The store is exactly full: a third file is refused, even an empty one.
  assert.equal((await service.write(ROOT_ID, { path: 'c.txt', content: '' })).code, CODES.QUOTA_EXCEEDED);
  // Growing a.txt by one byte exceeds the cap; replacing it with the same size does not.
  assert.equal((await service.write(ROOT_ID, { path: 'a.txt', content: 'a'.repeat(301) })).code, CODES.QUOTA_EXCEEDED);
  assert.equal((await service.write(ROOT_ID, { path: 'a.txt', content: 'z'.repeat(300) })).ok, true);
  // Shrinking frees room.
  assert.equal((await service.write(ROOT_ID, { path: 'a.txt', content: 'a' })).ok, true);
  assert.equal((await service.write(ROOT_ID, { path: 'c.txt', content: 'c'.repeat(100) })).ok, true);
  assert.equal((await service.list(ROOT_ID)).entries.length, 3);
});

test('concurrent writes cannot both pass the same cap', async () => {
  const { service } = makeService({ limits: { maxFiles: 3 } });
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => (
    service.write(ROOT_ID, { path: `p${index}.txt`, content: 'x' })
  )));
  assert.equal(results.filter((result) => result.ok).length, 3);
  assert.equal((await service.list(ROOT_ID)).entries.length, 3);
});

test('corrupt, wrong-version, oversized and hash-mismatched files are skipped and deleted', async () => {
  const { service, rootDir, fileFor } = makeService({ limits: { maxFileBytes: 100 } });
  await service.write(ROOT_ID, { path: 'good.txt', content: 'ok' });
  await service.write(ROOT_ID, { path: 'victim.txt', content: 'v' });
  await service.write(ROOT_ID, { path: 'liar.txt', content: 'l' });
  const garbage = fileFor('garbage.txt');
  fs.writeFileSync(garbage, '{not json');
  const wrongVersion = fileFor('version.txt');
  fs.writeFileSync(wrongVersion, JSON.stringify({ version: 2, path: 'version.txt', content: 'x', diskMtimeMs: 0, updatedAt: 1 }));
  const oversized = fileFor('huge.txt');
  fs.writeFileSync(oversized, JSON.stringify({ version: 1, path: 'huge.txt', content: 'h'.repeat(101), diskMtimeMs: 0, updatedAt: 1 }));
  const veryOversized = fileFor('very-huge.txt');
  fs.writeFileSync(veryOversized, 'x'.repeat(5000));
  // A valid-looking entry stored under another path's hash must never restore onto the wrong path.
  const mismatch = fileFor('victim.txt');
  fs.writeFileSync(mismatch, JSON.stringify({ version: 1, path: 'attacker.txt', content: 'evil', diskMtimeMs: 0, updatedAt: 9 }));
  const badPath = fileFor('liar.txt');
  fs.writeFileSync(badPath, JSON.stringify({ version: 1, path: '../liar.txt', content: 'evil', diskMtimeMs: 0, updatedAt: 9 }));
  // Foreign file names are ignored and left alone.
  fs.writeFileSync(path.join(rootDir(), 'notes.txt'), 'keep');

  assert.deepEqual((await service.read(ROOT_ID, { path: 'victim.txt' })), { ok: true, entry: null });
  assert.equal(fs.existsSync(mismatch), false);
  // list is stat-only: it drops the file too large to be a record; reading drops the rest.
  const listed = await service.list(ROOT_ID);
  assert.equal(fs.existsSync(veryOversized), false);
  assert.deepEqual((await pathsOf(service, listed.entries)).filter(Boolean), ['good.txt']);
  for (const file of [garbage, wrongVersion, oversized, veryOversized, badPath]) {
    assert.equal(fs.existsSync(file), false, file);
  }
  assert.equal(fs.existsSync(path.join(rootDir(), 'notes.txt')), true);
});

test('writes are atomic and leave no temp file behind', async () => {
  const { service, rootDir } = makeService();
  for (let index = 0; index < 5; index += 1) {
    await service.write(ROOT_ID, { path: 'a.txt', content: `v${index}` });
  }
  await service.write(ROOT_ID, { path: 'b.txt', content: 'b' });
  const names = fs.readdirSync(rootDir());
  assert.equal(names.length, 2);
  assert.ok(names.every((name) => /^[0-9a-f]{64}\.json$/.test(name)), names.join(','));
  assert.equal((await service.read(ROOT_ID, { path: 'a.txt' })).entry.content, 'v4');
});

test('an I/O failure answers a code without leaking paths or content', async () => {
  const { userDataPath } = makeService();
  // A file where the root directory should be makes the write and the listing fail.
  fs.mkdirSync(path.join(userDataPath, 'workspace-backups'));
  fs.writeFileSync(path.join(userDataPath, 'workspace-backups', ROOT_ID), 'blocker');
  const logs = [];
  const service = scoped(createWorkspaceBackupService({ userDataPath, log: (...args) => logs.push(args) }));
  const result = await service.write(ROOT_ID, { path: 'secret/path.txt', content: 'secret content' });
  assert.deepEqual([result.ok, result.code], [false, CODES.IO_FAILED]);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  assert.doesNotMatch(JSON.stringify(logs), /secret/);
  assert.ok(logs.length > 0);
  assert.equal((await service.list(ROOT_ID)).code, CODES.IO_FAILED);
});

// IPC handlers (services/main/workspace-ipc-registration.js)
function setupHandlers({ phase = 'ready', rootId = ROOT_ID, enabled = true, service = 'stub', userDataPath } = {}) {
  const handlers = new Map();
  const ipc = { handle: (channel, handler) => handlers.set(channel, handler), on() {} };
  const calls = [];
  const stub = {
    write: async (...args) => { calls.push(['write', ...args]); return { ok: true }; },
    remove: async (...args) => { calls.push(['remove', ...args]); return { ok: true, removed: true }; },
    list: async (...args) => { calls.push(['list', ...args]); return { ok: true, entries: [] }; },
    read: async (...args) => { calls.push(['read', ...args]); return { ok: true, entry: null }; },
  };
  registerWorkspaceIpcHandlers(ipc, {}, {
    getRootContext: () => ({ rootPath: 'C:/w', rootId, generation: 1, phase }),
    ...(service === 'stub' ? { workspaceBackupService: stub } : {}),
    ...(userDataPath ? { userDataPath } : {}),
    isWorkspaceBackupEnabled: () => enabled,
  });
  const call = (method, ...args) => handlers.get(getBridgeChannel(method, 'invoke'))({}, ...args);
  return { handlers, calls, call };
}

test("IPC handlers pass main's rootId, never a renderer one", async () => {
  const { calls, call } = setupHandlers();
  await call('workspaceBackup.write', { rootId: 'root_ffffffffffffffffffffffff', path: 'a.js', content: 'x', diskMtimeMs: 1 });
  await call('workspaceBackup.remove', { path: 'a.js' });
  await call('workspaceBackup.list');
  await call('workspaceBackup.read', { path: 'a.js' });
  assert.deepEqual(calls.map(([name, rootId]) => [name, rootId]), [
    ['write', ROOT_ID], ['remove', ROOT_ID], ['list', ROOT_ID], ['read', ROOT_ID],
  ]);
  assert.deepEqual(calls[3], ['read', ROOT_ID, { path: 'a.js' }]);
  // H1: the mutations also get main's generation, which the service checks the payload against.
  assert.equal(calls[0][3], 1);
  assert.equal(calls[1][3], 1);
});

test('H1 IPC: a write captured under root A is refused once main switched to root B', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-backup-switch-'));
  test.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  let context = { rootPath: 'C:/a', rootId: ROOT_ID, generation: 1, phase: 'ready' };
  const handlers = new Map();
  registerWorkspaceIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler), on() {} }, {}, {
    getRootContext: () => context, userDataPath, isWorkspaceBackupEnabled: () => true,
  });
  const call = (method, payload) => handlers.get(getBridgeChannel(method, 'invoke'))({}, payload);
  const captured = { path: 'a.js', content: 'root A text', diskMtimeMs: 1, expectedRootId: ROOT_ID, expectedGeneration: 1 };
  context = { rootPath: 'C:/b', rootId: OTHER_ROOT_ID, generation: 2, phase: 'ready' };
  assert.equal((await call('workspaceBackup.write', captured)).code, CODES.INVALID_ROOT);
  assert.equal((await call('workspaceBackup.remove', captured)).code, CODES.INVALID_ROOT);
  assert.deepEqual(fs.readdirSync(userDataPath), [], 'nothing under B, nothing at all');
  const current = { ...captured, expectedRootId: OTHER_ROOT_ID, expectedGeneration: 2 };
  assert.equal((await call('workspaceBackup.write', current)).ok, true);
});

test('IPC flag off answers the disabled code and never reaches the service or disk', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-backup-flag-'));
  test.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const real = setupHandlers({ enabled: false, service: 'real', userDataPath });
  const stubbed = setupHandlers({ enabled: false });
  for (const { call } of [real, stubbed]) {
    for (const [method, payload] of [
      ['workspaceBackup.write', { path: 'a.js', content: 'x' }],
      ['workspaceBackup.remove', { path: 'a.js' }],
      ['workspaceBackup.list'],
      ['workspaceBackup.read', { path: 'a.js' }],
    ]) {
      assert.deepEqual(await call(method, payload), { ok: false, code: CODES.DISABLED });
    }
  }
  assert.deepEqual(stubbed.calls, []);
  assert.deepEqual(fs.readdirSync(userDataPath), []);
});

test('IPC built from userDataPath writes through the real service', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-backup-ipc-'));
  test.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const { call } = setupHandlers({ service: 'real', userDataPath });
  const scope = { expectedRootId: ROOT_ID, expectedGeneration: 1 };
  assert.equal((await call('workspaceBackup.write', { path: 'a.js', content: 'x', diskMtimeMs: 3, ...scope })).ok, true);
  assert.equal((await call('workspaceBackup.read', { path: 'a.js' })).entry.content, 'x');
  assert.deepEqual((await call('workspaceBackup.list')).entries.map((entry) => entry.id), [idFor('a.js')]);
  assert.deepEqual(await call('workspaceBackup.remove', { path: 'a.js', ...scope }), { ok: true, removed: true });
});

test('IPC root not ready (or without an id) answers root_transitioning', async () => {
  for (const options of [{ phase: 'switching' }, { phase: 'error' }, { rootId: null }]) {
    const { calls, call } = setupHandlers(options);
    assert.deepEqual(await call('workspaceBackup.list'), { ok: false, code: 'root_transitioning' });
    assert.deepEqual(await call('workspaceBackup.write', { path: 'a.js', content: 'x' }), { ok: false, code: 'root_transitioning' });
    assert.deepEqual(calls, []);
  }
});

test('IPC non-record payloads are refused before the service is called', async () => {
  const { calls, call } = setupHandlers();
  for (const bad of [undefined, null, 'a.js', 7, ['a.js']]) {
    assert.deepEqual(await call('workspaceBackup.write', bad), { ok: false, code: CODES.INVALID_PAYLOAD });
    assert.deepEqual(await call('workspaceBackup.remove', bad), { ok: false, code: CODES.INVALID_PAYLOAD });
    assert.deepEqual(await call('workspaceBackup.read', bad), { ok: false, code: CODES.INVALID_PAYLOAD });
  }
  assert.deepEqual(calls, []);
});

test('IPC without a service or userDataPath does not register the backup channels', () => {
  const { handlers } = setupHandlers({ service: 'none' });
  assert.equal(handlers.has(getBridgeChannel('workspaceBackup.write', 'invoke')), false);
  assert.equal(handlers.has(getBridgeChannel('workspaceIde.getState', 'invoke')), true);
});
