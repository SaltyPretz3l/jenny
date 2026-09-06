'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { SessionShadowStore } = require('../services/backend/session-shadow-store');
const { TURN_EVENT_LOG_VERSION } = require('../services/backend/session-turn-events');
const { TurnEventJournal } = require('../services/backend/turn-event-journal');
const {
  cleanupTrackedResources,
  trackCloseable,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => cleanupTrackedResources());

function makeStore(StoreClass, label, writeDebounceMs = 60_000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jenny-port-${label}-`));
  trackDirectory(dir);
  const filePath = path.join(dir, `${label}.json`);
  const store = trackCloseable(new StoreClass(filePath, { writeDebounceMs }));
  return { store, dir, filePath };
}

function message(id, content = 'hello') {
  return {
    id,
    role: 'user',
    content,
    timestamp: '2026-07-14T10:00:00.000Z',
  };
}

for (const [label, StoreClass] of [
  ['electron', ElectronSessionStore],
  ['shadow', SessionShadowStore],
]) {
  test(`${label} ConversationStore enforces identity, idempotency, and durability epochs`, () => {
    const { store } = makeStore(StoreClass, label);
    const port = store.conversationStore;
    const missing = port.appendMessage('missing', message('msg_1'));
    assert.equal(missing.ok, false);
    assert.equal(store.getSession('missing'), null, 'a mutation must not create a missing session');

    const created = port.createSession('sess_port', { title: 'Port' });
    assert.equal(created.ok, true);
    assert.equal(created.durable, false, 'debounced acceptance is dirty, not durable');
    assert.equal(created.commitEpoch, 1);

    const first = port.appendMessage('sess_port', message('msg_1'), { durable: true });
    assert.equal(first.ok, true);
    assert.equal(first.applied, true);
    assert.equal(first.durable, true);
    assert.ok(first.durableEpoch >= first.commitEpoch && first.commitEpoch > 0);

    const beforeRetry = port.getEpochs('sess_port');
    const retry = port.appendMessage('sess_port', message('msg_1'), { durable: true });
    assert.equal(retry.ok, true);
    assert.equal(retry.applied, false);
    assert.equal(retry.reason, 'idempotent');
    assert.deepEqual(port.getEpochs('sess_port'), beforeRetry, 'an exact retry does not mint an epoch');

    const conflict = port.appendMessage('sess_port', message('msg_1', 'different'));
    assert.equal(conflict.ok, false);
    assert.equal(conflict.reason, 'message_id_conflict');
    assert.equal(port.getSessionMessages('sess_port').length, 1);

    const duplicateRows = [message('dup', 'one'), message('dup', 'two')];
    if (label === 'electron') store.replaceMessages('sess_port', duplicateRows);
    else store.upsertSession('sess_port', { messages: duplicateRows });
    const ambiguous = port.updateMessage('sess_port', 'dup', { content: 'patched' });
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.reason, 'ambiguous_message_id');
    assert.equal(store.updateMessage('sess_port', 'dup', { content: 'patched' }), null);
  });

  test(`${label} turn-event append returns strict proof and duplicate replay remains durable`, () => {
    const { store } = makeStore(StoreClass, `${label}-events`);
    const port = store.conversationStore;
    port.createSession('sess_events', { title: 'Events' });
    const event = {
      event_id: 'evt_1',
      turn_id: 'turn_1',
      kind: 'assistant_text',
      primary_message_id: 'msg_a',
      source_message_ids: ['msg_a'],
      payload: { content: 'done' },
    };
    const first = port.appendTurnEvents('sess_events', [event], { durable: true });
    assert.deepEqual(Object.keys(first), [
      'ok', 'applied', 'durable', 'reason', 'commitEpoch', 'dirtyEpoch', 'durableEpoch', 'value',
    ]);
    assert.equal(first.value.appended, 1);
    assert.equal(first.durable, true);

    const retry = port.appendTurnEvents('sess_events', [event], { durable: true });
    assert.equal(retry.ok, true);
    assert.equal(retry.applied, false);
    assert.equal(retry.reason, 'all_duplicates');
    assert.equal(retry.value.duplicateCount, 1);
    assert.ok(retry.durableEpoch >= retry.commitEpoch);
  });
}

function seedTerminalStore() {
  const result = makeStore(ElectronSessionStore, 'terminal');
  const { store } = result;
  store.createSessionWithId('sess_terminal', { title: 'Before' });
  store.setTurnIdentity('sess_terminal', {
    session_incarnation: 'inc_1',
    turn_generation: 1,
  });
  store.appendMessage('sess_terminal', {
    id: 'tool_1', role: 'assistant', kind: 'tool_use', content: '',
    timestamp: '2026-07-14T10:00:01.000Z',
    status: 'running',
    tool_call: { call_id: 'call_1', tool_name: 'demo', status: 'running' },
  });
  store.setActiveTurn('sess_terminal', {
    request_id: 'turn_1', stream_id: 'stream_1', turn_id: 'turn_1',
    user_message_id: 'user_1', session_incarnation: 'inc_1', generation: 1,
    started_at: '2026-07-14T10:00:00.000Z',
    last_event_at: '2026-07-14T10:00:01.000Z', status: 'streaming',
  });
  assert.equal(store.flushSession('sess_terminal'), true);
  return result;
}

function terminalRequest(overrides = {}) {
  return {
    identity: {
      sessionId: 'sess_terminal', sessionIncarnation: 'inc_1', generation: 1,
      turnId: 'turn_1', streamId: 'stream_1', userMessageId: 'user_1',
    },
    messages: [{
      id: 'assistant_1', role: 'assistant', content: 'finished',
      timestamp: '2026-07-14T10:00:02.000Z', status: 'complete',
    }],
    toolRepairs: [{
      messageId: 'tool_1', callId: 'call_1',
      patch: { status: 'complete', tool_call: { status: 'complete' } },
    }],
    turnEvents: [{
      event_id: 'evt_terminal', turn_id: 'turn_1', kind: 'assistant_text',
      primary_message_id: 'assistant_1', source_message_ids: ['assistant_1'],
      payload: { content: 'finished' },
    }],
    preferencePatch: { pending_question_batch: null },
    title: 'After',
    clearActiveTurnMatch: {
      requestId: 'turn_1', streamId: 'stream_1', turnId: 'turn_1',
      sessionIncarnation: 'inc_1', generation: 1, userMessageId: 'user_1',
    },
    ...overrides,
  };
}

test('commitTerminal applies one epoch, exact-one terminal tool repairs, and current event schema', () => {
  const { store } = seedTerminalStore();
  const before = store.conversationStore.getEpochs('sess_terminal').dirtyEpoch;
  const result = store.conversationStore.commitTerminal(
    'sess_terminal', terminalRequest(), { durable: true }
  );
  assert.equal(result.ok, true);
  assert.equal(result.commitEpoch, before + 1, 'the terminal transaction is one logical epoch');
  assert.deepEqual(result.value.repairedToolMessageIds, ['tool_1']);
  const session = store.getSession('sess_terminal');
  assert.equal(session.active_turn, null);
  assert.equal(session.turn_event_log_version, TURN_EVENT_LOG_VERSION);
  assert.equal(session.messages.find((item) => item.id === 'tool_1').tool_call.status, 'complete');
});

test('commitTerminal rejects a nonterminal or ambiguous tool repair before mutation', () => {
  const { store } = seedTerminalStore();
  const before = store.conversationStore.getEpochs('sess_terminal');
  const refused = store.conversationStore.commitTerminal('sess_terminal', terminalRequest({
    toolRepairs: [{ messageId: 'tool_1', patch: { tool_call: { status: 'running' } } }],
  }));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'nonterminal_tool_repair');
  assert.deepEqual(store.conversationStore.getEpochs('sess_terminal'), before);
  assert.ok(store.getActiveTurn('sess_terminal'));
});

test('commitTerminal durability failure compensates session/index and restores active-turn cache exactly', () => {
  const { store, filePath } = seedTerminalStore();
  const beforeSession = store.getSession('sess_terminal');
  const beforeIndex = store._backend.getIndexSnapshot();
  const indexStore = store._backend._indexStore;
  const originalWriteImmediate = indexStore.writeImmediate.bind(indexStore);
  let attempts = 0;
  indexStore.writeImmediate = (value) => {
    attempts += 1;
    if (attempts === 1) throw new Error('index flush failed once');
    return originalWriteImmediate(value);
  };

  const result = store.conversationStore.commitTerminal('sess_terminal', terminalRequest(), {
    durable: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'durability_failed');
  assert.equal(result.value.rollbackRestored, true);
  assert.deepEqual(store.getSession('sess_terminal'), beforeSession);
  assert.deepEqual(store._backend.getIndexSnapshot(), beforeIndex);

  const sessionsDir = path.join(path.dirname(filePath), path.basename(filePath, '.json'));
  const diskSession = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'sess_terminal.json'), 'utf8'));
  const diskIndex = JSON.parse(fs.readFileSync(path.join(sessionsDir, '_index.json'), 'utf8'));
  assert.deepEqual(diskSession.session, beforeSession);
  assert.deepEqual(diskIndex, beforeIndex);
});

test('journal clear refuses missing proof and accepts the exact durable commit result', () => {
  const { store, dir } = seedTerminalStore();
  const journal = trackCloseable(
    new TurnEventJournal(path.join(dir, 'turn-journal.json'), { writeDebounceMs: 60_000 })
  );
  journal.append('sess_terminal', 'turn_1', [{ event_id: 'evt_journal' }]);
  const refused = journal.clear('sess_terminal', 'turn_1');
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'invalid_commit_proof');
  assert.equal(journal.list('sess_terminal', 'turn_1').length, 1);

  const proof = store.appendTurnEvents('sess_terminal', [{
    event_id: 'evt_proof', turn_id: 'turn_1', kind: 'assistant_text',
    primary_message_id: 'tool_1', source_message_ids: ['tool_1'], payload: {},
  }], { durable: true });
  const cleared = journal.clear('sess_terminal', 'turn_1', { commitResult: proof });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.durable, true);
  assert.deepEqual(journal.list('sess_terminal', 'turn_1'), []);
});
