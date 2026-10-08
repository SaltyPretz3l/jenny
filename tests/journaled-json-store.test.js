'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { JournaledJsonStore } = require('../services/backend/journaled-json-store');
const { encodeHeader, encodeRecord, replayJournal } = require('../services/backend/session-journal');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');

const SESSION_ID = 's1';
const TINY = { maxJournalBytes: 300, maxJournalBaseRatio: 0 };

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function message(index) {
  return { id: `m${index}`, role: 'user', text: `message number ${index} ${'x'.repeat(30)}` };
}

function state(count, extra = {}) {
  return {
    schema_version: 1,
    session: {
      id: SESSION_ID,
      title: 'chat',
      messages: Array.from({ length: count }, (_, index) => message(index)),
      turn_events: [],
      ...extra,
    },
  };
}

function makeDir() {
  return createTrackedTempDir('jenny-jjs-');
}

// idleCompactMs is off by default so tests only see the writes they make.
function open(dir, options = {}) {
  return new JournaledJsonStore(path.join(dir, `${SESSION_ID}.json`), {
    payloadKey: 'session',
    journalId: SESSION_ID,
    compact: true,
    idleCompactMs: 0,
    ...options,
  });
}

function basePath(dir) {
  return path.join(dir, `${SESSION_ID}.json`);
}

function journalPath(dir, epoch) {
  return path.join(dir, `${SESSION_ID}.${epoch}.journal`);
}

function journalFiles(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.journal')).sort();
}

function rawBase(dir) {
  return JSON.parse(fs.readFileSync(basePath(dir), 'utf8'));
}

function withoutEpoch(raw) {
  const { journal_epoch: epoch, ...rest } = raw;
  void epoch;
  return rest;
}

function logRecorder() {
  const logs = [];
  return { logs, logger: (level, event, details) => logs.push({ level, event, details }) };
}

function createRng(seed) {
  let current = seed >>> 0;
  return (limit) => {
    current = (current + 0x6d2b79f5) >>> 0;
    let t = current;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * limit);
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition not reached in time');
}

test('constructor requires a payloadKey and defaults journalId to the file stem', () => {
  const dir = makeDir();
  assert.throws(() => new JournaledJsonStore(basePath(dir), {}), TypeError);
  assert.throws(() => new JournaledJsonStore(basePath(dir), { payloadKey: 'session', journalId: 4 }), TypeError);
  const store = new JournaledJsonStore(basePath(dir), { payloadKey: 'session', compact: true });
  store.writeImmediate(state(2));
  store.writeImmediate(state(3));
  assert.match(fs.readFileSync(journalPath(dir, 1), 'latin1'), /"session_id":"s1"/);
  const reader = open(dir, { journalId: 'other', ...logRecorder() });
  const result = reader.readWithStatus();
  assert.deepEqual(result.value, state(2));
  assert.equal(result.journalStatus, 'none');
  assert.deepEqual(open(dir).read(), state(3));
});

test('conformance: debounced write keeps generations and serves read-your-writes', async () => {
  const dir = makeDir();
  const store = open(dir, { writeDebounceMs: 30 });
  assert.deepEqual(store.write(state(1)), { generation: 1, durable: false });
  assert.deepEqual(store.getWriteState(), {
    acceptedGeneration: 1, durableGeneration: 0, failedGeneration: 0, pending: true,
  });
  assert.equal(store.hasPendingWrite(), true);
  assert.deepEqual(store.read(), state(1));
  assert.equal(fs.existsSync(basePath(dir)), false);
  assert.equal(await store.flushAsync(), true);
  assert.deepEqual(store.getWriteState(), {
    acceptedGeneration: 1, durableGeneration: 1, failedGeneration: 0, pending: false,
  });
  assert.deepEqual(store.writeImmediate(state(2)), { generation: 2, durable: true });
  assert.equal(store.getWriteState().durableGeneration, 2);

  store.write(state(3));
  assert.equal(store.replacePendingValue(state(4)), true);
  assert.deepEqual(store.read(), state(4));
  assert.equal(store.flush(), true);
  assert.equal(store.replacePendingValue(state(5)), false);
  assert.equal(store.hasPendingWrite(), false);
  assert.deepEqual(open(dir).read(), state(4));

  store.dispose();
  assert.throws(() => store.write(state(5)), { code: 'store_disposed' });
  assert.throws(() => store.writeImmediate(state(5)), { code: 'store_disposed' });
});

