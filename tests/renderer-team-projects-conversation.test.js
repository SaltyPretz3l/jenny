'use strict';

// new-test-file: a shared conversation drawn by the Team tab (row 123 slice 3-10, picks_3-10.md "Shared conversation",
// "The message box by state", "Approval card", "Always allowed"): open from a snapshot, a streamed turn coalesced per
// frame, tool lines, a resync snapshot, close; author lines; the driver line through acquire, release, takeover and a
// lease the host renews silently; a typed draft that survives every redraw; the box in each state for each role; take
// over and stop in order; the approval card by role with receipts, a lost race and a withdrawal; the asker's outcome
// line; caps at the edge and one past; hostile text; nothing left behind. A new surface.

const test = require('node:test');
const assert = require('node:assert/strict');

const { P1, S1, OTHER, DOT, MAYA, LENA, message, approval, snapshot, openProjects, region, flush, rulesAnswer, request, listAnswer, project } = require('./helpers/team-project-renderer-host');
const { heldAnswers, memberTeam } = require('./helpers/team-settings-harness');

const { NAMES, MINUTE, mount, box, field, type } = require('./helpers/team-conversation-mount');
const queues = require('../renderer/team/renderer-team-project-queue');

test('open from the snapshot: #team rows through the markdown path, one Jenny row per turn, names as #team (Former member); close on dispose', async (t) => {
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ has_more: true, messages: [
    message('m1', 'user', 'Why twice?', { author: { kind: 'member', member_id: MAYA } }), message('m2', 'assistant', 'It reads it once in **load**.'),
    message('m3', 'user', 'Make the change', { author: { kind: 'member', member_id: DOT } }), message('m4', 'user', 'Old note', { author: { kind: 'member', member_id: 'member_gone' } }),
    message('m5', 'user', 'Before schema 27') ] }) } });
  await flush();
  assert.deepEqual(m.sent('conversationOpen'), [{ team_id: OTHER, session_id: S1 }]);
  const authors = [...m.root.querySelectorAll('.team-msg__author')].map((el) => el.textContent);
  assert.deepEqual(authors, ['Maya', 'Jenny', 'Dot', 'Former member', 'Former member'], 'a gone member and a message with no author read Former member');
  assert.ok(m.q('.team-msg[data-turn-id="after:m1"] .team-msg__text strong'), 'markdown rendered in Jenny\'s row');
  assert.equal(m.root.querySelectorAll('.team-day').length, 1, 'one day divider');
  assert.equal(m.q('.chat-timeline, .chat-sprite-layer, [data-live="true"], .reasoning-row-block'), null, 'no row 169 look');
  assert.equal(m.q('[data-project-action="earlier"]').textContent, 'Show earlier messages', 'the snapshot has more: the older page is one click away');
  assert.match(m.q('.team-head__sub').textContent, /jenny-site · nobody is driving · you viewing/);
  m.restore();
  await flush();
  assert.deepEqual(m.sent('conversationClose'), [{ team_id: OTHER, session_id: S1 }]);
});

test('fix list M4c: closing before the open answered still sends the close, and again once an open lands after it', async (t) => {
  const m = mount(t, { hold: true });
  m.conv.dispose();
  await flush();
  assert.deepEqual(m.sent('conversationClose'), [{ team_id: OTHER, session_id: S1 }], 'the close goes at once');
  m.held.shift()();
  await flush();
  assert.equal(m.sent('conversationClose').length, 2, 'an open that landed after the close is closed too');
});

test('a streamed turn: one paint per frame, the tool on the chip (no line in the log); the reply stays until its snapshot lands; same-team pushes repaint nothing', async (t) => {
  const m = mount(t);
  await flush();
  const logBefore = m.renders.log;
  const liveRow = () => m.q('[data-conv-region="live"] .team-msg');
  const chip = () => liveRow().querySelector('.team-turn-chip__label').textContent;
  m.event('chat_stream', { stream_id: 'stream_1', event: { type: 'started' } });
  for (const piece of ['Hel', 'lo ', 'there']) m.event('chat_stream', { stream_id: 'stream_1', event: { type: 'delta', content: piece } });
  m.event('chat_stream', { stream_id: 'stream_1', event: { type: 'tool_use', call_id: 'c1', tool_name: 'edit_file' } });
  assert.equal(m.frames.size, 1, 'one frame asked for five events');
  const liveBefore = m.renders.live;
  m.frame();
  assert.equal(m.renders.live, liveBefore + 1, 'painted once');
  assert.match(liveRow().querySelector('.team-msg__text').textContent, /Hello there/);
  assert.equal(chip(), 'edit_file');
  assert.doesNotMatch(m.text('[data-conv-region="log"]'), /edit_file/, 'a tool draws no line in the log');
  m.advance(200);
  m.event('chat_stream', { stream_id: 'stream_1', event: { type: 'delta', aggregate: 'Hello there, done' } });
  m.event('chat_stream', { stream_id: 'stream_1', event: { type: 'tool_result', call_id: 'c1', tool_name: 'edit_file', status: 'ok' } });
  m.frame();
  assert.equal(chip(), 'Writing…');
  type(m, 'half a thought');
  const counts = { ...m.renders };
  m.conv.push({ kind: 'viewers', session_id: S1, viewers: [DOT] });
  m.conv.update({ type: 'transfer', team_id: OTHER });
  m.conv.update({ type: 'projects', team_id: OTHER });
  m.conv.update({ type: 'activity', team_id: OTHER });
  assert.deepEqual({ log: m.renders.log, live: m.renders.live, box: m.renders.box }, { log: counts.log, live: counts.live, box: counts.box }, 'nothing repainted');
  m.event('chat_stream', { stream_id: 'stream_1', event: { type: 'complete' } });
  m.frame();
  assert.match(liveRow().textContent, /Hello there, done/, 'the reply stays at the end');
  assert.equal(liveRow().querySelector('.team-turn-chip').dataset.state, 'done');
  m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot({ messages: [message('m9', 'assistant', 'Hello there, done')] }) });
  assert.equal(liveRow(), null, 'the snapshot holds it now');
  assert.match(m.text('[data-conv-region="log"]'), /Hello there, done/);
  assert.equal(m.q('[data-conv-region="log"] [data-message-id="m1"]'), null, 'a resync snapshot replaces the state');
  assert.ok(m.renders.log > logBefore);
});

