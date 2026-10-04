'use strict';

/* CTR-006: every pane timeline owns one batch approval controller (pane 1 used
 * to have none, and the primary one was built outside the per-pane bindings).
 * CTR-007: batch and per-card actions share one in-flight claim per approval,
 * so a lost race sends no competing request and shows no false error.
 *
 * The bindings tests build the real transcript bindings over real jsdom
 * timelines, the way each pane's bindings are built; the harness tests drive
 * the real shell with two panes mounted. Every test uses its own approval ids
 * because the claim registry is shared across a window.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createTranscriptEventBindings } = require('../renderer/chat/renderer-chat-event-transcript-bindings');
const { approvalClaims } = require('../renderer/chat/renderer-approval-batch-utils');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

function flush(ms = 60) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rowHtml(callId) {
  return ''
    + `<div class="approval-gap-row" role="status" data-tool-call-id="${callId}" data-call-id="${callId}" data-approval-id="${callId}" data-approval-status="pending">`
    + `<div class="tool-approval-block" data-tool-call-id="${callId}" data-call-id="${callId}" data-approval-id="${callId}">`
    + '<div class="tool-approval-actions">'
    + `<button class="tool-approve-btn" type="button" data-action="approve" data-tool-call-id="${callId}" data-call-id="${callId}" data-approval-id="${callId}">Allow</button>`
    + `<button class="tool-deny-btn" type="button" data-action="deny" data-tool-call-id="${callId}" data-call-id="${callId}" data-approval-id="${callId}">Deny</button>`
    + '</div></div></div>';
}

function turnHtml(turnId, callIds) {
  return `<article class="chat-thread-node" data-thread-message-id="${turnId}"><div class="chat-thread-children">`
    + callIds.map(rowHtml).join('')
    + '</div></article>';
}

function realResolveToolCallId(target) {
  const shell = target && typeof target.closest === 'function' ? target.closest('[data-approval-id], [data-call-id], [data-tool-call-id]') : null;
  return shell?.dataset ? String(shell.dataset.approvalId || shell.dataset.toolCallId || shell.dataset.callId || '').trim() : '';
}

function setupWindow(t, timelineIds) {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + Object.entries(timelineIds).map(([id, callIds]) => `<div id="${id}">${turnHtml(`turn-${id}`, callIds)}</div>`).join('')
    + '</body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  const requests = [];
  const calls = { approve: [], deny: [] };
  const impl = { approve: () => Promise.resolve(true), deny: () => Promise.resolve(true) };
  window.jennyShell = {
    tools: {
      approve: (id, options) => { calls.approve.push(id); requests.push(['approve', id, options]); return impl.approve(id); },
      deny: (id) => { calls.deny.push(id); requests.push(['deny', id]); return impl.deny(id); },
    },
  };
  const previous = { window: global.window, document: global.document, MutationObserver: global.MutationObserver };
  global.window = window;
  global.document = window.document;
  global.MutationObserver = window.MutationObserver;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key]; else global[key] = value;
    }
    window.close();
  });
  return { window, doc: window.document, calls, requests, impl };
}

function bindPane(t, timeline, { sessionId = 'session-1' } = {}) {
  const errors = [];
  const logs = [];
  const bindings = createTranscriptEventBindings({
    chatTimeline: timeline,
    state: { currentSessionId: sessionId },
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
    appendClientLog: (level, event, meta) => logs.push({ level, event, meta }),
    showComposerActionError: (error, title) => errors.push({ error, title }),
    resolveToolCallId: realResolveToolCallId,
    toggleToolDetails: () => {},
    thinkingController: {},
  });
  bindings.bindTranscriptEvents((target, eventName, handler, options) => target.addEventListener(eventName, handler, options));
  t.after(() => { try { bindings.dispose(); } catch { /* already disposed */ } });
  return { bindings, errors, logs };
}

