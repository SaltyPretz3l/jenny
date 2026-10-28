'use strict';

// Row 69 Q11 (owner 2026-10-20): the session_stop approval card names the chat it stops from the
// app's own directory (title, project, live state) with an app-derived effect line, the chip reads
// "Another chat", and the raw session id shows nowhere (card, receipt, "Needs you" row).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { escapeHtml } = require('../renderer/shared/string-utils');
const { renderApprovalBlock } = require('../renderer/chat/renderer-approval-block');
// tool-call-utils binds the facts factory (getApprovalCommandPreview) to its normalizers.
const toolApprovalFacts = require('../renderer/chat/tool-call-utils');
const { createTurnRowToolRenderUtils } = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const { buildTurnEventFromStreamPayload, createTurnReducerState, applyTurnStreamEvent } = require('../renderer/chat/renderer-turn-reducer');
const { projectTurnRows } = require('./helpers/renderer-turn-row-projector-helpers');
const { buildAttentionInbox } = require('../renderer/shell/renderer-attention-inbox-model');

const RAW_ID = 'sess_1792533201094_5ebb518922f3';

function stop(state = 'running', target = {}) {
  return { schema_version: 1, state,
    target: state === 'not_found' ? null : { session_id: RAW_ID, title: 'Beta parser', project_label: 'projB', ...target } };
}

function parse(html) {
  const dom = new JSDOM(`<!doctype html><body><div id="root">${html}</div></body>`);
  return dom.window.document.getElementById('root');
}

function render(extra = {}) {
  return parse(renderApprovalBlock({
    toolCallId: 'call_1', approvalId: 'approval_1', toolName: 'session_stop', displayToolName: 'Session Stop',
    mode: 'inline', policyScope: 'Another chat', purpose: 'The user asked to stop Beta parser.',
    commandText: `session_id: ${RAW_ID}`, sessionStopApproval: stop(), ...extra,
  }, { escapeHtml }));
}

test('the card names the target, its project and what the stop does now, under the "Another chat" chip', () => {
  const root = render();
  const target = root.querySelector('[data-approval-session-stop]');
  assert.equal(target.getAttribute('data-approval-session-stop'), 'running');
  assert.equal(target.querySelector('.tool-approval-message-label').textContent, 'Stop');
  assert.equal(target.querySelector('.tool-approval-message-title').textContent, 'Beta parser');
  assert.equal(target.querySelector('.tool-approval-message-project').textContent, 'projB');
  assert.match(target.querySelector('.tool-approval-message-note').textContent, /^Running now: its reply in progress is cancelled/);
  assert.equal(root.querySelector('[data-approval-fact="scope"]').textContent, 'Another chat');
  assert.equal(root.querySelector('.tool-approval-command'), null);
  assert.ok(!root.textContent.includes(RAW_ID), 'the raw id never shows');
  assert.ok(root.querySelector('[data-approval-scope="once"]'));
});

test('each live state has its own effect line; an unreadable target is unnamed, never the id', () => {
  const notes = {};
  for (const state of ['running', 'waiting_approval', 'queued', 'idle', 'not_found']) {
    notes[state] = render({ sessionStopApproval: stop(state) }).querySelector('.tool-approval-message-note').textContent;
  }
  assert.equal(new Set(Object.values(notes)).size, 5);
  assert.match(notes.waiting_approval, /^Paused on your approval/);
  assert.match(notes.idle, /nothing is stopped/);
  assert.match(notes.not_found, /can.t reach that one/);
  for (const value of [undefined, { schema_version: 2, state: 'running', target: stop().target }, { schema_version: 1, state: 'bogus' }]) {
    const root = render({ sessionStopApproval: value });
    assert.equal(root.querySelector('.tool-approval-message-title').textContent, 'A chat Jenny could not name');
    assert.equal(root.querySelector('.tool-approval-message-note'), null);
    assert.ok(!root.textContent.includes(RAW_ID));
  }
  assert.equal(render({ sessionStopApproval: stop('idle', { title: 'New Chat', project_label: null }) })
    .querySelector('.tool-approval-message-title').textContent, 'Untitled chat');
  const hostile = render({ sessionStopApproval: stop('running', { title: '<img src=x onerror=alert(1)>' }) });
  assert.equal(hostile.querySelector('img'), null);
});

