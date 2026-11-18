'use strict';

// new-test-file: row 171 channel builders; tests/renderer-team-project-timeline.test.js is at the 600-line cap
// The pure pieces of a Team project conversation drawn as a channel: the turns grouped from the host's messages, the
// working chip and its line, the additive `lead` slot of the #team row, the channel rows, the channel shell and the
// #team composer parts.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const action = require('../renderer/inventory/action-button');
const tl = require('../renderer/team/renderer-team-project-timeline');
const messageRow = require('../renderer/team/renderer-team-message-row');
const parts = require('../renderer/team/renderer-team-project-conversation-parts');
const projectRows = require('../renderer/team/renderer-team-project-rows');
const box = require('../renderer/team/renderer-team-project-box');

globalThis.inventory = { actionButton: action.actionButton || action };

const parse = (html) => {
  const dom = new JSDOM('<!doctype html><body></body>');
  dom.window.document.body.innerHTML = html;
  return dom.window.document.body;
};
const HOSTILE = '<img src=x onerror=alert(1)>‮"\'&';
const T0 = '2026-11-12T10:31:00.000Z';
const at = (seconds) => new Date(Date.parse(T0) + seconds * 1000).toISOString();
const user = (id, content, extra = {}) => ({ id, role: 'user', kind: 'message', content, status: 'complete', timestamp: at(0), author: { kind: 'member', member_id: 'member_maya' }, ...extra });
const said = (id, content, extra = {}) => ({ id, role: 'assistant', kind: 'message', content, status: 'complete', timestamp: at(1), ...extra });
const toolUse = (id, extra = {}) => ({ id, role: 'assistant', kind: 'tool_use', content: '', status: 'complete', timestamp: at(2),
  tool_call: { call_id: 'call_' + id, tool_name: 'read_file', input_json: '{"path":"index.html"}', status: 'complete' }, ...extra });
const toolResult = (id, extra = {}) => ({ id, role: 'tool', kind: 'tool_result', content: '', status: 'complete', timestamp: at(3),
  tool_result: { call_id: 'call_u', tool_name: 'read_file', output_text: 'x', is_error: false }, ...extra });
const kinds = (items) => items.map((i) => (i.kind === 'member' ? 'member:' + i.message.id : 'turn:' + i.id));

// ------------------------------------------------------------------ (a) groupTurns

test('groupTurns: one turn_id gives one member item and one turn with its tools, last text and prompt', () => {
  const messages = [user('u1', 'Check index.html', { turn_id: 'turn_1' }), said('a1', 'Reading it.', { turn_id: 'turn_1' }), toolUse('u', { turn_id: 'turn_1' }),
    toolResult('r', { turn_id: 'turn_1' }), said('a2', 'It says hello.', { turn_id: 'turn_1', model_used: 'qwen3:30b', finalized_at: at(9) })];
  const items = tl.groupTurns(messages);
  assert.deepEqual(kinds(items), ['member:u1', 'turn:turn_1']);
  const turn = items[1];
  assert.equal(turn.tools, 1);
  assert.equal(turn.text, 'It says hello.');
  assert.equal(turn.prompt.id, 'u1');
  assert.deepEqual(turn.messages.map((m) => m.id), ['a1', 'u', 'r', 'a2']);
  assert.equal(turn.status, 'done');
  assert.equal(turn.startedAt, at(0));
  assert.equal(turn.finishedAt, at(9));
  assert.equal(turn.model, 'qwen3:30b');
  assert.equal(turn.headless, false);
});

test('groupTurns: two turns interleaved by a member message group by turn_id, each after its prompt', () => {
  const messages = [user('u1', 'First'), said('a1', 'one', { turn_id: 't1' }), user('u2', 'Second'), said('b1', 'two', { turn_id: 't2' }), said('a2', 'one more', { turn_id: 't1' })];
  const items = tl.groupTurns(messages);
  assert.deepEqual(kinds(items), ['member:u1', 'turn:t1', 'member:u2', 'turn:t2']);
  assert.equal(items[1].text, 'one more');
  assert.equal(items[1].prompt.id, 'u1');
  assert.equal(items[3].prompt.id, 'u2');
});

test('groupTurns: messages without turn_id join the run after their user message', () => {
  const items = tl.groupTurns([user('u1', 'Hi'), said('a1', 'Hello'), said('a2', 'There'), user('u2', 'Again'), said('b1', 'Yes')]);
  assert.deepEqual(kinds(items), ['member:u1', 'turn:after:u1', 'member:u2', 'turn:after:u2']);
  assert.equal(items[1].text, 'There');
  assert.equal(items[1].messages.length, 2);
});

test('groupTurns: a turn whose prompt is not held is headless; a later one is not', () => {
  const items = tl.groupTurns([said('a1', 'end of an older answer', { turn_id: 't0' }), user('u1', 'Next'), said('b1', 'ok', { turn_id: 't1' })]);
  assert.deepEqual(kinds(items), ['turn:t0', 'member:u1', 'turn:t1']);
  assert.equal(items[0].headless, true);
  assert.equal(items[0].prompt, null);
  assert.equal(items[0].startedAt, at(1));
  assert.equal(items[2].headless, false);
  const untagged = tl.groupTurns([said('x1', 'orphan')]);
  assert.equal(untagged[0].id, 'at:x1');
  assert.equal(untagged[0].headless, true);
});

