'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ExecutionReceipts } = require('../services/execution/execution-receipts');
const { localEndpoint } = require('../services/execution/docker-launcher');
const { settleExecution } = require('../services/execution/execution-settlement');
test('durable admission survives restart and is never replayed', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-sandbox-receipts-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = new ExecutionReceipts(directory);
  const binding = { request_id: 'request', session_id: 'session', snapshot_digest: 'digest', job_id: 'job' };
  first.append('admitted', binding);
  const restarted = new ExecutionReceipts(directory);
  assert.equal(restarted.ownerId, first.ownerId);
  assert.equal(restarted.pending().length, 1);
  assert.equal(restarted.seen('request'), true);
  restarted.append('reconciled', binding, { status: 'interrupted', cleanup_confirmed: true });
  assert.equal(new ExecutionReceipts(directory).pending().length, 0);
});
test('torn receipts fail closed and are preserved', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-sandbox-torn-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  new ExecutionReceipts(directory);
  await fs.writeFile(path.join(directory, 'execution.jsonl'), '{"schema_version":');
  const restarted = new ExecutionReceipts(directory);
  assert.equal(restarted.invalid, true);
  assert.throws(() => restarted.append('terminal', { request_id: 'x' }), /receipt_recovery_required/u);
  assert.equal(await fs.readFile(path.join(directory, 'execution.jsonl'), 'utf8'), '{"schema_version":');
});
test('only local named pipe or Unix Docker endpoints are accepted', () => {
  assert.equal(localEndpoint('npipe:////./pipe/dockerDesktopLinuxEngine'), true);
  assert.equal(localEndpoint('unix:///var/run/docker.sock'), true);
  for (const value of ['tcp://127.0.0.1:2375','ssh://host','npipe:////server/pipe/docker','http://host',null]) {
    assert.equal(localEndpoint(value), false);
  }
});
test('uncertain cleanup changes terminal error and cannot become success', async () => {
  const service = { commandSandbox: { enabled: true, drainStream: async () => { throw new Error('unknown'); } } };
  await assert.rejects(settleExecution(service, 'stream'), /unknown/u);
  const payload = {};
  await settleExecution(service, 'stream', payload);
  assert.equal(payload.terminal_subcode, 'execution_uncertain');
  assert.equal(payload.retryable, false);
});
test('repeated corruption can recover while preserving the last two damaged journals', async t => {
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-sandbox-repeat-torn-'));
 t.after(() => fs.rm(directory, { recursive: true, force: true }));
 for (const value of ['first torn', 'second torn', 'third torn']) {
  await fs.writeFile(path.join(directory, 'execution.jsonl'), value);
  const receipts = new ExecutionReceipts(directory);
  assert.throws(() => receipts.recoverCorrupt({ cleanupConfirmed: false }), /cleanup_unconfirmed/);
  receipts.recoverCorrupt({ cleanupConfirmed: true });
  assert.equal(new ExecutionReceipts(directory).invalid, false);
 }
 assert.equal(await fs.readFile(path.join(directory, 'execution-corrupt.jsonl'), 'utf8'), 'third torn');
 assert.equal(await fs.readFile(path.join(directory, 'execution-corrupt-previous.jsonl'), 'utf8'), 'second torn');
});
