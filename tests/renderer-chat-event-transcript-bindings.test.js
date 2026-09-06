const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createTranscriptEventBindings,
} = require('../renderer/chat/renderer-chat-event-transcript-bindings');
const fileDiffBindings = require('../renderer/chat/renderer-file-diff-bindings');

function buildNoopBindingDeps(chatTimeline, overrides = {}) {
  return {
    chatTimeline,
    state: {},
    handleBranchMessage: async () => null,
    handleCopyMessage: async () => {},
    handleRegenerateMessage: async () => {},
    handleElaborateMessage: async () => {},
    handleFollowUpMessage: async () => {},
    handleUseProactiveSuggestionMessage: async () => {},
    handleSaveProactiveSuggestionMessage: async () => {},
    handleLaterProactiveSuggestionMessage: async () => {},
    handleErrorRecoveryAction: async () => {},
    handleArtifactAction: async () => {},
    toggleInteractiveRoundRecap: async () => {},
    toggleThreadBranch: () => {},
    setReasoningPhaseExpandedPreference: () => {},
    syncThinkingBlockNode: () => {},
    appendClientLog: () => {},
    showComposerActionError: () => {},
    resolveToolCallId: () => '',
    toggleToolDetails: () => {},
    thinkingController: {},
    ...overrides,
  };
}

test('minimal tool row toggle flips expansion in place and persists the override', async (t) => {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatTimeline">'
    + '<div class="tool-call-row tool-call-row--minimal" data-tool-call-id="call-1" data-tool-row-key="row-key-1" data-expanded="false">'
    + '<div class="tool-call-row-toggle" role="button" tabindex="0" data-tool-row-toggle="true" data-tool-call-id="call-1" data-tool-row-key="row-key-1" aria-expanded="false" aria-controls="tool-row-body-call-1">Toggle</div>'
    + '<div class="tool-call-row-body" id="tool-row-body-call-1" inert></div>'
    + '</div>'
    + '</div>'
    + '</body></html>');
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');
  const toolRowUtils = require('../renderer/chat/renderer-turn-row-tool-render-utils');
  const previousGlobal = globalThis.rendererTurnRowToolRenderUtils;
  globalThis.rendererTurnRowToolRenderUtils = toolRowUtils;
  t.after(() => {
    toolRowUtils.clearToolRowExpansionOverrides();
    if (previousGlobal === undefined) {
      delete globalThis.rendererTurnRowToolRenderUtils;
    } else {
      globalThis.rendererTurnRowToolRenderUtils = previousGlobal;
    }
  });

  const bindings = createTranscriptEventBindings(buildNoopBindingDeps(chatTimeline));
  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });

  const toggle = chatTimeline.querySelector('[data-tool-row-toggle]');
  const row = chatTimeline.querySelector('.tool-call-row--minimal');
  const body = chatTimeline.querySelector('.tool-call-row-body');

  const expandEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  toggle.dispatchEvent(expandEvent);
  await Promise.resolve();

  assert.equal(expandEvent.defaultPrevented, true);
  assert.equal(row.getAttribute('data-expanded'), 'true');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(body.hasAttribute('inert'), false);
  assert.equal(toolRowUtils.getToolRowExpansion('row-key-1'), true, 'expansion override persisted for re-renders');

  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await Promise.resolve();

  assert.equal(row.getAttribute('data-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(body.hasAttribute('inert'), true);
  assert.equal(toolRowUtils.getToolRowExpansion('row-key-1'), false);

  // Keyboard activation: the div[role=button] toggle responds to Enter.
  const enterEvent = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  toggle.dispatchEvent(enterEvent);
  await Promise.resolve();

  assert.equal(enterEvent.defaultPrevented, true);
  assert.equal(row.getAttribute('data-expanded'), 'true');
  assert.equal(body.hasAttribute('inert'), false);
});

test('F3: transcript action dispatcher routes branch hover action', async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatTimeline">'
    + '<button type="button" data-message-action="branch" data-message-id="msg_1">Branch</button>'
    + '</div>'
    + '</body></html>');
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');
  const calls = [];
  const bindings = createTranscriptEventBindings({
    chatTimeline,
    state: {},
    handleBranchMessage: async (messageId) => calls.push(messageId),
    handleCopyMessage: async () => {},
    handleRegenerateMessage: async () => {},
    handleElaborateMessage: async () => {},
    handleFollowUpMessage: async () => {},
    handleUseProactiveSuggestionMessage: async () => {},
    handleSaveProactiveSuggestionMessage: async () => {},
    handleLaterProactiveSuggestionMessage: async () => {},
    handleErrorRecoveryAction: async () => {},
    handleArtifactAction: async () => {},
    toggleInteractiveRoundRecap: async () => {},
    toggleThreadBranch: () => {},
    setReasoningPhaseExpandedPreference: () => {},
    syncThinkingBlockNode: () => {},
    appendClientLog: () => {},
    showComposerActionError: () => {},
    resolveToolCallId: () => '',
    toggleToolDetails: () => {},
    thinkingController: {},
  });

  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });

  const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  chatTimeline.querySelector('[data-message-action="branch"]').dispatchEvent(event);
  await Promise.resolve();

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(calls, ['msg_1']);
});

