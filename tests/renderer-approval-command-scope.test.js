'use strict';

// Row 103 (owner pick B, 2026-11-02): a run_command card names what "Always
// allow" will cover, the receipt repeats it, and Settings lists the rule by
// its command scope.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  applyApprovalReceipt,
  deriveApprovalReceipt,
  renderApprovalBlock,
  resolveApprovalCardState,
} = require('../renderer/chat/renderer-approval-block');
const coreRenderers = require('../renderer/shell/renderer-settings-core-renderers');

function parseFragment(html) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="root">${html}</div></body></html>`);
  return dom.window.document.getElementById('root');
}

function exactPresentation(command) {
  return { schema_version: 1, fields: [{ name: 'command', text: command }], sha256: 'a'.repeat(64) };
}

function commandCard(command, alwaysAllowScope, extra = {}) {
  return parseFragment(renderApprovalBlock({
    toolCallId: 'call_cmd', approvalId: 'approval_cmd', toolName: 'run_command',
    displayToolName: 'Run command', prompt: 'Run the project tests', mode: 'inline',
    exactApproval: exactPresentation(command), alwaysAllowScope, ...extra,
  }));
}

test('a prefix scope labels Always allow with the prefix and explains the coverage', () => {
  const root = commandCard('npm test -- --runInBand', { kind: 'prefix', prefix: 'npm test' });
  const always = root.querySelector('.tool-approve-always-btn');
  assert.ok(always);
  assert.equal(always.textContent, 'Always allow npm test \u2026');
  assert.equal(always.querySelector('code').textContent, 'npm test \u2026');
  assert.equal(always.getAttribute('data-approval-scope'), 'always');
  assert.equal(always.getAttribute('aria-label'), 'Always allow npm test with any arguments in this project');
  assert.match(always.getAttribute('title'), /npm test/);
  const note = root.querySelector('p.tool-approval-scope-note');
  assert.equal(note.textContent, 'Covers npm test with any arguments, in this project. Other commands still ask.');
  assert.equal(note.querySelector('code').textContent, 'npm test');
  assert.equal(root.querySelectorAll('.tool-approval-actions > button').length, 3);
  // The note sits under the actions, inside the card.
  assert.equal(root.querySelector('.tool-approval-actions').nextElementSibling, note);
});

test('an exact scope offers "Always allow this command"', () => {
  const root = commandCard('python build.py', { kind: 'exact' });
  const always = root.querySelector('.tool-approve-always-btn');
  assert.equal(always.textContent, 'Always allow this command');
  assert.equal(always.getAttribute('aria-label'), 'Always allow exactly this command in this project');
  assert.equal(root.querySelector('.tool-approval-scope-note').textContent,
    'Covers exactly this command, in this project. Other commands still ask.');
});

test('a chained command withholds Always allow and says why', () => {
  const root = commandCard('npm test && npm run build > build.log', { kind: 'none' }, { oneOffOnly: true });
  assert.equal(root.querySelector('.tool-approve-always-btn'), null);
  assert.ok(root.querySelector('[data-approval-scope="once"]'));
  assert.equal(root.querySelector('.tool-approval-scope-note').textContent,
    'Chained commands can only be allowed once.');
});

test('the prefix is escaped in the label, the aria-label and the note', () => {
  const html = renderApprovalBlock({
    toolCallId: 'call_x', toolName: 'run_command', mode: 'inline',
    exactApproval: exactPresentation('x'), alwaysAllowScope: { kind: 'prefix', prefix: 'a<img src=x onerror=1>' },
  });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /a&lt;img/);
});

test('run_command without a known scope offers no Always allow', () => {
  for (const scope of [undefined, null, { kind: 'prefix' }, { kind: 'prefix', prefix: '' }, { kind: 'bogus' }]) {
    const root = commandCard('npm test', scope);
    assert.equal(root.querySelector('.tool-approve-always-btn'), null, JSON.stringify(scope));
    assert.equal(root.querySelector('.tool-approval-scope-note'), null);
    assert.ok(root.querySelector('[data-approval-scope="once"]'));
  }
});

test('other tools keep their generic Always allow and no scope note', () => {
  const root = parseFragment(renderApprovalBlock({
    toolCallId: 'call_w', toolName: 'write_file', displayToolName: 'Write file', mode: 'card',
    alwaysAllowScope: { kind: 'prefix', prefix: 'npm test' },
  }));
  assert.equal(root.querySelector('.tool-approve-always-btn').textContent, 'Always allow');
  assert.equal(root.querySelector('.tool-approval-scope-note'), null);
});

test('a live approval hands its Always allow scope to the card', () => {
  const exactApproval = exactPresentation('npm test');
  const alwaysAllowScope = { kind: 'prefix', prefix: 'npm test' };
  const state = { pendingToolApprovals: new Map([
    ['a1', { approvalId: 'a1', callId: 'call_live', exactApproval, alwaysAllowScope }],
  ]) };
  assert.deepEqual(resolveApprovalCardState(state, { callId: 'call_live' }),
    { state: 'live', exactApproval, alwaysAllowScope });
});

test('an Always allowed command receipt reads the saved prefix', () => {
  const callPayload = {
    tool_name: 'run_command', state: 'completed',
    approval_resolutions: [{ status: 'approved', approval_state: 'approved', approval_scope: 'always', always_allow_prefix: 'npm test' }],
  };
  const receipt = deriveApprovalReceipt(callPayload);
  assert.deepEqual(receipt, { decision: 'allowed', scope: 'always', alwaysAllowPrefix: 'npm test' });
  const row = { state: 'awaiting_approval' };
  applyApprovalReceipt(row, receipt);
  assert.equal(row.always_allow_prefix, 'npm test');
  applyApprovalReceipt(row, { decision: 'denied' });
  assert.equal(Object.hasOwn(row, 'always_allow_prefix'), false);

  const root = parseFragment(renderApprovalBlock({
    toolCallId: 'call_r', toolName: 'run_command', cardState: 'resolved', decision: 'allowed',
    approvalScope: 'always', alwaysAllowPrefix: 'npm test', commandText: 'npm test -- --watch', mode: 'inline',
  }));
  assert.equal(root.querySelector('.tool-approval-receipt').textContent, '\u2713Always allowed\u00b7npm test \u2026');
});

test('the live and hydrated receipts both carry the saved prefix', () => {
  const {
    applyTurnStreamEvent, buildTurnEventFromStreamPayload, createTurnReducerState,
  } = require('../renderer/chat/renderer-turn-reducer');
  const { projectTurn } = require('../renderer/chat/renderer-turn-row-projector');
  const deterministic = { deterministicRowId: true };
  const payloads = [
    { type: 'started', streamId: 'stream-p' },
    { type: 'tool_use', streamId: 'stream-p', callId: 'call-p', toolName: 'run_command', status: 'pending_approval', approvalId: 'appr-p', summary: 'Run tests', input: { command: 'npm test -- --watch' } },
    { type: 'tool_approval_needed', streamId: 'stream-p', callId: 'call-p', toolName: 'run_command', approvalId: 'appr-p', summary: 'Run tests' },
    { type: 'tool_use', streamId: 'stream-p', callId: 'call-p', toolName: 'run_command', summary: 'Run tests',
      status: 'approved', approvalState: 'approved', approvalScope: 'always', alwaysAllowPrefix: 'npm test' },
    { type: 'tool_result', streamId: 'stream-p', callId: 'call-p', toolName: 'run_command', content: 'ok', summary: 'Ran tests' },
  ];
  const state = createTurnReducerState(deterministic);
  const turnEvents = [];
  payloads.forEach((payload, index) => {
    const events = buildTurnEventFromStreamPayload(payload, {
      turn_id: 'stream-p', event_id: `stream-p:${payload.type}:${index}`,
      primary_assistant_message_id: 'assistant_stream-p', primary_tool_message_id: 'tool_use_call-p',
      tool_result_message_id: 'tool_result_call-p', sort_key: [index, 0, 0],
    });
    turnEvents.push(...(Array.isArray(events) ? events : [events]).filter(Boolean));
    applyTurnStreamEvent(state, events);
  });
  const live = state.turns_by_id['stream-p'].rows.find((row) => row.kind === 'approval_gap');
  const hydrated = projectTurn({ turn_id: 'stream-p', events: turnEvents }, deterministic)
    .rows.find((row) => row.kind === 'approval_gap');
  for (const row of [live, hydrated]) {
    assert.equal(row.payload.approval_scope, 'always');
    assert.equal(row.payload.always_allow_prefix, 'npm test');
  }
});

test('an exact Always allowed receipt quotes the command', () => {
  const root = parseFragment(renderApprovalBlock({
    toolCallId: 'call_r', toolName: 'run_command', cardState: 'resolved', decision: 'allowed',
    approvalScope: 'always', commandText: 'python build.py', mode: 'inline',
  }));
  assert.equal(root.querySelector('.tool-approval-receipt-subject').textContent, 'python build.py');
});

test('Settings lists a command grant by its command scope', () => {
  const authority = { project_id: 'project_b', root_path: 'G:/beta' };
  const rows = coreRenderers.buildApprovalRuleRows({ scoped_grants: [
    { id: 'grant_p', tool_name: 'run_command', path_prefix: null,
      match: { tool_id: 'run_command', command_prefix: 'npm test' }, authority },
    { id: 'grant_e', tool_name: 'run_command', path_prefix: null,
      match: { tool_id: 'run_command', command_exact: 'python build.py' }, authority },
  ] }, [{ id: 'project_b', name: 'Beta' }]);
  assert.equal(rows[0].label, 'Always allow: npm test \u2026');
  assert.equal(rows[0].detail, 'Beta · G:/beta · any arguments');
  assert.equal(rows[0].key, 'grant_p');
  assert.equal(rows[1].label, 'Always allow: python build.py');
  assert.equal(rows[1].detail, 'Beta · G:/beta · this exact command');
});
