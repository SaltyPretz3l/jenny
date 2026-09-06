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

function buildEnv(timelineHtml, extraOptions) {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatView">'
    + '  <div id="chatTimeline" role="feed">' + (timelineHtml || '') + '</div>'
    + '</div>'
    + '<textarea id="composer"></textarea>'
    + '</body></html>');
  shimCssHighlights(dom.window);
  // JSDOM doesn't implement scrollIntoView — stub on the prototype.
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};

  const focusCalls = [];
  const keyboardController = {
    focusEntryAtIndex(idx) { focusCalls.push(idx); return true; },
    syncTabindex() {},
  };

  const overlay = createChatSearchOverlay({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    chatView: dom.window.document.getElementById('chatView'),
    keyboardController,
    searchBarFactory: createSearchBar,
    highlightFactory: createSearchHighlightController,
    ...(extraOptions || {}),
  });
  return { dom, overlay, focusCalls };
}

const FIXTURE = ''
  + '<article class="chat-entry" data-message-id="m1" tabindex="-1"><div class="chat-bubble">Hello world</div></article>'
  + '<article class="chat-entry" data-message-id="m2" tabindex="-1"><div class="chat-bubble">A different message</div></article>'
  + '<article class="chat-entry" data-message-id="m3" tabindex="-1"><div class="chat-bubble">Goodbye hello</div></article>';

test('Ctrl+F opens the overlay and focuses the input (E6/F1)', () => {
  const { dom, overlay } = buildEnv(FIXTURE);
  overlay.attach();
  const ev = new dom.window.KeyboardEvent('keydown', {
    key: 'f', ctrlKey: true, bubbles: true, cancelable: true,
  });
  dom.window.document.dispatchEvent(ev);
  assert.equal(overlay.isOpen(), true);
  const input = dom.window.document.querySelector('.chat-search-bar-input');
  assert.ok(input);
  assert.equal(dom.window.document.activeElement, input);
});

test('Cmd+F (meta) also opens the overlay (E6/F1)', () => {
  const { dom, overlay } = buildEnv(FIXTURE);
  overlay.attach();
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'f', metaKey: true, bubbles: true, cancelable: true,
  }));
  assert.equal(overlay.isOpen(), true);
});

test('UIUX-020: Ctrl+F stands down while the Workspace IDE view is active', () => {
  let activeView = 'ide';
  const { dom, overlay } = buildEnv(FIXTURE, { getActiveView: () => activeView });
  overlay.attach();

  const ideEvent = new dom.window.KeyboardEvent('keydown', {
    key: 'f', ctrlKey: true, bubbles: true, cancelable: true,
  });
  dom.window.document.dispatchEvent(ideEvent);
  assert.equal(overlay.isOpen(), false, 'chat search must not steal Ctrl+F from Monaco/the IDE view');
  assert.equal(ideEvent.defaultPrevented, false, 'event left for the IDE/Monaco Ctrl+F handler');

  activeView = 'chat';
  const chatEvent = new dom.window.KeyboardEvent('keydown', {
    key: 'f', ctrlKey: true, bubbles: true, cancelable: true,
  });
  dom.window.document.dispatchEvent(chatEvent);
  assert.equal(overlay.isOpen(), true, 'chat search opens normally once the IDE is no longer active');
});

test('UIUX-020: Ctrl+F does not reopen when another handler already consumed the keystroke', () => {
  const { dom, overlay } = buildEnv(FIXTURE);
  overlay.attach();
  // Simulate Monaco (or any other in-page handler) already having handled
  // Ctrl+F on its own element before the event bubbles to document -- a
  // bubble-phase listener registered on the timeline fires before the
  // document-level chat-search listener.
  dom.window.document.getElementById('chatTimeline').addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'f') e.preventDefault();
  });
  const event = new dom.window.KeyboardEvent('keydown', {
    key: 'f', ctrlKey: true, bubbles: true, cancelable: true,
  });
  dom.window.document.getElementById('chatTimeline').dispatchEvent(event);
  assert.equal(overlay.isOpen(), false, 'chat search must respect an already-consumed Ctrl+F');
});