test('conformance: delete removes the base and every journal, and a later write starts over', () => {
  const dir = makeDir();
  const store = open(dir);
  store.writeImmediate(state(1));
  store.writeImmediate(state(2));
  assert.equal(journalFiles(dir).length, 1);
  store.delete();
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(store.getWriteState().durableGeneration, store.getWriteState().acceptedGeneration);
  const missing = store.readWithStatus('fallback');
  assert.equal(missing.missing, true);
  assert.equal(missing.value, 'fallback');
  store.writeImmediate(state(3));
  assert.deepEqual(open(dir).read(), state(3));
});

test('base missing or corrupt keeps the inherited result and ignores journals', () => {
  const dir = makeDir();
  assert.equal(open(dir).readWithStatus('d').missing, true);
  fs.writeFileSync(basePath(dir), '{not json', 'utf8');
  const result = open(dir, { logger: () => {} }).readWithStatus('d');
  assert.equal(result.corrupted, true);
  assert.equal(result.value, 'd');
});

test('read-after-write equivalence over a random write sequence', async () => {
  const dir = makeDir();
  const rng = createRng(1234);
  const store = open(dir, { writeDebounceMs: 5, maxJournalBytes: 500, maxJournalBaseRatio: 0.1 });
  let count = 3;
  let last = state(count);
  for (let step = 0; step < 80; step += 1) {
    const change = rng(5);
    if (change === 0) count += 1 + rng(3);
    else if (change === 1 && count > 1) count -= 1;
    last = state(count, { title: `title ${rng(4)}` });
    if (change === 4 && rng(2) === 0) last.schema_version = 1 + rng(3);
    const mode = rng(4);
    if (mode === 0) store.writeImmediate(last);
    else if (mode === 1) { store.write(last); store.flush(); }
    else if (mode === 2) { store.write(last); await store.flushAsync(); }
    else store.write(last);
    assert.deepEqual(store.read(), last);
  }
  await store.flushAsync();
  assert.deepEqual(open(dir).read(), last);
});

test('a fresh instance first write replaces the base and never appends to an old journal', () => {
  const dir = makeDir();
  const first = open(dir);
  first.writeImmediate(state(1));
  first.writeImmediate(state(2));
  first.writeImmediate(state(3));
  assert.equal(rawBase(dir).journal_epoch, 1);
  const sizeBefore = fs.statSync(journalPath(dir, 1)).size;

  const second = open(dir);
  second.writeImmediate(state(4));
  assert.equal(rawBase(dir).journal_epoch, 2);
  assert.equal(fs.statSync(journalPath(dir, 1)).size, sizeBefore);
  assert.equal(fs.existsSync(journalPath(dir, 2)), false);
  second.writeImmediate(state(5));
  assert.equal(fs.existsSync(journalPath(dir, 2)), true);
  assert.deepEqual(open(dir).read(), state(5));
});

test('dispose leaves a complete base and read values never carry journal_epoch', () => {
  const dir = makeDir();
  const store = open(dir);
  store.writeImmediate(state(1));
  store.writeImmediate(state(2));
  store.writeImmediate(state(3));
  assert.equal('journal_epoch' in store.read(), false);
  store.dispose();
  const raw = rawBase(dir);
  assert.ok(raw.journal_epoch >= 2);
  assert.deepEqual(withoutEpoch(raw), state(3));
  assert.equal('journal_epoch' in open(dir).read(), false);
});

