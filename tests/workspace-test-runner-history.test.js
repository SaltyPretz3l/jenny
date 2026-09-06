'use strict';
// SPEC: Workspace Test Runner P0 — metadata-only run history.
//   S5a (Reliability) — append-only, bounded ring per config; corrupt/missing
//     read -> {}; appending never loses prior records; every terminal status
//     (incl. error/aborted/timeout/interrupted) is recorded safely.
//   S5b (Reliability) — crash/reload reconciliation: orphaned 'running' records
//     are rewritten to 'interrupted' on start; phantom 'running' never survives.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestRunnerHistory } = require('../services/workspace-test-runner-history');

function makeStore(initial) {
  let value = initial;
  return {
    read: (def) => (value === undefined ? def : value),
    write: (v) => { value = v; },
    peek: () => value,
  };
}

const NOW = () => new Date(5000);

test('s5a: a corrupt or missing store reads as an empty byConfig map', () => {
  // RED-BECAUSE: history.read throws NotImplementedError (no body yet).
  assert.deepEqual(createTestRunnerHistory({ store: makeStore(undefined) }).read(), { byConfig: {} });
  assert.deepEqual(createTestRunnerHistory({ store: makeStore('garbage') }).read(), { byConfig: {} });
  assert.deepEqual(createTestRunnerHistory({ store: makeStore({ byConfig: 'nope' }) }).read(), { byConfig: {} });
});

test('s5a: recordStart appends a running record visible via getHistory', () => {
  // RED-BECAUSE: recordStart throws (no body yet).
  const history = createTestRunnerHistory({ store: makeStore(undefined), now: NOW });
  history.recordStart('unit', { runId: 'r1', startedAt: '2026-06-20T00:00:00.000Z' });
  const records = history.getHistory('unit');
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    runId: 'r1',
    configId: 'unit',
    status: 'running',
    startedAt: '2026-06-20T00:00:00.000Z',
    exitCode: null,
    durationMs: null,
    finishedAt: null,
  });
  assert.deepEqual(history.getHistory('other'), [], 'unknown config -> []');
});

test('s5a: recordFinish patches the matching run to a terminal status, preserving prior records', () => {
  // RED-BECAUSE: recordStart/recordFinish throw (no body yet).
  const history = createTestRunnerHistory({ store: makeStore(undefined), now: NOW });
  history.recordStart('unit', { runId: 'old', startedAt: 'A' });
  history.recordFinish('unit', 'old', { status: 'passed', exitCode: 0, durationMs: 10, finishedAt: 'A2' });
  history.recordStart('unit', { runId: 'new', startedAt: 'B' });
  history.recordFinish('unit', 'new', { status: 'failed', exitCode: 1, durationMs: 20, finishedAt: 'B2' });
  const records = history.getHistory('unit');
  assert.equal(records.length, 2, 'appending never drops prior records');
  // Full-record deepEqual so a dropped durationMs/finishedAt patch field is caught.
  assert.deepEqual(records, [
    { runId: 'old', configId: 'unit', status: 'passed', startedAt: 'A', exitCode: 0, durationMs: 10, finishedAt: 'A2' },
    { runId: 'new', configId: 'unit', status: 'failed', startedAt: 'B', exitCode: 1, durationMs: 20, finishedAt: 'B2' },
  ]);
  assert.equal(records.every((r) => r.status !== 'running'), true, 'no phantom running survives a finish');
});

test('s5a: recordFinish with no matching start is append-safe and ring-bounded', () => {
  // RED-BECAUSE: recordFinish throws (no body yet).
  const history = createTestRunnerHistory({ store: makeStore(undefined), maxPerConfig: 2, now: NOW });
  // Three finishes with no prior start (e.g. a lost start record) — each appends
  // and the ring still caps at maxPerConfig.
  for (const id of ['a', 'b', 'c']) {
    history.recordFinish('unit', id, { status: 'passed', exitCode: 0, durationMs: 1, finishedAt: 't' });
  }
  const records = history.getHistory('unit');
  assert.equal(records.length, 2, 'orphan finishes still honor the ring cap');
  assert.deepEqual(records.map((r) => r.runId), ['b', 'c']);
  assert.equal(records[0].status, 'passed', 'the patch status wins over the default');
});

