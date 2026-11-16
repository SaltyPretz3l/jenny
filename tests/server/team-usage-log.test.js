'use strict';

// Slice 4b host core: the team engine usage log (node protocol spec "Team engine
// (N10)"). One row per engine request that held a lease: ids, a model id, counts,
// a duration and a closed outcome. No text of any kind.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  USAGE_LOG_FILE, USAGE_LOG_LIMITS, USAGE_LOG_SCHEMA_VERSION, UsageLog,
} = require('../../server/team/usage-log');
const { createClock, createLoggerSpy } = require('./helpers/team-pool-fixture');

const ROW_KEYS = ['seq', 'at', 'member_id', 'model', 'node_id', 'prompt_tokens', 'completion_tokens',
  'duration_ms', 'outcome', 'reason'];

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, USAGE_LOG_FILE);
}

function row(overrides = {}) {
  return { member_id: 'member_a', model: 'alpha', node_id: 'node_AAAAAAAAAAAAAAAAAAAAAA', prompt_tokens: 11,
    completion_tokens: 7, duration_ms: 1200, outcome: 'completed', reason: null, ...overrides };
}

function storedRow(seq, overrides = {}) {
  return { seq, at: 1_800_000_000_000 + seq, ...row(), ...overrides };
}

test('the limits and the file name are the spec values', () => {
  assert.equal(USAGE_LOG_FILE, 'team-pool-usage.json');
  assert.equal(USAGE_LOG_SCHEMA_VERSION, 1);
  assert.equal(USAGE_LOG_LIMITS.MAX_ENTRIES, 10_000);
  assert.equal(USAGE_LOG_LIMITS.MAX_BYTES, 4 * 1024 * 1024);
});

test('an append is durable, has the closed row shape and survives a reload', (t) => {
  const filePath = tempFile(t);
  const clock = createClock();
  const log = new UsageLog({ filePath, clock });
  assert.deepEqual(log.status(), { ok: true });
  assert.deepEqual(log.append(row()), { ok: true, seq: 1 });
  assert.deepEqual(log.append(row({ prompt_tokens: null, completion_tokens: null, node_id: null,
    outcome: 'cancelled', reason: 'cancelled' })), { ok: true, seq: 2 });
  const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(stored.schema_version, 1);
  assert.equal(stored.entries.length, 2);
  for (const entry of stored.entries) assert.deepEqual(Object.keys(entry).sort(), [...ROW_KEYS].sort());
  assert.equal(stored.entries[0].at, clock());
  const reloaded = new UsageLog({ filePath, clock });
  assert.deepEqual(reloaded.status(), { ok: true });
  assert.deepEqual(reloaded.append(row()), { ok: true, seq: 3 });
});

test('10,001 rows keep the newest 10,000 and move the floor', () => {
  const entries = Array.from({ length: 10_000 }, (_, i) => storedRow(i + 1));
  let written = null;
  const log = new UsageLog({
    filePath: 'memory://usage', clock: createClock(),
    readJson: () => ({ schema_version: 1, floor_seq: 1, next_seq: 10_001, entries }),
    writeJson: (_file, doc) => { written = doc; },
  });
  assert.deepEqual(log.append(row()), { ok: true, seq: 10_001 });
  assert.equal(written.entries.length, 10_000);
  assert.equal(written.floor_seq, 2);
  assert.equal(written.entries[0].seq, 2);
  assert.equal(written.entries.at(-1).seq, 10_001);
});

test('a document over the read cap is refused with pool_usage_store_failed and never rewritten', (t) => {
  const filePath = tempFile(t);
  const padding = 'x'.repeat(USAGE_LOG_LIMITS.MAX_BYTES);
  fs.writeFileSync(filePath, JSON.stringify({ schema_version: 1, floor_seq: 1, next_seq: 1, entries: [], padding }));
  const before = fs.readFileSync(filePath);
  const logger = createLoggerSpy();
  const log = new UsageLog({ filePath, clock: createClock(), logger });
  const status = log.status();
  assert.equal(status.ok, false);
  assert.equal(status.error.reason, 'pool_usage_store_failed');
  assert.equal(status.error.code, 'CMP-HOST-0006');
  assert.equal(log.append(row()).error.reason, 'pool_usage_store_failed');
  assert.deepEqual(fs.readFileSync(filePath), before);
  assert.equal(logger.text().includes('padding'), false);
});

test('a newer schema version is refused with pool_schema_unsupported', (t) => {
  const filePath = tempFile(t);
  fs.writeFileSync(filePath, JSON.stringify({ schema_version: 2, floor_seq: 1, next_seq: 1, entries: [] }));
  const logger = createLoggerSpy();
  const log = new UsageLog({ filePath, clock: createClock(), logger });
  const status = log.status();
  assert.equal(status.ok, false);
  assert.equal(status.error.reason, 'pool_schema_unsupported');
  assert.equal(status.error.code, 'CMP-HOST-0006');
  assert.ok(logger.calls.some(([, event, fields]) => event === 'team_pool_usage.rejected' && fields?.cause === 'newer_schema'),
    'the rejected line says the file is from a newer schema');
});

