'use strict';

// Row 156: the find field lives in each pane's session bar (renderer-chat-search-overlay.js).
// Split from renderer-chat-search-overlay.test.js, which sits at the 600-line cap.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createChatSearchOverlay } = require('../renderer/chat/renderer-chat-search-overlay');
const { createSearchBar } = require('../renderer/inventory/search-bar');
const { createSearchHighlightController } = require('../renderer/chat/renderer-chat-search-highlight');
const { waitForUiState } = require('./helpers/wait-for-ui-state');

function shimCssHighlights(win) {
  win.CSS = win.CSS || {};
  win.CSS.highlights = new Map();
  win.Highlight = function Highlight() {
    this.ranges = Array.prototype.slice.call(arguments);
  };
}

const FIXTURE = ''
  + '<article class="chat-entry" data-message-id="m1" tabindex="-1"><div class="chat-bubble">Hello world</div></article>'
  + '<article class="chat-entry" data-message-id="m2" tabindex="-1"><div class="chat-bubble">A different message</div></article>'
  + '<article class="chat-entry" data-message-id="m3" tabindex="-1"><div class="chat-bubble">Goodbye hello</div></article>';


function paneHtml(paneId, focused, timelineId, timelineHtml) {
  return '<div class="chat-pane" data-pane-id="' + paneId + '" data-pane-focused="' + focused + '">'
    + '<div class="chat-timeline-utility-cluster" data-chat-node="chatTimelineUtilityCluster"><div class="session-bar-title">Title ' + paneId + '</div></div>'
    + '<div class="chat-thread-stage"><div id="' + timelineId + '" role="feed">' + timelineHtml + '</div></div>'
    + '</div>';
}

function buildBarEnv(options) {
  const opts = options || {};
  const dom = new JSDOM('<!DOCTYPE html><html><body><div class="chat-view" id="chatView" data-pane-count="2">'
    + paneHtml(0, opts.focusedPane === 1 ? 'false' : 'true', 'chatTimeline', FIXTURE)
    + paneHtml(1, opts.focusedPane === 1 ? 'true' : 'false', 'chatTimeline1', FIXTURE)
    + '</div><textarea id="composer"></textarea></body></html>');
  shimCssHighlights(dom.window);
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  const focusCalls = [];
  const make = (timelineId) => createChatSearchOverlay({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById(timelineId),
    keyboardController: { focusEntryAtIndex(idx) { focusCalls.push(idx); return true; }, syncTabindex() {} },
    searchBarFactory: createSearchBar,
    highlightFactory: createSearchHighlightController,
    ...(opts.overlayOptions || {}),
  });
  const overlays = [make('chatTimeline'), make('chatTimeline1')];
  overlays.forEach((overlay) => overlay.attach());
  const clusters = Array.from(dom.window.document.querySelectorAll('.chat-timeline-utility-cluster'));
  return { dom, overlays, clusters, focusCalls };
}

function typeQuery(dom, root, value) {
  const input = root.querySelector('.chat-search-bar-input');
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  return input;
}

