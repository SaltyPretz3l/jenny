'use strict';

// new-test-file: row 175, the conversation controller's paint cost and recovery (reasoning throttle, tick and question
// sync, self-close focus, reopen after a failed open, one full live turn with the popover open) in jsdom. The siblings
// tests/renderer-team-projects-conversation.test.js (600 lines) and its -chat sibling (590) have no room left. It also holds
// the message box's own cases (row 175 F6 drafts on this PC, F7 the offline hint, item 15 the batch banner), for the same reason.

const test = require('node:test');
const assert = require('node:assert/strict');

const { OTHER, S1, DOT, MAYA, LENA, message, approval, snapshot, flush } = require('./helpers/team-project-renderer-host');
const { mount, field, box, type } = require('./helpers/team-conversation-mount');

const T0 = Date.parse('2026-11-12T10:31:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const ask = (id, content, turn, by = DOT) => message(id, 'user', content, { author: { kind: 'member', member_id: by }, turn_id: turn, timestamp: at(0) });
const said = (id, content, turn, over = {}) => message(id, 'assistant', content, { kind: undefined, turn_id: turn, timestamp: at(1), ...over });
const toolUse = (id, turn, path) => message(id, 'assistant', 'read_file', { kind: 'tool_use', turn_id: turn, timestamp: at(2),
  tool_call: { call_id: 'call_' + id, tool_name: 'read_file', input_json: JSON.stringify({ path }), status: 'complete' } });
const toolResult = (id, turn, call) => message(id, 'tool', '', { kind: 'tool_result', turn_id: turn, timestamp: at(3),
  tool_result: { call_id: call, tool_name: 'read_file', output_text: 'export const load = once;', is_error: false, duration_ms: 40 } });
const running = (turn, user) => ({ stream_id: 'stream_1', turn_id: turn, user_message_id: user, status: 'running' });
const reasoning = (text) => ({ reasoning: [{ id: 'r1', text }] });
const QUESTION = { question_ref: 'q_ref_1', stream_id: 'stream_1', call_id: 'call_q', prompter_member_id: MAYA, questions: [{ id: 'why', prompt: 'Anything to add?' }] };

const stream = (m, type, extra = {}) => m.event('chat_stream', { stream_id: 'stream_1', event: { type, ...extra } });
const click = (m, el) => el.dispatchEvent(new m.window.MouseEvent('click', { bubbles: true, cancelable: true }));
const liveChip = (m) => m.q('[data-conv-region="live"] .team-turn-chip');
const pop = (m) => m.q('#teamTurnPop');
const snap = (m, over) => m.conv.push({ kind: 'snapshot', session_id: S1, snapshot: snapshot(over) });
// Past the 100 ms text and reasoning window, then the frame that paints what waited.
const settle = (m) => { m.advance(100); m.frame(); };
// How many reasoning bodies and answer bubbles in the popover hold `word` (a reasoning row's header repeats its words by design).
const copies = (m, word) => [...pop(m).querySelectorAll('[data-row-kind="reasoning"] .reasoning-row-panel-body, [data-row-kind="assistant_text"] .chat-bubble')].filter((el) => el.textContent.includes(word)).length;

async function openPop(t, options) {
  const m = mount(t, options);
  await flush();
  stream(m, 'started');
  m.frame();
  click(m, liveChip(m));
  assert.ok(pop(m), 'the popover is open on the running turn');
  return m;
}

test('(D1) reasoning deltas with the popover open paint at most once per 100 ms window; the last change always paints', async (t) => {
  const m = await openPop(t, { open: { ok: true, snapshot: snapshot({ messages: [] }) } });
  m.advance(100);
  m.renders.pop = 0;
  stream(m, 'reasoning', reasoning('Look at'));
  m.frame();
  const first = m.renders.pop;
  assert.equal(first, 1, 'the first change after a quiet moment paints at once');
  for (const text of ['Look at the', 'Look at the loader', 'Look at the loader first']) { stream(m, 'reasoning', reasoning(text)); m.frame(); }
  assert.equal(m.renders.pop, first, 'three more deltas in the same window paint nothing');
  settle(m);
  assert.equal(m.renders.pop, first + 1, 'one trailing paint after the window');
  assert.match(pop(m).textContent, /Look at the loader first/, 'and it holds the last change');
  m.frame();
  assert.equal(m.renders.pop, first + 1, 'nothing more is drawn');
});

test('(D3) the tick draws the popover head and not its body; the questions sync only when the live row or the popover markup changed', async (t) => {
  const m = await openPop(t, { open: { ok: true, snapshot: snapshot({ messages: [] }) } });
  const scroll = m.q('#teamTurnPop .team-turn-pop__scroll');
  const watch = new m.window.MutationObserver(() => {});
  watch.observe(scroll, { childList: true, subtree: true, characterData: true, attributes: true });
  watch.takeRecords();
  m.advance(3000);
  assert.match(m.q('#teamTurnPop .team-turn-pop__title span').textContent, /3s/, 'the head ticks');
  assert.equal(watch.takeRecords().length, 0, 'the body is left alone');
  watch.disconnect();
});

test('(D3) a popover repaint that changes no card does not run the questions sync again', async (t) => {
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ messages: [ask('u1', 'Pick', 'turn_q', MAYA)], active_turn: running('turn_q', 'u1'), pending_questions: [QUESTION] }) } });
  // mount loads a fresh copy of the timeline: the controller's parts call this one.
  const tl = require('../renderer/team/renderer-team-project-timeline');
  await flush();
  click(m, liveChip(m));
  assert.ok(m.q('#teamTurnPop .team-conv__question'), 'the card is in the popover');
  const real = tl.lockQuestion;
  let locks = 0;
  tl.lockQuestion = (...args) => { locks += 1; return real(...args); };
  t.after(() => { tl.lockQuestion = real; });
  stream(m, 'reasoning', reasoning('Thinking about it'));
  settle(m);
  assert.match(pop(m).textContent, /Thinking about it/, 'the popover was drawn again');
  assert.equal(locks, 0, 'the same cards: no sync');
  snap(m, { messages: [ask('u1', 'Pick', 'turn_q', MAYA)], active_turn: running('turn_q', 'u1'), pending_questions: [QUESTION, { ...QUESTION, question_ref: 'q_ref_2' }] });
  assert.ok(locks > 0, 'a second card: synced');
});