test('groupTurns: an active turn with a held prompt and nothing saved yet is an empty running turn after that prompt', () => {
  const items = tl.groupTurns([user('u1', 'Old'), said('a1', 'done', { turn_id: 't1' }), user('u2', 'Now')],
    { activeTurn: { turn_id: 't2', stream_id: 'stream_2', user_message_id: 'u2', status: 'running', started_at: 5 } });
  assert.deepEqual(kinds(items), ['member:u1', 'turn:t1', 'member:u2', 'turn:t2']);
  assert.equal(items[3].status, 'running');
  assert.deepEqual(items[3].messages, []);
  assert.equal(items[3].prompt.id, 'u2');
  assert.equal(items[1].status, 'done');
  // Saved messages under the active stream id are that turn, running.
  const saved = tl.groupTurns([user('u2', 'Now'), toolUse('u', { turn_id: 'stream_2' })], { activeTurn: { turn_id: 't2', stream_id: 'stream_2', user_message_id: 'u2' } });
  assert.deepEqual(kinds(saved), ['member:u2', 'turn:stream_2']);
  assert.equal(saved[1].status, 'running');
});

test('groupTurns: runtime_error is failed, cancelled is stopped', () => {
  const items = tl.groupTurns([user('u1', 'a'), said('a1', '', { turn_id: 't1', status: 'runtime_error' }), user('u2', 'b'), said('b1', 'part', { turn_id: 't2', status: 'cancelled' })]);
  assert.equal(items[1].status, 'failed');
  assert.equal(items[1].text, '');
  assert.equal(items[3].status, 'stopped');
});

// ------------------------------------------------------------------ (b) chipState

const stream = (extra = {}) => ({ ...tl.startStream('stream_1', 1000), ...extra });
const running = { status: 'running', tools: 0, messages: [] };

test('chipState: the live states, the asks states and the elapsed time', () => {
  assert.deepEqual(tl.chipState({ turn: running, stream: stream(), now: 15_000 }), { state: 'live', label: 'Thinking…', elapsed: '14s' });
  assert.equal(tl.chipState({ turn: running, stream: stream({ status: 'Starting iteration 1/300…' }), now: 2000 }).label, 'Thinking…');
  assert.equal(tl.chipState({ turn: running, stream: stream({ status: 'Planning the edit' }), now: 2000 }).label, 'Planning the edit');
  assert.deepEqual(tl.chipState({ turn: running, stream: stream({ text: 'Hel' }), now: 3000 }), { state: 'live', label: 'Writing…', elapsed: '2s' });
  const withTool = { ...running, messages: [toolUse('u')] };
  assert.equal(tl.chipState({ turn: withTool, stream: stream({ tools: [{ id: 'call_u', name: 'read_file', state: 'running' }] }), now: 2000 }).label, 'read_file · index.html');
  assert.equal(tl.chipState({ turn: running, stream: stream({ tools: [{ id: 'call_z', name: 'list_dir', state: 'running' }] }), now: 2000 }).label, 'list_dir');
  assert.equal(tl.chipState({ turn: running, stream: stream({ tools: [{ id: 'call_z', name: 'list_dir', state: 'done' }] }), now: 2000 }).label, 'Thinking…');
  const asks = tl.chipState({ turn: running, stream: stream(), question: true, now: 4000 });
  assert.deepEqual(asks, { state: 'asks', label: 'Waiting for an answer', elapsed: '3s' });
  assert.equal(tl.chipState({ turn: running, stream: stream(), approval: true, now: 4000 }).label, 'Waiting for approval');
});

test('chipState: the finished states, the plural tool count and the Done fallback', () => {
  assert.deepEqual(tl.chipState({ turn: { status: 'failed' } }), { state: 'failed', label: 'Jenny could not finish this answer', elapsed: '' });
  assert.deepEqual(tl.chipState({ turn: { status: 'stopped' } }), { state: 'stopped', label: 'Stopped before Jenny answered', elapsed: '' });
  const timed = { status: 'done', startedAt: at(0), finishedAt: at(38) };
  assert.equal(tl.chipState({ turn: { ...timed, tools: 2 } }).label, 'Worked for 38s · 2 tools');
  assert.equal(tl.chipState({ turn: { ...timed, tools: 1 } }).label, 'Worked for 38s · 1 tool');
  assert.equal(tl.chipState({ turn: { ...timed, tools: 0 } }).label, 'Thought for 38s');
  assert.equal(tl.chipState({ turn: { status: 'done', tools: 0, startedAt: at(0), finishedAt: '' }, thoughtMs: 6000 }).label, 'Thought for 6s');
  assert.deepEqual(tl.chipState({ turn: { status: 'done', tools: 0, startedAt: at(0), finishedAt: '' } }), { state: 'done', label: 'Done', elapsed: '' });
  assert.equal(tl.chipState({ turn: { status: 'done', tools: 3 } }).label, 'Done · 3 tools');
});

// ------------------------------------------------------------------ (c) chip and turn line markup

test('chipHtml: classes, the turn-open action, aria-expanded, the dot and the shimmer only while live', () => {
  const live = parse(tl.chipHtml({ turnId: 'turn_1', state: 'live', label: 'Thinking…', elapsed: '4s', open: false })).firstElementChild;
  assert.equal(live.tagName, 'BUTTON');
  assert.equal(live.className, 'team-turn-chip');
  assert.equal(live.dataset.state, 'live');
  assert.equal(live.dataset.projectAction, 'turn-open');
  assert.equal(live.dataset.turnId, 'turn_1');
  assert.equal(live.getAttribute('aria-expanded'), 'false');
  assert.equal(live.getAttribute('aria-controls'), 'teamTurnPop');
  assert.equal(live.title, 'Show what Jenny thought and did in this turn');
  assert.ok(live.querySelector('.status-dot.status-dot--active'));
  assert.ok(live.querySelector('.team-turn-chip__label.shimmer-active[dir="auto"]'));
  assert.equal(live.querySelector('.team-turn-chip__time').textContent, '4s');
  assert.equal(live.querySelector('.team-turn-chip__more').textContent, 'Show work');
  const open = parse(tl.chipHtml({ turnId: 't', state: 'done', label: 'Done', elapsed: '', open: true })).firstElementChild;
  assert.equal(open.getAttribute('aria-expanded'), 'true');
  assert.equal(open.querySelector('.team-turn-chip__more').textContent, 'Hide');
  assert.equal(open.querySelector('.team-turn-chip__time'), null);
  assert.equal(open.querySelector('.shimmer-active'), null);
  assert.ok(open.querySelector('.status-dot--muted'));
  assert.ok(parse(tl.chipHtml({ turnId: 't', state: 'asks', label: 'x' })).querySelector('.status-dot--pending'));
  assert.ok(parse(tl.chipHtml({ turnId: 't', state: 'failed', label: 'x' })).querySelector('.status-dot--error'));
});

