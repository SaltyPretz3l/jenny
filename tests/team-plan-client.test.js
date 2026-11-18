'use strict';

// new-test-file: tests/team-ipc-contract.test.js is at its 599-line cap and tests/team-project-conversations.test.js at
// 599. Row 175 items 7 and D14 on the member side, with no host: main checks `plan_mode` on conversationPreferences and
// `plan_decision` / `feedback` on conversationDecide (ipc-methods.js), and project-conversations.js sends them to the
// host exactly as given.

const assert = require('node:assert/strict');
const test = require('node:test');

const { validatePayload } = require('../services/team/ipc-methods');
const { createProjectConversations } = require('../services/team/project-conversations');
const { fakeTimers } = require('./helpers/team-project-client-host');

const TEAM = 'team_a';
const S = 'sess_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const decide = { team_id: TEAM, session_id: S, stream_id: 's1', approval_id: 'a1', decision_revision: 'r1', approved: true };
const snapshot = { ok: true, snapshot: { cursor: 1, session: { session_id: S, title: 'T', revision: 'boot:1', plan_mode: false },
  messages: [], message_count: 0, has_more: false, active_turn: null, pending_approvals: [], pending_questions: [] } };

test('main checks plan_mode and the plan decision fields; anything else is refused before a host request', () => {
  const good = [
    ['conversationPreferences', { team_id: TEAM, session_id: S, plan_mode: true }],
    ['conversationPreferences', { team_id: TEAM, session_id: S, plan_mode: false, reasoning_effort: 'low' }],
    ['conversationDecide', { ...decide, plan_decision: 'accepted' }],
    ['conversationDecide', { ...decide, plan_decision: 'rejected', feedback: 'Split step two.\nThen test.' }],
    ['conversationDecide', { ...decide, plan_decision: 'approved', feedback: 'x'.repeat(800) }],
  ];
  for (const [method, payload] of good) assert.equal(validatePayload(method, payload).ok, true, `${method} ${JSON.stringify(payload).slice(0, 80)}`);
  const bad = [
    ['conversationPreferences', { team_id: TEAM, session_id: S, plan_mode: 'on' }],
    ['conversationPreferences', { team_id: TEAM, session_id: S }],
    ['conversationDecide', { ...decide, plan_decision: 'approved_auto' }],
    ['conversationDecide', { ...decide, approved: false, plan_decision: 'rejected' }],
    ['conversationDecide', { ...decide, plan_decision: 'accepted', always: 'ask' }],
    ['conversationDecide', { ...decide, feedback: 'no decision' }],
    ['conversationDecide', { ...decide, plan_decision: 'rejected', feedback: 'x'.repeat(801) }],
    ['conversationDecide', { ...decide, plan_decision: 'rejected', feedback: 7 }],
  ];
  for (const [method, payload] of bad) assert.equal(validatePayload(method, payload).ok, false, `${method} ${JSON.stringify(payload).slice(0, 80)}`);
});

test('the plan decision and feedback reach approval.resolve, and plan_mode reaches sessions.preferences, only when given', async () => {
  const sent = [];
  const answers = { 'sessions.snapshot': snapshot, 'session.view': { ok: true, viewing: true, viewers: [] },
    'control.acquire': { ok: true, lease: { session_id: S, client_id: 'client_me', generation: 1, member_id: 'member_me', expires_at: 1 } } };
  const manager = { command: async (operation, params) => {
    sent.push({ operation, params });
    return answers[operation] ?? { ok: true, revision: 'boot:2' };
  } };
  const conv = createProjectConversations({ manager, teamId: TEAM, online: () => true, timers: fakeTimers() });
  const feedback = 'Split step two.';
  await conv.call('conversationDecide', { ...decide, plan_decision: 'rejected', feedback });
  await conv.call('conversationDecide', { ...decide, plan_decision: 'accepted' });
  await conv.call('conversationDecide', decide);
  assert.deepEqual(sent.filter((one) => one.operation === 'approval.resolve').map((one) => one.params), [
    { stream_id: 's1', approval_id: 'a1', decision_revision: 'r1', approved: true, plan_decision: 'rejected', feedback },
    { stream_id: 's1', approval_id: 'a1', decision_revision: 'r1', approved: true, plan_decision: 'accepted' },
    { stream_id: 's1', approval_id: 'a1', decision_revision: 'r1', approved: true },
  ]);
  await conv.call('conversationOpen', { session_id: S });
  await conv.call('conversationPreferences', { team_id: TEAM, session_id: S, plan_mode: false });
  await conv.call('conversationPreferences', { team_id: TEAM, session_id: S, reasoning_effort: 'high' });
  assert.deepEqual(sent.filter((one) => one.operation === 'sessions.preferences').map((one) => one.params),
    [{ plan_mode: false }, { reasoning_effort: 'high' }]);
  conv.stop();
});
