'use strict';
/**
 * tests/renderer-resume-interrupted-reply.test.js
 *
 * Gate F9 (2026-10-05): a reply stopped because Jenny closed shows one calm
 * "Stopped when Jenny closed" card. Its Resume moves the run the restart
 * paused (the same work the queue strip shows), never a regenerated copy; a
 * run the runtime cannot resume (no checkpoint for its attempt) offers Run
 * again, which discards that paused run before regenerating. Real card
 * markup, the real transcript binding and the real shell-runtime handler;
 * only the runtime and the toast sink are stubbed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { summary, queueHarness } = require('./helpers/durable-send-queue-harness');
const errorRecoveryUtils = require('../renderer/chat/renderer-error-recovery-utils');
const { createTranscriptEventBindings } = require('../renderer/chat/renderer-chat-event-transcript-bindings');
const { createShellRuntimeController } = require('../renderer/shell/renderer-shell-runtime-utils');

const pausedRead = (streamId, owner = 'work_2') => payload => ({ ok: true, work: { work_id: payload.work_id, session_id: 'session-1',
  turn_id: payload.work_id.replace('work_', 'turn_'), status: 'paused', revision: 6,
  attempt: { attempt_id: 'attempt_1', stream_id: payload.work_id === owner ? streamId : 'stream_other' } } });

test('interruptedReplyKey names the paused work whose attempt owns the stopped stream', async t => {
  const { h, calls } = queueHarness(t, {
    snapshot: () => ({ ok: true, next_cursor: null,
      work: [summary(1, { status: 'paused' }), summary(2, { status: 'paused' }), summary(3)] }),
    getWork: pausedRead('stream_stopped'),
    resume: () => ({ ok: true, work_id: 'work_2' }),
  });
  const controller = h.state.runtimeSendController;
  const key = await controller.interruptedReplyKey('session-1', 'stream_stopped');
  assert.equal(key, 'work:work_2');
  assert.equal(await controller.resume(key), true);
  assert.deepEqual(calls.resumes, [{ work_id: 'work_2', expected_revision: 6 }], 'only the matching run resumes');
});

test('interruptedReplyKey is empty when no paused work owns the stream', async t => {
  const { h } = queueHarness(t, {
    snapshot: () => ({ ok: true, next_cursor: null, work: [summary(1, { status: 'paused' }), summary(2)] }),
    getWork: pausedRead('stream_elsewhere'),
  });
  const controller = h.state.runtimeSendController;
  assert.equal(await controller.interruptedReplyKey('session-1', 'stream_stopped'), '');
  assert.equal(await controller.interruptedReplyKey('session-1', ''), '');
  assert.equal(await controller.interruptedReplyKey('', 'stream_stopped'), '');
});

// Astra review: an interrupted reply behind 100 newer runs sits on page two.
test('interruptedReplyKey follows the snapshot cursor past the first page', async t => {
  let page = 0;
  const { h, calls } = queueHarness(t, {
    snapshot: () => (++page === 1
      ? { ok: true, next_cursor: 'cursor_2', work: [summary(1), summary(3, { status: 'completed' })] }
      : { ok: true, next_cursor: null, work: [summary(2, { status: 'paused' })] }),
    getWork: pausedRead('stream_stopped'),
  });
  assert.equal(await h.state.runtimeSendController.interruptedReplyKey('session-1', 'stream_stopped'), 'work:work_2');
  assert.deepEqual(calls.snapshots.slice(-2), [{ session_id: 'session-1', limit: 100 },
    { session_id: 'session-1', limit: 100, cursor: 'cursor_2' }]);
});

test('a failed or stale page read reports no work instead of guessing', async t => {
  const { h } = queueHarness(t, {
    snapshot: () => ({ ok: false, error: { reason: 'runtime_cursor_stale' } }),
    getWork: pausedRead('stream_stopped'),
  });
  assert.equal(await h.state.runtimeSendController.interruptedReplyKey('session-1', 'stream_stopped'), '');
});

function interruptedCard(recoveryClass, actionId, extra = {}) {
  return errorRecoveryUtils.renderTimelineErrorCard({
    id: 'assistant_stopped_1', session_id: 'session-1', stream_id: 'stream_stopped',
    stream_error: 'Jenny closed before this reply finished.',
    terminal_subcode: recoveryClass === 'app_restart' ? 'app_restart' : 'app_restart_unresumable',
    recovery_class: recoveryClass, next_action: actionId,
    recovery_actions: [{ id: actionId, label: actionId === 'resume_paused_reply' ? 'Resume' : 'Run again' }],
    ...extra,
  });
}

// Live recheck 2026-10-05: after Run again the old card kept a working button.
// Once a newer reply sits below (the row is superseded), the card is a record.
for (const [recoveryClass, actionId] of [['app_restart', 'resume_paused_reply'], ['app_restart_rerun', 'rerun_interrupted_reply']]) {
  test(`a superseded ${recoveryClass} card offers no ${actionId} and says the reply continues below`, () => {
    const html = interruptedCard(recoveryClass, actionId, { superseded: true });
    assert.ok(html.includes('data-error-severity="calm"'), 'still calm');
    assert.ok(html.includes('data-error-settled="true"'), 'marked settled');
    assert.ok(html.includes('chat-error-card--settled'), 'settled class for the muted title');
    assert.equal(/data-inv-error-action=/.test(html), false, 'no live button of any kind');
    assert.match(html, /The reply continues below\./);
    assert.equal(/chat-error-card-actions/.test(html), false, 'no empty action row');
  });
}

for (const [recoveryClass, actionId] of [['app_restart', 'resume_paused_reply'], ['app_restart_rerun', 'rerun_interrupted_reply']]) {
  test(`a ${recoveryClass} card is calm and leads with a primary ${actionId} that names its stream`, () => {
    assert.equal(errorRecoveryUtils.resolveErrorSeverity({ recovery_class: recoveryClass }), 'calm');
    const html = interruptedCard(recoveryClass, actionId);
    assert.ok(html.includes('data-error-severity="calm"'), 'not a fault: calm severity');
    const button = html.match(new RegExp(`<button[^>]*data-inv-error-action="${actionId}"[^>]*>`));
    assert.ok(button, 'action button rendered');
    assert.match(button[0], /data-stream-id="stream_stopped"/);
    assert.match(button[0], /data-message-id="assistant_stopped_1"/);
    assert.match(button[0], /inv-error-action--primary/);
    assert.equal(/retry_turn|data-inv-error-action="retry"/.test(html), false, 'no second copy offered');
  });
}

function mount(cardHtml, runtimeSendController) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="chatTimeline">${cardHtml}</div></body></html>`);
  const chatTimeline = dom.window.document.getElementById('chatTimeline');
  const toasts = [];
  const log = [];
  const controller = createShellRuntimeController({
    state: { currentSessionId: 'session-1', runtimeSendController },
    callbacks: { showToastMessage: (message, options) => toasts.push({ message, options }) },
  });
  const noop = () => {};
  const asyncNoop = async () => {};
  const bindings = createTranscriptEventBindings({
    chatTimeline, state: {}, handleBranchMessage: asyncNoop, handleCopyMessage: asyncNoop,
    handleRegenerateMessage: asyncNoop, handleElaborateMessage: asyncNoop, handleFollowUpMessage: asyncNoop,
    handleUseProactiveSuggestionMessage: asyncNoop, handleSaveProactiveSuggestionMessage: asyncNoop,
    handleLaterProactiveSuggestionMessage: asyncNoop,
    handleErrorRecoveryAction: payload => controller.handleErrorRecoveryAction(payload, {
      handleRegenerateMessage: async (id, options) => { log.push(['regenerate', id, options?.failureRetry === true]); } }),
    handleArtifactAction: asyncNoop, toggleInteractiveRoundRecap: asyncNoop, toggleThreadBranch: noop,
    setReasoningPhaseExpandedPreference: noop, syncThinkingBlockNode: noop, appendClientLog: noop,
    showComposerActionError: noop, resolveToolCallId: () => '', toggleToolDetails: noop, thinkingController: {},
  });
  bindings.bindTranscriptEvents((target, eventName, handler, options) => target.addEventListener(eventName, handler, options));
  const click = async (actionId) => {
    chatTimeline.querySelector(`[data-inv-error-action="${actionId}"]`)
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    for (let i = 0; i < 4; i += 1) await new Promise(resolve => setImmediate(resolve));
  };
  return { click, toasts, log };
}

function fakeRuntime(log, { key = 'work:work_2', withdrawOk = true } = {}) {
  return {
    interruptedReplyKey: async (sessionId, streamId) => { log.push(['lookup', sessionId, streamId]); return key; },
    resume: async (k) => { log.push(['resume', k]); return true; },
    withdraw: async (k) => { log.push(['withdraw', k]); return withdrawOk; },
  };
}

test('Resume on the card resumes that stream\'s run and never regenerates', async () => {
  const log = [];
  const view = mount(interruptedCard('app_restart', 'resume_paused_reply'), fakeRuntime(log));
  await view.click('resume_paused_reply');
  assert.deepEqual(log, [['lookup', 'session-1', 'stream_stopped'], ['resume', 'work:work_2']]);
  assert.deepEqual(view.log, []);
  assert.deepEqual(view.toasts, []);
});

test('a reply that can no longer be resumed says so instead of failing silently', async () => {
  const log = [];
  const view = mount(interruptedCard('app_restart', 'resume_paused_reply'), fakeRuntime(log, { key: '' }));
  await view.click('resume_paused_reply');
  assert.equal(view.toasts.length, 1);
  assert.match(view.toasts[0].message, /can no longer be resumed/);
  assert.equal(view.toasts[0].options.title, 'Resume unavailable');
  assert.deepEqual(view.log, []);
});

test('Run again discards the unresumable paused run first, then regenerates once', async () => {
  const log = [];
  const view = mount(interruptedCard('app_restart_rerun', 'rerun_interrupted_reply'), fakeRuntime(log));
  await view.click('rerun_interrupted_reply');
  assert.deepEqual(log, [['lookup', 'session-1', 'stream_stopped'], ['withdraw', 'work:work_2']]);
  assert.deepEqual(view.log, [['regenerate', 'assistant_stopped_1', true]]);
});

test('Run again never regenerates while the paused run refuses to be discarded', async () => {
  const log = [];
  const view = mount(interruptedCard('app_restart_rerun', 'rerun_interrupted_reply'), fakeRuntime(log, { withdrawOk: false }));
  await view.click('rerun_interrupted_reply');
  assert.deepEqual(view.log, [], 'two copies would run');
});

test('Run again regenerates directly when the paused run is already gone', async () => {
  const log = [];
  const view = mount(interruptedCard('app_restart_rerun', 'rerun_interrupted_reply'), fakeRuntime(log, { key: '' }));
  await view.click('rerun_interrupted_reply');
  assert.deepEqual(log, [['lookup', 'session-1', 'stream_stopped']]);
  assert.deepEqual(view.log, [['regenerate', 'assistant_stopped_1', true]]);
});
