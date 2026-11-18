'use strict';

// new-test-file: row 172 (a new surface: the Tools chip, the model pill and the folded settings line); the conversation
// suites are at their line caps.
// The log folding is pure (renderer/team/renderer-team-conversation-controls.js `foldLog`); the controls are driven in the
// real conversation (tests/helpers/team-conversation-mount.js) over fake snapshots and a fake GPU list.

const test = require('node:test');
const assert = require('node:assert/strict');

const controls = require('../renderer/team/renderer-team-conversation-controls');
const { S1, OTHER, DOT, MAYA, LENA, message, snapshot, flush } = require('./helpers/team-project-renderer-host');
const { mount, field, type } = require('./helpers/team-conversation-mount');

const T0 = Date.parse('2026-11-16T15:40:00.000Z');
const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
const values = (over = {}) => ({ model: null, effort: 'default', read: true, write: true, ...over });
const entry = (minutes, by, from, to) => ({ at: at(minutes), by, from: values(from), to: values(to) });
const NAMES = { member_sam: 'Sam', member_dot: 'Dot' };
const fold = (log, stamps = []) => controls.foldLog(log, stamps.map((m) => T0 + m * 60_000), { nameOf: (id) => NAMES[id] || '', timeText: (v) => String(v).slice(11, 16) });
const lines = (notes) => notes.map((n) => n.text);
const SAM = 'member_sam';

// ------------------------------------------------------------------ the folded log

test('foldLog: three changes by one member are one line with the net result, at the last change', () => {
  const log = [entry(1, SAM, {}, { model: 'gemma4-12b' }), entry(2, SAM, { model: 'gemma4-12b' }, { model: 'gemma4-12b', write: false }),
    entry(3, SAM, { model: 'gemma4-12b', write: false }, { model: 'gemma4-12b', write: false, effort: 'high' })];
  const notes = fold(log);
  assert.deepEqual(lines(notes), ['Sam set Jenny to gemma4-12b and set thinking to High and turned off Write and edit files · 15:43']);
  assert.equal(notes[0].at, T0 + 3 * 60_000);
  assert.match(notes[0].html, /^<div class="team-conv-note" role="note" dir="auto"><b>Sam<\/b> set Jenny to gemma4-12b/);
});

test('foldLog: a group that nets no change draws nothing; a change undone inside the group is not said', () => {
  assert.deepEqual(fold([entry(1, SAM, {}, { write: false }), entry(2, SAM, { write: false }, {})]), []);
  const net = fold([entry(1, SAM, {}, { model: 'a' }), entry(2, SAM, { model: 'a' }, { model: 'a', read: false }), entry(3, SAM, { model: 'a', read: false }, { read: false })]);
  assert.deepEqual(lines(net), ['Sam turned off Read and search files · 15:43']);
});

test('foldLog: a message or a turn between two changes makes two lines; two members alternating make separate lines', () => {
  const log = [entry(1, SAM, {}, { write: false }), entry(5, SAM, { write: false }, { write: false, effort: 'low' })];
  assert.deepEqual(lines(fold(log)), ['Sam set thinking to Low and turned off Write and edit files · 15:45']);
  assert.deepEqual(lines(fold(log, [3])), ['Sam turned off Write and edit files · 15:41', 'Sam set thinking to Low · 15:45']);
  assert.deepEqual(lines(fold(log, [0, 9])), ['Sam set thinking to Low and turned off Write and edit files · 15:45'], 'messages outside the group do not split it');
  const two = [entry(1, SAM, {}, { model: 'a' }), entry(2, 'member_dot', { model: 'a' }, { model: 'b' }), entry(3, SAM, { model: 'b' }, { model: 'c' })];
  assert.deepEqual(lines(fold(two)), ['Sam set Jenny to a · 15:41', 'Dot set Jenny to b · 15:42', 'Sam set Jenny to c · 15:43']);
});

test('foldLog review fix: changes older than the oldest held message stay apart', () => {
  const log = [entry(1, SAM, {}, { model: 'a' }), entry(2, SAM, { model: 'a' }, {}), entry(6, SAM, {}, { write: false }), entry(7, SAM, { write: false }, { write: false, read: false })];
  // A message at 15:45 is the oldest held: one may stand between 15:41 and 15:42 on a page not read, so those two stay apart.
  assert.deepEqual(lines(fold(log, [5])), ['Sam set Jenny to a · 15:41', 'Sam set Jenny back to the team default · 15:42',
    'Sam turned off Read and search files and turned off Write and edit files · 15:47']);
});