test('a journal_epoch key in a written value is ignored', () => {
  const dir = makeDir();
  const store = open(dir);
  store.writeImmediate({ journal_epoch: 99, ...state(1) });
  assert.equal(rawBase(dir).journal_epoch, 1);
  assert.equal(Object.keys(rawBase(dir))[0], 'journal_epoch');
  assert.deepEqual(open(dir).read(), state(1));
});

test('epoch monotonicity: stale higher journals are superseded and never replayed', () => {
  const dir = makeDir();
  const first = open(dir);
  first.writeImmediate(state(1));
  // Well-formed journals that claim to continue: only their epoch keeps them out.
  for (const epoch of [7, 8]) {
    fs.writeFileSync(journalPath(dir, epoch), Buffer.concat([
      encodeHeader({ sessionId: SESSION_ID, epoch, continues: true }),
      encodeRecord([{ o: 'set', k: 'title', v: `stale ${epoch}` }]),
    ]));
  }
  assert.deepEqual(open(dir).read(), state(1));
  const second = open(dir);
  second.writeImmediate(state(2));
  assert.equal(rawBase(dir).journal_epoch, 9);
  assert.deepEqual(journalFiles(dir), ['s1.8.journal']);
  assert.deepEqual(open(dir).read(), state(2));
});

function buildLossState({ continuing }) {
  const dir = makeDir();
  const writer = open(dir, TINY);
  writer.writeImmediate(state(20));
  writer.writeImmediate(state(21));
  const oldBase = fs.readFileSync(basePath(dir));
  const finalState = state(24, { title: 'renamed' });
  const second = continuing ? writer : open(dir, TINY);
  second.writeImmediate(state(24));
  second.writeImmediate(finalState);
  assert.equal(rawBase(dir).journal_epoch, 2);
  fs.writeFileSync(basePath(dir), oldBase);
  return { dir, finalState };
}

test('loss of the newer base: a continuing journal is replayed over base + previous journal', () => {
  const { dir, finalState } = buildLossState({ continuing: true });
  assert.match(fs.readFileSync(journalPath(dir, 2), 'latin1'), /"continues":true/);
  const result = open(dir).readWithStatus();
  assert.deepEqual(result.value, finalState);
  assert.equal(result.journalStatus, 'ok');
});

test('loss of the newer base: a non-continuing journal is ignored', () => {
  const { dir } = buildLossState({ continuing: false });
  assert.doesNotMatch(fs.readFileSync(journalPath(dir, 2), 'latin1'), /"continues"/);
  const { logs, logger } = logRecorder();
  const result = open(dir, { logger }).readWithStatus();
  assert.deepEqual(result.value, state(21));
  const ignored = logs.find((entry) => entry.event === 'store.journal_ignored');
  assert.equal(ignored.level, 'WARN');
  assert.equal(ignored.details.reason, 'not_continuation');
  assert.equal(ignored.details.epoch, 2);
});

test('torn tail: the read stops before the damaged record and the next write recovers', () => {
  const dir = makeDir();
  const store = open(dir);
  [state(1), state(2), state(3), state(4)].forEach((value) => store.writeImmediate(value));
  const target = journalPath(dir, 1);
  fs.truncateSync(target, fs.statSync(target).size - 5);
  const result = open(dir).readWithStatus();
  assert.deepEqual(result.value, state(3));
  assert.equal(result.journalStatus, 'torn_tail');
  const recovering = open(dir);
  recovering.writeImmediate(state(5));
  assert.deepEqual(open(dir).read(), state(5));
});

