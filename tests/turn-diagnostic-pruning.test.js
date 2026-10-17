'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dumpTurnDiagnostic, pruneTurnDiagnostics } = require('../services/backend/turn-diagnostic-dump');

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-diagnostic-pruning-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function countSweeps(t, root) {
  const original = fs.promises.readdir;
  let count = 0;
  t.mock.method(fs.promises, 'readdir', async function (dir, ...args) {
    if (dir === root) count += 1;
    return original.call(this, dir, ...args);
  });
  return () => count;
}

test('prune sweeps once and applies bytes to files remaining after age and count', async (t) => {
  const userDataPath = tempRoot(t);
  const root = path.join(userDataPath, 'diagnostics');
  const oldDir = path.join(root, '2026-01-01');
  const recentDir = path.join(root, '2026-10-14');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(recentDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'old.json'), 'x'.repeat(100));
  const files = Array.from({ length: 4 }, (_, index) => {
    const file = path.join(recentDir, `${index}.json`);
    fs.writeFileSync(file, 'x'.repeat(10));
    const timestamp = new Date(Date.UTC(2026, 9, 14, 0, index));
    fs.utimesSync(file, timestamp, timestamp);
    return file;
  });
  const sweeps = countSweeps(t, root);
  const daySweeps = countSweeps(t, recentDir);
  const result = await pruneTurnDiagnostics({
    userDataPath, now: new Date('2026-10-14T12:00:00Z'), maxFiles: 3, maxTotalBytes: 20,
  });
  assert.equal(sweeps(), 1);
  assert.equal(daySweeps(), 1);
  assert.equal(result.removedCount, 3);
  assert.equal(fs.existsSync(oldDir), false);
  assert.deepEqual(files.map((file) => fs.existsSync(file)), [false, false, true, true]);
});

test('dumps prune first and once per ten minutes per root, including concurrent dumps', async (t) => {
  const userDataPath = tempRoot(t);
  const otherPath = tempRoot(t);
  const sweeps = countSweeps(t, path.join(userDataPath, 'diagnostics'));
  const otherSweeps = countSweeps(t, path.join(otherPath, 'diagnostics'));
  let now = 1000000;
  t.mock.method(Date, 'now', () => now);
  const dump = (root, streamId) => dumpTurnDiagnostic({
    service: { options: { userDataPath: root } }, streamId, providerDiagnostics: null,
  });
  await Promise.all([dump(userDataPath, 'first'), dump(userDataPath, 'concurrent')]);
  assert.equal(sweeps(), 1);
  now += 599999;
  await dump(userDataPath, 'before');
  assert.equal(sweeps(), 1);
  now += 1;
  await dump(userDataPath, 'after');
  assert.equal(sweeps(), 2);
  await dump(otherPath, 'other');
  assert.equal(otherSweeps(), 1);
  // A direct prune is deliberately never throttled.
  await pruneTurnDiagnostics({ userDataPath });
  assert.equal(sweeps(), 3);
  assert.ok(fs.existsSync(path.join(otherPath, 'diagnostics')));
});