test('a stored row with an extra key, or with text where a count belongs, is refused on load', (t) => {
  for (const bad of [
    storedRow(1, { note: 'hello' }),
    storedRow(1, { prompt_tokens: 'eleven' }),
    storedRow(1, { outcome: 'finished' }),
    storedRow(1, { reason: 'Not A Code' }),
    storedRow(1, { member_id: 'someone' }),
    storedRow(1, { node_id: 'a node with spaces' }),
  ]) {
    const filePath = tempFile(t);
    fs.writeFileSync(filePath, JSON.stringify({ schema_version: 1, floor_seq: 1, next_seq: 2, entries: [bad] }));
    const status = new UsageLog({ filePath, clock: createClock() }).status();
    assert.equal(status.ok, false, JSON.stringify(bad));
    assert.equal(status.error.reason, 'pool_usage_store_failed');
  }
});

test('R16-F03: rows a node inflated (stored before the bound) still load; the read stays bounded and readable', (t) => {
  const filePath = tempFile(t);
  const clock = createClock(1_800_000_000_100);
  const BIG = 999_999_999_999_999;
  // Five forged rows for member_a, and 70 other members with one honest row each.
  const entries = Array.from({ length: 5 }, (_, i) => storedRow(i + 1, { prompt_tokens: BIG, completion_tokens: BIG }))
    .concat(Array.from({ length: 70 }, (_, i) => storedRow(i + 6, { member_id: `member_m${i}` })));
  fs.writeFileSync(filePath, JSON.stringify({ schema_version: 1, floor_seq: 1, next_seq: 76, entries }));
  const log = new UsageLog({ filePath, clock });
  assert.deepEqual(log.status(), { ok: true }, 'a stored file is never refused for its counts');
  const page = log.read({ limit: 50 });
  assert.equal(page.ok, true);
  assert.ok(page.totals.length <= 64, `at most 64 totals, got ${page.totals.length}`);
  assert.ok(page.totals.every((total) => Number.isSafeInteger(total.tokens)), 'every total is a safe integer');
  const forged = page.totals.find((total) => total.member_id === 'member_a');
  assert.deepEqual([forged.requests, forged.tokens], [5, 0], 'a count past the row bound reads as no count');
  assert.ok(page.rows.every((entry) => entry.tokens === null || entry.tokens <= USAGE_LOG_LIMITS.MAX_ROW_TOKENS));
  assert.deepEqual(log.append(row({ prompt_tokens: BIG, completion_tokens: 3 })), { ok: true, seq: 76 });
  const stored = JSON.parse(fs.readFileSync(filePath, 'utf8')).entries.at(-1);
  assert.deepEqual([stored.prompt_tokens, stored.completion_tokens], [null, 3], 'a new count past the bound is stored as null');
});

test('an input row outside the closed shape throws and writes nothing', (t) => {
  const filePath = tempFile(t);
  const log = new UsageLog({ filePath, clock: createClock() });
  for (const bad of [
    { ...row(), prompt: 'hi' },
    row({ model: 'x'.repeat(129) }),
    row({ model: 'line\nbreak' }),
    row({ outcome: 'completed', reason: 'cancelled' }),
    row({ outcome: 'failed', reason: null }),
    row({ duration_ms: -1 }),
    row({ completion_tokens: 1.5 }),
  ]) assert.throws(() => log.append(bad), TypeError, JSON.stringify(bad));
  assert.equal(fs.existsSync(filePath), false);
});

test('a read refused once by a busy file answers pool_usage_store_failed, and the next status is ok', (t) => {
  const filePath = tempFile(t);
  new UsageLog({ filePath, clock: createClock() }).append(row());
  let busy = true;
  const logger = createLoggerSpy();
  const log = new UsageLog({
    filePath, clock: createClock(), logger,
    readJson(file, options) {
      if (busy) { busy = false; throw Object.assign(new Error('busy'), { code: 'EBUSY', syscall: 'open' }); }
      return require('../../services/host/durable-json').readJson(file, options);
    },
  });
  assert.equal(log.status().error.reason, 'pool_usage_store_failed');
  assert.deepEqual(log.status(), { ok: true }, 'a passing failure does not disable the log');
  assert.deepEqual(log.append(row()), { ok: true, seq: 2 });
  assert.equal(logger.text().includes('team_pool_usage.rejected'), false);
});

test('a write that landed before it threw never leads to a reused seq', (t) => {
  const filePath = tempFile(t);
  let throwAfterWrite = false;
  const log = new UsageLog({
    filePath, clock: createClock(),
    writeJson(file, doc) {
      require('../../services/host/durable-json').writeJson(file, doc);
      if (throwAfterWrite) { throwAfterWrite = false; throw Object.assign(new Error('fsync'), { code: 'EIO' }); }
    },
  });
  assert.deepEqual(log.append(row()), { ok: true, seq: 1 });
  throwAfterWrite = true;
  assert.equal(log.append(row()).error.reason, 'pool_usage_store_failed');
  assert.deepEqual(log.append(row()), { ok: true, seq: 3 });
  const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(stored.entries.map((entry) => entry.seq), [1, 2, 3]);
});

