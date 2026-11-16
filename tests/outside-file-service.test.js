'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WORKSPACE_FS_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const { MAX_GRANTS, OutsideFileService, RESTORE_FILE, isVolumeRootOrShare } = require('../services/main/outside-files/outside-file-service');
const { invokeVersionedWorkspaceFile } = require('../services/main/workspace-file-ipc-result');

function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-outside-svc-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeTimers() {
  const queue = [];
  return {
    setTimer: (fn) => { const handle = { fn, cancelled: false }; queue.push(handle); return handle; },
    clearTimer: (handle) => { if (handle) handle.cancelled = true; },
    flush: () => { for (const handle of queue.splice(0)) if (!handle.cancelled) handle.fn(); },
  };
}

function makeService(t, overrides = {}) {
  const events = [];
  const timers = fakeTimers();
  const service = new OutsideFileService({
    sendBridgeEvent: (methodPath, payload) => events.push([methodPath, payload]),
    watch: () => ({ close() {}, on() {} }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  });
  t.after(() => service.dispose());
  return { service, events, timers };
}

test('intake grants an opaque id; the renderer gets name and folder, never a path to send back', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'Notes.md');
  fs.writeFileSync(file, '# hi');
  const { service, events } = makeService(t);
  await service.intake([file]);
  assert.deepEqual(events.map(([method]) => method), ['outsideFiles.onRequest']);
  const { requests } = service.takePending();
  assert.equal(requests.length, 1);
  const [item] = requests[0].items;
  assert.match(item.id, /^o[0-9a-f]{24}$/);
  assert.deepEqual({ ...item, id: 'x' }, { kind: 'outside', id: 'x', name: 'Notes.md', dirLabel: dir, ext: 'md' });
  assert.deepEqual(service.takePending().requests, [], 'pending requests drain once');
  await service.intake([file]);
  assert.equal(service.takePending().requests[0].items[0].id, item.id, 'the same file reuses its grant');
  const read = await service.readText({ id: item.id });
  assert.equal(read.content, '# hi');
  assert.equal(read.encoding, 'utf-8');
});

test('folders, missing and oversized files come back as failures with codes only', async (t) => {
  const dir = tempDir(t);
  const big = path.join(dir, 'big.log');
  fs.writeFileSync(big, 'x'.repeat(32));
  const { service } = makeService(t, { maxBytes: 16 });
  await service.intake([dir, path.join(dir, 'gone.md'), big]);
  const [request] = service.takePending().requests;
  assert.deepEqual(request.items, []);
  assert.deepEqual(request.failures.map((entry) => entry.code), [CODES.NOT_A_FILE, CODES.NOT_FOUND, CODES.TOO_LARGE]);
});

test('a file inside the current Workspace opens as the Workspace tab, not a grant', async (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'src'));
  const file = path.join(dir, 'src', 'a.ts');
  fs.writeFileSync(file, 'x');
  const { service } = makeService(t, { getWorkspaceRoot: () => dir });
  await service.intake([file]);
  assert.deepEqual(service.takePending().requests[0].items, [{ kind: 'workspace', relPath: 'src/a.ts', name: 'a.ts' }]);
  await service.intake([file], 'restore');
  assert.deepEqual(service.takePending().requests, [], 'restore skips Workspace files (they restore with the Workspace)');
});

test('save is in place through the IPC wrapper; an unknown grant is OUTSIDE_GRANT_UNKNOWN', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'b.txt');
  fs.writeFileSync(file, 'one');
  const { service } = makeService(t);
  await service.intake([file]);
  const { id } = service.takePending().requests[0].items[0];
  const read = await invokeVersionedWorkspaceFile(service, 'readText', { id });
  const saved = await invokeVersionedWorkspaceFile(service, 'writeText', { id, content: 'two', expectedFileVersion: read.fileVersion });
  assert.equal(saved.ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  const stale = await invokeVersionedWorkspaceFile(service, 'writeText', { id, content: 'three', expectedFileVersion: read.fileVersion });
  assert.equal(stale.code, CODES.WRITE_CONFLICT);
  const unknown = await invokeVersionedWorkspaceFile(service, 'readText', { id: 'o000000000000000000000000' });
  assert.equal(unknown.code, CODES.OUTSIDE_GRANT_UNKNOWN);
  assert.ok(!JSON.stringify([stale, unknown]).includes(dir), 'results never carry the path');
});

