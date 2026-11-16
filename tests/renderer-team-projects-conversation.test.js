'use strict';

// new-test-file: a shared conversation drawn by the Team tab (row 123 slice 3-10, picks_3-10.md "Shared conversation",
// "The message box by state", "Approval card", "Always allowed"): open from a snapshot, a streamed turn coalesced per
// frame, tool lines, a resync snapshot, close; author lines; the driver line through acquire, release, takeover and a
// lease the host renews silently; a typed draft that survives every redraw; the box in each state for each role; take
// over and stop in order; the approval card by role with receipts, a lost race and a withdrawal; the asker's outcome
// line; caps at the edge and one past; hostile text; nothing left behind. A new surface.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { P1, S1, OTHER, DOT, MAYA, LENA, message, approval, snapshot, openProjects, region, flush, rulesAnswer, request, listAnswer, project } = require('./helpers/team-project-renderer-host');
const { inventory, heldAnswers, memberTeam } = require('./helpers/team-settings-harness');
const { METHODS, validatePayload } = require('../services/team/ipc-methods');
const words = require('../renderer/shell/renderer-settings-team-strings');

const NAMES = { [DOT]: 'Dot', [MAYA]: 'Maya', [LENA]: 'Lena' };
const MINUTE = 60_000;

// The conversation module alone over a fake project store whose every call must pass main's own check, with names
// cleaned as the tab's own context does. `restore` is registered with t.after so a failed assertion still puts the
// globals back.
function mount(t, { role = 'writer', teamRole = 'member', answers = {}, open = { ok: true, snapshot: snapshot() }, projectName = 'jenny-site', hold = false } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { pretendToBeVisual: true });
  const saved = ['window', 'document', 'inventory', 'inventoryTextField', 'markdownUtils'].map((k) => [k, globalThis[k]]);
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.inventory = inventory();
  dom.window.markdownUtils = require('../renderer/shared/markdown-utils');
  globalThis.markdownUtils = dom.window.markdownUtils;
  for (const name of ['project-box', 'project-conversation', 'project-column']) delete require.cache[require.resolve(`../renderer/team/renderer-team-${name}`)];
  const { createConversation } = require('../renderer/team/renderer-team-project-conversation');
  const { clean } = require('../renderer/team/renderer-team-project-column');
  const calls = [];
  const refused = [];
  let now = 1_000_000;
  const timers = new Map();
  let nextTimer = 1;
  const frames = new Map();
  const held = [];
  const store = {
    call: (method, payload) => {
      calls.push({ method, payload });
      if (!Object.hasOwn(METHODS, method) || !validatePayload(method, payload).ok) refused.push(method);
      const answer = method === 'conversationOpen' ? (typeof open === 'function' ? open(payload) : open) : answers[method];
      const value = typeof answer === 'function' ? answer(payload) : (answer || { ok: true });
      if (hold && method === 'conversationOpen') return new Promise((resolve) => held.push(() => resolve(value)));
      return Promise.resolve(value);
    },
    project: () => ({ id: P1, name: projectName, role }),
    conversationsOf: () => [{ session_id: S1, project_id: P1, title: 'Palette loader cleanup' }],
  };
  const renders = { log: 0, live: 0, box: 0, head: 0 };
  const root = dom.window.document.getElementById('root');
  const conv = createConversation({ root, teamId: OTHER, projectId: P1, sessionId: S1, store, renders,
    ctx: () => ({ team: { team_id: OTHER, member_id: DOT, role: teamRole }, nameOf: (id) => clean(NAMES[id] || 'Former member', 64), errorText: (e) => words.errorText(e) }),
    clock: () => now, timers: { set: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: now + ms }); return id; }, clear: (id) => timers.delete(id) },
    frames: { request: (fn) => { const id = nextTimer++; frames.set(id, fn); return id; }, cancel: (id) => frames.delete(id) } });
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    conv.dispose();
    for (const [k, v] of saved) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
    if (refused.length) throw new Error('main would refuse: ' + refused.join(', '));
  };
  t.after(restore);
  const advance = (ms) => { const end = now + ms; for (;;) { const due = [...timers].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; now = Math.max(now, due[1].at); timers.delete(due[0]); due[1].fn(); } now = end; };
  const frame = () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } };
  const q = (s) => root.querySelector(s);
  const text = (s = '[data-conv-region]') => [...root.querySelectorAll(s)].map((el) => el.textContent).join(' ').replace(/\s+/g, ' ');
  const event = (event_type, event) => conv.push({ kind: 'conversation_event', session_id: S1, event_type, event: { session_id: S1, ...event } });
  return { conv, root, q, text, calls, renders, timers, frames, advance, frame, restore, event, held, now: () => now, sent: (m) => calls.filter((c) => c.method === m).map((c) => c.payload), window: dom.window };
}

