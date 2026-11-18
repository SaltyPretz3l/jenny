'use strict';

// new-test-file: row 171, a shared conversation drawn as a #team channel, end to end in jsdom; the sibling
// tests/renderer-team-projects-conversation.test.js is at the test-file line cap. Jenny's working chip through a turn
// (and the polite announcer), a turn running at open, a failed turn's Send again, a stopped turn, the transcript
// popover (open, step, page, close, Esc, the whitelist, the live tail, Stop), a question in the live row and the
// popover, the send queue, the #team composer, earlier pages, the jump pill, Copy, the title renamed in the head and
// the draft kept per conversation. The builders' own cases are in the channel, turn-pop and queue unit tests.

const test = require('node:test');
const assert = require('node:assert/strict');

const { P1, S1, OTHER, DOT, MAYA, message, snapshot, openProjects, region, flush, listAnswer, project } = require('./helpers/team-project-renderer-host');
const { NAMES, mount, box, field, type } = require('./helpers/team-conversation-mount');
const queues = require('../renderer/team/renderer-team-project-queue');

const T0 = Date.parse('2026-11-12T10:31:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
// The host's real message shape (server/session-snapshots.js MESSAGE_FIELDS), one turn by its saved turn_id.
const ask = (id, content, turn, by = DOT) => message(id, 'user', content, { author: { kind: 'member', member_id: by }, turn_id: turn, timestamp: at(0) });
// A saved answer carries no kind (services/backend/chat-stream-session-lifecycle.js); the helper's 'message' is a user row's.
const said = (id, content, turn, over = {}) => message(id, 'assistant', content, { kind: undefined, turn_id: turn, timestamp: at(1), ...over });
const toolUse = (id, turn, path) => message(id, 'assistant', 'read_file', { kind: 'tool_use', turn_id: turn, timestamp: at(2),
  tool_call: { call_id: 'call_' + id, tool_name: 'read_file', input_json: JSON.stringify({ path }), status: 'complete' } });
const toolResult = (id, turn, call) => message(id, 'tool', '', { kind: 'tool_result', turn_id: turn, timestamp: at(3),
  tool_result: { call_id: call, tool_name: 'read_file', output_text: 'export const load = once;', is_error: false, duration_ms: 40,
    metadata: { path: 'C:/secret/app.js', row_summary: 'Opened C:/secret/app.js' }, generated_artifacts: [{ artifact_id: 'art-1', artifact_kind: 'document', title: 'Report' }] } });
const running = (turn, user, over = {}) => ({ stream_id: 'stream_1', turn_id: turn, user_message_id: user, status: 'running', ...over });

const stream = (m, type, extra = {}) => m.event('chat_stream', { stream_id: 'stream_1', event: { type, ...extra } });
const click = (m, el) => el.dispatchEvent(new m.window.MouseEvent('click', { bubbles: true, cancelable: true }));
const key = (m, el, name) => el.dispatchEvent(new m.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
const enter = (m, text) => { type(m, text); key(m, field(m), 'Enter'); };
const liveRow = (m) => m.q('[data-conv-region="live"] .team-msg');
const chipOf = (m, id) => m.q(`.team-turn-chip[data-turn-id="${id}"]`);
const label = (chip) => chip.querySelector('.team-turn-chip__label').textContent;
const clock = (chip) => (chip.querySelector('.team-turn-chip__time') || { textContent: '' }).textContent;
const pop = (m) => m.q('#teamTurnPop');
const popButton = (m, kind) => m.q(`#teamTurnPop [data-pop-action="${kind}"]`);
const queued = (m) => [...m.root.querySelectorAll('[data-conv-region="queued"] .team-msg')];
const queuedButton = (row, action) => row.querySelector(`[data-project-action="${action}"]`);
const rowIds = (m) => [...m.root.querySelectorAll('[data-conv-region="log"] .team-msg')].map((el) => el.dataset.messageId || el.dataset.turnId);
const AFFORDANCES = '[data-chat-path], .tool-path-chip, .chat-inline-path, .inv-artifact-card, .inv-artifact-figure, [data-artifact-id], [data-inv-artifact-action], [data-inv-error-action]';
// What the polite live region was told, one entry per write.
function listen(m) {
  const heard = [];
  const observer = new m.window.MutationObserver(() => {});
  observer.observe(m.q('[data-conv-region="announce"]'), { childList: true });
  return () => { for (const r of observer.takeRecords()) for (const node of r.addedNodes) heard.push(node.textContent); return heard; };
}
const QUESTION = { question_ref: 'q_ref_1', stream_id: 'stream_1', call_id: 'call_q', prompter_member_id: MAYA,
  questions: [{ id: 'colour', prompt: 'Which palette?', options: ['Warm', 'Cool'], allow_other: true }, { id: 'why', prompt: 'Anything to add?' }] };

// ------------------------------------------------------------------ (a) the chip through a turn

test('(a) the chip through a turn: Thinking… ticking, the tool and its file, Writing… in the live row, then the log row with its time and tool; each state said once', async (t) => {
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ messages: [] }) } });
  await flush();
  const heard = listen(m);
  const chip = () => liveRow(m).querySelector('.team-turn-chip');
  stream(m, 'started');
  m.frame();
  assert.deepEqual([label(chip()), clock(chip()), chip().dataset.state, chip().getAttribute('aria-expanded')], ['Thinking…', '0s', 'live', 'false']);
  assert.ok(liveRow(m).querySelector('.team-turn-line [data-project-action="stop"]'), 'Stop beside the chip: nobody drives');
  assert.equal(m.q('[data-conv-region="box"] [data-project-action="stop"]'), null, 'not in the box');
  const [stop, logs] = [liveRow(m).querySelector('[data-project-action="stop"]'), m.renders.log];
  m.advance(2000);
  assert.equal(clock(chip()), '2s', 'drawn again each second');
  assert.deepEqual([liveRow(m).querySelector('[data-project-action="stop"]') === stop, m.renders.log], [true, logs], 'patched in place: Stop survives; the log is not rewritten');
  // Main reads the snapshot on tool_use: it names the saved turn and its call.
  stream(m, 'tool_use', { call_id: 'call_t1', tool_name: 'read_file' });
  m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot({ active_turn: running('turn_1', 'u1'), messages: [ask('u1', 'Check src/app.js', 'turn_1'), toolUse('t1', 'turn_1', 'src/app.js')] }) });
  m.frame();
  assert.equal(liveRow(m).dataset.turnId, 'turn_1', 'the saved turn replaces the stream\'s row');
  assert.equal(label(chip()), 'read_file · src/app.js');
  assert.equal(m.q('[data-conv-region="log"] .team-msg[data-turn-id]'), null, 'the running turn is drawn in the live region only');
  stream(m, 'tool_result', { call_id: 'call_t1', tool_name: 'read_file', status: 'ok' });
  stream(m, 'delta', { content: 'It loads **once**.' });
  m.frame();
  assert.equal(label(chip()), 'Writing…');
  assert.equal(liveRow(m).querySelector('.team-msg__text strong').textContent, 'once', 'the stream\'s words through the markdown path');
  m.advance(2000);
  stream(m, 'complete');
  m.frame();
  assert.deepEqual([chip().dataset.state, label(chip()), clock(chip())], ['done', 'Worked for 4s · 1 tool', '']);
  m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot({ messages: [ask('u1', 'Check src/app.js', 'turn_1'), toolUse('t1', 'turn_1', 'src/app.js'),
    toolResult('r1', 'turn_1', 'call_t1'), said('a1', 'It loads **once**.', 'turn_1')] }) });
  assert.equal(liveRow(m), null, 'the post-end snapshot holds it');
  const row = m.q('[data-conv-region="log"] .team-msg[data-turn-id="turn_1"]');
  assert.equal(label(row.querySelector('.team-turn-chip')), 'Worked for 4s · 1 tool');
  assert.match(row.querySelector('.team-msg__text').textContent, /It loads once\./);
  assert.equal(m.q('.tool-call-row, .team-tool-line, .reasoning-row-block'), null, 'no tool line or reasoning row in the channel');
  assert.deepEqual(heard(), ['Jenny is working', 'Worked for 4s · 1 tool'], 'each state once, not the clock');
});

