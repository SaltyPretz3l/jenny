const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createTranscriptEventBindings,
} = require('../renderer/chat/renderer-chat-event-transcript-bindings');

test('native thread toggles use the delegated click path without keydown double activation', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatTimeline"><button type="button" data-thread-toggle="assistant-1">Toggle</button></div>'
    + '</body></html>');
  const { window } = dom;
  const chatTimeline = window.document.getElementById('chatTimeline');
  const calls = [];
  const noopAsync = async () => {};
  const bindings = createTranscriptEventBindings({
    chatTimeline,
    state: {},
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
    toggleThreadBranch(messageId) { calls.push(messageId); },
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

  const toggle = chatTimeline.querySelector('[data-thread-toggle]');
  for (const key of ['Enter', ' ']) {
    const keydown = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    toggle.dispatchEvent(keydown);
    assert.equal(keydown.defaultPrevented, false);
    assert.deepEqual(calls, []);

    // Browsers synthesize one native click after activating a button with
    // Enter or Space; jsdom does not, so model that browser-owned edge here.
    toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.deepEqual(calls, ['assistant-1']);
    calls.length = 0;
  }

  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(calls, ['assistant-1']);
});