test('typing a query then waiting debounce highlights matches (F1)', async () => {
  const { dom, overlay } = buildEnv(FIXTURE);
  overlay.attach();
  overlay.open();
  const input = dom.window.document.querySelector('.chat-search-bar-input');
  input.value = 'hello';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await waitForUiState(dom.window, () => dom.window.CSS.highlights.get('chat-search-match')?.ranges.length === 2);
  const highlight = dom.window.CSS.highlights.get('chat-search-match');
  assert.ok(highlight, 'highlights registry should have the all-matches entry');
  assert.equal(highlight.ranges.length, 2);
  const count = dom.window.document.querySelector('.chat-search-bar-count');
  assert.equal(count.textContent, '1 of 2');
});

test('Enter on input advances to next match and updates current highlight (F1)', async () => {
  const { dom, overlay, focusCalls } = buildEnv(FIXTURE);
  overlay.attach();
  overlay.open();
  const input = dom.window.document.querySelector('.chat-search-bar-input');
  input.value = 'hello';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await waitForUiState(dom.window, () => focusCalls.length >= 1);
  // First match auto-applied; expect entryIndex 0 in focus calls.
  assert.deepEqual(focusCalls, [0]);
  // Press Enter → next.
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.deepEqual(focusCalls, [0, 2], 'm3 is entry index 2 (m1=0, m2=1, m3=2)');
  const count = dom.window.document.querySelector('.chat-search-bar-count');
  assert.equal(count.textContent, '2 of 2');
});

test('Shift+Enter wraps backward (F1)', async () => {
  const { dom, overlay, focusCalls } = buildEnv(FIXTURE);
  overlay.attach();
  overlay.open();
  const input = dom.window.document.querySelector('.chat-search-bar-input');
  input.value = 'hello';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await waitForUiState(dom.window, () => dom.window.CSS.highlights.get('chat-search-match')?.ranges.length === 2);
  // From index 0, Shift+Enter wraps to last (index 1 of matches → entryIndex 2).
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
  assert.deepEqual(focusCalls, [0, 2]);
});

test('Esc on input closes the overlay and clears highlights (E6/F1)', async () => {
  const { dom, overlay } = buildEnv(FIXTURE);
  overlay.attach();
  overlay.open();
  const input = dom.window.document.querySelector('.chat-search-bar-input');
  input.value = 'hello';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await waitForUiState(dom.window, () => dom.window.CSS.highlights.get('chat-search-match')?.ranges.length === 2);
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(overlay.isOpen(), false);
  assert.equal(dom.window.CSS.highlights.has('chat-search-match'), false);
});

test('Esc restores focus to the previously-focused element (E6/F1)', () => {
  const { dom, overlay } = buildEnv(FIXTURE);
  overlay.attach();
  const composer = dom.window.document.getElementById('composer');
  composer.focus();
  assert.equal(dom.window.document.activeElement, composer);
  overlay.open();
  overlay.close();
  assert.equal(dom.window.document.activeElement, composer, 'focus should restore to composer');
});

test('Esc falls back to timeline focus when the saved focus node detached', () => {
  const { dom, overlay } = buildEnv(FIXTURE);
  overlay.attach();
  const composer = dom.window.document.getElementById('composer');
  composer.focus();
  overlay.open();
  composer.remove();

  overlay.close();

  const timeline = dom.window.document.getElementById('chatTimeline');
  assert.equal(dom.window.document.activeElement, timeline);
  assert.equal(timeline.getAttribute('tabindex'), '-1');
});

test('toggle-case re-scans with case-sensitive matching (F1)', async () => {
  const html = '<article class="chat-entry" data-message-id="m1" tabindex="-1"><div class="chat-bubble">Hello hello HELLO</div></article>';
  const { dom, overlay } = buildEnv(html);
  overlay.attach();
  overlay.open();
  const input = dom.window.document.querySelector('.chat-search-bar-input');
  input.value = 'hello';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await waitForUiState(dom.window, () => dom.window.CSS.highlights.get('chat-search-match')?.ranges.length === 3);
  assert.equal(dom.window.CSS.highlights.get('chat-search-match').ranges.length, 3);
  // Toggle case-sensitive on
  dom.window.document.querySelector('.chat-search-bar-toggle-case').click();
  // No debounce on toggle — synchronous rescan
  assert.equal(dom.window.CSS.highlights.get('chat-search-match').ranges.length, 1);
});

