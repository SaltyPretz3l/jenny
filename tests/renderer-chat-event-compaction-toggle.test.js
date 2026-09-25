const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createTranscriptEventBindings,
} = require('../renderer/chat/renderer-chat-event-transcript-bindings');
const {
  createTranscriptThinkingRenderer,
} = require('../renderer/chat/renderer-transcript-thinking');
const {
  createViewportRecapUtils,
} = require('../renderer/shell/renderer-viewport-recap-utils');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const COMPACTION = { summaryStatus: 'created', phase: 'preflight', tokensBefore: 9000, tokensAfter: 4000 };

/* Mounts the real notice markup inside a timeline wired to the real delegated
   bindings and the real expansion-state owner (createViewportRecapUtils), so
   the state hand-off is exercised end to end rather than stubbed. */
function mountNotice(messageIds) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="chatTimeline"></div></body></html>');
  const { window } = dom;
  const chatTimeline = window.document.getElementById('chatTimeline');
  const state = { ui: {} };
  const {
    isContextCompactionExpanded,
    toggleContextCompactionDetails,
  } = createViewportRecapUtils({
    state,
    chatTimeline,
    escapeSelectorValue: (value) => String(value),
    getCurrentMessageById: () => null,
    renderMessages() {},
    getCurrentSessionMessages: () => [],
    isMapLike: (value) => value instanceof Map,
    isSetLike: (value) => value instanceof Set,
    buildInteractiveRecapViewModel: () => null,
  });
  const renderer = createTranscriptThinkingRenderer({ escapeHtml, isContextCompactionExpanded });
  const render = () => {
    chatTimeline.innerHTML = messageIds
      .map((id) => renderer.renderContextCompactedNotice({ id, context_compacted: COMPACTION }))
      .join('');
  };
  render();

  const noopAsync = async () => {};
  const bindings = createTranscriptEventBindings({
    chatTimeline,
    state,
    handleBranchMessage: noopAsync,
    handleCopyMessage: noopAsync,
    handleRegenerateMessage: noopAsync,
    handleElaborateMessage: noopAsync,
    handleFollowUpMessage: noopAsync,
    handleUseProactiveSuggestionMessage: noopAsync,
    handleSaveProactiveSuggestionMessage: noopAsync,
    handleLaterProactiveSuggestionMessage: noopAsync,
    handleErrorRecoveryAction: noopAsync,
    handleArtifactAction: noopAsync,
    toggleInteractiveRoundRecap: noopAsync,
    toggleContextCompactionDetails,
    toggleThreadBranch() {},
    setReasoningPhaseExpandedPreference() {},
    syncThinkingBlockNode() {},
    appendClientLog() {},
    showComposerActionError() {},
    resolveToolCallId: () => '',
    toggleToolDetails() {},
    thinkingController: {},
  });
  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });

  const nodesFor = (id) => {
    const toggle = [...chatTimeline.querySelectorAll('.context-compacted-notice-toggle')]
      .find((node) => node.dataset.messageId === id);
    const body = window.document.getElementById(toggle.getAttribute('aria-controls'));
    return { toggle, body };
  };
  const click = (id) => nodesFor(id).toggle.dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true })
  );
  return { window, chatTimeline, state, render, nodesFor, click };
}

test('the delegated handler opens the compaction body and records the state', () => {
  const view = mountNotice(['msg_a']);
  const before = view.nodesFor('msg_a');
  assert.equal(before.toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(before.body.hidden, true);

  view.click('msg_a');

  const after = view.nodesFor('msg_a');
  assert.equal(after.toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(after.body.hidden, false);
  assert.deepEqual([...view.state.ui.contextCompactionExpanded], ['msg_a']);

  view.click('msg_a');
  assert.equal(view.nodesFor('msg_a').toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(view.nodesFor('msg_a').body.hidden, true);
  assert.deepEqual([...view.state.ui.contextCompactionExpanded], []);
});

test('an open compaction body is re-stamped open after the timeline re-renders', () => {
  // The timeline re-renders by innerHTML: a flag kept only on the node would
  // be gone here, which is exactly how the old <details> collapsed.
  const view = mountNotice(['msg_a']);
  view.click('msg_a');

  view.render();

  const rerendered = view.nodesFor('msg_a');
  assert.equal(rerendered.toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(rerendered.body.hidden, false);
});

test('toggling one notice leaves every other notice in the timeline alone', () => {
  const view = mountNotice(['msg_a', 'msg_b']);

  view.click('msg_b');

  assert.equal(view.nodesFor('msg_a').toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(view.nodesFor('msg_a').body.hidden, true);
  assert.equal(view.nodesFor('msg_b').toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(view.nodesFor('msg_b').body.hidden, false);
  assert.deepEqual([...view.state.ui.contextCompactionExpanded], ['msg_b']);
});

test('the compaction toggle click is consumed rather than falling through', () => {
  const view = mountNotice(['msg_a']);
  const event = new view.window.MouseEvent('click', { bubbles: true, cancelable: true });

  view.nodesFor('msg_a').toggle.dispatchEvent(event);

  assert.equal(event.defaultPrevented, true);
});