test('SP-19: transcript dispatcher routes Retry save through additive durability IPC', async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatTimeline">'
    + '<article class="chat-entry assistant" data-message-id="assistant_1">'
    + '<div data-unsaved-reply-notice="true">'
    + '<button type="button" data-unsaved-reply-action="retry" data-message-id="assistant_1" data-artifact-id="repair_1">Retry save</button>'
    + '</div></article></div></body></html>');
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');
  const calls = [];
  const refreshCalls = [];
  window.jennyShell = {
    chat: {
      retryUnsavedReply: async (payload) => {
        calls.push(payload);
        return { ok: true, durable: true, reason: null };
      },
      editAndRegenerate: () => { throw new Error('must not regenerate'); },
    },
  };
  const state = {
    currentSessionId: 'session_1',
    messagesBySession: new Map([['session_1', [{
      id: 'assistant_1', role: 'assistant', status: 'complete', content: 'reply',
      durability: { state: 'unsaved', artifact_id: 'repair_1' },
    }]]]),
  };
  const bindings = createTranscriptEventBindings(buildNoopBindingDeps(chatTimeline, {
    state,
    refreshRecoveredSession: async (value) => refreshCalls.push(value),
  }));
  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });

  const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  chatTimeline.querySelector('[data-unsaved-reply-action="retry"]').dispatchEvent(event);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(calls, [{
    sessionId: 'session_1', messageId: 'assistant_1', artifactId: 'repair_1',
  }]);
  assert.equal(state.messagesBySession.get('session_1')[0].durability, undefined);
  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0].action, 'retry');
});

test('Phase 3B: transcript dispatcher routes data-jenny-code-review change-scope clicks to handleCodeReviewAction', async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatTimeline">'
    + '<button type="button" data-jenny-code-review data-scope="change" data-change-id="chg_1" data-turn-id="turn_5" data-file-key="default:a.js">Review changes</button>'
    + '</div>'
    + '</body></html>');
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');
  const calls = [];
  const bindings = createTranscriptEventBindings({
    chatTimeline,
    state: {},
    handleBranchMessage: async () => null,
    handleCopyMessage: async () => {},
    handleRegenerateMessage: async () => {},
    handleElaborateMessage: async () => {},
    handleFollowUpMessage: async () => {},
    handleUseProactiveSuggestionMessage: async () => {},
    handleSaveProactiveSuggestionMessage: async () => {},
    handleLaterProactiveSuggestionMessage: async () => {},
    handleErrorRecoveryAction: async () => {},
    handleArtifactAction: async () => {},
    handleCodeReviewAction: async (payload) => calls.push(payload),
    toggleInteractiveRoundRecap: async () => {},
    toggleThreadBranch: () => {},
    setReasoningPhaseExpandedPreference: () => {},
    syncThinkingBlockNode: () => {},
    appendClientLog: () => {},
    showComposerActionError: () => {},
    resolveToolCallId: () => '',
    toggleToolDetails: () => {},
    thinkingController: {},
  });

  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });

  const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  chatTimeline.querySelector('[data-jenny-code-review]').dispatchEvent(event);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(event.defaultPrevented, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope, 'change');
  assert.equal(calls[0].changeId, 'chg_1');
  assert.equal(calls[0].turnId, 'turn_5');
  assert.equal(calls[0].fileKey, 'default:a.js');
});

test('Phase 3B: transcript dispatcher routes turn-scope code-review clicks (assistant-turn summary)', async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatTimeline">'
    + '<button type="button" data-jenny-code-review data-scope="turn" data-turn-id="turn_9">Review changes</button>'
    + '</div>'
    + '</body></html>');
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');
  const calls = [];
  const bindings = createTranscriptEventBindings({
    chatTimeline,
    state: {},
    handleBranchMessage: async () => null,
    handleCopyMessage: async () => {},
    handleRegenerateMessage: async () => {},
    handleElaborateMessage: async () => {},
    handleFollowUpMessage: async () => {},
    handleUseProactiveSuggestionMessage: async () => {},
    handleSaveProactiveSuggestionMessage: async () => {},
    handleLaterProactiveSuggestionMessage: async () => {},
    handleErrorRecoveryAction: async () => {},
    handleArtifactAction: async () => {},
    handleCodeReviewAction: async (payload) => calls.push(payload),
    toggleInteractiveRoundRecap: async () => {},
    toggleThreadBranch: () => {},
    setReasoningPhaseExpandedPreference: () => {},
    syncThinkingBlockNode: () => {},
    appendClientLog: () => {},
    showComposerActionError: () => {},
    resolveToolCallId: () => '',
    toggleToolDetails: () => {},
    thinkingController: {},
  });

  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });

  const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  chatTimeline.querySelector('[data-jenny-code-review]').dispatchEvent(event);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(event.defaultPrevented, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope, 'turn');
  assert.equal(calls[0].turnId, 'turn_9');
});