test('the channel reads a numeric message time (a host may send one) when it splits a group', async (t) => {
  const log = [entry(4, DOT, {}, { write: false }), entry(6, DOT, { write: false }, {})];
  const messages = [message('m_old', 'user', 'first', { timestamp: at(-5), author: { kind: 'member', member_id: MAYA } }),
    message('m_num', 'user', 'between', { timestamp: T0 + 5 * 60_000, author: { kind: 'member', member_id: MAYA } })];
  const m = mount(t, { open: opened({ preference_log: log }, { messages }), gpus: GPUS });
  await flush();
  // Without the numeric 15:45 the 15:44 and 15:46 changes would fold into one group that nets nothing and draws no line.
  assert.deepEqual([...m.root.querySelectorAll('.team-conv-note')].map((el) => text(el).replace(/ · .*/, '')),
    ['Dot turned off Write and edit files', 'Dot turned on Write and edit files']);
});

test('foldLog: a plan mode change is one quiet line; it folds with the other changes of one member and an older entry without it reads as off (row 175 item 7)', () => {
  const plan = (on) => ({ plan: on });
  assert.deepEqual(lines(fold([entry(1, SAM, plan(false), plan(true))])), ['Sam turned on plan mode: Jenny plans and changes nothing until a plan is accepted · 15:41']);
  assert.deepEqual(lines(fold([entry(1, SAM, plan(true), plan(false))])), ['Sam turned off plan mode · 15:41']);
  assert.deepEqual(lines(fold([entry(1, SAM, {}, plan(true)), entry(2, SAM, plan(true), { plan: true, write: false })])),
    ['Sam turned off Write and edit files and turned on plan mode: Jenny plans and changes nothing until a plan is accepted · 15:42']);
  assert.deepEqual(fold([entry(1, SAM, plan(true), plan(true))]), [], 'no change');
  assert.deepEqual(fold([entry(1, SAM, {}, plan(true)), entry(2, SAM, plan(true), {})]), [], 'turned on and off again nets nothing');
  assert.deepEqual(fold([{ at: at(1), by: SAM, from: { model: null, effort: 'default', read: true, write: true }, to: { model: null, effort: 'default', read: true, write: true } }]), [], 'an older host sends no plan');
});

test('foldLog: the words for the team default, thinking and a switch turned back on; an unknown member and hostile entries', () => {
  assert.deepEqual(lines(fold([entry(1, SAM, { model: 'a', effort: 'high', write: false }, { model: null, effort: 'default', write: true })])),
    ['Sam set Jenny back to the team default and set thinking to Default and turned on Write and edit files · 15:41']);
  assert.deepEqual(lines(fold([entry(1, null, {}, { model: 'a' }), entry(2, 'member_gone', { model: 'a' }, { model: 'b' })])), ['Someone set Jenny to a · 15:41', 'Someone set Jenny to b · 15:42']);
  const hostile = [null, 'x', { at: 'never' }, { at: at(1), by: SAM, from: 7, to: { model: '<img src=x onerror=1>' } }];
  const [line] = fold(hostile);
  assert.ok(line.html.includes('&lt;img src=x onerror=1&gt;') && !line.html.includes('<img'), 'escaped');
  assert.deepEqual(fold('nothing'), []);
});

// ------------------------------------------------------------------ the controls in the conversation

