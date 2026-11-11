'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');
const {
  createChangePictureStore,
  turnKey,
  PICTURE_STATES,
} = require('../services/change-pictures/picture-store');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const WORKSPACE = 'root_0123456789abcdef01234567';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(totalBytes = 64, fill = 1) {
  return Buffer.concat([PNG_SIGNATURE, Buffer.alloc(totalBytes - PNG_SIGNATURE.length, fill)]);
}

function makeStore(overrides = {}) {
  const rootDir = path.join(createTrackedTempDir('jenny-pictures-'), 'change-pictures');
  const clock = { at: Date.UTC(2026, 10, 9, 12, 0, 0) };
  const store = createChangePictureStore({
    rootDir,
    now: () => new Date(clock.at),
    ...overrides,
  });
  return { store, rootDir, clock };
}

function turnArgs(turnId, extra = {}) {
  return {
    workspaceId: WORKSPACE,
    sessionId: 'sess-1',
    turnId,
    viewport: 'desktop',
    signature: 'sig',
    pages: [{
      path: 'index.html', state: 'ready', before: png(64, 1), after: png(64, 2), width: 1280, height: 800,
    }],
    ...extra,
  };
}

function turnDir(rootDir, sessionId, turnId) {
  return path.join(rootDir, WORKSPACE, turnKey(sessionId, turnId));
}

function turnFolders(rootDir) {
  const dir = path.join(rootDir, WORKSPACE);
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

test('turnKey is 32 hex characters and depends on both ids', () => {
  const key = turnKey('s', 't');
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(turnKey('s', 't'), key);
  assert.notEqual(turnKey('s', 'u'), key);
  assert.deepEqual([...PICTURE_STATES], ['ready', 'same', 'after_failed', 'new', 'deleted']);
});

test('write then read round-trips the record and the picture bytes', async () => {
  const { store, rootDir } = makeStore();
  assert.equal(store.getRootDir(), rootDir);
  const record = await store.write(turnArgs('turn-1'));
  assert.equal(record.sessionId, 'sess-1');
  assert.equal(record.turnId, 'turn-1');
  assert.equal(record.viewport, 'desktop');
  assert.equal(record.signature, 'sig');
  assert.equal(record.capturedAt, '2026-11-09T12:00:00.000Z');
  assert.equal(record.pages.length, 1);
  const [page] = record.pages;
  assert.equal(page.path, 'index.html');
  assert.equal(page.state, 'ready');
  assert.equal(page.width, 1280);
  assert.equal(page.height, 800);
  assert.deepEqual(fs.readFileSync(fileURLToPath(page.beforeUrl)), png(64, 1));
  assert.deepEqual(fs.readFileSync(fileURLToPath(page.afterUrl)), png(64, 2));
  assert.deepEqual(await store.read({ workspaceId: WORKSPACE, sessionId: 'sess-1', turnId: 'turn-1' }), record);

  const dir = turnDir(rootDir, 'sess-1', 'turn-1');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.version, 1);
  assert.match(meta.pages[0].before, /^p0-before-[0-9a-f]{12}\.png$/);
  assert.match(meta.pages[0].after, /^p0-after-[0-9a-f]{12}\.png$/);
  assert.deepEqual(fs.readdirSync(dir).sort(), [meta.pages[0].after, meta.pages[0].before, 'meta.json'].sort());
});

test('bad buffers become null and bad pages, viewports and extra pages are cleaned up', async () => {
  const { store, rootDir } = makeStore({ maxPictureBytes: 100 });
  const record = await store.write(turnArgs('turn-1', {
    viewport: 'tablet',
    signature: 'x'.repeat(500),
    pages: [
      { path: 'a.html', state: 'new', before: Buffer.from('not a png at all'), after: png(101), width: 10.7, height: -4 },
      { path: 'b.html', state: 'same', before: Buffer.alloc(0), after: png(50), width: 'wide', height: Infinity },
      { path: 'c.html', state: 'bogus', before: png(50), after: png(50), width: 1, height: 1 },
      { path: 'd.html', state: 'deleted', before: null, after: null, width: 1, height: 1 },
      { path: 'e.html', state: 'ready', before: png(50), after: png(50), width: 1, height: 1 },
      { path: 'f.html', state: 'ready', before: png(50), after: png(50), width: 1, height: 1 },
    ],
  }));
  assert.equal(record.viewport, 'desktop');
  assert.equal(record.signature.length, 200);
  assert.deepEqual(record.pages.map((p) => p.path), ['a.html', 'b.html', 'd.html']);
  assert.equal(record.pages[0].beforeUrl, null);
  assert.equal(record.pages[0].afterUrl, null);
  assert.equal(record.pages[0].width, 10);
  assert.equal(record.pages[0].height, 0);
  assert.equal(record.pages[1].beforeUrl, null);
  assert.notEqual(record.pages[1].afterUrl, null);
  assert.equal(record.pages[1].width, 0);
  assert.equal(record.pages[1].height, 0);
  assert.equal(record.pages[2].beforeUrl, null);
  const files = fs.readdirSync(turnDir(rootDir, 'sess-1', 'turn-1'));
  assert.equal(files.filter((name) => name.endsWith('.png')).length, 1);
});