test('streaming bubble matches are skipped (F1)', async () => {
  const html = ''
    + '<article class="chat-entry" data-message-id="m1" tabindex="-1"><div class="chat-bubble">Hello finalized</div></article>'
    + '<article class="chat-entry" data-message-id="m2" tabindex="-1"><div class="chat-bubble chat-bubble-streaming">Hello streaming</div></article>';
  const { dom, overlay } = buildEnv(html);
  overlay.attach();
  overlay.open();
  const input = dom.window.document.querySelector('.chat-search-bar-input');
  input.value = 'hello';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await waitForUiState(dom.window, () => dom.window.CSS.highlights.get('chat-search-match')?.ranges.length === 1);
  assert.equal(dom.window.CSS.highlights.get('chat-search-match').ranges.length, 1);
});

test('open() lazily creates the host inside chatView before chatTimeline (E6)', () => {
  const { dom, overlay } = buildEnv(FIXTURE);
  assert.equal(dom.window.document.getElementById('chatSearchOverlayHost'), null);
  overlay.attach();
  overlay.open();
  const host = dom.window.document.getElementById('chatSearchOverlayHost');
  assert.ok(host);
  const timeline = dom.window.document.getElementById('chatTimeline');
  assert.equal(host.nextElementSibling, timeline, 'host should sit immediately before #chatTimeline');
  assert.equal(host.parentElement.id, 'chatView');
});

test('reopening Ctrl+F while already open just refocuses the input (E6)', () => {
  const { dom, overlay } = buildEnv(FIXTURE);
  overlay.attach();
  overlay.open();
  const input = dom.window.document.querySelector('.chat-search-bar-input');
  input.value = 'pre-existing';
  input.blur();
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'f', ctrlKey: true, bubbles: true, cancelable: true,
  }));
  assert.equal(dom.window.document.activeElement, input);
});

test('Ctrl+F is scoped to Chat and does not intercept Settings or other surfaces', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatView"><div id="chatTimeline" role="feed">' + FIXTURE + '</div></div>'
    + '</body></html>');
  shimCssHighlights(dom.window);
  let activeView = 'settings';
  const overlay = createChatSearchOverlay({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    chatView: dom.window.document.getElementById('chatView'),
    keyboardController: { focusEntryAtIndex() { return true; }, syncTabindex() {} },
    searchBarFactory: createSearchBar,
    highlightFactory: createSearchHighlightController,
    getActiveView: () => activeView,
  });
  overlay.attach();
  const outside = new dom.window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
  dom.window.document.dispatchEvent(outside);
  assert.equal(outside.defaultPrevented, false);
  assert.equal(overlay.isOpen(), false);
  activeView = 'chat';
  const inside = new dom.window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
  dom.window.document.dispatchEvent(inside);
  assert.equal(inside.defaultPrevented, true);
  assert.equal(overlay.isOpen(), true);
  overlay.dispose();
});

test('search keeps virtualization active across open, close, and dispose', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatView">'
    + '  <div id="chatTimeline" role="feed">' + FIXTURE + '</div>'
    + '</div></body></html>');
  shimCssHighlights(dom.window);
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};

  const calls = [];
  const virtualizer = {
    pause(reason) { calls.push(['pause', reason]); },
    resume(reason) { calls.push(['resume', reason]); },
  };
  const overlay = createChatSearchOverlay({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    chatView: dom.window.document.getElementById('chatView'),
    keyboardController: { focusEntryAtIndex() { return true; }, syncTabindex() {} },
    searchBarFactory: createSearchBar,
    highlightFactory: createSearchHighlightController,
    virtualizer,
  });
  overlay.attach();

  overlay.open();
  overlay.close();
  overlay.dispose();
  assert.deepEqual(calls, [], 'search must not synchronously remount the transcript');
});

test('B5: search overlay tolerates a missing virtualizer (no plumbing required)', () => {
  // Most production wiring will pass a real virtualizer; small-conversation
  // sessions or tests without B5 must still work — none of the open/close
  // paths should throw when `virtualizer` is undefined.
  const { dom, overlay } = buildEnv(FIXTURE);
  overlay.attach();
  assert.doesNotThrow(() => overlay.open());
  assert.equal(overlay.isOpen(), true, 'overlay should be open after open() with no virtualizer');
  assert.doesNotThrow(() => overlay.close());
  assert.equal(overlay.isOpen(), false, 'overlay should be closed after close() with no virtualizer');
  dom.window.close?.();
});