const click = (m, el) => el.dispatchEvent(new m.window.MouseEvent('click', { bubbles: true, cancelable: true }));
const key = (m, el, name) => el.dispatchEvent(new m.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
const node = (member, label, models) => ({ node_id: 'node_' + member, member_id: member, label, online: true, paused: false, busy_slots: 0, slots: 1, models });
const GPUS = { team_model: 'qwen3.8-27b', nodes: [node(DOT, 'Dot PC', [{ name: 'qwen3.8-27b', thinking: true }]),
  node(MAYA, 'Maya PC', [{ name: 'gemma4-12b', thinking: false }, { name: 'qwen3.8-27b-board', thinking: true }])] };
const session = (over = {}) => ({ session_id: S1, title: 'Palette loader cleanup', revision: 'r1', plan_mode: false, file_tools: 'available', ...over });
const opened = (over = {}, rest = {}) => ({ ok: true, snapshot: snapshot({ session: session(over), ...rest }) });
const chip = (m) => m.q('#teamConvToolsChip');
const pill = (m) => m.q('#teamConvModelPill');
const sent = (m) => m.sent('conversationPreferences');
const ids = { team_id: OTHER, session_id: S1 };
const switchOf = (m, id) => m.q('#teamPrefSwitch-' + id);
const option = (m, name) => [...m.root.querySelectorAll('[data-pref-model]')].find((el) => el.dataset.prefModel === name);
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
// What a reader hears: each piece of text on its own, so a row's label and its sub line are not run together.
const spoken = (el) => { const walk = el.ownerDocument.createTreeWalker(el, 4); const out = []; while (walk.nextNode()) out.push(walk.currentNode.nodeValue.trim()); return out.filter(Boolean).join(' '); };

test('the bar: code, @, attach and the mic, the Tools chip, the hint, the model pill, Send; the shipped classes; no "Jenny answers with"', async (t) => {
  const m = mount(t, { open: opened(), gpus: GPUS });
  await flush();
  const parts = [...m.q('[data-conv-box="left"]').children].map((el) => (el.matches('.team-icon-btn') ? 'icon' : [...el.classList].find((c) => /^team-(conv-ctl--|composer__hint)/.test(c))));
  assert.deepEqual(parts, ['icon', 'icon', 'icon', 'icon', 'team-conv-ctl--tools', 'team-conv-ctl--plan', 'team-composer__hint', 'team-conv-ctl--model']);
  assert.ok(m.q('[data-conv-box="bar"] [data-project-action="send"]'));
  assert.deepEqual([chip(m).className, pill(m).className], ['inv-chip composer-tools-chip', 'inv-chip composer-model-pill']);
  assert.deepEqual([text(chip(m)), text(pill(m)), pill(m).title], ['Tools', 'qwen3.8-27b', 'The team default, set by the host in Settings › Team']);
  assert.equal(pill(m).querySelector('.composer-model-pill-dot').classList.contains('status-dot--ok'), true, 'the default is offered');
  assert.doesNotMatch(m.q('[data-conv-region="box"]').textContent, /Jenny answers with/);
  assert.equal(m.q('[data-conv-box="left"] [data-team-tab-action="share-settings"]'), null);
});

test('the Tools panel: title, tally, section, rows with their tool names, the always-on line; one popover at a time; Escape and an outside click close it', async (t) => {
  const m = mount(t, { open: opened(), gpus: GPUS });
  await flush();
  click(m, chip(m));
  const panel = m.q('.composer-chat-panel');
  assert.equal(panel.getAttribute('role'), 'dialog');
  assert.deepEqual([chip(m).getAttribute('aria-expanded'), panel.contains(m.root.ownerDocument.activeElement)], ['true', true], 'the focus goes in');
  assert.equal(spoken(panel), 'Tools for this conversation 2 of 2 on In this project · jenny-site Read and search files Look through this project’s team files 4 tools read_file , list_dir , glob_files , grep_search '
    + 'Write and edit files Each change asks a writer first, unless a project rule allows it 3 tools write_file , edit_file , propose_change Always on: questions For everyone in this conversation');
  assert.equal(panel.querySelector('[data-pref-reset]'), null, 'nothing to reset');
  assert.equal(m.q('#teamPrefMembers-read').hidden, true);
  click(m, panel.querySelector('[data-pref-members="read"]'));
  assert.equal(m.q('#teamPrefMembers-read').hidden, false);
  click(m, pill(m));
  assert.deepEqual([m.q('.composer-chat-panel'), Boolean(m.q('.composer-model-popover'))], [null, true], 'one at a time');
  key(m, m.q('.composer-model-popover [data-pref-model=""]'), 'Escape');
  assert.deepEqual([m.q('.composer-model-popover'), m.root.ownerDocument.activeElement === pill(m)], [null, true], 'Escape closes and the pill gets the focus back');
  click(m, chip(m));
  m.root.ownerDocument.body.dispatchEvent(new m.window.MouseEvent('click', { bubbles: true }));
  assert.equal(m.q('.composer-chat-panel'), null, 'a click outside closes it');
  assert.equal(sent(m).length, 0);
});

test('a switch asks the host, and the chip counts what the host accepted; Reset to defaults sends both on', async (t) => {
  const m = mount(t, { open: opened(), gpus: GPUS });
  await flush();
  click(m, chip(m));
  click(m, switchOf(m, 'write'));
  assert.deepEqual(sent(m), [{ ...ids, team_tools: { write: false } }]);
  await flush();
  assert.deepEqual([text(chip(m)), chip(m).classList.contains('composer-tools-chip--off'), switchOf(m, 'write').getAttribute('aria-checked'), text(m.q('.composer-chat-panel-tally'))], ['Tools1 off', true, 'false', '1 of 2 on']);
  click(m, m.q('[data-pref-reset]'));
  assert.deepEqual(sent(m)[1], { ...ids, team_tools: { read: true, write: true } });
  await flush();
  assert.deepEqual([text(chip(m)), m.q('[data-pref-reset]')], ['Tools', null]);
});

test('a refused change says why in the box and draws the snapshot as it was', async (t) => {
  const m = mount(t, { open: opened(), gpus: GPUS, answers: { conversationPreferences: { ok: false, error: { reason: 'lease_required' } } } });
  await flush();
  click(m, chip(m));
  click(m, switchOf(m, 'read'));
  await flush();
  assert.equal(switchOf(m, 'read').getAttribute('aria-checked'), 'true');
  assert.equal(text(chip(m)), 'Tools');
  assert.ok(m.q('[data-conv-box="below"] .team-drive__note').textContent.length > 0, 'the note line names the refusal');
});

test('the model picker: Team default first, the models grouped by their PC\'s owner, a pick that cannot think resets the effort in the same call', async (t) => {
  const m = mount(t, { open: opened(), gpus: GPUS });
  await flush();
  click(m, pill(m));
  const list = m.q('.composer-model-picker-list');
  assert.deepEqual([...list.children].map((el) => text(el)), ['Team default · qwen3.8-27b', 'On Dot’s PC', 'qwen3.8-27b', 'On Maya’s PC', 'gemma4-12b', 'qwen3.8-27b-board']);
  assert.equal(m.q('.composer-model-picker-option.is-active').dataset.prefModel, '', 'the default is the active option');
  assert.deepEqual([...m.root.querySelectorAll('.composer-model-picker-segment')].map(text), ['Default', 'Low', 'Medium', 'High'], 'the default model thinks');
  assert.equal(text(m.q('.composer-model-popover .inv-popover-footer')), 'Applies to this conversation, for everyone in it. The team default lives in Settings › Team.');
  click(m, option(m, 'gemma4-12b'));
  assert.deepEqual(sent(m), [{ ...ids, preferred_model: 'gemma4-12b', reasoning_effort: 'default' }]);
  await flush();
  assert.deepEqual([m.q('.composer-model-popover'), text(pill(m)), pill(m).title], [null, 'gemma4-12b', 'Picked for this conversation']);
  click(m, pill(m));
  assert.equal(m.q('.composer-model-picker-thinking'), null, 'no segments for a model that cannot think');
  click(m, option(m, 'qwen3.8-27b-board'));
  assert.deepEqual(sent(m)[1], { ...ids, preferred_model: 'qwen3.8-27b-board' });
  await flush();
  click(m, pill(m));
  click(m, m.q('[data-pref-effort="high"]'));
  assert.deepEqual(sent(m)[2], { ...ids, reasoning_effort: 'high' });
  await flush();
  assert.equal(text(pill(m)), 'qwen3.8-27b-board · High');
  assert.ok(m.q('.composer-model-popover'), 'the effort segments leave the picker open');
  key(m, m.q('[data-pref-effort="high"]'), 'ArrowLeft');
  assert.deepEqual(sent(m)[3], { ...ids, reasoning_effort: 'medium' }, 'the arrows step the segments');
  await flush();
  click(m, option(m, ''));
  assert.deepEqual(sent(m)[4], { ...ids, preferred_model: null }, 'the team default thinks, so the effort stays');
});

test('the snapshot is the truth: the pill and the chip follow it, and a newer snapshot replaces what the host accepted', async (t) => {
  const m = mount(t, { open: opened({ preferred_model: 'gemma4-12b', reasoning_effort: 'low', team_tools: { read: true, write: false } }), gpus: GPUS });
  await flush();
  assert.deepEqual([text(pill(m)), text(chip(m))], ['gemma4-12b · Low', 'Tools1 off']);
  m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot({ session: session({ preferred_model: 'qwen3.8-27b-board', reasoning_effort: 'high' }) }) });
  assert.deepEqual([text(pill(m)), text(chip(m))], ['qwen3.8-27b-board · High', 'Tools']);
});

