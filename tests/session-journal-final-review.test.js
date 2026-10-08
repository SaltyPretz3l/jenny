'use strict';

// Regression tests for the pre-landing reviews of the session journal.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { JournaledJsonStore } = require('../services/backend/journaled-json-store');
const { replayStable } = require('../services/backend/journaled-json-files');
const { purgeSessionRecoveryCopies } = require('../services/backend/session-recovery-copies');
const { encodeHeader, encodeRecord, replayJournal } = require('../services/backend/session-journal');
const { PortablePreferencesStore } = require('../services/data-lifecycle/portable-preferences-store');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
  trackCloseable,
} = require('./helpers/resource-cleanup');

const TIMESTAMP = '2026-07-14T10:00:00.000Z';
const STORE_OPTIONS = { payloadKey: 'session', compact: true, idleCompactMs: 0 };

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function state(count) {
  const messages = [];
  for (let index = 0; index < count; index += 1) messages.push({ id: `m${index}` });
  return { schema_version: 1, session: { id: 's1', messages } };
}

function journalOf(count) {
  const parts = [encodeHeader({ sessionId: 's1', epoch: 1 })];
  for (let index = 0; index < count; index += 1) {
    parts.push(encodeRecord([{ o: 'm', i: index, v: { id: `m${index}` } }]));
  }
  return Buffer.concat(parts);
}

function lockFiles(t, pattern) {
  const realRead = fs.readFileSync;
  return t.mock.method(fs, 'readFileSync', (file, ...rest) => {
    if (typeof file === 'string' && pattern.test(path.basename(file))) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${file}'`), { code: 'EBUSY' });
    }
    return realRead(file, ...rest);
  });
}

test('a damaged header in front of readable records is corruption, not an ignorable file', () => {
  const journal = journalOf(2);
  const damaged = Buffer.from(journal);
  damaged[journal.indexOf('"header"') + 2] ^= 0x01;
  const result = replayJournal({ id: 's1', messages: [] }, damaged, { sessionId: 's1', epoch: 1 });
  assert.equal(result.status, 'corrupt');
  assert.equal(result.records, 0);
  assert.deepEqual(result.session, { id: 's1', messages: [] });

  // A header alone that does not read (a crash while the file was created) and
  // a healthy header for another chat are still just ignored.
  const torn = encodeHeader({ sessionId: 's1', epoch: 1 }).subarray(0, 12);
  assert.equal(replayJournal({ id: 's1' }, torn, { sessionId: 's1', epoch: 1 }).status, 'header_mismatch');
  assert.equal(replayJournal({ id: 's1' }, journal, { sessionId: 'other', epoch: 1 }).status, 'header_mismatch');
});

test('a chat whose journal header is damaged reports the damage through the store', () => {
  const dir = createTrackedTempDir('jenny-journal-final-');
  const filePath = path.join(dir, 's1.json');
  const writer = new JournaledJsonStore(filePath, STORE_OPTIONS);
  writer.writeImmediate(state(1));
  writer.writeImmediate(state(3));
  const journalPath = path.join(dir, 's1.1.journal');
  const bytes = fs.readFileSync(journalPath);
  bytes[bytes.indexOf('"header"') + 2] ^= 0x01;
  fs.writeFileSync(journalPath, bytes);

  const read = JournaledJsonStore.readFile(filePath, { payloadKey: 'session' });
  assert.equal(read.journalStatus, 'corrupt');
  assert.equal(read.value.session.messages.length, 1);
});

test('the corruption scan is bounded when many candidates end at one newline', () => {
  // Each "J1 <n> 00000000 " prefix claims a body that ends at the single final
  // newline, so an unbounded scan checksums the rest of the file once per prefix.
  const size = 512 * 1024;
  const body = Buffer.alloc(size, 0x20);
  const bad = Buffer.from('J1 5 00000000 {"x"}\n');
  let offset = 0;
  while (offset + 40 < size) {
    const prefix = Buffer.from(`J1 ${size - (offset + 16 + String(size).length)} 00000000 `);
    // Recompute so the claimed body ends exactly at the final byte.
    const claimed = size - 1 - (offset + prefix.length);
    const exact = Buffer.from(`J1 ${claimed} 00000000 `);
    if (exact.length !== prefix.length) {
      offset += 1;
      continue;
    }
    exact.copy(body, offset);
    offset += exact.length + 8;
  }
  body[size - 1] = 0x0a;
  const buffer = Buffer.concat([encodeHeader({ sessionId: 's1', epoch: 1 }), bad, body]);
  const startedAt = Date.now();
  const result = replayJournal({ id: 's1' }, buffer, { sessionId: 's1', epoch: 1 });
  assert.ok(Date.now() - startedAt < 5000, `scan took ${Date.now() - startedAt} ms`);
  assert.ok(['corrupt', 'torn_tail'].includes(result.status));
  assert.equal(result.records, 0);
});