test('(a) the saved turn naming the running stream does not announce "Jenny is working" a second time', async (t) => {
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ messages: [] }) } });
  await flush();
  const heard = listen(m);
  stream(m, 'started');
  m.frame();
  m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot({ active_turn: running('turn_1', 'u1'), messages: [ask('u1', 'Check', 'turn_1')] }) });
  stream(m, 'complete');
  m.frame();
  assert.equal(heard().filter((w) => w === 'Jenny is working').length, 1);
});

// ------------------------------------------------------------------ (b) running at open, failed, stopped

test('(b) a turn running at open; a failed turn\'s chip and Send again for its prompter only; a stopped turn', async (t) => {
  const r = mount(t, { open: { ok: true, snapshot: snapshot({ messages: [ask('u1', 'Go on', 'turn_r', MAYA)], active_turn: running('turn_r', 'u1'),
    live_projection: { stream_id: 'stream_1', assistant_text: 'So far' } }) } });
  await flush();
  assert.equal(liveRow(r).dataset.turnId, 'turn_r');
  assert.match(liveRow(r).querySelector('.team-msg__text').textContent, /So far/, 'the host\'s assistant_text');
  assert.deepEqual([label(chipOf(r, 'turn_r')), clock(chipOf(r, 'turn_r'))], ['Writing…', '0s']);
  assert.deepEqual(rowIds(r), ['u1']);
  r.restore();
  const turns = [ask('u1', 'Write the essay', 'turn_f'), said('a1', '', 'turn_f', { status: 'runtime_error' }), ask('u2', 'Count slowly', 'turn_s'), said('a2', '', 'turn_s', { status: 'cancelled' }),
    ask('u3', 'Try mine', 'turn_g', MAYA), said('a3', '', 'turn_g', { status: 'runtime_error' })];
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ messages: turns }) } });
  await flush();
  assert.deepEqual([chipOf(m, 'turn_f').dataset.state, label(chipOf(m, 'turn_f'))], ['failed', 'Jenny could not finish this answer']);
  assert.deepEqual([chipOf(m, 'turn_s').dataset.state, label(chipOf(m, 'turn_s'))], ['stopped', 'Stopped before Jenny answered']);
  const again = [...m.root.querySelectorAll('[data-project-action="send-again"]')];
  assert.deepEqual(again.map((el) => el.dataset.turnId), ['turn_f'], 'only on the failed turn this member prompted');
  assert.equal(again[0].textContent.trim(), 'Send again');
  click(m, again[0]);
  await flush();
  assert.deepEqual(m.sent('conversationSend'), [{ team_id: OTHER, session_id: S1, prompt: 'Write the essay' }]);
  const reader = mount(t, { role: 'reader', open: { ok: true, snapshot: snapshot({ messages: turns }) } });
  await flush();
  assert.equal(reader.q('[data-project-action="send-again"]'), null, 'a reader may not send');
});

