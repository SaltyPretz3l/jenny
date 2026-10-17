'use strict';

// Archive-restore confirmation on the proposal cards (row 59 checkpoint 5b-3): a flagged record
// (actions.confirm_restored present) shows one attention line and a Confirm control, a restored
// command stays inert (Copy only), and unflagged records render exactly as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const cards = require('../renderer/chat/renderer-proposal-cards');
const actions = require('../renderer/chat/renderer-proposal-card-actions');
const { createProposalCardStore } = require('../renderer/chat/renderer-proposal-card-store');

const PID = `proposal_${'e'.repeat(64)}`;
const SID = 'pane-session';
const LINKS = { continuation_turn_id: null, continuation_work_id: null, command_tool_call_id: null, child_session_id: null, first_turn_turn_id: null, first_turn_work_id: null, preparation_turn_id: null };
const NO = { available: false, reason: null };
const YES = { available: true, reason: null };
const AUTH = { available: false, reason: 'authorization_required' };
const UNSUPPORTED = { available: false, reason: 'unsupported_capability' };
const RESTORED_ERROR = { code: 'CMP-PROPOSAL-0008', reason: 'restored_confirmation_required', retryable: false };
const OPTIONS = { destination_project_id: null, preferred_model: null, reasoning_effort: null, run_mode: 'agent' };

function gitPending(overrides = {}) {
  return {
    schema_version: 1, proposal_id: PID, revision: 7, kind: 'git', decision_state: 'pending', action_state: 'none',
    display: { summary: 'Summary', question: 'Commit these 2 files?', paths: ['a.js', 'b.js'], path_count: 2 },
    decision: null, links: LINKS, execution: null, last_error: null,
    actions: { commit: AUTH, test_first: AUTH, dismiss: YES, cancel: NO, retry: NO, confirm_restored: YES },
    ...overrides,
  };
}

function gitParked(overrides = {}) {
  return gitPending({
    decision_state: 'accepted', action_state: 'needs_attention', last_error: RESTORED_ERROR,
    decision: { choice: 'commit', accepted_at: '2026-10-15T10:00:00Z', accepted_revision: 6 },
    actions: { commit: NO, test_first: NO, dismiss: NO, cancel: NO, retry: YES, confirm_restored: YES },
    ...overrides,
  });
}

function sessionPending(overrides = {}) {
  return {
    schema_version: 1, proposal_id: PID, revision: 3, kind: 'session', decision_state: 'pending', action_state: 'none',
    display: { title: 'Compare the cards', description: 'Look at both.', initiation: 'offer', authorization_required: false },
    group_id: null, options: OPTIONS, options_editable: true,
    decision: null, links: LINKS, execution: null, last_error: null,
    actions: { do_it_here: AUTH, new_session: AUTH, dismiss: YES, cancel: NO, retry: NO, confirm_restored: YES },
    ...overrides,
  };
}

