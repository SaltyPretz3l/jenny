'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const {
  FEATURE_OVERRIDE_KEYS,
  buildFeatureFlagDefaults,
  normalizeFeatureOverrides,
} = require('../services/feature-flags');
const { JournaledJsonStore } = require('../services/backend/journaled-json-store');
const { SessionShadowStore } = require('../services/backend/session-shadow-store');
const { pruneLegacySessionFiles } = require('../services/backend/session-legacy-file-prune');
const { recoverTurnEventJournal } = require('../services/session-recovery-service');
const { TurnEventJournal } = require('../services/backend/turn-event-journal');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
  trackCloseable,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const TIMESTAMP = '2026-10-05T10:00:00.000Z';

function makeProfile() {
  const dir = createTrackedTempDir('jenny-session-journal-wiring-');
  return { dir, storePath: path.join(dir, 'sessions.json'), sessionsDir: path.join(dir, 'sessions') };
}

function open(profile, options = {}) {
  const logs = [];
  const store = trackCloseable(new ElectronSessionStore(profile.storePath, {
    writeDebounceMs: 60_000,
    sessionJournal: true,
    logger: (level, event, details) => logs.push({ level, event, details }),
    ...options,
  }));
  store.logs = logs;
  return store;
}

function userMessage(id, content = `message ${id}`) {
  return { id, role: 'user', content, timestamp: TIMESTAMP };
}

