'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { FileJsonStore } = require('../services/backend/file-json-store');
const { JournaledJsonStore } = require('../services/backend/journaled-json-store');
const { SessionShadowStore } = require('../services/backend/session-shadow-store');
const { pruneLegacySessionFiles } = require('../services/backend/session-legacy-file-prune');
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
  const dir = createTrackedTempDir('jenny-session-index-journal-');
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

function names(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function indexJournals(profile) {
  return names(profile.sessionsDir).filter((name) => /^_index\.\d+\.journal$/.test(name));
}

function indexPath(profile) {
  return path.join(profile.sessionsDir, '_index.json');
}

// The index file exactly as a script or another process would parse it.
function readRawIndex(profile) {
  return JSON.parse(fs.readFileSync(indexPath(profile), 'utf8'));
}

function userMessage(id) {
  return { id, role: 'user', content: `message ${id}`, timestamp: TIMESTAMP };
}

function listedIds(store) {
  return store.listSessions().map((summary) => summary.id).sort();
}

function titles(store) {
  return Object.fromEntries(store.listSessions().map((summary) => [summary.id, summary.title]));
}

// A chat that is durable on disk: created, given `count` messages and flushed
// through the same barrier a turn commit uses.
function seedChat(store, id, { title = id, count = 0 } = {}) {
  assert.ok(store.createSessionWithId(id, { title }), `created ${id}`);
  for (let index = 0; index < count; index += 1) {
    assert.ok(store.appendMessage(id, userMessage(`${id}_m${index}`)));
  }
  assert.equal(store.flushSession(id), true, `${id} is durable`);
  return id;
}

test('the index store class follows the journal option, and the shadow store stays plain', () => {
  const on = open(makeProfile());
  assert.ok(on._backend._indexStore instanceof JournaledJsonStore);

  const off = open(makeProfile(), { sessionJournal: false });
  assert.ok(off._backend._indexStore instanceof FileJsonStore);
  assert.equal(off._backend._indexStore instanceof JournaledJsonStore, false);

  const dir = createTrackedTempDir('jenny-session-index-shadow-');
  const shadow = trackCloseable(new SessionShadowStore(path.join(dir, 'session-shadow.json'), { writeDebounceMs: 60_000 }));
  assert.equal(shadow._backend._indexStore instanceof JournaledJsonStore, false);
});

test('index-shaped values round trip through the journal, including chats named like its array keys', () => {
  const dir = createTrackedTempDir('jenny-index-store-');
  const file = path.join(dir, '_index.json');
  const summary = (title, count = 1) => ({ id: title, title, updated_at: TIMESTAMP, message_count: count });
  const writer = trackCloseable(new JournaledJsonStore(file, { payloadKey: 'sessions', compact: true, idleCompactMs: 0 }));
  const read = () => JournaledJsonStore.readFile(file, { payloadKey: 'sessions', defaultValue: null });
  let sessions = { chat_1: summary('one'), messages: summary('named messages'), turn_events: summary('named events') };
  const write = () => {
    writer.writeImmediate({ schema_version: 23, sessions });
    const served = read();
    assert.equal(served.journalStatus === 'ok' || served.journalStatus === 'none', true, served.journalStatus);
    assert.deepEqual(served.value, { schema_version: 23, sessions });
  };
  write();
  const steps = [
    () => { sessions = { ...sessions, messages: summary('renamed messages', 2) }; },
    () => { sessions = { ...sessions, chat_2: summary('two') }; },
    () => { const { turn_events: removed, ...rest } = sessions; void removed; sessions = rest; },
    () => { sessions = { ...sessions, chat_1: summary('one again', 5) }; },
    () => { sessions = { ...sessions, turn_events: summary('events back', 3) }; },
    () => { const { messages: removed, ...rest } = sessions; void removed; sessions = rest; },
    () => { const { chat_1: removed, ...rest } = sessions; void removed; sessions = rest; },
  ];
  for (const step of steps) {
    step();
    write();
  }
  assert.ok(names(dir).some((name) => /^_index\.\d+\.journal$/.test(name)), 'the steps were journaled');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).journal_epoch, 1, 'the base was written once');
});

