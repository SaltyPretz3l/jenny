'use strict';

// The activity row's typed state (tool-input drafting, compaction, a wait) is
// read by the sprite through getTypedActivity and announced through
// onTypedActivityChange, never through the row's DOM.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStreamActivityRow } = require('../renderer/chat/renderer-stream-activity-row');

function makeRow(t) {
  const flags = { live: true };
  const clock = { nowMs: 0 };
  const row = createStreamActivityRow({
    getChatTimeline: () => null,
    isStreamLive: () => flags.live,
    isSessionVisible: () => true,
    now: () => clock.nowMs,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  t.after(() => row.dispose());
  const heard = [];
  row.onTypedActivityChange((change) => heard.push(change));
  return { row, flags, clock, heard };
}

function noteEvent(row, type, extra = {}) {
  row.noteStreamEvent({ type, streamId: 'stream-1', sessionId: 'session-1', ...extra });
}

function noteToolInput(row, toolName, argumentsDelta = '{') {
  noteEvent(row, 'tool_input_delta', { toolCallId: `call-${toolName}`, toolName, argumentsDelta });
}

const NOTHING = { kind: '', toolName: '', checklist: false, waitState: '' };

test('an untracked stream has no typed activity', (t) => {
  const { row, heard } = makeRow(t);
  assert.equal(row.getTypedActivity('stream-1'), null);
  noteEvent(row, 'delta');
  assert.equal(row.getTypedActivity('stream-1'), null, 'tracked but nothing typed');
  assert.deepEqual(heard, []);
});

test('tool input reads as tool_input with its tool name, checklist only for list tools', (t) => {
  const { row } = makeRow(t);
  noteToolInput(row, 'write_file');
  assert.deepEqual(row.getTypedActivity('stream-1'), { ...NOTHING, kind: 'tool_input', toolName: 'write_file' });
  noteToolInput(row, 'todo_write');
  assert.deepEqual(row.getTypedActivity('stream-1'), { ...NOTHING, kind: 'tool_input', toolName: 'todo_write', checklist: true });
  noteToolInput(row, 'task_board');
  assert.equal(row.getTypedActivity('stream-1').checklist, true);
});

test('compaction reads as compaction', (t) => {
  const { row } = makeRow(t);
  noteEvent(row, 'context_compacting', { compactionPhase: 'preflight', tokensBefore: 10, messageCount: 2 });
  assert.deepEqual(row.getTypedActivity('stream-1'), { ...NOTHING, kind: 'compaction' });
});

test('a wait reads as waiting and turns stuck in place', (t) => {
  const { row, heard } = makeRow(t);
  noteEvent(row, 'runtime_waiting', { workId: 'work-1', waitState: 'waiting' });
  assert.deepEqual(row.getTypedActivity('stream-1'), { ...NOTHING, kind: 'waiting', waitState: 'waiting' });
  noteEvent(row, 'runtime_waiting', { workId: 'work-1', waitState: 'stuck' });
  assert.deepEqual(row.getTypedActivity('stream-1'), { ...NOTHING, kind: 'waiting', waitState: 'stuck' });
  assert.equal(heard.length, 2, 'waiting, then stuck');
  noteEvent(row, 'runtime_waiting', { workId: 'work-1', waitState: 'ended' });
  assert.equal(row.getTypedActivity('stream-1'), null, 'an ended wait is no longer typed');
  assert.equal(heard.length, 3);
});

test('the typed activity is a frozen snapshot, not the live entry', (t) => {
  const { row } = makeRow(t);
  noteToolInput(row, 'todo_write', '{"content":"a');
  const first = row.getTypedActivity('stream-1');
  assert.ok(Object.isFrozen(first));
  assert.deepEqual(Object.keys(first).sort(), ['checklist', 'kind', 'toolName', 'waitState']);
  assert.throws(() => { first.kind = 'compaction'; }, TypeError);
  noteEvent(row, 'context_compacting', { compactionPhase: 'preflight' });
  assert.equal(first.kind, 'tool_input', 'a taken snapshot never follows later state');
  assert.equal(row.getTypedActivity('stream-1').kind, 'compaction');
});

test('typed state clears to null on the next ordinary event and on untrack', (t) => {
  const { row, heard } = makeRow(t);
  noteToolInput(row, 'write_file');
  noteEvent(row, 'delta');
  assert.equal(row.getTypedActivity('stream-1'), null);
  assert.equal(heard.length, 2, 'set, then cleared');

  noteEvent(row, 'context_compacting', { compactionPhase: 'preflight' });
  noteEvent(row, 'complete');
  assert.equal(row.getTypedActivity('stream-1'), null, 'a terminal event untracks');
  assert.equal(heard.length, 4);
  assert.deepEqual(heard[3], { streamId: 'stream-1', sessionId: 'session-1' });
});

test('a stream that stops being live clears on the next tick, and dispose announces too', (t) => {
  const { row, flags, heard } = makeRow(t);
  noteToolInput(row, 'write_file');
  flags.live = false;
  row.tick();
  assert.equal(row.getTypedActivity('stream-1'), null);
  assert.equal(heard.length, 2);

  flags.live = true;
  noteEvent(row, 'context_compacting', { compactionPhase: 'preflight' });
  row.dispose();
  assert.equal(heard.length, 4, 'set, then cleared by dispose');
});

test('a resumed session ends the wait of the stream it replaces', (t) => {
  const { row, heard } = makeRow(t);
  noteEvent(row, 'runtime_waiting', { workId: 'work-1', waitState: 'waiting' });
  row.noteStreamEvent({ type: 'started', streamId: 'stream-2', sessionId: 'session-1' });
  assert.equal(row.getTypedActivity('stream-1'), null);
  assert.equal(heard.length, 2);
  assert.deepEqual(heard[1], { streamId: 'stream-1', sessionId: 'session-1' });
});

test('listeners hear a change once, never repeats, ticks or the same typed tuple', (t) => {
  const { row, clock, heard } = makeRow(t);
  noteToolInput(row, 'write_file');
  noteToolInput(row, 'write_file', '"path":"a.js"');
  noteToolInput(row, 'write_file', '"content":"x"');
  clock.nowMs = 5000;
  row.tick();
  row.tick();
  assert.deepEqual(heard, [{ streamId: 'stream-1', sessionId: 'session-1' }]);

  noteEvent(row, 'context_compacting', { compactionPhase: 'preflight' });
  noteEvent(row, 'context_compacting', { compactionPhase: 'tool_loop' });
  assert.equal(heard.length, 2, 'tool_input to compaction is one change, a repeated compaction is none');

  noteToolInput(row, 'todo_write');
  noteToolInput(row, 'write_file');
  assert.equal(heard.length, 4, 'a different tool is a change, and so is checklist flipping off');
  noteEvent(row, 'context_usage');
  assert.equal(heard.length, 4, 'ignored telemetry changes nothing');
});

test('each stream is tracked on its own', (t) => {
  const { row, heard } = makeRow(t);
  noteToolInput(row, 'write_file');
  row.noteStreamEvent({ type: 'delta', streamId: 'stream-2', sessionId: 'session-2' });
  assert.equal(heard.length, 1);
  row.noteStreamEvent({ type: 'context_compacting', streamId: 'stream-2', sessionId: 'session-2', compactionPhase: 'preflight' });
  assert.deepEqual(heard[1], { streamId: 'stream-2', sessionId: 'session-2' });
  assert.equal(row.getTypedActivity('stream-1').kind, 'tool_input');
  assert.equal(row.getTypedActivity('stream-2').kind, 'compaction');
});

test('listeners run in registration order and unsubscribe stops one of them', (t) => {
  const { row } = makeRow(t);
  const order = [];
  const offA = row.onTypedActivityChange(() => order.push('a'));
  row.onTypedActivityChange(() => order.push('b'));
  noteToolInput(row, 'write_file');
  assert.deepEqual(order, ['a', 'b']);
  offA();
  noteEvent(row, 'delta');
  assert.deepEqual(order, ['a', 'b', 'b']);
});

test('a throwing listener neither breaks the row nor silences the others', (t) => {
  const { row } = makeRow(t);
  const seen = [];
  row.onTypedActivityChange(() => { throw new Error('listener'); });
  row.onTypedActivityChange(() => seen.push('ok'));
  noteToolInput(row, 'write_file');
  assert.deepEqual(seen, ['ok']);
  assert.equal(row.getTypedActivity('stream-1').kind, 'tool_input');
});