// ------------------------------------------------------------------ (c) the popover

test('(c) the popover: from the chip and Show work, Hide, the turn through the whitelist, prev/next, prev pages, Close and Esc return to the chip, gone with its turn', async (t) => {
  const older = snapshot({ messages: [ask('u0', 'Hello', 'turn_0'), said('a0', 'Hi.', 'turn_0')], has_more: false });
  const first = [ask('u1', 'Check src/app.js', 'turn_1'), said('a1', 'Reading it.', 'turn_1', { reasoning: { source: 'provider', entries: [{ id: 'r1', text: 'Look at the loader first' }] } }),
    toolUse('t1', 'turn_1', 'src/app.js'), toolResult('r1', 'turn_1', 'call_t1'), said('a2', 'It loads once.', 'turn_1', { model_used: 'qwen3:30b' }),
    ask('u2', 'Thanks', 'turn_2', MAYA), said('a3', 'You are welcome.', 'turn_2')];
  const m = mount(t, { open: (p) => (p.before_message_id ? { ok: true, snapshot: older } : { ok: true, snapshot: snapshot({ messages: first, has_more: true, next_before_message_id: 'u1' }) }) });
  await flush();
  click(m, chipOf(m, 'turn_1'));
  assert.equal(pop(m).dataset.turnId, 'turn_1');
  assert.deepEqual([chipOf(m, 'turn_1').getAttribute('aria-expanded'), chipOf(m, 'turn_1').querySelector('.team-turn-chip__more').textContent], ['true', 'Hide']);
  assert.equal(m.window.document.activeElement, m.q('.team-turn-pop__scroll'), 'focus goes to the popover');
  assert.match(m.q('#teamTurnPop .team-turn-pop__title span').textContent, /^Dot’s turn · .+ · Done · 1 tool · qwen3:30b$/);
  const body = m.q('.team-turn-pop__scroll');
  assert.match(body.querySelector('article.chat-entry.user').textContent, /Check src\/app\.js/, 'the prompt');
  assert.match(body.querySelector('.reasoning-row-header').textContent, /Look at the loader first/, 'the reasoning');
  for (const toggle of body.querySelectorAll('[data-tool-row-toggle]')) click(m, toggle);
  assert.ok(m.q('.team-turn-pop__scroll .tool-call-row'), 'a tool row');
  assert.match(m.q('.team-turn-pop__scroll').textContent, /It loads once\./);
  assert.equal(m.q('#teamTurnPop').querySelector(AFFORDANCES), null, 'metadata and artifacts draw no path chip or card');
  assert.equal([...pop(m).querySelectorAll('*')].some((el) => [...el.attributes].some((a) => a.name.startsWith('data-inv-'))), false);
  assert.doesNotMatch(pop(m).textContent, /C:\/secret/, 'the metadata never reaches the popover');
  click(m, m.q('.team-msg[data-turn-id="turn_2"] .team-acts [data-project-action="turn-open"]'));
  assert.equal(pop(m).dataset.turnId, 'turn_2', 'Show work in the toolbar');
  assert.equal(chipOf(m, 'turn_1').getAttribute('aria-expanded'), 'false');
  assert.equal(popButton(m, 'next').disabled, true, 'the latest turn has no later one');
  click(m, popButton(m, 'prev'));
  assert.equal(pop(m).dataset.turnId, 'turn_1');
  click(m, popButton(m, 'next'));
  assert.equal(pop(m).dataset.turnId, 'turn_2');
  click(m, popButton(m, 'prev'));
  click(m, popButton(m, 'prev'));
  await flush();
  assert.deepEqual(m.sent('conversationOpen').pop(), { team_id: OTHER, session_id: S1, before_message_id: 'u1' }, 'earlier at the edge reads the page before');
  assert.equal(pop(m).dataset.turnId, 'turn_0');
  click(m, popButton(m, 'close'));
  assert.equal(pop(m), null);
  assert.equal(m.window.document.activeElement, chipOf(m, 'turn_0'), 'Close returns to the chip');
  click(m, chipOf(m, 'turn_0'));
  chipOf(m, 'turn_0').focus();
  key(m, chipOf(m, 'turn_0'), 'Escape');
  assert.deepEqual([pop(m), m.window.document.activeElement === chipOf(m, 'turn_0')], [null, true], 'Esc from the channel');
  click(m, chipOf(m, 'turn_1'));
  key(m, m.q('.team-turn-pop__scroll'), 'Escape');
  assert.deepEqual([pop(m), m.window.document.activeElement === chipOf(m, 'turn_1')], [null, true], 'Esc inside the popover');
  click(m, chipOf(m, 'turn_0'));
  click(m, chipOf(m, 'turn_0'));
  assert.equal(pop(m), null, 'the chip again closes it');
  click(m, chipOf(m, 'turn_0'));
  m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot({ messages: [ask('u9', 'New start', 'turn_9'), said('a9', 'Fresh.', 'turn_9')] }) });
  assert.equal(pop(m), null, 'its turn left the held history: it closes');
});