test('file diff dispatcher materializes lazy bodies and routes open-in-editor by changeId', async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatTimeline">'
    + '<div class="file-diff" data-diff-id="diff:a" data-expanded="false">'
    + '<button type="button" data-file-diff-toggle data-diff-id="diff:a" aria-expanded="false">src/a.js</button>'
    + '<button type="button" data-jenny-open-change-diff data-change-id="change:a">open</button>'
    + '<div class="file-diff-body" data-file-diff-pending="1" hidden></div>'
    + '</div>'
    + '</div>'
    + '</body></html>');
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');
  const openCalls = [];
  fileDiffBindings.disposeFileDiffBindings();
  fileDiffBindings.registerFileDiffContext({
    diffId: 'diff:a',
    sessionId: 'session-1',
    materialize: () => '<div class="diff-line">added</div>',
  });
  const bindings = createTranscriptEventBindings(buildNoopBindingDeps(chatTimeline, {
    handleCodeReviewAction: async () => {},
    handleOpenChangeDiff: async (payload) => { openCalls.push(payload); return true; },
  }));

  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });

  const toggle = chatTimeline.querySelector('[data-file-diff-toggle]');
  const body = chatTimeline.querySelector('.file-diff-body');
  const toggleEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  toggle.dispatchEvent(toggleEvent);
  assert.equal(toggleEvent.defaultPrevented, true);
  assert.equal(body.hidden, false, 'row expands on toggle click');
  assert.ok(body.hasAttribute('data-file-diff-materialized'));
  assert.ok(body.querySelector('.diff-line'));
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');

  const openEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  chatTimeline.querySelector('[data-jenny-open-change-diff]').dispatchEvent(openEvent);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(openEvent.defaultPrevented, true);
  assert.equal(openCalls.length, 1);
  assert.equal(openCalls[0].changeId, 'change:a');
  fileDiffBindings.disposeFileDiffBindings();
});

test('Collapse/Expand All toggle button batches state changes into one full render', async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<button id="timelineCollapseExpandToggle">Toggle</button>'
    + '<div id="chatTimeline">'
    + '  <div class="tool-call-header" data-tool-row-key="tool_1" aria-expanded="true"></div>'
    + '  <div data-reasoning-toggle data-message-id="msg_1" data-phase-key="phase_1" data-default-expanded="true" aria-expanded="true"></div>'
    + '</div>'
    + '</body></html>');
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');
  const collapseExpandToggle = window.document.getElementById('timelineCollapseExpandToggle');

  const toolExpansionCalls = [];
  const reasoningBatchCalls = [];
  const renderCalls = [];
  const syncNodeCalls = [];
  const phaseExpansionMap = new Map();
  const thinkingController = {
    phaseExpansionState: phaseExpansionMap,
    autoScrollPaused: false
  };

  const bindings = createTranscriptEventBindings({
    chatTimeline,
    state: { currentSessionId: 'sess_123' },
    handleBranchMessage: async () => null,
    handleCopyMessage: async () => {},
    handleRegenerateMessage: async () => {},
    handleElaborateMessage: async () => {},
    handleFollowUpMessage: async () => {},
    handleUseProactiveSuggestionMessage: async () => {},
    handleSaveProactiveSuggestionMessage: async () => {},
    handleLaterProactiveSuggestionMessage: async () => {},
    handleErrorRecoveryAction: async () => {},
    handleArtifactAction: async () => {},
    toggleInteractiveRoundRecap: async () => {},
    toggleThreadBranch: () => {},
    setReasoningPhaseExpandedPreferences: (sessionId, entries) => reasoningBatchCalls.push({ sessionId, entries }),
    syncThinkingBlockNode: (msgId, phaseKey) => {
      syncNodeCalls.push({ msgId, phaseKey });
    },
    resolveToolCallId: () => '',
    toggleToolDetails: () => assert.fail('bulk toggle must not use the per-row materialization path'),
    setToolCallExpansion: (rowKey, expanded) => toolExpansionCalls.push({ rowKey, expanded }),
    renderAll: (options) => renderCalls.push(options),
    thinkingController,
  });

  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });

  // Step 1: Click when any are expanded -> should collapse all (nextExpanded = false)
  const clickEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  collapseExpandToggle.dispatchEvent(clickEvent);
  await Promise.resolve();

  assert.equal(clickEvent.defaultPrevented, true);
  assert.deepEqual(toolExpansionCalls, [{ rowKey: 'tool_1', expanded: false }]);
  assert.equal(reasoningBatchCalls.length, 1);
  assert.equal(reasoningBatchCalls[0].sessionId, 'sess_123');
  assert.deepEqual(reasoningBatchCalls[0].entries, [{
    messageId: 'msg_1', phaseKey: 'phase_1', expanded: false, defaultExpanded: true,
  }]);
  assert.deepEqual(renderCalls, [{ forceFullRender: true }]);
  assert.equal(syncNodeCalls.length, 0);
  assert.equal(phaseExpansionMap.get('msg_1::phase_1'), false);
  assert.equal(thinkingController.autoScrollPaused, true);

  // Clear tracking arrays for next phase
  toolExpansionCalls.length = 0;
  reasoningBatchCalls.length = 0;
  renderCalls.length = 0;
  syncNodeCalls.length = 0;
  phaseExpansionMap.clear();
  thinkingController.autoScrollPaused = false;

  // Step 2: Update DOM elements to be collapsed
  chatTimeline.querySelector('.tool-call-header').setAttribute('aria-expanded', 'false');
  chatTimeline.querySelector('[data-reasoning-toggle]').setAttribute('aria-expanded', 'false');

  // Click when all are collapsed -> should expand all (nextExpanded = true)
  const clickEvent2 = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  collapseExpandToggle.dispatchEvent(clickEvent2);
  await Promise.resolve();

  assert.equal(clickEvent2.defaultPrevented, true);
  assert.deepEqual(toolExpansionCalls, [{ rowKey: 'tool_1', expanded: true }]);
  assert.equal(reasoningBatchCalls.length, 1);
  assert.equal(reasoningBatchCalls[0].entries[0].expanded, true);
  assert.deepEqual(renderCalls, [{ forceFullRender: true }]);
  assert.equal(phaseExpansionMap.get('msg_1::phase_1'), true);
  assert.equal(thinkingController.autoScrollPaused, true);
});

