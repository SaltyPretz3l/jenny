'use strict';

// Fault injection for the chat (session) store, crash and migration rows (S1, S2, S4, S5, S16
// of docs/plans/PERSISTENCE_FAULTS_2026-10-26.md). Damaged records, round trips and EPERM live in
// session-store-corrupt-faults.test.js.
//
// Crash rows run tests/helpers/session-store-fault-child.js, which SIGKILLs itself at a marked
// rename; the parent waits for the child to exit and reopens the store in-process. Fixtures at
// the current schema come from the store API; only the schema re-stamp of S4 and the monolithic
// files of S5/S16 are written by hand.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { STORE_SCHEMA_VERSION } = require('../services/backend/electron-session-store');
const { pruneLegacySessionFiles } = require('../services/backend/session-legacy-file-prune');
const { cleanupTrackedResources, trackProcess } = require('./helpers/resource-cleanup');
const {
  newProfile,
  openStore,
  chatContent,
  seedChats,
  listFiles,
  readTree,
  isTemp,
  restampSchema,
  messageIds,
  assertAllChatsListed,
} = require('./helpers/session-store-fault-fixtures');

const CHILD = path.join(__dirname, 'helpers', 'session-store-fault-child.js');
const CRASH_CHAT = 'sess_crash';
const DAY_MS = 24 * 60 * 60 * 1000;

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// ---------------------------------------------------------------------------
// Crash harness
// ---------------------------------------------------------------------------

function runChild(config) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD], {
      env: { ...process.env, SESSION_FAULT_CONFIG: JSON.stringify(config) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    trackProcess(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    // 'close' follows 'exit' once the pipes drained, so every acknowledged line is read.
    child.on('close', (code, signal) => {
      resolve({ code, signal, stderr, lines: stdout.split('\n').filter(Boolean) });
    });
  });
}

// SIGKILL shows as signal SIGKILL on POSIX and as a non-zero code on Windows. 0 = ran to the
// end (the hook never fired), 2 = the child failed on its own, 4 = the kill did not land.
function assertKilled(result) {
  const killed = result.signal === 'SIGKILL' || (result.code !== null && ![0, 2, 4].includes(result.code));
  assert.ok(killed, `child was not killed: code=${result.code} signal=${result.signal} stderr=${result.stderr}`);
}

function acked(result) {
  return result.lines.filter((line) => line.startsWith('ack ')).map((line) => line.slice(4));
}

// ---------------------------------------------------------------------------
// S1, S2: crash around the rename of a chat file write (non-journal mode)
// ---------------------------------------------------------------------------

test('S1: kill before the chat file rename keeps the acknowledged messages and leaves a prunable temp', async () => {
  const profile = newProfile();
  const result = await runChild({
    profile: profile.dir, mode: 'append', journal: false, pattern: '^sess_crash\\.json$', when: 'before',
    nth: 1, killAtMessage: 4, killAtStep: 'append', total: 6,
  });
  assertKilled(result);
  assert.deepEqual(acked(result), ['m1', 'm2', 'm3']);

  const orphans = listFiles(profile.sessionsDir).filter(isTemp);
  assert.equal(orphans.length, 1, `exactly the killed write leaves a temp: ${orphans}`);
  assert.match(orphans[0], new RegExp(`^${CRASH_CHAT}\\.json\\.\\d{10,16}\\.[0-9a-f]{12}\\.tmp$`));
  const chatBytes = fs.readFileSync(profile.chatPath(CRASH_CHAT));
  assert.doesNotThrow(() => JSON.parse(chatBytes.toString('utf8')), 'the chat file is whole JSON');

  const store = openStore(profile);
  try {
    assert.deepEqual(messageIds(store.getSession(CRASH_CHAT)), ['m1', 'm2', 'm3']);
    assert.deepEqual(store.listSessions().map((summary) => summary.id), [CRASH_CHAT]);
    assert.ok(store.appendMessage(CRASH_CHAT, { id: 'm4', role: 'assistant', content: 'after crash' }));
    assert.equal(store.flushSession(CRASH_CHAT), true);
  } finally {
    store.dispose();
  }

  // The orphan is exactly what session-legacy-file-prune reaps once it is old enough, and
  // nothing else in the directory.
  const before = readTree(profile.sessionsDir);
  const pruned = await pruneLegacySessionFiles({ legacyFilePath: profile.storePath, now: Date.now() + 3 * DAY_MS });
  assert.deepEqual(pruned.failed, []);
  assert.deepEqual(pruned.deleted.map((record) => record.file), [orphans[0]]);
  const after = readTree(profile.sessionsDir);
  assert.deepEqual([...after.keys()], [...before.keys()].filter((rel) => rel !== orphans[0]));
});