test('chipHtml: a hostile tool name is cleaned and escaped', () => {
  const state = tl.chipState({ turn: running, stream: stream({ tools: [{ id: 'c', name: HOSTILE, state: 'running' }] }), now: 2000 });
  assert.equal(state.label.includes('‮'), false);
  const html = tl.chipHtml({ turnId: '"><b>x', state: state.state, label: state.label, elapsed: state.elapsed });
  const body = parse(html);
  assert.equal(body.querySelector('img'), null);
  assert.equal(body.querySelector('b'), null);
  assert.equal(body.querySelector('.team-turn-chip__label').textContent, state.label);
});

test('turnLineHtml: the chip, then Stop and Send again only when allowed', () => {
  const chip = tl.chipHtml({ turnId: 't1', state: 'live', label: 'Thinking…' });
  const both = parse(tl.turnLineHtml({ chip, canStop: true, canRetry: true, turnId: 't1' })).firstElementChild;
  assert.equal(both.className, 'team-turn-line');
  assert.ok(both.firstElementChild.classList.contains('team-turn-chip'));
  const stop = both.querySelector('[data-project-action="stop"]');
  assert.equal(stop.getAttribute('aria-label'), 'Stop this turn');
  assert.ok(stop.classList.contains('team-icon-btn'));
  const again = both.querySelector('[data-project-action="send-again"]');
  assert.equal(again.dataset.turnId, 't1');
  assert.equal(again.textContent, 'Send again');
  const none = parse(tl.turnLineHtml({ chip, canStop: false, canRetry: false, turnId: 't1' }));
  assert.equal(none.querySelector('[data-project-action="stop"]'), null);
  assert.equal(none.querySelector('[data-project-action="send-again"]'), null);
});

// ------------------------------------------------------------------ (d) the lead slot

test('rowInnerHtml: the lead sits after the meta line, or first in a continuing row; without it nothing changes', () => {
  const ctx = { author: () => ({ name: 'Ann', initial: 'A' }), nameOf: () => 'Ann' };
  const message = { id: 'm1', author: { kind: 'member', member_id: 'member_a' }, created_at: '', text: 'hi', reply_count: 0 };
  // Captured before the slot was added.
  assert.equal(messageRow.rowInnerHtml({ message, first: true, body: '<p>hi</p>', foot: '<i>f</i>' }, ctx),
    '<span class="team-avatar" aria-hidden="true">A</span><div class="team-msg__body"><div class="team-msg__meta"><span class="team-msg__author" dir="auto">Ann</span>'
    + '<time class="team-msg__time" datetime=""></time></div><div class="team-msg__text chat-bubble-markdown" dir="auto"><p>hi</p></div><div class="team-msg__foot"><i>f</i></div></div>');
  assert.equal(messageRow.rowInnerHtml({ message, first: false, body: '<p>hi</p>' }, ctx),
    '<span class="team-msg__gutter-time" aria-hidden="true"></span><div class="team-msg__body"><div class="team-msg__text chat-bubble-markdown" dir="auto"><p>hi</p></div></div>');
  const first = parse(messageRow.rowInnerHtml({ message, first: true, body: '<p>hi</p>', lead: '<div class="lead-x"></div>' }, ctx)).querySelector('.team-msg__body');
  assert.deepEqual([...first.children].map((el) => el.className), ['team-msg__meta', 'lead-x', 'team-msg__text chat-bubble-markdown']);
  const next = parse(messageRow.rowInnerHtml({ message, first: false, body: '<p>hi</p>', lead: '<div class="lead-x"></div>' }, ctx)).querySelector('.team-msg__body');
  assert.deepEqual([...next.children].map((el) => el.className), ['lead-x', 'team-msg__text chat-bubble-markdown']);
});

// ------------------------------------------------------------------ (e) createRows

function rowsFixture() {
  let rendered = 0;
  const rows = projectRows.createRows({ nameOf: (id) => ({ member_maya: 'Maya', member_dot: 'Dot' })[id] || '', me: 'member_dot',
    markdown: (text) => { rendered += 1; return '<p>' + text.replace(/</g, '&lt;') + '</p>'; },
    timeText: messageRow.timeText, dayLabel: (key) => 'Day ' + key, modelName: (m) => m });
  return { rows, count: () => rendered };
}

