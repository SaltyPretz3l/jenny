'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createLogicalScrollAnchorRegistry } = require('../renderer/chat/chat-scroll-utils');
const { createChatScrollCoordinator } = require('../renderer/chat/renderer-chat-scroll-coordinator');
const { createUnreadOrientationController } = require('../renderer/chat/renderer-chat-unread-orientation-utils');

function anchorHarness() {
  const dom = new JSDOM('<div id="scroll"><article class="chat-entry" data-message-id="m"><div data-row-id="volatile" data-row-kind="approval_gap"></div><div data-row-id="reading"></div></article></div>');
  const scroll = dom.window.document.getElementById('scroll');
  const article = scroll.firstElementChild;
  let growth = 0;
  scroll.scrollTop = 500;
  Object.defineProperties(scroll, { scrollHeight: { value: 2000 }, clientHeight: { value: 400 } });
  scroll.getBoundingClientRect = () => ({ top: 0, bottom: 400 });
  article.getBoundingClientRect = () => ({ top: -scroll.scrollTop, bottom: 1200 - scroll.scrollTop });
  function measureRows() {
    article.firstElementChild.getBoundingClientRect = () => ({ top: -scroll.scrollTop, bottom: 520 + growth - scroll.scrollTop });
    article.lastElementChild.getBoundingClientRect = () => ({ top: 520 + growth - scroll.scrollTop, bottom: 900 + growth - scroll.scrollTop });
  }
  measureRows();
  const registry = createLogicalScrollAnchorRegistry({ preferEntries: true, refineEntries: true });
  return { dom, scroll, article, registry, measureRows, grow(value) { growth = value; } };
}

for (const growth of [180, -80]) {
  test(`interior anchor compensates ${growth}px of intra-message reflow`, () => {
    const h = anchorHarness();
    try {
      h.registry.capture('reader', h.scroll);
      h.grow(growth);
      assert.equal(h.registry.restore('reader', h.scroll), 'logical');
      assert.equal(h.scroll.scrollTop, 500 + growth);
      assert.equal(h.article.lastElementChild.getBoundingClientRect().top, 20);
    } finally { h.registry.dispose(); h.dom.window.close(); }
  });
}

test('interior anchor re-resolves after a DOM rebuild and falls back to its article on removal', () => {
  const h = anchorHarness();
  try {
    h.registry.capture('reader', h.scroll);
    h.article.innerHTML = '<div data-row-id="volatile" data-row-kind="approval_gap"></div><div data-row-id="reading"></div>';
    h.measureRows();
    h.grow(100);
    assert.equal(h.registry.restore('reader', h.scroll), 'logical');
    assert.equal(h.scroll.scrollTop, 600);
    h.article.lastElementChild.remove();
    assert.equal(h.registry.restore('reader', h.scroll), 'parent');
    assert.equal(h.scroll.scrollTop, 500, 'parent fallback uses the original article offset, not the row offset');
  } finally { h.registry.dispose(); h.dom.window.close(); }
});

test('nested-only input never notifies live follow; actual outer movement does', () => {
  const dom = new JSDOM('<div id="scroll"><pre tabindex="0">output</pre></div>');
  const scroll = dom.window.document.getElementById('scroll');
  scroll.scrollTop = 600;
  Object.defineProperties(scroll, { scrollHeight: { value: 1400 }, clientHeight: { value: 400 } });
  let intentCount = 0;
  const coordinator = createChatScrollCoordinator({
    state: { ui: { followLatest: true } }, scrollContainer: scroll, window: dom.window,
    requestFrame: () => 1, cancelFrame() {},
  });
  coordinator.setViewportController({ noteScrollInputIntent() { intentCount += 1; } });
  try {
    coordinator.attach();
    scroll.firstElementChild.dispatchEvent(new dom.window.WheelEvent('wheel', { bubbles: true, deltaY: -50 }));
    assert.equal(intentCount, 0);
    assert.equal(coordinator.readSnapshot().userInitiated, false);
    scroll.scrollTop = 550;
    scroll.dispatchEvent(new dom.window.Event('scroll'));
    assert.equal(intentCount, 1);
    assert.equal(coordinator.readSnapshot().userInitiated, true);
  } finally { coordinator.dispose(); dom.window.close(); }
});

test('unread reveal failure retains retry state, successful retry clears it', () => {
  let succeeds = false;
  const state = { currentSessionId: 's', ui: { activeView: 'chat' } };
  const controller = createUnreadOrientationController({
    state, getCurrentSessionMessages: () => [{ id: 'm', role: 'assistant' }],
    getScrollMetrics: () => ({ scrollTop: 0, scrollHeight: 1000, clientHeight: 300 }),
    scrollMessageIntoView: () => succeeds,
  });
  try {
    controller.noteTimelineMessageCreated({ sessionId: 's', messageId: 'm', role: 'assistant', visible: true });
    assert.equal(controller.jumpToFirstUnread(), false);
    assert.equal(controller.getState().messageId, 'm');
    succeeds = true;
    assert.equal(controller.jumpToFirstUnread(), true);
    assert.equal(controller.getState().hasUnread, false);
  } finally { controller.dispose(); }
});