test('a host with no file access: both switches off and disabled with the reason, the chip says so', async (t) => {
  const m = mount(t, { open: opened({ file_tools: 'unavailable', team_tools: { read: true, write: true } }), gpus: GPUS });
  await flush();
  assert.equal(text(chip(m)), 'Toolsoff on this host');
  click(m, chip(m));
  assert.deepEqual(['read', 'write'].map((id) => [switchOf(m, id).disabled, switchOf(m, id).getAttribute('aria-checked')]), [[true, 'false'], [true, 'false']]);
  assert.equal(m.root.querySelectorAll('.composer-tool-warn').length, 2);
  assert.equal(text(m.q('.composer-tool-sub')), 'Off on this host: file access on this team host is not available yet');
  assert.equal(text(m.q('.composer-chat-panel-tally')), '0 of 2 on');
  click(m, switchOf(m, 'read'));
  assert.equal(sent(m).length, 0);
  const older = mount(t, { open: { ok: true, snapshot: snapshot() }, gpus: GPUS });
  await flush();
  assert.equal(text(chip(older)), 'Toolsoff on this host', 'an older host sends nothing: the same');
});

test('somebody else drives: both controls disabled, not hidden; the popovers open read-only with the driver line; no call', async (t) => {
  const m = mount(t, { open: opened({}, { control: { member_id: MAYA, expires_at: 0 } }), gpus: GPUS });
  await flush();
  assert.deepEqual([chip(m).getAttribute('aria-disabled'), pill(m).getAttribute('aria-disabled')], ['true', 'true']);
  assert.equal(m.q('[data-conv-box="composer"]').hidden, true, 'the sentence stands in the field\'s place; the two controls stay');
  click(m, chip(m));
  assert.equal(text(m.q('.composer-chat-panel .team-conv-ro')), 'Maya is driving. Take control to change these.');
  assert.deepEqual(['read', 'write'].map((id) => switchOf(m, id).disabled), [true, true]);
  click(m, switchOf(m, 'write'));
  click(m, pill(m));
  assert.equal(text(m.q('.composer-model-popover .team-conv-ro')), 'Maya is driving. Take control to change these.');
  assert.equal([...m.root.querySelectorAll('[data-pref-model]')].every((el) => el.disabled), true);
  click(m, option(m, 'gemma4-12b'));
  assert.equal(sent(m).length, 0);
});

