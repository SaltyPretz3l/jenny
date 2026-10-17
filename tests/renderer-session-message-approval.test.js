'use strict';

// Agent message approval (row 59 cp5b-2): the approval card for a `session_message` send shows the
// recipient, the whole body as inert text, the short hash and no "Always allow"; a request whose
// body did not arrive intact has no Allow button. The field also rides the live reducer and the
// hydrated projector into the gap row the card is rendered from.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { escapeHtml } = require('../renderer/shared/string-utils');
const { renderApprovalBlock, normalizeSessionMessageApproval } = require('../renderer/chat/renderer-approval-block');
const { createTurnRowToolRenderUtils } = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const { buildTurnEventFromStreamPayload, createTurnReducerState, applyTurnStreamEvent } = require('../renderer/chat/renderer-turn-reducer');
const { projectTurnRows } = require('./helpers/renderer-turn-row-projector-helpers');

const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

function approval(overrides = {}) {
  return {
    schema_version: 1,
    operation_id: '00000000-0000-4000-8000-000000000001',
    destination: { session_id: 'dest-1', title: 'Review the sidebar nesting copy', project_label: 'jenny-site' },
    body: 'Breadcrumb strings are final.\nShip them.',
    envelope_sha256: HASH,
    one_off_only: true,
    ...overrides,
  };
}

function parse(html) {
  const dom = new JSDOM(`<!doctype html><body><div id="root">${html}</div></body>`);
  return dom.window.document.getElementById('root');
}

function render(extra = {}) {
  return parse(renderApprovalBlock({
    toolCallId: 'call_1',
    approvalId: 'approval_1',
    toolName: 'session_message',
    displayToolName: 'Message another chat',
    mode: 'inline',
    sessionMessageApproval: approval(),
    ...extra,
  }, { escapeHtml }));
}

test('the card shows the recipient, project, the whole body as text and the short hash', () => {
  const root = render();
  const card = root.querySelector('[data-approval-session-message]');
  assert.ok(card);
  assert.equal(card.querySelector('.tool-approval-message-title').textContent, 'Review the sidebar nesting copy');
  assert.equal(card.querySelector('.tool-approval-message-project').textContent, 'jenny-site');
  const body = card.querySelector('[data-approval-message-body]');
  assert.equal(body.textContent, 'Breadcrumb strings are final.\nShip them.');
  assert.equal(body.tagName, 'PRE');
  assert.equal(body.getAttribute('tabindex'), '0', 'keyboard users can scroll the region');
  assert.equal(body.getAttribute('role'), 'region');
  assert.match(body.getAttribute('aria-label'), /exactly as written/u);
  assert.match(card.querySelector('.tool-approval-message-hash').textContent, /Fingerprint a1b2c3d4e5f6$/u);
  assert.doesNotMatch(root.textContent, /a1b2c3d4e5f60/u, 'only the first 12 hex characters are shown');
});

test('a long body is rendered whole, never clipped', () => {
  const long = Array.from({ length: 800 }, (_, index) => `line ${index} ${'x'.repeat(20)}`).join('\n');
  const root = render({ sessionMessageApproval: approval({ body: long }) });
  assert.equal(root.querySelector('[data-approval-message-body]').textContent, long);
  assert.equal(root.querySelector('.tool-approval-disclosure'), null);
  assert.doesNotMatch(root.textContent, /more chars/u);
});

test('an HTML-looking body and hostile recipient fields stay text', () => {
  const body = '<img src=x onerror=alert(1)><script>alert(2)</script> &amp; <b>bold</b>';
  const root = render({
    sessionMessageApproval: approval({
      body,
      destination: { session_id: 'dest-1', title: '<b>boss</b>', project_label: '<i>proj</i>' },
    }),
  });
  const card = root.querySelector('[data-approval-session-message]');
  assert.equal(card.querySelector('[data-approval-message-body]').textContent, body);
  assert.equal(card.querySelector('img'), null);
  assert.equal(card.querySelector('script'), null);
  assert.equal(card.querySelector('b'), null);
  assert.equal(card.querySelector('i'), null);
  assert.equal(card.querySelector('.tool-approval-message-title').textContent, '<b>boss</b>');
  assert.equal(card.querySelector('.tool-approval-message-project').textContent, '<i>proj</i>');
});