function names(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function journalNames(dir) {
  return names(dir).filter((name) => name.endsWith('.journal'));
}

function readBase(profile, id) {
  return JSON.parse(fs.readFileSync(path.join(profile.sessionsDir, `${id}.json`), 'utf8'));
}

// A chat with `baseCount` messages in its base file and `appended` more that
// only live in the journal (each one flushed, like a turn barrier).
function seedChat(store, { baseCount = 3, appended = 4, bulk = 0 } = {}) {
  const session = store.createSession({ title: 'Journaled' });
  for (let index = 0; index < baseCount; index += 1) {
    store.appendMessage(session.id, userMessage(`base_${index}`, 'b'.repeat(bulk || 20)));
  }
  assert.equal(store.flushSession(session.id), true);
  for (let index = 0; index < appended; index += 1) {
    assert.ok(store.appendMessage(session.id, userMessage(`tail_${index}`)));
    assert.equal(store.flushSession(session.id), true);
  }
  return session.id;
}

function messageIds(store, id) {
  return store.getSession(id).messages.map((message) => message.id);
}

function turnEvent(index) {
  return {
    event_id: `evt_${index}`,
    turn_id: 'turn_1',
    kind: 'assistant_text',
    primary_message_id: 'turn_user',
    source_message_ids: ['turn_user'],
    payload: { content: `event ${index}` },
  };
}

test('a turn on a long chat appends a small journal instead of rewriting the chat', () => {
  const profile = makeProfile();
  const store = open(profile);
  const id = seedChat(store, { baseCount: 300, appended: 0, bulk: 1300 });
  const baseBytes = fs.statSync(path.join(profile.sessionsDir, `${id}.json`)).size;
  assert.ok(baseBytes > 300 * 1024, `the chat is a few hundred KB (${baseBytes})`);
  const before = store._backend.getWriteVolumeSnapshot().session_bytes;

  store.appendMessage(id, userMessage('turn_user', 'please run the tools'));
  assert.equal(store.flushSession(id), true);
  for (let index = 0; index < 6; index += 1) {
    store.appendTurnEvents(id, [turnEvent(index)], { durable: false });
    store.appendMessage(id, {
      id: `tool_${index}`, role: 'assistant', kind: 'tool_use', content: '', timestamp: TIMESTAMP,
      status: 'running', tool_call: { call_id: `call_${index}`, tool_name: 'demo', status: 'running' },
    });
  }
  store.appendMessage(id, {
    id: 'assistant_final', role: 'assistant', content: 'all done', timestamp: TIMESTAMP, status: 'complete',
  });
  assert.equal(store.flushSession(id), true);

  const written = store._backend.getWriteVolumeSnapshot().session_bytes - before;
  assert.ok(written > 0, 'the turn wrote something');
  assert.ok(written < baseBytes * 0.1, `turn wrote ${written} bytes against a ${baseBytes} byte chat`);
  assert.ok(journalNames(profile.sessionsDir).length >= 1, 'a journal file exists');
});

test('a profile that was never disposed reopens with every acknowledged message', () => {
  const profile = makeProfile();
  const first = open(profile);
  const id = seedChat(first, { baseCount: 3, appended: 5 });
  assert.ok(journalNames(profile.sessionsDir).length >= 1);

  const second = open(profile);
  assert.deepEqual(messageIds(second, id), messageIds(first, id));
  assert.equal(messageIds(second, id).length, 8);
  assert.equal(fs.existsSync(path.join(profile.sessionsDir, 'corrupt')), false, 'nothing is quarantined');
  assert.equal(second.logs.some((entry) => entry.event === 'session_store.session_file_quarantined'), false);
});

test('dispose leaves a complete v24 base file', () => {
  const profile = makeProfile();
  const store = open(profile);
  const id = seedChat(store, { baseCount: 2, appended: 4 });
  const expected = store.getSession(id);
  store.dispose();

  const base = readBase(profile, id);
  assert.equal(base.schema_version, 24);
  assert.ok(base.journal_epoch >= 1);
  assert.equal(base.session.messages.length, 6);
  assert.equal(JSON.stringify(Object.keys(base)), JSON.stringify(['journal_epoch', 'schema_version', 'session']));

  const reopened = open(profile).getSession(id);
  assert.deepEqual(reopened.messages, expected.messages);
  assert.equal(reopened.title, expected.title);
});

test('the kill switch never creates a journal and still reads journals written with the flag on', () => {
  const offProfile = makeProfile();
  const off = open(offProfile, { sessionJournal: false });
  const offId = seedChat(off, { baseCount: 2, appended: 3 });
  assert.deepEqual(journalNames(offProfile.sessionsDir), []);
  assert.equal(readBase(offProfile, offId).session.messages.length, 5, 'every write replaced the base');
  assert.equal('journal_epoch' in readBase(offProfile, offId), false, 'the kill switch writes the pre-journal file shape');

  const onProfile = makeProfile();
  const on = open(onProfile);
  const onId = seedChat(on, { baseCount: 2, appended: 3 });
  assert.ok(journalNames(onProfile.sessionsDir).length >= 1);
  const killSwitch = open(onProfile, { sessionJournal: false });
  assert.deepEqual(messageIds(killSwitch, onId), messageIds(on, onId));
  assert.ok(killSwitch.appendMessage(onId, userMessage('after_switch')));
  assert.equal(killSwitch.flushSession(onId), true);
  assert.equal(readBase(onProfile, onId).session.messages.length, 6, 'the next write replaced the base');
  assert.equal(messageIds(open(onProfile), onId).length, 6);
});

for (const cached of [true, false]) {
  test(`deleting a chat removes its base, journals and quarantined journals (${cached ? 'cached' : 'uncached'} store)`, () => {
    const profile = makeProfile();
    const first = open(profile);
    const id = seedChat(first);
    const other = seedChat(first, { baseCount: 1, appended: 1 });
    const corruptDir = path.join(profile.sessionsDir, 'corrupt');
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, `${id}.1700000000000.json`), '{');
    fs.writeFileSync(path.join(corruptDir, `${id}.1700000000000.2.journal`), 'x');
    fs.writeFileSync(path.join(corruptDir, `${other}.1700000000000.2.journal`), 'x');
    fs.writeFileSync(path.join(profile.sessionsDir, `${id}.9.journal`), 'stale');
    assert.ok(journalNames(profile.sessionsDir).some((name) => name.startsWith(`${id}.`)));

    const store = cached ? first : open(profile);
    if (!cached) assert.equal(store._backend._sessionStores.has(id), false);
    assert.equal(store.deleteSession(id), true);

    assert.deepEqual(names(profile.sessionsDir).filter((name) => name.startsWith(`${id}.`)), []);
    assert.deepEqual(names(corruptDir), [`${other}.1700000000000.2.journal`]);
    assert.ok(names(profile.sessionsDir).includes(`${other}.json`), 'the other chat is untouched');
  });
}