test('(B5) a popover that closes itself while it holds focus gives the focus to the box', async (t) => {
  const older = [ask('u0', 'Hello', 'turn_0'), said('a0', 'Hi.', 'turn_0')];
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ messages: older }) } });
  await flush();
  click(m, m.q('.team-turn-chip[data-turn-id="turn_0"]'));
  assert.equal(m.window.document.activeElement, m.q('.team-turn-pop__scroll'), 'focus is in the popover');
  snap(m, { messages: [ask('u9', 'New start', 'turn_9'), said('a9', 'Fresh.', 'turn_9')] });
  assert.equal(pop(m), null, 'its turn left the held history: it closes');
  assert.equal(m.window.document.activeElement, field(m), 'the box has the focus');
});

test('(B5) a popover that closes itself while focus is elsewhere leaves the focus alone', async (t) => {
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ messages: [ask('u0', 'Hello', 'turn_0'), said('a0', 'Hi.', 'turn_0')] }) } });
  await flush();
  click(m, m.q('.team-turn-chip[data-turn-id="turn_0"]'));
  const other = m.window.document.createElement('button');
  m.window.document.body.appendChild(other);
  other.focus();
  snap(m, { messages: [ask('u9', 'New start', 'turn_9'), said('a9', 'Fresh.', 'turn_9')] });
  assert.equal(pop(m), null);
  assert.equal(m.window.document.activeElement, other);
});

const failed = { ok: false, error: { reason: 'timeout' } };
const tryAgain = (m) => {
  m.q('[data-conv-region="log"]').insertAdjacentHTML('beforeend', '<button type="button" data-project-action="reopen">Try again</button>');
  return m.q('[data-project-action="reopen"]');
};

test('(F8) Try again in the log opens the conversation again and clears the sentence', async (t) => {
  let opens = 0;
  const m = mount(t, { open: () => { opens += 1; return opens === 1 ? failed : { ok: true, snapshot: snapshot({ messages: [ask('u1', 'Back again', 'turn_1'), said('a1', 'Here.', 'turn_1')] }) }; } });
  await flush();
  assert.equal(opens, 1);
  assert.ok(m.q('[data-conv-region="log"] .team-page__lede'), 'the sentence stands in the log');
  click(m, tryAgain(m));
  await flush();
  assert.equal(opens, 2, 'the same open ran again');
  assert.equal(m.q('[data-conv-region="log"] .team-page__lede'), null, 'the sentence is gone');
  assert.match(m.text('[data-conv-region="log"]'), /Back again/);
  assert.equal(m.sent('conversationClose').length, 0);
});

