// new-test-file: the live and reconciled life of a user_steer stream payload is a new surface;
// the existing stream-handler files cover other payload types.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createSendOutbox } = require('../renderer/chat/renderer-send-outbox');
const { createSteerController } = require('../renderer/chat/renderer-send-outbox-dispatch');
const { createDeferred } = require('./helpers/deferred');
const { createHarness, flushMicrotasks } = require('./helpers/renderer-stream-handler-buffering-harness');
const reducer = require('../renderer/chat/renderer-turn-reducer');

const SESSION = 'session-1';
const STREAM = 'stream-s1';
const STEER_ID = 'steer_outbox_x1';

function steerRow(overrides = {}) {
  return {
    id: STEER_ID, role: 'user', kind: 'steer', turn_id: STREAM, content: 'Use the other file',
    attachments: [], outbox_item_id: 'outbox_x1', timestamp: '2026-11-17T10:00:00.000Z', ...overrides,
  };
}

function steerPayload(overrides = {}) {
  return { type: 'user_steer', streamId: STREAM, sessionId: SESSION, turnId: STREAM, message: steerRow(), ...overrides };
}

function setup(t, harnessOptions = {}) {
  const harness = createHarness(harnessOptions);
  t.after(() => harness.restore());
  const released = [];
  harness.state.ui.chatTimelineRowModelBySession = new Map([[SESSION, true]]);
  const outbox = createSendOutbox(harness.state, { releaseAssets: (paths) => { released.push(paths); } });
  harness.state.sendOutboxController = outbox;
  harness.state.sendSteerController = createSteerController({
    state: harness.state,
    sendOutbox: outbox,
    getBridge: () => ({}),
    isSessionBusy: () => true,
    getStreamId: () => STREAM,
    dispatchQueuedSend: () => Promise.resolve(null),
    onChange() {},
  });
  const queued = outbox.enqueue(SESSION, {
    prompt: 'Use the other file', status: 'offered', attachments: [{ assetPath: 'files/a.txt' }],
  });
  return { harness, outbox, released, queued };
}

async function runToolStep(harness) {
  await harness.emit({ type: 'started', sessionId: SESSION, streamId: STREAM });
  await harness.emit({ type: 'delta', sessionId: SESSION, streamId: STREAM, content: 'Looking. ', aggregate: 'Looking. ' });
  await harness.emit({ type: 'tool_use', sessionId: SESSION, streamId: STREAM, callId: 'call-1', toolName: 'Read', status: 'running', summary: 'Read a.js' });
  await harness.emit({ type: 'tool_result', sessionId: SESSION, streamId: STREAM, callId: 'call-1', toolName: 'Read', content: 'ok', summary: 'Read a.js' });
}

test('user_steer puts a user bubble after the last tool row and later deltas start a new segment', async (t) => {
  const { harness, outbox, released, queued } = setup(t);
  await runToolStep(harness);
  await harness.emit(steerPayload({ message: steerRow({ outbox_item_id: queued.id, id: `steer_${queued.id}` }) }));
  await harness.emit({ type: 'delta', sessionId: SESSION, streamId: STREAM, content: 'Switching files.', aggregate: 'Looking. Switching files.' });

  const messages = harness.state.messagesBySession.get(SESSION);
  const steerIndex = messages.findIndex((message) => message.kind === 'steer');
  const toolResultIndex = messages.findLastIndex((message) => message.kind === 'tool_result');
  const laterAssistant = messages.findIndex((message, index) => index > steerIndex
    && message.role === 'assistant' && String(message.content).includes('Switching files.'));
  assert.ok(steerIndex > toolResultIndex, 'the bubble sits after the step before it');
  assert.ok(laterAssistant > steerIndex, 'the next reply is a new segment after the bubble');
  assert.equal(messages[steerIndex].role, 'user');
  assert.equal(messages[steerIndex].content, 'Use the other file');
  assert.equal(messages[steerIndex].turn_id, STREAM);
  const earlier = messages.filter((message, index) => index < steerIndex && message.role === 'assistant' && !message.kind);
  assert.ok(earlier.every((message) => !String(message.content).includes('Switching files.')), 'the first segment is closed');
  assert.equal(earlier[0].status, 'complete');

  assert.equal(outbox.list(SESSION).length, 0, 'the queue card goes away');
  assert.deepEqual(released, [], 'the attachments now belong to the persisted row');

  const rows = harness.state.ui.chatTimelineLiveStateBySession.get(SESSION).turns_by_id[STREAM].rows;
  const kinds = rows.map((row) => row.kind);
  const bubble = kinds.indexOf('user_bubble');
  assert.ok(bubble > kinds.indexOf('tool_call'), `bubble after the tool row: ${kinds.join(',')}`);
  assert.ok(bubble < kinds.lastIndexOf('assistant_text'), `bubble before the later reply: ${kinds.join(',')}`);
  assert.equal(rows[bubble].primary_message_id, `steer_${queued.id}`);
  assert.equal(rows[bubble].payload.content, 'Use the other file');
});

test('a duplicate user_steer payload leaves one bubble', async (t) => {
  const { harness, queued } = setup(t);
  await runToolStep(harness);
  const message = steerRow({ outbox_item_id: queued.id, id: `steer_${queued.id}` });
  await harness.emit(steerPayload({ message }));
  await harness.emit(steerPayload({ message }));
  const messages = harness.state.messagesBySession.get(SESSION);
  assert.equal(messages.filter((entry) => entry.kind === 'steer').length, 1);
  const rows = harness.state.ui.chatTimelineLiveStateBySession.get(SESSION).turns_by_id[STREAM].rows;
  assert.equal(rows.filter((row) => row.kind === 'user_bubble').length, 1);
});