test('an append never re-creates a journal that vanished: the base is replaced instead', () => {
  const dir = createTrackedTempDir('jenny-journal-final-');
  const filePath = path.join(dir, 's1.json');
  const store = new JournaledJsonStore(filePath, STORE_OPTIONS);
  store.writeImmediate(state(1));
  store.writeImmediate(state(2));
  fs.unlinkSync(path.join(dir, 's1.1.journal'));
  store.writeImmediate(state(3));

  const read = JournaledJsonStore.readFile(filePath, { payloadKey: 'session' });
  assert.equal(read.value.session.messages.length, 3);
  assert.notEqual(read.journalStatus, 'corrupt');
  store.writeImmediate(state(4));
  assert.equal(JournaledJsonStore.readFile(filePath, { payloadKey: 'session' }).value.session.messages.length, 4);
  store.dispose();
});

test('a read whose base is replaced between the base and journal reads is retried, then refused', () => {
  const dir = createTrackedTempDir('jenny-journal-final-');
  const filePath = path.join(dir, 's1.json');
  const writer = new JournaledJsonStore(filePath, STORE_OPTIONS);
  writer.writeImmediate(state(1));
  writer.writeImmediate(state(2));
  const staleBase = fs.readFileSync(filePath, 'utf8');
  const ctx = () => ({ filePath, payloadKey: 'session', journalId: 's1', logger: null, defaultValue: null });

  // The reader holds base 1; a second writer replaces the base (epoch 2) before
  // the journals are read. The second attempt sees a consistent file.
  let calls = 0;
  const once = replayStable(() => {
    calls += 1;
    if (calls === 1) {
      const other = new JournaledJsonStore(filePath, STORE_OPTIONS);
      other.writeImmediate(state(5));
      other.dispose();
      return { value: JSON.parse(staleBase), missing: false, corrupted: false };
    }
    return { value: JSON.parse(fs.readFileSync(filePath, 'utf8')), missing: false, corrupted: false };
  }, ctx());
  assert.equal(calls, 2);
  assert.equal(once.value.session.messages.length, 5);

  // A base that never matches what was read is not served as a mix.
  const never = replayStable(() => ({ value: JSON.parse(staleBase), missing: false, corrupted: false }), ctx());
  assert.equal(never.unreadable, true);
  assert.equal(never.errorCode, 'EBASECHANGED');
  assert.equal(never.value, null);
  writer.dispose();
});

test('an idle period above the timer maximum does not compact at once', async () => {
  const dir = createTrackedTempDir('jenny-journal-final-');
  const filePath = path.join(dir, 's1.json');
  const store = new JournaledJsonStore(filePath, { ...STORE_OPTIONS, idleCompactMs: 3e9 });
  store.writeImmediate(state(1));
  store.writeImmediate(state(2));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(path.join(dir, 's1.1.journal')), true);
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).journal_epoch, 1);
  store.dispose();
});

test('cancelScheduledCompaction stops the age timer', async () => {
  const dir = createTrackedTempDir('jenny-journal-final-');
  const filePath = path.join(dir, 's1.json');
  const store = new JournaledJsonStore(filePath, { ...STORE_OPTIONS, idleCompactMs: 40 });
  store.writeImmediate(state(1));
  store.writeImmediate(state(2));
  store.cancelScheduledCompaction();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).journal_epoch, 1, 'no compaction ran');
  store.dispose();
});