test('(c) the popover on the running turn: the live tail, the running time, and Stop cancels the stream', async (t) => {
  const m = mount(t);
  await flush();
  stream(m, 'started');
  m.frame();
  click(m, liveRow(m).querySelector('.team-turn-chip'));
  assert.ok(pop(m));
  m.advance(3000);
  assert.match(m.q('#teamTurnPop .team-turn-pop__title span').textContent, /3s/, 'the popover ticks with the chip');
  stream(m, 'delta', { content: 'Drafting the plan' });
  m.frame();
  assert.match(m.q('#teamTurnPop [data-streaming-row="true"]').textContent, /Drafting the plan/, 'the live tail');
  click(m, popButton(m, 'stop'));
  await flush();
  assert.deepEqual(m.sent('conversationCancel'), [{ team_id: OTHER, session_id: S1, stream_id: 'stream_1' }]);
});

// ------------------------------------------------------------------ (d) a question

test('(d) a question in the live row and the popover, each in its own form; answering in the popover locks both; a submit is prevented', async (t) => {
  let release;
  const m = mount(t, { answers: { conversationAnswer: () => new Promise((resolve) => { release = resolve; }) },
    open: { ok: true, snapshot: snapshot({ messages: [ask('u1', 'Pick a palette', 'turn_q', MAYA)], active_turn: running('turn_q', 'u1'), pending_questions: [QUESTION] }) } });
  await flush();
  assert.ok(liveRow(m).querySelector('form.team-conv__qform .team-conv__question'), 'under the chip, in its form');
  assert.deepEqual([label(chipOf(m, 'turn_q')), clock(chipOf(m, 'turn_q'))], ['Waiting for an answer', ''], 'no clock while a person is asked');
  assert.equal(m.q('[data-conv-region="announce"]').textContent, 'Waiting for an answer');
  click(m, chipOf(m, 'turn_q'));
  const copies = () => [...m.root.querySelectorAll('.team-conv__question')];
  assert.ok(m.q('#teamTurnPop .team-turn-pop__extra form.team-conv__qform .team-conv__question'), 'and in the popover');
  assert.equal(m.root.querySelectorAll('form.team-conv__qform').length, 2);
  const radios = (wrap) => wrap.querySelectorAll('[data-user-question-option]');
  const [inRow, inPop] = copies();
  radios(inRow)[0].checked = true;
  radios(inRow)[0].dispatchEvent(new m.window.Event('change', { bubbles: true }));
  radios(inPop)[1].checked = true;
  radios(inPop)[1].dispatchEvent(new m.window.Event('change', { bubbles: true }));
  assert.deepEqual([radios(inRow)[0].checked, radios(inPop)[1].checked], [true, true], 'the copies\' radios are independent');
  const submitted = new m.window.Event('submit', { bubbles: true, cancelable: true });
  inPop.closest('form').dispatchEvent(submitted);
  assert.equal(submitted.defaultPrevented, true);
  const free = inPop.querySelector('[data-user-question-free-text]');
  free.value = 'Calm';
  free.dispatchEvent(new m.window.Event('input', { bubbles: true }));
  click(m, inPop.querySelector('.user-questions-submit-btn'));
  assert.equal(copies().every((w) => [...w.querySelectorAll('button, input, textarea')].every((el) => el.disabled)), true, 'both copies locked while it is sent');
  release({ ok: true });
  await flush();
  assert.deepEqual(m.sent('conversationAnswer'), [{ team_id: OTHER, session_id: S1, stream_id: 'stream_1', question_ref: 'q_ref_1',
    answers: [{ question_id: 'colour', answer: 'Cool' }, { question_id: 'why', answer: 'Calm' }] }]);
  assert.deepEqual(copies(), [], 'answered: both copies go');
  assert.notEqual(label(chipOf(m, 'turn_q')), 'Waiting for an answer');
});

test('a question Jenny asks: the card with whose turn asked; a writer answers it in the host\'s shape; a refusal keeps what was picked', async (t) => {
  let refuse = true;
  const m = mount(t, { answers: { conversationAnswer: () => (refuse ? { ok: false, error: { reason: 'approval_not_viewing' } } : { ok: true }) },
    open: { ok: true, snapshot: snapshot({ active_turn: { stream_id: 'stream_1', status: 'running' }, pending_questions: [QUESTION] }) } });
  await flush();
  const wrap = () => m.q('.team-conv__question');
  assert.deepEqual([wrap().dataset.questionRef, wrap().dataset.streamId], ['q_ref_1', 'stream_1']);
  assert.match(wrap().querySelector('.team-conv__who').textContent, /^Maya’s turn asked\. Anyone who can write in this project and is viewing this conversation can answer\.$/);
  const submit = () => wrap().querySelector('.user-questions-submit-btn');
  assert.equal(submit().disabled, true, 'nothing answered yet');
  const other = wrap().querySelector('[data-user-question-other-input]');
  other.value = 'Sepia';
  other.dispatchEvent(new m.window.Event('input', { bubbles: true }));
  assert.equal(wrap().querySelector('[data-user-question-other-toggle]').checked, true, 'typing an answer of one\'s own picks it');
  const free = wrap().querySelector('[data-user-question-free-text]');
  free.value = 'Keep it calm';
  free.dispatchEvent(new m.window.Event('input', { bubbles: true }));
  click(m, submit());
  await flush();
  const sent = { team_id: OTHER, session_id: S1, stream_id: 'stream_1', question_ref: 'q_ref_1', answers: [{ question_id: 'colour', answer: '', other: 'Sepia' }, { question_id: 'why', answer: 'Keep it calm' }] };
  assert.deepEqual(m.sent('conversationAnswer'), [sent]);
  assert.match(wrap().querySelector('[data-question-note]').textContent, /Only someone who can write in this project and is viewing this conversation can answer\./);
  assert.deepEqual([wrap().querySelector('[data-user-question-other-input]').value, wrap().querySelector('[data-user-question-free-text]').value, submit().disabled], ['Sepia', 'Keep it calm', false],
    'refused: the card is not redrawn');
  refuse = false;
  key(m, wrap().querySelector('[data-user-question-free-text]'), 'Enter');
  await flush();
  assert.deepEqual(m.sent('conversationAnswer'), [sent, sent], 'Enter in the card submits');
  assert.equal(wrap(), null, 'answered: the card goes before the snapshot says so');
  assert.equal(m.window.document.activeElement, field(m));
  m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot({ pending_questions: [QUESTION] }) });
  assert.equal(wrap(), null, 'a snapshot read before the answer landed does not bring it back');
  m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot() });
  m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot({ pending_questions: [QUESTION] }) });
  assert.ok(wrap(), 'the same question asked again later is shown');
});