test('the approval is one-off only: no Always allow even when the flag is missing', () => {
  for (const extra of [{}, { oneOffOnly: false }, { oneOffOnly: true }]) {
    const root = render(extra);
    assert.equal(root.querySelector('[data-approval-scope="always"]'), null);
    assert.equal(root.querySelector('.tool-approve-always-btn'), null);
    const allow = root.querySelector('[data-approval-scope="once"]');
    assert.ok(allow, 'Allow once and Deny reuse the existing controls');
    assert.ok(root.querySelector('[data-action="deny"]'));
  }
  assert.match(render().textContent, /This approval covers this one message only\./u);
});

test('no chosen project and no title degrade without printing null', () => {
  const root = render({ sessionMessageApproval: approval({ destination: { session_id: 'dest-1', title: null, project_label: null } }) });
  assert.equal(root.querySelector('.tool-approval-message-project'), null);
  assert.equal(root.querySelector('.tool-approval-message-title').textContent, 'Untitled chat');
  assert.doesNotMatch(root.textContent, /null/u);
});

test('a request without a valid full-body field has no Allow button and says why', () => {
  const broken = [
    undefined,
    null,
    'text',
    approval({ body: '' }),
    approval({ body: 7 }),
    approval({ envelope_sha256: 'abc' }),
    approval({ schema_version: 2 }),
    approval({ destination: { title: 'x' } }),
  ];
  for (const value of broken) {
    const root = render({ sessionMessageApproval: value });
    assert.equal(root.querySelector('[data-approval-scope="once"]'), null, JSON.stringify(value));
    assert.equal(root.querySelector('[data-approval-scope="always"]'), null);
    assert.ok(root.querySelector('[data-action="deny"]'), 'Deny stays');
    assert.ok(root.querySelector('[data-approval-session-message-unavailable]'));
  }
  assert.equal(normalizeSessionMessageApproval(approval()).shortHash, 'a1b2c3d4e5f6');
});

test('other tools never show the message card or get the session-message treatment', () => {
  const root = render({ toolName: 'run_command', displayToolName: 'Run command', commandText: 'ls' });
  assert.equal(root.querySelector('[data-approval-session-message]'), null);
  assert.ok(root.querySelector('[data-approval-scope="always"]'));
});

test('the turn-row approval gap hands the field to the card and skips the clipped input preview', () => {
  const renderer = createTurnRowToolRenderUtils({
    escapeHtml,
    normalizeId: (value) => String(value || '').trim(),
    formatDurationMs: () => '',
    renderArtifactTeaser: () => '',
    buildToolMarkerBannerMarkup: () => '',
    renderApprovalBlock,
    getApprovalCardState: () => ({ state: 'live' }),
  });
  const long = 'z'.repeat(5000);
  const html = renderer.buildApprovalGapMarkup({
    kind: 'approval_gap',
    row_id: 'gap_1',
    turn_id: 'turn_1',
    tool_call_id: 'call_1',
    payload: {
      tool_call_id: 'call_1',
      tool_name: 'session_message',
      state: 'awaiting_approval',
      approval_id: 'approval_1',
      input: { action: 'send', destination_session_id: 'dest-1', body: long.slice(0, 400) },
      session_message_approval: approval({ body: long }),
    },
  }, [], { sessionId: 'sess_1' });
  const root = parse(html);
  assert.equal(root.querySelector('[data-approval-message-body]').textContent, long);
  assert.equal(root.querySelector('.tool-approval-command'), null, 'no second, clipped quote of the body');
  assert.equal(root.querySelector('[data-approval-scope="always"]'), null);
  assert.ok(root.querySelector('[data-approval-scope="once"]'));
  void toolCallUtils;
});

test('the live reducer carries the field from tool_approval_needed into the gap row', () => {
  const state = createTurnReducerState();
  const context = { turn_id: 'stream-sm', primary_user_message_id: 'user_sm', primary_assistant_message_id: 'assistant_sm', primary_tool_message_id: 'tool_use_call-sm' };
  let ordinal = 0;
  const apply = (payload) => {
    const events = buildTurnEventFromStreamPayload(payload, { ...context, ordinal });
    ordinal += 1;
    applyTurnStreamEvent(state, events);
    return state.turns_by_id['stream-sm'];
  };
  apply({ type: 'started', streamId: 'stream-sm' });
  apply({ type: 'tool_use', streamId: 'stream-sm', callId: 'call-sm', toolName: 'session_message', status: 'pending_approval', input: { action: 'send' } });
  const turn = apply({
    type: 'tool_approval_needed', streamId: 'stream-sm', callId: 'call-sm', toolName: 'session_message', input: { action: 'send' },
    session_message_approval: approval(),
  });
  const gap = turn.rows.find((row) => row.kind === 'approval_gap' && row.tool_call_id === 'call-sm');
  assert.ok(gap);
  assert.deepEqual(gap.payload.session_message_approval, approval());
});