test('s5a: recordFinish persists an errorCode patch (so trend math can see "couldn\'t run it")', () => {
  // FINISH_KEYS must carry 'errorCode' end-to-end; a spawn-never-started run
  // records status:'error' WITH the CMP code so the widget/trend can separate it
  // from a suite that ran and failed.
  const history = createTestRunnerHistory({ store: makeStore(undefined), now: NOW });
  history.recordStart('unit', { runId: 'r1', startedAt: 'A' });
  history.recordFinish('unit', 'r1', {
    status: 'error', exitCode: null, durationMs: 0, finishedAt: 'A2', errorCode: 'CMP-TESTRUNNER-0030',
  });
  const record = history.getHistory('unit')[0];
  assert.equal(record.status, 'error');
  assert.equal(record.errorCode, 'CMP-TESTRUNNER-0030', 'errorCode survives the finish patch');
});

test('wide-016: termination confirmation and bounded reason persist with the terminal record', () => {
  const history = createTestRunnerHistory({ store: makeStore(undefined), now: NOW });
  history.recordStart('unit', { runId: 'r1', startedAt: 'A' });
  history.recordFinish('unit', 'r1', {
    status: 'timeout', exitCode: null, durationMs: 1, finishedAt: 'A2',
    terminationConfirmed: false, terminationWarning: 'kill_failed',
  });
  const record = history.getHistory('unit')[0];
  assert.equal(record.terminationConfirmed, false);
  assert.equal(record.terminationWarning, 'kill_failed');
});

test('s5a: the per-config ring is bounded to maxPerConfig (oldest dropped)', () => {
  // RED-BECAUSE: recordStart throws (no body yet).
  const history = createTestRunnerHistory({ store: makeStore(undefined), maxPerConfig: 3, now: NOW });
  for (let i = 1; i <= 5; i += 1) {
    history.recordStart('unit', { runId: `r${i}`, startedAt: `t${i}` });
    history.recordFinish('unit', `r${i}`, { status: 'passed', exitCode: 0, durationMs: i, finishedAt: `t${i}` });
  }
  const records = history.getHistory('unit');
  assert.equal(records.length, 3, 'ring caps at maxPerConfig');
  assert.deepEqual(records.map((r) => r.runId), ['r3', 'r4', 'r5'], 'the newest are kept');
});

test('s5a: every terminal status is recorded safely', () => {
  // RED-BECAUSE: recordStart/recordFinish throw (no body yet).
  const history = createTestRunnerHistory({ store: makeStore(undefined), now: NOW });
  for (const status of ['error', 'aborted', 'timeout', 'interrupted']) {
    history.recordStart(status, { runId: status, startedAt: 't' });
    history.recordFinish(status, status, { status, exitCode: null, durationMs: 1, finishedAt: 't2' });
    assert.equal(history.getHistory(status)[0].status, status);
  }
});

test('s5b: reconcileRunning rewrites orphaned running records to interrupted', () => {
  // RED-BECAUSE: reconcileRunning throws (no body yet).
  const history = createTestRunnerHistory({ store: makeStore(undefined), now: NOW });
  history.recordStart('unit', { runId: 'done', startedAt: 'A' });
  history.recordFinish('unit', 'done', { status: 'passed', exitCode: 0, durationMs: 5, finishedAt: 'A2' });
  history.recordStart('unit', { runId: 'orphan', startedAt: 'B' });   // crashed mid-run, never finished
  history.recordStart('e2e', { runId: 'orphan2', startedAt: 'C' });

  const changed = history.reconcileRunning();
  assert.equal(changed, 2, 'both orphaned running records were reconciled');

  const unit = history.getHistory('unit');
  assert.equal(unit.find((r) => r.runId === 'done').status, 'passed', 'a finished run is untouched');
  const orphan = unit.find((r) => r.runId === 'orphan');
  assert.equal(orphan.status, 'interrupted');
  assert.equal(orphan.finishedAt, new Date(5000).toISOString(), 'interrupted records get a finishedAt stamp');
  assert.equal(history.getHistory('e2e')[0].status, 'interrupted');

  // A phantom running can never reach trend math: none remain.
  const all = history.read().byConfig;
  const stillRunning = Object.values(all).flat().filter((r) => r.status === 'running');
  assert.deepEqual(stillRunning, []);
});

