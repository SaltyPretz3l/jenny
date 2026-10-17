'use strict';

// Owner report 2026-10-15 (NInfer, qwen3.8-27b-nvfp4, Plan Mode): while the
// model wrote its exit_plan_mode call the chat showed only the generic
// throbber ("Putting changes together…"). Two gaps:
// 1. Engines that stream tool arguments named the row "Exit Plan Mode ·
//    Composing…" and never showed which plan was being written.
// 2. NInfer parses tool markup server-side and sends the whole call in one
//    final chunk, so the silence after reasoning carried no typed event at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createStreamActivityRow,
  ACTIVITY_COPY,
  ACTIVITY_COPY_LONG,
} = require('../renderer/chat/renderer-stream-activity-row');

function makeHarness(t) {
  const dom = new JSDOM('<div id="chatTimeline"><article class="chat-entry assistant pending"><div class="chat-message-content"></div></article></div>');
  const timeline = dom.window.document.getElementById('chatTimeline');
  const clock = { nowMs: 0 };
  const row = createStreamActivityRow({
    getChatTimeline: () => timeline,
    isStreamLive: () => true,
    isSessionVisible: () => true,
    hasBlockingToolState: () => false,
    now: () => clock.nowMs,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    pickCopyIndex: () => 0,
  });
  t.after(() => {
    row.dispose();
    dom.window.close();
  });
  const read = () => {
    const node = timeline.querySelector('.turn-activity-row');
    if (!node) return null;
    const name = node.querySelector('.turn-activity-name');
    return {
      kind: node.getAttribute('data-turn-activity-kind'),
      name: name.hidden ? '' : name.textContent,
      label: node.querySelector('.turn-activity-label').textContent,
      elapsed: node.querySelector('.turn-activity-elapsed').textContent,
    };
  };
  return { clock, row, read };
}

function noteEvent(row, type, extra = {}) {
  row.noteStreamEvent({ type, streamId: 'stream-1', sessionId: 'session-1', ...extra });
}

function notePlanInput(row, argumentsDelta, argumentsBytes) {
  noteEvent(row, 'tool_input_delta', {
    toolCallId: 'call-plan', toolName: 'exit_plan_mode', argumentsDelta, argumentsBytes,
  });
}

function noteReasoning(row) {
  noteEvent(row, 'delta', {
    content: '',
    reasoning: { source: 'provider', entriesDelta: [{ id: 'r1', text: 'Now I can write the plan.' }] },
  });
}

test('an exit_plan_mode call reads as preparing the plan and names it once its title streams', (t) => {
  const { clock, row, read } = makeHarness(t);
  notePlanInput(row, '{"ti', 4);
  assert.deepEqual(read(), { kind: 'tool_input', name: 'Preparing the plan', label: 'Composing…', elapsed: '4 B · 0:00' });
  clock.nowMs = 3000;
  // The title key and its escapes split across folded deltas.
  notePlanInput(row, 'tle":"Add a \\"Retry\\" button","summary":"Adds a', 52);
  assert.deepEqual(read(), {
    kind: 'tool_input', name: 'Preparing the plan', label: 'Add a "Retry" button', elapsed: '52 B · 0:03',
  });
  clock.nowMs = 9000;
  notePlanInput(row, ' retry","steps":["Wire the button","Add a test"]}', 2100);
  row.tick();
  assert.deepEqual(read(), {
    kind: 'tool_input', name: 'Preparing the plan', label: 'Add a "Retry" button', elapsed: '2.1 KB · 0:09',
  }, 'a step text never replaces the title, and the size keeps counting');
  assert.deepEqual(row.getTypedActivity('stream-1'), {
    kind: 'tool_input', toolName: 'exit_plan_mode', checklist: false, waitState: '',
  }, 'the plan row is not a checklist row');
});

test('silence after reasoning reads as preparing the next step, not the generic copy', (t) => {
  const { clock, row, read } = makeHarness(t);
  noteReasoning(row);
  clock.nowMs = 1600;
  row.tick();
  assert.deepEqual(read(), { kind: 'generic', name: '', label: 'Preparing the next step…', elapsed: '' });
  clock.nowMs = 12000;
  row.tick();
  assert.equal(read().elapsed, '0:12', 'elapsed proves the call is still being written');
  clock.nowMs = 31000;
  row.tick();
  assert.equal(read().label, 'Still preparing the next step…');
  // The buffered call lands whole: the plan row takes over by name.
  notePlanInput(row, '{"title":"Ship it","steps":["a"]}', 33);
  assert.equal(read().name, 'Preparing the plan');
  assert.equal(read().label, 'Ship it');
});

test('silence after visible text or a tool result keeps the generic copy', (t) => {
  const { clock, row, read } = makeHarness(t);
  noteReasoning(row);
  noteEvent(row, 'delta', { content: 'Here is what I found.' });
  clock.nowMs = 1600;
  row.tick();
  assert.equal(read().label, ACTIVITY_COPY[0]);
  noteReasoning(row);
  noteEvent(row, 'tool_result', { toolCallId: 'call-read' });
  clock.nowMs = 3200;
  row.tick();
  assert.equal(read().label, ACTIVITY_COPY[0]);
  clock.nowMs = 40000;
  row.tick();
  assert.equal(read().label, ACTIVITY_COPY_LONG);
});

test('an early-return event after reasoning ends the next-step reading', (t) => {
  const { clock, row, read } = makeHarness(t);
  noteReasoning(row);
  // A new attempt's prefill start returns before the untyped path; the
  // silence after it is not the model writing its next step.
  noteEvent(row, 'thinking_status', {
    progress: { sessionId: 'session-1', requestId: 'stream-1', state: 'start', attemptId: 'attempt-2', sequence: 1 },
  });
  clock.nowMs = 1600;
  row.tick();
  assert.equal(read().label, ACTIVITY_COPY[0]);
});