test('the hydrated projector carries the field from the approval_requested event', () => {
  const events = [
    { event_id: 'sm:tool_use', turn_id: 'turn_sm', kind: 'tool_use', primary_message_id: 'tool_use_sm', source_message_ids: ['tool_use_sm'], sort_key: [0, 0, 40], tool_call_id: 'call_sm', status: 'pending_approval', payload: { tool_name: 'session_message', input: { action: 'send' } } },
    { event_id: 'sm:approval_requested', turn_id: 'turn_sm', kind: 'approval_requested', primary_message_id: 'tool_use_sm', source_message_ids: ['tool_use_sm'], sort_key: [0, 1, 45], tool_call_id: 'call_sm', status: 'pending_approval', payload: { approval_state: 'pending', session_message_approval: approval() } },
  ];
  const gap = projectTurnRows(events).find((row) => row.kind === 'approval_gap');
  assert.ok(gap);
  assert.deepEqual(gap.payload.session_message_approval, approval());
});

test('the hydrated projector finds the full body behind an earlier canonical tool_call_requested event', () => {
  const { body: _body, ...identity } = approval();
  const events = [
    { event_id: 'sm:canonical', turn_id: 'turn_sm', kind: 'tool_use', primary_message_id: 'tool_use_sm', source_message_ids: ['tool_use_sm'], sort_key: [0, 0, 30], tool_call_id: 'call_sm', status: 'pending', payload: { tool_name: 'session_message', tool_input: { action: 'send' }, canonical_event_type: 'tool_call_requested' } },
    { event_id: 'sm:tool_use', turn_id: 'turn_sm', kind: 'tool_use', primary_message_id: 'tool_use_sm', source_message_ids: ['tool_use_sm'], sort_key: [0, 0, 40], tool_call_id: 'call_sm', status: 'pending_approval', payload: { tool_name: 'session_message', input: { action: 'send' }, session_message_approval: approval() } },
    { event_id: 'sm:approval_requested', turn_id: 'turn_sm', kind: 'approval_requested', primary_message_id: 'tool_use_sm', source_message_ids: ['tool_use_sm'], sort_key: [0, 1, 45], tool_call_id: 'call_sm', status: 'pending_approval', payload: { approval_state: 'pending', canonical_seq: 3, session_message_approval: identity } },
  ];
  const rows = projectTurnRows(events);
  const gap = rows.find((row) => row.kind === 'approval_gap');
  assert.ok(gap);
  assert.deepEqual(gap.payload.session_message_approval, approval());
  assert.equal(rows.filter((row) => row.kind === 'tool_call').length, 1, 'both requests stay one logical call');
});

test('the hydrated projector takes the full body from the tool_use projection, not the body-less canonical request', () => {
  const { body: _body, ...identity } = approval();
  const events = [
    { event_id: 'sm:tool_use', turn_id: 'turn_sm', kind: 'tool_use', primary_message_id: 'tool_use_sm', source_message_ids: ['tool_use_sm'], sort_key: [0, 0, 40], tool_call_id: 'call_sm', status: 'pending_approval', payload: { tool_name: 'session_message', input: { action: 'send' }, session_message_approval: approval() } },
    { event_id: 'sm:approval_requested', turn_id: 'turn_sm', kind: 'approval_requested', primary_message_id: 'tool_use_sm', source_message_ids: ['tool_use_sm'], sort_key: [0, 1, 45], tool_call_id: 'call_sm', status: 'pending_approval', payload: { approval_state: 'pending', canonical_seq: 3, session_message_approval: identity } },
  ];
  const gap = projectTurnRows(events).find((row) => row.kind === 'approval_gap');
  assert.deepEqual(gap.payload.session_message_approval, approval());
});
