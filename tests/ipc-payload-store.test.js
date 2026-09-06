'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createIpcPayloadStore } = require('../services/backend/ipc-payload-store');

const NOW_MS = 2_000_000_000_000;
const GRACE_MS = 1_000;

function createFixture(t, fsImpl = fs) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ipc-payload-store-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const rootDir = path.join(userDataPath, 'background-memory', 'ipc-payloads');
  fs.mkdirSync(rootDir, { recursive: true });
  const store = createIpcPayloadStore({ userDataPath, fsImpl, now: () => NOW_MS });
  return {
    rootDir,
    store,
    write(name, ageMs) {
      const filePath = path.join(rootDir, name);
      fs.writeFileSync(filePath, name);
      const mtime = new Date(NOW_MS - ageMs);
      fs.utimesSync(filePath, mtime, mtime);
      return filePath;
    },
  };
}

const timing = { nowMs: NOW_MS, graceMs: GRACE_MS };

test('deletes an unreferenced payload older than the grace window', (t) => {
  const { store, write } = createFixture(t);
  const filePath = write('old.json', GRACE_MS + 1);

  assert.deepEqual(store.prunePayloadPaths(['old.json'], new Set(), timing), { deleted: 1 });
  assert.equal(fs.existsSync(filePath), false);
});

test('keeps an unreferenced payload newer than the grace window', (t) => {
  const { store, write } = createFixture(t);
  const filePath = write('in-flight.json', GRACE_MS - 1);

  assert.deepEqual(
    store.prunePayloadPaths(['in-flight.json'], new Set(), timing),
    { deleted: 0 }
  );
  assert.equal(fs.existsSync(filePath), true);
});

test('keeps a referenced payload regardless of age', (t) => {
  const { store, write } = createFixture(t);
  const filePath = write('live.json', GRACE_MS * 10);

  assert.deepEqual(
    store.prunePayloadPaths(['live.json'], new Set(['live.json']), timing),
    { deleted: 0 }
  );
  assert.equal(fs.existsSync(filePath), true);
});

test('empty userDataPath makes every method a no-op', () => {
  let touched = false;
  const fail = () => {
    touched = true;
    throw new Error('must not touch dependencies');
  };
  const store = createIpcPayloadStore({
    userDataPath: '',
    fsImpl: { readdirSync: fail, statSync: fail, unlinkSync: fail },
    now: fail,
  });

  assert.equal(store.rootDir, '');
  assert.deepEqual(store.listOrphanCandidates(), []);
  assert.deepEqual(store.prunePayloadPaths(['old.json'], new Set()), { deleted: 0 });
  assert.deepEqual(store.pruneUnreferencedPayloads(new Set()), { deleted: 0 });
  assert.equal(touched, false);
});

test('an unlink race does not abort later payload deletions', (t) => {
  const fsImpl = {
    readdirSync: fs.readdirSync,
    statSync: fs.statSync,
    unlinkSync(filePath) {
      if (path.basename(filePath) === 'vanished.json') {
        fs.unlinkSync(filePath);
        throw Object.assign(new Error('already gone'), { code: 'ENOENT' });
      }
      fs.unlinkSync(filePath);
    },
  };
  const { store, write } = createFixture(t, fsImpl);
  const vanishedPath = write('vanished.json', GRACE_MS + 1);
  const otherPath = write('other.json', GRACE_MS + 1);

  assert.deepEqual(
    store.prunePayloadPaths(['vanished.json', 'other.json'], new Set(), timing),
    { deleted: 1 }
  );
  assert.equal(fs.existsSync(vanishedPath), false);
  assert.equal(fs.existsSync(otherPath), false);
});

test('pruneUnreferencedPayloads deletes only unreferenced orphans', (t) => {
  const { rootDir, store, write } = createFixture(t);
  write('orphan.json', GRACE_MS + 1);
  write('live.json', GRACE_MS + 1);

  assert.deepEqual(
    store.pruneUnreferencedPayloads(new Set(['live.json']), timing),
    { deleted: 1 }
  );
  assert.deepEqual(fs.readdirSync(rootDir), ['live.json']);
});

test('a directory read failure returns no candidates', (t) => {
  const fsImpl = {
    readdirSync() {
      throw new Error('directory unavailable');
    },
    statSync: fs.statSync,
    unlinkSync: fs.unlinkSync,
  };
  const { store } = createFixture(t, fsImpl);

  assert.deepEqual(store.listOrphanCandidates(timing), []);
});

test('unlinks the real on-disk name when the candidate arrives normalized', (t) => {
  // Candidates come from payloadPathsFromMessages, which lowercases. Statting
  // that lowercased name only resolves on a case-insensitive filesystem, so the
  // store matches the directory listing by key and must unlink the REAL name --
  // asserted directly here so the behaviour holds on every platform, not just
  // the one this suite happens to run on.
  const unlinked = [];
  const fsImpl = {
    readdirSync: fs.readdirSync,
    statSync: fs.statSync,
    unlinkSync(filePath) {
      unlinked.push(path.basename(filePath));
      fs.unlinkSync(filePath);
    },
  };
  const { store, write } = createFixture(t, fsImpl);
  write('Req-ABC-Mixed.json', GRACE_MS + 1);

  const result = store.prunePayloadPaths(['req-abc-mixed.json'], new Set(), timing);

  assert.deepEqual(result, { deleted: 1 });
  assert.deepEqual(unlinked, ['Req-ABC-Mixed.json']);
});

test('a normalized candidate that is still referenced survives the case fold', (t) => {
  const { store, write } = createFixture(t);
  const filePath = write('Req-ABC-Mixed.json', GRACE_MS + 1);

  assert.deepEqual(
    store.prunePayloadPaths(['req-abc-mixed.json'], new Set(['req-abc-mixed.json']), timing),
    { deleted: 0 }
  );
  assert.equal(fs.existsSync(filePath), true);
});