test('createRows: a day divider, a run of one member, a Jenny row with its chip lead, its body and the hover acts', () => {
  const { rows, count } = rowsFixture();
  const messages = [user('u1', 'One', { timestamp: '2026-11-11T10:00:00.000Z' }), user('u2', 'Two', { timestamp: '2026-11-12T10:00:00.000Z' }),
    user('u3', 'Three', { timestamp: '2026-11-12T10:02:00.000Z' }), said('a1', 'Answer **here**', { turn_id: 't1', timestamp: '2026-11-12T10:02:30.000Z' })];
  const items = tl.groupTurns(messages);
  const lead = (item) => (item.kind === 'turn' ? tl.turnLineHtml({ chip: tl.chipHtml({ turnId: item.id, state: 'done', label: 'Done' }), turnId: item.id }) : '');
  const html = rows.html(items, { leadOf: lead });
  const body = parse(html);
  assert.equal(body.querySelectorAll('.team-day[role="separator"]').length, 2);
  const msgs = [...body.querySelectorAll('.team-msg')];
  assert.equal(msgs.length, 4);
  assert.deepEqual(msgs.map((el) => el.dataset.first), ['true', 'true', 'false', 'true']);
  assert.equal(msgs[1].dataset.messageId, 'u2');
  assert.equal(msgs[1].getAttribute('tabindex'), '-1');
  assert.equal(msgs[1].querySelector('.team-msg__author').textContent, 'Maya');
  const jenny = msgs[3];
  assert.equal(jenny.dataset.turnId, 't1');
  assert.equal(jenny.querySelector('.team-avatar').dataset.jenny, 'true');
  assert.equal(jenny.querySelector('.team-msg__role').textContent, 'model');
  const line = jenny.querySelector('.team-msg__meta').nextElementSibling;
  assert.equal(line.className, 'team-turn-line');
  assert.ok(line.querySelector('.team-turn-chip'));
  assert.match(jenny.querySelector('.team-msg__text').innerHTML, /Answer \*\*here\*\*/);
  const acts = jenny.querySelector('.team-acts[role="toolbar"]');
  assert.equal(acts.getAttribute('aria-label'), 'Message actions');
  assert.equal(acts.querySelector('[data-project-action="copy"]').dataset.messageId, 'a1');
  assert.equal(acts.querySelector('[data-project-action="turn-open"]').dataset.turnId, 't1');
  assert.equal(msgs[0].querySelector('[data-project-action="turn-open"]'), null);
  assert.equal(msgs[0].querySelector('[data-project-action="copy"]').dataset.messageId, 'u1');
  // Unchanged input: the same string, and no Markdown rendered again.
  const before = count();
  assert.equal(rows.html(items, { leadOf: lead }), html);
  assert.equal(count(), before);
  assert.equal(rows.size(), 4);
  rows.keep(['u1', 't1']);
  assert.equal(rows.size(), 2);
  rows.clear();
  assert.equal(rows.size(), 0);
});

test('createRows: a live body from bodyOf, a foot, a running turn without text has no Copy, and names are escaped', () => {
  const { rows } = rowsFixture();
  const items = tl.groupTurns([user('u1', 'Go', { author: { kind: 'member', member_id: 'member_x' } })], { activeTurn: { turn_id: 't9', user_message_id: 'u1' } });
  const quiet = parse(rows.html(items, { footOf: (item) => (item.kind === 'member' ? '<span class="team-queued">waits</span>' : '') }));
  const turnRow = quiet.querySelector('.team-msg[data-turn-id="t9"]');
  assert.equal(turnRow.querySelector('[data-project-action="copy"]'), null);
  assert.ok(turnRow.querySelector('[data-project-action="turn-open"]'));
  assert.ok(quiet.querySelector('.team-msg[data-message-id="u1"] .team-msg__foot .team-queued'));
  // A member not on the team reads as a former member.
  assert.equal(quiet.querySelector('.team-msg[data-message-id="u1"] .team-avatar').dataset.former, 'true');
  const streaming = parse(rows.html(items, { bodyOf: (item) => (item.kind === 'turn' ? 'So far' : null) }));
  assert.match(streaming.querySelector('.team-msg[data-turn-id="t9"] .team-msg__text').textContent, /So far/);
  const hostile = projectRows.createRows({ nameOf: () => HOSTILE, markdown: (t) => '<p>' + t.replace(/</g, '&lt;') + '</p>', timeText: () => '', dayLabel: () => '' });
  const out = parse(hostile.html(tl.groupTurns([user('u1', 'hi')])));
  assert.equal(out.querySelector('img'), null);
  assert.equal(out.querySelector('.team-msg__author').textContent.includes('‮'), false);
});

test('the rows script loads in the app, where require throws', () => {
  const vm = require('node:vm');
  const source = require('node:fs').readFileSync(require.resolve('../renderer/team/renderer-team-project-rows'), 'utf8');
  const app = { rendererTeamMessageRow: messageRow, rendererTeamProjectTimeline: tl, stringUtils: require('../renderer/shared/string-utils'), inventory: globalThis.inventory,
    require: (name) => { throw new Error('Check dependency list! ' + name); } };
  app.globalThis = app;
  vm.runInNewContext(source, app);
  assert.equal(typeof app.rendererTeamProjectRows.createRows, 'function');
});

// ------------------------------------------------------------------ (f) channelShellHtml