test('(d) Skip declines; the asker reads "Your turn asked"; a reader\'s copies, in the row and the popover, are locked', async (t) => {
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ pending_questions: [{ ...QUESTION, prompter_member_id: DOT }] }) } });
  await flush();
  assert.match(m.q('.team-conv__who').textContent, /^Your turn asked\./);
  click(m, m.q('.user-questions-decline-btn'));
  await flush();
  assert.deepEqual(m.sent('conversationDecline'), [{ team_id: OTHER, session_id: S1, stream_id: 'stream_1', question_ref: 'q_ref_1' }]);
  assert.equal(m.q('.team-conv__question'), null);
  const r = mount(t, { role: 'reader', open: { ok: true, snapshot: snapshot({ messages: [ask('u1', 'Pick', 'turn_q', MAYA)], active_turn: running('turn_q', 'u1'), pending_questions: [QUESTION] }) } });
  await flush();
  click(r, chipOf(r, 'turn_q'));
  assert.equal(r.root.querySelectorAll('.team-conv__question').length, 2);
  assert.match(r.q('.team-conv__who').textContent, /Only members who can write in this project can answer\.$/);
  const controls = [...r.root.querySelectorAll('.team-conv__question button, .team-conv__question input, .team-conv__question textarea')];
  assert.ok(controls.length >= 10);
  assert.equal(controls.every((el) => el.disabled), true);
  click(r, r.q('.user-questions-decline-btn'));
  await flush();
  assert.deepEqual(r.sent('conversationDecline'), []);
});

// ------------------------------------------------------------------ (e) the queue

test('(e) the driver queues while a turn runs; the end alone sends nothing; the idle snapshot sends the first; a send while settling waits; Edit, Discard, Copy', async (t) => {
  t.after(() => queues._reset());
  const wrote = [];
  const m = mount(t, { clipboard: { writeText: async (text) => { wrote.push(text); } } });
  await flush();
  stream(m, 'started');
  m.frame();
  assert.match(m.q('[data-conv-box="left"]').textContent, /Jenny is answering · what you send waits for her next turn/);
  enter(m, 'First');
  assert.equal(field(m).value, '', 'the field clears');
  const [row] = queued(m);
  assert.match(row.textContent, /First/);
  assert.equal(row.querySelector('.team-queued').textContent, 'Waits for Jenny’s turn to end');
  assert.deepEqual([queuedButton(row, 'queue-edit').textContent.trim(), queuedButton(row, 'queue-discard').textContent.trim(), queuedButton(row, 'queue-send')], ['Edit', 'Discard', null]);
  enter(m, 'Second');
  stream(m, 'complete');
  m.frame();
  assert.deepEqual(m.sent('conversationSend'), [], 'the end event alone sends nothing');
  enter(m, 'Third');
  assert.equal(queued(m).length, 3, 'sent after the end, before its snapshot: it waits too');
  m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot() });
  await flush();
  m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot() });
  await flush();
  assert.deepEqual(m.sent('conversationSend'), [{ team_id: OTHER, session_id: S1, prompt: 'First' }], 'exactly the first');
  assert.deepEqual(queued(m).map((el) => el.querySelector('.team-msg__text').textContent.trim()), ['Second', 'Third']);
  click(m, queued(m)[1].querySelector('[data-project-action="copy"]'));
  await flush();
  assert.deepEqual(wrote, ['Third'], 'Copy on a waiting row');
  click(m, queuedButton(queued(m)[0], 'queue-edit'));
  assert.equal(field(m).value, 'Second', 'Edit puts the text back');
  click(m, queuedButton(queued(m)[0], 'queue-discard'));
  assert.deepEqual(queued(m), [], 'Discard removes it');
  assert.equal(m.conv.resources().queued, 0);
});

