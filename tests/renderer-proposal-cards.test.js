'use strict';

// The proposal cards' markup (row 59 checkpoint 3): the Git decision tray and the command
// card, drawn only from the projection. Rendering never calls the bridge.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const cards = require('../renderer/chat/renderer-proposal-cards');

const PID = `proposal_${'b'.repeat(64)}`;
const SID = 'session-1';
const LINKS = { continuation_turn_id: null, continuation_work_id: null, command_tool_call_id: null };
const NO = { available: false, reason: null };
const YES = { available: true, reason: null };

function gitProposal(overrides = {}) {
  return {
    schema_version: 1, proposal_id: PID, revision: 1, kind: 'git', decision_state: 'pending', action_state: 'none',
    display: { summary: 'The layout now shares one width. <b>6 files</b> changed & tests pass.', question: 'Commit these 6 files to main?', paths: ['src/a.js', 'src/<odd>&name.js'], path_count: 6 },
    decision: null, links: LINKS, execution: null, last_error: null,
    actions: { commit: YES, test_first: YES, dismiss: YES, cancel: NO, retry: NO },
    ...overrides,
  };
}

const COMMAND = 'python -m pytest -k "a<b && c" -q\necho \'$(whoami)\' > out.txt # & done';

function commandProposal(overrides = {}) {
  return {
    schema_version: 1, proposal_id: PID, revision: 1, kind: 'command', decision_state: 'pending', action_state: 'none',
    display: {
      command: COMMAND, cwd: 'jenny\\sub', purpose: 'Run the long-chat tests', timeout_seconds: 30, expected_exit_codes: [0],
      preconditions: [{ text: 'Jenny is closed on the other machine' }, { text: 'No other test run is in progress' }], backend: 'native', shell: 'cmd.exe',
    },
    decision: null, links: LINKS, execution: null, last_error: null,
    actions: { run: YES, dismiss: YES, cancel: NO, retry: NO },
    ...overrides,
  };
}

function lookup(proposal, extra = {}) {
  return { status: 'ready', proposal, notice: null, busy: false, acks: [], fallback: null, ...extra };
}

function render(kind, view) {
  const html = cards.buildProposalCardMarkup({ sessionId: SID, proposalId: PID, kind, lookup: view });
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  return { html, doc, card: doc.querySelector('[data-proposal-id]') };
}

const statusLine = (doc) => doc.querySelector('.proposal-status');
const byAction = (doc, name) => doc.querySelector(`[data-proposal-action="${name}"]`);

test('the Git tray: eyebrow, summary, question, paths disclosure and the three actions', () => {
  const { card, doc, html } = render('git', lookup(gitProposal()));
  assert.equal(card.dataset.proposalSession, SID);
  assert.equal(card.dataset.proposalKind, 'git');
  assert.equal(card.dataset.proposalState, 'pending');
  assert.equal(doc.querySelector('.user-questions-eyebrow').textContent, 'Ready to commit');
  assert.equal(doc.querySelector('.proposal-question').textContent, 'Commit these 6 files to main?');
  assert.equal(doc.querySelector('.proposal-summary').textContent, 'The layout now shares one width. <b>6 files</b> changed & tests pass.');
  assert.doesNotMatch(html, /<b>6 files<\/b>/u, 'model text is escaped');
  const commit = byAction(doc, 'commit');
  assert.ok(commit.classList.contains('btn--primary') && commit.classList.contains('btn--sm'));
  assert.equal(byAction(doc, 'test_first').textContent.trim(), 'Test first');
  const dismiss = byAction(doc, 'dismiss');
  assert.equal(dismiss.getAttribute('aria-label'), 'Dismiss this proposal');
  assert.equal(dismiss.textContent.trim(), '');
  const details = doc.querySelector('details.proposal-scope');
  assert.equal(details.querySelector('summary').textContent, '6 files');
  assert.deepEqual([...details.querySelectorAll('li code')].map((node) => node.textContent), ['src/a.js', 'src/<odd>&name.js']);
  assert.equal(statusLine(doc), null, 'a pending tray carries no status of its own');
  assert.equal(card.hasAttribute('aria-busy'), false);
});