test('reasoning toggle marks only the streaming row as live-tail follow-exempt', (t) => {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatTimeline">'
    + '<div class="reasoning-row-block" data-reasoning-status="streaming" data-reasoning-live-tail="true">'
    + '<button data-reasoning-toggle data-message-id="msg_1" data-phase-key="phase_live"></button>'
    + '</div>'
    // A non-tail phase of the streaming message also carries
    // data-reasoning-status="streaming" — only the live-tail marker counts
    // (2026-08-29 review fix).
    + '<div class="reasoning-row-block" data-reasoning-status="streaming">'
    + '<button data-reasoning-toggle data-message-id="msg_1" data-phase-key="phase_hist"></button>'
    + '</div>'
    + '</div>'
    + '</body></html>');
  const previousDocument = global.document;
  global.document = dom.window.document;
  t.after(() => { global.document = previousDocument; });
  const chatTimeline = global.document.getElementById('chatTimeline');
  const calls = [];
  const bindings = createTranscriptEventBindings(buildNoopBindingDeps(chatTimeline, {
    thinkingController: {
      togglePhaseExpanded(...args) {
        calls.push(args);
        return true;
      },
    },
  }));
  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });

  const toggles = global.document.querySelectorAll('[data-reasoning-toggle]');
  toggles[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  toggles[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

  assert.deepEqual(calls, [
    ['msg_1', 'phase_live', false, { liveStreamingTail: true }],
    ['msg_1', 'phase_hist', false, { liveStreamingTail: false }],
  ]);
});

for (const { name, streaming, phaseKey, expected } of [
  {
    name: 'reasoning toggle treats the last block in a live article as follow-exempt when its marker is missing',
    streaming: true,
    phaseKey: 'phase_tail',
    expected: true,
  },
  {
    name: 'reasoning toggle does not treat an earlier block in a live article as follow-exempt',
    streaming: true,
    phaseKey: 'phase_earlier',
    expected: false,
  },
  {
    name: 'reasoning toggle does not treat an unmarked block in a settled article as follow-exempt',
    streaming: false,
    phaseKey: 'phase_tail',
    expected: false,
  },
]) {
  test(name, (t) => {
    const streamMarker = streaming ? ' data-streaming-message-id="assistant_seg1"' : '';
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="chatTimeline">'
      + `<article class="chat-entry"${streamMarker}>`
      + '<div class="reasoning-row-block"><button data-reasoning-toggle data-message-id="msg_1" data-phase-key="phase_earlier"></button></div>'
      + '<div class="reasoning-row-block"><button data-reasoning-toggle data-message-id="msg_1" data-phase-key="phase_tail"></button></div>'
      + '</article></div></body></html>');
    const previousDocument = global.document;
    global.document = dom.window.document;
    t.after(() => { global.document = previousDocument; });
    const chatTimeline = global.document.getElementById('chatTimeline');
    const calls = [];
    const bindings = createTranscriptEventBindings(buildNoopBindingDeps(chatTimeline, {
      thinkingController: {
        togglePhaseExpanded(...args) {
          calls.push(args);
          return true;
        },
      },
    }));
    bindings.bindTranscriptEvents((target, eventName, handler, options) => {
      target.addEventListener(eventName, handler, options);
    });

    chatTimeline.querySelector(`[data-phase-key="${phaseKey}"]`)
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    assert.deepEqual(calls, [
      ['msg_1', phaseKey, false, { liveStreamingTail: expected }],
    ]);
  });
}

