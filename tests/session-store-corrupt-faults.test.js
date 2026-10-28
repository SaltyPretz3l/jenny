'use strict';

// Fault injection for the chat (session) store, damaged records, round trips and EPERM (S6-S13,
// S15, S18 of docs/plans/PERSISTENCE_FAULTS_2026-10-26.md). Crash and migration rows live in
// session-store-faults.test.js. Fixtures come from the store API; only the damage is written
// by hand.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { STORE_SCHEMA_VERSION } = require('../services/backend/electron-session-store');
const { cleanupTrackedResources } = require('./helpers/resource-cleanup');
const {
  newProfile,
  createLogCollector,
  openStore,
  chatContent,
  seedChats,
  listFiles,
  readTree,
  assertTreesIdentical,
  isTemp,
  restampSchema,
  rewriteJson,
  messageIds,
  assertAllChatsListed,
} = require('./helpers/session-store-fault-fixtures');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// ---------------------------------------------------------------------------
// S6, S7, S8: the index file
// ---------------------------------------------------------------------------

function assertIndexRebuilt(profile, expected, damagedBytes, logs) {
  const store = openStore(profile, { logger: logs.logger });
  try {
    assertAllChatsListed(store, expected);
  } finally {
    store.dispose();
  }
  const rebuilt = JSON.parse(fs.readFileSync(profile.indexPath, 'utf8'));
  assert.deepEqual(Object.keys(rebuilt.sessions).sort(), Object.keys(expected).sort(), 'the rebuilt index lists every chat');
  const preserved = fs.readdirSync(profile.sessionsDir).filter((name) => /^_index\.json\.corrupt-\d{10,16}$/.test(name));
  assert.equal(preserved.length, 1, 'the damaged index moves to _index.json.corrupt-<ms>');
  assert.ok(fs.readFileSync(path.join(profile.sessionsDir, preserved[0])).equals(damagedBytes), 'with its bytes intact');
  assert.equal(logs.events('store.corrupt_file_preserved').length, 1);
}

test('S6: a truncated _index.json is rebuilt from the chat files and its bytes are kept', () => {
  const profile = newProfile();
  const expected = seedChats(profile, ['sess_idx_a', 'sess_idx_b', 'sess_idx_c']);
  const whole = fs.readFileSync(profile.indexPath);
  const damaged = whole.subarray(0, Math.floor(whole.length / 2));
  fs.writeFileSync(profile.indexPath, damaged);
  const logs = createLogCollector();

  assertIndexRebuilt(profile, expected, damaged, logs);
  assert.equal(logs.events('session_store.split_index_recovered').length, 1);
});

for (const [label, content] of [
  ['an array', '[1,2,3]'],
  ['an object without sessions', '{"schema_version":26}'],
  ['an object whose sessions is an array', '{"schema_version":26,"sessions":[]}'],
]) {
  test(`S7: an _index.json that is ${label} is rebuilt from the chat files and its bytes are kept`, () => {
    const profile = newProfile();
    const expected = seedChats(profile, ['sess_idx_a', 'sess_idx_b', 'sess_idx_c']);
    const damaged = Buffer.from(content);
    fs.writeFileSync(profile.indexPath, damaged);
    const logs = createLogCollector();

    assertIndexRebuilt(profile, expected, damaged, logs);
    assert.equal(logs.events('session_store.split_index_recovered').length, 1);
  });
}

test('S8: an _index.json from a future schema freezes the store and every file stays byte-identical', () => {
  const profile = newProfile();
  const ids = ['sess_fut_a', 'sess_fut_b'];
  seedChats(profile, ids);
  restampSchema(profile.indexPath, STORE_SCHEMA_VERSION + 74);
  const before = readTree(profile.dir);
  const logs = createLogCollector();

  const store = openStore(profile, { logger: logs.logger });
  try {
    assert.equal(store.hasNewerSchema(), true);
    assert.equal(logs.events('session_store.newer_schema_detected').length, 1);
    assert.equal(store.createSessionWithId('sess_fut_new', { title: 'new' }), null);
    assert.equal(store.appendMessage(ids[0], { id: 'late', role: 'user', content: 'late' }), null);
    assert.notEqual(store.deleteSession(ids[1]), true);
    assert.notEqual(store.flushSession(ids[0]), true);
    store.flush();
  } finally {
    store.dispose();
  }
  assertTreesIdentical(before, readTree(profile.dir), 'future-schema index');
});