test('interior corruption: the read keeps the valid prefix and logs store.journal_corrupt', () => {
  const dir = makeDir();
  const store = open(dir);
  const states = [state(1), state(2), state(3), state(4), state(5)];
  states.forEach((value) => store.writeImmediate(value));
  const target = journalPath(dir, 1);
  const bytes = fs.readFileSync(target);
  bytes[Math.floor(bytes.length / 2)] ^= 0x01;
  fs.writeFileSync(target, bytes);
  const { logs, logger } = logRecorder();
  const result = open(dir, { logger }).readWithStatus();
  assert.equal(result.journalStatus, 'corrupt');
  const intact = replayJournal(state(1).session, bytes, { sessionId: SESSION_ID, epoch: 1 }).records;
  assert.ok(intact >= 1 && intact <= 3, 'the flipped byte is in a middle record');
  assert.deepEqual(result.value, states[intact]);
  const entry = logs.find((item) => item.event === 'store.journal_corrupt');
  assert.equal(entry.level, 'ERROR');
  assert.equal(entry.details.epoch, 1);
  assert.equal(entry.details.status, 'corrupt');
  assert.equal(entry.details.filePath, basePath(dir));
});

test('threshold: an over-limit append replaces the base and prunes older journals', () => {
  const dir = makeDir();
  const store = open(dir, TINY);
  for (let count = 10; count < 30; count += 1) store.writeImmediate(state(count));
  const epoch = rawBase(dir).journal_epoch;
  assert.ok(epoch >= 4, `expected several replacements, got epoch ${epoch}`);
  const epochs = journalFiles(dir).map((name) => Number(name.split('.')[1]));
  assert.ok(epochs.every((value) => value >= epoch - 1), `stale journals left: ${epochs}`);
  assert.deepEqual(open(dir).read(), state(29));
});

test('a changed schema_version or non-payload key forces a base replacement', () => {
  const dir = makeDir();
  const store = open(dir);
  store.writeImmediate(state(1));
  store.writeImmediate(state(2));
  assert.equal(rawBase(dir).journal_epoch, 1);
  const bumped = state(3);
  bumped.schema_version = 2;
  store.writeImmediate(bumped);
  assert.equal(rawBase(dir).journal_epoch, 2);
  assert.equal(rawBase(dir).schema_version, 2);
  assert.deepEqual(open(dir).read(), bumped);
});

test('a non-object payload is replaced as a whole and appends resume afterwards', () => {
  const dir = makeDir();
  const store = open(dir);
  store.writeImmediate({ schema_version: 1, session: 'not an object' });
  store.writeImmediate(state(1));
  assert.equal(journalFiles(dir).length, 0);
  store.writeImmediate(state(2));
  assert.equal(journalFiles(dir).length, 1);
  assert.deepEqual(open(dir).read(), state(2));
});

test('an unchanged value appends nothing', () => {
  const dir = makeDir();
  const measured = [];
  const store = open(dir, { onWriteMeasured: (entry) => measured.push(entry) });
  store.writeImmediate(state(1));
  store.writeImmediate(state(2));
  const size = fs.statSync(journalPath(dir, 1)).size;
  store.writeImmediate(state(2));
  assert.equal(fs.statSync(journalPath(dir, 1)).size, size);
  assert.equal(measured.length, 2);
});

test('a failed append marks the journal unusable and the next write replaces the base', (t) => {
  const dir = makeDir();
  const store = open(dir);
  store.writeImmediate(state(1));
  store.writeImmediate(state(2));
  const original = fs.writeSync;
  let armed = true;
  t.mock.method(fs, 'writeSync', (...args) => {
    if (!armed) return original(...args);
    armed = false;
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  });
  assert.throws(() => store.writeImmediate(state(3)), { code: 'ENOSPC' });
  assert.equal(store.getWriteState().failedGeneration, store.getWriteState().acceptedGeneration);
  store.writeImmediate(state(4));
  assert.equal(store.getWriteState().failedGeneration, 0);
  assert.equal(rawBase(dir).journal_epoch, 2);
  assert.deepEqual(open(dir).read(), state(4));
});