test('the live reply: parsed again at most every 100 ms, at most 256 KB drawn; kept message HTML; pinned to the bottom unless scrolled up', async (t) => {
  const m = mount(t);
  await flush();
  const scroller = m.q('.team-conv__scroll');
  let height = 1000;
  Object.defineProperty(scroller, 'scrollHeight', { get: () => height, configurable: true });
  Object.defineProperty(scroller, 'clientHeight', { get: () => 200, configurable: true });
  m.event('chat_stream', { stream_id: 's', event: { type: 'started' } });
  m.event('chat_stream', { stream_id: 's', event: { type: 'delta', content: 'a' } });
  m.frame();
  const parsed = m.renders.live;
  m.event('chat_stream', { stream_id: 's', event: { type: 'delta', content: 'b' } });
  m.frame();
  assert.equal(m.renders.live, parsed, 'not again inside 100 ms');
  assert.equal(m.timers.size, 2, 'the chip\'s next second and one timer that paints what came after');
  m.advance(100);
  m.frame();
  assert.equal(m.renders.live, parsed + 1);
  const words = () => m.q('[data-conv-region="live"] .team-msg__text').textContent;
  assert.match(words(), /ab/);
  assert.equal(scroller.scrollTop, height, 'pinned to the bottom');
  scroller.scrollTop = 100;
  scroller.dispatchEvent(new m.window.Event('scroll'));
  height = 2000;
  m.advance(100);
  m.event('chat_stream', { stream_id: 's', event: { type: 'delta', content: 'c' } });
  m.frame();
  assert.equal(scroller.scrollTop, 100, 'scrolled up: left where the person put it');
  for (let i = 0; i < 6; i += 1) m.event('chat_stream', { stream_id: 's', event: { type: 'delta', content: 'x'.repeat(64 * 1024) } });
  m.advance(100);
  m.frame();
  assert.ok(words().trim().length <= 256 * 1024 && words().trim().length > 200 * 1024, 'the drawn reply is capped');
  const cached = m.conv.resources().cached;
  m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot() });
  assert.equal(m.conv.resources().cached, 2, 'one kept string per message held');
  assert.ok(cached >= 0);
});

test('fix list M1: a lease the host renews silently keeps its driver for a 3-minute turn; a vanished driver is cleared by the re-read', async (t) => {
  let control = null;
  const m = mount(t, { open: () => ({ ok: true, snapshot: snapshot({ active_turn: { stream_id: 'stream_7', status: 'running' }, control }) }) });
  await flush();
  const sub = () => m.q('.team-head__sub').textContent;
  // Maya takes the lease; the host renews it by heartbeat and publishes nothing.
  control = { member_id: MAYA, expires_at: m.now() + MINUTE };
  m.event('control_changed', { member_id: MAYA, expires_at: control.expires_at });
  for (let minute = 1; minute <= 3; minute += 1) {
    control = { member_id: MAYA, expires_at: m.now() + MINUTE + 30_000 };
    m.advance(MINUTE);
    await flush();
    assert.match(sub(), /Maya is driving/, `minute ${minute}`);
    assert.match(box(m), /Maya is driving and their turn is running\. You can take over when it ends\./, `minute ${minute}`);
  }
  const reads = m.sent('conversationOpen').length;
  assert.ok(reads >= 2 && reads <= 1 + 3 * 2, `at most one read every 30 s while shown: ${reads}`);
  // Maya's Jenny went away: the next re-read says nobody drives.
  control = null;
  m.advance(2 * MINUTE);
  await flush();
  assert.match(sub(), /nobody is driving/);
  assert.equal(m.conv.resources().timer, false, 'no lease shown, no lease timer');
});

test('fix list M1: the driver who holds the lease keeps Stop for the whole turn; no expiry is invented; takeover and release', async (t) => {
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ active_turn: { stream_id: 'stream_7', status: 'running' } }) } });
  await flush();
  const sub = () => m.q('.team-head__sub').textContent;
  m.conv.push({ kind: 'lease', session_id: S1, held: true });
  assert.match(sub(), /You are driving/);
  assert.equal(m.conv.resources().timer, false, 'a held lease has no clock');
  m.advance(3 * MINUTE);
  assert.match(sub(), /You are driving/);
  assert.ok(m.q('[data-project-action="stop"]'), 'Stop, not Send, after three minutes');
  m.event('control_changed', { member_id: MAYA, expires_at: m.now() + 30_000 });
  assert.match(sub(), /Maya is driving/);
  assert.match(box(m), /Maya took over\./, 'this member\'s lease ended by a takeover');
  m.event('control_changed', { state: 'released' });
  assert.match(sub(), /nobody is driving/);
  type(m, 'x');
  assert.doesNotMatch(box(m), /took over/, 'until they next act');
  m.conv.push({ kind: 'lease', session_id: S1, held: true });
  m.conv.push({ kind: 'lease', session_id: S1, held: false });
  assert.match(sub(), /nobody is driving/, 'a lease this member lost');
});