test('a turn-like sequence on a 200-chat index writes a small fraction of the index', () => {
  const profile = makeProfile();
  const store = open(profile);
  for (let index = 0; index < 200; index += 1) {
    assert.ok(store.createSessionWithId(`chat_${index}`, { title: `Seeded chat number ${index} with a realistic title` }));
  }
  store.flush();
  const indexBytes = fs.statSync(indexPath(profile)).size;
  assert.ok(indexBytes > 50 * 1024, `the index is large (${indexBytes})`);
  assert.deepEqual(indexJournals(profile), [], 'one base write so far');

  const before = store._backend.getWriteVolumeSnapshot().index_bytes;
  for (let index = 0; index < 6; index += 1) {
    assert.ok(store.appendMessage('chat_7', userMessage(`turn_${index}`)));
    assert.equal(store.flushSession('chat_7'), true);
  }
  const written = store._backend.getWriteVolumeSnapshot().index_bytes - before;
  assert.ok(written > 0, 'the turn wrote index bytes');
  assert.ok(written < indexBytes * 0.1, `turn wrote ${written} index bytes against a ${indexBytes} byte index`);
  assert.equal(indexJournals(profile).length, 1, 'an index journal exists');
});

test('a profile that was never disposed reopens with the right chats, titles and counts', () => {
  const profile = makeProfile();
  const first = open(profile);
  seedChat(first, 'chat_a', { title: 'Alpha' });
  seedChat(first, 'chat_b', { title: 'Bravo' });
  seedChat(first, 'chat_c', { title: 'Charlie' });
  first.flush();

  assert.equal(first.deleteSession('chat_c'), true);
  assert.ok(first.renameSession('chat_b', 'Bravo renamed'));
  assert.equal(first.flushSession('chat_b'), true);
  seedChat(first, 'chat_d', { title: 'Delta', count: 2 });
  assert.ok(first.appendMessage('chat_a', userMessage('a1')));
  assert.ok(first.appendMessage('chat_a', userMessage('a2')));
  assert.ok(first.appendMessage('chat_a', userMessage('a3')));
  assert.equal(first.flushSession('chat_a'), true);
  assert.ok(indexJournals(profile).length >= 1);

  const second = open(profile);
  assert.deepEqual(listedIds(second), ['chat_a', 'chat_b', 'chat_d']);
  assert.deepEqual(titles(second), { chat_a: 'Alpha', chat_b: 'Bravo renamed', chat_d: 'Delta' });
  assert.equal(second.getSessionSummary('chat_a').message_count, 3);
  assert.equal(second.getSessionSummary('chat_d').message_count, 2);
  assert.equal(second.getSession('chat_a').messages.length, 3);
  assert.equal(second.getSession('chat_c'), null);
  assert.equal(fs.existsSync(path.join(profile.sessionsDir, 'chat_c.json')), false);
  assert.equal(second.logs.some((entry) => entry.level === 'ERROR'), false);
});

test('dispose leaves an index file that lists every chat with its current summary', () => {
  const profile = makeProfile();
  const store = open(profile);
  seedChat(store, 'chat_a', { title: 'Alpha' });
  seedChat(store, 'chat_b', { title: 'Bravo' });
  store.flush();
  assert.ok(store.renameSession('chat_a', 'Alpha renamed'));
  seedChat(store, 'chat_c', { title: 'Charlie', count: 4 });
  assert.equal(store.deleteSession('chat_b'), true);
  assert.equal(store.flushSession('chat_c'), true);
  assert.ok(indexJournals(profile).length >= 1);
  const stale = readRawIndex(profile);
  assert.deepEqual(Object.keys(stale.sessions), ['chat_a'], 'the base alone is stale before dispose');

  store.dispose();
  const base = readRawIndex(profile);
  assert.equal(base.schema_version, 24);
  assert.ok(base.journal_epoch >= 1);
  assert.deepEqual(Object.keys(base).sort(), ['journal_epoch', 'schema_version', 'sessions']);
  assert.deepEqual(Object.keys(base.sessions).sort(), ['chat_a', 'chat_c']);
  assert.deepEqual(base.sessions, store._backend.getIndexSnapshot().sessions);
  assert.equal(base.sessions.chat_a.title, 'Alpha renamed');
  assert.equal(base.sessions.chat_c.message_count, 4);

  const reopened = open(profile);
  assert.deepEqual(titles(reopened), { chat_a: 'Alpha renamed', chat_c: 'Charlie' });
});

