'use strict';

// A4 (1.2.0 gate, owner-approved design 2B, 2026-09-22): a pending approval the
// runtime no longer waits on must not offer Allow and Deny. A paused reply's
// card offers Resume; a card whose answer was refused folds to a receipt.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  approvalCardStateKey,
  renderApprovalBlock,
  resolveApprovalCardState,
} = require('../renderer/chat/renderer-approval-block');

function parseFragment(html) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="root">${html}</div></body></html>`);
  return dom.window.document.getElementById('root');
}

function rendererState({ approvals = [], pending = [], inactive = [] } = {}) {
  return {
    pendingToolApprovals: new Map(approvals.map((approval) => [approval.approvalId, approval])),
    runtimeSendController: { listPending: (sessionId) => (sessionId === 'sess_1' ? pending : []) },
    inactiveApprovalCallIds: new Set(inactive),
  };
}

const REF = { sessionId: 'sess_1', turnId: 'turn_1', callId: 'call_1' };
const PAUSED_ROW = { key: 'detached:work_1', turnId: 'turn_1', status: 'paused' };

test('a live approval for the call keeps the buttons, whatever else is known', () => {
  const state = rendererState({
    approvals: [{ approvalId: 'approval_new', callId: 'call_1' }],
    pending: [PAUSED_ROW],
    inactive: ['call_1'],
  });
  assert.deepEqual(resolveApprovalCardState(state, REF), { state: 'live' });
});

test('a paused reply for the turn offers its own Resume key', () => {
  const state = rendererState({ pending: [PAUSED_ROW], inactive: ['call_1'] });
  assert.deepEqual(resolveApprovalCardState(state, REF), { state: 'paused', resumeKey: 'detached:work_1' });
});

test('a paused reply being discarded folds its card; queued or running work is not a pause', () => {
  assert.deepEqual(resolveApprovalCardState(rendererState({ pending: [{ ...PAUSED_ROW, status: 'withdrawing' }] }), REF),
    { state: 'inactive' });
  for (const status of ['pending', 'running']) {
    const state = rendererState({ pending: [{ ...PAUSED_ROW, status }] });
    assert.deepEqual(resolveApprovalCardState(state, REF), { state: 'live' }, status);
  }
  const otherTurn = rendererState({ pending: [{ ...PAUSED_ROW, turnId: 'turn_2' }] });
  assert.deepEqual(resolveApprovalCardState(otherTurn, REF), { state: 'live' });
});

test('a refused answer folds the card; unknown state keeps today\'s buttons', () => {
  assert.deepEqual(resolveApprovalCardState(rendererState({ inactive: ['call_1'] }), REF), { state: 'inactive' });
  assert.deepEqual(resolveApprovalCardState(rendererState(), REF), { state: 'live' });
  assert.deepEqual(resolveApprovalCardState({}, REF), { state: 'live' });
  assert.deepEqual(resolveApprovalCardState(null, REF), { state: 'live' });
});

test('a sealed approval row folds unless live or paused runtime authority wins', () => {
  const sealedRef = { ...REF, rowState: 'interrupted' };
  assert.deepEqual(resolveApprovalCardState(rendererState(), sealedRef), { state: 'inactive' });
  assert.deepEqual(resolveApprovalCardState(rendererState({
    approvals: [{ approvalId: 'approval_new', callId: 'call_1' }],
  }), sealedRef), { state: 'live' });
  assert.deepEqual(resolveApprovalCardState(rendererState({ pending: [PAUSED_ROW] }), sealedRef),
    { state: 'paused', resumeKey: 'detached:work_1' });
  assert.deepEqual(resolveApprovalCardState(rendererState(), { ...REF, rowState: 'awaiting_approval' }),
    { state: 'live' });
});

test('the paused inline card shows the request, Resume and the note, never Allow or Deny', () => {
  const html = renderApprovalBlock({
    toolCallId: 'call_1',
    approvalId: 'approval_old',
    toolName: 'todo_write',
    displayToolName: 'Todo Write',
    purpose: 'Mark all three steps complete',
    mode: 'inline',
    cardState: 'paused',
    resumeKey: 'detached:work_1',
  });
  const root = parseFragment(html);
  const row = root.querySelector('.approval-gap-row');
  assert.equal(row.getAttribute('data-approval-status'), 'paused');
  assert.equal(row.querySelector('.tool-approval-kicker').textContent, 'Paused');
  assert.match(row.querySelector('.tool-approval-prompt').textContent, /Mark all three steps complete/);
  assert.equal(row.querySelector('.tool-approve-btn, .tool-deny-btn'), null);
  const resume = row.querySelector('[data-action="resume-paused-approval"]');
  assert.ok(resume, 'expected the Resume button');
  assert.equal(resume.textContent, 'Resume');
  assert.equal(resume.getAttribute('data-resume-key'), 'detached:work_1');
  assert.ok(resume.classList.contains('resume-turn-action'));
  assert.equal(row.querySelector('.tool-approval-paused-note').textContent, 'Resume to answer.');
});

test('the paused card in the tool details also drops Allow and Deny', () => {
  const root = parseFragment(renderApprovalBlock({
    toolCallId: 'call_1', toolName: 'todo_write', mode: 'card', cardState: 'paused', resumeKey: 'k1',
  }));
  const block = root.querySelector('.tool-approval-block');
  assert.equal(block.getAttribute('data-approval-status'), 'paused');
  assert.equal(block.querySelector('.tool-approve-btn, .tool-deny-btn'), null);
  assert.ok(block.querySelector('[data-action="resume-paused-approval"][data-resume-key="k1"]'));
});

test('an inactive card is one receipt line with no controls', () => {
  for (const mode of ['inline', 'card']) {
    const root = parseFragment(renderApprovalBlock({
      toolCallId: 'call_1', toolName: 'todo_write', purpose: 'Mark steps', mode, cardState: 'inactive',
    }));
    const node = root.querySelector(mode === 'inline' ? '.approval-gap-row' : '.tool-approval-block');
    assert.equal(node.getAttribute('data-approval-status'), 'inactive', mode);
    assert.equal(node.querySelector('.tool-approval-receipt').textContent, 'Approval no longer active', mode);
    assert.equal(node.querySelector('button'), null, mode);
    assert.equal(node.querySelector('.tool-approval-prompt'), null, mode);
  }
});

test('the live card is unchanged', () => {
  const root = parseFragment(renderApprovalBlock({ toolCallId: 'call_1', toolName: 'todo_write', mode: 'inline' }));
  const row = root.querySelector('.approval-gap-row');
  assert.equal(row.getAttribute('data-approval-status'), 'pending');
  assert.equal(row.querySelector('.tool-approval-kicker').textContent, 'Approval needed');
  assert.equal(row.querySelectorAll('.tool-approve-btn').length, 2);
  assert.equal(row.querySelectorAll('.tool-deny-btn').length, 1);
  assert.equal(row.querySelector('[data-action="resume-paused-approval"]'), null);
});

test('the state key is empty with nothing pending and moves with every input', () => {
  assert.equal(approvalCardStateKey(rendererState(), 'sess_1'), '');
  const keys = new Set([
    approvalCardStateKey(rendererState(), 'sess_1'),
    approvalCardStateKey(rendererState({ pending: [PAUSED_ROW] }), 'sess_1'),
    approvalCardStateKey(rendererState({ approvals: [{ approvalId: 'a', callId: 'call_1' }] }), 'sess_1'),
    approvalCardStateKey(rendererState({ inactive: ['call_1'] }), 'sess_1'),
    approvalCardStateKey(rendererState({ pending: [{ ...PAUSED_ROW, status: 'withdrawing' }] }), 'sess_1'),
  ]);
  assert.equal(keys.size, 5);
  assert.equal(approvalCardStateKey(rendererState({ pending: [{ ...PAUSED_ROW, status: 'running' }] }), 'sess_1'), '');
});
