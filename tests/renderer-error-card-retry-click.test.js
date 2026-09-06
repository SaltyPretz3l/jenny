/**
 * tests/renderer-error-card-retry-click.test.js
 *
 * EH-W4 gate — universal Retry/Regenerate on the unified error card.
 * jsdom is blind to hit-testing, so these are REAL delegated-listener
 * click tests: actual card markup + the actual transcript binding +
 * the actual shell-runtime recovery handler, with only the regenerate
 * sink spied.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const errorRecoveryUtils = require('../renderer/chat/renderer-error-recovery-utils');
const {
  createTranscriptEventBindings,
} = require('../renderer/chat/renderer-chat-event-transcript-bindings');
const {
  createShellRuntimeController,
} = require('../renderer/shell/renderer-shell-runtime-utils');

function buildBindingDeps(chatTimeline, handleErrorRecoveryAction) {
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
    handleErrorRecoveryAction,
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
  };
}

function mountCard(cardHtml) {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + `<div id="chatTimeline">${cardHtml}</div>`
    + '</body></html>');
  const chatTimeline = dom.window.document.getElementById('chatTimeline');
  const regenerateCalls = [];
  const controller = createShellRuntimeController({ state: {}, callbacks: {} });
  const bindings = createTranscriptEventBindings(buildBindingDeps(
    chatTimeline,
    (payload) => controller.handleErrorRecoveryAction(payload, {
      handleRegenerateMessage: async (messageId) => { regenerateCalls.push(messageId); },
    })
  ));
  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });
  return { window: dom.window, chatTimeline, regenerateCalls };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('universal Retry renders on retryable danger cards with empty recovery_actions and a message id', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    id: 'assistant_failed_1',
    stream_error: 'Provider exploded',
    error_code: 'CMP-AI-0005',
    retryable: true,
  });
  assert.ok(html.includes('data-inv-error-action="retry"'), 'retry emitted without backend actions');
  assert.ok(html.includes('data-message-id="assistant_failed_1"'), 'message id threaded to the button');
});

test('universal Retry is suppressed when a retry-like backend action exists', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    id: 'assistant_failed_1',
    stream_error: 'Sidecar exited',
    error_code: 'CMP-SIDECAR-0003',
    recovery_actions: [{ id: 'retry_turn', label: 'Retry turn' }],
  });
  assert.ok(html.includes('data-inv-error-action="retry_turn"'), 'backend retry kept');
  assert.ok(!html.includes('data-inv-error-action="retry"'), 'no duplicate universal retry');
});

test('universal Retry is omitted when no target message id resolves', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    stream_error: 'Generation failed',
    error_code: 'CMP-AI-0005',
  });
  assert.ok(!html.includes('data-inv-error-action="retry"'), 'non-retryable provider without id stays retry-free');
});

test('retryable calm cards offer Regenerate response when a message id resolves', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    id: 'assistant_cancelled_1',
    stream_error: 'Turn cancelled',
    recovery_class: 'cancelled',
    retryable: true,
  });
  assert.ok(html.includes('Regenerate response'), 'calm regenerate label');
  assert.ok(html.includes('data-inv-error-action="retry"'), 'regenerate uses the retry action id');
  assert.ok(html.includes('inv-error-action--muted'), 'calm regenerate is muted');
});

test('danger card Retry click flows through the real delegated listener into regenerate', async () => {
  const cardHtml = errorRecoveryUtils.renderTimelineErrorCard({
    id: 'assistant_failed_1',
    session_id: 'sess_1',
    stream_error: 'Provider exploded',
    error_code: 'CMP-AI-0005',
    retryable: true,
  });
  const { window, chatTimeline, regenerateCalls } = mountCard(cardHtml);

  const retryButton = chatTimeline.querySelector('[data-inv-error-action="retry"]');
  assert.ok(retryButton, 'universal retry button mounted');
  const clickEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  retryButton.dispatchEvent(clickEvent);
  await settle();

  assert.equal(clickEvent.defaultPrevented, true, 'delegated listener claimed the click');
  assert.deepEqual(regenerateCalls, ['assistant_failed_1'], 'regenerate fired with the failed message id');
});

test('rapid Retry double-click remains single-flight', async () => {
  const cardHtml = errorRecoveryUtils.renderTimelineErrorCard({
    id: 'assistant_failed_1',
    stream_error: 'Provider exploded',
    error_code: 'CMP-AI-0005',
    retryable: true,
  });
  const { window, chatTimeline, regenerateCalls } = mountCard(cardHtml);
  const retryButton = chatTimeline.querySelector('[data-inv-error-action="retry"]');
  const click = () => retryButton.dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true })
  );

  click();
  click();
  await settle();

  assert.deepEqual(regenerateCalls, ['assistant_failed_1']);
});

test('calm card Regenerate click resolves the cancelled message id', async () => {
  const cardHtml = errorRecoveryUtils.renderTimelineErrorCard({
    id: 'assistant_cancelled_1',
    stream_error: 'Turn cancelled',
    recovery_class: 'cancelled',
    retryable: true,
  });
  const { window, chatTimeline, regenerateCalls } = mountCard(cardHtml);

  const regenerateButton = chatTimeline.querySelector('[data-inv-error-action="retry"]');
  assert.ok(regenerateButton, 'regenerate button mounted');
  regenerateButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle();

  assert.deepEqual(regenerateCalls, ['assistant_cancelled_1']);
});

test('retry without an own message id falls back to the closest data-message-id ancestor', async () => {
  /* Transport error without an id synthesizes a local Retry (W3 path);
   * resolveActionMessageId must walk up to the owning article. */
  const cardHtml = errorRecoveryUtils.renderTimelineErrorCard({
    stream_error: 'Connection failed',
    error_code: 'CMP-AI-0002',
  });
  assert.ok(cardHtml.includes('data-inv-error-action="retry"'), 'local transport retry present');
  assert.ok(!cardHtml.includes('data-message-id'), 'no own message id on the button');
  const wrapped = `<article data-message-id="assistant_outer_1">${cardHtml}</article>`;
  const { window, chatTimeline, regenerateCalls } = mountCard(wrapped);

  chatTimeline.querySelector('[data-inv-error-action="retry"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle();

  assert.deepEqual(regenerateCalls, ['assistant_outer_1'], 'closest ancestor id resolved');
});