test('channelShellHtml: every hook the controller uses, the pop host in the stage, the announce region, the #team composer', () => {
  const body = parse(parts.channelShellHtml({ board: false, fieldHtml: box.composerFieldHtml('Plan'), standing: 'Readers see this.' }));
  const root = body.querySelector('.team-conv.team-conv--channel');
  assert.equal(root.dataset.board, 'false');
  for (const name of ['head', 'log', 'live', 'box', 'pop', 'announce']) assert.ok(body.querySelector(`[data-conv-region="${name}"]`), name);
  const scroll = body.querySelector('.team-conv__scroll.team-scroll[role="log"]');
  assert.equal(scroll.hasAttribute('aria-live'), false);
  assert.ok(scroll.querySelector('[data-conv-region="log"]'));
  assert.ok(scroll.querySelector('[data-conv-region="live"]'));
  assert.equal(body.querySelector('.team-conv__column'), null);
  assert.equal(body.querySelector('.chat-sprite-layer'), null);
  assert.ok(body.querySelector('.team-conv__stage > .chat-jump-latest[data-project-action="latest"]'));
  const pop = body.querySelector('.team-conv__stage > .team-turn-pop-host[data-conv-region="pop"]');
  assert.equal(pop.innerHTML, '');
  assert.equal(pop.previousElementSibling, scroll);
  const announce = body.querySelector('[data-conv-region="announce"]');
  assert.equal(announce.getAttribute('aria-live'), 'polite');
  assert.ok(announce.classList.contains('sr-only'));
  for (const name of ['above', 'shell', 'locked', 'composer', 'toolbar', 'left', 'bar', 'below']) assert.ok(body.querySelector(`[data-conv-box="${name}"]`), name);
  assert.ok(body.querySelector('.team-composer-root > .team-composer[data-conv-box="shell"]'));
  assert.ok(body.querySelector('.team-composer__bar[data-conv-box="toolbar"] > [data-conv-box="left"] + [data-conv-box="bar"]'));
  assert.ok(body.querySelector('.team-conv__locked[data-conv-box="locked"]'));
  assert.ok(body.querySelector('[data-conv-box="composer"] textarea.team-composer__input[data-project-input="prompt"]'));
  assert.equal(body.querySelector('.team-conv__standing').textContent, 'Readers see this.');
  const board = parse(parts.channelShellHtml({ board: true, fieldHtml: '', standing: 'x' }));
  assert.equal(board.querySelector('.team-conv').dataset.board, 'true');
  assert.equal(board.querySelector('.team-conv__standing'), null);
});

// ------------------------------------------------------------------ (g) composerParts

const names = { member_dot: 'Dot', member_maya: 'Maya' };
const state = (over = {}) => ({ role: 'writer', owner: false, driver: null, me: 'member_dot', running: false, approval: false, confirm: false, takenBy: '', busy: false, note: '',
  nameOf: (id) => names[id] || '', boardHint: '', gpu: null, model: null, mayQueue: true, board: false, ...over });

test('composerFieldHtml: the #team field named after the conversation', () => {
  const el = parse(box.composerFieldHtml('Homepage <copy>')).querySelector('textarea');
  assert.equal(el.className, 'team-composer__input');
  assert.equal(el.id, box.BOX_ID);
  assert.equal(el.getAttribute('placeholder'), 'Message “Homepage <copy>”');
  assert.equal(el.getAttribute('aria-label'), 'Message “Homepage <copy>”');
  assert.equal(el.getAttribute('rows'), '1');
  assert.equal(el.getAttribute('dir'), 'auto');
  assert.equal(el.getAttribute('maxlength'), String(box.PROMPT_MAX));
  assert.equal(el.dataset.projectInput, 'prompt');
  assert.ok(el.getAttribute('aria-describedby'));
});

test('composerParts: every sentence state is the same as boxParts', () => {
  const cases = [state({ role: 'reader' }), state({ driver: 'member_maya', approval: true }), state({ driver: 'member_maya', running: true, confirm: true }),
    state({ driver: 'member_maya', running: true, role: 'admin' }), state({ driver: 'member_maya', running: true }), state({ driver: 'member_maya' }),
    state({ driver: 'member_maya', takenBy: 'member_maya', note: 'Refused.' })];
  for (const s of cases) {
    const expected = box.boxParts(s);
    assert.equal(expected.composer, false);
    assert.deepEqual(box.composerParts(s), expected);
  }
  const gpu = box.composerParts(state({ gpu: { team: 'Dot lab', canShare: true }, takenBy: 'member_maya', note: 'Refused.' }));
  const old = box.boxParts(state({ gpu: { team: 'Dot lab', canShare: true }, takenBy: 'member_maya', note: 'Refused.' }));
  assert.equal(gpu.above, old.above);
  assert.equal(gpu.below, old.below);
  assert.equal(gpu.lifecycle, old.lifecycle);
});

test('composerParts: the field has code, @ and attach (both greyed), the hint and Send, and no Stop', () => {
  const p = box.composerParts(state({ driver: 'member_dot' }));
  assert.equal(p.composer, true);
  const left = parse(p.left);
  const icons = [...left.querySelectorAll('.team-icon-btn')];
  assert.deepEqual(icons.map((b) => b.getAttribute('aria-label')), ['Code block', 'Mention someone', 'Attach files', 'Dictate']);
  assert.equal(icons[0].dataset.projectAction, 'code');
  assert.equal(icons[0].disabled, false);
  assert.equal(icons[1].disabled, true);
  assert.equal(icons[1].title, 'Mentions are not sent to Jenny');
  assert.equal(icons[2].disabled, true);
  assert.equal(icons[2].title, 'Attachments cannot be sent in project conversations yet');
  assert.equal(icons[3].disabled, true, 'no dictation controller yet: greyed, with its reason');
  assert.equal(icons[3].title, 'Turn on dictation in Settings to use it here.');
  const hint = left.querySelector('.team-composer__hint');
  assert.equal(hint.id, parse(box.composerFieldHtml('x')).querySelector('textarea').getAttribute('aria-describedby'));
  assert.equal(hint.textContent, 'Markdown · Enter to send', 'the model that answers is in the pill (row 172)');
  const bar = parse(p.bar);
  const send = bar.querySelector('[data-project-action="send"]');
  assert.ok(send.classList.contains('btn--primary'));
  assert.equal(bar.querySelector('[data-project-action="stop"]'), null);
  assert.equal(parse(box.composerParts(state({ driver: 'member_dot', running: true })).bar).querySelector('[data-project-action="stop"]'), null);
});