test('fix list M2: a typed draft keeps its node, value and selection through a stream frame, a viewers push and a projects push', async (t) => {
  const m = mount(t);
  await flush();
  const input = field(m);
  input.focus();
  type(m, 'Make the palette loader read once');
  input.setSelectionRange(5, 12);
  m.conv.push({ kind: 'lease', session_id: S1, held: true });
  m.event('chat_stream', { stream_id: 's', event: { type: 'started' } });
  m.event('chat_stream', { stream_id: 's', event: { type: 'delta', content: 'Working' } });
  m.frame();
  m.conv.push({ kind: 'viewers', session_id: S1, viewers: [DOT, MAYA] });
  m.conv.update({ type: 'projects', team_id: OTHER });
  m.event('chat_stream', { stream_id: 's', event: { type: 'complete' } });
  m.frame();
  assert.equal(field(m), input, 'the same node');
  assert.equal(input.value, 'Make the palette loader read once');
  assert.deepEqual([input.selectionStart, input.selectionEnd], [5, 12]);
  assert.equal(m.window.document.activeElement, input);
});

test('the box by state for a writer: nobody, someone running (disabled Take over), someone idle (Take over), an approval waits', async (t) => {
  const m = mount(t, { role: 'writer' });
  await flush();
  assert.match(box(m), /Sending makes you the driver/);
  type(m, 'Make the change');
  field(m).dispatchEvent(new m.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();
  assert.deepEqual(m.sent('conversationSend'), [{ team_id: OTHER, session_id: S1, prompt: 'Make the change' }]);
  assert.equal(field(m).value, '', 'sent: the field is emptied');
  m.event('control_changed', { member_id: MAYA, expires_at: 2_000_000 });
  m.event('chat_stream', { stream_id: 'stream_1', event: { type: 'started' } });
  m.frame();
  assert.match(box(m), /Maya is driving and their turn is running\. You can take over when it ends\./);
  const take = m.q('[data-project-action="takeover"]');
  assert.equal(take.disabled, true);
  assert.equal(take.getAttribute('title'), 'You can take over when Maya’s turn ends');
  m.event('chat_stream', { stream_id: 'stream_1', event: { type: 'complete' } });
  m.frame();
  assert.match(box(m), /their turn is running/, 'until the snapshot after the end lands');
  m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot({ control: { member_id: MAYA, expires_at: 2_000_000 } }) });
  assert.match(box(m), /^Maya is driving\.\s*Take over$/);
  m.q('[data-project-action="takeover"]').click();
  await flush();
  assert.deepEqual(m.sent('conversationControl'), [{ team_id: OTHER, session_id: S1, action: 'takeover' }]);
  m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot({ pending_approvals: [approval()], control: { member_id: LENA, expires_at: 2_000_000 } }) });
  assert.match(box(m), /Lena is driving\. You can answer the approval above\./);
});

test('the box for an admin and the team owner: Take over… asks, the confirm takes the focus, then takes over and stops in order; a reader\'s line', async (t) => {
  for (const [role, teamRole] of [['admin', 'member'], ['writer', 'owner']]) {
    const m = mount(t, { role, teamRole, open: { ok: true, snapshot: snapshot({ active_turn: { stream_id: 'stream_7', status: 'running' }, control: { member_id: MAYA, expires_at: 2_000_000 } }) } });
    await flush();
    assert.match(box(m), /Maya is driving and their turn is running\.\s*Take over…/, role + '/' + teamRole);
    m.q('[data-project-action="takeover-ask"]').focus();
    m.q('[data-project-action="takeover-ask"]').click();
    assert.match(box(m), /Maya’s turn is still running\. Take over to stop it\? Maya is told that you took over\./);
    assert.equal(m.window.document.activeElement, m.q('[data-project-action="takeover-cancel"]'), 'the focus moved into what replaced the button');
    m.q('[data-project-action="takeover-stop"]').click();
    await flush();
    assert.deepEqual(m.calls.filter((c) => c.method === 'conversationControl' || c.method === 'conversationCancel').map((c) => [c.method, c.payload]),
      [['conversationControl', { team_id: OTHER, session_id: S1, action: 'takeover' }], ['conversationCancel', { team_id: OTHER, session_id: S1, stream_id: 'stream_7' }]]);
    m.restore();
  }
  const r = mount(t, { role: 'reader' });
  await flush();
  assert.equal(box(r), 'You can read this project. Only its writers and admins can send.');
  assert.equal(r.q('[data-conv-box="composer"]').hidden, true, 'no field for a reader');
});

