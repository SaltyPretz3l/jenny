'use strict';

// Follow Jenny (row 121): the four-line tail next to the REAL writing row
// (renderer-stream-activity-row.js). The row keeps itself last in the reply and
// the tail sits under it; the two must not move each other on every fragment.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button');
const { createStreamActivityRow } = require('../renderer/chat/renderer-stream-activity-row');
const { createStreamActivityTail } = require('../renderer/chat/renderer-stream-activity-tail');

function makeHarness(t) {
  const dom = new JSDOM('<div id="chatTimeline"><article class="chat-entry assistant pending">'
    + '<div class="chat-message-content"><p>Writing the file now.</p></div></article></div>');
  const doc = dom.window.document;
  const timeline = doc.getElementById('chatTimeline');
  const mount = timeline.querySelector('.chat-message-content');
  const listeners = new Set();
  const call = {
    callId: 'call-1', sessionId: 'session-1', streamId: 'stream-1', mode: 'write', source: 'stream',
    phase: 'arriving', authoritative: false, tooLarge: false, path: 'demo/notes.js', content: '', edits: [],
  };
  const store = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    listCalls: () => [call],
    getCall: () => call,
  };
  let clock = 1000;
  const mounted = [];
  const row = createStreamActivityRow({
    getChatTimeline: () => timeline,
    isStreamLive: () => true,
    isSessionVisible: () => true,
    now: () => clock,
    setIntervalFn: null,
    onRowMounted: (sessionId, node) => mounted.push(node),
  });
  const tail = createStreamActivityTail({ store, getTimeline: () => timeline, isWorkspaceActive: () => false, actionButton });
  let args = '{"path":"demo/notes.js","content":"';
  // One forwarded fragment, in the order renderer-stream-handler.js delivers it: the row, then the store.
  function fragment(text) {
    clock += 100;
    args += text;
    call.content += text;
    row.noteStreamEvent({
      type: 'tool_input_delta', streamId: 'stream-1', sessionId: 'session-1', toolCallId: 'call-1',
      toolName: 'write_file', argumentsDelta: text, argumentsBytes: args.length,
    });
    for (const listener of [...listeners]) listener({ type: 'updated', call });
  }
  t.after(() => {
    tail.dispose();
    row.dispose();
    dom.window.close();
  });
  return { dom, mount, row, mounted, fragment, call, listeners, tick: () => { clock += 100; }, advance: (ms) => { clock += ms; } };
}

const order = (mount) => [...mount.children].map((node) => node.className.split(' ')[0]);

test('the row and its tail keep their places while fragments arrive', async (t) => {
  const { dom, mount, mounted, fragment } = makeHarness(t);
  fragment('// notes\\n');
  assert.deepEqual(order(mount), ['', 'turn-activity-row', 'turn-activity-tail']);
  const moves = [];
  const observer = new dom.window.MutationObserver((records) => {
    for (const record of records) if (record.target === mount) moves.push(record);
  });
  observer.observe(mount, { childList: true });
  for (let i = 0; i < 20; i += 1) fragment(`const line${i} = ${i};\\n`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  observer.disconnect();
  assert.equal(moves.length, 0, 'no node of the reply is moved by a fragment');
  assert.equal(mounted.length, 1, 'the viewport is asked to follow once, when the row lands');
  assert.deepEqual(order(mount), ['', 'turn-activity-row', 'turn-activity-tail']);
});

test('the row stays above its tail on the timer tick between two fragments', (t) => {
  const { mount, row, fragment, advance } = makeHarness(t);
  fragment('one\\n');
  fragment('two\\n');
  advance(50);
  row.tick(); // the row's own 500 ms tick: no store notification follows it
  assert.deepEqual(order(mount), ['', 'turn-activity-row', 'turn-activity-tail']);
});

test('a second file call in the same reply takes the row: one tail, one link, nothing moves', async (t) => {
  const { dom, mount, mounted, fragment, call, listeners, row, tick } = makeHarness(t);
  fragment('first file\\n');
  const second = { ...call, callId: 'call-2', path: 'demo/other.js', content: '' };
  const moves = [];
  let args = '{"path":"demo/other.js","content":"';
  for (let i = 0; i < 6; i += 1) {
    tick();
    args += `line ${i}\\n`;
    second.content += `line ${i}\n`;
    row.noteStreamEvent({
      type: 'tool_input_delta', streamId: 'stream-1', sessionId: 'session-1', toolCallId: 'call-2',
      toolName: 'write_file', argumentsDelta: `line ${i}\\n`, argumentsBytes: args.length,
    });
    for (const listener of [...listeners]) listener({ type: 'updated', call: second });
    if (i === 0) {
      new dom.window.MutationObserver((records) => moves.push(...records.filter((record) => record.target === mount)))
        .observe(mount, { childList: true });
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(mount.querySelectorAll('.turn-activity-tail').length, 1, 'one tail');
  assert.equal(mount.querySelector('.turn-activity-tail').getAttribute('data-turn-activity-tail'), 'call-2');
  assert.equal(mount.querySelectorAll('[data-turn-activity-watch]').length, 1, 'one link');
  assert.equal(mount.querySelector('[data-turn-activity-watch]').getAttribute('data-turn-activity-watch'), 'call-2');
  assert.equal(moves.length, 0, 'the second call moves nothing once it has the row');
  assert.equal(mounted.length, 1);
  assert.deepEqual(order(mount), ['', 'turn-activity-row', 'turn-activity-tail']);
});

test('real content after the tail still sends the row back to the end', (t) => {
  const { dom, mount, row, fragment, advance } = makeHarness(t);
  fragment('one\\n');
  mount.appendChild(dom.window.document.createElement('p'));
  advance(50);
  row.tick();
  assert.equal(mount.lastElementChild.className, 'turn-activity-row', 'the row is last again');
  fragment('two\\n');
  assert.deepEqual(order(mount), ['', '', 'turn-activity-row', 'turn-activity-tail']);
});