// Row 175 item 16: the mic uses the dictation controller's generic target.
test('composerParts: the mic follows the live dictation controller, and the field is its target', (t) => {
  globalThis.rendererDictationController = require('../renderer/features/renderer-dictation-controller');
  t.after(() => { delete globalThis.rendererDictationLive; delete globalThis.rendererDictationController; });
  assert.equal(parse(box.composerFieldHtml('x')).querySelector('textarea').getAttribute('data-dictation-target'), 'team-box');
  const mic = () => parse(box.composerParts(state({ driver: 'member_dot' })).left).querySelector('[data-dictation-button]');
  globalThis.rendererDictationLive = { isEnabled: () => false };
  assert.deepEqual([mic().disabled, mic().title], [true, 'Turn on dictation in Settings to use it here.']);
  globalThis.rendererDictationLive = { isEnabled: () => true };
  const on = mic();
  assert.deepEqual([on.disabled, on.title, on.getAttribute('aria-label'), on.getAttribute('aria-pressed')], [false, 'Dictate: hold, or press Ctrl+Space', 'Dictate', 'false']);
  assert.ok(on.querySelector('svg'));
});

test('composerParts: the hint while Jenny answers, when nobody drives, and on the Board; the controls around it', () => {
  const hintOf = (s) => parse(box.composerParts(s).left).querySelector('.team-composer__hint').textContent;
  assert.equal(hintOf(state({ driver: 'member_dot', running: true })), 'Jenny is answering · what you send waits for her next turn');
  assert.equal(hintOf(state({ driver: null })), 'Sending makes you the driver');
  assert.equal(hintOf(state({ driver: 'member_dot' })), 'Markdown · Enter to send');
  const prefs = { tools: '<i id="tools"></i>', model: '<i id="pill"></i>', above: '<p id="above"></p>', offline: true };
  const placed = box.composerParts(state({ driver: 'member_dot', prefs }));
  assert.deepEqual([...parse(placed.left).querySelectorAll('.team-icon-btn, i, .team-composer__hint')].map((el) => el.id || el.className.split(' ')[0]).slice(3), ['team-icon-btn', 'tools', 'teamConversationHint', 'pill'], 'the chip follows attach, the pill follows the hint');
  assert.deepEqual([placed.above.includes('id="above"'), parse(placed.bar).querySelector('[data-project-action="send"]').disabled], [true, true], 'an offline pick: its line above, Send held');
  assert.equal(hintOf(state({ boardHint: 'Shared with jenny-site', board: true, running: true })), 'Shared with jenny-site');
  const board = parse(box.composerParts(state({ boardHint: 'Shared with jenny-site', board: true, running: true })).bar);
  assert.ok(board.querySelector('[data-project-action="stop"]'));
  assert.ok(board.querySelector('[data-project-action="send"]'));
  const watching = parse(box.composerParts(state({ boardHint: 'Shared', board: true, running: true, driver: 'member_dot' })).bar);
  assert.ok(watching.querySelector('[data-project-action="stop"]'));
});

test('approval receipts: who answered starts the sentence; whose turn only when another member answered', () => {
  const names = { member_lena: 'Lena', member_maya: 'Maya' };
  const shot = { pending_approvals: [] };
  const approvals = parts.createApprovals({ snapshot: () => shot, send: async () => null, me: () => 'member_dot', mayAnswer: () => true,
    youOr: (id) => (id === 'member_dot' ? 'You' : names[id]), nameOf: (id) => names[id], errorText: () => '', timeText: () => '9:28 AM',
    cardHtml: box.cardHtml, receiptHtml: box.receiptHtml, outcomeHtml: box.outcomeHtml, acted() {}, redraw() {}, rules: async () => null, sessionId: 's', projectName: () => 'P' });
  approvals.decided({ approval_id: 'a1', approver_member_id: 'member_dot', prompter_member_id: 'member_lena', approved: true });
  approvals.decided({ approval_id: 'a2', approver_member_id: 'member_lena', prompter_member_id: 'member_lena', approved: false });
  approvals.decided({ approval_id: 'a3', prompter_member_id: 'member_lena' }); // a withdrawal: nobody named, never "Someone allowed"
  const lines = [...parse(approvals.receiptsHtml()).querySelectorAll('.tool-approval-receipt')].map((n) => n.textContent);
  assert.deepEqual(lines, ['You allowed this at 9:28 AM, in Lena’s turn', 'Lena denied this at 9:28 AM', 'Withdrawn at 9:28 AM: the turn no longer asks.']);
});

// ------------------------------------------------------------ row 175, wave 1: the popover model of a live turn

const { createChannel } = require('../renderer/team/renderer-team-project-channel');

const TURN = 'turn_1';
const savedMessages = () => [
  user('u1', 'Check index.html', { turn_id: TURN, event_seq: 200 }),
  said('assistant_s1_seg0', 'Let me look.', { turn_id: TURN, event_seq: 201, reasoning: { source: 'provider', entries: [{ id: 'saved-r1', text: 'First thought.' }] } }),
  toolUse('u', { turn_id: TURN, event_seq: 202 }),
  toolResult('r', { turn_id: TURN, event_seq: 203 }),
];
// A channel over a held conversation; a test edits `s` (the controller's state) between frames.
function harness({ messages = savedMessages(), stream = null, running = Boolean(stream), error = '', names = { member_maya: 'Maya' },
  rows = { html: () => '', keep() {} } } = {}) {
  const held = messages.slice();
  const s = { snapshot: running ? { active_turn: { turn_id: TURN, stream_id: 's1', status: 'running', user_message_id: 'u1' } } : {}, stream, liveTurn: stream ? TURN : '',
    popTurn: TURN, announced: '', thought: new Map(), error, closed: false };
  const channel = createChannel({ s, history: { messages: () => held, topHtml: () => '', more: () => false }, approvals: { pending: () => [], cardsHtml: () => '', receiptsHtml: () => '' },
    queue: { entries: () => [] }, rows, clock: () => Date.parse(T0) + 20000, me: () => 'member_maya', nameOf: (id) => names[id] || '', role: () => 'writer',
    mayDrive: () => true, running: () => running, streamId: () => (stream ? 's1' : ''), asking: () => [], projectName: () => 'P', modelName: (m) => m || '', liveText: () => '', notes: () => [] });
  return { s, channel, model: () => channel.popModel(channel.view()), log: () => channel.logHtml(channel.view()),
    live: () => channel.liveHtml(channel.view()) };
}
const liveStream = (extra = {}) => ({ id: 's1', text: '', reasoning: [], status: '', tools: [], ended: '', startedAt: Date.parse(T0), ...extra });