// ---------------------------------------------------------------------------
// S9, S10, S11, S12, S13: chat files
// ---------------------------------------------------------------------------

function quarantineFiles(profile) {
  const dir = path.join(profile.sessionsDir, 'corrupt');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')) : [];
}

test('S9: a truncated chat among good ones is quarantined with its bytes while the others are untouched', () => {
  const profile = newProfile();
  const ids = ['sess_c_a', 'sess_c_b', 'sess_c_c'];
  const expected = seedChats(profile, ids);
  const whole = fs.readFileSync(profile.chatPath(ids[1]));
  const damaged = whole.subarray(0, Math.floor(whole.length / 2));
  fs.writeFileSync(profile.chatPath(ids[1]), damaged);
  const neighbours = [ids[0], ids[2]].map((id) => [id, fs.readFileSync(profile.chatPath(id))]);
  const logs = createLogCollector();

  const store = openStore(profile, { logger: logs.logger });
  try {
    for (const [id] of neighbours) assert.deepEqual(chatContent(store.getSession(id)), expected[id], id);
    const stub = store.getSession(ids[1]);
    assert.equal(stub.title, expected[ids[1]].title, 'title survives from the index summary');
    assert.deepEqual(stub.messages, []);
    store.getSession(ids[1]);
  } finally {
    store.dispose();
  }

  const quarantined = quarantineFiles(profile);
  assert.equal(quarantined.length, 1);
  assert.match(quarantined[0], new RegExp(`^${ids[1]}\\.\\d{10,16}\\.json$`));
  assert.ok(fs.readFileSync(path.join(profile.sessionsDir, 'corrupt', quarantined[0])).equals(damaged));
  for (const [id, bytes] of neighbours) assert.ok(fs.readFileSync(profile.chatPath(id)).equals(bytes), `${id} bytes`);
  const errors = logs.events('session_store.session_file_quarantined');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].level, 'ERROR');
  assert.equal(errors[0].details.sessionId, ids[1]);
});

test('S10a: a byte flipped inside a message string still parses and loads as written (undetectable by design)', () => {
  const profile = newProfile();
  const ids = ['sess_f_a', 'sess_f_b'];
  const expected = seedChats(profile, ids);
  const bytes = fs.readFileSync(profile.chatPath(ids[0]));
  const needle = Buffer.from(`${ids[0]} content 2`);
  const at = bytes.indexOf(needle);
  assert.ok(at > 0);
  const flipped = Buffer.from(bytes);
  flipped[at] ^= 0x01;
  fs.writeFileSync(profile.chatPath(ids[0]), flipped);
  const logs = createLogCollector();

  const store = openStore(profile, { logger: logs.logger });
  try {
    const loaded = chatContent(store.getSession(ids[0]));
    assert.equal(loaded.messages.length, expected[ids[0]].messages.length);
    assert.notEqual(loaded.messages[1].content, expected[ids[0]].messages[1].content);
    assert.deepEqual(chatContent(store.getSession(ids[1])), expected[ids[1]]);
  } finally {
    store.dispose();
  }
  assert.deepEqual(quarantineFiles(profile), []);
  assert.equal(logs.events('session_store.session_file_quarantined').length, 0);
  assert.ok(fs.readFileSync(profile.chatPath(ids[0])).equals(flipped), 'the flipped file is not rewritten by a read');
});

test('S10b: a structural byte flipped in a chat file is quarantined like a truncation', () => {
  const profile = newProfile();
  const ids = ['sess_f_a', 'sess_f_b'];
  const expected = seedChats(profile, ids);
  const flipped = Buffer.from(fs.readFileSync(profile.chatPath(ids[0])));
  const colon = flipped.indexOf(Buffer.from(':'));
  assert.ok(colon > 0);
  flipped[colon] = 0x3b; // ':' -> ';'
  assert.throws(() => JSON.parse(flipped.toString('utf8')));
  fs.writeFileSync(profile.chatPath(ids[0]), flipped);
  const logs = createLogCollector();

  const store = openStore(profile, { logger: logs.logger });
  try {
    assert.deepEqual(store.getSession(ids[0]).messages, []);
    assert.deepEqual(chatContent(store.getSession(ids[1])), expected[ids[1]]);
  } finally {
    store.dispose();
  }
  const quarantined = quarantineFiles(profile);
  assert.equal(quarantined.length, 1);
  assert.match(quarantined[0], new RegExp(`^${ids[0]}\\.\\d{10,16}\\.json$`));
  assert.ok(fs.readFileSync(path.join(profile.sessionsDir, 'corrupt', quarantined[0])).equals(flipped));
  assert.equal(logs.events('session_store.session_file_quarantined').length, 1);
});