test('a second write for the same turn removes the first write\'s pictures', async () => {
  const { store, rootDir } = makeStore();
  const first = await store.write(turnArgs('turn-1'));
  const second = await store.write(turnArgs('turn-1', {
    pages: [{ path: 'index.html', state: 'same', before: png(80, 3), after: null, width: 1, height: 1 }],
  }));
  assert.equal(fs.existsSync(fileURLToPath(first.pages[0].beforeUrl)), false);
  assert.equal(fs.existsSync(fileURLToPath(first.pages[0].afterUrl)), false);
  assert.deepEqual(fs.readFileSync(fileURLToPath(second.pages[0].beforeUrl)), png(80, 3));
  const dir = turnDir(rootDir, 'sess-1', 'turn-1');
  assert.equal(fs.readdirSync(dir).length, 2);
});

test('stray temp files in a turn folder are removed by the next write', async () => {
  const { store, rootDir } = makeStore();
  await store.write(turnArgs('turn-1'));
  const dir = turnDir(rootDir, 'sess-1', 'turn-1');
  fs.writeFileSync(path.join(dir, 'meta.json.tmp-abc123'), '{');
  fs.writeFileSync(path.join(dir, 'p9-before-aaaaaaaaaaaa.png'), png());
  await store.write(turnArgs('turn-1'));
  const names = fs.readdirSync(dir);
  assert.equal(names.some((name) => name.includes('tmp')), false);
  assert.equal(names.includes('p9-before-aaaaaaaaaaaa.png'), false);
});

test('list filters by session and orders newest first', async () => {
  const { store, clock } = makeStore();
  for (const [session, turn, offsetSec] of [
    ['sess-1', 'a', 10], ['sess-2', 'x', 20], ['sess-1', 'b', 30], ['sess-1', 'c', 5],
  ]) {
    clock.at = Date.UTC(2026, 10, 9, 12, 0, offsetSec);
    await store.write(turnArgs(turn, { sessionId: session }));
  }
  const listed = await store.list({ workspaceId: WORKSPACE, sessionId: 'sess-1' });
  assert.deepEqual(listed.map((record) => record.turnId), ['b', 'a', 'c']);
  assert.deepEqual(
    (await store.list({ workspaceId: WORKSPACE, sessionId: 'sess-2' })).map((r) => r.turnId),
    ['x'],
  );
  assert.deepEqual(await store.list({ workspaceId: WORKSPACE, sessionId: 'nobody' }), []);
  assert.deepEqual(await store.list({ workspaceId: 'root_other00000000000000000000', sessionId: 'sess-1' }), []);
});

test('pruning by count keeps the newest turns', async () => {
  const { store, rootDir, clock } = makeStore({ maxTurnsPerWorkspace: 3 });
  for (let i = 1; i <= 5; i += 1) {
    clock.at = Date.UTC(2026, 10, 9, 12, 0, i);
    await store.write(turnArgs(`t${i}`));
  }
  assert.equal(turnFolders(rootDir).length, 3);
  const listed = await store.list({ workspaceId: WORKSPACE, sessionId: 'sess-1' });
  assert.deepEqual(listed.map((record) => record.turnId), ['t5', 't4', 't3']);
});

test('pruning never deletes the turn just written, even when it looks oldest', async () => {
  const { store, clock } = makeStore({ maxTurnsPerWorkspace: 2 });
  clock.at = Date.UTC(2026, 10, 9, 12, 0, 30);
  await store.write(turnArgs('t1'));
  clock.at = Date.UTC(2026, 10, 9, 12, 0, 40);
  await store.write(turnArgs('t2'));
  clock.at = Date.UTC(2026, 10, 9, 11, 0, 0);
  await store.write(turnArgs('old'));
  const listed = await store.list({ workspaceId: WORKSPACE, sessionId: 'sess-1' });
  assert.deepEqual(listed.map((record) => record.turnId).sort(), ['old', 't2']);
});