test('flushAsync and disposeAsync also leave a complete index file', async () => {
  const profile = makeProfile();
  const store = open(profile);
  seedChat(store, 'chat_a');
  store.flush();
  seedChat(store, 'chat_b', { count: 2 });
  assert.ok(indexJournals(profile).length >= 1);
  assert.deepEqual(Object.keys(readRawIndex(profile).sessions), ['chat_a']);

  await store.flushAsync();
  assert.deepEqual(Object.keys(readRawIndex(profile).sessions).sort(), ['chat_a', 'chat_b']);

  seedChat(store, 'chat_c');
  await store.disposeAsync();
  assert.deepEqual(Object.keys(readRawIndex(profile).sessions).sort(), ['chat_a', 'chat_b', 'chat_c']);
});

test('the kill switch never creates an index journal and leaves the pre-journal file shape', () => {
  const profile = makeProfile();
  const off = open(profile, { sessionJournal: false });
  for (const id of ['chat_a', 'chat_b', 'chat_c']) seedChat(off, id, { count: 2 });
  assert.deepEqual(indexJournals(profile), []);
  const base = readRawIndex(profile);
  assert.equal(Object.hasOwn(base, 'journal_epoch'), false);
  assert.deepEqual(Object.keys(base.sessions).sort(), ['chat_a', 'chat_b', 'chat_c']);
});

test('the kill switch reads an un-compacted journaled index and removes the unreachable journals on its first write', () => {
  const profile = makeProfile();
  const on = open(profile);
  seedChat(on, 'chat_a', { title: 'Alpha' });
  on.flush();
  seedChat(on, 'chat_late', { title: 'Late', count: 2 });
  assert.ok(indexJournals(profile).length >= 1);
  assert.deepEqual(Object.keys(readRawIndex(profile).sessions), ['chat_a'], 'the base lacks the journaled chat');

  const off = open(profile, { sessionJournal: false });
  assert.deepEqual(listedIds(off), ['chat_a', 'chat_late']);
  assert.equal(off.getSessionSummary('chat_late').message_count, 2);
  assert.ok(indexJournals(profile).length >= 1, 'reading removes nothing');

  seedChat(off, 'chat_off', { title: 'Off' });
  assert.deepEqual(indexJournals(profile), []);
  const base = readRawIndex(profile);
  assert.equal(Object.hasOwn(base, 'journal_epoch'), false);
  assert.deepEqual(Object.keys(base.sessions).sort(), ['chat_a', 'chat_late', 'chat_off']);
  assert.equal(off.logs.some((entry) => /journal_delete_failed/.test(entry.event)), false);

  for (const sessionJournal of [false, true]) {
    assert.deepEqual(listedIds(open(profile, { sessionJournal })), ['chat_a', 'chat_late', 'chat_off']);
  }
});

test('turning the flag back on after a kill-switch run reads, writes and reopens consistently', () => {
  const profile = makeProfile();
  const off = open(profile, { sessionJournal: false });
  seedChat(off, 'chat_a', { title: 'Alpha' });
  seedChat(off, 'chat_b', { title: 'Bravo' });
  assert.equal(Object.hasOwn(readRawIndex(profile), 'journal_epoch'), false);

  const on = open(profile);
  assert.deepEqual(listedIds(on), ['chat_a', 'chat_b']);
  seedChat(on, 'chat_c', { title: 'Charlie' });
  assert.ok(on.renameSession('chat_a', 'Alpha renamed'));
  assert.equal(on.flushSession('chat_a'), true);
  assert.ok(Number.isInteger(readRawIndex(profile).journal_epoch), 'the first write is a base with an epoch');

  const again = open(profile);
  assert.deepEqual(titles(again), { chat_a: 'Alpha renamed', chat_b: 'Bravo', chat_c: 'Charlie' });
  seedChat(again, 'chat_d', { title: 'Delta' });
  assert.equal(again.deleteSession('chat_b'), true);
  assert.ok(again.appendMessage('chat_d', userMessage('d1')));
  assert.equal(again.flushSession('chat_d'), true);
  assert.deepEqual(titles(open(profile)), { chat_a: 'Alpha renamed', chat_c: 'Charlie', chat_d: 'Delta' });
});