test('(e) Stop pauses with Not sent and Send now; a refused send says why; a takeover pauses; the queue outlives its view', async (t) => {
  t.after(() => queues._reset());
  let refuse = true;
  const m = mount(t, { answers: { conversationSend: () => (refuse ? { ok: false, error: { reason: 'approval_not_viewing' } } : { ok: true }) } });
  await flush();
  stream(m, 'started');
  m.frame();
  enter(m, 'One');
  enter(m, 'Two');
  stream(m, 'cancelled');
  m.frame();
  const words = () => queued(m).map((el) => el.querySelector('.team-queued').textContent);
  assert.deepEqual(words(), ['Not sent', 'Not sent']);
  assert.equal(queuedButton(queued(m)[0], 'queue-send').disabled, true, 'Send now waits for the snapshot after the end');
  m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot() });
  await flush();
  assert.deepEqual(m.sent('conversationSend'), [], 'a stopped turn sends nothing by itself');
  assert.equal(queuedButton(queued(m)[0], 'queue-send').disabled, false);
  click(m, queuedButton(queued(m)[0], 'queue-send'));
  await flush();
  assert.deepEqual(m.sent('conversationSend').map((p) => p.prompt), ['One']);
  assert.equal(words()[0], 'Only someone who can write in this project and is viewing this conversation can answer.', 'the refusal\'s sentence');
  refuse = false;
  stream(m, 'started');
  m.frame();
  enter(m, 'Three');
  assert.equal(words()[2], 'Waits for Jenny’s turn to end');
  m.event('control_changed', { member_id: MAYA, expires_at: 2_000_000 });
  assert.equal(words()[2], 'Not sent', 'another member took over');
  m.restore();
  const again = mount(t);
  await flush();
  assert.deepEqual(queued(again).map((el) => el.querySelector('.team-msg__text').textContent.trim()), ['One', 'Two', 'Three'], 'a new view of the same conversation shows it');
});

test('(e) a non-driver keeps the sentence and the text; the loop counter is not shown; the end clears the sentence', async (t) => {
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ control: { member_id: MAYA, expires_at: 2_000_000 } }) } });
  await flush();
  stream(m, 'started');
  stream(m, 'thinking_status', { text: 'Starting iteration 1/300...' });
  m.frame();
  assert.equal(label(liveRow(m).querySelector('.team-turn-chip')), 'Thinking…');
  assert.equal(liveRow(m).querySelector('[data-project-action="stop"]'), null, 'Maya drives: no Stop for Dot');
  m.event('control_changed', { state: 'released' });
  enter(m, 'Also, what is 2+2?');
  assert.equal(queued(m).length, 1, 'nobody drives: anyone may queue');
  queues._reset();
  m.event('control_changed', { member_id: MAYA, expires_at: 2_000_000 });
  enter(m, 'Also, what is 3+3?');
  await flush();
  assert.deepEqual(m.sent('conversationSend'), [], 'nothing is sent while the turn runs');
  assert.equal(field(m).value, 'Also, what is 3+3?');
  assert.match(box(m), /Jenny is still answering\. Send this when the turn ends, or stop it first\./);
  stream(m, 'complete');
  m.frame();
  assert.doesNotMatch(box(m), /Jenny is still answering/, 'the sentence goes when the turn ends');
});

// ------------------------------------------------------------------ (f) the composer, pages, title, Copy

test('(f) the #team composer: the placeholder names the conversation; the code button fences the selection; the Tools chip and the model pill replace "Jenny answers with"', async (t) => {
  const node = { node_id: 'node_maya', member_id: MAYA, label: 'Maya PC', online: true, paused: false, busy_slots: 0, models: [{ name: 'qwen3' }] };
  const m = mount(t, { teamRole: 'owner', gpus: { nodes: [node] } });
  await flush();
  const f = field(m);
  assert.deepEqual([f.className, f.placeholder, f.getAttribute('aria-label'), Boolean(f.closest('.team-composer'))],
    ['team-composer__input', 'Message “Palette loader cleanup”', 'Message “Palette loader cleanup”', true]);
  type(m, 'see load() here');
  f.setSelectionRange(4, 10);
  click(m, m.q('[data-conv-box="left"] [data-project-action="code"]'));
  assert.equal(f.value, 'see \n```\nload()\n``` here');
  m.conv.push({ kind: 'lease', session_id: S1, held: true });
  const hint = () => m.q('[data-conv-box="left"] .team-composer__hint');
  assert.equal(hint().textContent, 'Markdown · Enter to send');
  const [tools, pill] = ['.composer-tools-chip', '.composer-model-pill'].map((c) => m.q(`[data-conv-box="left"] .inv-chip${c}`));
  assert.deepEqual([tools.textContent.trim(), pill.textContent.trim()], ['Toolsoff on this host', 'qwen3'], 'the shipped chip and pill; the one model the GPUs offer is the default');
  assert.equal(m.q('.chat-sprite-layer, .composer-send'), null, 'no sprite and no row 169 composer');
  const w = mount(t, { open: { ok: true, snapshot: snapshot({ messages: [ask('u1', 'How many?', 'turn_1'), said('a1', 'Seven.', 'turn_1', { model_used: 'qwen3:30b' })] }) } });
  await flush();
  w.conv.push({ kind: 'lease', session_id: S1, held: true });
  assert.equal(w.q('[data-conv-box="left"] .team-conv__model, [data-conv-box="left"] [data-team-tab-action="share-settings"]'), null, 'no model fact and no Settings link');
});