test('ordering: a synchronous write during a background fsync wins and generations settle', async (t) => {
  const dir = makeDir();
  const store = open(dir, { writeDebounceMs: 1 });
  store.writeImmediate(state(1));
  store.writeImmediate(state(2));
  const original = fs.fsync;
  const started = deferred();
  const gate = deferred();
  t.mock.method(fs, 'fsync', (fd, callback) => {
    started.resolve();
    gate.promise.then(() => original.call(fs, fd, callback));
  });
  store.write(state(3));
  await started.promise;
  const accepted = store.writeImmediate(state(4)).generation;
  gate.resolve();
  await store.flushAsync();
  assert.deepEqual(open(dir).read(), state(4));
  const writeState = store.getWriteState();
  assert.equal(writeState.durableGeneration, accepted);
  assert.equal(writeState.acceptedGeneration, accepted);
  assert.equal(writeState.pending, false);
});

test('appendEnabled false never creates a journal but still reads an existing one', () => {
  const dir = makeDir();
  const writer = open(dir);
  writer.writeImmediate(state(1));
  writer.writeImmediate(state(2));
  writer.writeImmediate(state(3));
  const plain = open(dir, { appendEnabled: false });
  assert.deepEqual(plain.read(), state(3));
  const before = journalFiles(dir);
  plain.writeImmediate(state(4));
  plain.writeImmediate(state(5));
  assert.deepEqual(before, ['s1.1.journal']);
  assert.deepEqual(journalFiles(dir), []);
  assert.equal(rawBase(dir).journal_epoch, 3);
  assert.deepEqual(open(dir).read(), state(5));
  const fresh = makeDir();
  const never = open(fresh, { appendEnabled: false });
  for (let count = 1; count < 5; count += 1) never.writeImmediate(state(count));
  assert.deepEqual(journalFiles(fresh), []);
});

test('no file descriptor stays open between appends', async () => {
  const dir = makeDir();
  const store = open(dir, { writeDebounceMs: 1 });
  store.writeImmediate(state(1));
  for (let count = 2; count < 6; count += 1) store.writeImmediate(state(count));
  store.write(state(6));
  await store.flushAsync();
  assert.equal(journalFiles(dir).length, 1);
  const moved = `${dir}-moved`;
  fs.renameSync(dir, moved);
  fs.renameSync(moved, dir);
  assert.deepEqual(open(dir).read(), state(6));
});

test('idle compaction completes the base without dispose and does not hold the process', async () => {
  const dir = makeDir();
  const store = open(dir, { idleCompactMs: 40 });
  store.writeImmediate(state(1));
  store.writeImmediate(state(2));
  store.writeImmediate(state(3));
  assert.equal(rawBase(dir).journal_epoch, 1);
  assert.equal(store._idleTimer.hasRef(), false);
  await waitFor(() => rawBase(dir).journal_epoch === 2);
  assert.deepEqual(withoutEpoch(rawBase(dir)), state(3));
  assert.equal(store._idleTimer, null);
  store.writeImmediate(state(4));
  assert.deepEqual(open(dir).read(), state(4));
  store.dispose();
  assert.equal(store._idleTimer, null);
});

test('onWriteMeasured reports small appends and large base replacements', async () => {
  const dir = makeDir();
  const measured = [];
  const store = open(dir, { writeDebounceMs: 1, onWriteMeasured: (entry) => measured.push(entry) });
  store.writeImmediate(state(30));
  store.writeImmediate(state(31));
  store.write(state(32));
  await store.flushAsync();
  assert.equal(measured.length, 3);
  const [replacement, syncAppend, asyncAppend] = measured;
  assert.ok(replacement.bytes > 2000 && replacement.sync === true);
  assert.ok(syncAppend.bytes < 400 && syncAppend.sync === true);
  assert.ok(asyncAppend.bytes < 400 && asyncAppend.sync === false);
  assert.ok(Number.isFinite(asyncAppend.serializeMs) && Number.isFinite(asyncAppend.ms));
});

