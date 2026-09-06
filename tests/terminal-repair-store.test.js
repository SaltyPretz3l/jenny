'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  TERMINAL_REPAIR_SCHEMA_VERSION,
  TerminalRepairStore,
} = require('../services/backend/terminal-repair-store');
const {
  overlayPendingTerminalRepairs,
} = require('../services/backend/terminal-repair-overlay');

function createFixture(overrides = {}) {
  const fixture = {
    artifact_id: 'repair-session-a-inc-a-1',
    session_id: 'session-a',
    session_incarnation: 'inc-a',
    turn_generation: 1,
    turn_id: 'turn-a',
    stream_id: 'stream-a',
    reason: 'write_failed',
    scope: 'assistant',
    message: {
      id: 'assistant-stream-a',
      role: 'assistant',
      content: 'Visible reply',
      status: 'complete',
      client_message_id: 'assistant-stream-a',
      timestamp: '2026-07-14T12:00:00.000Z',
    },
  };
  const merged = { ...fixture, ...overrides };
  return {
    ...merged,
    terminal_snapshot: Object.hasOwn(overrides, 'terminal_snapshot')
      ? overrides.terminal_snapshot
      : {
        kind: 'complete',
        terminal: { kind: 'complete' },
        messages: [merged.message],
        tool_repairs: [],
        turn_events: [],
        preference_patch: {},
        title: null,
      },
  };
}

function createStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-terminal-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'terminal-repairs.json');
  return { filePath, store: new TerminalRepairStore(filePath) };
}

test('terminal repair store persists pending artifacts and reloads them', (t) => {
  const { filePath, store } = createStore(t);
  const result = store.savePending(createFixture());

  assert.equal(result.ok, true);
  assert.equal(result.durable, true);
  assert.equal(store.listPending('session-a').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).schema_version, TERMINAL_REPAIR_SCHEMA_VERSION);

  const reloaded = new TerminalRepairStore(filePath);
  const pending = reloaded.listPending('session-a')[0];
  assert.equal(pending.message.content, 'Visible reply');
  assert.equal(pending.terminal_snapshot.kind, 'complete');
  assert.equal(pending.terminal_snapshot.messages[0].id, 'assistant-stream-a');
});

test('terminal repair store treats prototype names as own artifact ids only', (t) => {
  const { filePath, store } = createStore(t);

  assert.equal(store.get('toString'), null);
  assert.equal(store.get('constructor'), null);
  assert.equal(store.savePending(createFixture({ artifact_id: '__proto__' })).ok, true);
  assert.equal(store.get('__proto__').artifact_id, '__proto__');
  assert.equal(new TerminalRepairStore(filePath).get('__proto__').artifact_id, '__proto__');
});

