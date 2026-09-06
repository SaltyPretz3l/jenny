// Regression tests for the 2026-07-02 chat-turn lifecycle triage bundle (F4):
// a persisted message silently reverted because the storage backend treated a
// SCHEDULED debounced disk write as durable. upsertSession(persist:true)
// cleared the dirty flag while the bytes were still in the FileJsonStore
// debounce buffer, _pruneCache could then evict the session from the loaded
// cache, and the next read re-loaded STALE disk state — losing the freshly
// appended user message and handing its event_seq slot to the next append
// (observed live: session sess_1783001098310_754cbc2d902d, streams
// stream_1783004143444_b19a2070 / stream_1783004237642_5482da77).
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { FileJsonStore } = require('../services/backend/file-json-store');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

// FileJsonStore's debounce timer is REFERENCED, not unref'd, and
// ElectronSessionStore wraps one. A store left holding a pending write keeps
// the runner alive for the whole writeDebounceMs and then writes into a
// directory this teardown has already removed. Measured on this file before
// the change: 5.7s wall for 0.5s of work -- one full 5000ms debounce interval.
const openStores = [];

function makeStore(...args) {
  const store = new FileJsonStore(...args);
  openStores.push(store);
  return store;
}

function makeSessionStore(...args) {
  const store = new ElectronSessionStore(...args);
  openStores.push(store);
  return store;
}

test.afterEach(async () => {
  // Dispose BEFORE the directories go: dispose() flushes, and a flush into a
  // removed directory would fail. Some tests deliberately leave a store whose
  // write must stay pending, so a throw here must not mask the test's result.
  while (openStores.length) {
    try {
      openStores.pop().dispose();
    } catch (error) {
      void error;
    }
  }
  await cleanupTrackedResources();
});

function makeTempRoot(prefix) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackDirectory(rootDir);
  return rootDir;
}

test('FileJsonStore readWithStatus returns the pending debounced value (read-your-writes)', async () => {
  const rootDir = makeTempRoot('jenny-fjs-pending-');
  const filePath = path.join(rootDir, 'store.json');
  const store = makeStore(filePath, { writeDebounceMs: 5000 });

  store.write({ generation: 1 });
  await store.flushAsync();

  // Debounced write pending: a read must observe the NEW value, not stale disk.
  store.write({ generation: 2 });
  assert.equal(store.hasPendingWrite(), true);
  const pendingRead = store.readWithStatus(null);
  assert.equal(pendingRead.missing, false);
  assert.equal(pendingRead.corrupted, false);
  assert.deepEqual(pendingRead.value, { generation: 2 });
  // The served value must be mutation-isolated from the pending buffer.
  pendingRead.value.generation = 999;
  assert.deepEqual(store.readWithStatus(null).value, { generation: 2 });

  await store.flushAsync();
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { generation: 2 });
  assert.deepEqual(store.readWithStatus(null).value, { generation: 2 });
});

test('FileJsonStore readWithStatus returns the in-flight async write value', async () => {
  const rootDir = makeTempRoot('jenny-fjs-inflight-');
  const filePath = path.join(rootDir, 'store.json');
  const store = makeStore(filePath, { writeDebounceMs: 1 });

  store.write({ generation: 1 });
  // Wait for the debounce timer to hand the value to the async write chain,
  // polling hasPendingWrite() through both the pending and in-flight phases.
  const flushed = store.flushAsync();
  assert.deepEqual(store.readWithStatus(null).value, { generation: 1 });
  await flushed;
  assert.deepEqual(store.readWithStatus(null).value, { generation: 1 });
});

test('FileJsonStore delete() clears any pending value from reads', () => {
  const rootDir = makeTempRoot('jenny-fjs-delete-');
  const filePath = path.join(rootDir, 'store.json');
  const store = makeStore(filePath, { writeDebounceMs: 5000 });

  store.write({ generation: 1 });
  store.delete();
  const read = store.readWithStatus(null);
  assert.equal(read.missing, true);
  assert.equal(read.value, null);
});

test('session store append survives an LRU mass-load burst while its disk write is debounced', () => {
  // Full-fidelity incident repro: user append -> 40-session load burst ->
  // assistant append -> flush. Before the fix the user message vanished and
  // the assistant stole its event_seq slot.
  const rootDir = makeTempRoot('jenny-store-evict-');
  const seedStore = makeSessionStore(path.join(rootDir, 'sessions.json'), {});
  seedStore.createSessionWithId('sess_A', { title: 'A' });
  for (let i = 0; i < 4; i += 1) {
    seedStore.appendMessage('sess_A', {
      id: `old_${i}`,
      role: i % 2 ? 'assistant' : 'user',
      content: `old ${i}`,
    });
  }
  for (let i = 0; i < 40; i += 1) {
    seedStore.createSessionWithId(`sess_S${i}`, { title: `S${i}` });
  }
  seedStore.flush();

  // Fresh instance over the same directory, with production-style debouncing.
  const store = makeSessionStore(path.join(rootDir, 'sessions.json'), {
    writeDebounceMs: 5000,
  });
  const appended = store.appendMessage('sess_A', {
    id: 'user_stream_X',
    role: 'user',
    content: 'THE USER PROMPT',
    client_message_id: 'user_stream_X',
    attachments: [],
  });
  assert.ok(appended, 'user append must commit');

  // Mass-load burst (attachment sweep / companion getState shape): more than
  // the 30-entry loaded-session cache while sess_A\'s write is still pending.
  for (let i = 0; i < 40; i += 1) {
    store.getSessionMessages(`sess_S${i}`);
  }

  const midMessages = store.getSessionMessages('sess_A');
  assert.equal(
    midMessages.some((message) => message.id === 'user_stream_X'),
    true,
    'user message must survive the cache burst while its disk write is pending'
  );

  store.appendMessage('sess_A', {
    id: 'assistant_stream_X',
    role: 'assistant',
    content: 'the reply',
    client_message_id: 'assistant_stream_X',
  });
  store.flush();

  // Disk truth via a third instance: both messages present, seqs monotonic.
  const verifyStore = makeSessionStore(path.join(rootDir, 'sessions.json'), {});
  const diskMessages = verifyStore.getSessionMessages('sess_A');
  const userMessage = diskMessages.find((message) => message.id === 'user_stream_X');
  const assistantMessage = diskMessages.find((message) => message.id === 'assistant_stream_X');
  assert.ok(userMessage, 'user message must be on disk after flush');
  assert.ok(assistantMessage, 'assistant message must be on disk after flush');
  assert.equal(userMessage.event_seq, 4);
  assert.equal(assistantMessage.event_seq, 5);
});

