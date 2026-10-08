// HB-038 H2 (dogfood, owner pick B 2026-10-05): a resolved approval keeps its
// approval_gap row as a one-line receipt in the live turn and in the saved
// chat. Splicing the card out on resolve dropped the pinned tail by the card's
// height (278-588 px, 5 of 5 approvals in dogfood B16).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  applyApprovalReceipt,
  deriveApprovalReceipt,
  renderApprovalBlock,
} = require('../renderer/chat/renderer-approval-block');
const {
  applyTurnStreamEvent,
  buildTurnEventFromStreamPayload,
  createTurnReducerState,
  reconcileTurnRows,
} = require('../renderer/chat/renderer-turn-reducer');
const { projectTurn, projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const { createTurnRowToolRenderUtils } = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const { waitForToolApproval } = require('../services/backend/chat-stream-tool-handling');
const { CanonicalTurnEventCollector } = require('../services/backend/canonical-turn-event-collector');

const DETERMINISTIC = Object.freeze({ deterministicRowId: true });

test('deriveApprovalReceipt names the decision from the call record', () => {
  const approved = (scope) => ({
    tool_name: 'run_command', state: 'completed',
    approval_resolutions: [{ status: 'approved', approval_state: 'approved', ...(scope ? { approval_scope: scope } : {}) }],
  });
  assert.deepEqual(deriveApprovalReceipt(approved('once')), { decision: 'allowed', scope: 'once' });
  assert.deepEqual(deriveApprovalReceipt(approved('always')), { decision: 'allowed', scope: 'always' });
  assert.deepEqual(deriveApprovalReceipt(approved('')), { decision: 'allowed' }, 'a chat saved before scopes were recorded');
  assert.deepEqual(deriveApprovalReceipt({ tool_name: 'run_command', state: 'denied' }), { decision: 'denied' });
  // The reader's answer outranks the call's own outcome (Astra, 2026-10-05).
  assert.deepEqual(deriveApprovalReceipt({ ...approved('once'), state: 'timed_out' }), { decision: 'allowed', scope: 'once' });
  assert.deepEqual(deriveApprovalReceipt({ tool_name: 'run_command', state: 'timed_out' }), { decision: 'timed_out' });
  assert.deepEqual(deriveApprovalReceipt({ tool_name: 'run_command', state: 'cancelled' }), { decision: 'cancelled' });
  // A call that ran was allowed even when the answer itself was not recorded.
  assert.deepEqual(deriveApprovalReceipt({ tool_name: 'run_command', state: 'running' }), { decision: 'allowed' });
  assert.deepEqual(deriveApprovalReceipt({ tool_name: 'run_command', state: 'abandoned' }), { decision: 'closed' });
  assert.equal(deriveApprovalReceipt({ tool_name: 'run_command', state: 'awaiting_approval' }), null, 'still waiting: no receipt');
  assert.equal(deriveApprovalReceipt({ ...approved('once'), tool_name: 'exit_plan_mode' }), null, 'the plan card owns its record');
});

test('applyApprovalReceipt settles the row payload and clears a stale scope', () => {
  const payload = { state: 'awaiting_approval', status: 'pending', approval_scope: 'always' };
  applyApprovalReceipt(payload, { decision: 'denied' });
  assert.deepEqual(payload, { state: 'resolved', status: 'resolved', decision: 'denied' });
});

function receiptDom(options) {
  const html = renderApprovalBlock({
    toolCallId: 'call-1', toolName: 'run_command', displayToolName: 'Run command',
    mode: 'inline', cardState: 'resolved', ...options,
  });
  return new JSDOM(`<body>${html}</body>`).window.document.querySelector('.approval-gap-row');
}

test('a resolved approval renders one receipt line with no actions', () => {
  const row = receiptDom({ decision: 'allowed', approvalScope: 'once', commandText: 'python -m pytest -q\necho second line' });
  assert.equal(row.getAttribute('data-approval-status'), 'resolved');
  assert.equal(row.getAttribute('data-approval-decision'), 'allowed');
  assert.equal(row.querySelectorAll('button').length, 0);
  assert.equal(row.querySelector('.tool-approval-receipt-label').textContent, 'Allowed once');
  assert.equal(row.querySelector('code.tool-approval-receipt-subject').textContent, 'python -m pytest -q', 'first line only');
  assert.equal(row.querySelector('.tool-approval-receipt-mark').textContent, '✓');

  const always = receiptDom({ decision: 'allowed', approvalScope: 'always', commandText: 'git status' });
  assert.equal(always.querySelector('.tool-approval-receipt-label').textContent, 'Always allowed');

  const denied = receiptDom({ decision: 'denied', commandText: '<b>git push</b>' });
  assert.equal(denied.querySelector('.tool-approval-receipt-label').textContent, 'Denied');
  assert.equal(denied.querySelector('code').textContent, '<b>git push</b>', 'the command is escaped');
  assert.equal(denied.querySelector('.tool-approval-receipt-mark').textContent, '✕');

  const noCommand = receiptDom({ decision: 'bogus' });
  assert.equal(noCommand.getAttribute('data-approval-decision'), 'closed', 'an unknown decision reads as closed');
  assert.equal(noCommand.querySelector('span.tool-approval-receipt-subject').textContent, 'Run command');
  assert.equal(noCommand.querySelector('.tool-approval-receipt-mark'), null);
});

function streamPayloads(callId, resolution) {
  return [
    { type: 'started', streamId: 'stream-r' },
    { type: 'tool_use', streamId: 'stream-r', callId, toolName: 'run_command', status: 'pending_approval', approvalId: `appr-${callId}`, summary: 'Run tests', input: { command: 'python -m pytest -q' } },
    { type: 'tool_approval_needed', streamId: 'stream-r', callId, toolName: 'run_command', approvalId: `appr-${callId}`, summary: 'Run tests' },
    { type: 'tool_use', streamId: 'stream-r', callId, toolName: 'run_command', summary: 'Run tests', ...resolution },
    { type: 'tool_result', streamId: 'stream-r', callId, toolName: 'run_command', content: 'ok', summary: 'Ran tests' },
  ];
}

function replay(payloads) {
  const state = createTurnReducerState(DETERMINISTIC);
  const turnEvents = [];
  payloads.forEach((payload, index) => {
    const context = {
      turn_id: 'stream-r',
      event_id: `stream-r:${payload.type}:${index}`,
      primary_assistant_message_id: 'assistant_stream-r',
      primary_tool_message_id: `tool_use_${payload.callId || ''}`,
      tool_result_message_id: `tool_result_${payload.callId || ''}`,
      sort_key: [index, 0, 0],
    };
    const events = buildTurnEventFromStreamPayload(payload, context);
    turnEvents.push(...(Array.isArray(events) ? events : [events]).filter(Boolean));
    applyTurnStreamEvent(state, events);
  });
  return { liveRows: state.turns_by_id['stream-r'].rows, turnEvents };
}

for (const withIds of [false, true]) {
  test(`a re-asked approval stays pending in projectTurn and the live reducer (ids: ${withIds})`, () => {
    const payloads = streamPayloads('call-r', {
      status: 'approved', approvalState: 'approved', approvalScope: 'once', approvalId: 'approval-A',
    }).slice(0, 4);
    payloads[2].approvalId = 'approval-A';
    payloads.push({ ...payloads[2], approvalId: 'approval-B' });
    if (!withIds) payloads.forEach((payload) => { delete payload.approvalId; });
    const { liveRows, turnEvents } = replay(payloads);
    const { rows } = projectTurn({ turn_id: 'stream-r', events: turnEvents }, DETERMINISTIC);
    for (const candidates of [liveRows, rows]) {
      const gap = candidates.find((row) => row.kind === 'approval_gap');
      assert.ok(gap, 'the re-ask keeps its approval card');
      assert.equal(gap.payload.state, 'awaiting_approval');
      // The live reducer says `pending`; the hydrated projector keeps the request event's `pending_approval`.
      assert.ok(['pending', 'pending_approval'].includes(gap.payload.status), gap.payload.status);
      assert.equal('decision' in gap.payload, false);
    }
  });
}

test('a late resolution for approval A does not settle unmatched approval B', () => {
  const { turnEvents } = replay(streamPayloads('call-r', {
    status: 'approved', approvalState: 'approved', approvalId: 'approval-A',
  }).slice(0, 4));
  const request = turnEvents.find((event) => event.kind === 'approval_requested');
  request.payload.approval_id = 'approval-A';
  const resolution = turnEvents.find((event) => event.kind === 'approval_resolved');
  resolution.payload.approval_id = 'approval-A';
  const reask = { ...request, event_id: 'reask-B', sort_key: [4, 0, 0], payload: { ...request.payload, approval_id: 'approval-B' } };
  turnEvents.push(reask, { ...resolution, event_id: 'late-A', sort_key: [5, 0, 0] });
  const pickGap = () => projectTurn({ turn_id: 'stream-r', events: turnEvents }, DETERMINISTIC)
    .rows.find((row) => row.kind === 'approval_gap');
  assert.equal(pickGap().payload.state, 'awaiting_approval');
  assert.equal(pickGap().payload.status, 'pending_approval');
  assert.equal('decision' in pickGap().payload, false);
  turnEvents.push({ ...resolution, event_id: 'answer-B', sort_key: [6, 0, 0], payload: { ...resolution.payload, approval_id: 'approval-B' } });
  assert.equal(pickGap().payload.state, 'resolved');
  assert.equal(pickGap().payload.decision, 'allowed');
});

test('projectTurn keeps the allowed receipt after approval A and a result', () => {
  const { liveRows, turnEvents } = replay(streamPayloads('call-r', {
    status: 'approved', approvalState: 'approved', approvalScope: 'once',
  }));
  const { rows } = projectTurn({ turn_id: 'stream-r', events: turnEvents }, DETERMINISTIC);
  for (const candidates of [liveRows, rows]) {
    const gap = candidates.find((row) => row.kind === 'approval_gap');
    assert.deepEqual([gap.payload.state, gap.payload.status, gap.payload.decision], ['resolved', 'resolved', 'allowed']);
  }
});

for (const [label, resolution, expected] of [
  ['allowed always', { status: 'approved', approvalState: 'approved', approvalScope: 'always' }, { decision: 'allowed', approval_scope: 'always' }],
  ['denied', { status: 'denied', approvalState: 'denied' }, { decision: 'denied' }],
]) {
  test(`the live receipt and the hydrated receipt agree (${label})`, () => {
    const { liveRows, turnEvents } = replay(streamPayloads('call-r', resolution));
    const hydratedRows = projectTurnRows(turnEvents, DETERMINISTIC);
    const pick = (rows) => rows.find((row) => row.kind === 'approval_gap');
    const live = pick(liveRows);
    const hydrated = pick(hydratedRows);
    assert.ok(live && hydrated, 'both sides keep the receipt row');
    assert.equal(live.row_id, hydrated.row_id, 'one row identity, so the settle morphs in place');
    for (const row of [live, hydrated]) {
      assert.equal(row.payload.state, 'resolved');
      assert.equal(row.payload.decision, expected.decision);
      assert.equal(row.payload.approval_scope, expected.approval_scope);
    }
    const { staleRows } = reconcileTurnRows(liveRows, hydratedRows, DETERMINISTIC);
    assert.deepEqual(staleRows, [], 'no live row is stranded at the turn end');
  });
}

// Astra 2026-10-05: production hydration (projectTurn) runs the view-model
// enrichments that projectTurnRows alone skips; a receipt must survive them.
for (const [label, tail] of [
  ['an allowed command interrupted mid-run', [{ type: 'tool_use', streamId: 'stream-r', callId: 'call-r', toolName: 'run_command', status: 'running', summary: 'Run tests' }]],
  ['an allowed command that timed out', [{ type: 'tool_result', streamId: 'stream-r', callId: 'call-r', toolName: 'run_command', content: 'timed out', isError: true, metadata: { timed_out: true } }]],
]) {
  test(`hydration keeps the receipt for ${label}`, () => {
    const payloads = streamPayloads('call-r', { status: 'approved', approvalState: 'approved', approvalScope: 'once' }).slice(0, 4).concat(tail);
    const { liveRows, turnEvents } = replay(payloads);
    const { rows } = projectTurn({ turn_id: 'stream-r', events: turnEvents }, DETERMINISTIC);
    for (const row of [liveRows.find((r) => r.kind === 'approval_gap'), rows.find((r) => r.kind === 'approval_gap')]) {
      assert.deepEqual([row.payload.state, row.payload.decision, row.payload.approval_scope], ['resolved', 'allowed', 'once']);
    }
  });
}

test('the receipt row renders through the transcript markup builder', () => {
  const { liveRows } = replay(streamPayloads('call-m', { status: 'approved', approvalState: 'approved', approvalScope: 'once' }));
  const receiptRow = liveRows.find((row) => row.kind === 'approval_gap');
  const renderer = createTurnRowToolRenderUtils({
    escapeHtml: (value) => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    renderApprovalBlock,
    // A receipt never asks the live approval state; a card would.
    getApprovalCardState() { throw new Error('a resolved row must not read the live card state'); },
  });
  const html = renderer.buildApprovalGapMarkup(receiptRow, [], { sessionId: 'session-r' });
  const row = new JSDOM(`<body>${html}</body>`).window.document.querySelector('.approval-gap-row');
  assert.equal(row.getAttribute('data-approval-status'), 'resolved');
  assert.equal(row.textContent.replace(/\s+/g, ' ').trim(), '✓Allowed once·python -m pytest -q');
});

test('the approval waiter records the reader\'s scope on the resolution', async () => {
  const emitted = [];
  const collector = new CanonicalTurnEventCollector({ turnId: 'stream-scope', sessionId: 'session-scope' });
  const service = {
    sessionStore: { appendMessage() {}, updateMessage() {} },
    emit(_event, payload) { emitted.push(payload); },
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
  };
  const resultPromise = waitForToolApproval(service, 'stream-scope', 'session-scope', 'req-scope', {
    tool_name: 'Write', tool_call_id: 'call-scope', tool_input: { path: 'notes.md' },
  }, new AbortController(), collector);
  const pending = [...service.pendingToolApprovals.values()][0];
  pending.resolve(true, 'approved', '', null, 'always');
  assert.equal(await resultPromise, true);
  const resolved = collector.capturedEvents.find((event) => event.kind === 'approval_resolved');
  assert.equal(resolved.payload.approval_scope, 'always');
  const toolUse = emitted.filter((payload) => payload.type === 'tool_use').pop();
  assert.equal(toolUse.approvalScope, 'always');
});

test('a denial records no scope', async () => {
  const collector = new CanonicalTurnEventCollector({ turnId: 'stream-deny', sessionId: 'session-deny' });
  const service = {
    sessionStore: { appendMessage() {}, updateMessage() {} },
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
  };
  const resultPromise = waitForToolApproval(service, 'stream-deny', 'session-deny', 'req-deny', {
    tool_name: 'Write', tool_call_id: 'call-deny', tool_input: { path: 'notes.md' },
  }, new AbortController(), collector);
  [...service.pendingToolApprovals.values()][0].resolve(false, 'denied', '', null, 'always');
  assert.equal(await resultPromise, false);
  const resolved = collector.capturedEvents.find((event) => event.kind === 'approval_resolved');
  assert.equal('approval_scope' in resolved.payload, false);
});

/* ---- consumers that read an approval row as an unresolved gate ---- */

const { hasUnresolvedApprovalGapRow } = require('../renderer/chat/renderer-turn-shell');
const { rowRequiresPin } = require('../renderer/chat/renderer-render-pipeline-projection-cache');
const { createApprovalFocusRestore } = require('../renderer/chat/renderer-approval-focus-restore');
const { createApprovalReconciliationController } = require('../renderer/chat/renderer-approval-batch-utils');

const PENDING_ROW = '<div class="approval-gap-row" data-approval-status="pending" data-tool-call-id="c1">'
  + '<button class="tool-approve-btn" type="button">Allow</button></div>';
const RECEIPT_ROW = '<div class="approval-gap-row" data-approval-status="resolved" data-tool-call-id="c0">'
  + '<p class="tool-approval-receipt">Allowed once</p></div>';

test('a receipt is not an unresolved gate for paint-skip or the projection pin', () => {
  const doc = new JSDOM('<body></body>').window.document;
  const article = doc.createElement('article');
  article.innerHTML = `<div data-row-kind="approval_gap">${RECEIPT_ROW}</div>`;
  assert.equal(hasUnresolvedApprovalGapRow(article), false);
  article.innerHTML += `<div data-row-kind="approval_gap">${PENDING_ROW}</div>`;
  assert.equal(hasUnresolvedApprovalGapRow(article), true);

  assert.equal(rowRequiresPin({ kind: 'approval_gap', payload: { state: 'resolved' } }), false);
  assert.equal(rowRequiresPin({ kind: 'approval_gap', payload: { state: 'awaiting_approval' } }), true);
});

test('focus moves on when the answered card morphs in place into its receipt', async (t) => {
  const dom = new JSDOM('<!DOCTYPE html><body><textarea id="chatInput"></textarea>'
    + `<div id="chatTimeline">${RECEIPT_ROW}${PENDING_ROW.replace(/c1/g, 'c2')}${PENDING_ROW}</div></body>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  const restore = createApprovalFocusRestore({ chatTimeline: doc.getElementById('chatTimeline'), doc });
  t.after(() => { restore.dispose(); dom.window.close(); });
  const [, answered, next] = doc.querySelectorAll('.approval-gap-row');
  const fallback = restore.resolveApprovalFocusFallback(answered);
  assert.equal(fallback, next.querySelector('.tool-approve-btn'), 'a receipt is never the next row to focus');
  answered.querySelector('.tool-approve-btn').focus();
  restore.watchApprovalRowRemoval(answered, fallback, true);
  // The keyed morph keeps the element and swaps its body for the receipt.
  answered.setAttribute('data-approval-status', 'resolved');
  answered.innerHTML = '<p class="tool-approval-receipt">Allowed once</p>';
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(doc.activeElement, fallback);
});

test('approval reconciliation treats a row morphed into its receipt as settled', async () => {
  const dom = new JSDOM(`<!DOCTYPE html><body><div id="timeline">${PENDING_ROW}</div></body>`);
  const row = dom.window.document.querySelector('.approval-gap-row');
  let scheduled;
  let busy = true;
  const controller = createApprovalReconciliationController({
    scopeRoot: dom.window.document.getElementById('timeline'),
    getCurrentSessionId: () => 'session-1',
    getActiveTurnState: async () => ({ pending_approval: { approval_id: 'appr-1' } }),
    rehydrateSession: async () => {},
    setBlockBusy: (_block, value) => { busy = value; },
    setTimeoutFn: (callback) => { scheduled = callback; return 1; },
    clearTimeoutFn: () => {},
  });
  controller.start({ sessionId: 'session-1', reference: 'appr-1', row, block: row });
  row.setAttribute('data-approval-status', 'resolved');
  await scheduled();
  assert.equal(row.getAttribute('data-approval-reconciliation'), 'settled');
  assert.equal(busy, true, 'a settled row is not re-enabled');
  controller.dispose();
});