test('popModel: the live tail shows while saved segments exist, carries only the unsaved words and sorts after the saved rows (A1-A4)', () => {
  const h = harness({ stream: liveStream({ text: 'Let me look.The file says hello.', reasoning: [{ id: 'live-r1', text: 'First thought.' }, { id: 'live-r2', text: 'Second thought.' }] }) });
  const m = h.model();
  assert.deepEqual(m.messages.map((x) => x.id), ['u1', 'assistant_s1_seg0', 'u', 'r', 'live-s1']);
  const tail = m.messages[4];
  assert.deepEqual([tail.content, tail.event_seq, tail.status], ['The file says hello.', 204, 'streaming']);
  assert.deepEqual(tail.reasoning.entries, [{ id: 'live-r2', text: 'Second thought.' }], 'the saved thought is not drawn twice');
  assert.equal(m.live, true);
  assert.equal(m.messages.every((x) => x.author === undefined), true, 'author never reaches a local message');
});

test('popModel: a reasoning-only saved segment is not drawn again, so nothing unsaved leaves the saved list', () => {
  const messages = [user('u1', 'Hi', { turn_id: TURN, event_seq: 1 }), said('seg0', '', { turn_id: TURN, event_seq: 2, reasoning: { source: 'provider', entries: [{ id: 'r1', text: 'Pondering.' }] } })];
  const h = harness({ messages, stream: liveStream({ reasoning: [{ id: 'r1', text: 'Pondering.' }] }) });
  assert.deepEqual(h.model().messages.map((x) => x.id), ['u1', 'seg0']);
});

test('popModel: an unchanged turn returns the same messages array, a changed stream a new one', () => {
  const h = harness({ stream: liveStream({ text: 'Let me look.More' }) });
  const first = h.model().messages;
  assert.equal(h.model().messages, first);
  h.s.stream = { ...h.s.stream, text: 'Let me look.More words' };
  const next = h.model().messages;
  assert.notEqual(next, first);
  assert.equal(next[next.length - 1].content, 'More words');
  h.s.stream = { ...h.s.stream, tools: [{ id: 'c9', name: 'grep_search', state: 'running' }] };
  assert.notEqual(h.model().messages, next, 'a new running tool changes the list');
});

test('popModel: a running tool with no saved row gets a synthetic row before the tail; a saved one does not (A8)', () => {
  const h = harness({ stream: liveStream({ text: 'Let me look.Now', tools: [{ id: 'call_u', name: 'read_file', state: 'done' }, { id: 'c9', name: 'grep_search', state: 'running' }] }) });
  assert.deepEqual(h.model().messages.slice(4).map((x) => [x.id, x.event_seq]), [['live-tool-c9', 204], ['live-s1', 205]]);
  const saved = harness({ stream: liveStream({ tools: [{ id: 'call_u', name: 'read_file', state: 'running' }] }) });
  assert.deepEqual(saved.model().messages.map((x) => x.id), ['u1', 'assistant_s1_seg0', 'u', 'r']);
});

test('popModel: the tail is complete after the stream completes, error or cancelled after those (A9)', () => {
  for (const [ended, status] of [['complete', 'complete'], ['error', 'error'], ['cancelled', 'cancelled']]) {
    const h = harness({ stream: liveStream({ text: 'Let me look.Unsaved end', ended }), running: false });
    const tail = h.model().messages.pop();
    assert.deepEqual([tail.content, tail.status], ['Unsaved end', status], ended);
  }
});

test('popModel: a failed or stopped turn ends with the chip words; a done or running one has no end line (A7)', () => {
  const failed = harness({ messages: [user('u1', 'Hi', { turn_id: TURN }), said('a1', '', { turn_id: TURN, status: 'runtime_error' })] }).model();
  assert.deepEqual(failed.end, { kind: 'failed', text: 'Jenny could not finish this answer' });
  const stopped = harness({ messages: [user('u1', 'Hi', { turn_id: TURN }), said('a1', '', { turn_id: TURN, status: 'cancelled' })] }).model();
  assert.deepEqual(stopped.end, { kind: 'stopped', text: 'Stopped before Jenny answered' });
  assert.equal(harness().model().end, null);
  assert.equal(harness({ stream: liveStream({ text: 'x' }) }).model().end, null);
  assert.equal(harness({ stream: liveStream({ text: 'x', ended: 'error' }), running: false }).model().end.kind, 'failed', 'a stream that errored and is not saved yet');
});

test('popModel: promptBy names the member who sent the prompt, else nothing (D9)', () => {
  assert.equal(harness().model().promptBy, 'Maya');
  assert.equal(harness({ names: {} }).model().promptBy, '');
  assert.equal(harness({ messages: [said('a1', 'Hello', { turn_id: TURN })] }).model().promptBy, '');
});

test('a conversation that failed to open says why and offers Try again; the button goes with the error (F8)', () => {
  const h = harness({ error: 'Could not open <b>this</b> conversation' });
  const dom = parse(h.log());
  assert.equal(dom.querySelector('b'), null, 'the reason is escaped');
  assert.equal(dom.querySelector('button[data-project-action="reopen"]').textContent.trim(), 'Try again');
  h.s.error = '';
  assert.equal(parse(h.log()).querySelector('[data-project-action="reopen"]'), null, 'no button without an error');
});