test('canonical search mounts only the selected virtualized message', async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatView">'
    + '  <div id="chatTimeline" role="feed"><article class="chat-entry" data-message-id="m2" data-virtualized="true"><div class="chat-entry-virtualized"></div></article></div>'
    + '</div></body></html>');
  shimCssHighlights(dom.window);
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};

  const calls = [];
  const timeline = dom.window.document.getElementById('chatTimeline');
  const virtualizer = {
    ensureMountedForMessageId(messageId) {
      calls.push(messageId);
      const entry = timeline.querySelector('[data-message-id="m2"]');
      entry.removeAttribute('data-virtualized');
      entry.innerHTML = '<div class="chat-bubble">virtual needle</div>';
      return true;
    },
  };
  const overlay = createChatSearchOverlay({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    chatView: dom.window.document.getElementById('chatView'),
    keyboardController: { focusEntryAtIndex() { return true; }, syncTabindex() {} },
    searchBarFactory: createSearchBar,
    highlightFactory: createSearchHighlightController,
    virtualizer,
    getCurrentSessionMessages: () => [{ id: 'm2', role: 'assistant', content: 'virtual needle' }],
    getSessionTurnEventState: () => ({ turnEvents: [] }),
  });
  overlay.attach();

  overlay.open();
  const input = dom.window.document.querySelector('.chat-search-bar-input');
  input.value = 'needle';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await waitForUiState(dom.window, () => calls.length > 0);
  assert.deepEqual(calls, ['m2']);
  assert.equal(timeline.querySelector('[data-message-id="m2"]').hasAttribute('data-virtualized'), false);
  overlay.dispose();
});

test('paired-result search mounts only the selected tool row and restores prior selections', async (t) => {
  const toolArticle = (messageId, callId, rowKey) => '<article class="chat-entry" data-message-id="' + messageId + '" tabindex="-1">'
    + '<div class="tool-call-row tool-call-row--minimal" data-tool-call-id="' + callId + '" data-tool-row-key="' + rowKey + '" data-expanded="false" data-tool-details-materialized="false">'
    + '<div data-tool-row-toggle="true" data-tool-row-key="' + rowKey + '" role="button" aria-expanded="false"></div>'
    + '<div class="tool-call-row-body" inert></div></div></article>';
  const html = toolArticle('m-tool-a', 'call-a', 'row-key-a') + toolArticle('m-tool-b', 'call-b', 'row-key-b');
  const expansion = new Map();
  const previousToolUtils = globalThis.rendererTurnRowToolRenderUtils;
  globalThis.rendererTurnRowToolRenderUtils = {
    setToolRowExpansion(rowKey, value) { expansion.set(rowKey, value); },
  };
  t.after(() => {
    if (previousToolUtils === undefined) delete globalThis.rendererTurnRowToolRenderUtils;
    else globalThis.rendererTurnRowToolRenderUtils = previousToolUtils;
  });
  let renders = 0;
  const { dom, overlay } = buildEnv(html, {
    getCurrentSessionMessages: () => [
      { id: 'u-a', role: 'user', content: 'first' },
      { id: 'm-tool-a', role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'call-a', input_json: '{}' } },
      { id: 'm-result-a', role: 'assistant', kind: 'tool_result', tool_result: { call_id: 'call-a', output_text: 'needle alpha' } },
      { id: 'u-b', role: 'user', content: 'second' },
      { id: 'm-tool-b', role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'call-b', input_json: '{}' } },
      { id: 'm-result-b', role: 'assistant', kind: 'tool_result', tool_result: { call_id: 'call-b', output_text: 'needle beta' } },
    ],
    getSessionTurnEventState: () => ({ turnEvents: [] }),
    renderAll() {
      renders += 1;
      for (const [rowKey, text] of [['row-key-a', 'needle alpha'], ['row-key-b', 'needle beta']]) {
        const row = dom.window.document.querySelector('[data-tool-row-key="' + rowKey + '"]');
        const expanded = expansion.get(rowKey) === true;
        row.setAttribute('data-expanded', expanded ? 'true' : 'false');
        row.setAttribute('data-tool-details-materialized', expanded ? 'true' : 'false');
        row.querySelector('.tool-call-row-body').innerHTML = expanded ? '<span>' + text + '</span>' : '';
      }
    },
  });
  overlay.attach();
  overlay.open();
  const input = dom.window.document.querySelector('.chat-search-bar-input');
  input.value = 'needle';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await waitForUiState(dom.window, () => expansion.get('row-key-a') === true);
  assert.equal(renders, 1);

  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await waitForUiState(dom.window, () => expansion.get('row-key-b') === true);
  assert.equal(expansion.get('row-key-a'), false);
  assert.equal(renders, 2);
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(dom.window.document.querySelector('.chat-search-bar-count').textContent, '2 of 2');
  assert.equal(expansion.get('row-key-b'), true, 'mutation rescan must retain the selected canonical match');

  overlay.close();
  assert.equal(expansion.get('row-key-b'), false);
  assert.equal(renders, 3);
});