test('a reader gets the same disabled controls with their own reason', async (t) => {
  const m = mount(t, { role: 'reader', open: opened(), gpus: GPUS });
  await flush();
  click(m, chip(m));
  assert.equal(text(m.q('.composer-chat-panel .team-conv-ro')), 'Only writers and admins can change these.');
  assert.equal(chip(m).getAttribute('aria-disabled'), 'true');
});

test('while a turn runs both lock: "Changes apply from the next turn."', async (t) => {
  const m = mount(t, { open: opened({}, { active_turn: { stream_id: 'stream_1', turn_id: 'turn_1', user_message_id: 'm1', status: 'running' } }), gpus: GPUS });
  await flush();
  assert.deepEqual([chip(m).getAttribute('aria-disabled'), pill(m).getAttribute('aria-disabled')], ['true', 'true']);
  click(m, chip(m));
  assert.equal(text(m.q('.composer-chat-panel .team-conv-ro')), 'Changes apply from the next turn.');
  click(m, switchOf(m, 'write'));
  assert.equal(sent(m).length, 0);
  click(m, pill(m));
  assert.equal(text(m.q('.composer-model-popover .team-conv-ro')), 'Changes apply from the next turn.');
});

test('a picked model whose PC left: the error dot, the line above, Send held, and the button goes back to the team default', async (t) => {
  const m = mount(t, { open: opened({ preferred_model: 'qwen3.8-27b-gone', reasoning_effort: 'high' }), gpus: GPUS });
  await flush();
  assert.equal(pill(m).querySelector('.composer-model-pill-dot').classList.contains('status-dot--error'), true);
  assert.equal(spoken(m.q('[data-conv-box="above"]')), 'qwen3.8-27b-gone is offline. Pick another model or use the team default. Use the team default');
  assert.equal(m.q('[data-conv-box="bar"] [data-project-action="send"]').disabled, true);
  type(m, 'Hello');
  key(m, field(m), 'Enter');
  assert.equal(m.sent('conversationSend').length, 0, 'Enter sends nothing either');
  click(m, pill(m));
  const gone = option(m, 'qwen3.8-27b-gone');
  assert.deepEqual([gone.classList.contains('is-unavailable'), gone.disabled, text(gone.querySelector('.composer-model-picker-meta'))], [true, true, 'offline']);
  click(m, m.q('[data-project-action="pref-default"]'));
  assert.deepEqual(sent(m), [{ ...ids, preferred_model: null }]);
  await flush();
  assert.equal(m.q('[data-conv-box="above"] .team-drive'), null);
  assert.equal(m.q('[data-conv-box="bar"] [data-project-action="send"]').disabled, false);
});