const box = (m) => [...m.q('[data-conv-region="box"]').children].filter((el) => !el.hidden).map((el) => el.textContent).join(' ').replace(/\s+/g, ' ').trim();
const field = (m) => m.q('#teamConversationInput');
function type(m, value) { field(m).value = value; field(m).dispatchEvent(new m.window.Event('input', { bubbles: true })); }

test('open from the snapshot: messages through the markdown path, author lines with You and Former member; close on dispose', async (t) => {
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ has_more: true, messages: [
    message('m1', 'user', 'Why twice?', { author: { kind: 'member', member_id: MAYA } }), message('m2', 'assistant', 'It reads it once in **load**.'),
    message('m3', 'user', 'Make the change', { author: { kind: 'member', member_id: DOT } }), message('m4', 'user', 'Old note', { author: { kind: 'member', member_id: 'member_gone' } }),
    message('m5', 'user', 'Before schema 27') ] }) } });
  await flush();
  assert.deepEqual(m.sent('conversationOpen'), [{ team_id: OTHER, session_id: S1 }]);
  const authors = [...m.root.querySelectorAll('.chat-author b')].map((el) => el.textContent);
  assert.deepEqual(authors, ['Maya', 'You', 'Former member'], 'Jenny\'s reply and a message with no author have no line');
  assert.ok(m.q('[data-message-id="m2"] strong'), 'markdown rendered');
  assert.match(m.text(), /Earlier messages are not shown here yet\./);
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

test('a streamed turn: one paint per frame, a tool line per call; the reply stays until its snapshot lands; same-team pushes repaint nothing', async (t) => {
  const m = mount(t);
  await flush();
  const logBefore = m.renders.log;
  m.event('chat_stream', { stream_id: 'stream_1', event: { type: 'started' } });
  for (const piece of ['Hel', 'lo ', 'there']) m.event('chat_stream', { stream_id: 'stream_1', event: { type: 'delta', content: piece } });
  m.event('chat_stream', { stream_id: 'stream_1', event: { type: 'tool_use', call_id: 'c1', tool_name: 'edit_file' } });
  assert.equal(m.frames.size, 1, 'one frame asked for five events');
  const liveBefore = m.renders.live;
  m.frame();
  assert.equal(m.renders.live, liveBefore + 1, 'painted once');
  assert.match(m.q('[data-live="true"]').textContent, /Hello there/);
  assert.match(m.text('[data-conv-region="log"]'), /edit_file · running/);
  m.advance(200);
  m.event('chat_stream', { stream_id: 'stream_1', event: { type: 'delta', aggregate: 'Hello there, done' } });
  m.event('chat_stream', { stream_id: 'stream_1', event: { type: 'tool_result', call_id: 'c1', tool_name: 'edit_file', status: 'ok' } });
  m.frame();
  assert.match(m.text('[data-conv-region="log"]'), /edit_file · done/);
  type(m, 'half a thought');
  const counts = { ...m.renders };
  m.conv.push({ kind: 'viewers', session_id: S1, viewers: [DOT] });
  m.conv.update({ type: 'transfer', team_id: OTHER });
  m.conv.update({ type: 'projects', team_id: OTHER });
  m.conv.update({ type: 'activity', team_id: OTHER });
  assert.deepEqual({ log: m.renders.log, live: m.renders.live, box: m.renders.box }, { log: counts.log, live: counts.live, box: counts.box }, 'nothing repainted');
  m.event('chat_stream', { stream_id: 'stream_1', event: { type: 'complete' } });
  m.frame();
  assert.match(m.q('[data-live="true"]').textContent, /Hello there, done/, 'the reply stays at the end');
  m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot({ messages: [message('m9', 'assistant', 'Hello there, done')] }) });
  assert.equal(m.q('[data-live="true"]'), null, 'the snapshot holds it now');
  assert.match(m.text('[data-conv-region="log"]'), /Hello there, done/);
  assert.doesNotMatch(m.text('[data-conv-region="log"]'), /edit_file/, 'a resync snapshot replaces the state');
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
  assert.equal(m.timers.size, 1, 'one timer paints what came after');
  m.advance(100);
  m.frame();
  assert.equal(m.renders.live, parsed + 1);
  assert.match(m.q('[data-live="true"]').textContent, /ab/);
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
  assert.ok(m.q('[data-live="true"]').textContent.trim().length <= 256 * 1024, 'the drawn reply is capped');
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
  assert.equal(m.timers.size, 0, 'no lease shown, no timer');
});