// ------------------------------------------------------------ row 175, wave 2: why a turn failed (F4), the compaction line (F14)

// A rows stub that draws only each turn's lead, so a test reads the line under Jenny's name.
const leadRows = { html: (items, o) => items.map((i) => (o && o.leadOf ? o.leadOf(i) : '')).join(''), keep() {} };
const failedTurn = (extra = {}) => [user('u1', 'Hi', { turn_id: TURN }), said('a1', '', { turn_id: TURN, status: 'runtime_error', ...extra })];

test('a failed turn shows its reason under the chip, from a fixed map of codes; an unknown code adds no line (F4)', () => {
  const lines = (extra) => parse(harness({ messages: failedTurn(extra), rows: leadRows }).log()).querySelectorAll('.team-turn-reason');
  const COPY = { timeout: 'It took too long to answer.', node_lost: 'The member sharing the model went offline.',
    pool_busy: 'Every shared model was busy.', team_pool_unavailable: 'No shared model was available.', service_stop: 'The host stopped this turn.',
    context_overflow: 'The conversation is too long for this model.', model_error: 'The model returned an error.' };
  for (const [code, copy] of Object.entries(COPY)) {
    const found = lines({ error_code: code });
    assert.equal(found.length, 1, code);
    assert.equal(found[0].textContent, copy, code);
  }
  assert.equal(lines({ terminal_subcode: 'node_lost' })[0].textContent, 'The member sharing the model went offline.', 'the saved subcode counts too');
  for (const code of ['', 'something_else', '<img src=x onerror=alert(1)>', 'x'.repeat(200), 'NODE LOST', 7]) {
    assert.equal(lines({ error_code: code }).length, 0, 'no line for ' + String(code).slice(0, 20));
  }
  const dom = parse(harness({ messages: failedTurn({ error_code: 'node_lost' }), rows: leadRows }).log());
  assert.ok(dom.querySelector('.team-turn-chip').textContent.includes('Jenny could not finish this answer'), 'the chip keeps its words');
  assert.ok(dom.querySelector('[data-project-action="send-again"]'), 'Send again stays');
  assert.ok(dom.querySelector('.team-turn-line').compareDocumentPosition(dom.querySelector('.team-turn-reason')) & 4, 'under the line');
  const done = parse(harness({ rows: leadRows }).log());
  assert.equal(done.querySelector('.team-turn-reason'), null, 'a turn that did not fail has none');
});

test('a stream that ended in an error carries its reason to the chip and the popover end line (F4)', () => {
  const ended = (extra) => harness({ stream: liveStream({ text: 'x', ended: 'error', ...extra }), running: false, rows: leadRows });
  const h = ended({ reason: 'timeout' });
  assert.deepEqual(h.model().end, { kind: 'failed', text: 'Jenny could not finish this answer. It took too long to answer.' });
  assert.equal(parse(h.live()).querySelector('.team-turn-reason').textContent, 'It took too long to answer.');
  assert.deepEqual(ended({}).model().end, { kind: 'failed', text: 'Jenny could not finish this answer' }, 'no code, no reason');
  const saved = harness({ messages: failedTurn({ error_code: 'node_lost' }) }).model();
  assert.equal(saved.end.text, 'Jenny could not finish this answer. The member sharing the model went offline.');
  const stopped = harness({ messages: [user('u1', 'Hi', { turn_id: TURN }), said('a1', '', { turn_id: TURN, status: 'cancelled', error_code: 'timeout' })] }).model();
  assert.deepEqual(stopped.end, { kind: 'stopped', text: 'Stopped before Jenny answered' }, 'a stopped turn takes no reason');
});

test('a compaction shows one quiet line per event, in the lead and in the popover tail (F14)', () => {
  const compacted = (n) => ({ strategy: 'micro', tokensBefore: 900 + n, tokensAfter: 300, occurredAt: at(n) });
  const lines = (h) => parse(h.log() + h.live()).querySelectorAll('.team-turn-compact');
  const COPY = 'Jenny summarised earlier turns to make room. Older details may be forgotten.';
  const none = harness({ rows: leadRows });
  assert.equal(lines(none).length, 0);
  const saved = harness({ messages: savedMessages().concat([said('a9', 'Done.', { turn_id: TURN, event_seq: 204, context_compacted: compacted(1) })]), rows: leadRows });
  assert.deepEqual([...lines(saved)].map((n) => n.textContent), [COPY]);
  const twice = harness({ messages: savedMessages().concat([said('a9', 'Done.', { turn_id: TURN, event_seq: 204, context_compacted: compacted(2),
    context_compactions: [compacted(1), compacted(2)] })]), rows: leadRows });
  assert.equal(lines(twice).length, 2, 'two distinct events, two lines');
  // A running turn: the event counts until the saved message holds it, and never twice.
  const live = harness({ stream: liveStream({ text: 'Hel', compacted: 1 }), rows: leadRows });
  assert.equal(lines(live).length, 1);
  assert.equal(live.model().messages.at(-1).context_compacted !== undefined, true, 'the popover tail marks it');
  const both = harness({ messages: savedMessages().concat([said('a9', 'Done.', { turn_id: TURN, event_seq: 204, context_compacted: compacted(1) })]),
    stream: liveStream({ text: 'Hel', compacted: 1 }), rows: leadRows });
  assert.equal(lines(both).length, 1, 'the saved event and the live one are the same event');
  assert.equal(both.model().messages.filter((m) => m.context_compacted).length, 1, 'one in the popover too');
});