test('pruning by bytes deletes the oldest turns first', async () => {
  // Each turn holds two 100-byte pictures: 200 bytes.
  const { store, clock } = makeStore({ maxBytesPerWorkspace: 450 });
  const pages = [{ path: 'a.html', state: 'ready', before: png(100), after: png(100), width: 1, height: 1 }];
  for (let i = 1; i <= 4; i += 1) {
    clock.at = Date.UTC(2026, 10, 9, 12, 0, i);
    await store.write(turnArgs(`t${i}`, { pages }));
  }
  const listed = await store.list({ workspaceId: WORKSPACE, sessionId: 'sess-1' });
  assert.deepEqual(listed.map((record) => record.turnId), ['t4', 't3']);
});

test('a folder with no readable meta is the oldest and goes first; other names are left alone', async () => {
  const { store, rootDir, clock } = makeStore({ maxTurnsPerWorkspace: 2 });
  clock.at = Date.UTC(2026, 10, 9, 12, 0, 1);
  await store.write(turnArgs('t1'));
  const orphan = path.join(rootDir, WORKSPACE, 'f'.repeat(32));
  fs.mkdirSync(orphan);
  fs.writeFileSync(path.join(orphan, 'meta.json'), 'not json');
  const bystander = path.join(rootDir, WORKSPACE, 'notes');
  fs.mkdirSync(bystander);
  clock.at = Date.UTC(2026, 10, 9, 12, 0, 2);
  await store.write(turnArgs('t2'));
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(bystander), true);
  const listed = await store.list({ workspaceId: WORKSPACE, sessionId: 'sess-1' });
  assert.deepEqual(listed.map((record) => record.turnId), ['t2', 't1']);
});

test('pruning one workspace leaves another workspace alone', async () => {
  const { store, clock } = makeStore({ maxTurnsPerWorkspace: 1 });
  const other = 'root_ffffffffffffffffffffffff';
  clock.at = Date.UTC(2026, 10, 9, 12, 0, 1);
  await store.write(turnArgs('t1', { workspaceId: other }));
  clock.at = Date.UTC(2026, 10, 9, 12, 0, 2);
  await store.write(turnArgs('t2'));
  clock.at = Date.UTC(2026, 10, 9, 12, 0, 3);
  await store.write(turnArgs('t3'));
  assert.equal((await store.list({ workspaceId: other, sessionId: 'sess-1' })).length, 1);
  assert.equal((await store.list({ workspaceId: WORKSPACE, sessionId: 'sess-1' })).length, 1);
});

test('the workspace least recently added to goes once there are too many; other names are left alone', async () => {
  const { store, rootDir } = makeStore({ maxWorkspaces: 2 });
  const ids = ['root_aaaaaaaaaaaaaaaaaaaaaaaa', 'root_bbbbbbbbbbbbbbbbbbbbbbbb', 'root_cccccccccccccccccccccccc'];
  fs.mkdirSync(path.join(rootDir, 'not a workspace'), { recursive: true });
  await store.write(turnArgs('t1', { workspaceId: ids[0] }));
  await store.write(turnArgs('t1', { workspaceId: ids[1] }));
  // Folder times are too coarse to order two writes in one test run.
  fs.utimesSync(path.join(rootDir, ids[0]), new Date(2026, 0, 2), new Date(2026, 0, 2));
  fs.utimesSync(path.join(rootDir, ids[1]), new Date(2026, 0, 1), new Date(2026, 0, 1));
  await store.write(turnArgs('t1', { workspaceId: ids[2] }));
  assert.deepEqual(fs.readdirSync(rootDir).sort(), [ids[0], ids[2], 'not a workspace'].sort());
});

test('a failed prune is logged and does not fail the write', async () => {
  const logs = [];
  const fsImpl = {
    ...fs,
    promises: {
      ...fs.promises,
      unlink: async () => { throw Object.assign(new Error('unlink refused'), { code: 'EIO' }); },
    },
  };
  const { store, clock } = makeStore({
    fsImpl,
    maxTurnsPerWorkspace: 1,
    logger: (level, event, details) => logs.push({ level, event, details }),
  });
  clock.at = Date.UTC(2026, 10, 9, 12, 0, 1);
  await store.write(turnArgs('t1'));
  clock.at = Date.UTC(2026, 10, 9, 12, 0, 2);
  const record = await store.write(turnArgs('t2'));
  assert.equal(record.turnId, 't2');
  assert.ok(logs.some((entry) => /prune/.test(entry.event)), JSON.stringify(logs));
});