test('(F8) the team coming back online retries a failed open once', async (t) => {
  let opens = 0;
  const m = mount(t, { open: () => { opens += 1; return opens < 3 ? failed : { ok: true, snapshot: snapshot() }; } });
  await flush();
  assert.equal(opens, 1);
  m.conv.update({ type: 'roster', team_id: OTHER });
  await flush();
  assert.equal(opens, 2, 'retried when the team changed (online)');
  m.conv.update({ type: 'roster', team_id: OTHER });
  await flush();
  assert.equal(opens, 2, 'once: a second failure waits for Try again');
  click(m, tryAgain(m));
  await flush();
  assert.equal(opens, 3);
  assert.equal(m.q('[data-conv-region="log"] .team-page__lede'), null);
});

test('(F8) no retry while the team is not online', async (t) => {
  let opens = 0;
  const m = mount(t, { teamState: 'connecting', open: () => { opens += 1; return failed; } });
  await flush();
  m.conv.update({ type: 'roster', team_id: OTHER });
  await flush();
  assert.equal(opens, 1);
});

test('one full live turn with the popover open: no duplicated text, the same aside through the stream-id to saved-id rename, the box takes focus at the end', async (t) => {
  const m = await openPop(t, { open: { ok: true, snapshot: snapshot({ messages: [] }) } });
  const aside = pop(m);
  const text = () => pop(m).textContent;
  const ok = (step) => {
    assert.equal(pop(m), aside, step + ': the same aside');
    for (const word of ['Plan the read', 'Reading it.', 'It loads once.']) assert.ok(copies(m, word) <= 1, `${step}: "${word}" drawn ${copies(m, word)} times`);
  };
  const prompt = ask('u1', 'Check src/app.js', 'turn_1');
  const seg0 = said('a1', 'Reading it.', 'turn_1', { reasoning: { source: 'provider', entries: [{ id: 'r1', text: 'Plan the read' }] } });
  stream(m, 'reasoning', reasoning('Plan the read'));
  settle(m);
  ok('reasoning');
  assert.match(text(), /Plan the read/);
  stream(m, 'delta', { content: 'Reading it.' });
  settle(m);
  ok('delta');
  assert.match(text(), /Reading it\./);
  stream(m, 'tool_use', { call_id: 'call_t1', tool_name: 'read_file' });
  snap(m, { active_turn: running('turn_1', 'u1'), messages: [prompt, seg0, toolUse('t1', 'turn_1', 'src/app.js')] });
  settle(m);
  ok('tool_use and its snapshot (the rename to turn_1)');
  assert.equal(pop(m).dataset.turnId, 'turn_1', 'the popover follows the saved turn');
  stream(m, 'tool_result', { call_id: 'call_t1', tool_name: 'read_file', status: 'ok' });
  snap(m, { active_turn: running('turn_1', 'u1'), messages: [prompt, seg0, toolUse('t1', 'turn_1', 'src/app.js'), toolResult('r1', 'turn_1', 'call_t1')] });
  settle(m);
  ok('tool_result and its snapshot');
  stream(m, 'delta', { content: 'It loads once.' });
  settle(m);
  ok('the second delta');
  assert.match(text(), /It loads once\./, 'the unsaved words show after the first tool call');
  stream(m, 'complete');
  settle(m);
  ok('complete');
  snap(m, { messages: [prompt, seg0, toolUse('t1', 'turn_1', 'src/app.js'), toolResult('r1', 'turn_1', 'call_t1'), said('a2', 'It loads once.', 'turn_1', { timestamp: at(4) })] });
  settle(m);
  ok('the final snapshot');
  assert.match(text(), /It loads once\./);
  assert.equal(pop(m), aside, 'the popover stayed open on the same element to the end');
  // Self-close returns focus to the box.
  pop(m).querySelector('.team-turn-pop__scroll').focus();
  snap(m, { messages: [ask('u9', 'New start', 'turn_9'), said('a9', 'Fresh.', 'turn_9')] });
  assert.equal(pop(m), null);
  assert.equal(m.window.document.activeElement, field(m));
});

// ------------------------------------------------------------ row 175: the message box

const saved = (m) => m.sent('projectDraftSet');
const sendButton = (m) => m.q('[data-project-action="send"]');

test('(F6) the box text is written to this PC after a pause, and never as a send', async (t) => {
  const m = mount(t);
  await flush();
  type(m, 'half a');
  type(m, 'half a prompt');
  assert.equal(saved(m).length, 0, 'not on every key');
  m.advance(1000);
  assert.deepEqual(saved(m), [{ team_id: OTHER, session_id: S1, text: 'half a prompt' }], 'one write after the pause');
  assert.equal(m.sent('conversationSend').length, 0, 'nothing went to the host');
});