for (const [label, content] of [
  ['an array', '[1,2,3]'],
  ['an object whose session is a string', '{"schema_version":26,"session":"x"}'],
  ['an object whose session is null', '{"schema_version":26,"session":null}'],
]) {
  test(`S11: a chat file that is valid JSON but ${label} is not written over as a blank chat`, () => {
    const profile = newProfile();
    const ids = ['sess_w_a', 'sess_w_b'];
    seedChats(profile, ids);
    const damaged = Buffer.from(content);
    fs.writeFileSync(profile.chatPath(ids[0]), damaged);

    const logs = createLogCollector();
    const store = openStore(profile, { logger: logs.logger });
    try {
      const served = store.getSession(ids[0]);
      assert.equal(served.title, `Title ${ids[0]}`, 'the re-seeded chat keeps its title from the index');
      assert.equal(served.messages.length, 0);
      assert.equal(logs.events('session_store.session_file_quarantined').length, 1);
      // A later write on that id must not destroy the bytes.
      store.appendMessage(ids[0], { id: 'after', role: 'user', content: 'after the damage' });
      store.flushSession(ids[0]);
      store.flush();
    } finally {
      store.dispose();
    }
    const quarantined = fs.readdirSync(path.join(profile.sessionsDir, 'corrupt'))
      .filter((name) => new RegExp(`^${ids[0]}\\.\\d{10,16}\\.json$`).test(name));
    assert.equal(quarantined.length, 1, 'quarantined to corrupt/<stem>.<ms>.json');
    assert.ok(fs.readFileSync(path.join(profile.sessionsDir, 'corrupt', quarantined[0])).equals(damaged));
  });
}

test('S11b: an index rebuild skips a chat file whose session is null and leaves its bytes', () => {
  const profile = newProfile();
  const ids = ['sess_w_a', 'sess_w_b'];
  const expected = seedChats(profile, ids);
  const damaged = Buffer.from('{"schema_version":26,"session":null}');
  fs.writeFileSync(profile.chatPath(ids[0]), damaged);
  fs.rmSync(profile.indexPath);

  const store = openStore(profile);
  try {
    assert.deepEqual(store.listSessions().map((summary) => summary.id), [ids[1]]);
    assert.deepEqual(chatContent(store.getSession(ids[1])), expected[ids[1]]);
    store.appendMessage(ids[0], { id: 'after', role: 'user', content: 'after the damage' });
    store.flush();
  } finally {
    store.dispose();
  }
  assert.ok(fs.readFileSync(profile.chatPath(ids[0])).equals(damaged), 'left in place, never written over');
});

test('S11c: a split-layout migration never rewrites a chat file whose session is null', async () => {
  const profile = newProfile();
  const ids = ['sess_w_a', 'sess_w_b'];
  const expected = seedChats(profile, ids);
  for (const id of ids) restampSchema(profile.chatPath(id), STORE_SCHEMA_VERSION - 1);
  restampSchema(profile.indexPath, STORE_SCHEMA_VERSION - 1);
  const damaged = Buffer.from(`{"schema_version":${STORE_SCHEMA_VERSION - 1},"session":null}`);
  fs.writeFileSync(profile.chatPath(ids[0]), damaged);

  const store = openStore(profile);
  try {
    assert.equal(store.hasPendingMigrations(), true);
    await store.runPendingMigrations();
    assert.deepEqual(chatContent(store.getSession(ids[1])), expected[ids[1]]);
    store.getSession(ids[0]);
    store.flush();
  } finally {
    store.dispose();
  }
  const inPlace = fs.existsSync(profile.chatPath(ids[0])) && fs.readFileSync(profile.chatPath(ids[0])).equals(damaged);
  const quarantined = fs.existsSync(path.join(profile.sessionsDir, 'corrupt'))
    && fs.readdirSync(path.join(profile.sessionsDir, 'corrupt'))
      .some((name) => fs.readFileSync(path.join(profile.sessionsDir, 'corrupt', name)).equals(damaged));
  assert.ok(inPlace || quarantined, 'the damaged bytes survive the migration');
});