test('invalid ids and an unconfigured store follow the contract', async () => {
  const { store } = makeStore();
  const badWrites = [
    turnArgs('t', { workspaceId: '../escape' }),
    turnArgs('t', { workspaceId: '' }),
    turnArgs('t', { workspaceId: 'a'.repeat(81) }),
    turnArgs('t', { workspaceId: 'has space' }),
    turnArgs('', {}),
    turnArgs('t', { sessionId: '' }),
    turnArgs('t', { sessionId: 's'.repeat(201) }),
    turnArgs('t'.repeat(201)),
    turnArgs(42),
  ];
  for (const args of badWrites) {
    await assert.rejects(store.write(args), (error) => error.code === 'ERR_CHANGE_PICTURES_INPUT');
  }
  await assert.rejects(store.write(), (error) => error.code === 'ERR_CHANGE_PICTURES_INPUT');
  const bad = { workspaceId: '..', sessionId: 's', turnId: 't' };
  assert.equal(await store.read(bad), null);
  assert.deepEqual(await store.list({ workspaceId: '..', sessionId: 's' }), []);
  assert.equal(await store.remove(bad), false);

  const unconfigured = createChangePictureStore({ rootDir: '' });
  assert.equal(unconfigured.getRootDir(), '');
  await assert.rejects(unconfigured.write(turnArgs('t')), (error) => error.code === 'ERR_CHANGE_PICTURES_INPUT');
  const ok = { workspaceId: WORKSPACE, sessionId: 's', turnId: 't' };
  assert.equal(await unconfigured.read(ok), null);
  assert.deepEqual(await unconfigured.list(ok), []);
  assert.equal(await unconfigured.remove(ok), false);
});

test('a tampered meta.json is handled without trusting its names', async () => {
  const { store, rootDir } = makeStore();
  await store.write(turnArgs('turn-1'));
  const ids = { workspaceId: WORKSPACE, sessionId: 'sess-1', turnId: 'turn-1' };
  const dir = turnDir(rootDir, 'sess-1', 'turn-1');
  const metaPath = path.join(dir, 'meta.json');
  const good = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const writeMeta = (value) => fs.writeFileSync(metaPath, typeof value === 'string' ? value : JSON.stringify(value));

  writeMeta('{ not json');
  assert.equal(await store.read(ids), null);
  assert.deepEqual(await store.list({ workspaceId: WORKSPACE, sessionId: 'sess-1' }), []);

  writeMeta({ ...good, version: 2 });
  assert.equal(await store.read(ids), null);

  writeMeta({ ...good, turnId: 'someone-else' });
  assert.equal(await store.read(ids), null);

  writeMeta({ ...good, sessionId: 'someone-else' });
  assert.equal(await store.read(ids), null);

  writeMeta({
    ...good,
    pages: [
      { ...good.pages[0], before: '../../outside.png', after: 'sub/p0-after-aaaaaaaaaaaa.png' },
      { ...good.pages[0], before: 'p0-before-zzzzzzzzzzzz.png', after: good.pages[0].after, state: 'weird' },
      { ...good.pages[0], before: 'C:\\x\\p0-before-aaaaaaaaaaaa.png', after: good.pages[0].after },
    ],
  });
  const record = await store.read(ids);
  assert.ok(record);
  assert.equal(record.pages[0].beforeUrl, null);
  assert.equal(record.pages[0].afterUrl, null);
  assert.equal(record.pages.every((page) => PICTURE_STATES.includes(page.state)), true);
  const urls = record.pages.flatMap((page) => [page.beforeUrl, page.afterUrl]).filter(Boolean);
  for (const url of urls) {
    assert.equal(path.dirname(fileURLToPath(url)), dir);
  }
});

test('remove deletes the turn folder and reports whether one existed', async () => {
  const { store, rootDir } = makeStore();
  await store.write(turnArgs('turn-1'));
  await store.write(turnArgs('turn-2'));
  const ids = { workspaceId: WORKSPACE, sessionId: 'sess-1', turnId: 'turn-1' };
  assert.equal(await store.remove(ids), true);
  assert.equal(fs.existsSync(turnDir(rootDir, 'sess-1', 'turn-1')), false);
  assert.equal(await store.read(ids), null);
  assert.equal(await store.remove(ids), false);
  assert.equal(fs.existsSync(turnDir(rootDir, 'sess-1', 'turn-2')), true);
});

test('read returns null for a turn that was never written', async () => {
  const { store } = makeStore();
  assert.equal(await store.read({ workspaceId: WORKSPACE, sessionId: 'sess-1', turnId: 'none' }), null);
});
