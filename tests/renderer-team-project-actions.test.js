'use strict';

// new-test-file: renderer/team/renderer-team-project-actions.js, a new module (row 175 items 5, 6, 9, 11 placement, F13,
// F18; D7, D8): the message menu on a project conversation's rows (right-click, the Menu key, Shift+F10), Regenerate with
// its confirm, Edit and resend in the row, Branch, Ask a teammate (the head and an approval card), Hand to… and the
// lease taken up on the other side, and host receipts placed under their turn. The conversation mounted alone.

const test = require('node:test');
const assert = require('node:assert/strict');

const { P1, S1, S2, OTHER, DOT, MAYA, LENA, message, approval, snapshot, members } = require('./helpers/team-project-renderer-host');
const { flush } = require('./helpers/team-settings-harness');
const { mount } = require('./helpers/team-conversation-mount');

// The inventory menu, faked: what each show() was handed.
function fakeMenu(t) {
  const shown = [];
  const saved = globalThis.inventoryContextMenu;
  // As the real one: a new menu hides the one before (its onHide runs).
  const hideLast = () => { const last = shown[shown.length - 1]; if (last && !last.hidden && last.onHide) { last.hidden = true; last.onHide(); } };
  globalThis.inventoryContextMenu = { show: (opts) => { hideLast(); shown.push(opts); }, hide: hideLast };
  t.after(() => { if (saved === undefined) delete globalThis.inventoryContextMenu; else globalThis.inventoryContextMenu = saved; });
  return shown;
}
const mine = (id = 'm1', who = DOT) => message(id, 'user', 'Why twice?', { author: { kind: 'member', member_id: who } });
const withMessages = (list, over = {}) => ({ ok: true, snapshot: snapshot({ messages: list, ...over }) });
const values = (opts) => opts.items.map((i) => (i.separator ? '-' : i.value));
const item = (opts, value) => opts.items.find((i) => i.value === value);
const rowOf = (m, attr, id) => [...m.root.querySelectorAll('.team-msg')].find((el) => el.dataset[attr] === id);
function rightClick(m, el) { el.dispatchEvent(new m.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 6 })); }
function key(m, el, k, extra = {}) { el.focus(); el.dispatchEvent(new m.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra })); }
const toast = (m) => [...m.root.querySelectorAll('.team-copied')].map((el) => el.textContent).join(' ');

test('message menu on a conversation row: right-click, the Menu key and Shift+F10 open it with the items; a reader gets them greyed with reasons', async (t) => {
  const shown = fakeMenu(t);
  const m = mount(t, { open: withMessages([mine('m1', MAYA), message('m2', 'assistant', 'It reads it once in **load**.')]) });
  await flush();
  rightClick(m, rowOf(m, 'messageId', 'm1').querySelector('.team-msg__text'));
  assert.equal(shown.length, 1, 'a right-click on a prompt row opens the menu');
  assert.deepEqual(values(shown[0]), ['copy', 'copy-markdown', 'work', 'copy-link', 'copy-source', '-', 'branch', 'regenerate', 'edit'], 'no Pin to board item: it was never available');
  assert.equal(item(shown[0], 'branch').disabled, undefined, 'a writer may branch');
  assert.match(item(shown[0], 'regenerate').description, /who asked, or a project admin/, 'not the author: greyed with its reason');
  assert.match(item(shown[0], 'edit').description, /who asked can edit/);
  assert.equal(shown[0].items.filter((i) => i.disabled && !i.description).length, 0, 'every greyed item says why');
  const closeMenu = () => globalThis.inventoryContextMenu.hide();
  closeMenu();
  key(m, rowOf(m, 'turnId', 'after:m1'), 'ContextMenu');
  closeMenu();
  key(m, rowOf(m, 'turnId', 'after:m1'), 'F10', { shiftKey: true });
  closeMenu();
  assert.equal(shown.length, 3, 'the Menu key and Shift+F10 on a focused row');
  assert.deepEqual(values(shown[1]), values(shown[0]), 'Jenny’s row offers the same, its turn’s prompt being the latest');
  key(m, rowOf(m, 'turnId', 'after:m1'), 'F10');
  assert.equal(shown.length, 3, 'F10 alone opens nothing');

  const reader = mount(t, { role: 'reader', open: withMessages([mine('m1', DOT), message('m2', 'assistant', 'ok')]) });
  await flush();
  rightClick(reader, rowOf(reader, 'messageId', 'm1'));
  const menu = shown[3];
  for (const value of ['branch', 'regenerate', 'edit']) assert.match(item(menu, value).description, /Only writers and admins/, value + ' greyed for a reader');
  assert.equal(item(menu, 'copy').disabled, undefined, 'a reader may copy');
});