test('take over and stop: a refused stop says so and leaves the Stop button; the confirm closes when the turn ends', async (t) => {
  const m = mount(t, { role: 'admin', answers: { conversationCancel: { ok: false, error: { reason: 'approval_not_viewing' } } },
    open: { ok: true, snapshot: snapshot({ active_turn: { stream_id: 'stream_7', status: 'running' }, control: { member_id: MAYA, expires_at: 2_000_000 } }) } });
  await flush();
  m.q('[data-project-action="takeover-ask"]').click();
  m.q('[data-project-action="takeover-stop"]').click();
  await flush();
  assert.match(box(m), /Only someone who can write in this project and is viewing this conversation can answer\./, 'the landed sentence');
  assert.ok(m.q('[data-project-action="stop"]'), 'the Stop button is still there');
  m.event('control_changed', { member_id: MAYA, expires_at: 2_000_000 });
  m.q('[data-project-action="takeover-ask"]').click();
  m.event('chat_stream', { stream_id: 'stream_7', event: { type: 'complete' } });
  m.frame();
  assert.doesNotMatch(box(m), /Take over to stop it/, 'the turn ended: the confirm is gone');
});

test('the approval card: the always button by project role (the team owner who is a writer asks), only for the two file tools, never in Plan mode; a reader has none', async (t) => {
  const cases = [
    ['writer', 'member', 'edit_file', false, 'Allow once, ask for always'],
    ['admin', 'member', 'write_file', false, 'Always allow'],
    ['writer', 'owner', 'edit_file', false, 'Allow once, ask for always'],
    ['admin', 'member', 'run_command', false, null],
    ['admin', 'member', 'edit_file', true, null],
  ];
  for (const [role, teamRole, tool, plan, always] of cases) {
    const m = mount(t, { role, teamRole, open: { ok: true, snapshot: snapshot({ session: { session_id: S1, title: 'T', revision: 'r1', plan_mode: plan }, pending_approvals: [approval({ tool_name: tool })] }) } });
    await flush();
    const card = m.q('.tool-approval-block');
    assert.ok(card.querySelector('.tool-approve-btn[data-approval-scope="once"]') && card.querySelector('.tool-deny-btn'), 'Allow once and Deny');
    const button = card.querySelector('[data-team-always]');
    assert.equal(button ? button.textContent : null, always, `${role}/${teamRole}/${tool}/${plan}`);
    if (button) assert.ok(button.getAttribute('title') && button.nextElementSibling.classList.contains('tool-deny-btn'), 'before Deny, with its tooltip');
    assert.match(card.querySelector('.tool-approval-who').textContent, /Lena’s turn asked\. Anyone who can write in this project and is viewing this conversation can answer\./);
    m.restore();
  }
  const r = mount(t, { role: 'reader', open: { ok: true, snapshot: snapshot({ pending_approvals: [approval({ summary: '‮' + 's'.repeat(900) })] }) } });
  await flush();
  assert.equal(r.q('.tool-approval-block button'), null, 'a reader has no buttons');
  const summary = r.q('.tool-approval-block').textContent;
  assert.ok(!summary.includes('‮') && !summary.includes('s'.repeat(601)), 'the summary is cut at 600 characters with no bidi control');
});

test('answering: the payloads, a losing answer\'s sentence, receipts allowed, declined and withdrawn, and an always that did not land', async (t) => {
  let fail = true;
  const m = mount(t, { role: 'writer', open: { ok: true, snapshot: snapshot({ pending_approvals: [approval()] }) },
    answers: { conversationDecide: (p) => (fail ? { ok: false, error: { reason: 'approval_not_viewing' } }
      : { ok: true, revision: 'r2', always_result: p.always ? { ok: false, reason: 'team_rule_request_limit' } : undefined }) } });
  await flush();
  m.q('.tool-approve-btn[data-approval-scope="once"]').click();
  await flush();
  assert.match(m.q('.tool-approval-block').textContent, /Only someone who can write in this project and is viewing this conversation can answer\./, 'the losing answer\'s sentence');
  assert.equal(m.q('.tool-approve-btn[data-approval-scope="once"]').disabled, false, 'not stuck');
  fail = false;
  m.q('[data-team-always="ask"]').click();
  // decision_changed arrives before the answer: the receipt is whole from what this member asked.
  m.event('decision_changed', { stream_id: 'stream_1', approval_id: 'appr_1', approver_member_id: DOT, prompter_member_id: LENA, approved: true });
  assert.match(m.q('[data-approval-status="resolved"]').textContent, /^You allowed this once at .+, in Lena’s turn, and asked the project’s admins to always allow edit_file here\./);
  await flush();
  assert.deepEqual(m.sent('conversationDecide'), [
    { team_id: OTHER, session_id: S1, stream_id: 'stream_1', approval_id: 'appr_1', decision_revision: 'rev_1', approved: true },
    { team_id: OTHER, session_id: S1, stream_id: 'stream_1', approval_id: 'appr_1', decision_revision: 'rev_1', approved: true, always: 'ask' }]);
  const receipt = m.q('[data-approval-status="resolved"]').textContent;
  assert.match(receipt, /^You allowed this at .+, in Lena’s turn Allowed once\. This project already has 16 requests waiting for its admins, so no new one was sent\.$/);
  assert.equal(m.q('.tool-approve-btn'), null, 'the card became the receipt');
  m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot({ pending_approvals: [approval({ approval_id: 'appr_2', call_id: 'call_2' }), approval({ approval_id: 'appr_3', call_id: 'call_3' })] }) });
  m.event('decision_changed', { stream_id: 'stream_1', approval_id: 'appr_2', approver_member_id: MAYA, prompter_member_id: LENA, approved: false });
  m.event('decision_changed', { stream_id: 'stream_1', approval_id: 'appr_3', prompter_member_id: LENA });
  const log = m.text('[data-conv-region="live"]');
  assert.match(log, /Maya denied this at .+, in Lena’s turn/);
  assert.match(log, /Withdrawn at .+: the turn no longer asks\./, 'a withdrawal names nobody');
  assert.ok(m.q('.team-conv__receipts > [data-approval-status="resolved"]'), 'receipts sit in the rows’ text column');
});