test('(F6) draft restored after reopen: a new run reads what main kept into the box', async (t) => {
  // The renderer's memory is gone in a new run (mount loads a fresh copy of the view); the answer is what main kept.
  const m = mount(t, { answers: { projectDraftGet: { ok: true, text: 'half a prompt' } } });
  await flush();
  assert.deepEqual(m.sent('projectDraftGet'), [{ team_id: OTHER, session_id: S1 }]);
  assert.equal(field(m).value, 'half a prompt');
  assert.equal(m.sent('conversationSend').length, 0);
});

test('(F6) text typed before the saved draft arrives stays; a pending write goes when the view closes', async (t) => {
  const m = mount(t, { answers: { projectDraftGet: { ok: true, text: 'older draft' } } });
  type(m, 'newer words');
  await flush();
  assert.equal(field(m).value, 'newer words');
  m.conv.dispose();
  assert.deepEqual(saved(m), [{ team_id: OTHER, session_id: S1, text: 'newer words' }], 'closing flushes the write that waited');
});

test('(F6) Send clears the saved draft at once, and so does a deleted conversation', async (t) => {
  const m = mount(t);
  await flush();
  type(m, 'Ship it');
  m.advance(1000);
  sendButton(m).click();
  await flush();
  assert.equal(m.sent('conversationSend').length, 1);
  assert.equal(field(m).value, '');
  assert.deepEqual(saved(m).map((p) => p.text), ['Ship it', ''], 'the empty text is written without waiting');
  type(m, 'More');
  m.event('session_changed', { state: 'deleted' });
  assert.equal(saved(m).at(-1).text, '', 'a deleted conversation keeps no draft');
});

const OFFLINE_HINTS = [['offline', 'Sends when the host is back'], ['connecting', 'Sends when reconnected'], ['reconnecting', 'Sends when reconnected']];

test('(F7) while the team is not online the box says when it sends, Send waits with its reason, and the text stays', async (t) => {
  for (const [state, hint] of OFFLINE_HINTS) {
    const m = mount(t, { teamState: state });
    await flush();
    type(m, 'Please check the loader');
    assert.ok(box(m).includes(hint), `${state}: ${box(m)}`);
    assert.equal(sendButton(m).disabled, true, state);
    assert.equal(sendButton(m).getAttribute('title'), hint, 'the reason is on the button');
    assert.equal(sendButton(m).getAttribute('aria-description'), hint);
    sendButton(m).click();
    field(m).dispatchEvent(new m.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    m.advance(60_000);
    await flush();
    assert.equal(m.sent('conversationSend').length, 0, state + ': nothing is sent');
    assert.equal(field(m).value, 'Please check the loader', 'the text stays');
    m.restore();
  }
});

// The team coming back online while the box is open: the helper mounts one state for good, so the same view is opened again over a state that changes.
function reopenOver(t, m, link) {
  m.conv.dispose();
  const { createConversation } = require('../renderer/team/renderer-team-project-conversation');
  const { clean } = require('../renderer/team/renderer-team-project-column');
  const sent = [];
  const store = { call: (method, payload) => { if (method === 'conversationSend') sent.push(payload); return Promise.resolve(method === 'conversationOpen' ? { ok: true, snapshot: snapshot() } : { ok: true }); },
    project: () => ({ id: 'project_aaaaaaaaaaaa', name: 'jenny-site', role: 'writer' }), conversationsOf: () => [] };
  const conv = createConversation({ root: m.root, teamId: OTHER, projectId: 'project_aaaaaaaaaaaa', sessionId: S1, store,
    ctx: () => ({ team: { team_id: OTHER, team_name: 'Dot lab', state: link.state, member_id: DOT, role: 'member' }, nameOf: (id) => clean(id, 64), errorText: () => 'error' }) });
  t.after(() => conv.dispose());
  return { conv, sent };
}

test('(F7, D3) coming back online sends nothing by itself: Send turns on, the text is still there, and the member presses it once', async (t) => {
  const m = mount(t, { teamState: 'offline' });
  const link = { state: 'offline' };
  const { conv, sent } = reopenOver(t, m, link);
  await flush();
  type(m, 'Waiting for the team');
  assert.equal(sendButton(m).disabled, true);
  link.state = 'online';
  conv.update({ type: 'roster', team_id: OTHER });
  await flush();
  assert.equal(sendButton(m).disabled, false, 'Send is back');
  assert.ok(!box(m).includes('Sends when'), 'the hint is gone');
  assert.equal(field(m).value, 'Waiting for the team');
  assert.equal(sent.length, 0, 'nothing fired on its own');
  sendButton(m).click();
  await flush();
  assert.deepEqual(sent, [{ team_id: OTHER, session_id: S1, prompt: 'Waiting for the team' }]);
});

// ------------------------------------------------------------ item 15: Allow all N

const EXACT_TOO_LARGE = { schema_version: 1, too_large: true, bytes: 99999, limit_bytes: 32768 };
const three = (over = {}) => [approval({ approval_id: 'appr_1', call_id: 'call_1', decision_revision: 'rev_1' }), approval({ approval_id: 'appr_2', call_id: 'call_2', decision_revision: 'rev_2' }),
  approval({ approval_id: 'appr_3', call_id: 'call_3', decision_revision: 'rev_3', ...over })];
const banner = (m) => m.q('[data-team-batch]');
const decided = (m) => m.sent('conversationDecide').map((p) => [p.approval_id, p.approved]);

test('(15) two or more approvals in one turn give a writer Allow all N and Deny all; each is decided once, in order, through the one decision call', async (t) => {
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ pending_approvals: three() }) } });
  await flush();
  assert.match(banner(m).textContent, /3 tools waiting for approval/);
  assert.equal(banner(m).querySelector('[data-project-action="allow-all"]').textContent, 'Allow all 3');
  assert.equal(banner(m).querySelector('[data-project-action="deny-all"]').textContent, 'Deny all');
  banner(m).querySelector('[data-project-action="allow-all"]').click();
  await flush();
  assert.deepEqual(m.sent('conversationDecide'), ['appr_1', 'appr_2', 'appr_3'].map((id, i) => ({ team_id: OTHER, session_id: S1, stream_id: 'stream_1', approval_id: id,
    decision_revision: 'rev_' + (i + 1), approved: true })), 'once each, in order, with no always');
  assert.equal(banner(m), null, 'nothing is left to decide');
});

