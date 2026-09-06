// Regression tests for the periodic-scan cache-churn fix (2026-07-02 follow-up
// to the lifecycle-triage F4 pending-write guard): the attachment-asset sweep,
// companion Home state, and managed-sidecar reconciliation all walked every
// session through the backend's 30-slot LRU (getSession per id), evicting the
// hot active session and re-parsing the whole store (~66MB on a 149-session
// profile) on every pass. Scans now go through cache-neutral peekSession and
// the summary-driven listSessionRecords + active-turn scan registry.
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const {
  collectReferencedAttachmentAssetPaths,
} = require('../services/main/startup-retention-tasks');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function makeStore(prefix, options = {}) {
  const userDataPath = createTrackedTempDir(prefix);
  const storePath = path.join(userDataPath, 'sessions.json');
  const store = new ElectronSessionStore(storePath, options);
  return { store, userDataPath, storePath };
}

function imageAttachment(name) {
  return {
    id: `att_${name}`,
    kind: 'image',
    displayName: `${name}.png`,
    assetPath: path.join('C:', 'assets', `${name}.png`),
  };
}

test('peekSession reads uncached sessions without inserting into the LRU', () => {
  const { store } = makeStore('jenny-scan-peek-');
  store.createSessionWithId('sess_peek', { title: 'Peek Target' });
  store.appendMessage('sess_peek', { id: 'm1', role: 'user', content: 'hello' });
  store.flush();
  store._backend._loadedSessions.clear();
  store._backend._sessionLru.clear();

  const peeked = store.peekSession('sess_peek');
  assert.equal(peeked.title, 'Peek Target');
  assert.equal(peeked.messages.length, 1);
  assert.equal(
    store._backend._loadedSessions.has('sess_peek'),
    false,
    'peekSession must not populate the loaded-session cache'
  );

  // Cached sessions are served from the cache (authoritative for pending writes).
  const viaGet = store._backend.getSession('sess_peek');
  assert.equal(store._backend.peekSession('sess_peek'), viaGet);
  assert.equal(store.peekSession('sess_missing'), null);
});

test('peekSession observes a pending debounced write, not stale disk bytes', () => {
  const { store, storePath } = makeStore('jenny-scan-peek-pending-');
  store.createSessionWithId('sess_p', { title: 'Pending' });
  store.flush();

  const debounced = new ElectronSessionStore(storePath, { writeDebounceMs: 5000 });
  debounced.appendMessage('sess_p', { id: 'fresh', role: 'user', content: 'unflushed' });
  const peeked = debounced.peekSession('sess_p');
  assert.equal(
    peeked.messages.some((message) => message.id === 'fresh'),
    true,
    'peek must see the committed-but-unflushed message'
  );
  debounced.flush();
});

test('listSessionRecords exposes active turns without loading session bodies', () => {
  const { store, storePath } = makeStore('jenny-scan-records-');
  store.createSessionWithId('sess_idle', { title: 'Idle' });
  store.createSessionWithId('sess_live', { title: 'Live' });
  store.setActiveTurn('sess_live', {
    request_id: 'req_1',
    stream_id: 'stream_1',
    user_message_id: 'user_1',
    started_at: '2026-07-02T10:00:00.000Z',
    last_event_at: '2026-07-02T10:00:01.000Z',
    status: 'streaming',
  });
  store.flush();

  // Same-instance view: registry is maintained by the writes themselves.
  const liveRecord = store.listSessionRecords().find((record) => record.id === 'sess_live');
  assert.equal(liveRecord.active_turn.request_id, 'req_1');
  assert.equal(
    store.listSessionRecords().find((record) => record.id === 'sess_idle').active_turn,
    null
  );

  // Cross-instance view: a fresh store (crash-restart shape) must seed the
  // registry from disk — reconciliation depends on finding orphaned turns —
  // and the seed itself must stay out of the loaded-session cache.
  const reloaded = new ElectronSessionStore(storePath);
  const records = reloaded.listSessionRecords();
  assert.equal(records.find((record) => record.id === 'sess_live').active_turn.request_id, 'req_1');
  assert.equal(records.find((record) => record.id === 'sess_idle').active_turn, null);
  assert.equal(
    reloaded._backend._loadedSessions.size,
    0,
    'active-turn seed must not populate the loaded-session cache'
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(records.find((record) => record.id === 'sess_live'), 'messages'),
    false
  );

  // clearActiveTurn and deleteSession both retire registry entries.
  reloaded.clearActiveTurn('sess_live', { request_id: 'req_1', stream_id: 'stream_1' });
  assert.equal(
    reloaded.listSessionRecords().find((record) => record.id === 'sess_live').active_turn,
    null
  );
  reloaded.deleteSession('sess_idle');
  assert.equal(reloaded.listSessionRecords().some((record) => record.id === 'sess_idle'), false);
});