test('open search overlay rescans after timeline DOM changes while visible', async () => {
  const { dom, overlay } = buildEnv(
    '<article class="chat-entry" data-message-id="m1" tabindex="-1"><div class="chat-bubble">hello first</div></article>'
  );
  overlay.attach();
  overlay.open();
  const input = dom.window.document.querySelector('.chat-search-bar-input');
  input.value = 'hello';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await waitForUiState(dom.window, () => dom.window.CSS.highlights.get('chat-search-match')?.ranges.length === 1);
  assert.equal(dom.window.CSS.highlights.get('chat-search-match').ranges.length, 1);

  const timeline = dom.window.document.getElementById('chatTimeline');
  timeline.insertAdjacentHTML(
    'beforeend',
    '<article class="chat-entry" data-message-id="m2" tabindex="-1"><div class="chat-bubble">hello second</div></article>'
  );
  await waitForUiState(dom.window, () => dom.window.CSS.highlights.get('chat-search-match')?.ranges.length === 2);

  assert.equal(dom.window.CSS.highlights.get('chat-search-match').ranges.length, 2);
});

test('open search overlay does not rescan timeline mutations until a query is active', async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatView">'
    + '  <div id="chatTimeline" role="feed">' + FIXTURE + '</div>'
    + '</div></body></html>');
  let scanCount = 0;
  const overlay = createChatSearchOverlay({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    chatView: dom.window.document.getElementById('chatView'),
    keyboardController: { focusEntryAtIndex() { return true; }, syncTabindex() {} },
    searchBarFactory: createSearchBar,
    highlightFactory: () => ({
      scan() { scanCount += 1; return []; },
      clear() {},
      getMatches() { return []; },
      getCurrentIndex() { return -1; },
      setCurrentIndex() { return null; },
    }),
  });
  overlay.attach();
  overlay.open();

  dom.window.document.getElementById('chatTimeline').insertAdjacentHTML(
    'beforeend',
    '<article class="chat-entry" data-message-id="m4" tabindex="-1"><div class="chat-bubble">hello idle</div></article>'
  );
  // Negative assertion: prove NO rescan fires when no query is active. A poll-
  // until-condition cannot verify an absence, so a real wait (longer than the
  // 120ms debounce) is the correct tool here — give any erroneous rescan time to
  // fire, then confirm it did not.
  await new Promise((r) => setTimeout(r, 180));

  assert.equal(scanCount, 0);
});

// Scroll-program W2b: an over-cap query must surface the omitted state in the
// bar (legacy DOM path — this harness supplies no canonical documents).
test('an over-cap query surfaces the omitted-matches state in the search bar', async (t) => {
  const bubble = Array(520).fill('needle').join(' ');
  const fixture = `<article class="chat-entry" data-message-id="m1" tabindex="-1"><div class="chat-bubble">${bubble}</div></article>`;
  const { dom, overlay } = buildEnv(fixture);
  t.after(() => overlay.dispose());
  overlay.attach();
  overlay.open();
  const input = dom.window.document.querySelector('.chat-search-bar-input');
  input.value = 'needle';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const count = dom.window.document.querySelector('.chat-search-bar-count');
  await waitForUiState(dom.window, () => /of/.test(count.textContent));

  assert.equal(count.textContent, '1 of 500+', 'the bar reports the floor, not a fabricated exact total');
  overlay.dispose();
});