test('the asker\'s outcome line: allowed in a folder, declined with the reason; another member\'s request shows nothing', async (t) => {
  const answered = [request({ request_seq: 4, asker_member_id: DOT, session_id: S1, state: 'changed', answered_by: MAYA, outcome_tool: 'edit_file', outcome_folder: 'posts/', rule_seq: 2 }),
    request({ request_seq: 5, asker_member_id: DOT, session_id: S1, state: 'declined', answered_by: MAYA, reason: 'Keep drafts reviewed until the launch.' }),
    request({ request_seq: 6, asker_member_id: LENA, session_id: S1, state: 'allowed', answered_by: MAYA, outcome_tool: 'edit_file', rule_seq: 3 })];
  const m = mount(t, { answers: { projectRules: rulesAnswer({ requests: answered }) } });
  await flush();
  for (const seq of [4, 5, 6]) m.conv.push({ kind: 'rule_answered', session_id: S1, request_seq: seq, outcome: 'allowed' });
  await flush();
  const lines = [...m.root.querySelectorAll('[data-team-outcome]')].map((el) => el.textContent);
  assert.deepEqual(lines, ['Maya always allowed edit_file in jenny-site, in posts/ only.', 'Maya did not always allow edit_file: “Keep drafts reviewed until the launch.” Each edit still asks.']);
});

test('caps at the edge and one past: 400 messages, 32 tools, 32 receipts, 16 outcome lines, 32 viewers, 3 queued; dispose leaves nothing', async (t) => {
  t.after(() => queues._reset());
  const many = (n) => Array.from({ length: n }, (_v, i) => message('m' + i, 'assistant', 'reply ' + i));
  const edge = mount(t, { open: { ok: true, snapshot: snapshot({ messages: many(400) }) } });
  await flush();
  assert.equal(edge.conv.resources().messages, 400);
  edge.event('chat_stream', { stream_id: 's', event: { type: 'started' } });
  edge.frame();
  for (const text of ['one', 'two', 'three', 'four']) { type(edge, text); field(edge).dispatchEvent(new edge.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); }
  assert.equal(edge.conv.resources().queued, 3, 'three wait');
  assert.equal(field(edge).value, 'four', 'the fourth stays in the box');
  assert.match(box(edge), /Up to 3 messages can wait\. Send or discard one first\./);
  const chip = edge.q('[data-conv-region="live"] .team-turn-chip');
  chip.click();
  assert.ok(edge.q('[id$="teamTurnPop"]'), 'the popover is open');
  edge.restore();
  assert.equal(edge.q('[id$="teamTurnPop"]'), null, 'dispose closes the popover');
  assert.equal(edge.conv.resources().listeners, 0);
  chip.click();
  assert.equal(edge.q('[id$="teamTurnPop"]'), null, 'no listener answers a click');
  assert.equal(edge.sent('conversationSend').length, 0, 'nothing queued was sent');
  queues._reset();
  const outcomes = Array.from({ length: 17 }, (_v, i) => request({ request_seq: i + 1, asker_member_id: DOT, session_id: S1, state: 'allowed', answered_by: MAYA, outcome_tool: 'edit_file', rule_seq: i + 1 }));
  const m = mount(t, { answers: { projectRules: rulesAnswer({ requests: outcomes }) }, open: { ok: true, snapshot: snapshot({ messages: many(401), control: { member_id: MAYA, expires_at: 2_000_000 } }) } });
  await flush();
  assert.equal(m.conv.resources().messages, 400, 'one past: the oldest goes');
  assert.equal(m.q('[data-message-id="m0"]'), null);
  assert.equal(m.q('[data-project-action="earlier"]'), null, 'no button for a page this view cannot hold');
  assert.match(m.text(), /This view holds 400 messages\. The ones before them are not shown here\./);
  m.event('chat_stream', { stream_id: 's', event: { type: 'started' } });
  for (let i = 0; i < 33; i += 1) m.event('chat_stream', { stream_id: 's', event: { type: 'tool_use', call_id: 'c' + i, tool_name: 'read_file' } });
  assert.equal(m.conv.resources().tools, 32);
  for (let i = 0; i < 33; i += 1) m.event('decision_changed', { stream_id: 's', approval_id: 'appr_' + i, approver_member_id: MAYA, approved: true });
  assert.equal(m.conv.resources().receipts, 32);
  for (let i = 1; i <= 17; i += 1) m.conv.push({ kind: 'rule_answered', session_id: S1, request_seq: i, outcome: 'allowed' });
  await flush();
  assert.equal(m.conv.resources().outcomes, 16);
  m.conv.push({ kind: 'viewers', session_id: S1, viewers: Array.from({ length: 33 }, (_v, i) => 'member_v' + i) });
  assert.equal((m.q('.team-head__sub').textContent.match(/Former member/g) || []).length, 32);
  assert.ok(m.conv.resources().answered <= 64);
  assert.equal(m.conv.resources().timer, true);
  assert.equal(m.conv.resources().frame, true);
  m.restore();
  assert.deepEqual({ ...m.conv.resources(), messages: 0, tools: 0, receipts: 0, outcomes: 0, answered: 0 },
    { timer: false, frame: false, listeners: 0, messages: 0, tools: 0, receipts: 0, outcomes: 0, answered: 0, cached: 0, queued: 0 });
  assert.equal(m.timers.size, 0);
  assert.equal(m.frames.size, 0);
});

