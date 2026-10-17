'use strict';

// The grouped suggestions tray (row 59 checkpoint 5a-2): the header "{n} suggested tasks" plus
// Start all on the FIRST row of a group_id, actionable rows only, Start all hidden at zero, and
// the Start all snapshot taken from the members as they are right now.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const cards = require('../renderer/chat/renderer-proposal-cards');
const group = require('../renderer/chat/renderer-proposal-suggestion-group');

const SID = 'session-1';
const GID = `group_${'a'.repeat(64)}`;
const pid = (c) => `proposal_${c.repeat(64)}`;
const NO = { available: false, reason: null };
const YES = { available: true, reason: null };
const LINKS = { continuation_turn_id: null, continuation_work_id: null, command_tool_call_id: null, child_session_id: null, first_turn_turn_id: null, first_turn_work_id: null, preparation_turn_id: null };
const NOW = Date.parse('2026-10-15T12:00:00Z');
const FUTURE = '2026-10-20T12:00:00Z';

function member(c, overrides = {}) {
  return {
    schema_version: 1, proposal_id: pid(c), revision: 2, kind: 'session', decision_state: 'pending', action_state: 'none',
    created_at: `2026-10-15T10:00:0${c.charCodeAt(0) % 10}Z`, expires_at: FUTURE,
    display: { title: `Task ${c}`, description: `Describe ${c}`, initiation: 'own_initiative', authorization_required: false },
    group_id: GID, options: { destination_project_id: null, preferred_model: null, reasoning_effort: null, run_mode: 'agent' }, options_editable: true,
    decision: null, links: LINKS, execution: null, last_error: null,
    actions: { do_it_here: YES, new_session: YES, dismiss: YES, cancel: NO, retry: NO },
    ...overrides,
  };
}

const started = (c) => member(c, {
  revision: 5, decision_state: 'accepted', action_state: 'succeeded', options_editable: false, links: { ...LINKS, child_session_id: `sess_1_${c.repeat(12)}` },
  decision: { choice: 'new_session', accepted_at: '2026-10-15T10:05:00Z', accepted_revision: 2, options: null },
  actions: { do_it_here: NO, new_session: NO, dismiss: NO, cancel: NO, retry: NO },
});
const failed = (c) => member(c, {
  revision: 5, decision_state: 'accepted', action_state: 'needs_attention', options_editable: false,
  decision: { choice: 'new_session', accepted_at: '2026-10-15T10:05:00Z', accepted_revision: 2, options: null },
  last_error: { code: 'CMP-PROPOSAL-0010', reason: 'preparation_failed', retryable: true, cause_code: 'deadline' },
  actions: { do_it_here: NO, new_session: NO, dismiss: NO, cancel: NO, retry: YES },
});
const dismissed = (c) => member(c, { decision_state: 'dismissed', options_editable: false, actions: { do_it_here: NO, new_session: NO, dismiss: NO, cancel: NO, retry: NO } });

const groupView = (members, extra = {}) => ({ groupId: GID, status: 'ready', members, busy: false, notice: null, ...extra });

function lookupFor(proposal, view) {
  return { status: 'ready', proposal, notice: null, busy: false, acks: [], fallback: null, group: view, optionsOpen: false, capabilities: { status: 'idle', value: null } };
}

function renderRow(proposal, view) {
  const html = cards.buildProposalCardMarkup({ sessionId: SID, proposalId: proposal.proposal_id, kind: 'session', lookup: lookupFor(proposal, view) });
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  return { html, doc, card: doc.querySelector('[data-proposal-id]') };
}

test('only pending, unexpired rows are actionable; the header counts exactly those', () => {
  const expired = member('e', { expires_at: '2026-10-10T00:00:00Z' });
  const view = groupView([member('a'), started('b'), failed('c'), dismissed('d'), expired, member('f')]);
  assert.deepEqual(group.actionableMembers(view, NOW).map((m) => m.proposal_id), [pid('a'), pid('f')]);
  assert.equal(group.countLabel(2), '2 suggested tasks');
  assert.equal(group.countLabel(1), '1 suggested task');
  assert.equal(group.countLabel(0), 'Suggested tasks');
});

test('the first member draws the header with the count and Start all; later members draw none', () => {
  const view = groupView([member('a'), member('b')]);
  const first = renderRow(view.members[0], view);
  const head = first.doc.querySelector('[data-proposal-group]');
  assert.equal(head.dataset.proposalGroup, GID);
  assert.equal(head.dataset.proposalSession, SID);
  assert.equal(head.querySelector('.proposal-group-count').textContent, '2 suggested tasks');
  const startAll = head.querySelector('[data-proposal-action="start-all"]');
  assert.equal(startAll.textContent.trim(), 'Start all');
  assert.equal(startAll.disabled, false);
  assert.ok(startAll.getAttribute('title'));
  const second = renderRow(view.members[1], view);
  assert.equal(second.doc.querySelector('[data-proposal-group]'), null);
  assert.equal(second.doc.querySelector('.proposal-session-title').textContent, 'Task b');
  assert.equal(first.card.querySelector('.proposal-session-title').textContent, 'Task a');
});