/* ── Logs deep link (Slice 4): chip click/keyboard -> Activity selection ── */

function makeLogsDeepLinkController(logs, extraCallbacks = {}) {
  const setActiveViewCalls = [];
  const dispatched = [];
  const clientLogs = [];
  const state = { logs, ui: {} };
  const windowRef = {
    CustomEvent: class CustomEventStub {
      constructor(type, init) {
        this.type = type;
        this.detail = init && init.detail;
      }
    },
    dispatchEvent: (event) => { dispatched.push(event); return true; },
  };
  const controller = createShellRuntimeController({
    state,
    windowRef,
    callbacks: {
      setActiveView: (view) => setActiveViewCalls.push(view),
      appendClientLog: (level, event, data) => clientLogs.push({ level, event, data }),
      ...extraCallbacks,
    },
  });
  return { controller, state, setActiveViewCalls, dispatched, clientLogs };
}

const TURN_DIAGNOSTIC_ENTRY = {
  entry_id: 'entry_turn_diag',
  run_id: 'run_1',
  level: 'INFO',
  event: 'chat.turn_diagnostic_dumped',
  data: { streamId: 'stream_abc' },
};

test('open_logs with a matching stream id selects the diagnostic event in Activity', async () => {
  const { controller, state, setActiveViewCalls, dispatched, clientLogs } = makeLogsDeepLinkController([
    { entry_id: 'entry_other', run_id: 'run_1', event: 'chat.token', data: { streamId: 'stream_zzz' } },
    TURN_DIAGNOSTIC_ENTRY,
  ]);
  state.ui.logs = {
    activeTab: 'overview', query: 'noise', levelFilter: 'error',
    sourceFilter: 'sidecar', autoScroll: true,
  };

  await controller.handleErrorRecoveryAction({ action: 'open_logs', streamId: 'stream_abc' });

  assert.deepEqual(setActiveViewCalls, ['logs'], 'navigates to the logs view');
  assert.equal(state.ui.logs.activeTab, 'activity', 'activity tab flips');
  assert.equal(state.ui.logs.selectedEntryId, 'entry_turn_diag', 'target entry selected');
  assert.equal(state.ui.logs.autoScroll, false, 'follow-latest disengages so the row stays put');
  assert.equal(state.ui.logs.query, '', 'stale filters cleared so the row survives filterEntries()');
  assert.equal(state.ui.logs.levelFilter, 'all');
  assert.equal(state.ui.logs.sourceFilter, 'all');
  assert.equal(state.ui.logs.selectedRunId, 'run_1', 'run switched to the entry owner');
  assert.equal(dispatched.length, 1, 'row focus requested from the diagnostics bindings');
  assert.equal(dispatched[0].type, 'diagnostics:focus-log-entry');
  assert.deepEqual(dispatched[0].detail, { entryId: 'entry_turn_diag' });
  assert.equal(clientLogs.at(-1).data.matched, true, 'match recorded for observability');
});

test('open_logs prefers the turn diagnostic event over other stream-tagged rows', async () => {
  const { controller, state } = makeLogsDeepLinkController([
    { entry_id: 'entry_early', run_id: 'run_1', event: 'chat.error', data: { stream_id: 'stream_abc' } },
    TURN_DIAGNOSTIC_ENTRY,
  ]);

  await controller.handleErrorRecoveryAction({ action: 'open_logs', streamId: 'stream_abc' });
  assert.equal(state.ui.logs.selectedEntryId, 'entry_turn_diag');
});