test('hostile text at 500 characters: a project, a title, a tool, a member, a folder and a reason make no element or attribute', async (t) => {
  const evil = (tag) => `<${tag} data-evil="1" onclick="x()">E</${tag}><img src=x onerror="globalThis.pwned=1">‮` + 'x'.repeat(500);
  NAMES.member_evil = evil('b');
  t.after(() => { delete NAMES.member_evil; });
  const m = mount(t, { projectName: evil('em'), answers: { projectRules: rulesAnswer({ requests: [request({ request_seq: 4, asker_member_id: DOT, session_id: S1, state: 'changed', answered_by: 'member_evil',
    outcome_tool: evil('u'), outcome_folder: evil('s'), rule_seq: 2 }), request({ request_seq: 5, asker_member_id: DOT, session_id: S1, state: 'declined', answered_by: MAYA, reason: evil('q') })] }) },
  open: { ok: true, snapshot: snapshot({ session: { session_id: S1, title: evil('script'), revision: 'r', plan_mode: false }, pending_approvals: [approval({ prompter_member_id: 'member_evil', summary: evil('code') })],
    messages: [message('m1', 'user', 'hi', { author: { kind: 'member', member_id: 'member_evil' } }), message('m2', 'assistant', 'ok', { model_used: evil('u') })] }) } });
  await flush();
  m.event('chat_stream', { stream_id: 's', event: { type: 'started' } });
  m.event('chat_stream', { stream_id: 's', event: { type: 'tool_use', call_id: 'c', tool_name: evil('i') } });
  m.frame();
  // The popover's sub line names whose turn it was and the model that answered.
  m.q('.team-turn-chip[data-turn-id="after:m1"]').click();
  assert.match(m.q('[id$="teamTurnPop"] .team-turn-pop__title span').textContent, /<b data-evil.*’s turn.*<u data-evil/);
  m.conv.push({ kind: 'viewers', session_id: S1, viewers: ['member_evil'] });
  for (const seq of [4, 5]) m.conv.push({ kind: 'rule_answered', session_id: S1, request_seq: seq, outcome: 'allowed' });
  await flush();
  assert.equal(m.root.querySelector('[data-evil], [onclick], [onerror], img, script, em, u, s, q, i, code'), null, 'nothing parsed from the strings');
  assert.match(m.q('.team-head__name').textContent, /^<script data-evil/);
  const drawn = [...m.root.querySelectorAll('*')].filter((el) => !el.children.length && el.textContent.includes('‮')).map((el) => el.outerHTML.slice(0, 120));
  assert.deepEqual(drawn, [], 'no bidi control drawn');
  // The approval answered: the running tool's name is the chip's label, as text.
  m.event('decision_changed', { stream_id: 's', approval_id: 'appr_1', approver_member_id: MAYA, prompter_member_id: 'member_evil', approved: true });
  assert.match(m.q('[data-conv-region="live"] .team-turn-chip__label').textContent, /^<i data-evil/);
  assert.equal(m.root.querySelector('[data-evil], [onclick], [onerror], img, i'), null);
  assert.equal(globalThis.pwned, undefined);
});

test('in the tab: a conversation opens from the column, only its own pushes reach it, and leaving it closes it', async (t) => {
  const { h, push } = await openProjects({ list: listAnswer({ projects: [project(P1, 'jenny-site', 'writer')] }) });
  t.after(h.restore);
  h.view.q(`[data-session-id="${S1}"]`).click();
  await flush();
  assert.deepEqual(h.sent('conversationOpen').map((c) => c.payload), [{ team_id: OTHER, session_id: S1 }]);
  assert.match(region(h).querySelector('.team-head__name').textContent, /Palette loader cleanup/);
  push({ kind: 'conversation_event', session_id: 'sess_' + 'z'.repeat(32), event_type: 'chat_stream', event: { session_id: 'sess_' + 'z'.repeat(32), stream_id: 's', event: { type: 'started' } } });
  push({ kind: 'snapshot', session_id: S1, snapshot: snapshot({ messages: [message('n1', 'assistant', 'From the resync')] }) });
  await flush();
  assert.match(region(h).textContent, /From the resync/);
  h.view.q(`[data-team-channel="chan_team"]`).click();
  await flush();
  assert.equal(region(h), null);
  assert.deepEqual(h.sent('conversationClose').map((c) => c.payload), [{ team_id: OTHER, session_id: S1 }]);
});

test('fix list M5: New conversation opens with the writer\'s box before any list push names it', async (t) => {
  const NEW = 'sess_' + 'n'.repeat(32);
  const { h } = await openProjects({ list: listAnswer({ projects: [project(P1, 'jenny-site', 'writer')] }),
    answers: { conversationCreate: { ok: true, session: { session_id: NEW, title: '', project_id: P1 } }, conversationOpen: { ok: true, snapshot: snapshot({ session: { session_id: NEW, title: '', revision: 'r1', plan_mode: false }, messages: [] }) } } });
  t.after(h.restore);
  h.view.q(`[data-team-tab-action="conv-new"][data-project-id="${P1}"]`).click();
  await flush();
  assert.deepEqual(h.sent('conversationOpen').map((c) => c.payload), [{ team_id: OTHER, session_id: NEW }]);
  const composer = region(h).querySelector('[data-conv-box="composer"]');
  assert.equal(composer.hidden, false, 'the box, not the reader\'s line');
  assert.match(region(h).querySelector('[data-conv-box="left"]').textContent, /Sending makes you the driver/);
  assert.match(region(h).querySelector('.team-conv__hero').textContent, /New conversation.*In jenny-site\./, 'an empty conversation says what it is');
});