test('terminal repair message may represent the full visible reply outside canonical tail rows', (t) => {
  const { store } = createStore(t);
  const fixture = createFixture();
  const result = store.savePending(createFixture({
    message: { ...fixture.message, id: 'assistant-stream-a-visible' },
    terminal_snapshot: {
      ...fixture.terminal_snapshot,
      messages: [{ ...fixture.message, id: 'assistant-stream-a-seg2', content: 'tail' }],
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(store.listPending('session-a')[0].message.id, 'assistant-stream-a-visible');
  assert.equal(
    store.listPending('session-a')[0].terminal_snapshot.messages[0].id,
    'assistant-stream-a-seg2'
  );
});

test('terminal-only repair artifacts persist without fabricating an assistant message', (t) => {
  const { filePath, store } = createStore(t);
  const fixture = createFixture({
    artifact_id: 'repair-terminal-only',
    message: null,
    scope: 'terminal',
    terminal_snapshot: {
      kind: 'denied',
      terminal: { kind: 'denied', rendererPayload: { type: 'error' } },
      messages: [],
      tool_repairs: [],
      turn_events: [],
      preference_patch: {},
      title: null,
    },
  });

  assert.equal(store.savePending(fixture).ok, true);
  const reloaded = new TerminalRepairStore(filePath).get('repair-terminal-only');
  assert.equal(reloaded.message, null);
  assert.equal(reloaded.scope, 'terminal');
  assert.equal(reloaded.terminal_snapshot.kind, 'denied');
  assert.equal(reloaded.terminal_snapshot.terminal.rendererPayload.type, 'error');
});

test('terminal repair store refuses malformed or unbounded terminal snapshots', (t) => {
  const { store } = createStore(t);
  assert.equal(store.savePending(createFixture({ terminal_snapshot: null })).reason, 'invalid_artifact');
  const message = createFixture().message;
  const oversized = Array.from({ length: 513 }, (_, index) => ({
    ...message,
    id: `assistant-${index}`,
  }));
  assert.equal(store.savePending(createFixture({
    terminal_snapshot: {
      kind: 'complete',
      messages: oversized,
      tool_repairs: [],
      turn_events: [],
      preference_patch: {},
    },
  })).reason, 'invalid_artifact');
});

test('terminal repair store is idempotent and refuses identity conflicts', (t) => {
  const { store } = createStore(t);
  assert.equal(store.savePending(createFixture()).ok, true);
  assert.equal(store.savePending(createFixture()).ok, true);
  const conflict = store.savePending(createFixture({
    message: { ...createFixture().message, id: 'assistant-other' },
  }));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, 'artifact_identity_conflict');
  const contentConflict = store.savePending(createFixture({
    message: { ...createFixture().message, content: 'Different reply' },
  }));
  assert.equal(contentConflict.reason, 'artifact_identity_conflict');
});

test('discard is durable, identity-fenced, and cannot be resurrected', (t) => {
  const { filePath, store } = createStore(t);
  store.savePending(createFixture());
  const stale = store.markDiscarded('repair-session-a-inc-a-1', {
    session_id: 'session-a',
    session_incarnation: 'inc-a',
    turn_generation: 2,
  });
  assert.equal(stale.reason, 'stale_identity');

  const discarded = store.markDiscarded('repair-session-a-inc-a-1', {
    session_id: 'session-a',
    session_incarnation: 'inc-a',
    turn_generation: 1,
  });
  assert.equal(discarded.ok, true);
  assert.deepEqual(store.listPending('session-a'), []);
  assert.equal(new TerminalRepairStore(filePath).listPending('session-a').length, 0);
  assert.equal(store.savePending(createFixture()).reason, 'artifact_discarded');
  assert.equal(store.findByIdentity({
    sessionId: 'session-a', sessionIncarnation: 'inc-a', generation: 1,
  }).state, 'discarded');
});

test('incomplete discard intent remains pending and visible across reload until final tombstone', (t) => {
  const { filePath, store } = createStore(t);
  const fixture = createFixture();
  assert.equal(store.savePending(fixture).ok, true);
  const intent = store.markDiscardPending(fixture.artifact_id, {
    session_id: fixture.session_id,
    session_incarnation: fixture.session_incarnation,
    turn_generation: fixture.turn_generation,
  });
  assert.equal(intent.ok, true);
  assert.equal(intent.artifact.state, 'pending');
  assert.equal(intent.artifact.discard_requested, true);

  const reloaded = new TerminalRepairStore(filePath);
  const pending = reloaded.listPending(fixture.session_id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].discard_requested, true);
  assert.equal(overlayPendingTerminalRepairs([], pending).length, 1);
  assert.equal(reloaded.savePending(fixture).reason, 'artifact_discard_pending');

  const finalized = reloaded.markDiscarded(fixture.artifact_id, {
    session_id: fixture.session_id,
    session_incarnation: fixture.session_incarnation,
    turn_generation: fixture.turn_generation,
  });
  assert.equal(finalized.ok, true);
  assert.deepEqual(new TerminalRepairStore(filePath).listPending(fixture.session_id), []);
});

test('write refusal never installs an in-memory repair that did not reach disk', (t) => {
  const { store } = createStore(t);
  const originalWriteImmediate = store._store.writeImmediate.bind(store._store);
  store._store.writeImmediate = () => {
    throw new Error('blocked');
  };
  const refused = store.savePending(createFixture());
  assert.equal(refused.ok, false);
  assert.equal(refused.durable, false);
  assert.equal(refused.reason, 'write_failed');
  assert.deepEqual(store.listPending('session-a'), []);
  store._store.writeImmediate = originalWriteImmediate;
  assert.equal(store.savePending(createFixture()).ok, true);
});

test('future repair schema freezes writes', (t) => {
  const { filePath } = createStore(t);
  fs.writeFileSync(filePath, JSON.stringify({
    schema_version: TERMINAL_REPAIR_SCHEMA_VERSION + 1,
    repairs: {},
  }));
  const store = new TerminalRepairStore(filePath);
  assert.equal(store.hasNewerSchema(), true);
  assert.equal(store.savePending(createFixture()).reason, 'newer_schema');
});

test('repair overlay restores only missing pending messages and canonical rows win', () => {
  const repair = { ...createFixture(), state: 'pending' };
  const restored = overlayPendingTerminalRepairs([], [repair]);
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0].durability, {
    state: 'unsaved',
    reason: 'write_failed',
    scope: 'assistant',
    artifact_id: 'repair-session-a-inc-a-1',
  });

  const canonical = [{
    ...repair.message,
    content: 'Durable canonical reply',
  }];
  const deduped = overlayPendingTerminalRepairs(canonical, [repair]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].content, 'Durable canonical reply');
  assert.equal(deduped[0].durability, undefined);
});

test('repair overlay preserves canonical array order regardless of timestamps', () => {
  const canonical = [
    { id: 'z-first', role: 'user', content: 'first', timestamp: '2026-07-14T12:00:02Z' },
    { id: 'a-second', role: 'assistant', content: 'second', timestamp: '' },
    { id: 'm-third', role: 'user', content: 'third', timestamp: '2026-07-14T12:00:02Z' },
  ];
  const repair = { ...createFixture(), state: 'pending' };
  const overlaid = overlayPendingTerminalRepairs(canonical, [repair]);

  assert.deepEqual(overlaid.slice(0, canonical.length), canonical);
  assert.deepEqual(overlaid.map((message) => message.id), [
    'z-first', 'a-second', 'm-third', repair.message.id,
  ]);
});

test('session deletion durably scrubs pending and discarded repairs', (t) => {
  const { filePath, store } = createStore(t);
  store.savePending(createFixture());
  store.savePending(createFixture({
    artifact_id: 'repair-session-b-inc-b-1',
    session_id: 'session-b',
    session_incarnation: 'inc-b',
    turn_id: 'turn-b',
    stream_id: 'stream-b',
    message: {
      ...createFixture().message,
      id: 'assistant-stream-b',
      client_message_id: 'assistant-stream-b',
    },
  }));
  const deleted = store.deleteSession('session-a');
  assert.equal(deleted.ok, true);
  assert.equal(deleted.durable, true);
  const reloaded = new TerminalRepairStore(filePath);
  assert.deepEqual(reloaded.listPending('session-a'), []);
  assert.equal(reloaded.listPending('session-b').length, 1);
});
