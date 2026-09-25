'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { MAX_PENDING_SESSION } = require('../../services/session-runtime/contracts');
const { RuntimeStore } = require('../../services/session-runtime/store');
const { harness, submission, attempt } = require('../helpers/runtime-store-fixture');

test('reopen accepts a mixed pending and restart-paused recovery index', () => {
  const { io, store } = harness();
  const pending = [];
  for (let index = 0; index < MAX_PENDING_SESSION; index += 1) {
    pending.push(store.submit(submission({ idempotencyKey: `mixed_${index}`,
      workId: `mixed_work_${index}`, turnId: `mixed_turn_${index}` })).record);
  }
  store.transition(pending[0].work_id, { expectedRevision: pending[0].revision,
    to: 'running', reason: 'dispatch', attempt: attempt(1) });
  store.submit(submission({ idempotencyKey: 'mixed_replacement',
    workId: 'mixed_replacement', turnId: 'mixed_replacement_turn' }));
  let recoveryTransitions = 0;
  let id = 0;
  assert.throws(() => new RuntimeStore('RUNTIME', { io,
    createId(prefix) {
      if (prefix === 'transition' && ++recoveryTransitions === 2) {
        throw new Error('simulated process exit');
      }
      return `${prefix}_crash_${++id}`;
    },
  }), /simulated process exit/);

  const reopened = harness(io).store;
  assert.equal(reopened.getStatus().read_only, false);
  assert.equal(reopened.get(pending[0].work_id).recovery.kind, 'restart_paused');
  assert.equal(reopened.listReadyCandidates().length, 0);
});

test('reopen accepts interrupted recovery with an ordinary paused record', () => {
  const { io, store } = harness();
  const pending = [];
  for (let index = 0; index < MAX_PENDING_SESSION; index += 1) {
    pending.push(store.submit(submission({ idempotencyKey: `ordinary_mixed_${index}`,
      workId: `ordinary_mixed_work_${index}`, turnId: `ordinary_mixed_turn_${index}` })).record);
  }
  store.transition(pending[0].work_id, { expectedRevision: pending[0].revision,
    to: 'running', reason: 'dispatch', attempt: attempt(1) });
  const ordinaryPaused = store.transition(pending[1].work_id, { expectedRevision: pending[1].revision,
    to: 'paused', reason: 'user_pause' }).record;
  store.submit(submission({ idempotencyKey: 'ordinary_mixed_replacement',
    workId: 'ordinary_mixed_replacement', turnId: 'ordinary_mixed_replacement_turn' }));
  let recoveryTransitions = 0;
  let id = 0;
  assert.throws(() => new RuntimeStore('RUNTIME', { io,
    createId(prefix) {
      if (prefix === 'transition' && ++recoveryTransitions === 2) {
        throw new Error('simulated process exit');
      }
      return `${prefix}_ordinary_crash_${++id}`;
    },
  }), /simulated process exit/);

  const reopened = harness(io).store;
  assert.equal(reopened.getStatus().read_only, false);
  assert.equal(reopened.get(ordinaryPaused.work_id).recovery, null);
  assert.equal(reopened.listReadyCandidates().length, 0);
});

// A journal whose removal keeps failing (EPERM on Windows while a scanner holds
// the file) must never poison the store: the commit is complete on disk, so both
// the live store and a reopened store stay writable and list the committed record.
test('a committed journal that cannot be removed stays cleanup-only across reopen', () => {
  const logs = [];
  const { io, store } = harness(undefined, { logger: (...entry) => logs.push(entry) });
  const pending = store.submit(submission()).record;
  const remove = io.remove.bind(io);
  let blockJournal = true;
  io.remove = (filePath) => {
    if (blockJournal && filePath === store.journalPath) {
      throw Object.assign(new Error('busy journal'), { code: 'EPERM' });
    }
    remove(filePath);
  };
  const paused = store.transition(pending.work_id, { expectedRevision: pending.revision,
    to: 'paused', reason: 'hold' }).record;
  assert.equal(store.getStatus().read_only, false);
  assert.equal(io.files.has(path.join('RUNTIME', 'transition.json')), true);

  const reopenLogs = [];
  const reopened = harness(io, { logger: (...entry) => reopenLogs.push(entry) }).store;
  assert.equal(reopened.getStatus().read_only, false, JSON.stringify(reopened.getStatus()));
  assert.deepEqual(reopened.get(pending.work_id), paused);
  assert.equal(reopened.listSummaries({ limit: 10 }).items.length, 1);
  assert.equal(io.files.has(path.join('RUNTIME', 'transition.json')), true, 'the stuck journal is left for later cleanup');
  assert.deepEqual(reopenLogs.filter(([level]) => level === 'WARN').map(([, event]) => event),
    ['runtime_store.journal_remove_failed']);

  blockJournal = false;
  const cancelled = reopened.transition(paused.work_id, { expectedRevision: paused.revision,
    to: 'cancelled', reason: 'stop' }).record;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(io.files.has(path.join('RUNTIME', 'transition.json')), false);
  assert.deepEqual(logs.filter(([level]) => level === 'WARN').map(([, event]) => event),
    ['runtime_store.journal_remove_failed']);
});

test('journal removal failure keeps the commit writable and replaces the stale journal', () => {
  const logs = [];
  const { io, store } = harness(undefined, { logger: (...entry) => logs.push(entry) });
  const pending = store.submit(submission()).record;
  const remove = io.remove.bind(io);
  let failRemove = true;
  io.remove = (filePath) => {
    if (failRemove) {
      failRemove = false;
      throw Object.assign(new Error('busy journal'), { code: 'EPERM' });
    }
    remove(filePath);
  };
  const paused = store.transition(pending.work_id, { expectedRevision: pending.revision,
    to: 'paused', reason: 'hold' }).record;
  assert.equal(store.getStatus().read_only, false);
  assert.deepEqual(store.get(pending.work_id), paused);
  assert.equal(io.files.has(path.join('RUNTIME', 'transition.json')), true);
  assert.deepEqual(logs, [['WARN', 'runtime_store.journal_remove_failed', { error_code: 'EPERM' }]]);
  const cancelled = store.transition(paused.work_id, { expectedRevision: paused.revision,
    to: 'cancelled', reason: 'stop' }).record;
  assert.equal(io.files.has(path.join('RUNTIME', 'transition.json')), false);

  const reopened = harness(io).store;
  assert.equal(reopened.getStatus().read_only, false);
  assert.deepEqual(reopened.get(pending.work_id), cancelled);
  assert.equal(io.files.has(path.join('RUNTIME', 'transition.json')), false);
});
