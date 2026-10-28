'use strict';

// The session offer card and suggestion row (row 59 checkpoint 5a-2): drawn only from the
// projection, escaped, with the shipped .proposal-status grammar for every state. Fixture
// projections follow the frozen shapes of the cp5a spec section 1.9. Rendering never calls the bridge.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const cards = require('../renderer/chat/renderer-proposal-cards');
const sessionCards = require('../renderer/chat/renderer-proposal-session-cards');

const PID = `proposal_${'d'.repeat(64)}`;
const SID = 'session-1';
const CHILD = 'sess_1760000000000_abcdef012345';
const NO = { available: false, reason: null };
const YES = { available: true, reason: null };
const TITLE = 'Compare <b>the old</b> task chip & "the new" offer card';
const LINKS = {
  continuation_turn_id: null, continuation_work_id: null, command_tool_call_id: null,
  child_session_id: null, first_turn_turn_id: null, first_turn_work_id: null, preparation_turn_id: null,
};
const OPTIONS = { destination_project_id: 'proj-a', preferred_model: 'qwen-27b', reasoning_effort: 'high', run_mode: 'agent' };
const CAPS = {
  ok: true,
  destinations: [{ project_id: 'proj-a', label: 'jenny', available: true }, { project_id: null, label: 'No project', available: true }, { project_id: 'proj-b', label: 'other', available: false }],
  models: [{ id: 'qwen-27b', label: 'Qwen3.8 27B' }, { id: 'small', label: 'Small' }],
  reasoning_efforts: ['low', 'high'],
  run_modes: ['agent', 'plan'],
  restrictions: { read_only: false, plan_mode: false, lockdown: false },
  unavailable_reason: null,
};

function sessionProposal(overrides = {}) {
  return {
    schema_version: 1, proposal_id: PID, revision: 3, kind: 'session', decision_state: 'pending', action_state: 'none',
    display: { title: TITLE, description: 'Look at <i>both</i> and report.', initiation: 'offer', authorization_required: false },
    group_id: null, options: OPTIONS, options_editable: true,
    decision: null, links: LINKS, execution: null, last_error: null,
    actions: { do_it_here: YES, new_session: YES, dismiss: YES, cancel: NO, retry: NO },
    ...overrides,
  };
}

function accepted(choice, actionState, extra = {}) {
  return sessionProposal({
    decision_state: 'accepted', action_state: actionState, options_editable: false,
    decision: { choice, accepted_at: new Date(Date.now() - 5000).toISOString(), accepted_revision: 3, options: choice === 'new_session' ? OPTIONS : null },
    actions: { do_it_here: NO, new_session: NO, dismiss: NO, cancel: NO, retry: NO },
    ...extra,
  });
}

function withChild(child) {
  return accepted('new_session', 'succeeded', {
    links: { ...LINKS, child_session_id: CHILD, first_turn_turn_id: 't1', first_turn_work_id: 'w1' },
    child: { model: 'ornith15:9b-q6-256k', run_mode: 'ask', project_label: 'rise-of-nations', resume_count: 0, resume_max: 0, key: JSON.stringify(child), ...child },
  });
}

function lookup(proposal, extra = {}) {
  return {
    status: 'ready', proposal, notice: null, busy: false, acks: [], fallback: null, group: null, optionsOpen: false,
    capabilities: { status: 'idle', value: null }, ...extra,
  };
}

function render(view) {
  const html = cards.buildProposalCardMarkup({ sessionId: SID, proposalId: PID, kind: 'session', lookup: view });
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  return { html, doc, card: doc.querySelector('[data-proposal-id]') };
}

const renderWith = (view, deps) => {
  const html = cards.buildProposalCardMarkup({ sessionId: SID, proposalId: PID, kind: 'session', lookup: view }, deps);
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  return { html, doc, card: doc.querySelector('[data-proposal-id]') };
};
const PRIMARY = { isPrimarySession: (id) => id === SID };
const always = (doc) => doc.querySelector('.proposal-always');

const byAction = (doc, name) => doc.querySelector(`[data-proposal-action="${name}"]`);
const statusLine = (doc) => doc.querySelector('.proposal-status');