test('copy, copy as Markdown, copy link and copy with source write the clipboard; Show Jenny’s work opens the popover', async (t) => {
  const shown = fakeMenu(t);
  const wrote = [];
  const m = mount(t, { clipboard: { writeText: async (text) => { wrote.push(text); } }, open: withMessages([mine('m1', MAYA), message('m2', 'assistant', 'It reads it once in **load**.')]) });
  await flush();
  rightClick(m, rowOf(m, 'turnId', 'after:m1'));
  for (const value of ['copy', 'copy-markdown', 'copy-link', 'copy-source']) { item(shown[0], value).action(); await flush(); }
  assert.deepEqual(wrote.slice(0, 2), ['It reads it once in load.', 'It reads it once in **load**.']);
  assert.equal(wrote[2], 'jenny-team:' + OTHER + '/conv/' + S1 + '/m2', 'a conversation link to the saved answer');
  assert.match(wrote[3], /^> \*\*Jenny\*\*, jenny-site, 2026-11-12\n> It reads it once in \*\*load\*\*\.$/);
  assert.match(toast(m), /Copied with source/);
  item(shown[0], 'work').action();
  assert.ok(m.q('[id$="teamTurnPop"]'), 'the turn’s popover opened');
});

test('Regenerate on the latest prompt: the confirm names the replaced answer, then projectRegenerate and the control take', async (t) => {
  const shown = fakeMenu(t);
  const m = mount(t, { answers: { projectRegenerate: { ok: true, session_id: S1, stream_id: 'stream_9', revision: 'r2' } },
    open: withMessages([mine('m0'), message('a0', 'assistant', 'first'), mine('m1'), message('m2', 'assistant', 'second')]) });
  await flush();
  rightClick(m, rowOf(m, 'messageId', 'm0'));
  assert.equal(item(shown[0], 'regenerate'), undefined, 'an earlier prompt offers no redo');
  rightClick(m, rowOf(m, 'messageId', 'm1'));
  item(shown[1], 'regenerate').action();
  const panel = m.q('[data-conv-act-panel="redo"]');
  assert.match(panel.textContent, /The current answer is replaced\. Branch from here first to keep it\./);
  assert.ok(panel.querySelector('[data-conv-act="redo-branch"]'), 'Branch first is offered');
  assert.equal(m.sent('projectRegenerate').length, 0, 'nothing sent before the confirm');
  panel.querySelector('[data-conv-act="redo-go"]').click();
  await flush();
  assert.deepEqual(m.sent('projectRegenerate'), [{ team_id: OTHER, project_id: P1, session_id: S1, message_id: 'm1' }]);
  assert.deepEqual(m.sent('conversationControl'), [{ team_id: OTHER, session_id: S1, action: 'take' }]);
  const order = m.calls.map((c) => c.method).filter((name) => name === 'projectRegenerate' || name === 'conversationControl');
  assert.deepEqual(order, ['projectRegenerate', 'conversationControl'], 'the take follows the ok answer');
  assert.equal(m.q('[data-conv-act-panel]'), null, 'the confirm goes');
});

test('a refused regenerate says why in the confirm and takes no lease', async (t) => {
  const shown = fakeMenu(t);
  const m = mount(t, { answers: { projectRegenerate: { ok: false, error: { reason: 'disk_pressure' } } }, open: withMessages([mine('m1'), message('m2', 'assistant', 'x')]) });
  await flush();
  rightClick(m, rowOf(m, 'messageId', 'm1'));
  item(shown[0], 'regenerate').action();
  m.q('[data-conv-act="redo-go"]').click();
  await flush();
  assert.ok(m.q('[data-conv-act-panel="redo"] [role="status"]').textContent.length > 0, 'the refusal’s sentence');
  assert.equal(m.sent('conversationControl').length, 0);
});