test('earlier messages: one older page per click with the host\'s cursor, put before what is held; a refusal says so; a later snapshot keeps them', async (t) => {
  const older = snapshot({ messages: [message('m-2', 'user', 'First of all'), message('m-1', 'assistant', 'The very start')], has_more: false });
  let answer = { ok: false, error: { reason: 'message_cursor_unknown' } };
  const m = mount(t, { open: (payload) => (payload.before_message_id ? answer : { ok: true, snapshot: snapshot({ has_more: true, next_before_message_id: 'm1' }) }) });
  await flush();
  const scroller = m.q('.team-conv__scroll');
  // 300 px a row: 1000 px with the two it opens with, 1600 px with the older page above them.
  Object.defineProperty(scroller, 'scrollHeight', { get: () => 400 + 300 * m.root.querySelectorAll('.team-msg').length, configurable: true });
  Object.defineProperty(scroller, 'clientHeight', { get: () => 200, configurable: true });
  scroller.scrollTop = 0;
  scroller.dispatchEvent(new m.window.Event('scroll'));
  const button = () => m.q('[data-project-action="earlier"]');
  button().focus();
  click(m, button());
  assert.deepEqual([button().disabled, button().textContent], [true, 'Loading earlier messages…']);
  await flush();
  assert.deepEqual(m.sent('conversationOpen'), [{ team_id: OTHER, session_id: S1 }, { team_id: OTHER, session_id: S1, before_message_id: 'm1' }]);
  assert.ok(button() && !button().disabled, 'refused: the button is back');
  assert.ok(m.q('[data-conv-region="log"] .team-note-line'), 'with the reason');
  answer = { ok: true, snapshot: older };
  click(m, button());
  await flush();
  assert.deepEqual(rowIds(m), ['m-2', 'after:m-2', 'm1', 'after:m1']);
  assert.equal(button(), null, 'nothing before these');
  assert.equal(m.q('[data-conv-region="log"] .team-note-line'), null);
  assert.equal(scroller.scrollTop, 600, 'what the person was reading stays where it was: the page grew above it');
  m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot({ has_more: true, next_before_message_id: 'm1',
    messages: [message('m2', 'assistant', 'It reads it once in **load**.'), message('m3', 'user', 'Thanks', { author: { kind: 'member', member_id: DOT } })] }) });
  assert.deepEqual(rowIds(m), ['m-2', 'after:m-2', 'm1', 'after:m1', 'm3'], 'a newer page joins what is held');
  assert.equal(button(), null, 'and the older pages read stay read');
  assert.equal(m.conv.resources().cached, 5);
});

test('the title: the pen opens a field in the head; Enter saves through conversationRename, Escape and an unchanged name do not; a refusal stays', async (t) => {
  let answer = { ok: false, error: { reason: 'control_lease_unavailable' } };
  const m = mount(t, { answers: { conversationRename: () => answer } });
  await flush();
  const pen = () => m.q('[data-project-action="rename"]');
  const input = () => m.q('#teamConversationTitle');
  assert.deepEqual([pen().disabled, pen().getAttribute('title'), pen().getAttribute('aria-label')], [false, 'Rename this conversation', 'Rename this conversation']);
  click(m, pen());
  assert.equal(input().value, 'Palette loader cleanup');
  assert.equal(m.window.document.activeElement, input());
  assert.equal(m.q('.team-head__name'), null, 'the field takes the title\'s place');
  key(m, input(), 'Escape');
  assert.deepEqual([input(), m.q('.team-head__name').textContent, m.window.document.activeElement === pen()], [null, 'Palette loader cleanup', true]);
  click(m, pen());
  key(m, input(), 'Enter');
  assert.deepEqual([input(), m.sent('conversationRename')], [null, []], 'unchanged: no call');
  click(m, pen());
  input().value = '  Loader, read once  ';
  input().dispatchEvent(new m.window.Event('input', { bubbles: true }));
  m.conv.push({ kind: 'viewers', session_id: S1, viewers: [DOT, MAYA] });
  assert.deepEqual([input().value, m.window.document.activeElement === input()], ['  Loader, read once  ', true], 'a redraw of the head keeps what is typed and the focus');
  // The browser reports the field a redraw replaced as left; the save is decided a moment later, focus on the new one.
  input().dispatchEvent(new m.window.FocusEvent('focusout', { bubbles: true }));
  m.advance(0);
  await flush();
  assert.deepEqual(m.sent('conversationRename'), [], 'a redraw is not the person leaving');
  key(m, input(), 'Enter');
  await flush();
  assert.deepEqual(m.sent('conversationRename'), [{ team_id: OTHER, session_id: S1, title: 'Loader, read once' }]);
  assert.equal(input().value, '  Loader, read once  ', 'refused: the field stays');
  assert.equal(m.q('.team-head [role="status"]').textContent.length > 0, true, 'with the reason');
  answer = { ok: true };
  key(m, input(), 'Enter');
  await flush();
  assert.deepEqual([input(), m.q('.team-head__name').textContent, m.q('.team-head__name').getAttribute('title')], [null, 'Loader, read once', 'Loader, read once']);
  assert.equal(m.window.document.activeElement, pen());
  click(m, pen());
  const left = input();
  left.value = 'Left by tabbing away';
  left.dispatchEvent(new m.window.Event('input', { bubbles: true }));
  field(m).focus();
  left.dispatchEvent(new m.window.FocusEvent('focusout', { bubbles: true }));
  m.advance(0);
  await flush();
  assert.equal(m.sent('conversationRename').pop().title, 'Left by tabbing away', 'leaving the field saves, as Enter does');
  assert.equal(m.q('.team-head__name').textContent, 'Left by tabbing away');
});

test('after a rename the composer placeholder names the new title', async (t) => {
  const m = mount(t);
  await flush();
  click(m, m.q('[data-project-action="rename"]'));
  const input = m.q('#teamConversationTitle');
  input.value = 'Loader, read once';
  input.dispatchEvent(new m.window.Event('input', { bubbles: true }));
  key(m, input, 'Enter');
  await flush();
  assert.equal(field(m).placeholder, 'Message “Loader, read once”');
});

