'use strict';

// Activity-row hand-off (renderer-stream-activity-row.js retireOnTimelineWrite):
// a dismissed row stays until the render that replaces it writes the timeline,
// and leaves in that same task. Removing it first let a layout run on a tail
// that had lost the row but not yet gained the tool row, and that clamp
// snapped a followed view up by the row's height when a tool started.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { createStreamActivityRow, RETIRE_FALLBACK_MS } = require('../renderer/chat/renderer-stream-activity-row');

function makeHarness(t, overrides = {}) {
  const dom = new JSDOM('<div id="chatTimeline"><article class="chat-entry assistant pending"><div class="chat-message-content"><div class="turn-row-list"><div class="chat-row">hi</div></div></div></article></div>');
  const doc = dom.window.document;
  const timeline = doc.getElementById('chatTimeline');
  const clock = { nowMs: 0 };
  const timers = [];
  const row = createStreamActivityRow({
    getChatTimeline: () => timeline,
    isStreamLive: () => true,
    isSessionVisible: () => true,
    hasBlockingToolState: () => false,
    now: () => clock.nowMs,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    pickCopyIndex: () => 0,
    retireOnTimelineWrite: true,
    MutationObserverRef: dom.window.MutationObserver,
    setTimeoutFn: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
    clearTimeoutFn: (handle) => { if (timers[handle - 1]) timers[handle - 1].callback = null; },
    ...overrides,
  });
  t.after(() => {
    row.dispose();
    dom.window.close();
  });
  const noteEvent = (type) => row.noteStreamEvent({ type, streamId: 'stream-1', sessionId: 'session-1' });
  const showRow = () => {
    noteEvent('delta');
    clock.nowMs += 2000;
    row.tick();
    const node = [...timeline.querySelectorAll('.turn-activity-row')].pop();
    assert.ok(node, 'the row is showing');
    return node;
  };
  const runTimers = () => timers.splice(0).forEach((timer) => timer.callback?.());
  return { doc, timeline, row, noteEvent, showRow, runTimers, timers };
}

// Mutation observers deliver at the next microtask checkpoint, before layout.
const settleMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

test('a dismissed row stays until the paired render writes the timeline, then leaves with it', async (t) => {
  const { doc, timeline, noteEvent, showRow } = makeHarness(t);
  const node = showRow();

  noteEvent('tool_use');
  assert.equal(node.isConnected, true, 'no layout can see the tail without the row or its replacement');
  await settleMicrotasks();
  assert.equal(node.isConnected, true, 'nothing replaced it yet');

  const toolRow = doc.createElement('div');
  toolRow.className = 'chat-row';
  timeline.querySelector('.turn-row-list').appendChild(toolRow);
  await settleMicrotasks();
  assert.equal(node.isConnected, false, 'the row left in the render task');
  assert.equal(timeline.querySelectorAll('.turn-activity-row').length, 0);
});

test('writes inside the retiring row are not the render; the fallback removes it', async (t) => {
  const { doc, row, noteEvent, showRow, runTimers, timers } = makeHarness(t);
  const node = showRow();

  noteEvent('tool_use');
  const elapsed = node.querySelector('.turn-activity-elapsed');
  elapsed.appendChild(doc.createElement('span'));
  elapsed.textContent = '0:12';
  await settleMicrotasks();
  assert.equal(node.isConnected, true, 'the shared elapsed clock writing the row does not count');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, RETIRE_FALLBACK_MS);

  runTimers();
  assert.equal(node.isConnected, false, 'with no render the row still leaves');
  row.tick();
  assert.equal(node.isConnected, false);
});

test('renewed silence mounts a fresh row and retires the old one', async (t) => {
  const { timeline, row, noteEvent, showRow } = makeHarness(t);
  const first = showRow();
  noteEvent('delta');
  const second = showRow();

  await settleMicrotasks();
  assert.notEqual(second, first);
  assert.equal(first.isConnected, false, 'the fresh row landing is a timeline write');
  assert.deepEqual([...timeline.querySelectorAll('.turn-activity-row')], [second]);
  row.reset();
});

test('terminal events still remove the row at once, and dispose flushes a retiring one', async (t) => {
  const { row, noteEvent, showRow } = makeHarness(t);
  const node = showRow();
  noteEvent('complete');
  assert.equal(node.isConnected, false, 'terminal events untrack synchronously');

  const retiring = showRow();
  noteEvent('tool_use');
  assert.equal(retiring.isConnected, true);
  row.dispose();
  assert.equal(retiring.isConnected, false);
});

test('without the option the row is removed synchronously, as before', (t) => {
  const { noteEvent, showRow } = makeHarness(t, { retireOnTimelineWrite: false });
  const node = showRow();
  noteEvent('tool_use');
  assert.equal(node.isConnected, false);
});

test('the live stream handler opts in to the hand-off', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'chat', 'renderer-stream-handler.js'), 'utf8');
  const wiring = source.slice(source.indexOf('createStreamActivityRow({'));
  assert.match(wiring.slice(0, 600), /retireOnTimelineWrite: true/);
});
