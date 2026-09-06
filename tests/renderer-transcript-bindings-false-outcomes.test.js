// CTL-009 acceptance contract: a resolved `false` from a timeline-affecting
// IPC call is a REFUSAL, not a success. The renderer must inspect the
// resolved outcome: on approve/deny `false` it re-enables the controls and
// surfaces a bounded "already resolved / no longer active" message (the
// batch Allow-All controller idiom, renderer-approval-batch-utils.js:184-203);
// on cancelStream `false` the stop path must not return a success shape.
// Transport rejections keep their existing error handling.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createTranscriptEventBindings,
} = require('../renderer/chat/renderer-chat-event-transcript-bindings');
const { createControllerHarness } = require('./helpers/send-controller-harness');

// --- helpers replicated from tests/renderer-chat-event-transcript-bindings.test.js ---

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

function buildApprovalRowHtml(callId) {
  return ''
    + `<div class="approval-gap-row" role="status" aria-live="polite" data-tool-call-id="${callId}" data-call-id="${callId}" data-approval-status="pending">`
    + `<div class="tool-approval-block" data-tool-call-id="${callId}" data-call-id="${callId}">`
    + '<p class="tool-approval-prompt">Approve this tool?</p>'
    + '<div class="tool-approval-actions">'
    + `<button class="tool-approve-btn" type="button" data-action="approve" data-tool-call-id="${callId}" data-call-id="${callId}" aria-label="Allow">Allow</button>`
    + `<button class="tool-deny-btn" type="button" data-action="deny" data-tool-call-id="${callId}" data-call-id="${callId}" aria-label="Deny">Deny</button>`
    + `<button class="tool-approve-btn tool-approve-always-btn" type="button" data-action="approve" data-approval-scope="always" data-tool-call-id="${callId}" data-call-id="${callId}" aria-label="Always allow">Always allow</button>`
    + '</div>'
    + '</div>'
    + '</div>';
}

function realResolveToolCallId(target) {
  const targetNode = target && typeof target.closest === 'function' ? target : null;
  const toolShell = targetNode?.closest('[data-approval-id], [data-call-id], [data-tool-call-id]');
  return toolShell?.dataset
    ? String(toolShell.dataset.approvalId || toolShell.dataset.toolCallId || toolShell.dataset.callId || '').trim()
    : '';
}

function installApprovalWindowGlobals(t, window, { approve, deny } = {}) {
  window.jennyShell = {
    tools: {
      approve: approve || (() => Promise.resolve(true)),
      deny: deny || (() => Promise.resolve(true)),
    },
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

function buildApprovalDom(callId) {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatTimeline">'
    + buildApprovalRowHtml(callId)
    + '</div>'
    + '</body></html>');
  return { dom, window: dom.window, chatTimeline: dom.window.document.getElementById('chatTimeline') };
}

function bindWithCaptures(t, window, chatTimeline, { approve, deny } = {}) {
  installApprovalWindowGlobals(t, window, { approve, deny });
  const composerErrors = [];
  const clientLogs = [];
  const bindings = createTranscriptEventBindings(
    buildNoopBindingDeps(chatTimeline, {
      state: { currentSessionId: 'session-1' },
      resolveToolCallId: realResolveToolCallId,
      showComposerActionError: (error, title) => composerErrors.push({ error, title }),
      appendClientLog: (level, event, meta) => clientLogs.push({ level, event, meta }),
    })
  );
  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });
  // A true-approval starts the approval-reconciliation timer (2.5s by default).
  // bindings.dispose() stops it via approvalReconciliation.dispose(); nothing
  // called it, so this file held the event loop ~2.5s past its last assertion.
  t.after(() => {
    try { bindings.dispose(); } catch { /* already disposed */ }
  });
  return { composerErrors, clientLogs };
}