test('an index and a chat locked together at startup: the chat keeps its place and its summary is repaired', (t) => {
  const dir = createTrackedTempDir('jenny-journal-final-');
  const storePath = path.join(dir, 'sessions.json');
  const sessionsDir = path.join(dir, 'sessions');
  const open = () => {
    const logs = [];
    const store = trackCloseable(new ElectronSessionStore(storePath, {
      writeDebounceMs: 0,
      sessionJournal: true,
      logger: (level, event, details) => logs.push({ level, event, details }),
    }));
    store.logs = logs;
    return store;
  };
  const first = open();
  for (const [id, title, count] of [['chat_a', 'Alpha', 1], ['chat_b', 'Bravo', 3]]) {
    assert.ok(first.createSessionWithId(id, { title }));
    for (let index = 0; index < count; index += 1) {
      assert.ok(first.appendMessage(id, { id: `${id}_m${index}`, role: 'user', content: 'hi', timestamp: TIMESTAMP }));
    }
    assert.equal(first.flushSession(id), true);
  }
  first.dispose();

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lock = lockFiles(t, /^(_index|chat_b)\.json$/);
  const second = open();
  assert.deepEqual(second.listSessions().map((summary) => summary.id).sort(), ['chat_a', 'chat_b']);
  assert.equal(second.getSessionSummary('chat_b').message_count, 0, 'unknown while the file is locked');

  // Still locked at the first retry, readable at the second.
  t.mock.timers.tick(2000);
  assert.equal(second.getSessionSummary('chat_b').message_count, 0);
  lock.mock.restore();
  t.mock.timers.tick(15000);
  const repaired = second.getSessionSummary('chat_b');
  assert.equal(repaired.message_count, 3);
  assert.equal(repaired.title, 'Bravo');
  assert.ok(second.logs.some((entry) => entry.event === 'session_store.index_entry_repaired'));
  t.mock.timers.reset();
  second.dispose();

  assert.equal(open().getSessionSummary('chat_b').message_count, 3, 'the repaired entry was saved');
  assert.equal(fs.existsSync(path.join(sessionsDir, 'corrupt')), false);
});

test('a damaged index journal is copied aside before the index is rebuilt', () => {
  const dir = createTrackedTempDir('jenny-journal-final-');
  const storePath = path.join(dir, 'sessions.json');
  const sessionsDir = path.join(dir, 'sessions');
  const options = { writeDebounceMs: 60_000, sessionJournal: true };
  const first = trackCloseable(new ElectronSessionStore(storePath, options));
  for (let index = 0; index < 6; index += 1) {
    assert.ok(first.createSessionWithId(`chat_${index}`, { title: `Chat ${index}` }));
    assert.equal(first.flushSession(`chat_${index}`), true);
  }
  const journal = fs.readdirSync(sessionsDir).filter((name) => /^_index\.\d+\.journal$/.test(name)).sort().pop();
  const journalPath = path.join(sessionsDir, journal);
  const bytes = fs.readFileSync(journalPath);
  bytes[Math.floor(bytes.length / 2)] ^= 0x01;
  fs.writeFileSync(journalPath, bytes);

  const second = trackCloseable(new ElectronSessionStore(storePath, options));
  assert.equal(second.listSessions().length, 6);
  const copies = fs.readdirSync(path.join(sessionsDir, 'corrupt'));
  assert.ok(copies.some((name) => /^_index\.\d{10,16}\.\d+\.journal$/.test(name)), copies.join(', '));
});

test('the recovery-copy purge leaves the journals of a chat that exists', () => {
  const dir = createTrackedTempDir('jenny-journal-final-');
  const backend = {
    _rootDir: dir,
    _storeName: 'session_store',
    _mode: 'split',
    _logger: null,
    _sessionFilePath: (id) => path.join(dir, `${id}.json`),
  };
  fs.writeFileSync(path.join(dir, 'chat_x.2.journal'), 'j');
  fs.writeFileSync(path.join(dir, 'chat_x.json'), '{}');
  assert.equal(purgeSessionRecoveryCopies(backend, 'chat_x').removed, 0);
  assert.equal(fs.existsSync(path.join(dir, 'chat_x.2.journal')), true);

  fs.unlinkSync(path.join(dir, 'chat_x.json'));
  assert.equal(purgeSessionRecoveryCopies(backend, 'chat_x').removed, 1);
  assert.equal(fs.existsSync(path.join(dir, 'chat_x.2.journal')), false);
});

test('portable preferences are not rewritten from defaults while the file cannot be read', (t) => {
  const dir = createTrackedTempDir('jenny-journal-final-');
  const store = new PortablePreferencesStore(dir);
  store.sync({ chatZoomPercent: 110, preferredModel: 'qwen3' });
  const before = fs.readFileSync(store.filePath, 'utf8');

  lockFiles(t, new RegExp(`^${path.basename(store.filePath).replace(/\./g, '\\.')}$`));
  assert.throws(() => store.sync({ chatZoomPercent: 90 }), /portable_preferences_unreadable/);
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(store.filePath, 'utf8'), before);
  assert.equal(store.read().preferredModel, 'qwen3');
});