test('S12: a bare chat record with no schema_version envelope loads with its messages', () => {
  const profile = newProfile();
  const ids = ['sess_b_a', 'sess_b_b'];
  const expected = seedChats(profile, ids);
  const envelope = JSON.parse(fs.readFileSync(profile.chatPath(ids[0]), 'utf8'));
  fs.writeFileSync(profile.chatPath(ids[0]), JSON.stringify(envelope.session));

  const store = openStore(profile);
  try {
    assertAllChatsListed(store, expected);
  } finally {
    store.dispose();
  }
  assert.deepEqual(quarantineFiles(profile), []);

  // The same bare file also survives an index rebuild.
  fs.rmSync(profile.indexPath);
  const rebuilt = openStore(profile);
  try {
    assertAllChatsListed(rebuilt, expected);
  } finally {
    rebuilt.dispose();
  }
});

function seedNegativeCounters() {
  const profile = newProfile();
  const id = 'sess_n_a';
  const expected = seedChats(profile, [id]);
  rewriteJson(profile.chatPath(id), (value) => {
    value.session.message_seq_counter = -5;
    value.session.message_count = -1;
    value.session.turn_event_seq_counter = -2;
  });
  rewriteJson(profile.indexPath, (value) => {
    value.sessions[id].message_count = -1;
  });
  return { profile, id, expected };
}

test('S13a: negative counters on disk are normalised on read and the messages are kept', () => {
  const { profile, id, expected } = seedNegativeCounters();
  const store = openStore(profile);
  try {
    const loaded = store.getSession(id);
    assert.deepEqual(chatContent(loaded), expected[id]);
    assert.ok(loaded.message_count >= 0, `message_count ${loaded.message_count}`);
    assert.ok(loaded.turn_event_seq_counter >= 0, `turn_event_seq_counter ${loaded.turn_event_seq_counter}`);
    // message_seq_counter is read as stored: every consumer takes max(counter,
    // messages.length) (appendMessage, planInsertBefore), so a negative value
    // cannot misorder a row. The index summary is listed as stored and is
    // recomputed by the chat's next write. S13b pins both.
  } finally {
    store.dispose();
  }
});

test('S13b: after negative counters the next append sorts above every existing message and persists', () => {
  const { profile, id } = seedNegativeCounters();
  const store = openStore(profile);
  try {
    const highest = Math.max(...store.getSession(id).messages.map((message) => message.event_seq));
    assert.ok(store.appendMessage(id, { id: 'sess_n_a_next', role: 'user', content: 'next' }));
    const after = store.getSession(id);
    const appended = after.messages[after.messages.length - 1];
    assert.equal(appended.id, 'sess_n_a_next');
    assert.ok(appended.event_seq > highest, `event_seq ${appended.event_seq} must exceed ${highest}`);
    assert.equal(after.message_count, after.messages.length);
    assert.equal(store.listSessions()[0].message_count, after.messages.length);
    assert.equal(store.flushSession(id), true);
  } finally {
    store.dispose();
  }
  const reopened = openStore(profile);
  try {
    assert.equal(reopened.getSession(id).messages.length, 4);
  } finally {
    reopened.dispose();
  }
});

// ---------------------------------------------------------------------------
// S15: current-schema round trip changes nothing on disk
// ---------------------------------------------------------------------------

function readEverything(store) {
  for (const summary of store.listSessions()) assert.ok(store.getSession(summary.id), `read ${summary.id}`);
}

test('S15a: reopening a journaled profile with the journal on changes no byte and adds no file', () => {
  const profile = newProfile();
  seedChats(profile, ['sess_j_a', 'sess_j_b'], { journal: true });
  const before = readTree(profile.dir);
  assert.ok([...before.keys()].some((rel) => rel.endsWith('.journal')), 'the fixture has journals');

  const store = openStore(profile, { sessionJournal: true });
  readEverything(store);
  store.dispose();
  assertTreesIdentical(before, readTree(profile.dir), 'journal-on reopen');
});

for (const journal of [false, true]) {
  test(`S15b: reopening a mixed journaled and plain profile with the journal ${journal ? 'on' : 'off'} changes no byte`, () => {
    const profile = newProfile();
    seedChats(profile, ['sess_j_a', 'sess_j_b'], { journal: true });
    seedChats(profile, ['sess_p_a', 'sess_p_b'], { journal: false });
    const before = readTree(profile.dir);

    const store = openStore(profile, { sessionJournal: journal });
    readEverything(store);
    store.dispose();
    assertTreesIdentical(before, readTree(profile.dir), `mixed profile, journal ${journal}`);
  });
}