test('bulk scans no longer evict the hot session from the backend cache', () => {
  const { store, storePath } = makeStore('jenny-scan-churn-');
  for (let i = 0; i < 40; i += 1) {
    store.createSessionWithId(`sess_S${i}`, { title: `S${i}` });
    store.appendMessage(`sess_S${i}`, {
      id: `m_${i}`,
      role: 'user',
      content: `hi ${i}`,
      attachments: i % 2 ? [imageAttachment(`s${i}`)] : [],
    });
  }
  store.flush();

  const runtime = new ElectronSessionStore(storePath, { writeDebounceMs: 5000 });
  runtime.appendMessage('sess_S0', { id: 'hot_msg', role: 'user', content: 'hot' });
  assert.equal(runtime._backend._loadedSessions.has('sess_S0'), true);
  const cachedSizeBefore = runtime._backend._loadedSessions.size;

  // All three periodic scan shapes, back to back.
  runtime.listSessionRecords();
  const referenced = collectReferencedAttachmentAssetPaths(runtime, { cache: new Map() });
  runtime.listSessionRecords();

  assert.equal(
    runtime._backend._loadedSessions.has('sess_S0'),
    true,
    'hot session must survive periodic scans'
  );
  assert.equal(
    runtime._backend._loadedSessions.size,
    cachedSizeBefore,
    'scans must not grow or churn the loaded-session cache'
  );
  // The sweep still sees every referenced asset, including via peek reads.
  const expected = [];
  for (let i = 0; i < 40; i += 1) {
    if (i % 2) expected.push(path.join('C:', 'assets', `s${i}.png`));
  }
  assert.deepEqual([...referenced].sort(), expected.sort());
  runtime.flush();
});

test('corrupt session files are still quarantined when hit through peekSession', () => {
  const { store } = makeStore('jenny-scan-corrupt-');
  store.createSessionWithId('sess_bad', { title: 'Corrupt' });
  store.flush();
  store._backend._loadedSessions.clear();
  const filePath = store._backend._sessionFilePath('sess_bad');
  fs.writeFileSync(filePath, '{not json');

  const recovered = store.peekSession('sess_bad');
  assert.ok(recovered, 'peek must return the recovered stub');
  assert.equal(recovered.messages.length, 0);
  assert.equal(
    fs.readdirSync(path.dirname(filePath)).some((name) => name === 'corrupt'),
    true,
    'unreadable bytes must be quarantined'
  );
});

// --- peekSessionMessages (perf finding #5) -------------------------------
// The per-tool-call tool_use/tool_result id lookups fetched messages through
// getSessionMessages -> getSession, which re-normalizes every message and
// normalizes + sorts the entire turn_events log just to scan for one id.
// peekSessionMessages serves the already-canonical backend record instead.
// These pin the two properties that make the by-reference sharing safe.

function seedLookupSession(store, sessionId) {
  store.createSessionWithId(sessionId, { title: 'Lookup' });
  store.updateSession(sessionId, {
    messages: [
      { id: 'm_user', role: 'user', kind: 'user_text', content: 'do a thing' },
      {
        id: 'm_tool_use',
        role: 'tool',
        kind: 'tool_use',
        content: '',
        tool_call: { call_id: 'call_7', parent_stream_id: 'stream_x', tool_name: 'read_file' },
      },
      {
        id: 'm_tool_result',
        role: 'tool',
        kind: 'tool_result',
        content: '',
        tool_result: { call_id: 'call_7', parent_stream_id: 'stream_x', output_text: 'ok' },
      },
    ],
    message_count: 3,
    turn_events: [
      { event_seq: 2, turn_id: 'stream_x', type: 'tool_result', payload: {} },
      { event_seq: 1, turn_id: 'stream_x', type: 'tool_call', payload: {} },
    ],
  });
}

test('peekSessionMessages matches getSessionMessages on every lookup field', () => {
  const { store } = makeStore('jenny-peek-messages-');
  seedLookupSession(store, 'sess_lookup');

  const canonical = store.getSessionMessages('sess_lookup');
  const peeked = store.peekSessionMessages('sess_lookup');

  // findToolMessageId reads exactly these fields; a normalization difference
  // between the two paths would silently break tool-message upserts.
  const lookupView = (list) => list.map((message) => ({
    id: message.id,
    kind: message.kind,
    toolCallId: message.tool_call?.call_id || '',
    toolCallStream: message.tool_call?.parent_stream_id || '',
    toolResultId: message.tool_result?.call_id || '',
    toolResultStream: message.tool_result?.parent_stream_id || '',
  }));

  assert.equal(peeked.length, canonical.length);
  assert.deepEqual(lookupView(peeked), lookupView(canonical));
  assert.equal(peeked[1].tool_call.call_id, 'call_7', 'lookup view must not be vacuously empty');
  assert.deepEqual(store.peekSessionMessages('sess_missing'), []);
});

test('peekSessionMessages isolates array identity and survives a concurrent write', () => {
  const { store } = makeStore('jenny-peek-messages-isolation-');
  seedLookupSession(store, 'sess_iso');

  const peeked = store.peekSessionMessages('sess_iso');
  peeked.push({ id: 'm_intruder', role: 'user', kind: 'user_text', content: 'nope' });
  peeked.length = 1;
  assert.equal(
    store.getSessionMessages('sess_iso').length,
    3,
    'mutating the returned array must not reach the stored record'
  );

  // The lookup sites hold the peeked array across an updateMessage on one of
  // its own entries. Write paths replace message objects rather than mutating
  // them, so the held array must keep its pre-write snapshot semantics.
  const held = store.peekSessionMessages('sess_iso');
  store.updateMessage('sess_iso', 'm_tool_use', {
    tool_call: { call_id: 'call_7', parent_stream_id: 'stream_x', tool_name: 'read_file', status: 'error' },
  });
  assert.equal(held[1].tool_call.status, 'completed', 'held snapshot must not observe the later write');
  assert.equal(
    store.getSessionMessages('sess_iso')[1].tool_call.status,
    'error',
    'the store itself must reflect the write'
  );
});