function commandPending(overrides = {}) {
  return {
    schema_version: 1, proposal_id: PID, revision: 2, kind: 'command', decision_state: 'pending', action_state: 'none',
    display: { command: 'npm test', cwd: '.', purpose: 'p', timeout_seconds: 30, expected_exit_codes: [0], preconditions: [], backend: 'native', shell: 'cmd.exe' },
    decision: null, links: LINKS, execution: null, last_error: null,
    actions: { run: UNSUPPORTED, dismiss: YES, cancel: NO, retry: NO, confirm_restored: UNSUPPORTED },
    ...overrides,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function lookup(proposal, extra = {}) {
  return { status: 'ready', proposal, notice: null, busy: false, acks: [], fallback: null, group: null, optionsOpen: false, capabilities: { status: 'idle', value: null }, ...extra };
}

function render(kind, proposal) {
  const html = cards.buildProposalCardMarkup({ sessionId: SID, proposalId: PID, kind, lookup: lookup(proposal) });
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  return { doc, text: () => (doc.querySelector('.proposal-status') ? doc.querySelector('.proposal-status').textContent : ''), by: (name) => doc.querySelector(`[data-proposal-action="${name}"]`) };
}

test('a flagged pending Git tray shows the restore line and Confirm, with the choices off and explained', () => {
  const view = render('git', gitPending());
  assert.match(view.text(), /Restored from a backup/u);
  assert.match(view.text(), /Confirm before anything runs\./u);
  const confirm = view.by('confirm-restored');
  assert.ok(confirm);
  assert.equal(confirm.textContent.trim(), 'Confirm');
  assert.equal(view.by('commit').disabled, true);
  assert.equal(view.by('test_first').disabled, true);
  assert.equal(view.by('commit').getAttribute('title'), 'Confirm this restored proposal first.');
  assert.equal(view.by('dismiss').disabled, false);
});

test('a flagged record that cannot be confirmed shows the line without Confirm', () => {
  const view = render('git', gitPending({ actions: { commit: AUTH, test_first: AUTH, dismiss: YES, cancel: NO, retry: NO, confirm_restored: NO } }));
  assert.match(view.text(), /Restored from a backup/u);
  assert.equal(view.by('confirm-restored'), null);
});

test('an unflagged Git tray is unchanged: no restore line, no Confirm, working choices', () => {
  const plain = gitPending({ actions: { commit: YES, test_first: YES, dismiss: YES, cancel: NO, retry: NO } });
  const view = render('git', plain);
  assert.equal(view.text(), '');
  assert.equal(view.by('confirm-restored'), null);
  assert.equal(view.by('commit').disabled, false);
  assert.equal(view.by('commit').getAttribute('title'), null);
});

test('a parked accepted Git action says it needs attention, offers Confirm and never Retry', () => {
  const view = render('git', gitParked());
  assert.match(view.text(), /Commit · Needs attention/u);
  assert.match(view.text(), /Restored from a backup\. Confirm before anything runs\./u);
  assert.ok(view.by('confirm-restored'));
  assert.equal(view.by('retry'), null, 'generic Retry is never the confirmation');
});

test('a flagged session offer shows the restore line, Confirm and disabled choices with the reason', () => {
  const view = render('session', sessionPending());
  assert.match(view.text(), /Restored from a backup/u);
  assert.ok(view.by('confirm-restored'));
  assert.equal(view.by('do_it_here').disabled, true);
  assert.equal(view.by('new_session').disabled, true);
  assert.equal(view.by('do_it_here').getAttribute('title'), 'Confirm this restored proposal first.');
  assert.doesNotMatch(view.text(), /isn't available right now/u, 'the restore line replaces the generic unavailable line');
});

test('a parked New session keeps its child link and gains Confirm without Retry', () => {
  const parked = sessionPending({
    decision_state: 'accepted', action_state: 'needs_attention', options_editable: false, last_error: RESTORED_ERROR,
    decision: { choice: 'new_session', accepted_at: '2026-10-15T10:00:00Z', accepted_revision: 2, options: OPTIONS },
    links: { ...LINKS, child_session_id: 'sess_1760000000000_abcdef012345' },
    actions: { do_it_here: NO, new_session: NO, dismiss: NO, cancel: NO, retry: YES, confirm_restored: YES },
  });
  const view = render('session', parked);
  assert.ok(view.by('confirm-restored'));
  assert.ok(view.by('open-child'));
  assert.equal(view.by('retry'), null);
  assert.match(view.text(), /Restored from a backup\. Confirm before anything runs\./u);
});

test('a restored command shows the fresh-proposal text, keeps Copy and has no Confirm or Run', () => {
  const view = render('command', commandPending());
  assert.match(view.text(), /Restored command proposals can't run\. Ask for a fresh proposal\./u);
  assert.match(view.text(), /Copy still works\./u);
  assert.equal(view.by('confirm-restored'), null);
  assert.equal(view.by('run').disabled, true);
  assert.equal(view.doc.querySelector('pre.inv-codeblock code').textContent, 'npm test', 'the command stays visible');
  assert.equal(view.doc.querySelector('.inv-codeblock-copy').disabled, false, 'Copy is still offered');
});

test('a parked restored command explains it cannot run and offers no Confirm', () => {
  const view = render('command', commandPending({
    decision_state: 'accepted', action_state: 'needs_attention', last_error: RESTORED_ERROR,
    decision: { choice: 'run', accepted_at: '2026-10-15T10:00:00Z', accepted_revision: 1 },
    actions: { run: NO, dismiss: NO, cancel: NO, retry: NO, confirm_restored: UNSUPPORTED },
  }));
  assert.match(view.text(), /Restored command proposals can't run\. Ask for a fresh proposal\./u);
  assert.equal(view.by('confirm-restored'), null);
});

test('a terminal record that still carries the flag shows no restore line', () => {
  const dismissed = gitPending({ decision_state: 'dismissed', actions: { commit: NO, test_first: NO, dismiss: NO, cancel: NO, retry: NO, confirm_restored: NO } });
  const view = render('git', dismissed);
  assert.equal(view.text(), 'Dismissed');
  assert.equal(view.by('confirm-restored'), null);
});

// ---- the bound click ------------------------------------------------------------------------

function makeBridge(handler) {
  const calls = [];
  return {
    calls,
    get: async () => ({ ok: false }),
    confirmRestored: async (request) => { calls.push(request); return handler(request, calls.length); },
    onChanged: () => () => {},
  };
}

function setup(proposal, bridge) {
  const dom = new JSDOM('<body><div class="timeline"></div></body>');
  let n = 0;
  const store = createProposalCardStore({ getBridge: () => bridge, randomUUID: () => `gesture-${n += 1}` });
  store.apply(SID, proposal);
  const container = dom.window.document.querySelector('.timeline');
  container.insertAdjacentHTML('beforeend', cards.buildProposalCardMarkup({ sessionId: SID, proposalId: PID, kind: proposal.kind, lookup: store.lookup(SID, PID) }));
  const dispose = actions.bindProposalCardInteractions(container, { store, cards, getBridge: () => bridge });
  return { store, container, dispose, by: (name) => container.querySelector(`[data-proposal-action="${name}"]`), text: () => container.querySelector('.proposal-status')?.textContent || '' };
}

test('Confirm calls confirmRestored once with the displayed revision and one gesture id, then the card follows the projection', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const bridge = makeBridge(async () => {
    await gate;
    return { schema_version: 1, ok: true, created: true, proposal: gitPending({ revision: 8, actions: { commit: YES, test_first: YES, dismiss: YES, cancel: NO, retry: NO } }) };
  });
  const ctx = setup(gitPending(), bridge);
  const confirm = ctx.by('confirm-restored');
  confirm.click();
  confirm.click(); // a double click is one gesture
  await flush();
  release();
  await flush();
  assert.equal(bridge.calls.length, 1);
  assert.deepEqual(bridge.calls[0], { schema_version: 1, session_id: SID, proposal_id: PID, expected_revision: 7, decision_id: 'gesture-1' });
  assert.equal(ctx.by('confirm-restored'), null, 'the cleared record no longer asks');
  assert.equal(ctx.by('commit').disabled, false, 'it is an ordinary pending offer again');
  ctx.dispose();
});

test('a stale-revision refusal shows the calm notice and keeps the card', async () => {
  const bridge = makeBridge(async () => ({ schema_version: 1, ok: false, error_code: 'CMP-PROPOSAL-0003', reason: 'stale_revision', retryable: false }));
  const ctx = setup(gitPending(), bridge);
  ctx.by('confirm-restored').click();
  await flush();
  assert.match(ctx.container.querySelector('.proposal-notice').textContent, /This proposal changed\./u);
  assert.ok(ctx.by('confirm-restored'));
  ctx.dispose();
});

test('the command card never reaches confirmRestored', async () => {
  const bridge = makeBridge(async () => ({ ok: true }));
  const ctx = setup(commandPending(), bridge);
  assert.equal(ctx.by('confirm-restored'), null);
  assert.equal(bridge.calls.length, 0);
  ctx.dispose();
});