test('chats named messages and turn_events round trip through create, update, delete and a crash', () => {
  const profile = makeProfile();
  const first = open(profile);
  seedChat(first, 'chat_anchor', { title: 'Anchor' });
  first.flush();

  seedChat(first, 'messages', { title: 'Messages chat', count: 1 });
  seedChat(first, 'turn_events', { title: 'Events chat' });
  assert.deepEqual(titles(open(profile)), { chat_anchor: 'Anchor', messages: 'Messages chat', turn_events: 'Events chat' });

  assert.ok(first.renameSession('messages', 'Messages renamed'));
  assert.equal(first.flushSession('messages'), true);
  assert.ok(first.appendMessage('turn_events', userMessage('e1')));
  assert.equal(first.flushSession('turn_events'), true);
  assert.deepEqual(titles(open(profile)), {
    chat_anchor: 'Anchor', messages: 'Messages renamed', turn_events: 'Events chat',
  });
  assert.equal(open(profile).getSessionSummary('turn_events').message_count, 1);

  assert.equal(first.deleteSession('turn_events'), true);
  assert.ok(first.renameSession('chat_anchor', 'Anchor renamed'));
  assert.equal(first.flushSession('chat_anchor'), true);
  const reopened = open(profile);
  assert.deepEqual(titles(reopened), { chat_anchor: 'Anchor renamed', messages: 'Messages renamed' });
  assert.equal(reopened.getSession('messages').messages.length, 1);
  assert.equal(reopened.logs.some((entry) => entry.level === 'ERROR'), false);
});

test('a lost index and its journals are rebuilt from the chat files', () => {
  const profile = makeProfile();
  const first = open(profile);
  seedChat(first, 'chat_a', { title: 'Alpha', count: 1 });
  first.flush();
  seedChat(first, 'chat_b', { title: 'Bravo', count: 2 });
  assert.ok(indexJournals(profile).length >= 1);

  fs.rmSync(indexPath(profile));
  for (const name of indexJournals(profile)) fs.rmSync(path.join(profile.sessionsDir, name));
  const second = open(profile);
  assert.deepEqual(listedIds(second), ['chat_a', 'chat_b']);
  assert.equal(second.getSessionSummary('chat_b').message_count, 2);
  assert.equal(second.logs.some((entry) => entry.event === 'session_store.split_index_recovered'), true);
  assert.ok(Number.isInteger(readRawIndex(profile).journal_epoch));
  assert.deepEqual(listedIds(open(profile)), ['chat_a', 'chat_b']);
});

test('index journals left beside a lost index are not replayed over the rebuilt one', () => {
  const profile = makeProfile();
  const first = open(profile);
  seedChat(first, 'chat_a', { title: 'Alpha' });
  seedChat(first, 'chat_b', { title: 'Bravo' });
  first.flush();
  seedChat(first, 'chat_ghost', { title: 'Ghost' });
  const journals = indexJournals(profile);
  assert.ok(journals.length >= 1);
  const oldEpoch = readRawIndex(profile).journal_epoch;
  assert.ok(Number.isInteger(oldEpoch));

  // The ghost chat's file is gone and only the index base is lost: the journal
  // that still lists the ghost must stay unreachable.
  fs.rmSync(path.join(profile.sessionsDir, 'chat_ghost.json'));
  fs.rmSync(indexPath(profile));
  const second = open(profile);
  assert.deepEqual(listedIds(second), ['chat_a', 'chat_b']);
  assert.ok(readRawIndex(profile).journal_epoch > oldEpoch, 'the rebuilt base has a higher epoch');

  seedChat(second, 'chat_c', { title: 'Charlie' });
  assert.deepEqual(listedIds(open(profile)), ['chat_a', 'chat_b', 'chat_c']);
  second.dispose();
  assert.deepEqual(listedIds(open(profile)), ['chat_a', 'chat_b', 'chat_c']);
});

test('a damaged index journal is logged and the index is rebuilt from the chat files', () => {
  const profile = makeProfile();
  const first = open(profile);
  seedChat(first, 'chat_base', { title: 'Base' });
  first.flush();
  const created = [];
  for (let index = 0; index < 8; index += 1) {
    created.push(seedChat(first, `chat_late_${index}`, { title: `Late ${index}`, count: 1 }));
  }
  const journals = indexJournals(profile);
  assert.equal(journals.length, 1);
  const target = path.join(profile.sessionsDir, journals[0]);
  const bytes = fs.readFileSync(target);
  bytes[Math.floor(bytes.length / 2)] ^= 0x01;
  fs.writeFileSync(target, bytes);

  const second = open(profile);
  const ids = listedIds(second);
  // The journal alone would list only a prefix of the late chats; none is hidden.
  assert.deepEqual(ids, ['chat_base', ...created].sort());
  for (const id of created) {
    assert.equal(second.getSessionSummary(id).title, first.getSessionSummary(id).title);
    assert.equal(second.getSession(id).messages.length, 1);
  }
  const damaged = second.logs.filter((entry) => entry.event === 'store.journal_corrupt');
  assert.ok(damaged.length >= 1);
  assert.equal(damaged[0].level, 'ERROR');

  // The store keeps working and the next reopen sees what it listed plus the new chat.
  seedChat(second, 'chat_after', { title: 'After' });
  assert.deepEqual(listedIds(open(profile)), [...ids, 'chat_after'].sort());
});