test('the receipt names the target, and the command preview never quotes the id', () => {
  const receipt = render({ cardState: 'resolved', decision: 'denied' });
  assert.equal(receipt.querySelector('.tool-approval-receipt-subject').textContent, 'Stop Beta parser');
  assert.ok(!receipt.textContent.includes(RAW_ID));
  assert.equal(toolApprovalFacts.getApprovalCommandPreview('session_stop', { session_id: RAW_ID }), '');
  assert.equal(render({ cardState: 'resolved', decision: 'allowed', sessionStopApproval: undefined, commandText: '' })
    .querySelector('.tool-approval-receipt-subject').textContent, 'Session Stop');
});

test('the turn-row gap, the live reducer and the hydrated projector all carry the target to the card', () => {
  const renderer = createTurnRowToolRenderUtils({
    escapeHtml, normalizeId: (value) => String(value || '').trim(), formatDurationMs: () => '',
    renderArtifactTeaser: () => '', buildToolMarkerBannerMarkup: () => '', renderApprovalBlock,
    getApprovalCardState: () => ({ state: 'live' }),
  });
  const html = renderer.buildApprovalGapMarkup({ kind: 'approval_gap', row_id: 'gap_1', turn_id: 'turn_1', tool_call_id: 'call_1',
    payload: { tool_call_id: 'call_1', tool_name: 'session_stop', state: 'awaiting_approval', approval_id: 'approval_1',
      policy_scope: 'Another chat', input: { session_id: RAW_ID }, session_stop_approval: stop() } }, [], { sessionId: 'sess_1' });
  const root = parse(html);
  assert.equal(root.querySelector('.tool-approval-message-title').textContent, 'Beta parser');
  assert.ok(!root.textContent.includes(RAW_ID));

  const state = createTurnReducerState();
  const context = { turn_id: 'stream-st', primary_user_message_id: 'u', primary_assistant_message_id: 'a', primary_tool_message_id: 'tool_use_call-st' };
  let ordinal = 0;
  const apply = (payload) => {
    applyTurnStreamEvent(state, buildTurnEventFromStreamPayload(payload, { ...context, ordinal }));
    ordinal += 1;
    return state.turns_by_id['stream-st'];
  };
  apply({ type: 'started', streamId: 'stream-st' });
  apply({ type: 'tool_use', streamId: 'stream-st', callId: 'call-st', toolName: 'session_stop', status: 'pending_approval', input: { session_id: RAW_ID } });
  const turn = apply({ type: 'tool_approval_needed', streamId: 'stream-st', callId: 'call-st', toolName: 'session_stop',
    input: { session_id: RAW_ID }, session_stop_approval: stop() });
  const liveGap = turn.rows.find((row) => row.kind === 'approval_gap' && row.tool_call_id === 'call-st');
  assert.deepEqual(liveGap.payload.session_stop_approval, stop());

  const events = [
    { event_id: 'st:tool_use', turn_id: 'turn_st', kind: 'tool_use', primary_message_id: 'tool_use_st', source_message_ids: ['tool_use_st'], sort_key: [0, 0, 40], tool_call_id: 'call_st', status: 'pending_approval', payload: { tool_name: 'session_stop', input: { session_id: RAW_ID } } },
    { event_id: 'st:approval_requested', turn_id: 'turn_st', kind: 'approval_requested', primary_message_id: 'tool_use_st', source_message_ids: ['tool_use_st'], sort_key: [0, 1, 45], tool_call_id: 'call_st', status: 'pending_approval', payload: { approval_state: 'pending', session_stop_approval: stop('waiting_approval') } },
  ];
  const hydrated = projectTurnRows(events).find((row) => row.kind === 'approval_gap');
  assert.deepEqual(hydrated.payload.session_stop_approval, stop('waiting_approval'));
});

test('the "Needs you" row reads "Stop <title>", or "Stop another chat" without a target, never the id', () => {
  const model = (entry) => buildAttentionInbox({
    sessions: [{ id: 'sess_primary', title: 'Jenny' }],
    pendingToolApprovals: new Map([['a1', { approvalId: 'a1', callId: 'c1', sessionId: 'sess_primary', toolName: 'session_stop',
      input: { session_id: RAW_ID }, policyScope: 'Another chat', ...entry }]]),
    facts: toolApprovalFacts,
  });
  const row = (entry) => model(entry).rows.find((item) => item.kind === 'approval');
  assert.equal(row({ sessionStopApproval: stop() }).preview, 'Stop Beta parser');
  assert.equal(row({}).preview, 'Stop another chat');
  assert.equal(row({ sessionStopApproval: stop('idle', { title: 'New Chat' }) }).preview, 'Stop another chat');
});