test('a journal that cannot be removed does not undo a delete once the base is gone', () => {
  const profile = makeProfile();
  const first = open(profile);
  const cachedId = seedChat(first);
  const uncachedId = seedChat(first);
  const cachedStore = first._backend._sessionStores.get(cachedId);
  cachedStore.delete = () => {
    fs.unlinkSync(path.join(profile.sessionsDir, `${cachedId}.json`));
    throw Object.assign(new Error('journal busy'), { code: 'EBUSY' });
  };
  assert.equal(first.deleteSession(cachedId), true);
  assert.equal(first.logs.filter((entry) => entry.event === 'session_store.journal_delete_failed').length, 1);
  assert.equal(first.logs.some((entry) => entry.event === 'session_store.delete_failed'), false);
  assert.equal(first.getSession(cachedId), null);

  // A failed base removal still retains the chat.
  const retained = seedChat(first);
  first._backend._sessionStores.get(retained).delete = () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); };
  assert.equal(first.deleteSession(retained), false);
  assert.ok(first.getSession(retained));

  const second = open(profile);
  const original = JournaledJsonStore.deleteJournals;
  JournaledJsonStore.deleteJournals = () => { throw Object.assign(new Error('journal busy'), { code: 'EBUSY' }); };
  try {
    assert.equal(second.deleteSession(uncachedId), true);
  } finally {
    JournaledJsonStore.deleteJournals = original;
  }
  assert.equal(second.logs.filter((entry) => entry.event === 'session_store.journal_delete_failed').length, 1);
  assert.equal(fs.existsSync(path.join(profile.sessionsDir, `${uncachedId}.json`)), false);
});

test('a corrupt base is quarantined together with its journals and the chat keeps working', () => {
  const profile = makeProfile();
  const first = open(profile);
  const id = seedChat(first, { baseCount: 2, appended: 3 });
  fs.writeFileSync(path.join(profile.sessionsDir, `${id}.json`), '{"journal_epoch":1,"schema_version":23,');

  const second = open(profile);
  const stub = second.getSession(id);
  assert.deepEqual(stub.messages, []);
  const quarantined = names(path.join(profile.sessionsDir, 'corrupt'));
  const baseCopy = quarantined.find((name) => new RegExp(`^${id}\\.\\d+\\.json$`).test(name));
  assert.ok(baseCopy, `base quarantined: ${quarantined}`);
  const stamp = baseCopy.split('.')[1];
  const journalCopies = quarantined.filter((name) => new RegExp(`^${id}\\.${stamp}\\.\\d+\\.journal$`).test(name));
  assert.ok(journalCopies.length >= 1, `journals quarantined with the same stamp: ${quarantined}`);
  assert.deepEqual(
    journalNames(profile.sessionsDir).filter((name) => name.startsWith(`${id}.`)),
    [],
    'no live journal of the quarantined chat remains'
  );

  assert.ok(second.appendMessage(id, userMessage('after_quarantine')));
  assert.equal(second.flushSession(id), true);
  assert.deepEqual(messageIds(open(profile), id), ['after_quarantine']);
});

