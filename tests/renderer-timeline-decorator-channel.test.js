const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createTimelineDecoratorChannel } = require('../renderer/chat/renderer-timeline-decorator-channel');

function setupDom(t) {
  const dom = new JSDOM(
    '<!DOCTYPE html><div id="timeline">'
    + '<div class="chat-entry" data-message-id="m1" data-message-role="user"></div>'
    + '<div class="chat-entry" data-message-id="m2" data-message-role="assistant"></div>'
    + '</div>'
  );
  t.after(() => dom.window.close());
  return dom.window.document.getElementById('timeline');
}

test('decorator channel: dispatch runs each subscriber exactly once with one shared scope', (t) => {
  const chatTimeline = setupDom(t);
  const channel = createTimelineDecoratorChannel({ chatTimeline });
  const seenA = [];
  const seenB = [];
  channel.subscribe('a', (scope) => seenA.push(scope));
  channel.subscribe('b', (scope) => seenB.push(scope));
  const returned = channel.dispatch({ patchedMessageId: 'm1', decorateFollowUps: true, syncViewport: true });
  assert.equal(seenA.length, 1);
  assert.equal(seenB.length, 1);
  assert.equal(seenA[0], seenB[0], 'subscribers receive the same scope object by reference');
  assert.equal(seenA[0], returned);
});

test('decorator channel: patchedRoot is resolved exactly once per dispatch and shared by reference', (t) => {
  const chatTimeline = setupDom(t);
  let queryCount = 0;
  const realQuerySelector = chatTimeline.querySelector.bind(chatTimeline);
  chatTimeline.querySelector = (selector) => { queryCount += 1; return realQuerySelector(selector); };
  const channel = createTimelineDecoratorChannel({ chatTimeline });
  let rootA = 'unset';
  let rootB = 'unset';
  channel.subscribe('a', (scope) => { rootA = scope.patchedRoot; });
  channel.subscribe('b', (scope) => { rootB = scope.patchedRoot; });
  channel.dispatch({ patchedMessageId: 'm1', decorateFollowUps: true, syncViewport: true });
  assert.equal(queryCount, 1, 'patchedRoot resolved once regardless of subscriber count');
  assert.ok(rootA, 'resolved a patched node');
  assert.equal(rootA, rootB, 'the same patchedRoot is shared by reference (no per-subscriber re-resolve)');
  assert.equal(rootA.getAttribute('data-message-id'), 'm1');
});

test('decorator channel: a full render does no patched-root query and flags fullRender', (t) => {
  const chatTimeline = setupDom(t);
  let queryCount = 0;
  const realQuerySelector = chatTimeline.querySelector.bind(chatTimeline);
  chatTimeline.querySelector = (selector) => { queryCount += 1; return realQuerySelector(selector); };
  const channel = createTimelineDecoratorChannel({ chatTimeline });
  let captured = null;
  channel.subscribe('a', (scope) => { captured = scope; });
  channel.dispatch({ decorateFollowUps: true, syncViewport: true });
  assert.equal(queryCount, 0, 'no patched-root querySelector on a full render');
  assert.equal(captured.patchedRoot, null);
  assert.equal(captured.fullRender, true);
  assert.equal(captured.patchedMessageId, '');
});

test('decorator channel: scope carries the per-render opt flags for subscriber self-gating', (t) => {
  const chatTimeline = setupDom(t);
  const channel = createTimelineDecoratorChannel({ chatTimeline });
  let captured = null;
  channel.subscribe('a', (scope) => { captured = scope; });
  channel.dispatch({ patchedMessageId: 'm2', decorateFollowUps: false, syncViewport: true });
  assert.equal(captured.decorateFollowUps, false);
  assert.equal(captured.syncViewport, true);
  assert.equal(captured.patchedMessageId, 'm2');
});

test('decorator channel: a malformed/unsafe patchedMessageId resolves to a null patched root (no throw)', (t) => {
  const chatTimeline = setupDom(t);
  const channel = createTimelineDecoratorChannel({ chatTimeline });
  let captured = null;
  channel.subscribe('a', (scope) => { captured = scope; });
  channel.dispatch({ patchedMessageId: 'bad"id', syncViewport: true });
  assert.equal(captured.patchedRoot, null, 'a message id with a quote/backslash never reaches querySelector');
  assert.equal(captured.fullRender, false, 'still a scoped dispatch (patchedMessageId present)');
});

test('decorator channel: unsubscribe removes a subscriber from future dispatches', (t) => {
  const chatTimeline = setupDom(t);
  const channel = createTimelineDecoratorChannel({ chatTimeline });
  let count = 0;
  const unsubscribe = channel.subscribe('a', () => { count += 1; });
  channel.dispatch({ syncViewport: true });
  unsubscribe();
  channel.dispatch({ syncViewport: true });
  assert.equal(count, 1);
});