test('a degraded log tries to heal at most once a second by its clock, with no file IO in between', (t) => {
  const filePath = tempFile(t);
  const clock = createClock();
  const durable = require('../../services/host/durable-json');
  let fail = true;
  let reads = 0;
  const log = new UsageLog({
    filePath, clock,
    readJson(file, options) { reads += 1; return durable.readJson(file, options); },
    writeJson(file, doc) { if (fail) throw Object.assign(new Error('disk'), { code: 'EIO' }); durable.writeJson(file, doc); },
  });
  assert.equal(log.append(row()).error.reason, 'pool_usage_store_failed');
  reads = 0;
  for (let index = 0; index < 20; index += 1) {
    assert.equal(log.status().error.reason, 'pool_usage_store_failed');
    clock.advance(40);
  }
  assert.equal(reads, 1, 'twenty calls inside one second read the file once');
  fail = false;
  clock.advance(200);
  assert.deepEqual(log.status(), { ok: true }, 'after the second it reads again and heals');
  assert.equal(reads, 2);
  // A clock that gives no time tries on every call, as before.
  fail = true;
  assert.equal(log.append(row()).error.reason, 'pool_usage_store_failed');
  clock.set(undefined);
  reads = 0;
  for (let index = 0; index < 3; index += 1) log.status();
  assert.equal(reads, 3);
});

test('a degraded log whose clock stepped back tries again at once instead of waiting out the step', (t) => {
  const filePath = tempFile(t);
  const clock = createClock();
  const durable = require('../../services/host/durable-json');
  let fail = true;
  let reads = 0;
  const log = new UsageLog({
    filePath, clock,
    readJson(file, options) { reads += 1; return durable.readJson(file, options); },
    writeJson(file, doc) { if (fail) throw Object.assign(new Error('disk'), { code: 'EIO' }); durable.writeJson(file, doc); },
  });
  assert.equal(log.append(row()).error.reason, 'pool_usage_store_failed');
  reads = 0;
  assert.equal(log.status().error.reason, 'pool_usage_store_failed', 'one failed heal');
  assert.equal(reads, 1);
  fail = false;
  clock.set(clock() - 3_600_000);
  assert.deepEqual(log.status(), { ok: true }, 'the next status reads again and heals');
  assert.equal(reads, 2);
});

test('a failed write answers pool_usage_store_failed, degrades the log and the next append lands', () => {
  let fail = true;
  const writes = [];
  const logger = createLoggerSpy();
  const clock = createClock();
  const log = new UsageLog({
    filePath: 'memory://usage', clock, logger,
    readJson: () => null,
    writeJson: (_file, doc) => { if (fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); writes.push(doc); },
  });
  const failed = log.append(row());
  assert.equal(failed.ok, false);
  assert.equal(failed.error.reason, 'pool_usage_store_failed');
  assert.match(logger.text(), /team_pool_usage\.write_failed/u);
  assert.equal(logger.text().includes('disk full'), false);
  const degraded = log.status();
  assert.equal(degraded.ok, false, 'a failed write degrades the log');
  assert.equal(degraded.error.reason, 'pool_usage_store_failed');
  fail = false;
  clock.advance(1000);
  assert.deepEqual(log.status(), { ok: true }, 'status re-reads, re-writes and heals');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].entries.length, 0, 'the failed row stays lost');
  assert.deepEqual(log.append(row()), { ok: true, seq: 1 });
  assert.equal(writes[1].entries.length, 1);
});

test('3-4b: openAtStart sets a file refused for its content aside with the shared stamp; a newer schema stays', (t) => {
  const { utcStamp } = require('../../server/team/bounded-log');
  const file = tempFile(t);
  fs.writeFileSync(file, '{ not json');
  const clock = () => Date.UTC(2026, 10, 12, 9, 30);
  const log = new UsageLog({ filePath: file, clock });
  assert.equal(log.status().ok, false);
  const opened = log.openAtStart();
  assert.deepEqual(opened, { setAside: true, keptName: `${path.basename(file)}.unreadable-${utcStamp(clock())}` });
  assert.equal(fs.existsSync(path.join(path.dirname(file), opened.keptName)), true);
  assert.equal(log.status().ok, true);
  assert.equal(log.append(row()).ok, true);
  const newer = tempFile(t);
  fs.writeFileSync(newer, JSON.stringify({ schema_version: 99, floor_seq: 1, next_seq: 1, entries: [] }));
  const kept = new UsageLog({ filePath: newer, clock });
  assert.deepEqual(kept.openAtStart(), { setAside: false, keptName: null });
  assert.equal(kept.status().error.reason, 'pool_schema_unsupported');
  assert.equal(fs.readdirSync(path.dirname(newer)).length, 1, 'a newer file is never moved');
});