test('preview images resolve beside the file only; escapes are refused', async (t) => {
  const dir = tempDir(t);
  const inner = path.join(dir, 'doc');
  fs.mkdirSync(path.join(inner, 'img'), { recursive: true });
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  fs.writeFileSync(path.join(inner, 'img', 'a.png'), png);
  fs.writeFileSync(path.join(dir, 'secret.png'), png);
  fs.writeFileSync(path.join(inner, 'README.md'), '![](img/a.png)');
  const { service } = makeService(t);
  await service.intake([path.join(inner, 'README.md')]);
  const { id } = service.takePending().requests[0].items[0];
  const ok = await invokeVersionedWorkspaceFile(service, 'readImage', { id, relPath: 'img/a.png' });
  assert.equal(ok.ok, true);
  assert.equal(ok.mime, 'image/png');
  const escape = await invokeVersionedWorkspaceFile(service, 'readImage', { id, relPath: '../secret.png' });
  assert.equal(escape.ok, false);
  const absolute = await invokeVersionedWorkspaceFile(service, 'readImage', { id, relPath: path.join(dir, 'secret.png') });
  assert.equal(absolute.ok, false);
});

test('open grants are pinned against eviction, watched, and persisted for restore', async (t) => {
  const dir = tempDir(t);
  const userData = tempDir(t);
  const watched = [];
  const writes = [];
  const { service, events, timers } = makeService(t, {
    userDataPath: userData,
    watch: (target, _options, listener) => { watched.push({ target, listener }); return { close() {}, on() {} }; },
    writeJson: async (file, value) => { writes.push([file, value]); fs.writeFileSync(file, JSON.stringify(value)); },
  });
  const kept = path.join(dir, 'kept.md');
  fs.writeFileSync(kept, 'k');
  await service.intake([kept]);
  const keptId = service.takePending().requests[0].items[0].id;
  service.setOpenSet({ ids: [keptId, 'o_not_a_grant'] });
  assert.equal(watched.length, 1);
  assert.equal(watched[0].target, dir);
  for (let i = 0; i < MAX_GRANTS + 4; i += 1) {
    const extra = path.join(dir, `f${i}.md`);
    fs.writeFileSync(extra, String(i));
    await service.intake([extra]);
  }
  service.takePending();
  assert.equal((await service.readText({ id: keptId })).content, 'k', 'the open grant survived eviction');

  watched[0].listener('change', 'other.md');
  timers.flush();
  watched[0].listener('change', 'kept.md');
  timers.flush();
  const changeSeen = () => events.some(([method]) => method === 'outsideFiles.onChange');
  for (let i = 0; i < 100 && !changeSeen(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const changes = events.filter(([method]) => method === 'outsideFiles.onChange');
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0][1], { id: keptId, kind: 'changed' });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.at(-1)[0], path.join(userData, RESTORE_FILE));
  assert.deepEqual(writes.at(-1)[1], { version: 1, paths: [kept] });

  const second = makeService(t, { userDataPath: userData }).service;
  await second.restore();
  const [restored] = second.takePending().requests;
  assert.equal(restored.source, 'restore');
  assert.equal(restored.items[0].name, 'kept.md');
});

test('drive roots and network shares are never watched', () => {
  assert.equal(isVolumeRootOrShare('C:\\', 'win32'), process.platform === 'win32');
  assert.equal(isVolumeRootOrShare('\\\\server\\share\\docs', 'win32'), true);
  assert.equal(isVolumeRootOrShare(path.join(os.tmpdir(), 'x'), process.platform), false);
});

test('a re-check with the held version answers unchanged from one stat, and reads again after any change', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'log.txt');
  fs.writeFileSync(file, 'one\n');
  const reads = [];
  const { service } = makeService(t, {
    fs: { ...fs.promises, open: (...args) => { reads.push(args[1]); return fs.promises.open(...args); } },
  });
  const request = await service.intake([file], 'launch');
  const { id } = request.items[0];
  const first = await service.readText({ id });
  assert.equal(first.content, 'one\n');
  const before = reads.length;
  const echo = await service.readText({ id, ifVersion: first.fileVersion });
  assert.deepEqual([echo.unchanged, echo.fileVersion, 'content' in echo], [true, first.fileVersion, false]);
  assert.equal(reads.length, before, 'no file handle opened for an unchanged re-check');
  // Our own save is remembered: its echo is unchanged too, and no stats leak to the renderer.
  const saved = await service.writeText({ id, content: 'two\n', expectedFileVersion: first.fileVersion });
  assert.equal('stats' in saved, false);
  assert.equal((await service.readText({ id, ifVersion: saved.fileVersion })).unchanged, true);
  // A change on disk (new size) is read in full, even with the held version.
  fs.writeFileSync(file, 'three!\n');
  const changed = await service.readText({ id, ifVersion: saved.fileVersion });
  assert.deepEqual([changed.unchanged, changed.content], [undefined, 'three!\n']);
});

test('a top-level Workspace name starting with two dots is inside the Workspace', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, '..notes.md');
  fs.writeFileSync(file, '# dots');
  const { service } = makeService(t, { getWorkspaceRoot: () => dir });
  const request = await service.intake([file], 'launch');
  assert.deepEqual(request.items, [{ kind: 'workspace', relPath: '..notes.md', name: '..notes.md' }]);
});
