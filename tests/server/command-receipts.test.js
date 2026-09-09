'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CommandReceipts } = require('../../server/command-receipts');
const command = { request_id: 'request', operation: 'sessions.create', params: { title: 'One' } };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-host-receipts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'receipts.json');
}

test('simultaneous retries join once and settled results survive restart', async (t) => {
  const filePath = fixture(t);
  const receipts = new CommandReceipts({ filePath });
  let calls = 0;
  const execute = async () => { calls++; return { ok: true, session_id: 'created' }; };
  const [a, b] = await Promise.all([receipts.run(command, 'device', execute), receipts.run(command, 'device', execute)]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  const restarted = new CommandReceipts({ filePath });
  assert.deepEqual(await restarted.run(command, 'device', execute), a);
  assert.equal(calls, 1);
  const conflict = await restarted.run({ ...command, params: { title: 'Changed' } }, 'device', execute);
  assert.equal(conflict.error.reason, 'request_payload_changed');
});

test('a crash window after admission cannot automatically replay a side effect', async (t) => {
  const filePath = fixture(t);
  const receipts = new CommandReceipts({ filePath });
  await receipts.run(command, 'device', async () => { throw new Error('interrupted'); });
  let called = false;
  const result = await new CommandReceipts({ filePath }).run(command, 'device', async () => { called = true; });
  assert.equal(called, false);
  assert.equal(result.error.reason, 'operation_indeterminate');
});

test('failed admission persistence prevents execution and latches the store unavailable', async (t) => {
  const receipts = new CommandReceipts({ filePath: fixture(t), write: () => { throw new Error('ENOSPC'); } });
  let calls = 0;
  const execute = async () => { calls++; return { ok: true }; };
  assert.equal((await receipts.run(command, 'device', execute)).error.code, 'CMP-HOST-0006');
  await receipts.run({ ...command, request_id: 'another' }, 'device', execute);
  assert.equal(calls, 0);
});

test('future metadata is rejected without overwriting it', (t) => {
  const filePath = fixture(t);
  const original = '{"schema_version":2,"receipts":[]}';
  fs.writeFileSync(filePath, original);
  assert.throws(() => new CommandReceipts({ filePath }));
  assert.equal(fs.readFileSync(filePath, 'utf8'), original);
});

test('expired unresolved receipts survive unrelated traffic and cannot be repeated', async (t) => {
  let now = 0;
  const receipts = new CommandReceipts({ filePath: fixture(t), now: () => now, ttlMs: 100 });
  await receipts.run(command, 'device', async () => { throw new Error('crashed'); });
  now = 101;
  await receipts.run({ ...command, request_id: 'other' }, 'device', async () => ({ ok: true }));
  let ran = false;
  const result = await receipts.run(command, 'device', async () => { ran = true; return { ok: true }; });
  assert.equal(ran, false);
  assert.equal(result.error.reason, 'operation_indeterminate');
});

test('settled receipts expire on lookup and allow the request identity to execute again', async (t) => {
  let now = 0;
  const receipts = new CommandReceipts({ filePath: fixture(t), now: () => now, ttlMs: 100 });
  let calls = 0;
  const execute = async () => ({ ok: true, call: ++calls });
  assert.deepEqual(await receipts.run(command, 'device', execute), { ok: true, call: 1 });
  now = 101;
  assert.deepEqual(receipts.lookup(command, 'device'), { found: false });
  assert.deepEqual(await receipts.run(command, 'device', execute), { ok: true, call: 2 });
});

test('scalar, oversized and future-dated metadata is preserved and rejected', (t) => {
  const filePath = fixture(t);
  const entry = { key: 'device:request', digest: 'a'.repeat(64), created_at: 0, state: 'settled', result: { ok: true } };
  for (const value of [null, false, 0, '',
    { schema_version: 1, receipts: [{ ...entry, created_at: Number.MAX_SAFE_INTEGER }] },
    { schema_version: 1, receipts: [{ ...entry, result: { ok: true, data: 'a'.repeat(4096) } }] }]) {
    const raw = JSON.stringify(value);
    fs.writeFileSync(filePath, raw);
    assert.throws(() => new CommandReceipts({ filePath }));
    assert.equal(fs.readFileSync(filePath, 'utf8'), raw);
  }
});
