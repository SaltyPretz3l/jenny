const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createSessionManager } = require('../renderer/shell/renderer-session-utils');
const searchOverlayUtils = require('../renderer/chat/renderer-chat-search-overlay');
const { wireChatAccessibility } = require('../renderer/chat/renderer-chat-accessibility-wiring');
const { waitForUiState } = require('./helpers/wait-for-ui-state');

// CTR-005: the search overlay indexes the session shown in the timeline it
// searches, with the real session accessors (a blank id yields no turn events).

function createManager(state) {
  return createSessionManager({
    state,
    constants: {
      INTERACTIVE_SEQUENCE_IDLE: 'idle',
      INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE: 'structured_active',
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: 'fallback_requested',
      MAX_INTERACTIVE_ROUNDS: 4,
      MAX_INTERACTIVE_QUESTIONS: 4,
    },
    callbacks: {
      normalizeChatMessage(message) { return message; },
      normalizeChatMessages(messages) { return messages; },
      isInteractiveOtherTrigger() { return false; },
      getActiveSession() { return null; },
      patchSessionSummary() {},
      rekeyDismissedMemorySession() {},
      rekeySessionArtifacts() {},
      notifySessionMessagesReplaced() {},
    },
  });
}

function shimCssHighlights(win) {
  win.CSS = win.CSS || {};
  win.CSS.highlights = new Map();
  win.Highlight = function Highlight() {
    this.ranges = Array.prototype.slice.call(arguments);
  };
}

function setup(t, paneSessionId, focusedSessionId) {
  const state = {
    currentSessionId: focusedSessionId,
    messagesBySession: new Map([
      ['session-a', [
        { id: 'a-user', role: 'user', content: 'only-in-pane-a marker' },
        { id: 'a-tool', role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'call-a', input_json: '{}' } },
      ]],
      ['session-b', [
        { id: 'b-user', role: 'user', content: 'only-in-pane-b marker' },
      ]],
    ]),
    turnEventsBySession: new Map([
      ['session-a', { turnEventLogVersion: 1, turnEvents: [
        { kind: 'tool_result', primary_message_id: 'a-tool', tool_call_id: 'call-a', payload: { output_text: 'event-only text' } },
      ] }],
    ]),
  };
  const manager = createManager(state);
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="chatView"><div id="chatTimeline" role="feed"></div></div></body></html>');
  shimCssHighlights(dom.window);
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  const wired = wireChatAccessibility({
    state,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    chatView: dom.window.document.getElementById('chatView'),
    document: dom.window.document,
    searchOverlayUtils,
    // The callbacks the shell hands to the event bindings in production.
    getCurrentSessionMessages: (...args) => manager.getCurrentSessionMessages(...args),
    getSessionTurnEventState: (...args) => manager.getSessionTurnEventState(...args),
    getSessionMessages: (...args) => manager.getSessionMessages(...args),
    // The pane's own session context.
    getSessionId: () => paneSessionId,
  });
  t.after(() => wired.searchOverlay.dispose());
  return { dom, wired };
}

async function search(dom, wired, query, expected) {
  wired.searchOverlay.open();
  const input = dom.window.document.querySelector('.chat-search-bar-input');
  const count = dom.window.document.querySelector('.chat-search-bar-count');
  input.value = query;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await waitForUiState(dom.window, () => count.textContent === expected, {
    message: 'count never reached "' + expected + '" (was "' + count.textContent + '")',
  });
}

test('CTR-005: turn-event content of the pane session is indexed through the real accessors', async (t) => {
  const { dom, wired } = setup(t, 'session-a', 'session-a');
  await search(dom, wired, 'event-only', '1 of 1');
});

test('CTR-005: a focused second pane does not redirect the first pane search to its own messages', async (t) => {
  const { dom, wired } = setup(t, 'session-a', 'session-b');
  await search(dom, wired, 'only-in-pane-b', 'No matches');
  await search(dom, wired, 'only-in-pane-a', '1 of 1');
});
