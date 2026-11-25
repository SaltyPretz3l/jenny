'use strict';

// new-test-file: a new surface (row 151 slice T9): the History of a team board in the conversation column and the deleted boards list under
// the boards list, over the real Board page in team scope and the scripted `team` bridge of tests/helpers/board-team-page-kit.js. Time and
// the two debounce timers (600 ms history, 300 ms deleted boards) are driven by the tests, never waited for.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const fx = require('./helpers/board-hostile-fixtures');
const K = require('./helpers/board-team-page-kit');

const { host, TEAM, PROJECT, DOT, MAYA, boardId, teamBoard, tick } = K;
const GONE = 'member_gone';
const NOW_MS = new Date(2026, 10, 15, 12, 0).getTime();
const at = (day, hour, minute) => new Date(2026, 10, day, hour, minute).toISOString();
const BOARDS = [teamBoard(1, 'Plan', K.note(1, 'hello')), teamBoard(2, 'Ideas')];
const change = (rev, actor, when, kind, ops, over = {}) => ({ rev, actor, at: when, kind, of_rev: null, ops, takeable: true, reverted: false, ...over });
const listOf = (...changes) => ({ ok: true, rev: 99, changes });
const projectsAs = (role) => host.listAnswer({ projects: [host.project(PROJECT, 'jenny-site', role)] });
const iso = (name) => `⁨${name}⁩`;
const ISO = /⁨([^⁨⁩]*)⁩/g;
const unsafe = (text) => Array.from(text).some((ch) => { const c = ch.codePointAt(0); return c < 32 || (c >= 127 && c < 160) || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069); });
const tag = () => (globalThis.jennyI18n && globalThis.jennyI18n.tag ? globalThis.jennyI18n.tag() : undefined);
const clockText = (when) => new Intl.DateTimeFormat(tag(), { hour: 'numeric', minute: '2-digit' }).format(new Date(when));
const dateText = (when) => new Intl.DateTimeFormat(tag(), { dateStyle: 'medium' }).format(new Date(when));
const key = (m, target, k) => target.dispatchEvent(new m.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const deferred = () => { const out = {}; out.promise = new Promise((resolve) => { out.resolve = resolve; }); return out; };

// A team project with the chat column open. The clock of the page is set; the two debounce timers are held by `timers`.
async function mountTeam(t, { role = 'admin', answers = {}, boards = BOARDS } = {}) {
  const m = await K.mount(t, { boards, answers: { projectList: projectsAs(role), boardHistory: listOf(), boardTrash: { ok: true, boards: [] }, ...answers } });
  m.window.Date = Object.assign(class FakeDate extends Date {}, { now: () => NOW_MS });
  const queue = [];
  const real = { set: m.window.setTimeout, clear: m.window.clearTimeout };
  m.window.setTimeout = (fn, ms, ...rest) => { if (ms === 600 || ms === 300) { const entry = { fn, ms, live: true }; queue.push(entry); return entry; } return real.set.call(m.window, fn, ms, ...rest); };
  m.window.clearTimeout = (id) => { if (id && typeof id === 'object' && queue.includes(id)) id.live = false; else real.clear.call(m.window, id); };
  m.timers = { pending: (ms) => queue.filter((e) => e.live && e.ms === ms).length, fire: (ms) => queue.filter((e) => e.live && e.ms === ms).forEach((e) => { e.live = false; e.fn(); }) };
  const subs = new Set(); // the listeners on the team source's change events: the page's own and this part's
  const made = m.window.rendererBoardSourceTeam;
  const build = made.createTeamBoardSource;
  made.createTeamBoardSource = (deps) => {
    const source = build(deps);
    const on = source.onChanged;
    source.onChanged = (fn) => { subs.add(fn); const off = on(fn); return () => { subs.delete(fn); off(); }; };
    return source;
  };
  m.subs = subs;
  await K.pickTeam(m);
  assert.equal(m.captured.part.openChat(), true);
  await m.flush();
  return m;
}
const historyButton = (m) => m.q('[data-board-team-conv="history"]');
const conversation = (m) => m.q('aside.board-team-conv:not(.board-team-history)');
const historyAside = (m) => m.q('aside.board-team-history');
const rows = (m) => m.qa('.board-team-history__log > li[data-board-history-rev]');
const sentence = (li) => li.querySelector('span[dir="auto"]').textContent;
const calls = (m) => m.bridge.of('boardHistory');
const openHistory = async (m) => { historyButton(m).click(); await tick(); };
const msg = (m) => m.q('.board-team-history__empty p').textContent;
const take = (m, rev) => m.q(`[data-board-history-rev="${rev}"] [data-board-team-history="take"]`);
const people = (extra = []) => K.members([[DOT, 'Dot'], [MAYA, 'Maya'], ...extra]);

test('the History button is in the column head for a reader, a writer and an admin, disabled with its reason when no board is open', async (t) => {
  for (const role of ['reader', 'writer', 'admin']) {
    const m = await mountTeam(t, { role });
    const button = historyButton(m);
    assert.ok(button, `${role}: the button`);
    assert.deepEqual([button.disabled, button.getAttribute('aria-label'), button.title, button.classList.contains('ide-chat-dock-action')], [false, 'History', 'History: who changed this board', true], role);
    assert.equal(button.nextElementSibling, m.q('[data-board-team-conv="collapse"]'), `${role}: just before Collapse chat`);
    assert.equal(button.parentElement.classList.contains('ide-chat-dock-header-actions'), true);
  }
  const none = await mountTeam(t, { boards: [] });
  assert.deepEqual([historyButton(none).disabled, historyButton(none).title], [true, 'Open a board to see its history.']);
  none.captured.ctx.pickProject(null);
});

test('opening History hides the conversation without remounting it, focus goes to Back, and Back and Escape return to the conversation', async (t) => {
  const m = await mountTeam(t);
  const conv = conversation(m);
  const opens = m.bridge.of('conversationOpen').length;
  await openHistory(m);
  const aside = historyAside(m);
  assert.ok(aside && aside.hasAttribute('data-board-team-history') && aside.getAttribute('aria-label') === 'Board history');
  assert.equal(aside.parentElement, m.captured.ctx.chatHost);
  assert.deepEqual([conv.hidden, conversation(m) === conv, m.bridge.of('conversationOpen').length], [true, true, opens]);
  assert.equal(aside.querySelector('.ide-chat-dock-label').textContent, 'History');
  assert.equal(m.doc.activeElement, aside.querySelector('[data-board-team-history="back"]'));
  assert.equal(aside.querySelector('[data-board-team-history="back"]').textContent.trim(), 'Back to the conversation');
  aside.querySelector('[data-board-team-history="back"]').click();
  assert.deepEqual([historyAside(m), conv.hidden, conversation(m) === conv, m.doc.activeElement, m.bridge.of('conversationOpen').length], [null, false, true, historyButton(m), opens]);
  await openHistory(m);
  key(m, historyAside(m).querySelector('.board-team-history__sub'), 'Escape');
  assert.deepEqual([historyAside(m), conv.hidden, m.doc.activeElement], [null, false, historyButton(m)]);
});

test('the list: newest first, day headings, a time element each, and the sentence of every case', async (t) => {
  const today = (h, mi) => at(15, h, mi);
  const cases = [
    [change(40, DOT, today(11, 30), 'change', { 'card.remove': 23 }), 'You removed 23 cards'],
    [change(39, MAYA, today(11, 20), 'change', { 'card.add': 1 }), `${iso('Maya')} added a card`],
    [change(38, MAYA, today(11, 10), 'change', { 'card.add': 2, 'card.edit': 3 }), `${iso('Maya')} added 2 cards and edited 3 cards`],
    [change(37, MAYA, today(11, 0), 'change', { 'card.remove': 1, 'card.add': 2, 'card.place': 4, 'connector.add': 5 }), `${iso('Maya')} removed a card, added 2 cards and made 9 other changes`],
    [change(36, MAYA, today(10, 50), 'change', { 'card.remove': 1, 'card.add': 1, 'card.place': 1 }), `${iso('Maya')} removed a card, added a card and made another change`],
    [change(35, MAYA, today(10, 40), 'change', null), `${iso('Maya')} changed the board`],
    [change(34, MAYA, today(10, 35), 'change', {}), `${iso('Maya')} changed the board`],
    [change(33, MAYA, today(10, 30), 'change', { 'mystery.op': 2 }), `${iso('Maya')} made 2 other changes`],
    [change(32, MAYA, today(10, 20), 'change', { 'card.edit': 1, 'card.place': 1 }), `${iso('Maya')} edited a card and moved a card`],
    [change(31, MAYA, today(10, 15), 'change', { 'connector.remove': 1, 'connector.edit': 2 }), `${iso('Maya')} removed a connection and changed 2 connections`],
    [change(30, MAYA, today(10, 10), 'change', { 'connector.add': 3, 'group.add': 1 }), `${iso('Maya')} added 3 connections and added a group`],
    [change(29, MAYA, today(10, 5), 'change', { 'group.remove': 2, 'group.edit': 1 }), `${iso('Maya')} removed 2 groups and changed a group`],
    [change(28, MAYA, today(10, 4), 'change', { 'group.place': 1, 'board.rename': 1 }), `${iso('Maya')} moved a group and renamed the board`],
    [change(27, MAYA, today(10, 3), 'change', { 'group.assign': 3 }), `${iso('Maya')} moved 3 cards between groups`],
    [change(26, GONE, today(10, 2), 'change', { 'card.add': 1 }), `${iso('Former member')} added a card`],
    [change(25, MAYA, today(10, 1), 'proposal', { 'card.add': 4, 'connector.add': 1 }), `${iso('Maya')} accepted Jenny’s proposal: added 4 cards and added a connection`],
    [change(24, DOT, today(10, 0), 'proposal', null), 'You accepted a proposal from Jenny'],
    [change(23, DOT, today(9, 50), 'proposal', { 'card.add': 1 }), 'You accepted Jenny’s proposal: added a card'],
    [change(22, DOT, today(9, 40), 'revert', null, { of_rev: 3, takeable: false }), `You took back a change by ${iso('Maya')}`],
    [change(21, MAYA, today(9, 30), 'revert', null, { of_rev: 2, takeable: false }), `${iso('Maya')} took back a change of yours`],
    [change(20, MAYA, today(9, 20), 'revert', null, { of_rev: 1, takeable: false }), `${iso('Maya')} took back a change by ${iso('Former member')}`],
    [change(19, MAYA, today(9, 10), 'revert', null, { of_rev: 999, takeable: false }), `${iso('Maya')} took back a change`],
    [change(18, DOT, today(9, 0), 'revert', null, { of_rev: 4, takeable: false }), 'You took back a change'],
    [change(4, DOT, at(14, 16, 5), 'change', { 'card.add': 1 }), 'You added a card'],
    [change(3, MAYA, at(14, 15, 50), 'change', { 'card.add': 1 }), `${iso('Maya')} added a card`],
    [change(2, DOT, at(10, 8, 30), 'change', { 'card.edit': 1 }), 'You edited a card'],
    [change(1, GONE, at(10, 8, 0), 'change', { 'card.add': 1 }), `${iso('Former member')} added a card`],
  ];
  const m = await mountTeam(t, { answers: { members: people(), boardHistory: listOf(...cases.map(([entry]) => entry)) } });
  await openHistory(m);
  assert.deepEqual(rows(m).map(sentence), cases.map(([, text]) => text));
  assert.deepEqual(rows(m).map((li) => li.dataset.boardHistoryRev), cases.map(([entry]) => String(entry.rev)));
  assert.deepEqual(m.qa('.board-team-history__day').map((li) => li.textContent), ['Today', 'Yesterday', dateText(at(10, 8, 0))]);
  const first = rows(m)[0].querySelector('time');
  assert.deepEqual([first.getAttribute('datetime'), first.textContent], [cases[0][0].at, clockText(cases[0][0].at)]);
  assert.equal(rows(m).every((li, i) => li.querySelector('time').textContent === clockText(cases[i][0].at)), true);
  const order = m.qa('.board-team-history__log > li').map((li) => (li.classList.contains('board-team-history__day') ? 'day' : 'row'));
  assert.deepEqual([order[0], order[order.indexOf('day', 1)], order.filter((x) => x === 'day').length], ['day', 'day', 3]);
});

test('the four states: no board open, reading, no changes, and a failed read with Try again', async (t) => {
  const gate = deferred();
  const m = await mountTeam(t, { answers: { boardHistory: () => gate.promise } });
  await openHistory(m);
  assert.deepEqual([msg(m), m.q('.board-team-history__log').hidden, m.q('.board-team-history__empty').hidden], ['Reading the history…', true, false]);
  gate.resolve(listOf());
  await tick();
  assert.equal(msg(m), 'No changes on this board yet.');
  m.bridge.answers.boardHistory = { ok: false };
  m.timers.fire(600);
  m.bridge.push('onBoard', { kind: 'applied', team_id: TEAM, project_id: PROJECT, board_id: boardId(1), applied: null });
  m.timers.fire(600);
  await tick();
  assert.equal(msg(m), 'The history could not be read.');
  const retry = m.q('[data-board-team-history="retry"]');
  assert.equal(retry.textContent.trim(), 'Try again');
  const before = calls(m).length;
  m.bridge.answers.boardHistory = listOf(change(1, DOT, at(15, 9, 0), 'change', { 'card.add': 1 }));
  retry.click();
  await tick();
  assert.deepEqual([calls(m).length, rows(m).length, m.q('[data-board-team-history="retry"]')], [before + 1, 1, null]);
  m.bridge.answers.boardHistory = { ok: false, error: { reason: 'team_board_unavailable' } };
  m.bridge.push('onBoard', { kind: 'applied', team_id: TEAM, project_id: PROJECT, board_id: boardId(1), applied: null });
  m.timers.fire(600);
  await tick();
  assert.equal(msg(m), 'The team server cannot reach its boards right now. Try again in a moment.');
  m.bridge.answers.boardList = { ok: true, boards: [] };
  m.bridge.push('onBoard', { kind: 'list_changed', team_id: TEAM, project_id: PROJECT });
  await m.flush();
  assert.equal(msg(m), 'Open a board to see its history.');
  assert.equal(conversation(m).hidden, true, 'the conversation stays hidden while History shows its state');
});

test('the sub line and the end of each row by role: only an admin is offered Take back, on rows that can be taken back', async (t) => {
  const list = listOf(
    change(5, MAYA, at(15, 11, 0), 'change', { 'card.add': 1 }),
    change(4, MAYA, at(15, 10, 0), 'change', { 'card.add': 1 }, { reverted: true }),
    change(3, DOT, at(15, 9, 0), 'revert', null, { of_rev: 4, takeable: false }),
    change(2, MAYA, at(15, 8, 0), 'change', { 'card.add': 1 }, { takeable: false }),
    change(1, DOT, at(15, 7, 0), 'change', { 'card.add': 1 }),
  );
  const admin = await mountTeam(t, { role: 'admin', answers: { members: people(), boardHistory: list } });
  await openHistory(admin);
  assert.equal(admin.q('.board-team-history__sub').textContent, 'The last 200 changes to this board. As a project admin you can take one back; that is recorded in the project’s Activity.');
  assert.deepEqual(admin.qa('[data-board-team-history="take"]').map((b) => b.closest('li').dataset.boardHistoryRev), ['5', '1']);
  assert.equal(take(admin, 5).getAttribute('aria-label'), `Take back: ${iso('Maya')} added a card`);
  assert.deepEqual(rows(admin).map((li) => [li.dataset.boardHistoryRev, li.querySelector('.board-team-history__taken') ? li.querySelector('.board-team-history__taken').textContent : '']).filter(([, text]) => text), [['4', 'Taken back']]);
  assert.equal(rows(admin).filter((li) => li.querySelector('button')).length, 2, 'nothing else is a control');
  for (const role of ['writer', 'reader']) {
    const m = await mountTeam(t, { role, answers: { members: people(), boardHistory: list } });
    await openHistory(m);
    assert.equal(m.q('.board-team-history__sub').textContent, 'The last 200 changes to this board. A project admin can take one back.', role);
    assert.deepEqual([m.qa('.board-team-history__log button').length, m.qa('.board-team-history__taken').length, rows(m).length], [0, 1, 5], role);
  }
});

const TAKE = [change(5, DOT, at(15, 11, 0), 'change', { 'card.remove': 3 }), change(4, MAYA, at(15, 10, 0), 'change', { 'card.add': 1 })];
const CONFIRM_END = ' Its cards, connections and groups go back to how they were before it. Anything changed since then is left as it is.';

test('Take back: one confirm at a time, Cancel and Escape return focus, confirming sends boardRevert once and disables the buttons', async (t) => {
  const gate = deferred();
  const m = await mountTeam(t, { answers: { members: people(), boardHistory: listOf(...TAKE), boardRevert: () => gate.promise } });
  await openHistory(m);
  take(m, 4).click();
  const confirms = () => m.qa('.board-team-history__log .team-set-confirm');
  assert.equal(confirms().length, 1);
  assert.equal(take(m, 4).closest('li').nextElementSibling, confirms()[0].parentElement, 'the next row of the list');
  assert.equal(confirms()[0].querySelector('p').textContent, `Take back ${iso('Maya')}’s change?${CONFIRM_END}`);
  assert.deepEqual([...confirms()[0].querySelectorAll('button')].map((b) => b.textContent.trim()), ['Take back', 'Cancel']);
  take(m, 5).click();
  assert.equal(confirms().length, 1, 'one at a time');
  assert.equal(confirms()[0].querySelector('p').textContent, `Take back your change?${CONFIRM_END}`);
  m.q('[data-board-team-history="cancel"]').click();
  assert.deepEqual([confirms().length, m.doc.activeElement], [0, take(m, 5)]);
  take(m, 4).click();
  key(m, m.doc.activeElement, 'Escape');
  assert.deepEqual([confirms().length, m.doc.activeElement, historyAside(m) !== null], [0, take(m, 4), true], 'Escape closes the confirm first');
  take(m, 4).click();
  const go = m.q('[data-board-team-history="confirm"]');
  go.click();
  go.click();
  await tick();
  assert.deepEqual(m.bridge.of('boardRevert'), [{ team_id: TEAM, project_id: PROJECT, board_id: boardId(1), rev: 4 }]);
  assert.deepEqual([...confirms()[0].querySelectorAll('button')].map((b) => b.disabled), [true, true]);
  const reads = calls(m).length;
  gate.resolve({ ok: true, rev: 10, reverted: 2, skipped: 0 });
  await tick();
  assert.deepEqual([confirms().length, calls(m).length, m.toasts.length], [0, reads + 1, 0], 'taken back: the list says it, nothing more');
  assert.equal(m.bridge.of('boardRevert').length, 1);
});

test('Take back outcomes: partly, nothing left, and a refusal each say their sentence, and the list is read again', async (t) => {
  const outcomes = [
    [{ ok: true, rev: 10, reverted: 2, skipped: 1 }, 'Part of that change could not be taken back: the board has changed since.', undefined],
    [{ ok: true, rev: 10, reverted: 0, skipped: 2 }, 'Nothing of that change was left to take back.', undefined],
    [{ ok: false, error: { reason: 'role_forbidden', message: 'HOST WORDS here' } }, 'Your role in this project does not allow that.', 'warning'],
    [{ ok: false, error: { reason: 'weird_reason', message: 'HOST WORDS here' } }, null, 'warning'],
    [{ ok: false }, 'That change could not be taken back.', 'warning'],
  ];
  for (const [answer, text, tone] of outcomes) {
    const m = await mountTeam(t, { answers: { members: people(), boardHistory: listOf(...TAKE), boardRevert: answer } });
    await openHistory(m);
    take(m, 4).click();
    const reads = calls(m).length;
    m.q('[data-board-team-history="confirm"]').click();
    await tick();
    assert.equal(m.toasts.length, 1, JSON.stringify(answer));
    if (text) assert.equal(m.toasts[0].message, text);
    assert.equal(String(m.toasts[0].message).includes('HOST WORDS'), false, 'the host words never reach the page');
    assert.equal(m.toasts[0].tone, tone);
    assert.deepEqual([m.qa('.team-set-confirm').length, calls(m).length], [0, reads + 1]);
  }
});

test('Reading: ten events are one read after the debounce, none while closed or for another board, a new board reads its own history', async (t) => {
  const byBoard = (payload) => (payload.board_id === boardId(1) ? listOf(change(2, MAYA, at(15, 10, 0), 'change', { 'card.add': 1 })) : listOf(change(7, DOT, at(15, 9, 0), 'change', { 'card.edit': 1 })));
  const m = await mountTeam(t, { answers: { members: people(), boardHistory: byBoard } });
  const applied = (board) => m.bridge.push('onBoard', { kind: 'applied', team_id: TEAM, project_id: PROJECT, board_id: board, applied: { batch_id: 'b' }, actor: MAYA });
  applied(boardId(1));
  assert.deepEqual([m.timers.pending(600), calls(m).length], [0, 0], 'closed: nothing');
  await openHistory(m);
  assert.deepEqual(calls(m), [{ team_id: TEAM, project_id: PROJECT, board_id: boardId(1) }]);
  for (let i = 0; i < 10; i += 1) applied(boardId(1));
  assert.deepEqual([m.timers.pending(600), calls(m).length], [1, 1]);
  m.timers.fire(600);
  await tick();
  assert.equal(calls(m).length, 2);
  applied(boardId(2));
  assert.equal(m.timers.pending(600), 0, 'another board: nothing');
  await m.captured.ctx.openBoard(boardId(2));
  await tick();
  assert.deepEqual([calls(m).length, calls(m).at(-1).board_id, rows(m).map((li) => li.dataset.boardHistoryRev)], [3, boardId(2), ['7']]);
  historyAside(m).querySelector('[data-board-team-history="back"]').click();
  applied(boardId(2));
  assert.equal(m.timers.pending(600), 0, 'closed again: nothing');
  assert.equal(calls(m).length, 3);
});

test('Reading: an answer for a board no longer shown is dropped, an unchanged answer rebuilds no row, a re-read keeps the open confirm and its focus', async (t) => {
  const gates = [deferred(), deferred()];
  let n = 0;
  const m = await mountTeam(t, { answers: { members: people(), boardHistory: (payload) => (n < 2 ? gates[n++].promise.then((value) => ({ ...value, board: payload.board_id })) : listOf(...TAKE)) } });
  await openHistory(m);
  await m.captured.ctx.openBoard(boardId(2));
  gates[0].resolve(listOf(change(77, DOT, at(15, 8, 0), 'change', { 'card.add': 1 })));
  await tick();
  assert.deepEqual([rows(m).length, msg(m)], [0, 'Reading the history…'], 'the answer for the first board is not drawn');
  gates[1].resolve(listOf(...TAKE));
  await tick();
  assert.deepEqual(rows(m).map((li) => li.dataset.boardHistoryRev), ['5', '4']);
  const nodes = rows(m);
  m.bridge.push('onBoard', { kind: 'applied', team_id: TEAM, project_id: PROJECT, board_id: boardId(2), applied: null });
  m.timers.fire(600);
  await tick();
  assert.equal(rows(m).every((li, i) => li === nodes[i]), true, 'the same answer: the same nodes');
  take(m, 4).click();
  m.bridge.answers.boardHistory = listOf(change(6, MAYA, at(15, 11, 30), 'change', { 'card.add': 1 }), ...TAKE);
  m.bridge.push('onBoard', { kind: 'applied', team_id: TEAM, project_id: PROJECT, board_id: boardId(2), applied: null });
  m.timers.fire(600);
  await tick();
  assert.deepEqual([rows(m).length, m.qa('.team-set-confirm').length, m.doc.activeElement.getAttribute('data-board-team-history')], [3, 1, 'confirm']);
  assert.equal(take(m, 4).closest('li').nextElementSibling.querySelector('.team-set-confirm') !== null, true);
  m.bridge.answers.boardHistory = listOf(change(6, MAYA, at(15, 11, 30), 'change', { 'card.add': 1 }), change(5, DOT, at(15, 11, 0), 'change', { 'card.remove': 3 }));
  m.bridge.push('onBoard', { kind: 'applied', team_id: TEAM, project_id: PROJECT, board_id: boardId(2), applied: null });
  m.timers.fire(600);
  await tick();
  assert.equal(m.qa('.team-set-confirm').length, 0, 'the row no longer exists: no confirm for it');
});

test('hostile input: every fixture as a member name and as a deleted board name is text, bounded and isolated, and makes no element', async (t) => {
  const values = [...fx.HOSTILE.map((entry) => entry.value), '', '\u0000‮\t\n'];
  const ids = values.map((_v, i) => `member_fx${String(i).padStart(4, '0')}`);
  const trash = values.map((v, i) => ({ id: boardId(500 + i), name: v, rev: 1, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', created_by: ids[i], deleted_at: at(14, 9, 0), deleted_by: ids[i] }));
  const list = listOf(...ids.map((id, i) => change(100 - i, id, at(15, 10, 0), 'change', { 'card.add': 1 })));
  const m = await mountTeam(t, { answers: { members: K.members([[DOT, 'Dot'], ...values.map((v, i) => [ids[i], v])]), boardHistory: list, boardTrash: { ok: true, boards: trash } } });
  const baseline = m.doc.querySelectorAll('script, iframe, object, embed, link, style, meta, base, img, a, svg image').length;
  await openHistory(m);
  m.q('[data-board-team-deleted="toggle"]').click();
  assert.equal(rows(m).length, values.length);
  for (const li of rows(m)) {
    const text = sentence(li);
    const found = [...text.matchAll(ISO)];
    assert.equal(found.length, 1, `one isolated name: ${text.slice(0, 80)}`);
    assert.ok(Array.from(found[0][1]).length <= 64 && text.length < 200, 'bounded');
    assert.ok(!unsafe(found[0][1]), 'no control or override inside the name');
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/.test(text), 'no split pair');
    assert.deepEqual([...li.children].map((el) => el.tagName), ['TIME', 'SPAN', 'BUTTON'], 'an admin: Take back is the only control');
  }
  const names = m.qa('[data-board-deleted-id]');
  assert.ok(names.length > 0 && names.length <= 200);
  for (const li of names) {
    const label = li.querySelector('button').getAttribute('aria-label');
    assert.equal((label.match(/⁨/g) || []).length, (label.match(/⁩/g) || []).length);
    assert.ok(Array.from(li.querySelector('.board-team-deleted__name').textContent).length <= 200);
    assert.deepEqual([...li.children].map((el) => el.tagName), ['SPAN', 'SPAN', 'BUTTON']);
  }
  const after = m.doc.querySelectorAll('script, iframe, object, embed, link, style, meta, base, img, a, svg image').length;
  assert.deepEqual([after, m.doc.querySelector('[onerror], [onload], [onclick], [onmouseover]')], [baseline, null]);
});

test('hostile answers: a changes answer that is no array, non-objects, 10,000 entries, odd kinds, ops that are arrays or carry property names, and huge counts', async (t) => {
  const proto = JSON.parse('{"__proto__": 5, "constructor": 3, "toString": 2, "card.add": 9007199254740991, "card.edit": 1e308, "group.add": -4, "x y": 1}');
  const entries = Array.from({ length: 10000 }, (_x, i) => change(20000 - i, MAYA, at(15, 10, 0), 'change', { 'card.add': 1 }));
  const shapes = [
    [{ ok: true, rev: 1, changes: 'HOSTTEXT' }, 0],
    [{ ok: true, rev: 1, changes: { length: 5 } }, 0],
    [{ ok: true, rev: 1, changes: [1, 'HOSTTEXT', null, [], undefined, change(3, MAYA, at(15, 9, 0), 'change', { 'card.add': 1 })] }, 1],
    [{ ok: true, rev: 1, changes: entries }, 200],
    [{ ok: true, rev: 1, changes: [change(3, MAYA, at(15, 9, 0), 'HOSTKIND', { 'card.add': 1 }), change(2, '<img src=x onerror=1>', 'HOSTTEXT', 'change', [1, 2]), change(1, MAYA, at(15, 8, 0), 'change', proto, { rev: 1, takeable: 'yes' })] }, 3],
  ];
  const m = await mountTeam(t, { answers: { members: people(), boardHistory: listOf() } });
  await openHistory(m);
  for (const [answer, count] of shapes) {
    m.bridge.answers.boardHistory = answer;
    m.bridge.push('onBoard', { kind: 'applied', team_id: TEAM, project_id: PROJECT, board_id: boardId(1), applied: null });
    m.timers.fire(600);
    await tick();
    assert.equal(rows(m).length, count);
    const text = historyAside(m).textContent;
    assert.deepEqual(['HOSTTEXT', 'HOSTKIND', 'constructor', '__proto__'].filter((word) => text.includes(word)), []);
    assert.equal(m.qa('[data-board-team-history="take"]').length <= count, true);
  }
  assert.deepEqual(rows(m).map(sentence), [`${iso('Maya')} added a card`, `${iso('Former member')} changed the board`, `${iso('Maya')} added 9007199254740991 cards`]);
});

const TRASHED = [
  { id: boardId(11), name: 'Sprint 12 retro', deleted_at: new Date(NOW_MS - 2 * 86400000).toISOString(), deleted_by: MAYA },
  { id: boardId(12), name: 'Old pricing', deleted_at: new Date(NOW_MS - 5.5 * 86400000).toISOString(), deleted_by: DOT },
  { id: boardId(13), name: 'Scratch', deleted_at: new Date(NOW_MS - 6.5 * 86400000).toISOString(), deleted_by: GONE },
].map((row) => ({ ...row, rev: 1, created_at: row.deleted_at, updated_at: row.deleted_at, created_by: DOT }));

test('deleted boards: an admin gets the closed toggle with the count; writers and readers get nothing and nothing is sent for them', async (t) => {
  const m = await mountTeam(t, { answers: { members: people(), boardTrash: { ok: true, boards: TRASHED } } });
  const block = m.q('[data-board-team-deleted]');
  const toggle = block.querySelector('[data-board-team-deleted="toggle"]');
  assert.deepEqual([toggle.tagName, toggle.getAttribute('aria-expanded'), toggle.textContent.trim(), block.querySelector('ul')], ['BUTTON', 'false', '3 deleted boards', null]);
  assert.equal(block.nextElementSibling, m.q('[data-board-team-foot]'), 'just before the team foot line');
  assert.equal(m.q('[data-board-list]').lastElementChild, m.q('[data-board-team-foot]'));
  toggle.click();
  assert.equal(toggle.isConnected, false, 'the block is drawn again');
  const open = m.q('[data-board-team-deleted="toggle"]');
  assert.deepEqual([open.getAttribute('aria-expanded'), m.doc.activeElement], ['true', open]);
  m.captured.part.sync();
  assert.deepEqual(m.qa('[data-board-deleted-id]').map((li) => [li.querySelector('.board-team-deleted__name').textContent, li.querySelector('.board-team-deleted__meta').textContent, li.querySelector('button').getAttribute('aria-label')]), [
    ['Sprint 12 retro', `${iso('Maya')} · 5 days left`, `Restore ${iso('Sprint 12 retro')}`],
    ['Old pricing', 'You · 1 day left', `Restore ${iso('Old pricing')}`],
    ['Scratch', `${iso('Former member')} · less than a day left`, `Restore ${iso('Scratch')}`],
  ]);
  assert.equal(m.q('.board-team-deleted__note').textContent, 'Who deleted it, and how long it is kept. After 7 days a deleted board is removed for good.');
  m.bridge.answers.boardTrash = { ok: true, boards: TRASHED.slice(0, 1) };
  m.bridge.push('onBoard', { kind: 'list_changed', team_id: TEAM, project_id: PROJECT });
  m.timers.fire(300);
  await tick();
  assert.equal(m.q('[data-board-team-deleted="toggle"]').textContent.trim(), '1 deleted board');
  for (const role of ['writer', 'reader']) {
    const other = await mountTeam(t, { role, answers: { boardTrash: { ok: true, boards: TRASHED } } });
    other.bridge.push('onBoard', { kind: 'list_changed', team_id: TEAM, project_id: PROJECT });
    other.timers.fire(300);
    await tick();
    assert.deepEqual([other.q('[data-board-team-deleted]'), other.bridge.of('boardTrash').length], [null, 0], role);
  }
});

test('deleted boards: Restore sends boardRestore once, says so, reads again; a refusal says the page sentence; events are one read; zero rows draw nothing', async (t) => {
  const m = await mountTeam(t, { answers: { members: people(), boardTrash: { ok: true, boards: TRASHED }, boardRestore: { ok: true, board: { id: boardId(11), name: 'Sprint 12 retro' } } } });
  m.q('[data-board-team-deleted="toggle"]').click();
  const reads = m.bridge.of('boardTrash').length;
  m.bridge.answers.boardTrash = { ok: true, boards: TRASHED.slice(1) };
  const button = m.q(`[data-board-deleted-id="${boardId(11)}"] button`);
  button.focus();
  button.click();
  button.click();
  await tick();
  assert.deepEqual(m.bridge.of('boardRestore'), [{ team_id: TEAM, project_id: PROJECT, board_id: boardId(11) }]);
  assert.deepEqual([m.toasts.at(-1).message, m.toasts.at(-1).tone, m.bridge.of('boardTrash').length], [`Restored ${iso('Sprint 12 retro')}.`, undefined, reads + 1]);
  assert.equal(m.doc.activeElement, m.q(`[data-board-deleted-id="${boardId(12)}"] button`), 'focus goes to the next row');
  m.bridge.answers.boardRestore = { ok: false, error: { reason: 'team_board_limit' } };
  m.q(`[data-board-deleted-id="${boardId(13)}"] button`).click();
  await tick();
  assert.deepEqual([m.toasts.at(-1).message, m.toasts.at(-1).tone], ['That board could not be restored.', 'warning']);
  m.bridge.answers.boardRestore = { ok: false, error: { reason: 'team_board_unavailable', message: 'HOST WORDS' } };
  m.q(`[data-board-deleted-id="${boardId(13)}"] button`).click();
  await tick();
  assert.equal(m.toasts.at(-1).message, 'The team server cannot reach its boards right now. Try again in a moment.');
  m.bridge.answers.boardRestore = { ok: true };
  m.bridge.answers.boardTrash = { ok: true, boards: TRASHED.slice(1, 2) };
  m.q(`[data-board-deleted-id="${boardId(13)}"] button`).focus();
  m.q(`[data-board-deleted-id="${boardId(13)}"] button`).click();
  await tick();
  assert.equal(m.doc.activeElement, m.q('[data-board-team-deleted="toggle"]'), 'the last row restored: the toggle');
  m.bridge.answers.boardTrash = { ok: true, boards: [] };
  m.q(`[data-board-deleted-id="${boardId(12)}"] button`).focus();
  m.q(`[data-board-deleted-id="${boardId(12)}"] button`).click();
  await tick();
  assert.deepEqual([m.q('[data-board-team-deleted]'), m.doc.activeElement.getAttribute('data-board-action')], [null, 'new'], 'the block is gone: the New board button');
  const before = m.bridge.of('boardTrash').length;
  for (let i = 0; i < 10; i += 1) m.bridge.push('onBoard', { kind: 'list_changed', team_id: TEAM, project_id: PROJECT });
  assert.equal(m.timers.pending(300), 1);
  m.bridge.answers.boardTrash = { ok: true, boards: TRASHED };
  m.timers.fire(300);
  await tick();
  assert.deepEqual([m.bridge.of('boardTrash').length, m.q('[data-board-team-deleted]') !== null], [before + 1, true]);
  m.bridge.answers.boardTrash = { ok: false, error: { reason: 'team_board_unavailable' } };
  m.bridge.push('onBoard', { kind: 'list_changed', team_id: TEAM, project_id: PROJECT });
  m.timers.fire(300);
  await tick();
  assert.equal(m.q('[data-board-team-deleted]') !== null, true, 'a failed read keeps the section (it says so, see the retry test)');
});

test('deleted boards: a failed read keeps the section with an error and Retry; Retry reads again and the error goes (H24)', async (t) => {
  const m = await mountTeam(t, { answers: { members: people(), boardTrash: { ok: true, boards: TRASHED } } });
  const toggle = () => m.q('[data-board-team-deleted="toggle"]');
  const retry = () => m.q('[data-board-team-deleted="retry"]');
  assert.deepEqual([retry(), m.q('.board-team-deleted__error')], [null, null]);
  m.bridge.answers.boardTrash = { ok: false, error: { reason: 'team_board_trash_limit' } };
  m.bridge.push('onBoard', { kind: 'list_changed', team_id: TEAM, project_id: PROJECT });
  m.timers.fire(300);
  await tick();
  assert.deepEqual([toggle().textContent.trim(), m.q('.board-team-deleted__error').textContent, retry().tagName, retry().title, m.q('.board-team-deleted__error').getAttribute('role')],
    ['3 deleted boards', 'This project has too many deleted boards. Each is removed for good 7 days after it was deleted.', 'BUTTON', 'Try again', 'alert'], 'the rows stay and the host\'s sentence is said beside them');
  retry().focus();
  m.bridge.answers.boardTrash = { ok: true, boards: TRASHED.slice(0, 2) };
  const reads = m.bridge.of('boardTrash').length;
  retry().click();
  await tick();
  assert.deepEqual([m.bridge.of('boardTrash').length - reads, m.q('.board-team-deleted__error'), retry(), toggle().textContent.trim()], [1, null, null, '2 deleted boards']);
  assert.equal(m.doc.activeElement, toggle(), 'the focus moves on with the control that went');
  // A first read that fails: no rows to show, but the section is there with the error and Retry.
  const first = await mountTeam(t, { answers: { members: people(), boardTrash: { ok: false, reason: 'team_board_unavailable' } } });
  assert.deepEqual([first.q('[data-board-team-deleted="toggle"]'), first.q('.board-team-deleted__error').textContent, first.q('[data-board-team-deleted="retry"]') !== null], [null, 'Deleted boards could not be read.', true]);
  first.bridge.answers.boardTrash = { ok: true, boards: TRASHED };
  first.q('[data-board-team-deleted="retry"]').click();
  await tick();
  assert.deepEqual([first.q('.board-team-deleted__error'), first.q('[data-board-team-deleted="toggle"]').textContent.trim()], [null, '3 deleted boards']);
});

test('keyboard: Take back stays reachable by Tab, the toggle is a button with aria-expanded, and the stylesheet hides with opacity and moves nothing', async (t) => {
  const m = await mountTeam(t, { answers: { members: people(), boardHistory: listOf(...TAKE) } });
  await openHistory(m);
  const button = take(m, 4);
  assert.deepEqual([button.tagName, button.disabled, button.tabIndex, button.hidden, button.closest('[hidden]')], ['BUTTON', false, 0, false, null]);
  button.focus();
  assert.equal(m.doc.activeElement, button);
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'board-team.css'), 'utf8');
  const { window } = new JSDOM(`<!doctype html><style>${css}</style>`);
  const hidden = [];
  const opacity = [];
  const moving = [];
  const MOVING = ['transition', 'transition-property', 'transition-duration', 'animation', 'animation-name', 'animation-duration', 'scroll-behavior'];
  const scan = (list, media) => [...list].forEach((rule) => {
    if (rule.media) { scan(rule.cssRules, rule.media.mediaText || media); return; } // a style rule has cssRules too in this CSSOM: only a media rule is entered
    if (!rule.style) return;
    if (/board-team-history__take/.test(rule.selectorText)) {
      if (rule.style.getPropertyValue('visibility') === 'hidden' || rule.style.getPropertyValue('display') === 'none') hidden.push(rule.selectorText);
      if (rule.style.getPropertyValue('opacity')) opacity.push([rule.selectorText, media || '', rule.style.getPropertyValue('opacity')]);
    }
    if (!/prefers-reduced-motion:\s*reduce/.test(media || '')) MOVING.forEach((prop) => { const value = rule.style.getPropertyValue(prop); if (value && value !== 'none' && !/^0s?$/.test(value) && value !== 'auto') moving.push(`${rule.selectorText} ${prop}`); });
  });
  scan(window.document.styleSheets[0].cssRules, '');
  window.close();
  assert.deepEqual(hidden, []);
  assert.ok(opacity.some(([sel, media, value]) => !media && value === '0' && !/hover|focus/.test(sel)), 'resting: opacity 0');
  assert.ok(opacity.some(([sel, media, value]) => !media && value === '1' && /hover/.test(sel) && /focus-within/.test(sel + opacity.map((o) => o[0]).join(' '))), 'on the hovered or focused row');
  assert.ok(opacity.some(([, media, value]) => /hover:\s*none/.test(media) && value === '1'), 'always shown where there is no hover');
  assert.deepEqual(moving, []);
  const bare = await mountTeam(t, { answers: { boardTrash: { ok: true, boards: TRASHED } } });
  assert.equal(bare.q('[data-board-team-deleted="toggle"]').getAttribute('aria-expanded'), 'false');
});

test('leaving: a collapsed column, an own project, a left team and dispose each leave no aside, listener, source subscription or timer', async (t) => {
  const open = async (role) => {
    const m = await mountTeam(t, { role, answers: { members: people(), boardHistory: listOf(...TAKE), boardTrash: { ok: true, boards: TRASHED } } });
    return { m, base: m.bridge.listeners(), subs: m.subs.size };
  };
  const clean = (m, base, subs, expected) => {
    assert.deepEqual([historyAside(m), m.timers.pending(600), m.timers.pending(300), m.bridge.listeners()], [null, 0, 0, base]);
    assert.equal(m.subs.size, subs - expected);
  };
  const writer = await open('writer');
  await openHistory(writer.m);
  writer.m.bridge.push('onBoard', { kind: 'applied', team_id: TEAM, project_id: PROJECT, board_id: boardId(1), applied: null });
  assert.equal(writer.m.timers.pending(600), 1);
  assert.equal(writer.m.subs.size, writer.subs + 1, 'open: one more subscription');
  writer.m.captured.ctx.chat.setOpen(false);
  writer.m.captured.part.sync();
  clean(writer.m, writer.base, writer.subs + 1, 1);
  assert.equal(conversation(writer.m), null);
  const own = await open('admin');
  await openHistory(own.m);
  own.m.captured.ctx.pickProject(null);
  await own.m.flush();
  assert.deepEqual([own.m.q('[data-board-team-deleted]'), historyAside(own.m), own.m.timers.pending(600)], [null, null, 0]);
  const left = await open('admin');
  await openHistory(left.m);
  left.m.window.rendererTeamStore.getTeamStore().seed({ teams: [] });
  await K.settle(left.m);
  assert.deepEqual([left.m.q('[data-board-team-deleted]'), historyAside(left.m), left.m.timers.pending(600), left.m.timers.pending(300)], [null, null, 0, 0]);
  const gone = await open('admin');
  await openHistory(gone.m);
  gone.m.bridge.push('onBoard', { kind: 'list_changed', team_id: TEAM, project_id: PROJECT });
  gone.m.bridge.push('onBoard', { kind: 'applied', team_id: TEAM, project_id: PROJECT, board_id: boardId(1), applied: null });
  assert.deepEqual([gone.m.timers.pending(300), gone.m.timers.pending(600)], [1, 1]);
  gone.m.page.dispose();
  assert.deepEqual([historyAside(gone.m), gone.m.q('[data-board-team-deleted]'), gone.m.timers.pending(300), gone.m.timers.pending(600), gone.m.subs.size], [null, null, 0, 0, 0]);
});