test('minimal tool row reveal animates max-height when a transition duration is configured', (t) => {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatTimeline">'
    + '<div class="tool-call-row tool-call-row--minimal" data-tool-call-id="call-anim" data-expanded="false">'
    + '<div class="tool-call-row-toggle" role="button" tabindex="0" data-tool-row-toggle="true" data-tool-call-id="call-anim" aria-expanded="false" aria-controls="tool-row-body-call-anim">Toggle</div>'
    + '<div class="tool-call-row-body" id="tool-row-body-call-anim" inert></div>'
    + '</div>'
    + '</div>'
    + '</body></html>', { pretendToBeVisual: true });
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');
  const toolRowUtils = require('../renderer/chat/renderer-turn-row-tool-render-utils');
  const previousGlobal = globalThis.rendererTurnRowToolRenderUtils;
  globalThis.rendererTurnRowToolRenderUtils = toolRowUtils;
  t.after(() => {
    toolRowUtils.clearToolRowExpansionOverrides();
    if (previousGlobal === undefined) {
      delete globalThis.rendererTurnRowToolRenderUtils;
    } else {
      globalThis.rendererTurnRowToolRenderUtils = previousGlobal;
    }
  });

  const body = chatTimeline.querySelector('.tool-call-row-body');
  // jsdom has no layout, so fake a content height for the reveal to animate to.
  Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 120 });

  const bindings = createTranscriptEventBindings(
    buildNoopBindingDeps(chatTimeline, { getToolDetailsTransitionMs: () => 200 })
  );
  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });

  // Capture the rAF + settle-timer callbacks so we can step the animation by hand.
  let rafCb = null;
  let settleCb = null;
  let settleMs = null;
  window.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
  window.setTimeout = (cb, ms) => { settleCb = cb; settleMs = ms; return 7; };
  window.clearTimeout = () => {};

  const toggle = chatTimeline.querySelector('[data-tool-row-toggle]');

  // Expand: seeds 0 height synchronously, schedules a frame + the settle timer.
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(body.hasAttribute('inert'), false, 'expanded body leaves the inert/a11y tree');
  assert.equal(body.style.maxHeight, '0px', 'reveal seeds from 0 height');
  assert.equal(settleMs, 200, 'settle timer uses the configured transition duration');
  assert.equal(typeof rafCb, 'function', 'an animation frame was scheduled');
  rafCb();
  assert.equal(body.style.maxHeight, '120px', 'reveal animates to the measured content height');
  settleCb();
  assert.equal(body.style.maxHeight, 'none', 'expanded body settles to max-height:none');

  // Collapse: seeds from the current height, animates to 0, clears the inline value.
  rafCb = null;
  settleCb = null;
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(body.hasAttribute('inert'), true, 'collapsed body returns to the inert/a11y tree');
  assert.equal(body.style.maxHeight, '120px', 'collapse seeds from the measured height');
  rafCb();
  assert.equal(body.style.maxHeight, '0px', 'collapse animates back to 0');
  settleCb();
  assert.equal(body.style.maxHeight, '', 'collapsed body clears the inline max-height');
});

// A2 â€” Approval Allow/Deny: busy state, visible error, focus restoration.
// See renderer/chat/renderer-approval-block.js for the real markup shape
// (approval-gap-row > tool-approval-block > .tool-approve-btn/.tool-deny-btn).
function buildApprovalRowHtml(callId, { approvalId } = {}) {
  const approvalAttr = approvalId ? ` data-approval-id="${approvalId}"` : '';
  return ''
    + `<div class="approval-gap-row" role="status" aria-live="polite" data-tool-call-id="${callId}" data-call-id="${callId}"${approvalAttr} data-approval-status="pending">`
    + `<div class="tool-approval-block" data-tool-call-id="${callId}" data-call-id="${callId}"${approvalAttr}>`
    + '<p class="tool-approval-prompt">Approve this tool?</p>'
    + '<div class="tool-approval-actions">'
    + `<button class="tool-approve-btn" type="button" data-action="approve" data-tool-call-id="${callId}" data-call-id="${callId}"${approvalAttr} aria-label="Allow">Allow</button>`
    + `<button class="tool-deny-btn" type="button" data-action="deny" data-tool-call-id="${callId}" data-call-id="${callId}"${approvalAttr} aria-label="Deny">Deny</button>`
    + `<button class="tool-approve-btn tool-approve-always-btn" type="button" data-action="approve" data-approval-scope="always" data-tool-call-id="${callId}" data-call-id="${callId}" aria-label="Always allow">Always allow</button>`
    + '</div>'
    + '</div>'
    + '</div>';
}

