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

test('scalar, oversized and malformed metadata is preserved and rejected', (t) => {
  const filePath = fixture(t);
  const entry = { key: 'device:request', digest: 'a'.repeat(64), created_at: 0, state: 'settled', result: { ok: true } };
  for (const value of [null, false, 0, '',
    { schema_version: 1, receipts: [{ ...entry, created_at: -1 }] },
    { schema_version: 1, receipts: [{ ...entry, state: 'unknown' }] },
    { schema_version: 1, receipts: [{ ...entry, result: { ok: true, data: 'a'.repeat(4096) } }] }]) {
    const raw = JSON.stringify(value);
    fs.writeFileSync(filePath, raw);
    assert.throws(() => new CommandReceipts({ filePath }));
    assert.equal(fs.readFileSync(filePath, 'utf8'), raw);
  }
});

test('a clock stepped back re-stamps future receipts to the load time; a settled one still answers its retry', async (t) => {
  const filePath = fixture(t);
  const ttlMs = 1_000_000;
  const ahead = 10_000_000;
  let now = ahead;
  const writer = new CommandReceipts({ filePath, now: () => now, ttlMs });
  const stored = await writer.run(command, 'device', async () => ({ ok: true, session_id: 'created' }));
  const pendingCommand = { ...command, request_id: 'pending' };
  await writer.run(pendingCommand, 'device', async () => { throw new Error('interrupted'); });
  const written = fs.readFileSync(filePath, 'utf8');
  now = ahead - 3_600_000;
  const loadedAt = now;
  const logs = [];
  const receipts = new CommandReceipts({ filePath, now: () => now, ttlMs, logger: (...entry) => logs.push(entry) });
  assert.deepEqual(logs, [['WARN', 'host.receipts_future_restamped', { count: 2 }]]);
  assert.equal(fs.readFileSync(filePath, 'utf8'), written, 'nothing is written at load');
  let calls = 0;
  const execute = async () => { calls += 1; return { ok: true, session_id: 'again' }; };
  assert.deepEqual(await receipts.run(command, 'device', execute), stored);
  const retry = await receipts.run(pendingCommand, 'device', execute);
  assert.equal(retry.error.reason, 'operation_indeterminate');
  assert.equal(calls, 0);
  now = loadedAt + ttlMs - 1;
  assert.deepEqual(receipts.status('request', 'device'), { ok: true, state: 'settled', result: stored });
  now = loadedAt + ttlMs;
  assert.deepEqual(receipts.lookup(command, 'device'), { found: false }, 'gone one TTL after the load time');
  const saved = JSON.parse(fs.readFileSync(filePath, 'utf8')).receipts;
  assert.deepEqual(saved.map((entry) => [entry.key, entry.state, entry.created_at]),
    [['device:pending', 'pending', loadedAt]], 'the re-stamp is written with the next save');
  assert.equal(receipts.status('pending', 'device').state, 'indeterminate');
  const corrupt = JSON.stringify({ schema_version: 1, receipts: [{ ...saved[0], digest: 'not-hex' }] });
  fs.writeFileSync(filePath, corrupt);
  assert.throws(() => new CommandReceipts({ filePath, now: () => now }), /invalid_receipt_store/u);
  assert.equal(fs.readFileSync(filePath, 'utf8'), corrupt);
});

test('a full store drops its oldest settled receipt instead of refusing; a running or unresolved one is kept', async (t) => {
  const filePath = fixture(t);
  let now = 1_000;
  const logs = [];
  const receipts = new CommandReceipts({ filePath, now: () => now, capacity: 3, logger: (...entry) => logs.push(entry) });
  const cmd = (id) => ({ ...command, request_id: id });
  const settle = (id) => { now += 1; return receipts.run(cmd(id), 'device', async () => ({ ok: true, id })); };
  // The oldest receipt of all is one a crash left unresolved; then two settled ones fill the store.
  await receipts.run(cmd('lost'), 'device', async () => { throw new Error('interrupted'); });
  await settle('a');
  await settle('b');
  assert.deepEqual(await settle('c'), { ok: true, id: 'c' }, 'a full store still runs the command');
  assert.deepEqual(receipts.status('a', 'device'), { ok: true, state: 'unknown' }, 'the oldest settled receipt went');
  assert.equal(receipts.status('lost', 'device').state, 'indeterminate');
  assert.deepEqual(receipts.status('b', 'device'), { ok: true, state: 'settled', result: { ok: true, id: 'b' } });
  // A command that is still running is not the one dropped, whatever its age.
  let finish = null;
  now += 1;
  const slow = receipts.run(cmd('slow'), 'device', () => new Promise((resolve) => { finish = () => resolve({ ok: true, id: 'slow' }); }));
  assert.equal(receipts.status('b', 'device').state, 'unknown');
  await settle('d');
  assert.equal(receipts.status('c', 'device').state, 'unknown');
  assert.equal(receipts.status('slow', 'device').state, 'pending');
  await Promise.resolve();
  finish();
  assert.deepEqual(await slow, { ok: true, id: 'slow' });
  // What is on disk is what the store holds: three receipts, and a retry of a kept one is answered, not run again.
  const restarted = new CommandReceipts({ filePath, now: () => now, capacity: 3 });
  assert.deepEqual([...restarted.entries.keys()].sort(), ['device:d', 'device:lost', 'device:slow']);
  let again = 0;
  assert.deepEqual(await restarted.run(cmd('d'), 'device', async () => { again += 1; }), { ok: true, id: 'd' });
  assert.equal(again, 0);
  assert.deepEqual(logs.map(([level, event, detail]) => [level, event, detail]), [['WARN', 'host.receipts_full_oldest_dropped', { capacity: 3 }]], 'said once');
});

test('a store full of unresolved receipts refuses, and runs nothing', async (t) => {
  const filePath = fixture(t);
  const receipts = new CommandReceipts({ filePath, capacity: 2 });
  for (const id of ['one', 'two']) await receipts.run({ ...command, request_id: id }, 'device', async () => { throw new Error('interrupted'); });
  let called = false;
  const refused = await receipts.run({ ...command, request_id: 'three' }, 'device', async () => { called = true; return { ok: true }; });
  assert.deepEqual([refused.ok, refused.error.reason, called], [false, 'receipt_capacity', false]);
  assert.equal(receipts.entries.size, 2);
});
