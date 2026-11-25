'use strict';

// new-test-file: team review fixes (C9.3, C10.1, H1/OD-2 UI) for the conversation surface: the sibling suites
// renderer-team-projects-conversation.test.js and -chat.test.js are at their line caps. Per-instance DOM ids and the
// root cleared on dispose, roving tabindex on the rows with the toolbar reachable from the focused row, and the
// approval card without its always buttons while the project's rules are paused.

const test = require('node:test');
const assert = require('node:assert/strict');

const { P1, S1, OTHER, DOT, MAYA, LENA, message, approval, snapshot, flush } = require('./helpers/team-project-renderer-host');
const { mount } = require('./helpers/team-conversation-mount');

const NAMES = { [DOT]: 'Dot', [MAYA]: 'Maya', [LENA]: 'Lena' };
const key = (m, el, k, extra = {}) => { el.focus(); el.dispatchEvent(new m.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra })); };
const click = (m, el) => el.dispatchEvent(new m.window.MouseEvent('click', { bubbles: true, cancelable: true }));

// A second conversation in the same document as `m` (the Team tab's hidden one and the Board's column at once).
function addInstance(m, t, open) {
  const { createConversation } = require('../renderer/team/renderer-team-project-conversation');
  const root = m.window.document.createElement('div');
  m.window.document.body.appendChild(root);
  const store = { call: (method) => Promise.resolve(method === 'conversationOpen' ? open : { ok: true }), project: () => ({ id: P1, name: 'jenny-site', role: 'writer' }), conversationsOf: () => [] };
  const conv = createConversation({ root, teamId: OTHER, projectId: P1, sessionId: S1, store,
    ctx: () => ({ team: { team_id: OTHER, team_name: 'Dot lab', state: 'online', member_id: DOT, role: 'member' }, nameOf: (id) => NAMES[id] || 'Former member', errorText: () => 'error' }) });
  t.after(() => conv.dispose());
  return { conv, root, q: (s) => root.querySelector(s) };
}

const planWaiting = () => ({ ok: true, snapshot: snapshot({ session: { session_id: S1, title: 'T', revision: 'r1', plan_mode: true },
  messages: [message('u1', 'user', 'Plan it', { author: { kind: 'member', member_id: MAYA }, turn_id: 'turn_1' }),
    message('plan_1', 'assistant', 'Update the hero', { kind: 'plan_document', turn_id: 'turn_1', plan_document: { plan_id: 'plan_1', tool_call_id: 'call_plan', approval_id: 'appr_plan',
      title: 'Update the hero', summary: 'Two templates.', steps: ['one', 'two'], verification: 'build', files_read: [], state: 'pending' } })],
  active_turn: { stream_id: 'stream_1', turn_id: 'turn_1', user_message_id: 'u1', status: 'running' },
  pending_approvals: [approval({ approval_id: 'appr_plan', tool_name: 'exit_plan_mode', call_id: 'call_plan', summary: 'Update the hero' })] }) });

test('C9.3: two conversations in one document keep their own box and hint ids, their ARIA references and their Keep planning field; dispose clears the root', async (t) => {
  const m = mount(t, { open: planWaiting() });
  const other = addInstance(m, t, planWaiting());
  await flush();
  const doc = m.window.document;
  const fields = [m.q('textarea.team-composer__input'), other.q('textarea.team-composer__input')];
  assert.notEqual(fields[0].id, fields[1].id, 'each box has its own id');
  for (const [i, root] of [m.root, other.root].entries()) {
    assert.equal(doc.getElementById(fields[i].id), fields[i], 'the id names this box alone');
    const hint = root.querySelector('.team-composer__hint');
    assert.equal(fields[i].getAttribute('aria-describedby'), hint.id, 'the box is described by its own hint');
    assert.equal(doc.getElementById(hint.id), hint, 'and the hint id is unique in the document');
  }
  // Keep planning in the first, then in the second: the field that opens and takes the focus is the clicked conversation's own.
  click(m, m.q('[data-project-action="plan-keep"]'));
  const first = m.q('textarea[id$="teamPlanFeedback"]');
  assert.ok(first && doc.activeElement === first, 'the first conversation focuses its own field');
  click(m, other.q('[data-project-action="plan-keep"]'));
  const second = other.q('textarea[id$="teamPlanFeedback"]');
  assert.ok(second && first.id !== second.id, 'the second field has its own id');
  assert.equal(doc.activeElement, second, 'the focus goes to the second conversation’s field, not the first one’s');
  m.conv.dispose();
  other.conv.dispose();
  assert.equal(m.root.innerHTML, '', 'dispose clears the first root');
  assert.equal(other.root.innerHTML, '', 'and the second');
});

const THREE = [message('m1', 'user', 'Why twice?', { author: { kind: 'member', member_id: DOT } }), message('m2', 'assistant', 'It reads it once in **load**.')];