test('Edit and resend: only for the author; the edited text is sent, capped as the message box caps it; Esc cancels', async (t) => {
  const shown = fakeMenu(t);
  const m = mount(t, { answers: { projectEditResend: { ok: true, session_id: S1, revision: 'r2' } }, open: withMessages([mine('m1'), message('m2', 'assistant', 'x')]) });
  await flush();
  rightClick(m, rowOf(m, 'messageId', 'm1'));
  item(shown[0], 'edit').action();
  const field = m.q('[data-conv-act-panel="edit"] textarea');
  assert.equal(field.value, 'Why twice?');
  assert.equal(field.maxLength, require('../renderer/team/renderer-team-project-box').PROMPT_MAX, 'the box’s own limit, not a smaller one');
  key(m, field, 'Escape');
  assert.equal(m.q('[data-conv-act-panel]'), null, 'Esc closes the editor');
  rightClick(m, rowOf(m, 'messageId', 'm1'));
  item(shown[1], 'edit').action();
  const again = m.q('[data-conv-act-panel="edit"] textarea');
  again.value = 'Why three times?';
  again.dispatchEvent(new m.window.Event('input', { bubbles: true }));
  m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot({ messages: [mine('m1'), message('m2', 'assistant', 'x, redrawn')] }) });
  assert.equal(m.q('[data-conv-act-panel="edit"] textarea').value, 'Why three times?', 'a redraw keeps the editor and its text');
  m.q('[data-conv-act="edit-save"]').click();
  await flush();
  assert.deepEqual(m.sent('projectEditResend'), [{ team_id: OTHER, project_id: P1, session_id: S1, message_id: 'm1', prompt: 'Why three times?' }]);
  assert.deepEqual(m.sent('conversationControl'), [{ team_id: OTHER, session_id: S1, action: 'take' }]);

  const other = mount(t, { open: withMessages([mine('m1', MAYA), message('m2', 'assistant', 'x')]) });
  await flush();
  rightClick(other, rowOf(other, 'messageId', 'm1'));
  assert.equal(item(shown[2], 'edit').disabled, true, 'another member’s question cannot be edited');
});

test('Edit and resend sends a question longer than 32,000 characters up to the box’s limit, and says too long past it', async (t) => {
  const shown = fakeMenu(t);
  const { PROMPT_MAX } = require('../renderer/team/renderer-team-project-box');
  const m = mount(t, { answers: { projectEditResend: { ok: true, session_id: S1, revision: 'r2' } }, open: withMessages([mine('m1'), message('m2', 'assistant', 'x')]) });
  await flush();
  rightClick(m, rowOf(m, 'messageId', 'm1'));
  item(shown[0], 'edit').action();
  const field = m.q('[data-conv-act-panel="edit"] textarea');
  field.value = 'q'.repeat(PROMPT_MAX + 1);
  field.dispatchEvent(new m.window.Event('input', { bubbles: true }));
  m.q('[data-conv-act="edit-save"]').click();
  await flush();
  assert.equal(m.sent('projectEditResend').length, 0, 'one past the limit is not sent');
  assert.match(m.q('[data-conv-act-panel="edit"] [role="status"]').textContent, /too long/);
  const again = m.q('[data-conv-act-panel="edit"] textarea');
  again.value = 'q'.repeat(PROMPT_MAX);
  again.dispatchEvent(new m.window.Event('input', { bubbles: true }));
  m.q('[data-conv-act="edit-save"]').click();
  await flush();
  assert.deepEqual(m.sent('projectEditResend').map((p) => p.prompt.length), [PROMPT_MAX], 'the whole limit goes');
});

test('Branch from here opens the new conversation', async (t) => {
  const shown = fakeMenu(t);
  const asked = [];
  const saved = globalThis.rendererTeamNotify;
  globalThis.rendererTeamNotify = { request: (intent) => { asked.push(intent); return true; } };
  t.after(() => { if (saved === undefined) delete globalThis.rendererTeamNotify; else globalThis.rendererTeamNotify = saved; });
  const m = mount(t, { answers: { projectBranch: { ok: true, session_id: S2, revision: 'r1' } }, open: withMessages([mine('m1', MAYA), message('m2', 'assistant', 'x')]) });
  await flush();
  rightClick(m, rowOf(m, 'turnId', 'after:m1'));
  item(shown[0], 'branch').action();
  await flush();
  assert.deepEqual(m.sent('projectBranch'), [{ team_id: OTHER, project_id: P1, session_id: S1, message_id: 'm2' }]);
  assert.deepEqual(asked, [{ kind: 'conversation', teamId: OTHER, sessionId: S2, projectId: P1 }]);
});