// Real resolveToolCallId implementation (mirrors the one in
// renderer-chat-event-utils.js) â€” the buildNoopBindingDeps default
// (`() => ''`) can't be reused here because the busy/focus behavior depends
// on actually resolving the call id from the clicked button's ancestry.
function realResolveToolCallId(target) {
  const targetNode = target && typeof target.closest === 'function' ? target : null;
  const toolShell = targetNode?.closest('[data-approval-id], [data-call-id], [data-tool-call-id]');
  return toolShell?.dataset
    ? String(toolShell.dataset.approvalId || toolShell.dataset.toolCallId || toolShell.dataset.callId || '').trim()
    : '';
}

// The click handler references the bare (browser-)global `window.jennyShell`,
// mirroring how it runs in the real renderer. Under plain node:test there is
// no ambient `window`, so tests that exercise the approve/deny IPC calls must
// install `dom.window` as `global.window` (and clean it up via t.after) â€”
// the same pattern used throughout tests/renderer-*.test.js.
function installApprovalWindowGlobals(t, window, { approve, deny, getActiveTurnState } = {}) {
  window.jennyShell = {
    tools: {
      approve: approve || (() => Promise.resolve(true)),
      deny: deny || (() => Promise.resolve(true)),
    },
    chat: { getActiveTurnState: getActiveTurnState || (() => Promise.resolve(null)) },
  };
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = window;
  global.document = window.document;
  t.after(() => {
    if (previousWindow === undefined) {
      delete global.window;
    } else {
      global.window = previousWindow;
    }
    if (previousDocument === undefined) {
      delete global.document;
    } else {
      global.document = previousDocument;
    }
  });
}

test('A2: clicking Allow disables both buttons and sets aria-busy before the IPC promise settles', async (t) => {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatTimeline">'
    + buildApprovalRowHtml('call_1')
    + '</div>'
    + '</body></html>');
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');

  let resolveApprove;
  const pendingApprove = new Promise((resolve) => { resolveApprove = resolve; });
  installApprovalWindowGlobals(t, window, { approve: () => pendingApprove });

  const bindings = createTranscriptEventBindings(
    buildNoopBindingDeps(chatTimeline, { resolveToolCallId: realResolveToolCallId })
  );
  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });

  const approveBtn = chatTimeline.querySelector('.tool-approve-btn');
  const denyBtn = chatTimeline.querySelector('.tool-deny-btn');

  approveBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

  // Busy state must be applied synchronously in the click handler, before the
  // pending IPC promise has any chance to settle.
  assert.equal(approveBtn.disabled, true, 'approve button disabled while busy');
  assert.equal(approveBtn.getAttribute('aria-busy'), 'true', 'approve button marked aria-busy');
  assert.equal(denyBtn.disabled, true, 'deny button also disabled while its sibling is busy');
  assert.equal(denyBtn.getAttribute('aria-busy'), 'true', 'deny button also marked aria-busy');

  // A second click while busy must not re-invoke tools.approve (double-click guard).
  let secondCallCount = 0;
  const originalApprove = window.jennyShell.tools.approve;
  window.jennyShell.tools.approve = (...args) => { secondCallCount += 1; return originalApprove(...args); };
  approveBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(secondCallCount, 0, 'busy button ignores a second click');

  resolveApprove(true);
  await Promise.resolve();
  await Promise.resolve();
});

test('T1: dropped approval settlement reconciles through Electron and leaves the row recoverable', async (t) => {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="chatTimeline">'
    + buildApprovalRowHtml('call_reconcile', { approvalId: 'approval_reconcile' })
    + '</div></body></html>');
  const { window } = dom;
  const chatTimeline = window.document.getElementById('chatTimeline');
  let queryCount = 0;
  let scheduled;
  let refreshCount = 0;
  installApprovalWindowGlobals(t, window, {
    approve: () => Promise.resolve(true),
    getActiveTurnState: async () => { queryCount += 1; return null; },
  });
  const bindings = createTranscriptEventBindings(buildNoopBindingDeps(chatTimeline, {
    state: { currentSessionId: 'session_reconcile' },
    resolveToolCallId: realResolveToolCallId,
    refreshRecoveredSession: async () => { refreshCount += 1; },
    approvalReconcileSetTimeout: (callback) => { scheduled = callback; return 1; },
    approvalReconcileClearTimeout: () => {},
  }));
  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });

  chatTimeline.querySelector('.tool-approve-btn').dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true })
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(typeof scheduled, 'function');
  await scheduled();

  const row = chatTimeline.querySelector('.approval-gap-row');
  assert.equal(queryCount, 1);
  assert.equal(refreshCount, 1);
  assert.equal(row.getAttribute('data-approval-reconciliation'), 'unknown');
  assert.equal(row.querySelector('.tool-approve-btn').disabled, false);
  assert.equal(row.querySelector('.tool-deny-btn').disabled, false);
  bindings.dispose();
});

