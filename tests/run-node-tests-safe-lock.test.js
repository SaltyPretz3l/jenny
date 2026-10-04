'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const safeRunner = require('../scripts/run-node-tests-safe');

test('run lock protects fresh incomplete publication and reclaims aged corrupt metadata', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-lock-publication-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const lockPath = path.join(tempRoot, safeRunner.LOCK_BASENAME);
  for (const contents of ['', '{"pid":']) {
    fs.writeFileSync(lockPath, contents);
    const lock = await safeRunner.acquireRunLock({ cwd: tempRoot, waitMs: 0, log() {} });
    lock?.release();
    assert.equal(lock, null, 'fresh incomplete lock must not be reclaimed');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), contents);
  }
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(lockPath, old, old);
  const reclaimed = await safeRunner.acquireRunLock({ cwd: tempRoot, waitMs: 0, staleMs: 1000, log() {} });
  assert.ok(reclaimed, 'aged corrupt lock can be reclaimed');
  reclaimed.release();
});

test('a live holder is protected until the stale age, which covers a reused pid', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-lock-live-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const lockPath = path.join(tempRoot, safeRunner.LOCK_BASENAME);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: '2000-01-01T00:00:00Z' }));
  const fresh = await safeRunner.acquireRunLock({ cwd: tempRoot, waitMs: 0, log() {} });
  fresh?.release();
  assert.equal(fresh, null, 'a live holder younger than the stale age must be kept');
  const old = new Date('2000-01-01T00:00:00Z');
  fs.utimesSync(lockPath, old, old);
  const lock = await safeRunner.acquireRunLock({ cwd: tempRoot, waitMs: 0, staleMs: 1000, log() {} });
  assert.ok(lock, 'a lock older than the stale age is reclaimed even when its pid is alive (pid reuse)');
  lock.release();
});

test('a stranded reclaim guard is claimed by exactly one waiter', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-lock-guard-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const guardPath = path.join(tempRoot, `${safeRunner.LOCK_BASENAME}.reclaim`);
  fs.mkdirSync(guardPath);
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(guardPath, old, old);
  const [first, second] = await Promise.all([
    safeRunner.acquireRunLock({ cwd: tempRoot, waitMs: 2000, pollMs: 10, log() {} }),
    safeRunner.acquireRunLock({ cwd: tempRoot, waitMs: 0, log() {} }),
  ]);
  t.after(() => { first?.release(); second?.release(); });
  assert.equal([first, second].filter(Boolean).length, 1, 'only one runner holds the lock');
  assert.equal(fs.readdirSync(tempRoot).filter((name) => name.includes('.reclaim')).length, 0);
});

test('competing stale-lock reclaimer cannot delete a newly acquired replacement', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-lock-reclaim-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const lockPath = path.join(tempRoot, safeRunner.LOCK_BASENAME);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 99_999_999 }));
  let competitor;
  const lock = await safeRunner.acquireRunLock({
    cwd: tempRoot, waitMs: 0,
    log(message) {
      if (message.includes('removing stale')) {
        competitor = safeRunner.acquireRunLock({ cwd: tempRoot, waitMs: 0, log() {} });
      }
    },
  });
  const competingLock = await competitor;
  t.after(() => { lock?.release(); competingLock?.release(); });
  assert.equal(competingLock, null, 'second reclaimer must not acquire during stale removal');
  assert.ok(lock);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, process.pid);
});

test('run lock treats unreadable metadata as held and releases its reclamation guard', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-lock-unreadable-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const lockPath = path.join(tempRoot, safeRunner.LOCK_BASENAME);
  fs.writeFileSync(lockPath, 'unreadable');
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === lockPath) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return read(file, ...args);
  });
  const lock = await safeRunner.acquireRunLock({ cwd: tempRoot, waitMs: 0, log() {} });
  lock?.release();
  assert.equal(lock, null, 'a briefly unreadable lock is waited on, not a runner crash');
  assert.equal(read(lockPath, 'utf8'), 'unreadable');
  assert.equal(fs.existsSync(`${lockPath}.reclaim`), false);
});

test('a stranded reclamation guard blocks instead of deleting a replacement lock', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-lock-guard-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const lockPath = path.join(tempRoot, safeRunner.LOCK_BASENAME);
  fs.mkdirSync(`${lockPath}.reclaim`);
  const lock = await safeRunner.acquireRunLock({ cwd: tempRoot, waitMs: 0, log() {} });
  lock?.release();
  assert.equal(lock, null);
  assert.equal(fs.existsSync(`${lockPath}.reclaim`), true);
});

test('a reclaim guard stranded by a killed runner does not block later runs', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-lock-guard-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const guardPath = `${path.join(tempRoot, safeRunner.LOCK_BASENAME)}.reclaim`;
  fs.mkdirSync(guardPath);
  assert.equal(await safeRunner.acquireRunLock({ cwd: tempRoot, waitMs: 0, log() {} }), null, 'a fresh guard is honoured');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(guardPath, old, old);
  const lock = await safeRunner.acquireRunLock({ cwd: tempRoot, waitMs: 0, log() {} });
  assert.ok(lock, 'a stranded guard is removed');
  lock.release();
  assert.equal(fs.existsSync(guardPath), false);
});