test('the offer tray: eyebrow, escaped title and description, two equal choices, Options and dismiss', () => {
  const { card, doc, html } = render(lookup(sessionProposal()));
  assert.equal(card.dataset.proposalKind, 'session');
  assert.equal(card.dataset.proposalState, 'pending');
  assert.equal(card.getAttribute('aria-label'), 'Offer to start a new chat');
  assert.equal(doc.querySelector('.user-questions-eyebrow').textContent, 'Start this in its own session?');
  assert.equal(doc.querySelector('.proposal-session-title').textContent, TITLE);
  assert.equal(doc.querySelector('.proposal-session-desc').textContent, 'Look at <i>both</i> and report.');
  assert.doesNotMatch(html, /<b>the old<\/b>/u, 'model text is escaped');
  assert.doesNotMatch(html, /<i>both<\/i>/u);
  const local = byAction(doc, 'do_it_here');
  const fresh = byAction(doc, 'new_session');
  assert.equal(local.textContent.trim(), 'Do it here');
  assert.equal(fresh.textContent.trim(), 'New session');
  for (const button of [local, fresh]) {
    assert.ok(button.classList.contains('btn--sm'));
    assert.equal(button.classList.contains('btn--primary'), false, 'the two choices are equal: neither is primary');
    assert.equal(button.disabled, false);
  }
  assert.equal(local.className, fresh.className);
  assert.equal(byAction(doc, 'dismiss').getAttribute('aria-label'), 'Dismiss this proposal');
  assert.equal(statusLine(doc), null, 'a pending tray carries no status of its own');
  assert.equal(doc.querySelector('.proposal-session-note'), null);
});

test('every button with an aria-label or icon content also carries a title', () => {
  const group = { groupId: 'group_x', status: 'ready', members: [], busy: false, notice: null };
  const suggestion = sessionProposal({ display: { title: 'T', description: null, initiation: 'own_initiative', authorization_required: false }, group_id: 'group_x' });
  for (const [view, minimum] of [[lookup(sessionProposal()), 1], [lookup(suggestion, { group }), 3]]) {
    const { doc } = render(view);
    const labelled = [...doc.querySelectorAll('button[aria-label]')];
    assert.ok(labelled.length >= minimum);
    for (const button of labelled) assert.ok(button.getAttribute('title'), `title on ${button.getAttribute('data-proposal-action')}`);
  }
});

test('an unauthorized user_asked offer carries the plain note', () => {
  const { doc } = render(lookup(sessionProposal({ display: { title: 'T', description: null, initiation: 'offer', authorization_required: true } })));
  assert.equal(doc.querySelector('.proposal-session-note').textContent,
    'You asked for a separate chat, but it was not authorized, so here is the choice.');
  assert.equal(doc.querySelector('.proposal-session-desc'), null, 'no description, no empty line');
});