test('open_logs falls back to any entry carrying the stream id', async () => {
  const { controller, state } = makeLogsDeepLinkController([
    {
      origin_entry_id: 'entry_local', run_id: 'run_1', event: 'chat.error',
      details: { stream_id: 'stream_abc' },
    },
  ]);

  await controller.handleErrorRecoveryAction({ action: 'open_logs', streamId: 'stream_abc' });
  assert.equal(state.ui.logs.selectedEntryId, 'entry_local', 'origin_entry_id keys local renderer rows');
});

test('open_logs with no matching entry opens Activity plainly and never throws', async () => {
  const { controller, state, setActiveViewCalls, dispatched, clientLogs } = makeLogsDeepLinkController([
    { entry_id: 'entry_other', run_id: 'run_1', event: 'chat.token', data: { streamId: 'stream_zzz' } },
  ]);
  state.ui.logs = { activeTab: 'overview', query: 'noise', selectedEntryId: '', autoScroll: true };

  await controller.handleErrorRecoveryAction({ action: 'open_logs', streamId: 'stream_missing' });

  assert.deepEqual(setActiveViewCalls, ['logs'], 'still opens the logs view');
  assert.equal(state.ui.logs.activeTab, 'activity', 'still lands on Activity');
  assert.equal(state.ui.logs.selectedEntryId, '', 'nothing selected');
  assert.equal(state.ui.logs.query, 'noise', 'user filters untouched when there is nothing to reveal');
  assert.deepEqual(dispatched[0].detail, { entryId: '' }, 'repaint asked for, no row to focus');
  assert.equal(clientLogs.at(-1).data.matched, false, 'miss recorded, no toast, no error');
});

test('open_logs without a stream id keeps the plain legacy behaviour', async () => {
  const { controller, state, setActiveViewCalls, dispatched } = makeLogsDeepLinkController([TURN_DIAGNOSTIC_ENTRY]);

  await controller.handleErrorRecoveryAction({ action: 'open_logs' });
  await controller.handleErrorRecoveryAction({ action: 'open_diagnostics' });

  assert.deepEqual(setActiveViewCalls, ['logs', 'logs']);
  assert.ok(!state.ui.logs.selectedEntryId, 'nothing selected without a target');
  assert.equal(state.ui.logs.activeTab, 'activity');
  assert.equal(dispatched.length, 2, 'each open still asks Activity to repaint');
  assert.deepEqual(dispatched[0].detail, { entryId: '' });
});

test('open_diagnostics deep-links on the same stream id contract', async () => {
  const { controller, state } = makeLogsDeepLinkController([TURN_DIAGNOSTIC_ENTRY]);
  await controller.handleErrorRecoveryAction({ action: 'open_diagnostics', streamId: 'stream_abc' });
  assert.equal(state.ui.logs.selectedEntryId, 'entry_turn_diag');
});

function mountLinkedCard(cardHtml) {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + `<div id="chatTimeline">${cardHtml}</div>`
    + '</body></html>');
  const chatTimeline = dom.window.document.getElementById('chatTimeline');
  const payloads = [];
  const bindings = createTranscriptEventBindings(buildBindingDeps(chatTimeline, async (payload) => {
    payloads.push(payload);
  }));
  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });
  return { dom, chatTimeline, payloads };
}

test('chip click and Enter/Space all reach the handler with the stream id', async () => {
  const { dom, chatTimeline, payloads } = mountLinkedCard(errorRecoveryUtils.renderTimelineErrorCard({
    id: 'assistant_failed_link',
    stream_error: 'Provider exploded',
    error_code: 'CMP-AI-0005',
    stream_id: 'stream_abc',
  }));

  const chip = chatTimeline.querySelector('.chat-error-card-code[role="link"]');
  assert.ok(chip, 'chip mounted as a link');
  assert.equal(chip.getAttribute('tabindex'), '0');
  assert.equal(chip.getAttribute('title'), "View this error's diagnostic event in Activity");

  chip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(payloads.length, 1, 'click routed through the delegate');
  assert.equal(payloads[0].action, 'open_logs');
  assert.equal(payloads[0].streamId, 'stream_abc');

  for (const key of ['Enter', ' ']) {
    const keyEvent = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    chip.dispatchEvent(keyEvent);
    await settle();
    assert.equal(keyEvent.defaultPrevented, true, `${key} claimed by the keydown delegate`);
  }
  assert.equal(payloads.length, 3, 'Enter and Space each activated the chip once');
  assert.equal(payloads.at(-1).streamId, 'stream_abc');
});

test('View in logs button click carries the stream id too', async () => {
  const { dom, chatTimeline, payloads } = mountLinkedCard(errorRecoveryUtils.renderTimelineErrorCard({
    id: 'assistant_failed_link_button',
    stream_error: 'Provider exploded',
    error_code: 'CMP-AI-0005',
    stream_id: 'stream_abc',
  }));

  chatTimeline.querySelector('button[data-inv-error-action="open_logs"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle();

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].streamId, 'stream_abc');
});
