const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createChatSearchOverlay } = require('../renderer/chat/renderer-chat-search-overlay');
const { createSearchBar } = require('../renderer/inventory/search-bar');
const { createSearchHighlightController } = require('../renderer/chat/renderer-chat-search-highlight');
const { waitForUiState } = require('./helpers/wait-for-ui-state');

// Scroll-program W0 red suite (fixed in W1a): search navigation today scrolls
// with a raw entryEl.scrollIntoView and never releases follow-latest, so a
// search jump taken between turns leaves follow latched and the next assistant
// reply yanks the reader back to the bottom. W1a routes both navigation call
// sites (the legacy DOM-scan path and the canonical messageId path) through the
// shared viewport reveal helper (dep `viewportReveal`), which releases follow
// and reports the navigation reason for attribution + telemetry.
//
// Sibling file to renderer-chat-search-overlay.test.js: appending there would
// push it past the 600-line test-file ratchet.

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

function createFollowReveal() {
  // Stands in for the W1a reveal helper: revealElement must be invoked with
  // followLatest === false (releasing follow) and a non-empty navigation reason.
  const uiState = { ui: { followLatest: true } };
  const revealCalls = [];
  const viewportReveal = {
    revealElement(element, options) {
      revealCalls.push({
        followLatest: options ? options.followLatest : undefined,
        reason: options ? options.reason : undefined,
        behavior: options ? options.behavior : undefined,
      });
      if (options && options.followLatest === false) {
        uiState.ui.followLatest = false;
      }
      return true;
    },
  };
  return { uiState, revealCalls, viewportReveal };
}

function buildEnv(timelineHtml, extraOptions) {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatView">'
    + '  <div id="chatTimeline" role="feed">' + (timelineHtml || '') + '</div>'
    + '</div>'
    + '<textarea id="composer"></textarea>'
    + '</body></html>');
  shimCssHighlights(dom.window);
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};

  const overlay = createChatSearchOverlay({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    chatView: dom.window.document.getElementById('chatView'),
    keyboardController: { focusEntryAtIndex() { return true; }, syncTabindex() {} },
    searchBarFactory: createSearchBar,
    highlightFactory: createSearchHighlightController,
    ...(extraOptions || {}),
  });
  return { dom, overlay };
}

test('applying a search match releases follow-latest (legacy DOM-scan path)', async (t) => {
  const follow = createFollowReveal();
  const { dom, overlay } = buildEnv(FIXTURE, { viewportReveal: follow.viewportReveal });
  t.after(() => overlay.dispose());
  overlay.attach();
  overlay.open();
  const input = dom.window.document.querySelector('.chat-search-bar-input');
  input.value = 'hello';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await waitForUiState(dom.window, () => dom.window.CSS.highlights.get('chat-search-match')?.ranges.length === 2);

  assert.equal(
    follow.uiState.ui.followLatest,
    false,
    'auto-applying the first search match is a navigation and must release follow'
  );
  assert.ok(follow.revealCalls.length >= 1, 'the search jump must route through the reveal helper');
  assert.equal(follow.revealCalls[0].followLatest, false);
  assert.ok(
    typeof follow.revealCalls[0].reason === 'string' && follow.revealCalls[0].reason.length > 0,
    'the reveal call must carry a navigation reason for attribution + telemetry'
  );
  assert.equal(
    follow.revealCalls[0].behavior,
    'auto',
    'search reveals are instant: rescan re-applies the current match every keystroke/mutation debounce, and restarting a smooth animation each 120ms judders (pre-land M1)'
  );
});

test('search next navigation releases follow-latest even after follow re-latches', async (t) => {
  const follow = createFollowReveal();
  const { dom, overlay } = buildEnv(FIXTURE, { viewportReveal: follow.viewportReveal });
  t.after(() => overlay.dispose());
  overlay.attach();
  overlay.open();
  const input = dom.window.document.querySelector('.chat-search-bar-input');
  input.value = 'hello';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await waitForUiState(dom.window, () => dom.window.CSS.highlights.get('chat-search-match')?.ranges.length === 2);

  // Reader returns to the bottom between navigations; follow re-latches.
  follow.uiState.ui.followLatest = true;
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

  assert.equal(
    follow.uiState.ui.followLatest,
    false,
    'search-next must release follow so the next stream sync cannot yank the reader'
  );
});

test('canonical search navigation releases follow-latest (messageId path)', async (t) => {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatView">'
    + '  <div id="chatTimeline" role="feed"><article class="chat-entry" data-message-id="m2" data-virtualized="true"><div class="chat-entry-virtualized"></div></article></div>'
    + '</div></body></html>');
  shimCssHighlights(dom.window);
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};

  const follow = createFollowReveal();
  const mountCalls = [];
  const timeline = dom.window.document.getElementById('chatTimeline');
  const virtualizer = {
    // Idempotent on purpose: a failed-assert teardown path must not leave a
    // mutation -> rescan -> mutation cycle spinning behind the test.
    ensureMountedForMessageId(messageId) {
      mountCalls.push(messageId);
      const entry = timeline.querySelector('[data-message-id="m2"]');
      if (entry.hasAttribute('data-virtualized')) {
        entry.removeAttribute('data-virtualized');
        entry.innerHTML = '<div class="chat-bubble">virtual needle</div>';
      }
      return true;
    },
  };
  const overlay = createChatSearchOverlay({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: timeline,
    chatView: dom.window.document.getElementById('chatView'),
    keyboardController: { focusEntryAtIndex() { return true; }, syncTabindex() {} },
    searchBarFactory: createSearchBar,
    highlightFactory: createSearchHighlightController,
    virtualizer,
    viewportReveal: follow.viewportReveal,
    getCurrentSessionMessages: () => [{ id: 'm2', role: 'assistant', content: 'virtual needle' }],
    getSessionTurnEventState: () => ({ turnEvents: [] }),
  });
  t.after(() => overlay.dispose());
  overlay.attach();
  overlay.open();
  const input = dom.window.document.querySelector('.chat-search-bar-input');
  input.value = 'needle';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await waitForUiState(dom.window, () => mountCalls.length > 0);

  assert.equal(
    follow.uiState.ui.followLatest,
    false,
    'the canonical (messageId) navigation path must release follow like the legacy path'
  );
  assert.ok(follow.revealCalls.length >= 1, 'the canonical jump must route through the reveal helper');
  assert.equal(follow.revealCalls[0].followLatest, false);
});