async function flushMicrotasks(count = 8) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function click(window, element) {
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

// ---------------------------------------------------------------------------
// Approve / deny resolving `false`
// ---------------------------------------------------------------------------

test('tools.approve resolving false re-enables the controls and surfaces a bounded already-resolved message', async (t) => {
  const { window, chatTimeline } = buildApprovalDom('call_false_1');
  const { composerErrors } = bindWithCaptures(t, window, chatTimeline, {
    approve: () => Promise.resolve(false),
  });

  const approveBtn = chatTimeline.querySelector('.tool-approve-btn');
  const denyBtn = chatTimeline.querySelector('.tool-deny-btn');
  click(window, approveBtn);
  assert.equal(approveBtn.disabled, true, 'busy immediately after click');
  await flushMicrotasks();

  assert.equal(approveBtn.disabled, false, 'a refused approval must re-enable Allow');
  assert.equal(approveBtn.hasAttribute('aria-busy'), false, 'aria-busy cleared after refusal');
  assert.equal(denyBtn.disabled, false, 'a refused approval must re-enable Deny');
  assert.equal(composerErrors.length, 1, 'the refusal surfaces exactly one bounded message');
  assert.match(
    String(composerErrors[0].error?.message || composerErrors[0].error || ''),
    /already|no longer|not.*pending|resolved/i,
    'the message says the request is already resolved / no longer active'
  );
});

test('tools.deny resolving false re-enables the controls and surfaces a bounded message', async (t) => {
  const { window, chatTimeline } = buildApprovalDom('call_false_2');
  const { composerErrors } = bindWithCaptures(t, window, chatTimeline, {
    deny: () => Promise.resolve(false),
  });

  const approveBtn = chatTimeline.querySelector('.tool-approve-btn');
  const denyBtn = chatTimeline.querySelector('.tool-deny-btn');
  click(window, denyBtn);
  assert.equal(denyBtn.disabled, true, 'busy immediately after click');
  await flushMicrotasks();

  assert.equal(denyBtn.disabled, false, 'a refused deny must re-enable Deny');
  assert.equal(approveBtn.disabled, false, 'a refused deny must re-enable Allow');
  assert.equal(composerErrors.length, 1);
  assert.match(
    String(composerErrors[0].error?.message || composerErrors[0].error || ''),
    /already|no longer|not.*pending|resolved/i
  );
});

test('approve resolving false AFTER the row was removed (timeout race) still surfaces the bounded message without throwing', async (t) => {
  const { window, chatTimeline } = buildApprovalDom('call_false_3');
  let resolveApprove;
  const { composerErrors } = bindWithCaptures(t, window, chatTimeline, {
    approve: () => new Promise((resolve) => { resolveApprove = resolve; }),
  });

  const approveBtn = chatTimeline.querySelector('.tool-approve-btn');
  click(window, approveBtn);
  await flushMicrotasks();

  // The approval timed out backend-side; a stream event removed the row while
  // the click's IPC promise was still in flight.
  chatTimeline.querySelector('.approval-gap-row').remove();
  resolveApprove(false);
  await flushMicrotasks();

  assert.equal(composerErrors.length, 1, 'the refusal is still surfaced when the row is already gone');
});

test('duplicate clicks stay idempotent and a refused approval permits a retry', async (t) => {
  const { window, chatTimeline } = buildApprovalDom('call_false_4');
  let approveCalls = 0;
  bindWithCaptures(t, window, chatTimeline, {
    approve: () => {
      approveCalls += 1;
      return Promise.resolve(false);
    },
  });

  const approveBtn = chatTimeline.querySelector('.tool-approve-btn');
  click(window, approveBtn);
  // Second click while busy: ignored (double-click guard).
  click(window, approveBtn);
  assert.equal(approveCalls, 1, 'the busy guard keeps duplicate clicks idempotent');
  await flushMicrotasks();

  assert.equal(approveBtn.disabled, false, 'refusal re-enabled the button');
  click(window, approveBtn);
  await flushMicrotasks();
  assert.equal(approveCalls, 2, 'after a refusal the user can retry (controls are live again)');
});

// Green pin: a resolved `true` keeps today's behavior — the row is on its way
// out via the stream event, so the buttons stay busy and no message shows.
test('tools.approve resolving true keeps the busy state (row removal is the success path)', async (t) => {
  const { window, chatTimeline } = buildApprovalDom('call_true_1');
  const { composerErrors } = bindWithCaptures(t, window, chatTimeline, {
    approve: () => Promise.resolve(true),
  });

  const approveBtn = chatTimeline.querySelector('.tool-approve-btn');
  click(window, approveBtn);
  await flushMicrotasks();

  assert.equal(approveBtn.disabled, true, 'a successful approval leaves the row busy for stream-driven removal');
  assert.equal(composerErrors.length, 0, 'no error message on success');
});

// ---------------------------------------------------------------------------
// cancelStream resolving `false`
// ---------------------------------------------------------------------------

test('handleStopActiveStream must not return a success shape when cancelStream resolves false', async (t) => {
  const harness = createControllerHarness([]);
  t.after(() => harness.restore());

  harness.multiStreamController.registerStream('session-1', 'stream-refused');
  harness.state.currentSessionId = 'session-1';
  global.window.jennyShell.chat.cancelStream = async () => false;

  const result = await harness.controller.handleStopActiveStream();

  assert.equal(
    result,
    null,
    'a refused cancel (unknown/already-finished stream) must not report {streamId, sessionId} success'
  );
});

// Green pin: an accepted cancel still reports the cancelled stream.
test('handleStopActiveStream still returns the stream info when the backend accepts the cancel', async (t) => {
  const harness = createControllerHarness([]);
  t.after(() => harness.restore());

  harness.multiStreamController.registerStream('session-1', 'stream-accepted');
  harness.state.currentSessionId = 'session-1';
  global.window.jennyShell.chat.cancelStream = async () => true;

  const result = await harness.controller.handleStopActiveStream();

  assert.deepEqual(result, { streamId: 'stream-accepted', sessionId: 'session-1' });
});

test('the approval scope is the button that was pressed: Allow once never persists a policy', async (t) => {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatTimeline">'
    + buildApprovalRowHtml('call_once')
    + buildApprovalRowHtml('call_always')
    + '</div>'
    + '</body></html>');
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');
  const calls = [];
  installApprovalWindowGlobals(t, window, {
    approve: (callId, options) => { calls.push([callId, options]); return Promise.resolve(true); },
  });
  const bindings = createTranscriptEventBindings(
    buildNoopBindingDeps(chatTimeline, { resolveToolCallId: realResolveToolCallId })
  );
  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });

  const onceRow = chatTimeline.querySelector('[data-call-id="call_once"].approval-gap-row');
  const alwaysRow = chatTimeline.querySelector('[data-call-id="call_always"].approval-gap-row');
  onceRow.querySelector('.tool-approve-btn:not(.tool-approve-always-btn)')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  alwaysRow.querySelector('.tool-approve-always-btn')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await Promise.resolve();

  assert.deepEqual(calls, [
    ['call_once', { alwaysAllow: false }],
    ['call_always', { alwaysAllow: true }],
  ], 'Allow once never persists a policy; Always allow always does');
});
