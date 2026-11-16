'use strict';

// Row 166 D10: when the backend offers a round (the same step's later edits, each with its exact input), the card
// lists them folded under the edit it asks about and adds one "Allow all" answer. The offer reaches the card from the
// live request and on a reopen; nothing malformed or partial is ever offered.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { escapeHtml } = require('../renderer/shared/string-utils');
const { renderApprovalBlock, resolveApprovalCardState } = require('../renderer/chat/renderer-approval-block');
const { createApprovalCardBindings } = require('../renderer/chat/renderer-chat-approval-card-bindings');
const { createSessionLifecycleController } = require('../renderer/shell/renderer-session-lifecycle-utils');

const exact = (n, pathField = 'file_path') => ({
  schema_version: 1,
  fields: [{ name: pathField, text: `src/file-${n}.js` }, { name: 'old_string', text: `before ${n}` }, { name: 'new_string', text: `after ${n}` }],
  bytes: 60,
  sha256: String(n).repeat(64).slice(0, 64),
});
const roundOf = (...numbers) => ({ calls: numbers.map((n) => ({ call_id: `call_${n}`, summary: `edit_file src/file-${n}.js`, exact_approval: exact(n) })) });

function html(extra = {}) {
  return renderApprovalBlock({
    toolCallId: 'call_1', approvalId: 'approval_1', toolName: 'edit_file', displayToolName: 'Edit file', mode: 'inline',
    exactApproval: exact(1), roundApproval: roundOf(2, 3), ...extra,
  }, { escapeHtml });
}

const parse = (markup) => new JSDOM(`<!doctype html><body><div id="root">${markup}</div></body>`).window.document.getElementById('root');
const buttons = (root) => Array.from(root.querySelectorAll('.tool-approval-actions button')).map((button) => button.textContent);

test('an offered round lists each later edit under its file, whole, and adds one answer for all', () => {
  const root = parse(html());

  const round = root.querySelector('[data-approval-round]');
  assert.equal(round.getAttribute('data-approval-round'), '2');
  assert.equal(round.querySelector('.tool-approval-round-heading').textContent, '2 more edits come with this one');
  const calls = Array.from(round.querySelectorAll('details[data-approval-round-call]'));
  assert.deepEqual(calls.map((call) => call.getAttribute('data-approval-round-call')), ['call_2', 'call_3']);
  assert.deepEqual(calls.map((call) => call.querySelector('summary').textContent), ['src/file-2.js', 'src/file-3.js']);
  assert.equal(calls[0].open, false, 'folded until the reader opens it');
  assert.equal(calls[0].querySelector('[data-approval-exact-field="new_string"]').textContent, 'after 2');
  assert.equal(calls[1].querySelector('[data-approval-exact-field="old_string"]').textContent, 'before 3');

  assert.deepEqual(buttons(root), ['Allow all 3', 'Allow this one', 'Always allow', 'Deny']);
  const all = root.querySelector('[data-approval-round="true"]');
  assert.equal(all.getAttribute('data-action'), 'approve');
  assert.equal(all.getAttribute('data-approval-scope'), 'once', 'never a standing rule');
  assert.equal(all.getAttribute('data-call-id'), 'call_1');
  assert.equal(all.getAttribute('data-approval-id'), 'approval_1');
  assert.equal(all.getAttribute('aria-label'), 'Allow all 3 Edit file calls');
  const one = root.querySelector('.tool-approve-btn--quiet');
  assert.equal(one.textContent, 'Allow this one');
  assert.equal(one.hasAttribute('data-approval-round'), false);
});

test('one later file reads in the singular, and a write names files', () => {
  assert.equal(parse(html({ roundApproval: roundOf(2) })).querySelector('.tool-approval-round-heading').textContent,
    '1 more edit comes with this one');
  const write = parse(html({ toolName: 'write_file', exactApproval: exact(1, 'path'),
    roundApproval: { calls: [2, 3].map((n) => ({ call_id: `call_${n}`, summary: '', exact_approval: exact(n, 'path') })) } }));
  assert.equal(write.querySelector('.tool-approval-round-heading').textContent, '2 more files come with this one');
  assert.equal(write.querySelector('details[data-approval-round-call] summary').textContent, 'src/file-2.js');
});

test('nothing partial is offered: without a whole, well-formed round the card is the ordinary one', () => {
  const broken = roundOf(2, 3);
  broken.calls[1].exact_approval = { ...exact(3), sha256: 'nope' };
  const tooLarge = roundOf(2, 3);
  tooLarge.calls[1].exact_approval = { schema_version: 1, too_large: true };
  for (const [label, extra] of [
    ['no offer', { roundApproval: undefined }],
    ['an empty offer', { roundApproval: { calls: [] } }],
    ['not a list', { roundApproval: { calls: 'call_2' } }],
    ['one call did not arrive whole', { roundApproval: broken }],
    ['one call is too large to show', { roundApproval: tooLarge }],
    ['a call with no id', { roundApproval: { calls: [{ summary: 'x', exact_approval: exact(2) }] } }],
    ['more calls than a card offers', { roundApproval: roundOf(...Array.from({ length: 17 }, (_, index) => index + 2)) }],
    ['another tool', { toolName: 'run_command', exactApproval: { schema_version: 1, fields: [{ name: 'command', text: 'dir' }], bytes: 10, sha256: 'c'.repeat(64) } }],
    ['approved once only', { oneOffOnly: true }],
    ['its own exact input is missing', { exactApproval: undefined }],
    ['a paused card', { cardState: 'paused', resumeKey: 'k' }],
  ]) {
    const root = parse(html(extra));
    assert.equal(root.querySelector('[data-approval-round]'), null, label);
    assert.equal(root.querySelector('.tool-approve-btn--quiet'), null, label);
    assert.equal(buttons(root).includes('Allow this one'), false, label);
  }
  assert.deepEqual(buttons(parse(html({ roundApproval: undefined }))), ['Allow once', 'Always allow', 'Deny']);
});