// Team review R13-F02: the answer to a New conversation asked in one team lands after another team is shown.
test('R13-F02: a conversation create answered after a team switch writes no note, page or focus into the team now shown', async (t) => {
  const NEW = 'sess_' + 'n'.repeat(32);
  const beta = memberTeam({ team_id: 'team_CCCCCCCCCCCCCCCCCCCCCC', team_name: 'Beta lab' });
  const gate = heldAnswers();
  const { h } = await openProjects({ list: listAnswer({ projects: [project(P1, 'jenny-site', 'writer')] }), answers: { conversationCreate: gate.answer } });
  t.after(h.restore);
  h.listeners.state({ teams: [memberTeam(), beta] });
  await flush();
  const switchTo = async (name) => {
    h.view.q('[data-team-tab-action="switch"]').click();
    [...h.window.document.querySelectorAll('.team-switch-menu [role="menuitemradio"]')].find((el) => el.textContent.includes(name)).click();
    await flush();
  };
  const askAndLeave = async () => {
    h.view.q(`[data-team-tab-action="conv-new"][data-project-id="${P1}"]`).click();
    await flush();
    await switchTo('Beta lab');
    h.view.q('[data-team-tab-action="switch"]').focus();
    return { focused: h.window.document.activeElement, screen: h.view.q('.team-shell').dataset.screen };
  };
  let before = await askAndLeave();
  gate.release({ ok: false, error: { reason: 'not_allowed' } });
  await flush();
  assert.equal(h.view.q('[data-team-head-note]'), null, 'team A\'s refusal is not written on Beta lab\'s header');
  assert.equal(h.window.document.activeElement, before.focused);

  await switchTo('Dot lab');
  before = await askAndLeave();
  gate.release({ ok: true, session: { session_id: NEW, title: '', project_id: P1 } });
  await flush();
  assert.deepEqual(gate.calls.map((p) => p.team_id), [OTHER, OTHER]);
  assert.equal(region(h), null, 'Beta lab\'s page is not replaced by team A\'s new conversation');
  assert.deepEqual(h.sent('conversationOpen'), []);
  assert.equal(h.view.q('.team-shell').dataset.screen, before.screen);
  assert.equal(h.window.document.activeElement, before.focused, 'the focus stays where the person put it');
});

// Row 169 moved the line from the header to under the message box, so the header keeps the title and who drives.
test('E68: a shared conversation has a standing line under its message box before any message, saying who can read it, and nothing dismisses it', async (t) => {
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ messages: [] }) } });
  await flush();
  const line = m.q('[data-conv-region="box"] .team-conv__standing[data-standing="true"]');
  assert.ok(line, 'the standing line is under the box');
  assert.equal(line.textContent, 'The team host and the member whose PC answers can read this conversation.');
  assert.equal(m.q('[data-conv-region="head"] [data-standing]'), null, 'said once');
  assert.equal(line.querySelector('button'), null, 'no control closes the line');
  m.conv.push({ kind: 'viewers', session_id: S1, viewers: [DOT, MAYA] });
  m.conv.push({ kind: 'closed', session_id: S1, reason: 'team_left' });
  assert.equal(m.q('[data-conv-box="shell"]').hidden, true, 'the box is gone');
  assert.equal(m.q('[data-standing="true"]'), line, 'the same line through a redraw and a closed conversation');
  const reader = mount(t, { role: 'reader' });
  await flush();
  assert.ok(reader.q('.team-conv__standing[data-standing="true"]'), 'a reader has it too');
});

test('host shapes: { id, label } options answer by the picked option\'s id, repeated labels by place, a blank option is not drawn', async (t) => {
  const twins = { question_ref: 'q_ref_1', stream_id: 'stream_1', call_id: 'call_q', prompter_member_id: MAYA, questions: [{ id: 'pick', prompt: 'Which?', options: [{ id: 'a', label: 'Same' }, { id: 'b', label: 'Same' }, { id: 'c', label: '  ' }] }] };
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ active_turn: { stream_id: 'stream_1', status: 'running' }, pending_questions: [twins] }) } });
  await flush();
  const wrap = m.q('.team-conv__question');
  assert.deepEqual(Array.from(wrap.querySelectorAll('.user-questions-option-label')).map((el) => el.textContent), ['Same', 'Same']);
  const second = wrap.querySelectorAll('[data-user-question-option]')[1];
  second.checked = true;
  second.dispatchEvent(new m.window.Event('change', { bubbles: true }));
  wrap.querySelector('.user-questions-submit-btn').click();
  await flush();
  assert.deepEqual(m.sent('conversationAnswer').map((p) => p.answers), [[{ question_id: 'pick', answer: 'b' }]]);
});

test('the pen is greyed with its reason for a reader and while another member drives', async (t) => {
  const r = mount(t, { role: 'reader' });
  await flush();
  const pen = (m) => m.q('[data-project-action="rename"]');
  assert.deepEqual([pen(r).disabled, pen(r).getAttribute('title')], [true, 'Only writers and admins can rename']);
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ control: { member_id: MAYA, expires_at: 2_000_000 } }) } });
  await flush();
  assert.deepEqual([pen(m).disabled, pen(m).getAttribute('title')], [true, 'Maya is driving. You can rename when their turn ends']);
  pen(m).click();
  assert.equal(m.q('[id$="teamConversationTitle"]'), null);
  m.event('control_changed', { state: 'released' });
  assert.equal(pen(m).disabled, false);
});