test('a damaged journal loads the readable prefix, is copied once and logs once', () => {
  const profile = makeProfile();
  const first = open(profile);
  const id = seedChat(first, { baseCount: 1, appended: 8 });
  const journals = journalNames(profile.sessionsDir).filter((name) => name.startsWith(`${id}.`));
  assert.equal(journals.length, 1);
  const target = path.join(profile.sessionsDir, journals[0]);
  const bytes = fs.readFileSync(target);
  bytes[Math.floor(bytes.length / 2)] ^= 0x01;
  fs.writeFileSync(target, bytes);

  const second = open(profile);
  const loaded = messageIds(second, id);
  assert.ok(loaded.length >= 1 && loaded.length < 9, `prefix only: ${loaded.length}`);
  assert.equal(loaded[0], 'base_0');
  // Bypass the session cache twice: the copy and the log happen once per session.
  second._backend._readSessionFromDisk(id);
  second._backend._readSessionFromDisk(id);
  const copies = names(path.join(profile.sessionsDir, 'corrupt'))
    .filter((name) => new RegExp(`^${id}\\.\\d+\\.\\d+\\.journal$`).test(name));
  assert.equal(copies.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(profile.sessionsDir, 'corrupt', copies[0])), bytes);
  assert.ok(fs.existsSync(target), 'the damaged journal itself stays where it is');
  const damaged = second.logs.filter((entry) => entry.event === 'session_store.session_journal_damaged');
  assert.equal(damaged.length, 1);
  assert.equal(damaged[0].level, 'ERROR');
  assert.equal(damaged[0].details.sessionId, id);
  assert.equal(second.logs.some((entry) => entry.event === 'session_store.session_file_quarantined'), false);
});

test('a torn journal tail is normal after a crash: INFO only, no copy', () => {
  const profile = makeProfile();
  const first = open(profile);
  const id = seedChat(first, { baseCount: 1, appended: 4 });
  const journals = journalNames(profile.sessionsDir).filter((name) => name.startsWith(`${id}.`));
  const target = path.join(profile.sessionsDir, journals[0]);
  fs.truncateSync(target, fs.statSync(target).size - 5);

  const second = open(profile);
  assert.equal(messageIds(second, id).length, 4, 'the last record was dropped');
  assert.equal(fs.existsSync(path.join(profile.sessionsDir, 'corrupt')), false);
  const dropped = second.logs.filter((entry) => entry.event === 'session_store.session_journal_tail_dropped');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].level, 'INFO');
  assert.equal(second.logs.some((entry) => entry.event === 'session_store.session_journal_damaged'), false);
});