test('LRU pruning still evicts clean sessions once their writes have flushed', () => {
  const rootDir = makeTempRoot('jenny-store-prune-');
  const store = makeSessionStore(path.join(rootDir, 'sessions.json'), {
    writeDebounceMs: 0,
  });
  for (let i = 1; i <= 35; i += 1) {
    store.createSessionWithId(`sess_${i}`, { title: `Session ${i}` });
  }
  store.flush();
  assert.ok(
    store._backend._loadedSessions.size <= 30,
    `loaded-session cache stays capped (${store._backend._loadedSessions.size})`
  );
});

test('SessionStorageDurability._records stays bounded across a lifetime of distinct session loads', () => {
  // Regression for the durability-map leak: markLoaded() (getSession, called
  // from getSessionMessages below) adds one _records entry per distinct
  // session id, but forget() used to be reachable only from hard session
  // deletion — never from _pruneCache's LRU eviction. Loading far more
  // distinct, settled (non-pending) sessions than the 30-slot cache must NOT
  // grow _records past the cache bound.
  const rootDir = makeTempRoot('jenny-store-durability-bound-');
  const store = makeSessionStore(path.join(rootDir, 'sessions.json'), {
    writeDebounceMs: 0,
  });
  const total = 120;
  for (let i = 0; i < total; i += 1) {
    store.createSessionWithId(`sess_D${i}`, { title: `D${i}` });
  }
  store.flush();
  // Re-touch every session (cache-neutral commits already flushed: settled).
  for (let i = 0; i < total; i += 1) {
    store.getSessionMessages(`sess_D${i}`);
  }
  const recordCount = store._backend._durability._records.size;
  assert.ok(
    recordCount <= 30,
    `durability record count must stay bounded to the LRU cap, got ${recordCount} after ${total} distinct loads`
  );
});

test('a session with a pending debounced write keeps its durability record through an LRU eviction pass', () => {
  // The other half of the eviction contract: _pruneCache only forgets a
  // durability record once hasPendingWriteForSession() is false. A session
  // whose disk write is still debounced (or whose dirtyEpoch has outrun its
  // durableEpoch) must survive both the loaded-session eviction AND the
  // durability-record forget, or the pending signal is lost silently.
  const rootDir = makeTempRoot('jenny-store-durability-pending-');
  const seedStore = makeSessionStore(path.join(rootDir, 'sessions.json'), {});
  seedStore.createSessionWithId('sess_A', { title: 'A' });
  for (let i = 0; i < 40; i += 1) {
    seedStore.createSessionWithId(`sess_S${i}`, { title: `S${i}` });
  }
  seedStore.flush();

  // Fresh instance, production-style debouncing: sess_A gets one more
  // mutation whose disk write stays pending through the whole burst below.
  const store = makeSessionStore(path.join(rootDir, 'sessions.json'), {
    writeDebounceMs: 5000,
  });
  store.appendMessage('sess_A', {
    id: 'msg_1',
    role: 'user',
    content: 'pending durability content',
    client_message_id: 'msg_1',
    attachments: [],
  });
  assert.equal(
    store._backend.hasPendingWriteForSession('sess_A'),
    true,
    'sess_A must have a pending write before the eviction burst'
  );

  // Cache-neutral reads of the 40 already-flushed sibling sessions: each is
  // settled immediately (no markAccepted call), so this burst both evicts
  // them from the loaded-session LRU and forgets their durability records —
  // while sess_A, still pending, must survive both.
  for (let i = 0; i < 40; i += 1) {
    store.getSessionMessages(`sess_S${i}`);
  }

  assert.ok(
    store._backend._durability._records.has('sess_A'),
    'durability record for the pending session must survive _pruneCache eviction'
  );
  assert.ok(
    store._backend._loadedSessions.has('sess_A'),
    'loaded cache entry for the pending session must survive _pruneCache eviction'
  );
  assert.ok(
    store._backend._loadedSessions.size <= 30,
    `sibling sessions were evicted back under the cache cap (${store._backend._loadedSessions.size})`
  );
});