test('Commit and Test first are unavailable in Plan mode and read-only chats, with the reason in words', () => {
  const planned = gitProposal({ actions: { commit: { available: false, reason: 'plan_mode' }, test_first: { available: false, reason: 'plan_mode' }, dismiss: YES, cancel: NO, retry: NO } });
  const { doc } = render('git', lookup(planned));
  assert.equal(byAction(doc, 'commit').disabled, true);
  assert.equal(byAction(doc, 'test_first').disabled, true);
  assert.equal(byAction(doc, 'dismiss').disabled, false);
  const line = statusLine(doc);
  assert.match(line.textContent, /Commit isn't available in Plan mode\./u);
  assert.equal(line.getAttribute('role'), null, 'not a live region: state changes go through the shared announcer');
  const readOnly = render('git', lookup(gitProposal({ actions: { commit: { available: false, reason: 'read_only' }, test_first: YES, dismiss: YES, cancel: NO, retry: NO } })));
  assert.match(statusLine(readOnly.doc).textContent, /Commit isn't available in a read-only chat\./u);
});

const GIT_STATES = [
  { name: 'queued', overrides: { decision_state: 'accepted', action_state: 'queued', decision: { choice: 'commit' }, actions: { cancel: YES, retry: NO } }, word: 'Commit · Queued', control: 'cancel', controlText: 'Withdraw' },
  { name: 'working', overrides: { decision_state: 'accepted', action_state: 'admitted', decision: { choice: 'commit', accepted_at: new Date(Date.now() - 14000).toISOString() }, actions: { cancel: YES, retry: NO } }, word: 'Commit · Jenny is working on it', control: 'cancel', controlText: 'Cancel', running: true },
  { name: 'finished', overrides: { decision_state: 'accepted', action_state: 'succeeded', decision: { choice: 'commit' }, links: { ...LINKS, continuation_turn_id: 'turn-9' } }, word: 'Commit · Turn finished', control: 'jump-reply', controlText: 'See the reply' },
  { name: 'test first finished', overrides: { decision_state: 'accepted', action_state: 'succeeded', decision: { choice: 'test_first' } }, word: 'Test first · Turn finished', detail: 'No commit was requested.' },
  { name: 'failed', overrides: { decision_state: 'accepted', action_state: 'failed', decision: { choice: 'commit' } }, word: 'Commit · Turn failed', tone: 'error' },
  { name: 'cancelled', overrides: { decision_state: 'accepted', action_state: 'cancelled', decision: { choice: 'test_first' } }, word: 'Test first · Cancelled' },
  { name: 'needs attention', overrides: { decision_state: 'accepted', action_state: 'needs_attention', decision: { choice: 'commit' }, last_error: { code: 'CMP-PROPOSAL-0002', reason: 'unavailable', retryable: true, cause_code: null }, actions: { retry: YES, cancel: NO } }, word: 'Commit · Needs attention', tone: 'warn', control: 'retry', controlText: 'Retry', detail: "Jenny isn't available right now. You can try again." },
  { name: 'dismissed', overrides: { decision_state: 'dismissed' }, word: 'Dismissed' },
  { name: 'expired', overrides: { decision_state: 'expired' }, word: 'Expired after 7 days' },
  { name: 'withdrawn', overrides: { decision_state: 'withdrawn' }, word: 'Withdrawn' },
];

for (const scenario of GIT_STATES) {
  test(`Git receipt: ${scenario.name}`, () => {
    const base = gitProposal(scenario.overrides);
    base.actions = { commit: NO, test_first: NO, dismiss: NO, cancel: NO, retry: NO, ...scenario.overrides.actions };
    const { doc, card } = render('git', lookup(base));
    assert.ok(card.classList.contains('proposal-receipt'));
    assert.equal(doc.querySelector('.proposal-question').textContent, 'Commit these 6 files to main?');
    assert.equal(byAction(doc, 'commit'), null, 'a receipt offers no second choice');
    const line = statusLine(doc);
    assert.equal(line.getAttribute('role'), null);
    assert.equal(line.getAttribute('aria-live'), null);
    assert.equal(line.querySelector('.proposal-state').textContent, scenario.word);
    if (scenario.tone) assert.equal(line.dataset.tone, scenario.tone);
    if (scenario.detail) assert.equal(line.querySelector('.proposal-detail').textContent, scenario.detail);
    if (scenario.control) assert.equal(byAction(doc, scenario.control).textContent.trim(), scenario.controlText);
    if (scenario.running) {
      assert.equal(line.dataset.running, 'true');
      assert.ok(line.querySelector('.proposal-elapsed[data-turn-elapsed][data-elapsed-started-at]'));
    }
    if (scenario.name === 'finished') assert.equal(byAction(doc, 'jump-reply').dataset.proposalTurnId, 'turn-9');
  });
}

test('a failed Git continuation offers no Retry unless the projection says so', () => {
  const failed = gitProposal({ decision_state: 'accepted', action_state: 'failed', decision: { choice: 'commit' }, actions: { commit: NO, test_first: NO, dismiss: NO, cancel: NO, retry: NO } });
  assert.equal(byAction(render('git', lookup(failed)).doc, 'retry'), null);
});

test('a stale proposal keeps its facts, names the drift and accepts no choice', () => {
  const stale = gitProposal({ decision_state: 'stale', actions: { commit: NO, test_first: NO, dismiss: NO, cancel: NO, retry: NO } });
  const { doc } = render('git', lookup(stale));
  assert.match(doc.querySelector('.proposal-summary').textContent, /layout now shares/u);
  assert.equal(byAction(doc, 'commit'), null);
  assert.equal(statusLine(doc).querySelector('.proposal-state').textContent, 'Out of date');
  assert.match(statusLine(doc).textContent, /branch or these files changed/u);
});

test('before the record loads the card is inert: Checking, aria-busy, every action disabled', () => {
  const { doc, card } = render('git', { status: 'checking', proposal: null, notice: null, busy: false, acks: [], fallback: { summary: 'S', question: 'Q?', paths: ['x.js'] } });
  assert.equal(card.getAttribute('aria-busy'), 'true');
  assert.equal(statusLine(doc).querySelector('.proposal-state').textContent, 'Checking…');
  for (const name of ['commit', 'test_first', 'dismiss']) assert.equal(byAction(doc, name).disabled, true, name);
  const command = render('command', { status: 'checking', proposal: null, notice: null, busy: false, acks: [], fallback: { command: 'ls -la' } });
  assert.equal(byAction(command.doc, 'run').disabled, true);
  assert.equal(command.doc.querySelector('code').textContent, 'ls -la');
  assert.ok(command.doc.querySelector('.inv-codeblock-copy'), 'Copy stays available');
});

test('not_found renders one static line and no actions', () => {
  const { doc, card } = render('command', { status: 'not_found', proposal: null, notice: null, busy: false, acks: [], fallback: { command: 'secret' } });
  assert.equal(doc.querySelector('.proposal-gone').textContent, 'This proposal is no longer available.');
  assert.equal(card.querySelectorAll('button').length, 0);
  assert.doesNotMatch(card.textContent, /secret/u);
});

test('with the bridge unavailable the command card stays inert but Copy works on the exact text', () => {
  const { doc } = render('command', { status: 'unavailable', proposal: null, notice: null, busy: false, acks: [], fallback: { command: COMMAND } });
  assert.equal(byAction(doc, 'run').disabled, true);
  assert.equal(doc.querySelector('code').textContent, COMMAND);
  assert.match(statusLine(doc).textContent, /Can't check this proposal right now\./u);
});

test('the command card shows the exact command bytes, escaped, never truncated', () => {
  const { doc, html } = render('command', lookup(commandProposal()));
  assert.equal(doc.querySelector('pre.inv-codeblock code').textContent, COMMAND);
  assert.doesNotMatch(html, /a<b/u, 'the angle bracket is escaped in the markup');
  assert.match(html, /\$\(whoami\)/u);
  assert.ok(doc.querySelector('.proposal-codeblock'));
  assert.equal(doc.querySelector('.inv-codeblock-language').textContent, 'cmd.exe · jenny\\sub · This computer');
  assert.equal(doc.querySelector('.proposal-purpose').textContent, 'Run the long-chat tests');
  const copy = doc.querySelector('.inv-codeblock-copy');
  assert.equal(copy.getAttribute('aria-label'), 'Copy command');
  assert.equal(copy.getAttribute('title'), 'Copy command');
  const run = byAction(doc, 'run');
  assert.equal(run.getAttribute('aria-label'), 'Run command');
  assert.ok(!run.classList.contains('inv-codeblock-copy'), 'Run must never be picked up by the copy handler');
});

test('target line: docker backend and the workspace root', () => {
  const display = { ...commandProposal().display, backend: 'docker', shell: '/bin/sh', cwd: '.' };
  const { doc } = render('command', lookup(commandProposal({ display })));
  assert.equal(doc.querySelector('.inv-codeblock-language').textContent, '/bin/sh · Workspace root · Docker sandbox');
});

test('Run stays disabled until every precondition is ticked', () => {
  const none = render('command', lookup(commandProposal(), { acks: [] }));
  assert.equal(byAction(none.doc, 'run').disabled, true);
  const boxes = [...none.doc.querySelectorAll('[data-proposal-ack]')];
  assert.deepEqual(boxes.map((box) => box.dataset.proposalAck), ['0', '1']);
  assert.equal(none.doc.querySelector('.proposal-precond-title').textContent, 'Before running, confirm');
  assert.equal(none.doc.querySelectorAll('.inv-checkbox__label')[1].textContent, 'No other test run is in progress');
  const one = render('command', lookup(commandProposal(), { acks: [0] }));
  assert.equal(byAction(one.doc, 'run').disabled, true);
  assert.equal(one.doc.querySelector('[data-proposal-ack="0"]').checked, true);
  const all = render('command', lookup(commandProposal(), { acks: [0, 1] }));
  assert.equal(byAction(all.doc, 'run').disabled, false);
  const busy = render('command', lookup(commandProposal(), { acks: [0, 1], busy: true }));
  assert.equal(byAction(busy.doc, 'run').disabled, true);
  const plain = commandProposal();
  plain.display.preconditions = [];
  assert.equal(byAction(render('command', lookup(plain)).doc, 'run').disabled, false);
});

for (const [reason, text] of [
  ['plan_mode', "Run isn't available in Plan mode."],
  ['read_only', "Run isn't available in a read-only chat."],
  ['unsupported_capability', "Run isn't available yet."],
]) {
  test(`Run unavailable (${reason}) is disabled and says so; Copy still works`, () => {
    const proposal = commandProposal({ actions: { run: { available: false, reason }, dismiss: YES, cancel: NO, retry: NO } });
    const { doc } = render('command', lookup(proposal, { acks: [0, 1] }));
    assert.equal(byAction(doc, 'run').disabled, true);
    const line = statusLine(doc);
    assert.equal(line.querySelector('.proposal-state').textContent, text);
    assert.equal(line.querySelector('.proposal-detail').textContent, 'Copy still works.');
    assert.equal(line.getAttribute('aria-live'), null);
    assert.equal(doc.querySelector('.proposal-precond'), null, 'no acknowledgements for an action that cannot run');
    assert.ok(doc.querySelector('.inv-codeblock-copy'));
    assert.equal(byAction(doc, 'dismiss').disabled, false);
  });
}

const COMMAND_STATES = [
  { name: 'dismissed', overrides: { decision_state: 'dismissed' }, word: 'Dismissed' },
  { name: 'stale', overrides: { decision_state: 'stale' }, word: 'Out of date', detail: 'The folder or shell changed since this was proposed.' },
  { name: 'approval', overrides: { decision_state: 'accepted', action_state: 'admitted', links: { ...LINKS, command_tool_call_id: 'call-1' } }, word: 'Waiting for your approval', control: 'jump-tool', controlText: 'Review' },
  { name: 'running', overrides: { decision_state: 'accepted', action_state: 'admitted', execution: { status: 'running', exit_code: null, cleanup: null }, links: { ...LINKS, command_tool_call_id: 'call-1' }, actions: { cancel: YES } }, word: 'Running', control: 'cancel', controlText: 'Cancel', running: true },
  { name: 'exit zero', overrides: { decision_state: 'accepted', action_state: 'succeeded', execution: { status: 'succeeded', exit_code: 0, cleanup: 'confirmed' }, links: { ...LINKS, command_tool_call_id: 'call-1' } }, word: 'Exited 0', control: 'jump-tool', controlText: 'View output' },
  { name: 'exit nonzero', overrides: { decision_state: 'accepted', action_state: 'failed', execution: { status: 'failed', exit_code: 1, cleanup: 'confirmed' } }, word: 'Exited 1', tone: 'error' },
  { name: 'denied or blocked', overrides: { decision_state: 'accepted', action_state: 'cancelled', execution: { status: 'denied', exit_code: null, cleanup: null } }, word: 'Not approved. Nothing ran.' },
  { name: 'expected nonzero exit', overrides: { decision_state: 'accepted', action_state: 'succeeded', execution: { status: 'succeeded', exit_code: 1, cleanup: 'confirmed' } }, word: 'Exited 1', tone: 'ok' },
  { name: 'never started', overrides: { decision_state: 'accepted', action_state: 'failed', execution: { status: 'failed', exit_code: null, cleanup: null } }, word: "Didn't complete", detail: 'No exit code was reported.', tone: 'error' },
  { name: 'cancelled', overrides: { decision_state: 'accepted', action_state: 'cancelled', execution: { status: 'cancelled', exit_code: null, cleanup: 'confirmed' } }, word: 'Cancelled · process stopped' },
  { name: 'interrupted', overrides: { decision_state: 'accepted', action_state: 'needs_attention', execution: { status: 'interrupted_unknown', exit_code: null, cleanup: 'uncertain' }, last_error: { code: 'CMP-PROPOSAL-0012', reason: 'outcome_unknown', retryable: false, cause_code: 'interrupted' } }, word: 'Interrupted · outcome unknown', tone: 'warn', detail: 'This stopped before Jenny could confirm how it ended. Check the result before trying again.' },
  { name: 'restart', overrides: { decision_state: 'accepted', action_state: 'needs_attention', execution: { status: 'interrupted_unknown', exit_code: null, cleanup: null }, last_error: { code: 'CMP-PROPOSAL-0012', reason: 'outcome_unknown', retryable: false, cause_code: 'restart' } }, word: 'Interrupted · outcome unknown', detail: 'Jenny restarted while this ran. Check the result before trying again.' },
  { name: 'cleanup uncertain', overrides: { decision_state: 'accepted', action_state: 'needs_attention', execution: { status: 'cancelled', exit_code: null, cleanup: 'uncertain' }, last_error: { code: 'CMP-PROPOSAL-0012', reason: 'outcome_unknown', retryable: false, cause_code: 'cleanup_uncertain' } }, word: 'Cancelled · cleanup not confirmed' },
  { name: 'dispatch unconfirmed', overrides: { decision_state: 'accepted', action_state: 'needs_attention', execution: { status: 'interrupted_unknown', exit_code: null, cleanup: null }, last_error: { code: 'CMP-PROPOSAL-0012', reason: 'outcome_unknown', retryable: false, cause_code: 'dispatch_unconfirmed' } }, word: 'Interrupted · outcome unknown', detail: "Jenny couldn't confirm this started. Check the result before trying again." },
];

for (const scenario of COMMAND_STATES) {
  test(`command receipt: ${scenario.name} keeps Copy, drops Run and uses the shared status line`, () => {
    const base = commandProposal(scenario.overrides);
    base.actions = { run: NO, dismiss: NO, cancel: NO, retry: NO, ...scenario.overrides.actions };
    const { doc } = render('command', lookup(base));
    assert.equal(doc.querySelector('code').textContent, COMMAND);
    assert.ok(doc.querySelector('.inv-codeblock-copy'));
    assert.equal(byAction(doc, 'run'), null);
    const line = statusLine(doc);
    assert.equal(line.getAttribute('role'), null);
    assert.equal(line.getAttribute('aria-live'), null);
    assert.equal(line.querySelector('.proposal-state').textContent, scenario.word);
    if (scenario.tone) assert.equal(line.dataset.tone, scenario.tone);
    if (scenario.detail) assert.equal(line.querySelector('.proposal-detail').textContent, scenario.detail);
    if (scenario.control) assert.equal(byAction(doc, scenario.control).textContent.trim(), scenario.controlText);
    if (scenario.running) assert.equal(line.dataset.running, 'true');
  });
}

test('a notice from a refused action renders as a polite live line', () => {
  const { doc } = render('git', lookup(gitProposal(), { notice: { text: 'That conflicts with an earlier choice.' } }));
  const notice = doc.querySelector('.proposal-notice');
  assert.equal(notice.textContent, 'That conflicts with an earlier choice.');
  assert.equal(notice.getAttribute('aria-live'), 'polite');
});

test('card identity: only a paired result with a valid proposal id of the matching kind', () => {
  const row = (tool, extra) => ({ kind: 'tool_call', tool_call_id: 'c1', payload: { tool_name: tool, tool_call_id: 'c1', input: {} }, ...extra });
  const result = (metadata) => ({ payload: { metadata } });
  const ok = cards.resolveProposalIdentity(row('propose_git_action'), result({ result_kind: 'git_proposal', proposal_id: PID }), []);
  assert.deepEqual(ok, { proposalId: PID, kind: 'git' });
  assert.deepEqual(cards.resolveProposalIdentity(row('propose_command'), result({ result_kind: 'command_proposal', proposal_id: PID }), []), { proposalId: PID, kind: 'command' });
  assert.equal(cards.resolveProposalIdentity(row('propose_command'), result({ result_kind: 'git_proposal', proposal_id: PID }), []), null);
  assert.equal(cards.resolveProposalIdentity(row('propose_git_action'), result({ result_kind: 'git_proposal', proposal_id: 'nope' }), []), null);
  assert.equal(cards.resolveProposalIdentity(row('bash'), result({ result_kind: 'git_proposal', proposal_id: PID }), []), null);
  assert.equal(cards.resolveProposalIdentity(row('propose_git_action'), null, []), null, 'no result yet: the plain tool row');
  const viaMessage = cards.resolveProposalIdentity(
    row('propose_git_action'), { primary_message_id: 'm2', payload: {} },
    [{ id: 'm2', tool_result: { metadata: { result_kind: 'git_proposal', proposal_id: PID } } }],
  );
  assert.equal(viaMessage.proposalId, PID);
});

test('rendering a card never calls any proposal method', () => {
  const calls = [];
  const bridge = new Proxy({}, { get: (_t, name) => (...args) => { calls.push([name, args]); return Promise.resolve(null); } });
  const previous = globalThis.window;
  globalThis.window = { jennyShell: { sessionProposals: bridge } };
  try {
    const row = { kind: 'tool_call', tool_call_id: 'c1', payload: { tool_name: 'propose_command', tool_call_id: 'c1', input: { command: 'rm -rf build' } } };
    const paired = { payload: { metadata: { result_kind: 'command_proposal', proposal_id: PID } } };
    const store = require('../renderer/chat/renderer-proposal-card-store');
    globalThis.rendererProposalCardStore = store;
    const html = cards.buildProposalRowMarkup(row, [], { pairedToolResultRow: paired, sessionId: SID }, {});
    assert.match(html, /rm -rf build/u);
    assert.match(html, /aria-busy="true"/u);
    // The only traffic is the read-only get the store schedules; no decide, cancel or retry.
    return new Promise((resolve) => setImmediate(() => {
      assert.ok(calls.every(([name]) => name === 'get' || name === 'onChanged'), JSON.stringify(calls.map(([name]) => name)));
      resolve();
    }));
  } finally {
    globalThis.window = previous;
    delete globalThis.rendererProposalCardStore;
  }
});

test('the elapsed counter is hidden from assistive tech (it ticks every second)', () => {
  const running = commandProposal({ decision_state: 'accepted', action_state: 'admitted',
    decision: { decision_id: '11111111-1111-4111-8111-111111111111', choice: 'run', accepted_revision: 2, accepted_at: '2026-10-15T10:00:00.000Z' },
    execution: { status: 'running', exit_code: null, cleanup: null } });
  running.actions = { run: NO, dismiss: NO, cancel: YES, retry: NO };
  const { doc } = render('command', lookup(running));
  const elapsed = doc.querySelector('.proposal-elapsed');
  assert.ok(elapsed, 'a running Run shows the elapsed counter');
  assert.equal(elapsed.getAttribute('aria-hidden'), 'true');
});

test('the kind switch: session goes to the session card, git and command keep their own trays', () => {
  const session = {
    schema_version: 1, proposal_id: PID, revision: 1, kind: 'session', decision_state: 'pending', action_state: 'none',
    display: { title: 'Compare chips', description: null, initiation: 'offer', authorization_required: false },
    group_id: null, options: null, options_editable: false, decision: null, links: LINKS, execution: null, last_error: null,
    actions: { do_it_here: YES, new_session: YES, dismiss: YES, cancel: NO, retry: NO },
  };
  const s = render('session', lookup(session));
  assert.equal(s.card.dataset.proposalKind, 'session');
  assert.equal(byAction(s.doc, 'new_session').textContent.trim(), 'New session');
  assert.equal(byAction(s.doc, 'options'), null, 'no options object, no Options disclosure');
  assert.equal(render('git', lookup(gitProposal())).card.dataset.proposalKind, 'git');
  assert.equal(render('command', lookup(commandProposal())).card.dataset.proposalKind, 'command');
  assert.equal(cards.deriveStatus({ ...session, decision_state: 'expired' }).word, 'Expired after 7 days');
});

test('the group header is exported for in-place patches and is empty without a group', () => {
  assert.equal(cards.buildGroupHeaderMarkup({ sessionId: SID, groupId: 'g', group: null }), '');
  const html = cards.buildGroupHeaderMarkup({ sessionId: SID, groupId: 'group_x', group: { status: 'ready', members: [], busy: false, notice: null } });
  const head = new JSDOM(`<body>${html}</body>`).window.document.querySelector('[data-proposal-group]');
  assert.equal(head.dataset.proposalGroup, 'group_x');
  assert.equal(head.querySelector('[data-proposal-action="start-all"]'), null);
});