test('a terminal commit that is rolled back is not resurrected by journal replay', () => {
  const profile = makeProfile();
  const store = open(profile);
  store.createSessionWithId('sess_terminal', { title: 'Before' });
  store.setTurnIdentity('sess_terminal', { session_incarnation: 'inc_1', turn_generation: 1 });
  store.appendMessage('sess_terminal', {
    id: 'tool_1', role: 'assistant', kind: 'tool_use', content: '', timestamp: TIMESTAMP,
    status: 'running', tool_call: { call_id: 'call_1', tool_name: 'demo', status: 'running' },
  });
  store.setActiveTurn('sess_terminal', {
    request_id: 'turn_1', stream_id: 'stream_1', turn_id: 'turn_1', user_message_id: 'user_1',
    session_incarnation: 'inc_1', generation: 1, started_at: TIMESTAMP, last_event_at: TIMESTAMP,
    status: 'streaming',
  });
  assert.equal(store.flushSession('sess_terminal'), true);
  const before = store.getSession('sess_terminal');

  const indexStore = store._backend._indexStore;
  const originalWriteImmediate = indexStore.writeImmediate.bind(indexStore);
  let attempts = 0;
  indexStore.writeImmediate = (value) => {
    attempts += 1;
    if (attempts === 1) throw new Error('index flush failed once');
    return originalWriteImmediate(value);
  };
  const result = store.conversationStore.commitTerminal('sess_terminal', {
    identity: {
      sessionId: 'sess_terminal', sessionIncarnation: 'inc_1', generation: 1,
      turnId: 'turn_1', streamId: 'stream_1', userMessageId: 'user_1',
    },
    messages: [{
      id: 'assistant_rejected', role: 'assistant', content: 'finished', timestamp: TIMESTAMP, status: 'complete',
    }],
    toolRepairs: [{
      messageId: 'tool_1', callId: 'call_1', patch: { status: 'complete', tool_call: { status: 'complete' } },
    }],
    turnEvents: [{
      event_id: 'evt_rejected', turn_id: 'turn_1', kind: 'assistant_text',
      primary_message_id: 'assistant_rejected', source_message_ids: ['assistant_rejected'],
      payload: { content: 'finished' },
    }],
    preferencePatch: { pending_question_batch: null },
    title: 'After',
    clearActiveTurnMatch: {
      requestId: 'turn_1', streamId: 'stream_1', turnId: 'turn_1',
      sessionIncarnation: 'inc_1', generation: 1, userMessageId: 'user_1',
    },
  }, { durable: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'durability_failed');
  assert.equal(result.value.rollbackRestored, true);
  assert.deepEqual(store.getSession('sess_terminal'), before);

  const reopened = open(profile).getSession('sess_terminal');
  assert.deepEqual(reopened.messages.map((message) => message.id), ['tool_1']);
  assert.equal(reopened.title, 'Before');
  assert.ok(reopened.active_turn, 'the active turn is back');
  assert.deepEqual(reopened.turn_events, before.turn_events);
});

test('turn-event recovery journal is only cleared once the session journal holds the events', () => {
  const profile = makeProfile();
  const store = open(profile);
  const created = store.createSession({ title: 'Interrupted' });
  store.appendMessage(created.id, { ...userMessage('user_stream_1', 'Run a tool'), client_message_id: 'user_stream_1' });
  store.setActiveTurn(created.id, {
    request_id: 'stream_1', stream_id: 'stream_1', user_message_id: 'user_stream_1',
    started_at: TIMESTAMP, last_event_at: TIMESTAMP, status: 'streaming',
  });
  assert.equal(store.flushSession(created.id), true);
  const journal = new TurnEventJournal(path.join(profile.dir, 'turn-event-journal.json'));
  journal.append(created.id, 'stream_1', [{
    event_id: 'stream_1:tool_use:0', turn_id: 'stream_1', kind: 'tool_use',
    tool_call_id: 'call_1', payload: { tool_name: 'read_file' },
  }]);

  const result = recoverTurnEventJournal({ sessionStore: store, journal });
  assert.equal(result.replayed, 1);
  assert.deepEqual(journal.list(created.id, 'stream_1'), []);
  assert.ok(journalNames(profile.sessionsDir).length >= 1);

  const crashed = open(profile);
  const events = crashed.getSessionTurnEvents(created.id);
  assert.deepEqual(events.map((event) => event.event_id), ['stream_1:tool_use:0']);
  const again = recoverTurnEventJournal({ sessionStore: crashed, journal });
  assert.equal(again.replayed, 0);
  assert.equal(crashed.getSessionTurnEvents(created.id).length, 1, 'not duplicated');
});

test('a journaled chat found under an older index is migrated with its journaled messages', async () => {
  const profile = makeProfile();
  const first = open(profile);
  const id = seedChat(first, { baseCount: 1, appended: 3 });
  const baseMessages = readBase(profile, id).session.messages.length;
  assert.equal(baseMessages, 1, 'only the base message is in the base file');
  assert.ok(readBase(profile, id).journal_epoch >= 1);

  const indexPath = path.join(profile.sessionsDir, '_index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  index.schema_version = 22;
  fs.writeFileSync(indexPath, JSON.stringify(index));

  const second = open(profile);
  assert.equal(second._backend.hasPendingMigrations(), true);
  const outcome = await second._backend.runPendingMigrations();
  assert.equal(outcome.success, true);
  assert.deepEqual(messageIds(second, id), ['base_0', 'tail_0', 'tail_1', 'tail_2']);
  assert.equal(second.flushSession(id), true);
  assert.deepEqual(messageIds(open(profile), id), ['base_0', 'tail_0', 'tail_1', 'tail_2']);
  assert.equal(JSON.parse(fs.readFileSync(indexPath, 'utf8')).schema_version, 24);
});

test('the legacy prune removes only old journals that no read can reach', async () => {
  const profile = makeProfile();
  fs.mkdirSync(profile.sessionsDir, { recursive: true });
  const now = Date.now();
  const old = new Date(now - 3 * 24 * 60 * 60 * 1000);
  const young = new Date(now - 60 * 1000);
  const write = (name, mtime) => {
    const file = path.join(profile.sessionsDir, name);
    fs.writeFileSync(file, 'journal');
    fs.utimesSync(file, mtime, mtime);
  };
  write('gone.3.journal', old);
  write('fresh.2.journal', young);
  write('kept.4.journal', old);
  write('kept.5.journal', old);
  write('kept.2.journal', old);
  // One generation back is the fallback for a lost rename of the current base.
  write('kept.3.journal', old);
  fs.writeFileSync(path.join(profile.sessionsDir, 'kept.json'), '{"journal_epoch":4,"schema_version":23,"session":{}}');
  // A base rewritten without an epoch (the kill switch) is never replayed over.
  write('plain.2.journal', old);
  fs.writeFileSync(path.join(profile.sessionsDir, 'plain.json'), '{"schema_version":23,"session":{}}');
  write('notes.txt', old);
  fs.mkdirSync(path.join(profile.sessionsDir, 'dir.5.journal'));
  // A base that exists but cannot be read (here: not a file) keeps its journal.
  write('locked.3.journal', old);
  fs.mkdirSync(path.join(profile.sessionsDir, 'locked.json'));

  const logs = [];
  const result = await pruneLegacySessionFiles({
    legacyFilePath: profile.storePath,
    now,
    log: (level, event, details) => logs.push({ level, event, details }),
  });
  assert.deepEqual(
    result.deleted.map((entry) => [entry.file, entry.kind]).sort(),
    [['gone.3.journal', 'orphaned_journal'], ['kept.2.journal', 'orphaned_journal'], ['plain.2.journal', 'orphaned_journal']]
  );
  assert.deepEqual(result.failed, []);
  assert.deepEqual(names(profile.sessionsDir), [
    'dir.5.journal', 'fresh.2.journal', 'kept.3.journal', 'kept.4.journal', 'kept.5.journal', 'kept.json',
    'locked.3.journal', 'locked.json', 'notes.txt', 'plain.json',
  ]);
  assert.equal(logs.filter((entry) => entry.event === 'session_store.legacy_file_pruned').length, 3);
});

test('the shadow store keeps whole-file chat files with no journal', () => {
  const dir = createTrackedTempDir('jenny-session-journal-shadow-');
  const filePath = path.join(dir, 'session-shadow.json');
  const store = trackCloseable(new SessionShadowStore(filePath, { writeDebounceMs: 60_000 }));
  store.upsertSession('shadow_1', { title: 'Shadow', messages: [userMessage('s1'), userMessage('s2')] });
  assert.equal(store.flushSession('shadow_1'), true);
  store.upsertSession('shadow_1', { messages: [userMessage('s1'), userMessage('s2'), userMessage('s3')] });
  assert.equal(store.flushSession('shadow_1'), true);
  store.flush();
  store.dispose();

  const sessionsDir = path.join(dir, 'session-shadow');
  assert.deepEqual(journalNames(sessionsDir), []);
  const chat = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'shadow_1.json'), 'utf8'));
  assert.equal(Object.hasOwn(chat, 'journal_epoch'), false);
  assert.equal(chat.schema_version, 9);
  assert.equal(chat.session.messages.length, 3);
});

test('rebuilding a lost index counts the journaled messages', () => {
  const profile = makeProfile();
  const first = open(profile);
  const id = seedChat(first, { baseCount: 2, appended: 5 });
  assert.equal(readBase(profile, id).session.messages.length, 2);
  fs.rmSync(path.join(profile.sessionsDir, '_index.json'));

  const second = open(profile);
  assert.equal(second.getSessionSummary(id).message_count, 7);
  assert.equal(second.logs.some((entry) => entry.event === 'session_store.split_index_recovered'), true);
  assert.equal(messageIds(second, id).length, 7);
});

test('session_journal is a default-on internal flag with an environment kill switch', () => {
  assert.equal(buildFeatureFlagDefaults({}).session_journal, true);
  assert.equal(buildFeatureFlagDefaults({ JENNY_ENABLE_SESSION_JOURNAL: '0' }).session_journal, false);
  assert.equal(FEATURE_OVERRIDE_KEYS.includes('session_journal'), false);
  assert.deepEqual(normalizeFeatureOverrides({ session_journal: false }), {});
});