test('(15) Deny all denies every approval of the turn; an approval whose Allow is withheld is denied but never allowed in a batch', async (t) => {
  const open = { ok: true, snapshot: snapshot({ pending_approvals: three({ tool_name: 'write_file', exact_approval: EXACT_TOO_LARGE }) }) };
  const m = mount(t, { open });
  await flush();
  assert.equal(m.q('[data-project-action="allow-all"]').textContent, 'Allow all 2', 'the card with no Allow is not counted');
  m.q('[data-project-action="allow-all"]').click();
  await flush();
  assert.deepEqual(decided(m), [['appr_1', true], ['appr_2', true]], 'the third was not allowed');
  const n = mount(t, { open });
  await flush();
  n.q('[data-project-action="deny-all"]').click();
  await flush();
  assert.deepEqual(decided(n), [['appr_1', false], ['appr_2', false], ['appr_3', false]]);
});

test('(15) the first refusal stops the batch and says so; the rest stay as cards', async (t) => {
  let calls = 0;
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ pending_approvals: three() }) },
    answers: { conversationDecide: () => { calls += 1; return calls === 2 ? { ok: false, error: { reason: 'approval_not_viewing' } } : { ok: true, revision: 'r2' }; } } });
  await flush();
  m.q('[data-project-action="allow-all"]').click();
  await flush();
  assert.deepEqual(decided(m), [['appr_1', true], ['appr_2', true]], 'no call after the refusal');
  assert.match(box(m), /Stopped at the first approval that was refused/);
  assert.ok(m.q('.tool-approve-btn[data-approval-id="appr_3"]'), 'the third card is still there to answer');
});

test('(15) no banner for a reader or for one approval; a writer sees it while another member drives, and it goes when others answered', async (t) => {
  const reader = mount(t, { role: 'reader', open: { ok: true, snapshot: snapshot({ pending_approvals: three() }) } });
  await flush();
  assert.equal(banner(reader), null, 'readers get no banner');
  reader.restore();
  const one = mount(t, { open: { ok: true, snapshot: snapshot({ pending_approvals: three().slice(0, 1) }) } });
  await flush();
  assert.equal(banner(one), null, 'one approval has its card');
  one.restore();
  const driven = mount(t, { open: { ok: true, snapshot: snapshot({ pending_approvals: three(), control: { member_id: LENA, expires_at: 2_000_000 } }) } });
  await flush();
  assert.match(banner(driven).textContent, /3 tools waiting/);
  driven.event('decision_changed', { stream_id: 'stream_1', approval_id: 'appr_2', approver_member_id: MAYA, approved: true });
  driven.event('decision_changed', { stream_id: 'stream_1', approval_id: 'appr_3', approver_member_id: MAYA, approved: false });
  assert.equal(banner(driven), null, 'two answered by others: one card is left');
});