test('C10.1: the rows are one tab stop with arrows, Home and End; the toolbar buttons are reachable from the focused row; a redraw keeps the stop and the focus', async (t) => {
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ messages: THREE }) } });
  await flush();
  const rows = () => [...m.root.querySelectorAll('.team-msg')];
  const stops = () => rows().filter((row) => row.tabIndex === 0);
  assert.equal(rows().length, 2);
  assert.deepEqual(stops().map((row) => row.dataset.turnId || row.dataset.messageId), ['after:m1'], 'one tab stop: the last row');
  const buttons = [...m.root.querySelectorAll('.team-acts button')];
  assert.ok(buttons.length >= 2, 'Copy on both rows and Show work on Jenny’s');
  assert.ok(buttons.every((button) => button.getAttribute('tabindex') !== '-1'), 'the toolbar buttons are tab stops of their focused row');
  key(m, rows()[1], 'ArrowUp');
  assert.equal(m.window.document.activeElement, rows()[0], 'ArrowUp moves to the row above');
  assert.deepEqual(stops().map((row) => row.dataset.messageId), ['m1'], 'and takes the tab stop');
  key(m, rows()[0], 'End');
  assert.equal(m.window.document.activeElement, rows()[1]);
  key(m, rows()[1], 'Home');
  assert.equal(m.window.document.activeElement, rows()[0]);
  m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot({ messages: [...THREE, message('m3', 'user', 'And again?', { author: { kind: 'member', member_id: DOT } })] }) });
  assert.equal(stops().length, 1, 'still one tab stop after a message arrived');
  assert.equal(stops()[0].dataset.messageId, 'm1', 'the row the reader was on keeps it');
  assert.equal(m.window.document.activeElement, stops()[0], 'and the focus stays on it');
});

const writeApproval = () => ({ ok: true, snapshot: snapshot({ pending_approvals: [approval({ tool_name: 'write_file' })] }) });
const buttonsOf = (m) => [...m.root.querySelectorAll('.tool-approval-block .tool-approve-btn, .tool-approval-block .tool-deny-btn')].map((b) => b.getAttribute('data-team-always') || b.getAttribute('data-approval-scope') || 'deny');

test('OD-2: while the rules are paused an approval card has only the one-off answers; unpaused it has the always button', async (t) => {
  const paused = mount(t, { role: 'admin', open: writeApproval(), answers: { projectRules: { ok: true, project_id: P1, revision: 1, rules: [], open_request_count: 0, requests: [], paused: 'file_tools' } } });
  await flush();
  assert.deepEqual(buttonsOf(paused), ['once', 'deny'], 'no Always allow while paused');
  assert.equal(paused.q('.tool-approval-scope-note'), null, 'and no note about a rule');
  const writer = mount(t, { role: 'writer', open: writeApproval(), answers: { projectRules: { ok: true, project_id: P1, revision: 1, rules: [], open_request_count: 0, requests: [], paused: 'file_tools' } } });
  await flush();
  assert.deepEqual(buttonsOf(writer), ['once', 'deny'], 'no Allow once, ask for always for a writer either');
  const free = mount(t, { role: 'admin', open: writeApproval(), answers: { projectRules: { ok: true, project_id: P1, revision: 1, rules: [], open_request_count: 0, requests: [] } } });
  await flush();
  assert.deepEqual(buttonsOf(free), ['once', 'rule', 'deny'], 'not paused: the always button is back');
});

test('OD-2: a rules read that fails keeps the always buttons away (fail closed); a later read that says unpaused brings them back', async (t) => {
  let answer = { ok: false, error: { reason: 'team_offline' } };
  const m = mount(t, { role: 'admin', open: writeApproval(), answers: { projectRules: () => answer } });
  await flush();
  assert.deepEqual(buttonsOf(m), ['once', 'deny'], 'the paused state is unknown: one-off answers only');
  answer = { ok: true, project_id: P1, revision: 1, rules: [], open_request_count: 0, requests: [] };
  m.advance(60_000);
  m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot({ pending_approvals: [approval({ tool_name: 'write_file' })], cursor: 2 }) });
  await flush();
  assert.deepEqual(buttonsOf(m), ['once', 'rule', 'deny'], 'read again and not paused');
});

const TURN = () => ({ ok: true, snapshot: snapshot({ messages: [message('u1', 'user', 'Why twice?', { author: { kind: 'member', member_id: DOT }, turn_id: 'turn_1' }),
  message('a1', 'assistant', 'It reads it once.', { turn_id: 'turn_1' })] }) });

test('C9.3: two conversations with their Tools panel, model popover, rename field and turn popover open make no duplicate id, and each ARIA reference names its own element', async (t) => {
  const m = mount(t, { open: TURN() });
  const other = addInstance(m, t, TURN());
  await flush();
  const doc = m.window.document;
  for (const view of [m, other]) {
    click(m, view.q('[data-project-action="rename"]'));
    click(m, view.q('.team-turn-chip'));
    click(m, view.q('.composer-model-pill'));
    click(m, view.q('.composer-tools-chip'));
  }
  const seen = new Map();
  for (const el of doc.querySelectorAll('[id]')) seen.set(el.id, (seen.get(el.id) || 0) + 1);
  assert.deepEqual([...seen].filter(([id, n]) => n > 1).map(([id]) => id), [], 'no id appears twice in the document');
  for (const [i, view] of [m, other].entries()) {
    for (const id of ['teamConvToolsChip', 'teamConvModelPill', 'teamTurnPop', 'teamConversationTitle']) assert.equal(view.root.querySelectorAll('[id$="' + id + '"]').length, 1, id + ' exists once in conversation ' + i);
    for (const attr of ['aria-controls', 'aria-labelledby', 'aria-describedby']) {
      for (const el of view.root.querySelectorAll('[' + attr + ']')) {
        for (const id of el.getAttribute(attr).split(/\s+/).filter(Boolean)) {
          assert.ok(view.root.querySelector('[id="' + id + '"]'), attr + ' "' + id + '" names an element inside its own conversation');
        }
      }
    }
  }
});