// ---------------------------------------------------------------------------
// S18: EPERM from renameSync on a chat write
// ---------------------------------------------------------------------------

function failChatRenames(t, fileName) {
  const state = { failures: 0, active: true };
  const realRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', function renameSyncMaybeFailing(from, to, ...rest) {
    if (state.active && path.basename(String(to)) === fileName) {
      state.failures += 1;
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return realRename.call(fs, from, to, ...rest);
  });
  return state;
}

test('S18a: an EPERM on the chat rename refuses the append, keeps the old file and the retry persists', (t) => {
  const profile = newProfile();
  const logs = createLogCollector();
  const store = openStore(profile, { logger: logs.logger });
  t.after(() => store.dispose());
  store.createSessionWithId('sess_e_a', { title: 'E' });
  assert.ok(store.appendMessage('sess_e_a', { id: 'm1', role: 'user', content: 'one' }));
  assert.equal(store.flushSession('sess_e_a'), true);
  const previous = fs.readFileSync(profile.chatPath('sess_e_a'));
  const filesBefore = listFiles(profile.sessionsDir);

  const state = failChatRenames(t, 'sess_e_a.json');
  const refused = store.appendMessage('sess_e_a', { id: 'm2', role: 'user', content: 'two' });
  state.active = false;

  assert.equal(refused, null, 'the append reports failure');
  assert.ok(state.failures >= 1);
  assert.ok(logs.events('session_store.write_failed').some((entry) => entry.details.errorCode === 'EPERM'));
  assert.ok(fs.readFileSync(profile.chatPath('sess_e_a')).equals(previous), 'the previous chat file is byte-identical');
  assert.deepEqual(listFiles(profile.sessionsDir).filter(isTemp), [], 'no temp left from the failed write');
  assert.deepEqual(listFiles(profile.sessionsDir), filesBefore);
  assert.deepEqual(messageIds(store.getSession('sess_e_a')), ['m1'], 'the refused message is not served from memory');

  assert.ok(store.appendMessage('sess_e_a', { id: 'm2', role: 'user', content: 'two' }));
  assert.equal(store.flushSession('sess_e_a'), true);
  const reopened = openStore(profile);
  try {
    assert.deepEqual(messageIds(reopened.getSession('sess_e_a')), ['m1', 'm2']);
  } finally {
    reopened.dispose();
  }
});

test('S18b: an EPERM on a debounced chat flush leaves the chat dirty and the next flush persists it', (t) => {
  const profile = newProfile();
  const logs = createLogCollector();
  // A debounce window far longer than the test keeps the accepted append pending in memory.
  const store = openStore(profile, { logger: logs.logger, writeDebounceMs: 600000 });
  t.after(() => store.dispose());
  store.createSessionWithId('sess_e_b', { title: 'E' });
  assert.ok(store.appendMessage('sess_e_b', { id: 'm1', role: 'user', content: 'one' }));
  assert.equal(store.flushSession('sess_e_b'), true);
  const previous = fs.readFileSync(profile.chatPath('sess_e_b'));

  assert.ok(store.appendMessage('sess_e_b', { id: 'm2', role: 'user', content: 'two' }));
  assert.equal(store.hasPendingWrites(), true);
  const state = failChatRenames(t, 'sess_e_b.json');
  const flushed = store.flushSession('sess_e_b');
  state.active = false;

  assert.notEqual(flushed, true, 'the flush reports failure');
  assert.ok(state.failures >= 1);
  assert.ok(logs.events('session_store.flush_session_failed').some((entry) => entry.details.errorCode === 'EPERM'));
  assert.ok(fs.readFileSync(profile.chatPath('sess_e_b')).equals(previous), 'the previous chat file is byte-identical');
  assert.deepEqual(listFiles(profile.sessionsDir).filter(isTemp), [], 'no temp left from the failed write');
  assert.equal(store.hasPendingWrites(), true, 'the chat stays dirty');
  assert.deepEqual(messageIds(store.getSession('sess_e_b')), ['m1', 'm2']);

  assert.equal(store.flushSession('sess_e_b'), true);
  const reopened = openStore(profile);
  try {
    assert.deepEqual(messageIds(reopened.getSession('sess_e_b')), ['m1', 'm2']);
  } finally {
    reopened.dispose();
  }
});
