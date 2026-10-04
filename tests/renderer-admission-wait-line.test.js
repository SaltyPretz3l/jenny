'use strict';

// Gate F20 (owner option A): a send held behind another chat's approval showed
// only its user bubble for minutes. A quiet line where the reply will appear
// names the chat it waits for and links to it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { syncAdmissionWaitLine, waitText } = require('../renderer/chat/renderer-admission-wait-line');

function harness(t) {
  const dom = new JSDOM('<div id="chatTimeline"><article class="chat-entry user">Say hello in five words.</article></div>');
  t.after(() => dom.window.close());
  const timeline = dom.window.document.getElementById('chatTimeline');
  const state = {
    sessions: [{ id: 'session_a', title: 'Use the run_command' }, { id: 'session_b', title: 'Hello' }],
    pendingToolApprovals: new Map(),
  };
  const opened = [];
  const sync = (rows) => syncAdmissionWaitLine({ timeline, state, rows, onOpenChat: (id) => opened.push(id) });
  return { dom, timeline, state, opened, sync };
}

const held = (blockingSessionId = 'session_a') => [{ key: 'k1', status: 'pending', wait: { reason: 'model_busy', blockingSessionId } }];

test('a send held by a chat paused on an approval says so after the user bubble, and links to it', (t) => {
  const { timeline, state, opened, sync, dom } = harness(t);
  state.pendingToolApprovals.set('call_1', { callId: 'call_1', sessionId: 'session_a' });
  const line = sync(held());
  assert.equal(timeline.lastElementChild, line);
  assert.equal(line.getAttribute('role'), 'status');
  assert.equal(line.getAttribute('data-turn-activity-kind'), 'waiting');
  assert.equal(line.textContent, 'Waiting for another chat: "Use the run_command" is paused on your approval.');
  const link = line.querySelector('.turn-activity-wait-link');
  link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(opened, ['session_a']);
});

test('a chat still replying is named without the approval; an unknown chat is not linked', (t) => {
  const { sync } = harness(t);
  assert.equal(sync(held()).textContent, 'Waiting for "Use the run_command" to finish its reply.');
  const unknown = sync(held('session_gone'));
  assert.equal(unknown.textContent, 'Waiting for another chat to finish its reply.');
  assert.equal(unknown.querySelector('.turn-activity-wait-link'), null);
});

test('the line stays one node across renders, moves back to the tail, and goes when the wait ends', (t) => {
  const { timeline, sync, dom } = harness(t);
  const first = sync(held());
  const reply = dom.window.document.createElement('article');
  timeline.appendChild(reply);
  assert.equal(sync(held()), first);
  assert.equal(timeline.lastElementChild, first);
  // Admitted work is no longer pending: no wait, no line.
  assert.equal(sync([{ key: 'k1', status: 'running', wait: null }]), null);
  assert.equal(timeline.querySelector('[data-admission-wait-line]'), null);
});

test('only a wait on another chat shows here: unconfirmed cleanup stays with the strip and its Restart', (t) => {
  const { timeline, sync } = harness(t);
  assert.equal(sync([{ key: 'k1', status: 'pending', wait: { reason: 'cleanup_unconfirmed', blockingSessionId: 'session_a' } }]), null);
  assert.equal(timeline.querySelector('[data-admission-wait-line]'), null);
});

// Owner gate P3: the blocking chat's untitled placeholder ("New Chat") is no
// name at all; quoting it read as a real title. Placeholders read as untitled.
test('a blocking chat still on its placeholder title is not quoted by name', (t) => {
  const { state, sync } = harness(t);
  state.sessions = [{ id: 'session_a', title: 'New Chat' }, { id: 'session_c', title: '  ' }];
  state.pendingToolApprovals.set('call_1', { callId: 'call_1', sessionId: 'session_a' });
  const line = sync(held());
  assert.equal(line.textContent, 'Waiting for another chat that is paused on your approval.');
  assert.equal(line.querySelector('.turn-activity-wait-link'), null);
  assert.equal(waitText(state, 'session_c'), 'Waiting for another chat to finish its reply.');
  state.pendingToolApprovals.clear();
  assert.equal(waitText(state, 'session_a'), 'Waiting for another chat to finish its reply.');
});

test('the queue strip reads the same words', () => {
  const state = { sessions: [{ id: 'session_a', title: 'Draft' }], pendingToolApprovals: new Map([['c', { sessionId: 'session_a' }]]) };
  assert.equal(waitText(state, 'session_a'), 'Waiting for another chat: "Draft" is paused on your approval.');
});