test('the header of an unloaded group is absent and every row still renders its own compact row', () => {
  const only = member('a');
  const { doc } = renderRow(only, null);
  assert.equal(doc.querySelector('[data-proposal-group]'), null);
  assert.ok(doc.querySelector('[data-proposal-action="new_session"]'));
});

test('Start all hides when nothing is actionable; started and failed rows stay as history with their links', () => {
  const view = groupView([started('a'), failed('b'), dismissed('c')]);
  const first = renderRow(view.members[0], view);
  assert.equal(first.doc.querySelector('.proposal-group-count').textContent, 'Suggested tasks');
  assert.equal(first.doc.querySelector('[data-proposal-action="start-all"]'), null);
  assert.match(first.doc.querySelector('.proposal-state').textContent, /^Started · Task a$/u);
  assert.ok(first.doc.querySelector('[data-proposal-action="open-child"]'));
  const second = renderRow(view.members[1], view);
  assert.equal(second.doc.querySelector('.proposal-state').textContent, "Couldn't prepare the new chat");
  assert.ok(second.doc.querySelector('[data-proposal-action="retry"]'));
  assert.equal(second.doc.querySelector('[data-proposal-action="new_session"]'), null);
});

test('Start all is disabled (not hidden) while the group is busy or no pending row can start', () => {
  const busy = renderRow(member('a'), groupView([member('a')], { busy: true }));
  assert.equal(busy.doc.querySelector('[data-proposal-action="start-all"]').disabled, true);
  assert.equal(busy.doc.querySelector('[data-proposal-group]').getAttribute('aria-busy'), 'true');
  const blocked = member('a', { actions: { do_it_here: YES, new_session: { available: false, reason: 'unsupported_capability' }, dismiss: YES, cancel: NO, retry: NO } });
  const stuck = renderRow(blocked, groupView([blocked]));
  assert.equal(stuck.doc.querySelector('[data-proposal-action="start-all"]').disabled, true);
  assert.equal(stuck.doc.querySelector('.proposal-group-count').textContent, '1 suggested task');
});

test('a group notice shows under the header as a polite status', () => {
  const view = groupView([member('a')], { notice: { text: "Some suggestions didn't start. Each one shows why." } });
  const { doc } = renderRow(view.members[0], view);
  const notice = doc.querySelector('.proposal-group-head .proposal-notice');
  assert.equal(notice.getAttribute('role'), 'status');
  assert.match(notice.textContent, /Some suggestions didn't start/u);
});

test('the Start all snapshot holds the pending rows that can start, with their revisions, at call time', () => {
  const view = groupView([member('a', { revision: 4 }), started('b'), member('c', { revision: 7 }), dismissed('d'),
    member('e', { actions: { do_it_here: YES, new_session: NO, dismiss: YES, cancel: NO, retry: NO } })]);
  const items = group.snapshotItems(view, NOW);
  assert.deepEqual(items, [{ proposal_id: pid('a'), expected_revision: 4 }, { proposal_id: pid('c'), expected_revision: 7 }]);
  assert.equal(group.snapshotSignature(items), `${pid('a')}@4,${pid('c')}@7`);
  // A later change produces a different snapshot (and so a different decision id in the store).
  view.members[0] = member('a', { revision: 5 });
  assert.notEqual(group.snapshotSignature(group.snapshotItems(view, NOW)), group.snapshotSignature(items));
});

test('the snapshot never exceeds ten rows and an expired row is excluded', () => {
  const many = 'abcdefghijkl'.split('').map((c) => member(c));
  assert.equal(group.snapshotItems(groupView(many), NOW).length, 10);
  assert.deepEqual(group.snapshotItems(groupView([member('a', { expires_at: '2026-10-01T00:00:00Z' })]), NOW), []);
});

test('model text in a suggestion is escaped in the row and the header never carries it', () => {
  const evil = member('a', { display: { title: '<img src=x onerror=alert(1)>', description: '"><script>x()</script>', initiation: 'own_initiative', authorization_required: false } });
  const { html, doc } = renderRow(evil, groupView([evil]));
  assert.doesNotMatch(html, /<img src=x/u);
  assert.doesNotMatch(html, /<script>/u);
  assert.equal(doc.querySelector('.proposal-session-title').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(doc.querySelector('.proposal-group-head').textContent.includes('img'), false);
});

test('isFirstMember reads the store order (oldest first) and tolerates an empty or missing group', () => {
  assert.equal(group.isFirstMember(null, pid('a')), false);
  assert.equal(group.isFirstMember(groupView([]), pid('a')), false);
  assert.equal(group.isFirstMember(groupView([member('a'), member('b')]), pid('a')), true);
  assert.equal(group.isFirstMember(groupView([member('a'), member('b')]), pid('b')), false);
});