test('review fixes: a model name the host would refuse is not offered; Team default with no listed model keeps the effort', async (t) => {
  const gpus = { team_model: '', nodes: [node(DOT, 'Dot PC', [{ name: 'qwen3.8-27b', thinking: true }, { name: 'modèle-é', thinking: true }])] };
  const m = mount(t, { open: opened({ reasoning_effort: 'high' }), gpus: { ...gpus, nodes: [...gpus.nodes, node(MAYA, 'Maya PC', [{ name: 'gemma4-12b', thinking: false }])] } });
  await flush();
  click(m, pill(m));
  assert.equal(option(m, 'modèle-é'), undefined, 'a non-ASCII name is not listed');
  assert.ok(m.q('.composer-model-picker-thinking'), 'Automatic: the segments show while an offered model thinks');
  click(m, option(m, 'gemma4-12b'));
  await flush();
  click(m, pill(m));
  click(m, option(m, ''));
  assert.deepEqual(sent(m)[1], { ...ids, preferred_model: null }, 'Automatic keeps the effort (the gateway drops it for a model that does not think)');
});

test('a team whose GPU list is not read yet claims nothing: no offline line, no dot', async (t) => {
  const m = mount(t, { open: opened({ preferred_model: 'anything' }) });
  await flush();
  assert.deepEqual([m.q('[data-conv-box="above"] .team-drive'), pill(m).querySelector('.composer-model-pill-dot'), text(pill(m))], [null, null, 'anything']);
});

test('the channel draws the folded lines between the rows in time order; a member message splits a group', async (t) => {
  const when = (sec) => new Date(Date.parse('2026-11-12T10:31:00.000Z') + sec * 1000).toISOString();
  const log = [{ at: when(30), by: DOT, from: values(), to: values({ write: false }) }, { at: when(100), by: DOT, from: values({ write: false }), to: values({ write: false, model: 'gemma4-12b' }) },
    { at: when(400), by: LENA, from: values({ write: false, model: 'gemma4-12b' }), to: values({ write: false }) }];
  const messages = [message('m1', 'user', 'First', { timestamp: when(0), author: { kind: 'member', member_id: MAYA } }), message('m2', 'assistant', 'Answer', { kind: undefined, timestamp: when(5) }),
    message('m3', 'user', 'Second', { timestamp: when(60), author: { kind: 'member', member_id: MAYA } })];
  const m = mount(t, { open: opened({ preference_log: log }, { messages }), gpus: GPUS });
  await flush();
  const order = [...m.root.querySelectorAll('[data-conv-region="log"] > *')].filter((el) => !el.matches('.team-day'))
    .map((el) => (el.matches('.team-conv-note') ? text(el).replace(/ · .*/, '') : el.dataset.messageId || 'jenny'));
  assert.deepEqual(order, ['m1', 'jenny', 'Dot turned off Write and edit files', 'm3', 'Dot set Jenny to gemma4-12b', 'Lena set Jenny back to the team default']);
});