test('Branch from here in Board stays there: onOpenConversation returning true skips the Team tab hand-off (H23.4)', async (t) => {
  const shown = fakeMenu(t);
  const asked = [];
  const saved = globalThis.rendererTeamNotify;
  globalThis.rendererTeamNotify = { request: (intent) => { asked.push(intent); return true; } };
  t.after(() => { if (saved === undefined) delete globalThis.rendererTeamNotify; else globalThis.rendererTeamNotify = saved; });
  const opened = [];
  let result = true;
  const m = mount(t, { board: { onOpenConversation: (id) => { opened.push(id); return result; } }, answers: { projectBranch: { ok: true, session_id: S2, revision: 'r1' } }, open: withMessages([mine('m1', MAYA), message('m2', 'assistant', 'x')]) });
  await flush();
  rightClick(m, rowOf(m, 'turnId', 'after:m1'));
  item(shown[0], 'branch').action();
  await flush();
  assert.deepEqual(opened, [S2], 'Board is asked to open the branch');
  assert.deepEqual(asked, [], 'it opened there, so the Team tab is not asked');
  result = false;
  item(shown[0], 'branch').action();
  await flush();
  assert.equal(asked.length, 1, 'Board declined: the Team tab hand-off is the fallthrough');
});

test('Ask a teammate from an approval card sends approval_id and lists the project’s members minus yourself; the head asks too', async (t) => {
  const shown = fakeMenu(t);
  const m = mount(t, { answers: { projectMembers: members([[DOT, 'writer'], [MAYA, 'reader'], [LENA, 'admin']]), projectAskTeammate: { ok: true } },
    open: withMessages([mine('m1'), message('m2', 'assistant', 'x')], { pending_approvals: [approval()] }) });
  await flush();
  const button = m.q('.tool-approval-block [data-conv-act="ask"]');
  assert.ok(button, 'the card has Ask a teammate');
  button.click();
  await flush();
  assert.deepEqual(m.sent('projectMembers'), [{ team_id: OTHER, project_id: P1 }]);
  assert.deepEqual(shown[0].items.map((i) => i.label), ['⁨Maya⁩', '⁨Lena⁩'], 'readers count, yourself does not; names isolated');
  shown[0].items[0].action();
  await flush();
  assert.deepEqual(m.sent('projectAskTeammate'), [{ team_id: OTHER, project_id: P1, session_id: S1, member_id: MAYA, approval_id: 'appr_1' }]);
  assert.match(toast(m), /Asked Maya/);
  assert.equal(m.sent('conversationDecide').length, 0, 'the card’s own buttons were not pressed');
  m.q('.team-head [data-conv-act="ask"]').click();
  await flush();
  shown[1].items[1].action();
  await flush();
  assert.deepEqual(m.sent('projectAskTeammate')[1], { team_id: OTHER, project_id: P1, session_id: S1, member_id: LENA }, 'from the head: no approval');
});

test('Hand to… lists the viewers who can write; the member it names takes the lease up on control_changed', async (t) => {
  const shown = fakeMenu(t);
  const m = mount(t, { answers: { projectMembers: members([[DOT, 'writer'], [MAYA, 'reader'], [LENA, 'writer']]), projectHandDriver: { ok: true, member_id: LENA } },
    open: withMessages([mine('m1'), message('m2', 'assistant', 'x')], { control: { member_id: DOT, expires_at: 0 }, viewers: [DOT, MAYA, LENA] }) });
  await flush();
  assert.match(m.q('.team-head__sub').textContent, /You are driving · Maya, Lena and you viewing/);
  const hand = m.q('.team-head [data-conv-act="hand"]');
  assert.equal(hand.disabled, false, 'the driver may hand the seat on');
  hand.click();
  await flush();
  assert.deepEqual(shown[0].items.map((i) => i.label), ['⁨Lena⁩'], 'a reader and yourself are not offered');
  shown[0].items[0].action();
  await flush();
  assert.deepEqual(m.sent('projectHandDriver'), [{ team_id: OTHER, project_id: P1, session_id: S1, member_id: LENA }]);

  const target = mount(t, { open: withMessages([mine('m1'), message('m2', 'assistant', 'x')], { control: { member_id: MAYA, expires_at: 0 } }) });
  await flush();
  assert.equal(target.q('.team-head [data-conv-act="hand"]').disabled, true, 'not driving: greyed');
  assert.match(target.q('.team-head [data-conv-act="hand"]').title, /driving/);
  target.event('control_changed', { member_id: DOT, client_id: 'client_a', generation: 3, expires_at: target.now() + 60_000 });
  await flush();
  // Main pushes `lease` held for this client's own take; none came, so after the wait the seat reads as handed.
  target.advance(1_500);
  await flush();
  assert.deepEqual(target.sent('conversationControl'), [{ team_id: OTHER, session_id: S1, action: 'take' }]);
  assert.match(toast(target), /You are driving now/);

  // This client's own take answers with a `lease` push: no hand-off, no second take, no toast.
  const own = mount(t, { open: withMessages([mine('m1'), message('m2', 'assistant', 'x')], { control: { member_id: MAYA, expires_at: 0 } }) });
  await flush();
  own.event('control_changed', { member_id: DOT, client_id: 'client_a', generation: 4, expires_at: own.now() + 60_000 });
  own.conv.push({ kind: 'lease', session_id: S1, held: true });
  own.advance(1_500);
  await flush();
  assert.deepEqual(own.sent('conversationControl'), []);
});