test('Options: closed by default with a toggle, a hidden popover and the summary; open shows the four controls', () => {
  const closed = render(lookup(sessionProposal(), { capabilities: { status: 'ready', value: CAPS } }));
  const toggle = byAction(closed.doc, 'options');
  assert.equal(toggle.textContent.trim(), 'Options');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-haspopup'), 'dialog');
  const popover = closed.doc.querySelector('.proposal-options-popover');
  assert.equal(toggle.getAttribute('aria-controls'), popover.id);
  assert.equal(popover.hidden, true);
  assert.equal(closed.doc.querySelector('.proposal-options-summary').textContent, 'jenny · Qwen3.8 27B · high · Agent');

  const open = render(lookup(sessionProposal(), { optionsOpen: true, capabilities: { status: 'ready', value: CAPS } }));
  assert.equal(byAction(open.doc, 'options').getAttribute('aria-expanded'), 'true');
  const pop = open.doc.querySelector('.proposal-options-popover');
  assert.equal(pop.hidden, false);
  assert.equal(pop.getAttribute('role'), 'dialog');
  const selectOf = (key) => pop.querySelector(`select[data-proposal-option="${key}"]`);
  assert.equal(selectOf('destination').value, 'proj-a');
  assert.deepEqual([...selectOf('destination').options].map((o) => [o.value, o.textContent, o.disabled]),
    [['proj-a', 'jenny', false], ['', 'No project', false], ['proj-b', 'other', true]]);
  assert.equal(selectOf('model').value, 'qwen-27b');
  assert.deepEqual([...selectOf('model').options].map((o) => o.textContent), ['Automatic', 'Qwen3.8 27B', 'Small']);
  assert.equal(selectOf('effort').value, 'high');
  const mode = pop.querySelector('[data-proposal-option="run_mode"]');
  assert.equal(mode.getAttribute('role'), 'radiogroup');
  assert.equal(mode.querySelector('[aria-checked="true"]').getAttribute('data-value'), 'agent');
  assert.match(pop.textContent, /Permissions follow this chat and can't be raised here\./u);
});

test('Options: a Plan source offers only plan (no radio group); null model and effort read as Automatic', () => {
  const planOnly = { ...CAPS, run_modes: ['plan'] };
  const options = { ...OPTIONS, preferred_model: null, reasoning_effort: null, run_mode: 'plan' };
  const { doc } = render(lookup(sessionProposal({ options }), { optionsOpen: true, capabilities: { status: 'ready', value: planOnly } }));
  assert.equal(doc.querySelector('[data-proposal-option="run_mode"]'), null);
  assert.equal(doc.querySelector('.proposal-options-value').textContent, 'Plan');
  assert.equal(doc.querySelector('select[data-proposal-option="model"]').value, '');
  assert.equal(doc.querySelector('select[data-proposal-option="effort"]').value, '');
  assert.equal(doc.querySelector('.proposal-options-summary').textContent, 'jenny · Plan');
});

test('Options: locked while busy or not editable; loading and failed reads say so in words', () => {
  const busy = render(lookup(sessionProposal(), { busy: true, optionsOpen: true, capabilities: { status: 'ready', value: CAPS } }));
  for (const control of busy.doc.querySelectorAll('.proposal-options-popover select')) assert.equal(control.disabled, true);
  const fixed = render(lookup(sessionProposal({ options_editable: false }), { optionsOpen: true, capabilities: { status: 'ready', value: CAPS } }));
  assert.equal(byAction(fixed.doc, 'options').disabled, true);
  const loading = render(lookup(sessionProposal(), { optionsOpen: true, capabilities: { status: 'loading', value: null } }));
  assert.equal(loading.doc.querySelector('.proposal-options-note').textContent, 'Loading options…');
  assert.equal(loading.doc.querySelector('select'), null);
  const failed = render(lookup(sessionProposal(), { optionsOpen: true, capabilities: { status: 'error', value: null } }));
  assert.equal(failed.doc.querySelector('.proposal-options-note').textContent, "Options aren't available right now.");
  const gated = render(lookup(sessionProposal(), { optionsOpen: true, capabilities: { status: 'ready', value: { ...CAPS, unavailable_reason: 'runtime_disabled' } } }));
  assert.equal(gated.doc.querySelector('.proposal-options-note').textContent, "Options aren't available right now.");
  assert.doesNotMatch(gated.html, /runtime_disabled/u, 'the stable reason code is never shown');
});

test('New session unavailable (runtime or negotiation): said plainly, Do it here still works, no fallback', () => {
  const blocked = sessionProposal({ actions: { do_it_here: YES, new_session: { available: false, reason: 'unsupported_capability' }, dismiss: YES, cancel: NO, retry: NO } });
  const { doc } = render(lookup(blocked));
  assert.equal(byAction(doc, 'new_session').disabled, true);
  assert.equal(byAction(doc, 'do_it_here').disabled, false);
  const line = statusLine(doc);
  assert.equal(line.querySelector('.proposal-state').textContent, "Starting a separate chat isn't available here.");
  assert.equal(line.querySelector('.proposal-detail').textContent, 'Do it here still works.');
});

const STATES = [
  { name: 'waiting for the source turn', proposal: accepted('new_session', 'waiting_for_source', { actions: { cancel: YES, retry: NO, dismiss: NO } }), word: 'Waiting for the current turn to finish', tone: 'pending', control: 'cancel', controlText: 'Cancel' },
  { name: 'queued', proposal: accepted('new_session', 'queued', { actions: { cancel: YES, retry: NO, dismiss: NO } }), word: 'Queued', tone: 'pending', detail: 'Runs after the current turn', control: 'cancel', controlText: 'Withdraw' },
  { name: 'preparing', proposal: accepted('new_session', 'preparing', { actions: { cancel: YES, retry: NO, dismiss: NO } }), word: 'Preparing the new chat…', tone: 'active', running: true, control: 'cancel', controlText: 'Cancel' },
  { name: 'child created', proposal: accepted('new_session', 'child_created', { links: { ...LINKS, child_session_id: CHILD } }), word: 'Starting the new chat…', tone: 'active', running: true, control: 'open-child', controlText: 'Open', noControl: 'cancel' },
  { name: 'started', proposal: accepted('new_session', 'succeeded', { links: { ...LINKS, child_session_id: CHILD, first_turn_turn_id: 't1', first_turn_work_id: 'w1' } }), word: `Started · ${TITLE}`, tone: 'ok', control: 'open-child', controlText: 'Open' },
  // F3b (2026-10-27): after admission the card follows its child (proposal.child, derived per read).
  { name: 'child running', proposal: withChild({ phase: 'running', turn_started_at: new Date().toISOString() }), word: 'Running', tone: 'active', running: true, control: 'open-child', controlText: 'Open' },
  { name: 'child resumed automatically', proposal: withChild({ phase: 'running', resume_count: 2, resume_max: 5 }), word: 'Running', tone: 'active', running: true, detail: 'Resumed automatically after a turn-budget stop (2 of 5)' },
  { name: 'child waiting for the user', proposal: withChild({ phase: 'waiting' }), word: 'Waiting for you', tone: 'warn', detail: 'The new chat needs your answer.', control: 'open-child', controlText: 'Open' },
  { name: 'child reported back', proposal: withChild({ phase: 'reported', reply_turn_id: 'wake-1' }), word: 'Reported back', tone: 'ok', control: 'jump-reply', controlText: 'See the reply', also: 'open-child' },
  { name: 'child stopped at the cap', proposal: withChild({ phase: 'stopped', resume_count: 5, resume_max: 5 }), word: 'Stopped', tone: 'warn', detail: 'Jenny resumed it 5 of 5 times. Reply "resume" in the chat to keep going.' },
  { name: 'child stopped, no resumes', proposal: withChild({ phase: 'stopped' }), word: 'Turn budget used up', tone: 'warn', detail: 'Reply "resume" in the chat to keep going.' },
  { name: 'child first turn failed (the incident)', proposal: withChild({ phase: 'failed', error_class: 'model_busy', failed_turn_is_first: true, retry: { message_id: 'a_t1' } }), word: "Couldn't start the new chat", tone: 'error', detail: 'The model was still switching. Nothing ran.', control: 'retry-child', controlText: 'Retry', also: 'open-child' },
  { name: 'child later turn failed', proposal: withChild({ phase: 'failed', error_class: 'engine' }), word: 'The new chat stopped with an error', tone: 'error', detail: "The model didn't respond.", noControl: 'retry-child' },
  { name: 'child needs attention', proposal: withChild({ phase: 'attention' }), word: 'Needs attention', tone: 'warn', detail: 'This needs your attention.', control: 'open-child', controlText: 'Open' },
  { name: 'child archived', proposal: withChild({ phase: 'archived' }), word: 'Archived', tone: 'muted', control: 'open-child', controlText: 'Open' },
  { name: 'child deleted', proposal: withChild({ phase: 'gone' }), word: 'The new chat was deleted', tone: 'muted', noControl: 'open-child' },
  { name: 'cancelled', proposal: accepted('new_session', 'cancelled'), word: 'Cancelled', tone: 'muted' },
  { name: 'preparation failed (deadline)', proposal: accepted('new_session', 'needs_attention', { actions: { retry: YES, cancel: NO, dismiss: NO }, last_error: { code: 'CMP-PROPOSAL-0010', reason: 'preparation_failed', retryable: true, cause_code: 'deadline' } }), word: "Couldn't prepare the new chat", tone: 'warn', detail: 'Preparing took longer than 60 seconds. You can try again.', control: 'retry', controlText: 'Retry' },
  { name: 'preparation failed (no brief)', proposal: accepted('new_session', 'needs_attention', { actions: { retry: YES, cancel: NO, dismiss: NO }, last_error: { code: 'CMP-PROPOSAL-0010', reason: 'preparation_failed', retryable: true, cause_code: 'no_handoff' } }), word: "Couldn't prepare the new chat", tone: 'warn', detail: "Jenny didn't finish the brief. You can try again." },
  { name: 'created but could not start', proposal: accepted('new_session', 'needs_attention', { actions: { retry: YES, cancel: NO, dismiss: NO }, links: { ...LINKS, child_session_id: CHILD }, last_error: { code: 'CMP-PROPOSAL-0011', reason: 'dispatch_failed', retryable: true, cause_code: null } }), word: "Couldn't start the new chat", tone: 'warn', detail: 'The new chat exists. You can try starting it again.', control: 'open-child', controlText: 'Open', also: 'retry' },
  { name: 'background chats unavailable', proposal: accepted('new_session', 'needs_attention', { actions: { retry: YES, cancel: NO, dismiss: NO }, last_error: { code: 'CMP-PROPOSAL-0002', reason: 'unavailable', retryable: true, cause_code: null } }), word: "Background chats aren't available", tone: 'warn', detail: 'Nothing was started. Do it here still works.' },
  { name: 'authority changed', proposal: accepted('new_session', 'needs_attention', { last_error: { code: 'CMP-PROPOSAL-0007', reason: 'authority_changed', retryable: false, cause_code: null } }), word: 'Out of date', tone: 'warn' },
  { name: 'Do it here queued', proposal: accepted('do_it_here', 'queued', { actions: { cancel: YES, retry: NO, dismiss: NO } }), word: 'Do it here · Queued', tone: 'pending', control: 'cancel', controlText: 'Withdraw' },
  { name: 'Do it here waiting for the source', proposal: accepted('do_it_here', 'waiting_for_source', { actions: { cancel: YES, retry: NO, dismiss: NO } }), word: 'Do it here · Waiting for the current turn to finish', tone: 'pending' },
  { name: 'Do it here working', proposal: accepted('do_it_here', 'admitted', { actions: { cancel: YES, retry: NO, dismiss: NO } }), word: 'Do it here · Jenny is working on it', tone: 'active', running: true, control: 'cancel', controlText: 'Cancel' },
  { name: 'Do it here finished', proposal: accepted('do_it_here', 'succeeded', { links: { ...LINKS, continuation_turn_id: 'turn-9' } }), word: 'Do it here · Turn finished', tone: 'ok', control: 'jump-reply', controlText: 'See the reply' },
  { name: 'Do it here failed', proposal: accepted('do_it_here', 'failed'), word: 'Do it here · Turn failed', tone: 'error' },
  { name: 'Do it here cancelled', proposal: accepted('do_it_here', 'cancelled'), word: 'Do it here · Cancelled', tone: 'muted' },
  { name: 'Do it here needs attention', proposal: accepted('do_it_here', 'needs_attention', { actions: { retry: YES, cancel: NO, dismiss: NO }, last_error: { code: 'CMP-PROPOSAL-0011', reason: 'dispatch_failed', retryable: true, cause_code: null } }), word: 'Do it here · Needs attention', tone: 'warn', detail: "Jenny couldn't start this. You can try again.", control: 'retry', controlText: 'Retry' },
  { name: 'dismissed', proposal: sessionProposal({ decision_state: 'dismissed', options_editable: false, actions: { do_it_here: NO, new_session: NO, dismiss: NO, cancel: NO, retry: NO } }), word: 'Dismissed', tone: 'muted' },
  { name: 'expired', proposal: sessionProposal({ decision_state: 'expired', options_editable: false }), word: 'Expired after 7 days', tone: 'muted' },
  { name: 'withdrawn', proposal: sessionProposal({ decision_state: 'withdrawn', options_editable: false }), word: 'Withdrawn', tone: 'muted' },
  { name: 'stale', proposal: sessionProposal({ decision_state: 'stale', options_editable: false }), word: 'Out of date', tone: 'warn' },
];

for (const scenario of STATES) {
  test(`session receipt: ${scenario.name}`, () => {
    const proposal = scenario.proposal;
    proposal.actions = { do_it_here: NO, new_session: NO, dismiss: NO, cancel: NO, retry: NO, ...proposal.actions };
    const { doc, card, html } = render(lookup(proposal));
    assert.ok(card.classList.contains('proposal-receipt'));
    assert.equal(doc.querySelector('.proposal-session-title').textContent, TITLE);
    assert.equal(byAction(doc, 'new_session'), null, 'a receipt offers no second choice');
    assert.equal(byAction(doc, 'do_it_here'), null);
    assert.equal(byAction(doc, 'options'), null);
    assert.doesNotMatch(html, /<b>the old<\/b>/u);
    const line = statusLine(doc);
    assert.equal(line.getAttribute('role'), null, 'not a live region: changes go through the shared announcer');
    assert.equal(line.querySelector('.proposal-state').textContent, scenario.word);
    assert.equal(line.dataset.tone, scenario.tone);
    assert.equal(line.querySelector('.status-dot').getAttribute('aria-hidden'), 'true', 'the dot only echoes the state word');
    if (scenario.detail) assert.equal(line.querySelector('.proposal-detail').textContent, scenario.detail);
    if (scenario.running) assert.equal(line.dataset.running, 'true');
    else assert.equal(line.hasAttribute('data-running'), false);
    if (scenario.control) assert.equal(byAction(doc, scenario.control).textContent.trim(), scenario.controlText);
    if (scenario.also) assert.ok(byAction(doc, scenario.also));
    if (scenario.noControl) assert.equal(byAction(doc, scenario.noControl), null);
  });
}

test('the child link is a button with the child id; it opens nothing by itself', () => {
  const proposal = accepted('new_session', 'succeeded', { links: { ...LINKS, child_session_id: CHILD } });
  proposal.actions = { do_it_here: NO, new_session: NO, dismiss: NO, cancel: NO, retry: NO };
  const { doc } = render(lookup(proposal));
  const open = byAction(doc, 'open-child');
  assert.equal(open.tagName, 'BUTTON');
  assert.equal(open.dataset.proposalChildId, CHILD);
  assert.equal(doc.querySelector('a[href]'), null);
});

test('a suggestion row: title, clamped description, Options, Do it here, Start and dismiss (no eyebrow, no primary)', () => {
  const proposal = sessionProposal({ display: { title: TITLE, description: 'A short preview of the task.', initiation: 'own_initiative', authorization_required: false } });
  const { doc, card } = render(lookup(proposal));
  assert.ok(card.classList.contains('proposal-suggestion'));
  assert.equal(card.getAttribute('aria-label'), 'Suggested task');
  assert.equal(doc.querySelector('.user-questions-eyebrow'), null);
  assert.equal(doc.querySelector('.proposal-session-desc').textContent, 'A short preview of the task.');
  const start = byAction(doc, 'new_session');
  assert.equal(start.textContent.trim(), 'Start');
  assert.equal(start.getAttribute('aria-label'), `Start ${TITLE} in a new chat`);
  assert.equal(start.getAttribute('title'), start.getAttribute('aria-label'));
  assert.equal(byAction(doc, 'do_it_here').textContent.trim(), 'Do it here');
  assert.ok(byAction(doc, 'options'));
  assert.ok(byAction(doc, 'dismiss'));
  assert.equal(doc.querySelector('.btn--primary'), null);
});

test('before the record loads: the tool input shows with disabled choices; a missing record says so', () => {
  const fallback = { title: 'Early title', description: '', initiation: 'offer' };
  const checking = render({ status: 'checking', proposal: null, notice: null, busy: false, acks: [], fallback });
  assert.equal(checking.doc.querySelector('.proposal-session-title').textContent, 'Early title');
  assert.equal(byAction(checking.doc, 'new_session').disabled, true);
  assert.equal(byAction(checking.doc, 'do_it_here').disabled, true);
  assert.equal(statusLine(checking.doc).querySelector('.proposal-state').textContent, 'Checking…');
  const gone = render({ status: 'not_found', proposal: null, notice: null, busy: false, acks: [], fallback });
  assert.equal(gone.doc.querySelector('.proposal-gone').textContent, 'This proposal is no longer available.');
});

test('a notice from a refused click shows inside the card as a polite status', () => {
  const { doc } = render(lookup(sessionProposal(), { notice: { text: "Starting a separate chat isn't available here." } }));
  const notice = doc.querySelector('.proposal-notice');
  assert.equal(notice.getAttribute('role'), 'status');
  assert.equal(notice.textContent, "Starting a separate chat isn't available here.");
});

test('the tool row: propose_session with a session_proposal result becomes the card; complete_session_handoff stays an ordinary tool row', () => {
  const row = (name, meta) => ({ payload: { tool_name: name, input: { title: 'From the input', initiation: 'offer' }, metadata: meta }, tool_call_id: 'c1' });
  const identity = cards.resolveProposalIdentity(row('propose_session', { result_kind: 'session_proposal', proposal_id: PID }), null, []);
  assert.deepEqual(identity, { proposalId: PID, kind: 'session' });
  const html = cards.buildProposalRowMarkup(row('propose_session', { result_kind: 'session_proposal', proposal_id: PID }), [], { sessionId: SID }, {});
  assert.match(html, /data-proposal-kind="session"/u);
  assert.match(html, /From the input/u);
  assert.equal(cards.resolveProposalIdentity(row('complete_session_handoff', { result_kind: 'session_handoff', proposal_id: PID }), null, []), null);
  assert.equal(cards.buildProposalRowMarkup(row('complete_session_handoff', { result_kind: 'session_handoff', proposal_id: PID }), [], { sessionId: SID }, {}), '');
  assert.equal(cards.resolveProposalIdentity(row('propose_session', { result_kind: 'git_proposal', proposal_id: PID }), null, []), null, 'a mismatched result kind is not a card');
});

test('deriveSessionStatus is closed: an unknown decision state renders nothing', () => {
  assert.equal(sessionCards.deriveSessionStatus(sessionProposal({ decision_state: 'pending' })), null);
  assert.equal(cards.deriveStatus(sessionProposal({ decision_state: 'dismissed' })).word, 'Dismissed');
});

test('a paired propose_session result renders the session card in the turn row; a successful complete_session_handoff draws no row (F3c)', async () => {
  const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');
  const store = require('../renderer/chat/renderer-proposal-card-store');
  const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const gets = [];
  const savedWindow = globalThis.window;
  globalThis.window = { jennyShell: { sessionProposals: { get: async (request) => { gets.push(request); return null; }, onChanged: () => () => {} } } };
  Object.assign(globalThis, { rendererProposalCardStore: store, rendererProposalCards: cards });
  try {
    const renderer = createTurnRowRenderUtils({ MESSAGE_STATUS: { STREAMING: 'streaming' }, escapeHtml });
    const pair = (toolName, kind, id, resultState = 'completed') => [
      { row_id: `${id}-1`, turn_id: 't1', kind: 'tool_call', primary_message_id: `tool_use_${id}`, tool_call_id: id,
        payload: { tool_call_id: id, tool_name: toolName, state: 'completed', input: { title: 'Compare <chips>', initiation: 'offer' } } },
      { row_id: `${id}-2`, turn_id: 't1', kind: 'tool_result', primary_message_id: `tool_result_${id}`, tool_call_id: id,
        payload: { tool_call_id: id, tool_name: toolName, state: resultState, metadata: kind ? { result_kind: kind, proposal_id: PID } : null } },
    ];
    const html = renderer.buildTurnRowListMarkup(pair('propose_session', 'session_proposal', 'c1'), [], { sessionId: 'pane-s' });
    assert.match(html, new RegExp(`data-proposal-id="${PID}"`));
    assert.match(html, /data-proposal-kind="session"/u);
    assert.match(html, /Compare &lt;chips&gt;/u);
    assert.equal((html.match(/data-row-id=/gu) || []).length, 1, 'one card for the call and its result');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(gets, [{ schema_version: 1, session_id: 'pane-s', proposal_id: PID }]);
    const handoff = renderer.buildTurnRowListMarkup(pair('complete_session_handoff', 'session_handoff', 'c2'), [], { sessionId: 'pane-s' });
    assert.doesNotMatch(handoff, /data-proposal-id/u, 'the handoff tool is never a second card');
    assert.equal((handoff.match(/data-row-id=/gu) || []).length, 0, 'the session card above is its receipt');
    const running = renderer.buildTurnRowListMarkup(pair('complete_session_handoff', 'session_handoff', 'c3').slice(0, 1), [], { sessionId: 'pane-s' });
    assert.equal((running.match(/data-row-id=/gu) || []).length, 0, 'not drawn while it runs either');
    const refused = renderer.buildTurnRowListMarkup(pair('complete_session_handoff', null, 'c4', 'error'), [], { sessionId: 'pane-s' });
    assert.equal((refused.match(/data-row-id=/gu) || []).length, 1, 'a failed handoff keeps its ordinary row');
    assert.doesNotMatch(refused, /data-proposal-id/u);
  } finally {
    globalThis.window = savedWindow;
    delete globalThis.rendererProposalCardStore;
    delete globalThis.rendererProposalCards;
  }
});

// ---- Row 76 (E1): the primary chat's "Always allow" row ----

test('Always allow row: a primary pending offer shows it with the destination label from capabilities', () => {
  const view = lookup(sessionProposal(), { capabilities: { status: 'ready', value: CAPS } });
  const { doc } = renderWith(view, PRIMARY);
  const row = always(doc);
  assert.ok(row);
  assert.equal(row.querySelector('.inv-checkbox').textContent.trim(), 'Always allow Jenny to start chats in jenny');
  const input = row.querySelector('input[type="checkbox"]');
  assert.equal(input.id, `proposal-always-${PID}`);
  assert.equal(input.hasAttribute('data-proposal-always-allow'), true);
  assert.equal(input.checked, false);
  assert.equal(doc.querySelector('.proposal-actions').nextElementSibling, row, 'the row follows the choices');
});

test('Always allow row: "this project" when the label is unknown; escaped when it carries markup', () => {
  const unknown = renderWith(lookup(sessionProposal()), PRIMARY);
  assert.equal(always(unknown.doc).textContent.trim(), 'Always allow Jenny to start chats in this project');
  const hostile = { ...CAPS, destinations: [{ project_id: 'proj-a', label: '<b>x</b>', available: true }] };
  const rendered = renderWith(lookup(sessionProposal(), { capabilities: { status: 'ready', value: hostile } }), PRIMARY);
  assert.doesNotMatch(rendered.html, /<b>x<\/b>/u);
  assert.match(always(rendered.doc).textContent, /<b>x<\/b>/u);
});

test('Always allow row: absent for a non-primary source, a suggestion, the flag off, no destination project, and a decided offer', () => {
  assert.equal(always(render(lookup(sessionProposal())).doc), null, 'no predicate: never');
  assert.equal(always(renderWith(lookup(sessionProposal()), { isPrimarySession: () => false }).doc), null);
  const own = sessionProposal({ display: { title: 'T', description: 'd', initiation: 'own_initiative', authorization_required: false } });
  assert.equal(always(renderWith(lookup(own), PRIMARY).doc), null);
  assert.equal(always(renderWith(lookup(sessionProposal()), { ...PRIMARY, launchPermissionEnabled: false }).doc), null);
  assert.equal(always(renderWith(lookup(sessionProposal({ options: { ...OPTIONS, destination_project_id: null } })), PRIMARY).doc), null);
  assert.equal(always(renderWith(lookup(accepted('new_session', 'queued')), PRIMARY).doc), null);
  assert.equal(always(renderWith(lookup(null, { status: 'loading', fallback: { title: 'T', initiation: 'offer' } }), PRIMARY).doc), null);
});

test('F3b: the receipt shows the facts the child really got, Retry carries the failed reply, and elapsed follows the child turn', () => {
  const failed = withChild({ phase: 'failed', error_class: 'model_busy', failed_turn_is_first: true, retry: { message_id: 'a_t1' } });
  failed.actions = { do_it_here: NO, new_session: NO, dismiss: NO, cancel: NO, retry: NO };
  const { doc } = render(lookup(failed));
  assert.equal(doc.querySelector('.proposal-session-meta').textContent, 'rise-of-nations · ornith15:9b-q6-256k · Ask');
  const retry = byAction(doc, 'retry-child');
  assert.equal(retry.dataset.proposalChildId, CHILD);
  assert.equal(retry.dataset.proposalMessageId, 'a_t1');
  const started = new Date(Date.now() - 74000).toISOString();
  const running = withChild({ phase: 'running', turn_started_at: started });
  running.actions = failed.actions;
  assert.equal(render(lookup(running)).doc.querySelector('.proposal-elapsed').dataset.elapsedStartedAt, String(Date.parse(started)));
  const unknownStart = withChild({ phase: 'running' });
  unknownStart.actions = failed.actions;
  assert.equal(render(lookup(unknownStart)).doc.querySelector('.proposal-elapsed'), null, 'no elapsed time from the Accept click');
  const plain = accepted('new_session', 'succeeded', { links: { ...LINKS, child_session_id: CHILD } });
  plain.actions = failed.actions;
  assert.equal(render(lookup(plain)).doc.querySelector('.proposal-session-meta'), null, 'no child view, no facts line');
});