test('T1: approval reconciliation stays bound to the click session across a delayed IPC result', async (t) => {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="chatTimeline">'
    + buildApprovalRowHtml('call_origin', { approvalId: 'approval_origin' })
    + '</div></body></html>');
  const { window } = dom;
  const chatTimeline = window.document.getElementById('chatTimeline');
  const state = { currentSessionId: 'session_origin' };
  let resolveApprove;
  const pendingApprove = new Promise((resolve) => { resolveApprove = resolve; });
  let scheduledCount = 0;
  installApprovalWindowGlobals(t, window, { approve: () => pendingApprove });
  const bindings = createTranscriptEventBindings(buildNoopBindingDeps(chatTimeline, {
    state,
    resolveToolCallId: realResolveToolCallId,
    approvalReconcileSetTimeout: () => { scheduledCount += 1; return scheduledCount; },
    approvalReconcileClearTimeout: () => {},
  }));
  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });

  chatTimeline.querySelector('.tool-approve-btn').dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true })
  );
  state.currentSessionId = 'session_other';
  resolveApprove(true);
  await Promise.resolve();
  await Promise.resolve();

  const row = chatTimeline.querySelector('.approval-gap-row');
  assert.equal(scheduledCount, 0, 'session switch prevents a watchdog for the wrong session');
  assert.equal(row.getAttribute('data-approval-reconciliation'), 'session_changed');
  assert.equal(row.querySelector('.tool-approve-btn').disabled, false);
  bindings.dispose();
});

test('A2: a rejected tools.approve re-enables the buttons and calls showComposerActionError', async (t) => {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatTimeline">'
    + buildApprovalRowHtml('call_2')
    + '</div>'
    + '</body></html>');
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');

  const failure = new Error('boom');
  installApprovalWindowGlobals(t, window, { approve: () => Promise.reject(failure) });

  const composerErrors = [];
  const clientLogs = [];
  const bindings = createTranscriptEventBindings(
    buildNoopBindingDeps(chatTimeline, {
      resolveToolCallId: realResolveToolCallId,
      showComposerActionError: (error, title) => composerErrors.push({ error, title }),
      appendClientLog: (level, event, meta) => clientLogs.push({ level, event, meta }),
    })
  );
  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });

  const approveBtn = chatTimeline.querySelector('.tool-approve-btn');
  const denyBtn = chatTimeline.querySelector('.tool-deny-btn');

  approveBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(approveBtn.disabled, true, 'busy immediately after click');

  // Let the rejection propagate through the .catch chain.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(approveBtn.disabled, false, 'approve button re-enabled after failure');
  assert.equal(approveBtn.hasAttribute('aria-busy'), false, 'aria-busy cleared after failure');
  assert.equal(denyBtn.disabled, false, 'deny button re-enabled after failure');
  assert.equal(denyBtn.hasAttribute('aria-busy'), false, 'sibling aria-busy cleared after failure');

  assert.equal(composerErrors.length, 1, 'showComposerActionError called exactly once (visible-error path)');
  assert.equal(composerErrors[0].error, failure);
  assert.equal(composerErrors[0].title, 'Approval Failed');

  assert.equal(clientLogs.length, 1, 'appendClientLog still called for diagnostics');
  assert.equal(clientLogs[0].event, 'tool.approve_failed');
});

test('A2: a rejected tools.deny re-enables the buttons and calls showComposerActionError with Deny Failed', async (t) => {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatTimeline">'
    + buildApprovalRowHtml('call_3')
    + '</div>'
    + '</body></html>');
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');

  const failure = new Error('deny-boom');
  installApprovalWindowGlobals(t, window, { deny: () => Promise.reject(failure) });

  const composerErrors = [];
  const bindings = createTranscriptEventBindings(
    buildNoopBindingDeps(chatTimeline, {
      resolveToolCallId: realResolveToolCallId,
      showComposerActionError: (error, title) => composerErrors.push({ error, title }),
    })
  );
  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });

  const approveBtn = chatTimeline.querySelector('.tool-approve-btn');
  const denyBtn = chatTimeline.querySelector('.tool-deny-btn');

  denyBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(denyBtn.disabled, true, 'busy immediately after click');

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(denyBtn.disabled, false, 'deny button re-enabled after failure');
  assert.equal(approveBtn.disabled, false, 'approve button re-enabled after failure');
  assert.equal(composerErrors.length, 1);
  assert.equal(composerErrors[0].title, 'Deny Failed');
});

