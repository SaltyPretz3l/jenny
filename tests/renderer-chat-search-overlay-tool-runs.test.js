'use strict';

// Search overlay against real Answers row markup (NEXT_STEPS row 21): the
// .chat-row wrapper and a collapsed tool run around the matched tool row.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createChatSearchOverlay } = require('../renderer/chat/renderer-chat-search-overlay');
const { createSearchBar } = require('../renderer/inventory/search-bar');
const { createSearchHighlightController } = require('../renderer/chat/renderer-chat-search-highlight');
const { waitForUiState } = require('./helpers/wait-for-ui-state');

function buildEnv(timelineHtml, extraOptions) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="chatView"><div id="chatTimeline" role="feed">'
    + timelineHtml + '</div></div><textarea id="composer"></textarea></body></html>');
  dom.window.CSS = dom.window.CSS || {};
  dom.window.CSS.highlights = new Map();
  dom.window.Highlight = function Highlight() { this.ranges = Array.prototype.slice.call(arguments); };
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

test('a tool-detail hit inside a collapsed Answers run opens the run and the row, then restores both', async (t) => {
  const runKey = 'session=s|turn=t|row=tool_run|call=call-a';
  const member = (callId, rowKey) => '<div class="chat-row" data-run-id="call-a" data-run-expanded="false" data-run-member="step" data-row-id="t:tool_call:' + callId + '" data-row-kind="tool_call" data-tool-call-id="' + callId + '">'
    + '<div class="tool-call-row tool-call-row--minimal" data-tool-call-id="' + callId + '" data-tool-row-key="' + rowKey + '" data-expanded="false" data-tool-details-materialized="false">'
    + '<div data-tool-row-toggle="true" data-tool-row-key="' + rowKey + '" role="button" aria-expanded="false"></div>'
    + '<div class="tool-call-row-body" inert></div></div></div>';
  const html = '<article class="chat-entry" data-message-id="m-tool-a" tabindex="-1"><div class="turn-row-list">'
    + '<div class="chat-row" data-row-id="t:tool_run:call-a" data-row-kind="tool_run" data-run-id="call-a" data-run-expanded="false">'
    + '<div class="tool-run-row"><div class="tool-run-toggle" role="button" data-tool-run-toggle="true" data-tool-run-key="' + runKey + '" aria-expanded="false"></div></div></div>'
    + member('call-a', 'row-key-a') + member('call-b', 'row-key-b') + '</div></article>';
  const expansion = new Map();
  const previousToolUtils = globalThis.rendererTurnRowToolRenderUtils;
  globalThis.rendererTurnRowToolRenderUtils = { setToolRowExpansion(rowKey, value) { expansion.set(rowKey, value); } };
  t.after(() => {
    if (previousToolUtils === undefined) delete globalThis.rendererTurnRowToolRenderUtils;
    else globalThis.rendererTurnRowToolRenderUtils = previousToolUtils;
  });
  const { dom, overlay } = buildEnv(html, {
    getCurrentSessionMessages: () => [
      { id: 'u-a', role: 'user', content: 'first' },
      { id: 'm-tool-a', role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'call-a', input_json: '{}' } },
      { id: 'm-result-a', role: 'assistant', kind: 'tool_result', tool_result: { call_id: 'call-a', output_text: 'needle alpha' } },
    ],
    getSessionTurnEventState: () => ({ turnEvents: [] }),
    renderAll() {
      const doc = dom.window.document;
      const runOpen = expansion.get(runKey) === true;
      doc.querySelectorAll('[data-run-id="call-a"]').forEach((node) => node.setAttribute('data-run-expanded', runOpen ? 'true' : 'false'));
      const row = doc.querySelector('.tool-call-row[data-tool-row-key="row-key-a"]');
      const open = expansion.get('row-key-a') === true;
      row.setAttribute('data-expanded', open ? 'true' : 'false');
      row.querySelector('.tool-call-row-body').innerHTML = open ? '<span>needle alpha</span>' : '';
    },
  });
  overlay.attach();
  overlay.open();
  const input = dom.window.document.querySelector('.chat-search-bar-input');
  input.value = 'needle';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await waitForUiState(dom.window, () => expansion.get('row-key-a') === true);
  assert.equal(expansion.get(runKey), true, 'the collapsed run opens with the row');
  overlay.close();
  assert.equal(expansion.get('row-key-a'), false);
  assert.equal(expansion.get(runKey), false, 'closing the search collapses the run again');
});

