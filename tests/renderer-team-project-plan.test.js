'use strict';

// new-test-file: row 175 item 7 (plan mode in a team conversation): the plan module (renderer/team/renderer-team-project-plan.js),
// its row in the conversation and the Plan chip, end to end in jsdom; the sibling conversation suites are at their line caps.

const test = require('node:test');
const assert = require('node:assert/strict');

const { S1, OTHER, DOT, MAYA, LENA, message, snapshot, approval, flush } = require('./helpers/team-project-renderer-host');
const { mount, field } = require('./helpers/team-conversation-mount');
const ipc = require('../services/team/ipc-methods');
const msgRow = require('../renderer/team/renderer-team-message-row');

const IDS = { team_id: OTHER, session_id: S1 };
const DECIDE = { ...IDS, stream_id: 'stream_1', approval_id: 'appr_plan', decision_revision: 'rev_1', approved: true };
// Main's own check takes the plan fields (row 175 round 2b-2).
assert.ok(ipc.validatePayload('conversationPreferences', { ...IDS, plan_mode: true }).ok);
assert.ok(ipc.validatePayload('conversationDecide', { ...DECIDE, plan_decision: 'rejected', feedback: 'smaller' }).ok);

const T0 = Date.parse('2026-11-12T10:31:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const ask = (id, content, turn, by = MAYA) => message(id, 'user', content, { author: { kind: 'member', member_id: by }, turn_id: turn, timestamp: at(0) });
const said = (id, content, turn) => message(id, 'assistant', content, { kind: undefined, turn_id: turn, timestamp: at(1) });
const STEPS = ['**Replace the hero line**: change `templates/home.html`', 'Run the build and count the characters'];
const planDoc = (over = {}) => ({ plan_id: 'plan_1', tool_call_id: 'call_plan', approval_id: 'appr_plan', title: 'Update the hero', summary: 'Two templates carry the old line.',
  steps: STEPS, verification: '`npm run build`', files_read: ['a.html', 'b.md'], state: 'pending', ...over });
const planMessage = (over = {}, turn = 'turn_1') => message('plan_1', 'assistant', 'Update the hero', { kind: 'plan_document', turn_id: turn, timestamp: at(2), plan_document: planDoc(over) });
const waiting = (over = {}) => approval({ approval_id: 'appr_plan', tool_name: 'exit_plan_mode', call_id: 'call_plan', stream_id: 'stream_1', prompter_member_id: MAYA, summary: 'Update the hero', ...over });
const running = { stream_id: 'stream_1', turn_id: 'turn_1', user_message_id: 'u1', status: 'running' };
const session = (over = {}) => ({ session_id: S1, title: 'Palette loader cleanup', revision: 'r1', plan_mode: true, file_tools: 'available', ...over });
const LENA_DRIVES = { member_id: LENA, expires_at: 2_000_000 };
// A plan waiting in the running turn.
const planned = (over = {}, sess = {}) => ({ ok: true, snapshot: snapshot({ session: session(sess),
  messages: [ask('u1', 'Plan the hero change', 'turn_1'), said('a1', 'Here is the plan.', 'turn_1'), planMessage()], active_turn: running, pending_approvals: [waiting()], ...over }) });
// A plan the host saved in `state`, nothing waiting.
const saved = (state, doc = {}, sess = {}, over = {}) => ({ ok: true, snapshot: snapshot({ session: session(sess),
  messages: [ask('u1', 'Plan the hero change', 'turn_1'), said('a1', 'Here is the plan.', 'turn_1'), planMessage({ state, ...doc })], ...over }) });
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
const click = (m, el) => el.dispatchEvent(new m.window.MouseEvent('click', { bubbles: true, cancelable: true }));
const planRow = (m) => m.q('[data-conv-region="live"] .plan-document, [data-conv-region="log"] .plan-document');
const buttons = (m) => [...planRow(m).querySelectorAll('[data-plan-actions] button')].map(text);
const button = (m, action) => m.q(`[data-project-action="${action}"]`);
const chip = (m) => m.q('#teamConvPlanChip');

test('plan row in the conversation: the read-only plan document and three decisions for a viewing writer', async (t) => {
  const m = mount(t, { open: planned() });
  await flush();
  const row = planRow(m);
  assert.ok(row, 'the plan document is in Jenny\'s row');
  assert.equal(m.q('[data-conv-region="live"] .plan-document'), row, 'in her live row');
  assert.equal(text(row.closest('.team-msg').querySelector('.team-msg__text')), 'Here is the plan.', 'her words stay hers, not the plan title');
  assert.ok(row.closest('.team-msg__foot'), 'after her words');
  assert.equal(row.querySelector('[data-plan-title], [data-plan-step-text], [draggable], [role="button"]'), null, 'no title or step editing');
  assert.deepEqual(buttons(m), ['Keep planning', 'Looks good, not yet', 'Build it']);
  assert.ok(!/auto mode/i.test(text(row)));
  assert.equal(m.q('.tool-approval-block'), null, 'no generic approval card for the plan');
  assert.equal(m.q('[data-team-batch]'), null);
  assert.equal(text(row.querySelector('.tool-approval-who')), 'Maya’s turn made this plan. Anyone who can write in this project and is viewing this conversation can decide it.');
  assert.match(text(row), /Update the heroTwo templates carry the old line\./);
  assert.match(text(row), /Replace the hero lineChange templates\/home\.html/);
});

test('plan row: a reader sees the plan and no buttons, only that a writer decides it', async (t) => {
  const m = mount(t, { role: 'reader', open: planned() });
  await flush();
  assert.ok(planRow(m));
  assert.equal(planRow(m).querySelector('button'), null);
  assert.equal(text(planRow(m).querySelector('.tool-approval-who')), 'Maya’s turn made this plan. A writer in this project decides it.');
});

test('plan row: a writer who is not driving keeps the buttons, and the box says who drives, with Take over', async (t) => {
  const m = mount(t, { open: planned({ control: LENA_DRIVES }) });
  await flush();
  assert.deepEqual(buttons(m), ['Keep planning', 'Looks good, not yet', 'Build it']);
  const locked = m.q('[data-conv-box="locked"]');
  assert.equal(text(locked), 'Lena is driving. You can decide the plan above.Take over');
  assert.ok(locked.querySelector('[data-project-action="takeover"]:not([disabled])'));
});

test('plan row: host text is escaped; a plan the host sent no plan_document for stands as the approval\'s own summary', async (t) => {
  const hostile = '<img src=x onerror=alert(1)>';
  const m = mount(t, { open: planned({ messages: [ask('u1', 'Plan', 'turn_1'), said('a1', 'Here', 'turn_1'),
    planMessage({ title: hostile, summary: hostile, steps: [hostile, '`' + hostile + '`'], notes: hostile, verification: hostile, files_read: [hostile] })] }) });
  await flush();
  assert.equal(planRow(m).querySelector('img'), null);
  assert.ok(planRow(m).innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;'));
  const bare = mount(t, { open: planned({ messages: [ask('u1', 'Plan', 'turn_1'), said('a1', 'Here', 'turn_1')] }) });
  await flush();
  assert.match(text(planRow(bare)), /Update the hero/);
  assert.deepEqual(buttons(bare), ['Keep planning', 'Looks good, not yet', 'Build it'], 'still decidable');
});

test('decisions: Build it, Looks good not yet and Keep planning (with its feedback) go through conversationDecide with a plan_decision', async (t) => {
  const answers = { conversationDecide: { ok: true } };
  const build = mount(t, { open: planned(), answers });
  await flush();
  click(build, button(build, 'plan-build'));
  await flush();
  assert.deepEqual(build.sent('conversationDecide'), [{ ...DECIDE, plan_decision: 'approved' }]);
  assert.equal(planRow(build), null, 'decided here: the waiting plan is gone');
  assert.match(text(build.q('.plan-document-receipt')), /Approved by Dot · .+/, 'the receipt names who and when');

  const accept = mount(t, { open: planned(), answers });
  await flush();
  click(accept, button(accept, 'plan-accept'));
  await flush();
  assert.deepEqual(accept.sent('conversationDecide'), [{ ...DECIDE, plan_decision: 'accepted' }]);
  assert.match(text(accept.q('.plan-document-receipt')), /Accepted by Dot · .+ · not built/);

  const keep = mount(t, { open: planned(), answers });
  await flush();
  click(keep, button(keep, 'plan-keep'));
  const feedback = keep.q('#teamPlanFeedback');
  assert.ok(feedback && keep.root.ownerDocument.activeElement === feedback, 'a small field, focused');
  assert.equal(feedback.maxLength, 800);
  assert.equal(keep.sent('conversationDecide').length, 0, 'asking for feedback decides nothing');
  feedback.value = 'Also cover the 404 page. ' + 'x'.repeat(900);
  click(keep, button(keep, 'plan-send'));
  await flush();
  const [sent] = keep.sent('conversationDecide');
  assert.deepEqual([sent.plan_decision, sent.approved, sent.feedback.length, sent.feedback.slice(0, 25)], ['rejected', true, 800, 'Also cover the 404 page. ']);
});

test('decisions: a refusal says why and keeps the plan waiting; the buttons are held while the call is out', async (t) => {
  let release;
  const m = mount(t, { open: planned(), answers: { conversationDecide: () => new Promise((resolve) => { release = resolve; }) } });
  await flush();
  click(m, button(m, 'plan-build'));
  assert.deepEqual([...planRow(m).querySelectorAll('[data-plan-actions] button')].map((b) => b.disabled), [true, true, true]);
  release({ ok: false, error: { code: 'CMP-TEAM-0001', reason: 'stale_decision' } });
  await flush();
  assert.ok(planRow(m), 'still waiting');
  assert.ok(planRow(m).querySelector('.team-set-note'), 'the sentence');
  assert.ok([...planRow(m).querySelectorAll('[data-plan-actions] button')].every((b) => !b.disabled));
});

test('the Plan chip: beside Tools; a writer turns it on by click and off by Shift+Tab; the hint and the field say so; the host\'s answer decides', async (t) => {
  const m = mount(t, { open: saved('accepted', {}, { plan_mode: false }) });
  await flush();
  const left = [...m.q('[data-conv-box="left"]').children].map((el) => [...el.classList].find((c) => /^team-conv-ctl--/.test(c)) || '').filter(Boolean);
  assert.deepEqual(left, ['team-conv-ctl--tools', 'team-conv-ctl--plan', 'team-conv-ctl--model']);
  assert.deepEqual([chip(m).getAttribute('aria-pressed'), chip(m).hasAttribute('aria-disabled'), text(chip(m))], ['false', false, 'Plan']);
  assert.equal(field(m).placeholder, 'Message “Palette loader cleanup”');
  click(m, chip(m));
  await flush();
  assert.deepEqual(m.sent('conversationPreferences'), [{ ...IDS, plan_mode: true }]);
  assert.equal(chip(m).getAttribute('aria-pressed'), 'true');
  assert.equal(text(m.q('.team-composer__hint')), 'Plan mode · nothing changes until a plan is accepted');
  assert.equal(field(m).placeholder, 'Ask Jenny for a plan');
  const tab = new m.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
  field(m).dispatchEvent(tab);
  await flush();
  assert.equal(tab.defaultPrevented, true);
  assert.deepEqual(m.sent('conversationPreferences').map((p) => p.plan_mode), [true, false]);
  assert.equal(chip(m).getAttribute('aria-pressed'), 'false');
});

test('the Plan chip: greyed, never hidden, with its reason: a reader, somebody else driving, a turn running, a plan waiting', async (t) => {
  const reasons = async (opts, open) => { const m = mount(t, { ...opts, open }); await flush(); return { m, title: chip(m).title, off: chip(m).getAttribute('aria-disabled') }; };
  const reader = await reasons({ role: 'reader' }, saved('accepted'));
  assert.deepEqual([reader.off, reader.title.endsWith('Only writers and admins can change plan mode.')], ['true', true]);
  const other = await reasons({}, saved('accepted', {}, {}, { control: LENA_DRIVES }));
  assert.ok(other.title.endsWith('Lena is driving. You can change plan mode when you drive.'));
  assert.equal(other.off, 'true');
  const going = await reasons({}, { ok: true, snapshot: snapshot({ session: session(), active_turn: running }) });
  assert.ok(going.title.endsWith('Changes apply from the next turn.'));
  const plan = await reasons({}, planned());
  assert.ok(plan.title.endsWith('A plan is waiting for a decision. Decide it first.'));
  click(plan.m, chip(plan.m));
  assert.equal(plan.m.sent('conversationPreferences').length, 0, 'a greyed chip changes nothing');
  assert.ok(plan.m.q('[data-conv-box="left"] #teamConvPlanChip'), 'in the box');
  assert.ok(other.m.q('[data-conv-box="left"] #teamConvPlanChip'), 'kept in the locked box too');
});

test('an accepted plan folds into the local receipt with who and when, and keeps Build it while plan mode is on', async (t) => {
  const m = mount(t, { open: saved('accepted', { decided_by: MAYA, decided_at: at(60) }, {}, { control: { member_id: DOT, expires_at: 2_000_000 } }) });
  await flush();
  const receipt = m.q('.plan-document-receipt');
  assert.equal(text(receipt.querySelector('.plan-document-receipt__state')), `Accepted by Maya · ${msgRow.timeText(at(60))} · not built`);
  assert.equal(receipt.getAttribute('data-plan-state'), 'accepted');
  assert.equal(m.q('.plan-document'), null, 'no decisions on a decided plan');
  assert.ok(button(m, 'plan-build-accepted'), 'Build it kept');
  assert.equal(m.q('.team-plan-act .tool-approval-who'), null, 'the driver builds as themselves');
  const reader = mount(t, { role: 'reader', open: saved('accepted') });
  await flush();
  assert.equal(button(reader, 'plan-build-accepted'), null);
  const off = mount(t, { open: saved('accepted', {}, { plan_mode: false }) });
  await flush();
  assert.equal(button(off, 'plan-build-accepted'), null, 'plan mode already off: built');
});

test('a built plan reads "Approved by"; its receipt keeps no Build it', async (t) => {
  const m = mount(t, { open: saved('approved', { decided_by: DOT, decided_at: at(120) }, { plan_mode: false }) });
  await flush();
  assert.equal(text(m.q('.plan-document-receipt__state')), `Approved by Dot · ${msgRow.timeText(at(120))}`);
  assert.equal(button(m, 'plan-build-accepted'), null);
});

test('Build it on an accepted plan by a writer who is not driving: take over, plan mode off, then the turn as that writer', async (t) => {
  const answers = { conversationControl: { ok: true }, conversationPreferences: { ok: true }, conversationSend: { ok: true } };
  const m = mount(t, { open: saved('accepted', {}, {}, { control: LENA_DRIVES }), answers });
  await flush();
  assert.equal(text(m.q('.team-plan-act .tool-approval-who')), 'Build it starts a turn as you and makes you the driver.');
  click(m, button(m, 'plan-build-accepted'));
  await flush();
  assert.deepEqual(m.calls.map((c) => c.method).filter((x) => /^conversation(Control|Preferences|Send)$/.test(x)), ['conversationControl', 'conversationPreferences', 'conversationSend']);
  assert.deepEqual(m.sent('conversationControl'), [{ ...IDS, action: 'takeover' }]);
  assert.deepEqual(m.sent('conversationPreferences'), [{ ...IDS, plan_mode: false }]);
  assert.deepEqual(m.sent('conversationSend'), [{ ...IDS, prompt: 'Build the accepted plan.' }]);
  assert.equal(chip(m).getAttribute('aria-pressed'), 'false');
});

test('Build it stops where the host refuses the take-over: no plan-mode change, no turn', async (t) => {
  const refused = { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'busy' } };
  const m = mount(t, { open: saved('accepted', {}, {}, { control: LENA_DRIVES }), answers: { conversationControl: refused } });
  await flush();
  click(m, button(m, 'plan-build-accepted'));
  await flush();
  assert.deepEqual([m.sent('conversationPreferences').length, m.sent('conversationSend').length], [0, 0]);
});

test('another member\'s decision: no generic receipt; the plan then reads as the host saved it', async (t) => {
  const m = mount(t, { open: planned() });
  await flush();
  m.event('decision_changed', { stream_id: 'stream_1', approval_id: 'appr_plan', approved: true, approver_member_id: MAYA, prompter_member_id: MAYA, plan_decision: 'accepted' });
  await flush();
  assert.equal(m.q('.team-conv__receipts .tool-approval-receipt'), null, 'not an "allowed this" line');
  assert.equal(planRow(m), null);
  assert.match(text(m.q('.plan-document-receipt__state')), /^Accepted by Maya · .+ · not built$/);
});

test('in Jenny\'s work the plan is a one-line receipt: waiting for a decision, no buttons', async (t) => {
  const m = mount(t, { open: planned() });
  await flush();
  click(m, m.q('.team-turn-chip'));
  await flush();
  const pop = m.q('#teamTurnPop');
  assert.ok(pop);
  assert.equal(text(pop.querySelector('.plan-document-receipt .plan-document-receipt__state')), 'Waiting for a decision');
  assert.equal(pop.querySelector('.plan-document, [data-plan-actions]'), null);
  assert.equal(pop.querySelector('[data-project-action^="plan-"]'), null);
});

test('the conversation says who changed plan mode, in the quiet line the Tools changes use', async (t) => {
  const state = (plan) => ({ model: null, effort: 'default', read: true, write: true, plan });
  const log = [{ at: at(-30), by: MAYA, from: state(false), to: state(true) }];
  const m = mount(t, { open: saved('accepted', {}, { preference_log: log }) });
  await flush();
  const line = text(m.q('.team-conv-note'));
  assert.match(line, /^Maya turned on plan mode: Jenny plans and changes nothing until a plan is accepted · .+/);
});