// Owner report: a member could not message Jenny. With nobody sharing a GPU a turn cannot be placed, and the box said nothing.
const NOBODY = 'Nobody is sharing a GPU with Dot lab right now, so Jenny cannot answer here yet.';
const NODE = { node_id: 'node_maya', member_id: MAYA, label: 'Maya PC', online: true, paused: false, busy_slots: 0, models: [{ name: 'qwen3' }] };

test('no GPU shared: a writer sees why Jenny cannot answer and a button to the share switch; the box stays usable', async (t) => {
  const m = mount(t, { gpus: { nodes: [] } });
  await flush();
  assert.equal(m.q('[data-conv-box="above"] .team-drive').textContent.replace(/\s+/g, ' ').trim(), NOBODY + 'Share this PC’s GPU…');
  const share = m.q('[data-conv-box="above"] button');
  assert.equal(share.textContent.trim(), 'Share this PC’s GPU…');
  assert.equal(share.dataset.teamTabAction, 'share-settings', 'the Team tab opens Settings > Team at the share switch');
  assert.equal(m.q('[data-conv-box="composer"]').hidden, false);
  type(m, 'Hello');
  assert.equal(field(m).value, 'Hello');
});

test('no hint while the GPU list is unread, the team is not connected, or a GPU is listed', async (t) => {
  for (const options of [{}, { gpus: { nodes: [] }, teamState: 'connecting' }, { gpus: { nodes: [NODE] } }]) {
    const m = mount(t, options);
    await flush();
    assert.doesNotMatch(box(m), /Nobody is sharing/, JSON.stringify(options));
    assert.match(box(m), options.teamState ? /Sends when reconnected/ : /Sending makes you the driver/, 'a team that is not online says when Send works (row 175 F7)');
    m.restore();
  }
});

test('no GPU shared: a project reader keeps only the read-only line; a team read-only member gets the sentence without the button', async (t) => {
  const reader = mount(t, { role: 'reader', gpus: { nodes: [] } });
  await flush();
  assert.equal(box(reader), 'You can read this project. Only its writers and admins can send.');
  reader.restore();
  const watcher = mount(t, { teamRole: 'read_only', gpus: { nodes: [] } });
  await flush();
  assert.equal(watcher.q('[data-conv-box="above"]').textContent.replace(/\s+/g, ' ').trim(), NOBODY);
  assert.equal(watcher.q('[data-conv-box="above"] button'), null);
});

test('in the tab: the hint opens Settings > Team, and a GPU appearing removes it with no reload', async (t) => {
  const { h } = await openProjects({ list: listAnswer({ projects: [project(P1, 'jenny-site', 'writer')] }) });
  t.after(h.restore);
  const pools = (nodes) => h.listeners.state({ teams: [memberTeam()], sharing: null, pools: { [OTHER]: { nodes } } });
  h.view.q(`[data-session-id="${S1}"]`).click();
  await flush();
  assert.doesNotMatch(region(h).textContent, /Nobody is sharing/, 'the list is not read yet: nothing is claimed');
  pools([]);
  await flush();
  assert.match(region(h).textContent, /Nobody is sharing a GPU with Dot lab right now/);
  region(h).querySelector('[data-conv-box="above"] button').click();
  assert.deepEqual(h.opened, ['team']);
  const input = region(h).querySelector('[id$="teamConversationInput"]');
  pools([NODE]);
  await flush();
  assert.doesNotMatch(region(h).textContent, /Nobody is sharing/);
  assert.equal(region(h).querySelector('[id$="teamConversationInput"]'), input, 'the same field: no reload');
  assert.equal(h.sent('conversationOpen').length, 1);
});

test('row 171 review: Send again queues once; a queued send answered after the view went settles; leaving pauses the waiting rows', async (t) => {
  t.after(() => queues._reset());
  let answer = null;
  const turns = [message('u1', 'user', 'Retry me', { author: { kind: 'member', member_id: DOT }, turn_id: 'tf' }), message('a1', 'assistant', '', { kind: undefined, turn_id: 'tf', status: 'runtime_error' })];
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ messages: turns }) }, answers: { conversationSend: () => new Promise((resolve) => { answer = resolve; }) } });
  await flush();
  const ev = (type) => m.event('chat_stream', { stream_id: 's1', event: { type } });
  const words = (v) => [...v.root.querySelectorAll('[data-conv-region="queued"] .team-queued')].map((el) => el.textContent);
  ev('started');
  for (let i = 0; i < 2; i += 1) m.q('[data-project-action="send-again"][data-turn-id="tf"]').click();
  assert.deepEqual(words(m), ['Waits for Jenny’s turn to end'], 'queued once');
  ev('complete');
  m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot({ messages: turns }) }); await flush();
  assert.deepEqual(m.sent('conversationSend').map((x) => x.prompt), ['Retry me'], 'it went with the idle snapshot');
  ev('started');
  type(m, 'Later');
  field(m).dispatchEvent(new m.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  m.restore();
  answer({ ok: true });
  await flush();
  const again = mount(t);
  await flush();
  assert.deepEqual(words(again), ['Not sent'], 'the posted one is gone; the waiting one reads Not sent, nothing sends unwatched');
});