test('journalStatus is none when no journal was replayed', () => {
  const dir = makeDir();
  const store = open(dir);
  store.writeImmediate(state(1));
  assert.equal(open(dir).readWithStatus().journalStatus, 'none');
  store.writeImmediate(state(2));
  assert.equal(open(dir).readWithStatus().journalStatus, 'ok');
});

test('JournaledJsonStore.readFile reads base plus journals without an instance', () => {
  const dir = makeDir();
  const store = open(dir);
  store.writeImmediate(state(1));
  store.writeImmediate(state(2));
  const options = { payloadKey: 'session', journalId: SESSION_ID };
  const direct = JournaledJsonStore.readFile(basePath(dir), options);
  assert.deepEqual(direct, open(dir).readWithStatus());
  assert.deepEqual(direct.value, state(2));
  assert.deepEqual(JournaledJsonStore.readFile(basePath(dir), { payloadKey: 'session' }).value, state(2));
  const missing = JournaledJsonStore.readFile(path.join(dir, 'nope.json'), { ...options, defaultValue: 7 });
  assert.equal(missing.missing, true);
  assert.equal(missing.value, 7);
  assert.throws(() => JournaledJsonStore.readFile(basePath(dir), {}), TypeError);
});

test('JournaledJsonStore.deleteJournals removes only that stem and ignores a missing directory', () => {
  const dir = makeDir();
  const store = open(dir);
  store.writeImmediate(state(1));
  store.writeImmediate(state(2));
  fs.writeFileSync(path.join(dir, 'other.1.journal'), 'x', 'utf8');
  fs.writeFileSync(path.join(dir, 's1.json.bak'), 'x', 'utf8');
  JournaledJsonStore.deleteJournals(basePath(dir));
  assert.deepEqual(journalFiles(dir), ['other.1.journal']);
  assert.equal(fs.existsSync(basePath(dir)), true);
  JournaledJsonStore.deleteJournals(path.join(dir, 'missing-dir', 's1.json'));
});

test('compact() replaces the base once and later writes still append', () => {
  const dir = makeDir();
  const store = open(dir);
  assert.equal(store.compact(), false);
  store.writeImmediate(state(1));
  assert.equal(store.compact(), false);
  store.writeImmediate(state(2));
  store.writeImmediate(state(3));
  const accepted = store.getWriteState();
  assert.equal(store.compact(), true);
  assert.deepEqual(store.getWriteState(), accepted);
  assert.deepEqual(rawBase(dir), { journal_epoch: 2, ...state(3) });
  assert.equal(store.compact(), false);
  store.writeImmediate(state(4));
  assert.equal(fs.existsSync(journalPath(dir, 2)), true);
  assert.deepEqual(open(dir).read(), state(4));
});

test('compact() refuses while a write is pending and propagates a failed base write', async (t) => {
  const dir = makeDir();
  const store = open(dir, { writeDebounceMs: 50 });
  store.writeImmediate(state(1));
  store.writeImmediate(state(2));
  store.write(state(3));
  assert.equal(store.compact(), false);
  await store.flushAsync();
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); });
  assert.throws(() => store.compact(), { code: 'EPERM' });
  t.mock.restoreAll();
  assert.deepEqual(open(dir).read(), state(3));
  store.writeImmediate(state(4));
  assert.deepEqual(open(dir).read(), state(4));
  store.dispose();
  assert.equal(store.compact(), false);
});

test('compaction persists what was written, not a value mutated in memory afterwards', () => {
  const dir = makeDir();
  const store = open(dir);
  const live = state(2);
  store.writeImmediate(state(1));
  store.writeImmediate(live);
  live.session.messages.length = 0;
  assert.equal(store.compact(), true);
  const { journal_epoch: epoch, ...base } = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
  assert.ok(epoch >= 2);
  assert.deepEqual(base, state(2));
  store.dispose();
  assert.deepEqual(open(dir).read(), state(2));
});