function key(dom, target, init) {
  const event = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

test('row 156: the magnifier toggle in the bar opens and closes the field in place', (t) => {
  const { dom, overlays, clusters } = buildBarEnv();
  t.after(() => overlays.forEach((overlay) => overlay.dispose()));
  const toggle = clusters[0].querySelector('.chat-find-toggle');
  assert.ok(toggle, 'each pane bar gets its own toggle');
  assert.ok(clusters[1].querySelector('.chat-find-toggle'));
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(toggle.getAttribute('title'), 'Find in this chat (Ctrl+F)');

  toggle.click();
  assert.equal(overlays[0].isOpen(), true);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(clusters[0].hasAttribute('data-find-open'), true);
  const host = clusters[0].querySelector('.chat-find');
  assert.ok(host && !host.hidden, 'the field lives in the cluster');
  assert.ok(host.querySelector('.chat-search-bar'));
  assert.equal(dom.window.document.activeElement, host.querySelector('.chat-search-bar-input'));
  assert.equal(host.querySelector('.chat-search-bar-count').textContent, '', 'no count before a query');

  toggle.click();
  assert.equal(overlays[0].isOpen(), false);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(clusters[0].hasAttribute('data-find-open'), false);
  assert.equal(host.hidden, true);
});

test('row 156: Ctrl+F opens only the focused pane’s field and searches that pane', async (t) => {
  const { dom, overlays, clusters } = buildBarEnv({ focusedPane: 1 });
  t.after(() => overlays.forEach((overlay) => overlay.dispose()));
  key(dom, dom.window.document, { key: 'f', ctrlKey: true });
  assert.equal(overlays[0].isOpen(), false, 'pane 0 is not focused');
  assert.equal(overlays[1].isOpen(), true);
  assert.equal(clusters[0].querySelector('.chat-find'), null);
  typeQuery(dom, clusters[1], 'hello');
  const count = clusters[1].querySelector('.chat-search-bar-count');
  await waitForUiState(dom.window, () => count.textContent === '1 of 2');
  const ranges = dom.window.CSS.highlights.get('chat-search-match-1').ranges;
  const timeline1 = dom.window.document.getElementById('chatTimeline1');
  assert.ok(ranges.every((range) => timeline1.contains(range.startContainer)), 'matches come from pane 1');
});

test('row 156: a pane hosted in the IDE dock offers no find', (t) => {
  const { dom, overlays, clusters } = buildBarEnv();
  t.after(() => overlays.forEach((overlay) => overlay.dispose()));
  clusters[0].parentElement.classList.add('ide-chat-dock-body');
  key(dom, dom.window.document, { key: 'f', ctrlKey: true });
  assert.equal(overlays[0].isOpen(), false);
  overlays[0].open();
  assert.equal(overlays[0].isOpen(), false, 'open() is a no-op while hosted elsewhere');
});

test('row 156: closing keeps the query; a reopen paints in place and the first Enter reveals it', async (t) => {
  const { dom, overlays, clusters, focusCalls } = buildBarEnv();
  t.after(() => overlays.forEach((overlay) => overlay.dispose()));
  overlays[0].open();
  const input = typeQuery(dom, clusters[0], 'hello');
  const count = clusters[0].querySelector('.chat-search-bar-count');
  await waitForUiState(dom.window, () => count.textContent === '1 of 2');
  key(dom, input, { key: 'Enter' });
  assert.equal(count.textContent, '2 of 2');
  overlays[0].close();
  assert.equal(dom.window.CSS.highlights.has('chat-search-match'), false, 'close clears the paint');

  const before = focusCalls.length;
  key(dom, dom.window.document, { key: 'f', ctrlKey: true });
  assert.equal(input.value, 'hello', 'the query survives the close');
  assert.equal(input.selectionStart, 0);
  assert.equal(input.selectionEnd, 5, 'selected, so typing replaces it');
  assert.equal(count.textContent, '1 of 2');
  assert.equal(dom.window.CSS.highlights.get('chat-search-match').ranges.length, 2, 'painted on reopen');
  assert.equal(focusCalls.length, before, 'a reopen does not move the reader');

  key(dom, input, { key: 'Enter' });
  assert.equal(count.textContent, '1 of 2', 'the first Enter reveals the restored match');
  assert.equal(focusCalls.length, before + 1);
  key(dom, input, { key: 'Enter' });
  assert.equal(count.textContent, '2 of 2');
});

test('row 156: F3 and Shift+F3 step through matches from the timeline', async (t) => {
  const { dom, overlays, clusters } = buildBarEnv();
  t.after(() => overlays.forEach((overlay) => overlay.dispose()));
  overlays[0].open();
  typeQuery(dom, clusters[0], 'hello');
  const count = clusters[0].querySelector('.chat-search-bar-count');
  await waitForUiState(dom.window, () => count.textContent === '1 of 2');
  const entry = dom.window.document.querySelector('#chatTimeline .chat-entry');
  entry.focus();
  assert.equal(key(dom, entry, { key: 'F3' }).defaultPrevented, true);
  assert.equal(count.textContent, '2 of 2');
  key(dom, entry, { key: 'F3', shiftKey: true });
  assert.equal(count.textContent, '1 of 2');
  assert.equal(overlays[1].isOpen(), false, 'the unfocused pane ignores F3');
});

test('row 156: Esc from the timeline closes the field; Esc in the composer does not', (t) => {
  const { dom, overlays } = buildBarEnv();
  t.after(() => overlays.forEach((overlay) => overlay.dispose()));
  overlays[0].open();
  const composer = dom.window.document.getElementById('composer');
  composer.focus();
  key(dom, composer, { key: 'Escape' });
  assert.equal(overlays[0].isOpen(), true, 'a text input elsewhere keeps its Esc');
  const entry = dom.window.document.querySelector('#chatTimeline .chat-entry');
  entry.focus();
  key(dom, entry, { key: 'Escape' });
  assert.equal(overlays[0].isOpen(), false);
});

test('row 156: Ctrl+F over a one-line selection in the timeline seeds the query', async (t) => {
  const { dom, overlays, clusters } = buildBarEnv();
  t.after(() => overlays.forEach((overlay) => overlay.dispose()));
  const bubble = dom.window.document.querySelector('#chatTimeline [data-message-id="m2"] .chat-bubble');
  const range = dom.window.document.createRange();
  range.setStart(bubble.firstChild, 2);
  range.setEnd(bubble.firstChild, 11);
  dom.window.getSelection().removeAllRanges();
  dom.window.getSelection().addRange(range);
  key(dom, dom.window.document, { key: 'f', ctrlKey: true });
  const input = clusters[0].querySelector('.chat-search-bar-input');
  assert.equal(input.value, 'different');
  const count = clusters[0].querySelector('.chat-search-bar-count');
  await waitForUiState(dom.window, () => count.textContent === '1 of 1');
});

test('row 156: canonical search paints every mounted match, not only the current one', async (t) => {
  const messages = [
    { id: 'm1', role: 'assistant', content: 'Hello world' },
    { id: 'm2', role: 'assistant', content: 'A different message' },
    { id: 'm3', role: 'assistant', content: 'Goodbye hello' },
  ];
  const { dom, overlays, clusters } = buildBarEnv({ overlayOptions: {
    getCurrentSessionMessages: () => messages,
    getSessionTurnEventState: () => ({ turnEvents: [] }),
  } });
  t.after(() => overlays.forEach((overlay) => overlay.dispose()));
  overlays[0].open();
  typeQuery(dom, clusters[0], 'hello');
  const count = clusters[0].querySelector('.chat-search-bar-count');
  await waitForUiState(dom.window, () => count.textContent === '1 of 2');
  const painted = dom.window.CSS.highlights.get('chat-search-match');
  assert.ok(painted, 'the match paint is registered on the canonical path');
  assert.equal(painted.ranges.length, 2);
});

test('row 156 review: two open panes paint under their own names and ids', async (t) => {
  const { dom, overlays, clusters } = buildBarEnv();
  t.after(() => overlays.forEach((overlay) => overlay.dispose()));
  overlays[0].open();
  overlays[1].open();
  typeQuery(dom, clusters[0], 'hello');
  typeQuery(dom, clusters[1], 'world');
  const count1 = clusters[1].querySelector('.chat-search-bar-count');
  await waitForUiState(dom.window, () => count1.textContent === '1 of 1');
  const registry = dom.window.CSS.highlights;
  assert.equal(registry.get('chat-search-match').ranges.length, 2, 'pane 0 keeps its paint');
  assert.equal(registry.get('chat-search-match-1').ranges.length, 1);
  assert.notEqual(clusters[0].querySelector('input').id, clusters[1].querySelector('input').id);
  overlays[1].close();
  assert.equal(registry.has('chat-search-match-1'), false);
  assert.equal(registry.get('chat-search-match').ranges.length, 2, 'closing pane 1 leaves pane 0 painted');
});

test('row 156 review: Esc on a bar button closes; a blank query paints nothing', async (t) => {
  const { dom, overlays, clusters } = buildBarEnv();
  t.after(() => overlays.forEach((overlay) => overlay.dispose()));
  overlays[0].open();
  typeQuery(dom, clusters[0], '   ');
  await new Promise((resolve) => dom.window.setTimeout(resolve, 200));
  assert.equal(dom.window.CSS.highlights.has('chat-search-match'), false, 'spaces are no query');
  assert.equal(clusters[0].querySelector('.chat-search-bar-count').textContent, '');
  const caseButton = clusters[0].querySelector('.chat-search-bar-toggle-case');
  caseButton.focus();
  key(dom, caseButton, { key: 'Escape' });
  assert.equal(overlays[0].isOpen(), false);
});

test('row 156 review: F3 and Esc from the timeline leave focus in the timeline', async (t) => {
  const { dom, overlays, clusters } = buildBarEnv({ overlayOptions: {
    keyboardController: { focusEntryAtIndex(idx) { dom.window.document.querySelectorAll('#chatTimeline .chat-entry')[idx]?.focus(); return true; }, syncTabindex() {} },
  } });
  t.after(() => overlays.forEach((overlay) => overlay.dispose()));
  dom.window.document.getElementById('composer').focus();
  overlays[0].open();
  typeQuery(dom, clusters[0], 'hello');
  const count = clusters[0].querySelector('.chat-search-bar-count');
  await waitForUiState(dom.window, () => count.textContent === '1 of 2');
  const entry = dom.window.document.querySelector('#chatTimeline [data-message-id="m2"]');
  entry.focus();
  key(dom, entry, { key: 'F3' });
  assert.equal(count.textContent, '2 of 2');
  assert.ok(dom.window.document.activeElement.closest('#chatTimeline'), 'F3 does not pull focus into the field');
  const focused = dom.window.document.activeElement;
  key(dom, focused, { key: 'Escape' });
  assert.equal(overlays[0].isOpen(), false);
  assert.equal(dom.window.document.activeElement, focused, 'Esc from the timeline keeps focus there');
});