test('A2: a resolved approval whose row is removed moves focus to the next pending approval row', async (t) => {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatTimeline">'
    + buildApprovalRowHtml('call_4')
    + buildApprovalRowHtml('call_5')
    + '</div>'
    + '</body></html>');
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');

  let resolveApprove;
  const pendingApprove = new Promise((resolve) => { resolveApprove = resolve; });
  installApprovalWindowGlobals(t, window, { approve: () => pendingApprove });

  const bindings = createTranscriptEventBindings(
    buildNoopBindingDeps(chatTimeline, { resolveToolCallId: realResolveToolCallId })
  );
  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });

  const firstRow = chatTimeline.querySelector('[data-tool-call-id="call_4"].approval-gap-row');
  const firstApproveBtn = firstRow.querySelector('.tool-approve-btn');

  // Focus must be inside the row at click time so the handler's heldFocus
  // snapshot is true â€” this is what makes the fallback-focus restore below
  // eligible to fire once the row is removed.
  firstApproveBtn.focus();
  firstApproveBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  resolveApprove(true);
  await Promise.resolve();
  await Promise.resolve();

  // Simulate the reducer/render pipeline resolving the approval and splicing
  // the row out of the DOM â€” this happens later, driven by a stream event,
  // not synchronously inside the click handler (see
  // renderer-turn-reducer-approval-gap.js::removeApprovalGapRow).
  firstRow.remove();
  await Promise.resolve();
  await Promise.resolve();

  const secondApproveBtn = chatTimeline.querySelector('[data-tool-call-id="call_5"].approval-gap-row .tool-approve-btn');
  assert.equal(
    window.document.activeElement,
    secondApproveBtn,
    'focus moves to the next pending approval row Allow button'
  );
});

test('A2: a resolved approval with no other pending rows falls back to the composer input', async (t) => {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<textarea id="chatInput"></textarea>'
    + '<div id="chatTimeline">'
    + buildApprovalRowHtml('call_6')
    + '</div>'
    + '</body></html>');
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');

  let resolveApprove;
  const pendingApprove = new Promise((resolve) => { resolveApprove = resolve; });
  installApprovalWindowGlobals(t, window, { approve: () => pendingApprove });

  const bindings = createTranscriptEventBindings(
    buildNoopBindingDeps(chatTimeline, { resolveToolCallId: realResolveToolCallId })
  );
  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });

  const row = chatTimeline.querySelector('.approval-gap-row');
  const approveBtn = row.querySelector('.tool-approve-btn');

  // Focus must be inside the row at click time so heldFocus is true and the
  // composer fallback restore below is eligible to fire.
  approveBtn.focus();
  approveBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  resolveApprove(true);
  await Promise.resolve();
  await Promise.resolve();

  row.remove();
  await Promise.resolve();
  await Promise.resolve();

  const chatInput = window.document.getElementById('chatInput');
  assert.equal(
    window.document.activeElement,
    chatInput,
    'focus falls back to the composer input when no pending approval rows remain'
  );
});

test('A2: does not steal focus back from the composer if the user moved focus away before row removal', async (t) => {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<textarea id="chatInput"></textarea>'
    + '<div id="chatTimeline">'
    + buildApprovalRowHtml('call_7')
    + buildApprovalRowHtml('call_8')
    + '</div>'
    + '</body></html>');
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');

  let resolveApprove;
  const pendingApprove = new Promise((resolve) => { resolveApprove = resolve; });
  installApprovalWindowGlobals(t, window, { approve: () => pendingApprove });

  const bindings = createTranscriptEventBindings(
    buildNoopBindingDeps(chatTimeline, { resolveToolCallId: realResolveToolCallId })
  );
  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });

  const firstRow = chatTimeline.querySelector('[data-tool-call-id="call_7"].approval-gap-row');
  const firstApproveBtn = firstRow.querySelector('.tool-approve-btn');

  firstApproveBtn.focus();
  firstApproveBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  resolveApprove(true);
  await Promise.resolve();
  await Promise.resolve();

  // The user moves focus into the composer BEFORE the row actually gets
  // removed (e.g. they started typing while the approval IPC was still
  // in flight / the reducer hadn't yet spliced the row out).
  const chatInput = window.document.getElementById('chatInput');
  chatInput.focus();
  assert.equal(window.document.activeElement, chatInput, 'precondition: composer holds focus before removal');

  // Now the reducer/render pipeline catches up and removes the row.
  firstRow.remove();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(
    window.document.activeElement,
    chatInput,
    'focus must stay on the composer, not get pulled to the next approval row'
  );
});