test('s5b: reconcileRunning is idempotent', () => {
  // RED-BECAUSE: reconcileRunning throws (no body yet).
  const history = createTestRunnerHistory({ store: makeStore(undefined), now: NOW });
  history.recordStart('unit', { runId: 'orphan', startedAt: 'B' });
  assert.equal(history.reconcileRunning(), 1);
  assert.equal(history.reconcileRunning(), 0, 'a second reconcile finds nothing to change');
});

// ---------------------------------------------------------------------------
// Verification gate Wave 3: attribution + skip records.
// ---------------------------------------------------------------------------

test('gate: recordStart keeps initiator and gateAttempt, and recordFinish preserves them', () => {
  const history = createTestRunnerHistory({ store: makeStore(undefined), now: NOW });
  history.recordStart('unit', { runId: 'r1', startedAt: 'A', initiator: 'jenny', gateAttempt: 2 });
  assert.deepEqual(history.getHistory('unit')[0], {
    runId: 'r1', configId: 'unit', status: 'running', startedAt: 'A',
    exitCode: null, durationMs: null, finishedAt: null, initiator: 'jenny', gateAttempt: 2,
  });
  history.recordFinish('unit', 'r1', { status: 'failed', exitCode: 1, durationMs: 10, finishedAt: 'B' });
  const finished = history.getHistory('unit')[0];
  assert.equal(finished.initiator, 'jenny', 'the finish patch does not erase attribution');
  assert.equal(finished.gateAttempt, 2);
  assert.equal(finished.status, 'failed');
});

test('gate: attribution is absent (not null) on a user run, and junk is dropped', () => {
  const history = createTestRunnerHistory({ store: makeStore(undefined), now: NOW });
  history.recordStart('unit', { runId: 'r1', startedAt: 'A' });
  history.recordStart('unit', { runId: 'r2', startedAt: 'B', initiator: 42, gateAttempt: 'two' });
  history.recordStart('unit', { runId: 'r3', startedAt: 'C', initiator: '', gateAttempt: 0 });
  history.recordStart('unit', { runId: 'r4', startedAt: 'D', initiator: 'x'.repeat(100), gateAttempt: 1.5 });
  const records = history.getHistory('unit');
  for (const record of records.slice(0, 3)) {
    assert.equal('initiator' in record, false, `${record.runId}: no initiator key`);
    assert.equal('gateAttempt' in record, false, `${record.runId}: no gateAttempt key`);
  }
  assert.equal(records[3].initiator.length, 32, 'initiator is bounded');
  assert.equal('gateAttempt' in records[3], false, 'a non-integer attempt is dropped');
});

test('gate: recordSkip appends a terminal skipped record that reconcile leaves alone', () => {
  const history = createTestRunnerHistory({ store: makeStore(undefined), now: NOW });
  history.recordSkip('unit', { runId: 's1', startedAt: 'A', initiator: 'jenny', reason: 'already_running', gateAttempt: 1 });
  assert.deepEqual(history.getHistory('unit')[0], {
    runId: 's1', configId: 'unit', status: 'skipped', startedAt: 'A',
    exitCode: null, durationMs: null, finishedAt: 'A',
    skipReason: 'already_running', initiator: 'jenny', gateAttempt: 1,
  });
  assert.equal(history.reconcileRunning(), 0, 'a skip is not an orphaned running record');
  assert.equal(history.getHistory('unit')[0].status, 'skipped');
});

test('gate: recordSkip is ring-bounded like every other append', () => {
  const history = createTestRunnerHistory({ store: makeStore(undefined), maxPerConfig: 2, now: NOW });
  history.recordSkip('unit', { runId: 's1', startedAt: 'A', reason: 'already_running' });
  history.recordSkip('unit', { runId: 's2', startedAt: 'B', reason: 'already_running' });
  history.recordSkip('unit', { runId: 's3', startedAt: 'C', reason: 'already_running' });
  assert.deepEqual(history.getHistory('unit').map((r) => r.runId), ['s2', 's3']);
});