test('a path with markup or an invisible character is quoted, never run', () => {
  const round = roundOf(2);
  round.calls[0].exact_approval.fields[0].text = 'src/<img src=x onerror=alert(1)>‮.js';
  const root = parse(html({ roundApproval: round }));
  assert.equal(root.querySelector('img'), null);
  assert.ok(root.querySelector('details[data-approval-round-call] summary .tool-approval-invisible'));
});

test('the live approval hands its round to the card state, and an answered call reads Allowed together', () => {
  const roundApproval = roundOf(2);
  const state = { pendingToolApprovals: new Map([['a', { callId: 'call_1', roundApproval }], ['b', { callId: 'call_2' }]]) };
  assert.equal(resolveApprovalCardState(state, { callId: 'call_1' }).roundApproval, roundApproval);
  assert.equal(Object.hasOwn(resolveApprovalCardState(state, { callId: 'call_2' }), 'roundApproval'), false);

  const receipt = parse(html({ cardState: 'resolved', decision: 'allowed', approvalScope: 'round', commandText: 'src/file-1.js' }));
  assert.equal(receipt.querySelector('.tool-approval-receipt-label').textContent, 'Allowed together');
  assert.equal(receipt.querySelector('[data-approval-round]'), null);
});

test('pressing Allow all answers this call and asks for the round; Allow this one does not', async (t) => {
  const dom = new JSDOM(`<!doctype html><body><div id="timeline">${html()}</div></body>`);
  const doc = dom.window.document;
  const approved = [];
  dom.window.jennyShell = { tools: { approve: (id, options) => { approved.push([id, options]); return Promise.resolve(true); } } };
  const previousWindow = globalThis.window;
  globalThis.window = dom.window;
  const state = { pendingToolApprovals: new Map([['approval_1', { approvalId: 'approval_1', callId: 'call_1', sessionId: 's1' }]]) };
  const bindings = createApprovalCardBindings({
    chatTimeline: doc.getElementById('timeline'), doc, windowRef: dom.window, state, getSessionId: () => 's1',
    appendClientLog() {}, showComposerActionError() {}, renderAll() {}, refreshRecoveredSession: () => Promise.resolve(),
    resolveToolCallId: (button) => button.getAttribute('data-call-id'),
  });
  t.after(() => { bindings.dispose(); globalThis.window = previousWindow; dom.window.close(); });
  const click = (selector) => bindings.handleApprovalClick({ target: doc.querySelector(selector), preventDefault() {}, stopPropagation() {} });

  assert.equal(click('[data-approval-round="true"]'), true);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(approved, [['approval_1', { alwaysAllow: false, round: true }]]);

  doc.getElementById('timeline').innerHTML = html();
  assert.equal(click('.tool-approve-btn--quiet'), true);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(approved[1], ['approval_1', { alwaysAllow: false }]);
});

test('a reopened chat keeps the round its card offered', async () => {
  const roundApproval = roundOf(2, 3);
  const state = {
    currentSessionId: 'session-old',
    sessionMessageAccessOrder: new Map(),
    pendingToolApprovals: new Map(),
    messagesBySession: new Map([['session-new', [{
      id: 'm-1', kind: 'tool_use', role: 'assistant',
      tool_call: { call_id: 'call_1', tool_name: 'edit_file', status: 'pending_approval', input: { file_path: 'src/file-1.js' } },
    }]]]),
  };
  const controller = createSessionLifecycleController({
    state,
    sessionCacheController: { async evictColdSessionCaches() {} },
    thinkingController: { resumeAutoScroll() {} },
    jennyShell: {
      sessions: { async getMessages() { return { data: [], turn_events: [] }; } },
      chat: { async getActiveTurnState() {
        return { stream_id: 'stream-1', pending_approval: {
          call_id: 'call_1', approval_id: 'approval_1', tool_name: 'edit_file', exact_approval: exact(1), round_approval: roundApproval,
        } };
      } },
    },
    callbacks: { appendClientLog() {} },
  });

  await controller.openSession('session-new', { silent: true });

  assert.deepEqual(state.pendingToolApprovals.get('approval_1').roundApproval, roundApproval);
  assert.deepEqual(resolveApprovalCardState(state, { callId: 'call_1' }).roundApproval, roundApproval);
});