test('Copy puts the saved message on the clipboard and says so on the button for a moment; the jump pill appears when scrolled up', async (t) => {
  const wrote = [];
  const m = mount(t, { clipboard: { writeText: async (text) => { wrote.push(text); } } });
  await flush();
  const copy = () => m.q('.team-msg[data-turn-id="after:m1"] .team-acts [data-project-action="copy"]');
  assert.deepEqual([copy().dataset.messageId, copy().getAttribute('aria-label'), copy().getAttribute('title')], ['m2', 'Copy message', 'Copy message']);
  click(m, copy());
  await flush();
  assert.deepEqual(wrote, ['It reads it once in **load**.'], 'the text as it was written, not its markup');
  assert.equal(copy().getAttribute('aria-label'), 'Copied');
  m.advance(1500);
  assert.equal(copy().getAttribute('aria-label'), 'Copy message');
  const scroller = m.q('.team-conv__scroll');
  const pill = m.q('.chat-jump-latest');
  Object.defineProperty(scroller, 'scrollHeight', { get: () => 1000, configurable: true });
  Object.defineProperty(scroller, 'clientHeight', { get: () => 200, configurable: true });
  assert.deepEqual([pill.dataset.visible, pill.hasAttribute('inert'), pill.getAttribute('title')], ['false', true, 'Jump to the latest message']);
  scroller.scrollTop = 100;
  scroller.dispatchEvent(new m.window.Event('scroll'));
  assert.deepEqual([pill.dataset.visible, pill.hasAttribute('inert')], ['true', false]);
  click(m, pill);
  assert.deepEqual([scroller.scrollTop, pill.dataset.visible, m.window.document.activeElement === field(m)], [1000, 'false', true]);
});

test('host shapes: saved reasoning in entries reaches the popover; the pool alias names no model; a failed turn keeps what it thought', async (t) => {
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ messages: [
    ask('u1', 'Why is the sky blue?', 'turn_1'), said('a1', 'Rayleigh scattering.', 'turn_1', { model_used: 'team-pool', reasoning: { source: 'provider', entries: [{ id: 'r1', text: 'Short answer.' }] } }),
    ask('u2', 'An essay, please.', 'turn_2'), said('a2', '', 'turn_2', { status: 'runtime_error', model_used: 'team-pool', reasoning: { source: 'provider', entries: [{ id: 'r2', text: 'Planning the essay.' }] } })] }) } });
  await flush();
  assert.equal(m.q('.reasoning-row-block'), null, 'no reasoning in the channel');
  click(m, chipOf(m, 'turn_1'));
  assert.match(m.q('#teamTurnPop .reasoning-row-header').textContent, /Short answer\./);
  assert.doesNotMatch(m.q('#teamTurnPop .team-turn-pop__title').textContent, /team-pool/, 'the alias names no model');
  click(m, chipOf(m, 'turn_2'));
  assert.match(m.q('#teamTurnPop .reasoning-row-header').textContent, /Planning the essay\./);
});

test('hostile text in a status, a model and a question makes no element; an empty conversation says what it is, for a reader too', async (t) => {
  const evil = '<img src=x onerror="globalThis.pwned=1"><b data-evil="1">E</b>‮';
  NAMES.member_evil = evil;
  t.after(() => { delete NAMES.member_evil; });
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ messages: [ask('u1', 'hi', 'turn_1', 'member_evil'), said('a1', 'ok', 'turn_1', { model_used: evil, reasoning: { source: 'p', entries: [{ id: 'r', text: 'plain' }] } })],
    pending_questions: [{ ...QUESTION, prompter_member_id: 'member_evil', questions: [{ id: evil, prompt: evil, options: [evil] }] }] }) } });
  await flush();
  stream(m, 'started');
  stream(m, 'thinking_status', { text: evil });
  m.frame();
  click(m, chipOf(m, 'turn_1'));
  assert.equal(m.root.querySelector('[data-evil], [onerror], img'), null);
  assert.equal(globalThis.pwned, undefined);
  assert.equal([...m.root.querySelectorAll('.team-conv__who, .team-turn-chip, .team-turn-pop__title, .team-msg__author')].some((el) => el.textContent.includes('‮')), false, 'no bidi control drawn');
  const empty = mount(t, { role: 'reader', open: { ok: true, snapshot: snapshot({ messages: [] }) } });
  await flush();
  assert.match(empty.q('.team-conv__hero').textContent, /New conversation.*In jenny-site\..*You can read here; writers and admins can send\./);
  assert.equal(empty.q('[data-project-action="earlier"]'), null);
});

test('in the tab: what is typed and not sent is kept per conversation while the app runs, and sending clears it', async (t) => {
  const { h } = await openProjects({ list: listAnswer({ projects: [project(P1, 'jenny-site', 'writer')] }) });
  t.after(h.restore);
  const open = async () => { h.view.q(`[data-session-id="${S1}"]`).click(); await flush(); return region(h).querySelector('#teamConversationInput'); };
  let input = await open();
  input.value = 'Half a thought';
  input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  h.view.q('[data-team-channel="chan_team"]').click();
  await flush();
  input = await open();
  assert.equal(input.value, 'Half a thought');
  input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();
  assert.deepEqual(h.sent('conversationSend').map((call) => call.payload.prompt), ['Half a thought']);
  h.view.q('[data-team-channel="chan_team"]').click();
  await flush();
  assert.equal((await open()).value, '', 'sent: nothing is kept');
});