test('S1b: kill before the flush rename, after the append already published the message', async () => {
  const profile = newProfile();
  const result = await runChild({
    profile: profile.dir, mode: 'append', journal: false, pattern: '^sess_crash\\.json$', when: 'before',
    nth: 1, killAtMessage: 4, killAtStep: 'flush', total: 6,
  });
  assertKilled(result);
  assert.deepEqual(acked(result), ['m1', 'm2', 'm3']);
  const store = openStore(profile);
  try {
    const ids = messageIds(store.getSession(CRASH_CHAT));
    assert.deepEqual(ids, ['m1', 'm2', 'm3', 'm4'], 'the un-acked append was already whole on disk');
  } finally {
    store.dispose();
  }
});

test('S2: kill right after the chat file rename leaves the new write whole', async () => {
  const profile = newProfile();
  const result = await runChild({
    profile: profile.dir, mode: 'append', journal: false, pattern: '^sess_crash\\.json$', when: 'after',
    nth: 1, killAtMessage: 4, killAtStep: 'append', total: 6,
  });
  assertKilled(result);
  assert.deepEqual(acked(result), ['m1', 'm2', 'm3']);
  const store = openStore(profile);
  try {
    const session = store.getSession(CRASH_CHAT);
    assert.deepEqual(messageIds(session), ['m1', 'm2', 'm3', 'm4']);
    assert.deepEqual(session.messages.map((message) => message.content), ['message 1', 'message 2', 'message 3', 'message 4']);
  } finally {
    store.dispose();
  }
});

test('S2b: kill right before the index rename that follows the chat write keeps the chat whole and listed', async () => {
  const profile = newProfile();
  const result = await runChild({
    profile: profile.dir, mode: 'append', journal: false, pattern: '^_index\\.json$', when: 'before',
    nth: 1, killAtMessage: 4, killAtStep: 'append', total: 6,
  });
  assertKilled(result);
  assert.deepEqual(acked(result), ['m1', 'm2', 'm3']);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(profile.indexPath, 'utf8')), 'the index is whole JSON');
  const store = openStore(profile);
  try {
    assert.deepEqual(store.listSessions().map((summary) => summary.id), [CRASH_CHAT]);
    assert.deepEqual(messageIds(store.getSession(CRASH_CHAT)), ['m1', 'm2', 'm3', 'm4']);
  } finally {
    store.dispose();
  }
});

// ---------------------------------------------------------------------------
// S4: kill during the split-layout schema migration
// ---------------------------------------------------------------------------

for (const journal of [false, true]) {
  test(`S4: kill during the schema 25 -> 26 split migration (journal ${journal}) re-queues it and loses nothing`, async () => {
    const profile = newProfile();
    const ids = ['sess_s4_a', 'sess_s4_b', 'sess_s4_c', 'sess_s4_d'];
    const expected = seedChats(profile, ids, { journal });
    restampSchema(profile.indexPath, 25);
    for (const id of ids) restampSchema(profile.chatPath(id), 25);
    const before = listFiles(profile.sessionsDir).filter((rel) => !isTemp(rel));

    const result = await runChild({
      profile: profile.dir, mode: 'migrate', journal, pattern: '^sess_s4_.*\\.json$', when: 'before',
      nth: 2,
    });
    assertKilled(result);
    assert.ok(result.lines.includes('opened'));
    assert.ok(!result.lines.some((line) => line.startsWith('migrated')), 'the migration never reported completion');

    const store = openStore(profile, { sessionJournal: journal });
    try {
      assert.equal(store.hasPendingMigrations(), true, 'the index still says schema 25');
      const outcome = await store.runPendingMigrations();
      assert.equal(outcome.success, true);
      assert.equal(store.hasPendingMigrations(), false);
      for (const id of ids) assert.deepEqual(chatContent(store.getSession(id)), expected[id], id);
      assert.deepEqual(store.listSessions().map((summary) => summary.id).sort(), [...ids].sort());
    } finally {
      store.dispose();
    }
    assert.equal(JSON.parse(fs.readFileSync(profile.indexPath, 'utf8')).schema_version, STORE_SCHEMA_VERSION);
    const afterNames = new Set(listFiles(profile.sessionsDir).filter((rel) => !isTemp(rel)));
    // Journal epochs are legitimately rotated by a base rewrite; every other file must survive.
    for (const rel of before.filter((name) => !name.endsWith('.journal'))) {
      assert.ok(afterNames.has(rel), `${rel} was deleted`);
    }
    const reopened = openStore(profile, { sessionJournal: journal });
    try {
      assert.equal(reopened.hasPendingMigrations(), false);
      for (const id of ids) assert.deepEqual(chatContent(reopened.getSession(id)), expected[id], `reopened ${id}`);
    } finally {
      reopened.dispose();
    }
  });
}

// ---------------------------------------------------------------------------
// S5, S16: monolithic -> split migration
// ---------------------------------------------------------------------------

