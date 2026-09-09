'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ExecutionBroker, validateCommand, readReceipt } = require('../../services/host/execution-broker');
const OLD = '11111111-1111-4111-8111-111111111111';
const NEXT = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.cwd(), 'tmp-broker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function terminal(jobId, status = 'completed') {
  return { schema_version: 1, incarnation: OLD, job_id: jobId, status, exit_code: 0,
    stdout: 'verified output', stderr: '', output_truncated: false, reason: null };
}
function ready(incarnation = OLD, previous = null) {
  return { incarnation, phase: 'ready', job_id: null, previous_result: previous };
}
test('command contract rejects escaping cwd, extra fields and unbounded arguments', () => {
  assert.equal(validateCommand({ command: 'python3 -c "print(2+2)"' }).timeoutSeconds, 10);
  for (const changes of [{ command: '' }, { command: 'x\0y' }, { command: 'x'.repeat(16385) },
    { cwd: '../secret' }, { cwd: '/data' }, { cwd: 'C:\\secret' },
    { timeoutSeconds: 121 }, { timeoutSeconds: NaN }, { run_in_background: true },
    { expectedExitCodes: [0, 0] }, { expectedExitCodes: [256] }]) {
    assert.throws(() => validateCommand({ command: 'true', ...changes }), /sandbox_/);
  }
});
test('terminal result and drain wait for a different authenticated incarnation', async (t) => {
  let state = ready();
  let waiting;
  const reachedWait = new Promise((resolve) => { waiting = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let jobId;
  const broker = new ExecutionBroker({ userDataPath: fixture(t),
    wait: async () => { waiting(); await gate; },
    request: async (operation, fields) => {
      if (operation === 'status') return state;
      if (operation === 'submit') {
        jobId = fields.job_id;
        state = { ...ready(OLD, terminal(jobId)), phase: 'recycling', job_id: jobId };
        return { accepted: true };
      }
      throw new Error('unexpected request');
    } });
  await broker.prepare();
  let settled = false;
  const execution = broker.execute({ command: 'printf verified' }, { streamId: 'stream-1' }).then((value) => {
    settled = true; return value;
  });
  await reachedWait;
  let drained = false;
  const drain = broker.drainStream('stream-1').then(() => { drained = true; });
  assert.equal(settled, false);
  assert.equal(drained, false);
  assert.equal(readReceipt(broker.filePath).pending.job_id, jobId);
  state = ready(NEXT, terminal(jobId));
  release();
  const result = await execution;
  await drain;
  assert.equal(result.cleanup_confirmed, true);
  assert.equal(result.success, true);
  assert.equal(drained, true);
  assert.equal(readReceipt(broker.filePath).pending, null);
  await broker.close();
});
test('lost submit response is fenced by cancellation, never replayed', async (t) => {
  let state = ready();
  const requests = [];
  const broker = new ExecutionBroker({ userDataPath: fixture(t), request: async (operation, fields) => {
    requests.push(operation);
    if (operation === 'status') return state;
    if (operation === 'submit') throw new Error('reply lost after admission');
    if (operation === 'cancel') {
      state = ready(NEXT, terminal(fields.job_id, 'cancelled'));
      return { accepted: true };
    }
    throw new Error('unexpected');
  } });
  await broker.prepare();
  const result = await broker.execute({ command: 'touch file' });
  assert.equal(requests.filter((value) => value === 'submit').length, 1);
  assert.ok(requests.includes('cancel'));
  assert.equal(result.status, 'cancelled');
  assert.equal(result.success, false);
  assert.equal(readReceipt(broker.filePath).pending, null);
});
test('recovery consumes an idle old incarnation instead of forgetting ambiguous admission', async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'sandbox-admission.json'),
    JSON.stringify({ schema_version: 1, pending: { job_id: JOB, incarnation: OLD } }));
  let state = ready();
  const calls = [];
  const broker = new ExecutionBroker({ userDataPath: root, request: async (operation, fields) => {
    calls.push(operation);
    if (operation === 'cancel') { state = ready(NEXT, terminal(fields.job_id, 'cancelled')); return { accepted: true }; }
    return state;
  } });
  await broker.prepare();
  assert.equal(calls[0], 'cancel');
  assert.equal(calls.includes('submit'), false);
  assert.equal(broker.status().available, true);
  assert.equal(readReceipt(broker.filePath).pending, null);
});
test('mismatched cleanup receipt poisons admission and retains durable identity', async (t) => {
  let state = ready();
  const broker = new ExecutionBroker({ userDataPath: fixture(t), request: async (operation) => {
    if (operation === 'submit') { state = ready(NEXT, terminal(JOB)); return { accepted: true }; }
    return state;
  } });
  await broker.prepare();
  await assert.rejects(broker.execute({ command: 'true' }), /sandbox_receipt_mismatch/);
  assert.equal(broker.status().available, false);
  assert.ok(readReceipt(broker.filePath).pending);
  await assert.rejects(broker.execute({ command: 'true' }), /sandbox_unavailable/);
  await assert.rejects(broker.drainStream('any'), /sandbox_cleanup_unconfirmed/);
});
test('uncertain receipt clear cannot report successful command settlement', async (t) => {
  let state = ready();
  let receipt;
  const broker = new ExecutionBroker({ userDataPath: fixture(t),
    readReceiptImpl: () => ({ schema_version: 1, pending: null }),
    writeReceiptImpl: (_file, value) => {
      if (value.pending === null) throw new Error('fsync failed');
      receipt = value;
    },
    request: async (operation, fields) => {
      if (operation === 'submit') { state = ready(NEXT, terminal(fields.job_id)); return { accepted: true }; }
      return state;
    } });
  await broker.prepare();
  await assert.rejects(broker.execute({ command: 'true' }), /fsync failed/);
  assert.ok(receipt.pending);
  assert.equal(broker.status().available, false);
});
test('abort before admission creates no worker job or receipt', async (t) => {
  const broker = new ExecutionBroker({ userDataPath: fixture(t), request: async () => ready() });
  await broker.prepare();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(broker.execute({ command: 'true' }, { signal: controller.signal }), /cancelled_before_admission/);
  assert.equal(fs.existsSync(broker.filePath), false);
});
test('future and malformed durable receipts fail closed', (t) => {
  const file = path.join(fixture(t), 'sandbox-admission.json');
  for (const value of [{ schema_version: 2, pending: null }, { schema_version: 1 },
    { schema_version: 1, pending: { job_id: JOB, incarnation: OLD, command: 'hidden replay' } }]) {
    fs.writeFileSync(file, JSON.stringify(value));
    assert.throws(() => readReceipt(file), /sandbox_receipt_invalid/);
  }
});


test('cancelling during readiness drains without inventing cleanup uncertainty', async (t) => {
  let release;
  let delayStatus = false;
  const paused = new Promise((resolve) => { release = resolve; });
  const broker = new ExecutionBroker({ userDataPath: fixture(t), request: async (operation) => {
    assert.equal(operation, 'status');
    if (delayStatus) await paused;
    return ready();
  } });
  await broker.prepare();
  delayStatus = true;
  const controller = new AbortController();
  const execution = broker.execute({ command: 'true' }, { signal: controller.signal, streamId: 'pre-admission' });
  const expected = assert.rejects(execution, /cancelled_before_admission/);
  controller.abort();
  const drained = broker.drainStream('pre-admission');
  release();
  await expected;
  await drained;
  assert.equal(broker.receipt.pending, null);
  assert.equal(broker.blocked, false);
});