test('receipts with call_id sit under their turn; the client’s copy of the same decision is not drawn twice', async (t) => {
  const tool = (id, turn) => message(id, 'assistant', '', { kind: 'tool_use', turn_id: turn, tool_call: { call_id: 'call_' + id, tool_name: 'edit_file', input_json: '{}', status: 'complete' } });
  const receipt = (over) => ({ seq: 1, session_id: S1, outcome: 'allowed', tool_name: 'edit_file', approver_member_id: MAYA, prompter_member_id: DOT, decided_at: '2026-11-12T10:32:00.000Z', ...over });
  const m = mount(t, { open: withMessages([mine('m1', DOT), tool('t1', 'turn_1'), message('a1', 'assistant', 'one', { turn_id: 'turn_1' }),
    mine('m3', DOT), tool('t3', 'turn_3'), message('a3', 'assistant', 'two', { turn_id: 'turn_3' })].map((x, i) => (x.role === 'user' ? { ...x, turn_id: i < 3 ? 'turn_1' : 'turn_3' } : x)),
  { receipts: [receipt({ call_id: 'call_t1', approval_id: 'approval_x_s_call_t1' }), receipt({ seq: 2, outcome: 'answered', call_id: 'call_t3', approver_member_id: LENA })] }) });
  await flush();
  const under = (turn) => rowOf(m, 'turnId', turn).querySelector('.team-conv__receipts');
  assert.match(under('turn_1').textContent, /^Maya allowed this at .*, in Dot’s turn$/);
  assert.match(under('turn_3').textContent, /^Answered by Lena · /);
  m.event('decision_changed', { stream_id: 's', approval_id: 'approval_x_s_call_t1', approver_member_id: MAYA, approved: true });
  assert.equal(m.q('[data-conv-region="live"] .team-conv__receipts'), null, 'the decision placed under its turn is not repeated below');
  m.event('decision_changed', { stream_id: 's', approval_id: 'approval_other', approver_member_id: MAYA, approved: false });
  assert.match(m.q('[data-conv-region="live"] .team-conv__receipts').textContent, /Maya denied this/, 'one with nothing to place stays below');
});

test('T5: Esc and Cancel do nothing while Regenerate or Edit is out, a refusal is then said in the panel, and a busy host says to wait', async (t) => {
  const shown = fakeMenu(t);
  let release;
  const held = () => new Promise((resolve) => { release = resolve; });
  const m = mount(t, { answers: { projectRegenerate: held, projectBranch: held }, open: withMessages([mine('m1'), message('m2', 'assistant', 'x')]) });
  await flush();
  rightClick(m, rowOf(m, 'messageId', 'm1'));
  item(shown[0], 'regenerate').action();
  m.q('[data-conv-act="redo-go"]').click();
  assert.equal(m.q('[data-conv-act="panel-cancel"]').disabled, true, 'Cancel is greyed while the call is out');
  key(m, m.q('[data-conv-act-panel="redo"]'), 'Escape');
  m.q('[data-conv-act="panel-cancel"]').click();
  assert.ok(m.q('[data-conv-act-panel="redo"]'), 'the panel stays');
  release({ ok: false, error: { reason: 'disk_pressure' } });
  await flush();
  assert.ok(m.q('[data-conv-act-panel="redo"] [role="status"]').textContent.length > 0, 'the refusal is not dropped');
  rightClick(m, rowOf(m, 'messageId', 'm1'));
  item(shown[1], 'branch').action();
  m.q('[data-conv-act="redo-go"]').click();
  assert.match(m.q('[data-conv-act-panel="redo"] [role="status"]').textContent, /Wait for the last action to finish\./);
  assert.equal(m.sent('projectRegenerate').length, 1, 'nothing more was sent');
});