test('fix list M1: the driver who holds the lease keeps Stop for the whole turn; no expiry is invented; takeover and release', async (t) => {
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ active_turn: { stream_id: 'stream_7', status: 'running' } }) } });
  await flush();
  const sub = () => m.q('.team-head__sub').textContent;
  m.conv.push({ kind: 'lease', session_id: S1, held: true });
  assert.match(sub(), /You are driving/);
  assert.equal(m.timers.size, 0, 'a held lease has no clock');
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
  assert.match(m.q('[data-approval-status="resolved"]').textContent, /You asked the project’s admins to always allow edit_file here\./);
  await flush();
  assert.deepEqual(m.sent('conversationDecide'), [
    { team_id: OTHER, session_id: S1, stream_id: 'stream_1', approval_id: 'appr_1', decision_revision: 'rev_1', approved: true },
    { team_id: OTHER, session_id: S1, stream_id: 'stream_1', approval_id: 'appr_1', decision_revision: 'rev_1', approved: true, always: 'ask' }]);
  const receipt = m.q('[data-approval-status="resolved"]').textContent;
  assert.match(receipt, /^Allowed by You at .+ · asked by Lena’s turn Allowed once\. This project already has 16 requests waiting for its admins, so no new one was sent\.$/);
  assert.equal(m.q('.tool-approve-btn'), null, 'the card became the receipt');
  m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot({ pending_approvals: [approval({ approval_id: 'appr_2', call_id: 'call_2' }), approval({ approval_id: 'appr_3', call_id: 'call_3' })] }) });
  m.event('decision_changed', { stream_id: 'stream_1', approval_id: 'appr_2', approver_member_id: MAYA, prompter_member_id: LENA, approved: false });
  m.event('decision_changed', { stream_id: 'stream_1', approval_id: 'appr_3', prompter_member_id: LENA });
  const log = m.text('[data-conv-region="log"]');
  assert.match(log, /Denied by Maya at .+ · asked by Lena’s turn/);
  assert.match(log, /Withdrawn at .+: the turn no longer asks\./, 'a withdrawal names nobody');
  assert.doesNotMatch(log, /Allowed by Someone/);
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

test('caps at the edge and one past: 50 messages, 32 tool lines, 32 receipts, 16 outcome lines, 32 viewers; dispose leaves nothing', async (t) => {
  const many = (n) => Array.from({ length: n }, (_v, i) => message('m' + i, 'assistant', 'reply ' + i));
  const edge = mount(t, { open: { ok: true, snapshot: snapshot({ messages: many(50) }) } });
  await flush();
  assert.equal(edge.conv.resources().messages, 50);
  edge.restore();
  const outcomes = Array.from({ length: 17 }, (_v, i) => request({ request_seq: i + 1, asker_member_id: DOT, session_id: S1, state: 'allowed', answered_by: MAYA, outcome_tool: 'edit_file', rule_seq: i + 1 }));
  const m = mount(t, { answers: { projectRules: rulesAnswer({ requests: outcomes }) }, open: { ok: true, snapshot: snapshot({ messages: many(51), control: { member_id: MAYA, expires_at: 2_000_000 } }) } });
  await flush();
  assert.equal(m.conv.resources().messages, 50, 'one past: the oldest goes');
  assert.equal(m.q('[data-message-id="m0"]'), null);
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
    { timer: false, frame: false, listeners: 0, messages: 0, tools: 0, receipts: 0, outcomes: 0, answered: 0, cached: 0 });
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
    messages: [message('m1', 'user', 'hi', { author: { kind: 'member', member_id: 'member_evil' } })] }) } });
  await flush();
  m.event('chat_stream', { stream_id: 's', event: { type: 'started' } });
  m.event('chat_stream', { stream_id: 's', event: { type: 'tool_use', call_id: 'c', tool_name: evil('i') } });
  m.frame();
  m.conv.push({ kind: 'viewers', session_id: S1, viewers: ['member_evil'] });
  for (const seq of [4, 5]) m.conv.push({ kind: 'rule_answered', session_id: S1, request_seq: seq, outcome: 'allowed' });
  await flush();
  assert.equal(m.root.querySelector('[data-evil], [onclick], [onerror], img, script, em, u, s, q, i, code'), null, 'nothing parsed from the strings');
  assert.match(m.q('.team-head__name').textContent, /^<script data-evil/);
  const drawn = [...m.root.querySelectorAll('*')].filter((el) => !el.children.length && el.textContent.includes('‮')).map((el) => el.outerHTML.slice(0, 120));
  assert.deepEqual(drawn, [], 'no bidi control drawn');
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
  assert.match(region(h).querySelector('[data-conv-box="bar"]').textContent, /Sending makes you the driver/);
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

test('E68: a shared conversation has a standing line in its header before any message, saying who can read it, and nothing dismisses it', async (t) => {
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ messages: [] }) } });
  await flush();
  const line = m.q('[data-conv-region="head"] .team-head__sub[data-standing="true"]');
  assert.ok(line, 'the standing line is in the header');
  assert.equal(line.textContent, 'The team host and the member whose PC answers can read this conversation.');
  assert.equal(m.q('[data-conv-region="head"] .team-head__sub:not([data-standing])').textContent.includes('can read'), false, 'the driver line stays its own');
  assert.equal(m.root.querySelectorAll('[data-conv-region="head"] button').length, 1, 'only Back: no control closes the line');
  m.conv.push({ kind: 'viewers', session_id: S1, viewers: [DOT, MAYA] });
  assert.equal(m.q('[data-conv-region="head"] [data-standing="true"]').textContent, line.textContent, 'it survives a redraw of the header');
});