test('a malformed user_steer payload changes nothing', async (t) => {
  const { harness, outbox } = setup(t);
  await runToolStep(harness);
  const before = harness.state.messagesBySession.get(SESSION).length;
  await harness.emit(steerPayload({ message: null }));
  await harness.emit(steerPayload({ message: steerRow({ role: 'assistant' }) }));
  assert.equal(harness.state.messagesBySession.get(SESSION).length, before);
  assert.equal(outbox.list(SESSION).length, 1);
});

test('the live reducer and the hydrated projection agree on the steer bubble', () => {
  const live = reducer.createTurnReducerState();
  const attachments = [{ displayName: 'a.txt', kind: 'text' }];
  const events = reducer.buildTurnEventFromStreamPayload(
    steerPayload({ message: steerRow({ attachments }) }),
    { turn_id: STREAM, ordinal: 4, message_index: 4 }
  );
  assert.deepEqual([].concat(events).map((event) => event.kind), ['user_prompt', 'attachment_cluster']);
  reducer.applyTurnStreamEvent(live, events);
  const liveRows = live.turns_by_id[STREAM].rows.filter((row) => row.kind === 'user_bubble');
  assert.equal(liveRows.length, 1);

  const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');
  const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
  const tree = projectTurnTree({ messages: [
    { id: 'user_stream-s1', role: 'user', content: 'Start', turn_id: STREAM },
    { id: 'tool_use_call-1', role: 'assistant', kind: 'tool_use', turn_id: STREAM, tool_call: { call_id: 'call-1', tool_name: 'Read', status: 'completed', parent_stream_id: STREAM } },
    steerRow({ attachments }),
    { id: 'assistant_stream-s1_seg1', role: 'assistant', content: 'Done.', turn_id: STREAM, status: 'complete' },
  ] });
  const turn = tree.turns.find((entry) => entry.turn_id === STREAM);
  const hydrated = projectTurnRows(turn.events, {}).filter((row) => row.kind === 'user_bubble');
  assert.equal(hydrated.length, 2, 'the opening prompt and the steer, in one turn');
  const steerHydrated = hydrated.find((row) => row.primary_message_id === STEER_ID);
  assert.equal(steerHydrated.payload.content, liveRows[0].payload.content);
  assert.equal(steerHydrated.payload.attachments.length, liveRows[0].payload.attachments.length);
  const kinds = projectTurnRows(turn.events, {}).map((row) => row.kind);
  assert.ok(kinds.indexOf('user_bubble', 1) > kinds.indexOf('tool_call'), kinds.join(','));
  assert.ok(kinds.indexOf('user_bubble', 1) < kinds.indexOf('assistant_text'), kinds.join(','));
});

test('after the terminal reconcile there is exactly one bubble for the steer message', async (t) => {
  const terminalHydration = createDeferred();
  const { harness, queued } = setup(t, {
    stateOverrides: {
      window: { jennyShell: { sessions: { async getMessages() { return terminalHydration.promise; } } } },
    },
  });
  await runToolStep(harness);
  const message = steerRow({ outbox_item_id: queued.id, id: `steer_${queued.id}` });
  await harness.emit(steerPayload({ message }));
  await harness.emit({ type: 'delta', sessionId: SESSION, streamId: STREAM, content: 'Switching files.', aggregate: 'Looking. Switching files.' });
  const completePromise = harness.emit({ type: 'complete', sessionId: SESSION, streamId: STREAM, turnId: STREAM, content: 'Switching files.' });
  await flushMicrotasks(20);
  const local = harness.state.messagesBySession.get(SESSION);
  terminalHydration.resolve({
    data: [{ id: 'user_stream-s1', role: 'user', content: 'Start', turn_id: STREAM, status: 'complete' }, ...local],
  });
  await completePromise;
  const final = harness.state.messagesBySession.get(SESSION);
  assert.equal(final.filter((entry) => entry.id === message.id).length, 1);
  assert.equal(final.filter((entry) => entry.kind === 'steer').length, 1);
  assert.equal(final.filter((entry) => entry.role === 'user' && entry.content === 'Use the other file').length, 1);
});

test('a new turn anchors on the opening user message, never on a steer message', async (t) => {
  const { harness } = setup(t);
  harness.state.messagesBySession.set(SESSION, [
    { id: 'user_open', role: 'user', content: 'Start', status: 'complete' },
    { id: 'steer_outbox_old', role: 'user', kind: 'steer', content: 'Earlier steer', status: 'complete' },
  ]);
  await harness.emit({ type: 'started', sessionId: SESSION, streamId: STREAM });
  const turn = harness.state.ui.chatTimelineLiveStateBySession.get(SESSION).turns_by_id[STREAM];
  assert.equal(turn.primary_user_message_id, 'user_open');
});

for (const terminal of [
  { type: 'complete', content: 'Done.' },
  { type: 'error', message: 'The engine stopped.', status: 'error' },
]) {
  test(`a ${terminal.type} terminal puts an item still offered back to ready, not offered again for that stream`, async (t) => {
    const { harness, outbox, queued } = setup(t);
    await runToolStep(harness);
    assert.equal(outbox.list(SESSION)[0].status, 'offered');
    await harness.emit({ ...terminal, sessionId: SESSION, streamId: STREAM, turnId: STREAM });
    const [entry] = outbox.list(SESSION);
    assert.equal(entry.id, queued.id);
    assert.equal(entry.status, 'ready');
    assert.equal(entry.steerBlockedStreamId, STREAM);
  });
}