function click(window, element) {
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

function banner(timeline) {
  return timeline.querySelector('.approval-batch-banner');
}

function batchButton(timeline, action) {
  return timeline.querySelector(`[data-approval-batch-action="${action}"]`);
}

function deferred() {
  const entry = {};
  entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
  return entry;
}

function addPendingRow(window, timeline, callId) {
  const wrapper = window.document.createElement('div');
  wrapper.innerHTML = rowHtml(callId);
  timeline.querySelector('.chat-thread-children').appendChild(wrapper.firstElementChild);
}

// ---------------------------------------------------------------------------
// CTR-006: one batch controller per pane timeline
// ---------------------------------------------------------------------------

test('CTR-006: each pane timeline gets its own batch banner and a batch click resolves only that timeline\'s rows', async (t) => {
  const { window, doc, calls } = setupWindow(t, { paneA: ['p6a-1', 'p6a-2'], paneB: ['p6b-1', 'p6b-2'] });
  const paneA = doc.getElementById('paneA');
  const paneB = doc.getElementById('paneB');
  bindPane(t, paneA);
  bindPane(t, paneB);
  await flush();

  assert.ok(banner(paneA), 'pane A has a banner');
  assert.ok(banner(paneB), 'pane B has a banner');
  assert.equal(paneA.querySelectorAll('.approval-batch-banner').length, 1);
  assert.equal(paneB.querySelectorAll('.approval-batch-banner').length, 1);

  click(window, batchButton(paneB, 'approve-all-once'));
  await flush();

  assert.deepEqual(calls.approve, ['p6b-1', 'p6b-2'], 'only the second timeline\'s rows are sent');
  assert.equal(paneB.querySelectorAll('[data-approval-resolved="true"]').length, 2);
  assert.equal(paneA.querySelectorAll('[data-approval-resolved="true"]').length, 0, 'the first timeline is untouched');
  assert.equal(batchButton(paneA, 'approve-all-once').disabled, false, 'the first banner stays usable');
});

test('CTR-006: disposing one pane\'s bindings stops its banner sync and clicks without affecting the other', async (t) => {
  const { window, doc, calls } = setupWindow(t, { paneA: ['p6c-a1', 'p6c-a2'], paneB: ['p6c-b1', 'p6c-b2'] });
  const paneA = doc.getElementById('paneA');
  const paneB = doc.getElementById('paneB');
  const first = bindPane(t, paneA);
  bindPane(t, paneB);
  await flush();
  first.bindings.dispose();

  addPendingRow(window, paneA, 'p6c-a3');
  addPendingRow(window, paneB, 'p6c-b3');
  await flush();

  assert.equal(banner(paneA).getAttribute('data-pending-count'), '2', 'the disposed pane\'s banner no longer syncs');
  assert.equal(banner(paneB).getAttribute('data-pending-count'), '3', 'the live pane keeps syncing');

  click(window, batchButton(paneA, 'deny-all'));
  await flush();
  assert.deepEqual(calls.deny, [], 'a click on the disposed pane\'s banner sends nothing');

  click(window, batchButton(paneB, 'deny-all'));
  await flush();
  assert.deepEqual(calls.deny, ['p6c-b1', 'p6c-b2', 'p6c-b3']);
});

test('CTR-006: the primary pane has exactly one batch controller (one click sends one request per row)', async (t) => {
  const app = await loadRendererApp({});
  t.after(() => app.dispose());
  const { window } = app;
  await waitForUi(window, 150);
  const approvals = [];
  window.jennyShell.tools.approve = (id) => { approvals.push(id); return Promise.resolve(true); };
  const timeline = window.document.getElementById('chatTimeline');
  timeline.insertAdjacentHTML('beforeend', turnHtml('turn-primary', ['p6d-1', 'p6d-2']));
  await waitForUi(window, 80);

  assert.equal(timeline.querySelectorAll('.approval-batch-banner').length, 1);
  click(window, batchButton(timeline, 'approve-all-once'));
  await waitForUi(window, 80);

  assert.deepEqual(approvals, ['p6d-1', 'p6d-2'], 'one request per row, not one per controller');
});

test('CTR-006: a second mounted pane gets batch controls and resolves only its own rows', async (t) => {
  const app = await loadRendererApp({ shell: {
    sessions: [
      { id: 'session-a', title: 'Alpha', session_type: 'chat', conversation_mode: 'chat', preferred_model: 'gpt-test', reasoning_effort: 'default', plan_mode: false, pinned: false, archived_at: null, context_preferences: { history_scope: 'session', include_personality: true, include_memory: true }, linked_session_ids: [], interactive_round_count: 0, interactive_sequence_state: 'idle', pending_question_batch: null, updated_at: new Date().toISOString() },
      { id: 'session-b', title: 'Beta', session_type: 'chat', conversation_mode: 'chat', preferred_model: 'gpt-test', reasoning_effort: 'default', plan_mode: false, pinned: false, archived_at: null, context_preferences: { history_scope: 'session', include_personality: true, include_memory: true }, linked_session_ids: [], interactive_round_count: 0, interactive_sequence_state: 'idle', pending_question_batch: null, updated_at: new Date().toISOString() },
    ],
    workspaceState: { activeSessionId: 'session-a', openSessionIds: ['session-a', 'session-b'] },
    sessionMessagePayloads: {
      'session-a': { data: [{ id: 'u-a', role: 'user', content: 'Q a', status: 'complete' }] },
      'session-b': { data: [{ id: 'u-b', role: 'user', content: 'Q b', status: 'complete' }] },
    },
  } });
  t.after(() => app.dispose());
  const { window } = app;
  await waitForUi(window, 150);
  const composition = window.rendererAppPaneComposition.getPaneComposition();
  assert.equal(composition.toggleSplit(), true, 'precondition: the second pane opens');
  await waitForUi(window, 150);
  const pane1Timeline = composition.getPane(1).dom.chatTimeline;
  const pane0Timeline = window.document.getElementById('chatTimeline');
  assert.notEqual(pane1Timeline, pane0Timeline);
  const approvals = [];
  window.jennyShell.tools.approve = (id) => { approvals.push(id); return Promise.resolve(true); };
  pane0Timeline.insertAdjacentHTML('beforeend', turnHtml('turn-pane0', ['p6e-0a', 'p6e-0b']));
  pane1Timeline.insertAdjacentHTML('beforeend', turnHtml('turn-pane1', ['p6e-1a', 'p6e-1b']));
  await waitForUi(window, 100);

  assert.equal(pane0Timeline.querySelectorAll('.approval-batch-banner').length, 1);
  assert.equal(pane1Timeline.querySelectorAll('.approval-batch-banner').length, 1, 'pane 1 has the same batch actions as pane 0');
  click(window, batchButton(pane1Timeline, 'approve-all-once'));
  await waitForUi(window, 80);

  assert.deepEqual(approvals, ['p6e-1a', 'p6e-1b'], 'the click in pane 1 resolves pane 1\'s rows only');
});

// ---------------------------------------------------------------------------
// CTR-007: one in-flight claim per approval
// ---------------------------------------------------------------------------

test('CTR-007: a card Allow during an outstanding batch approve sends nothing and shows no error', async (t) => {
  const { window, doc, calls, impl } = setupWindow(t, { pane: ['p7a-1', 'p7a-2'] });
  const timeline = doc.getElementById('pane');
  const pending = { 'p7a-1': deferred(), 'p7a-2': deferred() };
  impl.approve = (id) => pending[id].promise;
  const { errors } = bindPane(t, timeline);
  await flush();

  click(window, batchButton(timeline, 'approve-all-once'));
  await flush(20);
  assert.deepEqual(calls.approve, ['p7a-1', 'p7a-2']);
  const firstRow = timeline.querySelector('[data-approval-id="p7a-1"].approval-gap-row');
  assert.equal(firstRow.querySelector('.tool-approve-btn').disabled, true, 'the card is busy while the batch request is out');
  assert.equal(firstRow.querySelector('.tool-deny-btn').getAttribute('aria-busy'), 'true');
  assert.equal(approvalClaims.has('p7a-1'), true);

  // A re-render can hand the user a fresh, enabled card for the same approval.
  const wrapper = doc.createElement('div');
  wrapper.innerHTML = rowHtml('p7a-1');
  const freshRow = wrapper.firstElementChild;
  firstRow.replaceWith(freshRow);
  click(window, freshRow.querySelector('.tool-approve-btn'));
  click(window, freshRow.querySelector('.tool-deny-btn'));
  await flush(20);

  assert.deepEqual(calls.approve, ['p7a-1', 'p7a-2'], 'no competing approve');
  assert.deepEqual(calls.deny, [], 'no competing deny');
  assert.equal(errors.length, 0, 'the lost race shows no toast');

  pending['p7a-1'].resolve(true);
  pending['p7a-2'].resolve(true);
  await flush(20);
  assert.equal(errors.length, 0);
  assert.equal(approvalClaims.has('p7a-1'), false, 'a settled batch row is released');
  assert.equal(approvalClaims.has('p7a-2'), false);
});

test('CTR-007: a batch click while a card request is in flight skips that row', async (t) => {
  const { window, doc, calls, impl } = setupWindow(t, { pane: ['p7b-1', 'p7b-2'] });
  const timeline = doc.getElementById('pane');
  const cardRequest = deferred();
  impl.approve = (id) => (id === 'p7b-1' ? cardRequest.promise : Promise.resolve(true));
  const { errors } = bindPane(t, timeline);
  await flush();

  click(window, timeline.querySelector('[data-approval-id="p7b-1"] .tool-approve-btn'));
  await flush(20);
  assert.deepEqual(calls.approve, ['p7b-1']);

  click(window, batchButton(timeline, 'approve-all-once'));
  await flush(20);

  assert.deepEqual(calls.approve, ['p7b-1', 'p7b-2'], 'the card\'s row is skipped; only the other row is sent by the batch');
  cardRequest.resolve(true);
  await flush(20);
  assert.equal(errors.length, 0, 'no error toast from the skipped row');
  assert.equal(approvalClaims.has('p7b-1'), false);
});

test('CTR-007: a batch deny-all skips a row whose card Deny is in flight', async (t) => {
  const { window, doc, calls, impl } = setupWindow(t, { pane: ['p7c-1', 'p7c-2'] });
  const timeline = doc.getElementById('pane');
  const cardRequest = deferred();
  impl.deny = (id) => (id === 'p7c-1' ? cardRequest.promise : Promise.resolve(true));
  const { errors } = bindPane(t, timeline);
  await flush();

  click(window, timeline.querySelector('[data-approval-id="p7c-1"] .tool-deny-btn'));
  await flush(20);
  click(window, batchButton(timeline, 'deny-all'));
  await flush(20);

  assert.deepEqual(calls.deny, ['p7c-1', 'p7c-2']);
  cardRequest.resolve(true);
  await flush(20);
  assert.equal(errors.length, 0);
});

test('CTR-007: a rejected batch request releases the claim, re-enables the card, reports once, and a card retry sends', async (t) => {
  const { window, doc, calls, impl } = setupWindow(t, { pane: ['p7d-1', 'p7d-2'] });
  const timeline = doc.getElementById('pane');
  let firstAttempt = true;
  impl.approve = (id) => {
    if (id === 'p7d-1' && firstAttempt) { firstAttempt = false; return Promise.reject(new Error('backend rejected')); }
    return Promise.resolve(true);
  };
  const { errors, logs } = bindPane(t, timeline);
  await flush();

  click(window, batchButton(timeline, 'approve-all-once'));
  await flush();

  const firstRow = timeline.querySelector('[data-approval-id="p7d-1"].approval-gap-row');
  assert.equal(errors.length, 1, 'one visible error for the one failed row');
  assert.equal(errors[0].title, 'Approval Failed');
  assert.deepEqual(logs.filter((entry) => entry.event === 'tool.approve_failed').map((entry) => entry.meta),
    [{ callId: 'p7d-1', batch_action: 'approve-all-once', message: 'backend rejected' }]);
  assert.equal(approvalClaims.has('p7d-1'), false, 'the failed row is released');
  assert.equal(firstRow.querySelector('.tool-approve-btn').disabled, false, 'the card is usable again');
  assert.equal(firstRow.querySelector('.tool-approve-btn').hasAttribute('aria-busy'), false);

  click(window, firstRow.querySelector('.tool-approve-btn'));
  await flush(20);
  assert.deepEqual(calls.approve, ['p7d-1', 'p7d-2', 'p7d-1'], 'the retry from the card reaches the backend');
  assert.equal(errors.length, 1);
});

test('CTR-007: a batch request that resolves false reports once and releases the row', async (t) => {
  const { window, doc, calls, impl } = setupWindow(t, { pane: ['p7e-1', 'p7e-2'] });
  const timeline = doc.getElementById('pane');
  impl.deny = () => Promise.resolve(false);
  const { errors, logs } = bindPane(t, timeline);
  await flush();

  click(window, batchButton(timeline, 'deny-all'));
  await flush();

  assert.deepEqual(calls.deny, ['p7e-1', 'p7e-2']);
  assert.equal(errors.length, 2, 'one error per refused row, none from a competing request');
  assert.equal(errors[0].title, 'Deny Failed');
  assert.equal(logs.filter((entry) => entry.event === 'tool.deny_failed').length, 2);
  assert.equal(approvalClaims.has('p7e-1'), false);
  assert.equal(timeline.querySelector('[data-approval-id="p7e-1"] .tool-deny-btn').disabled, false);
});

test('CTR-007: a rejected card request releases the claim so the batch can retry that row', async (t) => {
  const { window, doc, calls, impl } = setupWindow(t, { pane: ['p7f-1', 'p7f-2'] });
  const timeline = doc.getElementById('pane');
  let firstAttempt = true;
  impl.approve = (id) => {
    if (id === 'p7f-1' && firstAttempt) { firstAttempt = false; return Promise.reject(new Error('backend rejected')); }
    return Promise.resolve(true);
  };
  const { errors } = bindPane(t, timeline);
  await flush();

  click(window, timeline.querySelector('[data-approval-id="p7f-1"] .tool-approve-btn'));
  await flush(20);
  assert.equal(errors.length, 1);
  assert.equal(approvalClaims.has('p7f-1'), false, 'the failed card releases its claim');

  click(window, batchButton(timeline, 'approve-all-once'));
  await flush();
  assert.deepEqual(calls.approve, ['p7f-1', 'p7f-1', 'p7f-2'], 'the batch retries the row the card failed on');
  assert.equal(errors.length, 1);
});

test('CTR-007: a card request that throws before it is sent releases the claim, so a retry sends', async (t) => {
  const { window, doc, calls, impl } = setupWindow(t, { pane: ['p7f-1'] });
  const timeline = doc.getElementById('pane');
  let firstAttempt = true;
  impl.approve = () => {
    if (firstAttempt) { firstAttempt = false; throw new Error('bridge unavailable'); }
    return Promise.resolve(true);
  };
  const { errors } = bindPane(t, timeline);
  await flush();

  const approve = timeline.querySelector('.tool-approve-btn');
  click(window, approve);
  await flush(20);
  assert.equal(errors.length, 1, 'the failure is reported');
  assert.equal(approvalClaims.has('p7f-1'), false, 'the claim does not outlive the failed attempt');
  assert.equal(approve.disabled, false);

  click(window, approve);
  await flush(20);
  assert.deepEqual(calls.approve, ['p7f-1', 'p7f-1'], 'the second click reaches the backend');
});