test('a torn index journal tail drops only the last record', () => {
  const profile = makeProfile();
  const first = open(profile);
  seedChat(first, 'chat_base');
  first.flush();
  for (let index = 0; index < 4; index += 1) seedChat(first, `chat_late_${index}`);
  const journal = path.join(profile.sessionsDir, indexJournals(profile)[0]);
  fs.truncateSync(journal, fs.statSync(journal).size - 5);

  const second = open(profile);
  assert.deepEqual(listedIds(second), ['chat_base', 'chat_late_0', 'chat_late_1', 'chat_late_2']);
  assert.equal(second.logs.some((entry) => entry.event === 'store.journal_corrupt'), false);
});

test('the shadow store has no index journal and keeps a whole index file', () => {
  const dir = createTrackedTempDir('jenny-session-index-shadow-');
  const shadow = trackCloseable(new SessionShadowStore(path.join(dir, 'session-shadow.json'), { writeDebounceMs: 60_000 }));
  for (let index = 0; index < 4; index += 1) {
    shadow.upsertSession(`shadow_${index}`, { title: `Shadow ${index}`, messages: [userMessage(`s${index}`)] });
    assert.equal(shadow.flushSession(`shadow_${index}`), true);
  }
  shadow.upsertSession('shadow_0', { title: 'Shadow renamed', messages: [userMessage('s0'), userMessage('s0b')] });
  assert.equal(shadow.flushSession('shadow_0'), true);
  shadow.flush();
  shadow.dispose();

  const sessionsDir = path.join(dir, 'session-shadow');
  assert.deepEqual(names(sessionsDir).filter((name) => name.endsWith('.journal')), []);
  const index = JSON.parse(fs.readFileSync(path.join(sessionsDir, '_index.json'), 'utf8'));
  assert.equal(Object.hasOwn(index, 'journal_epoch'), false);
  assert.deepEqual(Object.keys(index.sessions).sort(), ['shadow_0', 'shadow_1', 'shadow_2', 'shadow_3']);
});

test('after flushSession returns true a crash reopen lists the chat with the right message count', () => {
  const profile = makeProfile();
  const first = open(profile);
  seedChat(first, 'chat_a', { count: 1 });
  first.flush();

  assert.ok(first.createSessionWithId('chat_new', { title: 'New' }));
  for (let index = 0; index < 3; index += 1) assert.ok(first.appendMessage('chat_new', userMessage(`n${index}`)));
  assert.equal(first.flushSession('chat_new'), true);
  const crashed = open(profile);
  assert.deepEqual(listedIds(crashed), ['chat_a', 'chat_new']);
  assert.equal(crashed.getSessionSummary('chat_new').message_count, 3);

  assert.ok(first.appendMessage('chat_a', userMessage('a_more')));
  assert.equal(first.flushSession('chat_a'), true);
  assert.equal(open(profile).getSessionSummary('chat_a').message_count, 2);
});

test('the legacy prune removes only index journals that no read can reach', async () => {
  const profile = makeProfile();
  const first = open(profile);
  seedChat(first, 'chat_a');
  first.flush();
  seedChat(first, 'chat_b', { count: 1 });
  const [live] = indexJournals(profile);
  assert.ok(live, 'a reachable index journal exists');
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const age = (name) => fs.utimesSync(path.join(profile.sessionsDir, name), old, old);
  const stale = '_index.9.journal';
  fs.writeFileSync(path.join(profile.sessionsDir, stale), 'journal');
  age(stale);
  age(live);

  const run = () => pruneLegacySessionFiles({ legacyFilePath: profile.storePath, now: Date.now() });
  assert.deepEqual((await run()).deleted.map((entry) => entry.file), [stale]);
  assert.deepEqual(indexJournals(profile), [live]);

  // A base rewritten without an epoch (the kill switch) leaves its journal unreachable.
  const base = readRawIndex(profile);
  delete base.journal_epoch;
  fs.writeFileSync(indexPath(profile), JSON.stringify(base));
  assert.deepEqual((await run()).deleted.map((entry) => entry.file), [live]);
});