function monolithicFixture(schemaVersion) {
  const sessions = {};
  ['sess_mono_a', 'sess_mono_b', 'sess_mono_c', 'sess_mono_d'].forEach((id, index) => {
    sessions[id] = {
      id,
      title: `Mono ${id}`,
      created_at: `2026-03-1${index}T10:00:00.000Z`,
      updated_at: `2026-03-1${index}T11:00:00.000Z`,
      messages: [1, 2, 3].map((n) => ({
        id: `${id}_m${n}`,
        role: n % 2 ? 'user' : 'assistant',
        content: `${id} legacy content ${n}`,
        timestamp: `2026-03-1${index}T10:0${n}:00.000Z`,
      })),
    };
  });
  return { schema_version: schemaVersion, sessions };
}

function expectedMonolithicContent(fixture) {
  const expected = {};
  for (const [id, session] of Object.entries(fixture.sessions)) {
    expected[id] = {
      title: session.title,
      messages: session.messages.map(({ id: messageId, role, content }) => ({ id: messageId, role, content })),
    };
  }
  return expected;
}

function monolithicOutcome(profile) {
  const migrated = fs.readdirSync(profile.dir).filter((name) => /^sessions\.json\.migrated-\d+$/.test(name));
  return { monolithic: fs.existsSync(profile.storePath), migrated };
}

test('S5a: kill after K chat files, before the index exists, re-runs the monolithic migration', async () => {
  const profile = newProfile();
  const fixture = monolithicFixture(2);
  fs.writeFileSync(profile.storePath, JSON.stringify(fixture));
  const originalBytes = fs.readFileSync(profile.storePath);

  const result = await runChild({
    profile: profile.dir, mode: 'open', journal: false, pattern: '^sess_mono_.*\\.json$', when: 'before', nth: 3,
  });
  assertKilled(result);
  assert.equal(fs.existsSync(profile.indexPath), false, 'the index is written after every chat file');
  assert.ok(listFiles(profile.sessionsDir).filter((rel) => /^sess_mono_.*\.json$/.test(rel)).length >= 2);
  assert.ok(fs.readFileSync(profile.storePath).equals(originalBytes), 'the monolithic file is untouched');

  const store = openStore(profile);
  try {
    assertAllChatsListed(store, expectedMonolithicContent(fixture));
  } finally {
    store.dispose();
  }
  const outcome = monolithicOutcome(profile);
  assert.ok(outcome.monolithic || outcome.migrated.length > 0, 'the legacy data exists in some form');
});

test('S5b: kill after the index rename, before the monolithic rename, lists every chat', async () => {
  const profile = newProfile();
  const fixture = monolithicFixture(2);
  fs.writeFileSync(profile.storePath, JSON.stringify(fixture));
  const originalBytes = fs.readFileSync(profile.storePath);

  const result = await runChild({
    profile: profile.dir, mode: 'open', journal: false, pattern: '^_index\\.json$', when: 'after', nth: 1,
  });
  assertKilled(result);
  assert.ok(fs.existsSync(profile.indexPath));
  assert.ok(fs.readFileSync(profile.storePath).equals(originalBytes), 'the monolithic rename never ran');

  const store = openStore(profile);
  try {
    assertAllChatsListed(store, expectedMonolithicContent(fixture));
  } finally {
    store.dispose();
  }
  const outcome = monolithicOutcome(profile);
  assert.ok(outcome.monolithic || outcome.migrated.length > 0, 'the legacy data exists in some form');
});

test('S16: a schema 2 monolithic file reaches the split layout at the current schema with content and dates intact', () => {
  const profile = newProfile();
  const fixture = monolithicFixture(2);
  fs.writeFileSync(profile.storePath, JSON.stringify(fixture));

  const first = openStore(profile);
  try {
    assertAllChatsListed(first, expectedMonolithicContent(fixture));
    for (const [id, source] of Object.entries(fixture.sessions)) {
      assert.equal(first.getSession(id).created_at, source.created_at, `${id} created_at`);
    }
  } finally {
    first.dispose();
  }
  assert.equal(JSON.parse(fs.readFileSync(profile.indexPath, 'utf8')).schema_version, STORE_SCHEMA_VERSION);
  assert.equal(fs.existsSync(profile.storePath), false);
  assert.equal(monolithicOutcome(profile).migrated.length, 1);

  const second = openStore(profile);
  try {
    assertAllChatsListed(second, expectedMonolithicContent(fixture));
    for (const [id, source] of Object.entries(fixture.sessions)) {
      assert.equal(second.getSession(id).created_at, source.created_at, `${id} created_at after reopen`);
      const onDisk = JSON.parse(fs.readFileSync(profile.chatPath(id), 'utf8'));
      assert.equal(onDisk.schema_version, STORE_SCHEMA_VERSION);
    }
  } finally {
    second.dispose();
  }
});
