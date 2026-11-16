'use strict';

// new-test-file: a new surface (row 151 slice T7: a team project's boards in the Board tab). The team BoardSource
// (board-source-team.js) over a scripted `team` bridge, the scope switch that hands the page one source
// (board-source-bridge.js createScopedBoardSource), the project tracker's pick, and the real page in team scope.
// The member side under the bridge is tests/team-board-ipc.test.js; the page on its own boards is renderer-board-page.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const model = require('../services/boards/board-model');
const { createMemoryBoardSource } = require('../renderer/features/board/board-source-memory');
const { createBridgeBoardSource, createScopedBoardSource } = require('../renderer/features/board/board-source-bridge');
const { createTeamBoardSource, copyBoardToTeam } = require('../renderer/features/board/board-source-team');
const { createProjectTracker } = require('../renderer/features/board/board-project');
const { createBoardPage } = require('../renderer/features/board/board-page');

const TEAM = 'team_one';
const PROJECT = 'project_shared';
const NOW = '2026-11-15T10:00:00.000Z';
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const boardId = (n) => `board_${uid(n)}`;
const at = (n) => ({ team_id: TEAM, project_id: PROJECT, board_id: boardId(n) });
const flush = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const refused = (reason, extra = {}) => ({ ok: false, error: { code: 'CMP-TEAM-0001', reason }, ...extra });
const note = (n, text) => ({ op: 'card.add', card: { id: uid(100 + n), kind: 'note', data: { text }, x: n * 300, y: 0 } });

function teamBoard(n, name, ...ops) {
  const empty = model.createBoard({ id: boardId(n), project_id: PROJECT, name, now: NOW }).board;
  if (!ops.length) return empty;
  const made = model.applyBatch(empty, { batch_id: `seed${n}`, board_id: empty.id, actor: 'member_ann', ops }, { now: NOW });
  assert.equal(made.ok, true, JSON.stringify(made));
  return made.board;
}
const row = (board) => ({ id: board.id, name: board.name, rev: board.rev, created_at: NOW, updated_at: NOW, created_by: 'member_ann' });
const opened = (board, extra = {}) => ({ ok: true, board, rev: board.rev, read_only: false, pending: 0, presence: { viewers: ['member_ann'], cursors: [], locks: [] }, ...extra });

// The `team` bridge, scripted: every call is recorded; `answers[method]` is the answer or a function of the payload.
function teamBridge(answers = {}) {
  const calls = [];
  const listeners = new Set();
  const bridge = new Proxy({}, {
    get: (_target, name) => {
      if (name === 'onBoard') return (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
      return async (payload) => {
        calls.push([name, payload]);
        const answer = answers[name];
        return typeof answer === 'function' ? answer(payload) : (answer === undefined ? { ok: true } : answer);
      };
    },
  });
  return { bridge, calls, answers, listeners, push: (payload) => [...listeners].forEach((listener) => listener(payload)), names: () => calls.map(([name]) => name) };
}

function teamSource(answers, { role = 'writer', words = null } = {}) {
  const t = teamBridge(answers);
  const holder = { role };
  const source = createTeamBoardSource({ bridge: t.bridge, teamId: TEAM, projectId: PROJECT, role: () => holder.role, words });
  const events = [];
  source.onChanged((event) => events.push(event));
  return { ...t, source, events, holder };
}

test('the scope switch: calls go to the team source while one is set, events come only from the scope shown, and the one replaced is disposed', async () => {
  const own = createMemoryBoardSource({ model });
  const ownListeners = [];
  const realOnChanged = own.onChanged;
  own.onChanged = (listener) => { ownListeners.push(listener); const off = realOnChanged(listener); return () => { ownListeners.splice(ownListeners.indexOf(listener), 1); off(); }; };
  own.fetchLinkTitle = async () => ({ ok: true, title: 'from this Jenny' });
  own.revealFile = undefined;
  const scoped = createScopedBoardSource(own);
  const { source } = scoped;
  // A call this Jenny's source does not have is not offered: the page's parts ask `typeof source.x`.
  assert.equal(typeof source.revealFile, 'undefined');
  assert.equal(typeof source.fetchLinkTitle, 'function');
  const seen = [];
  const off = source.onChanged((event) => seen.push(event.kind));
  const mine = (await source.create({ projectId: 'project_alpha', name: 'Mine' })).board;
  assert.deepEqual(seen, ['created']);

  const teamListeners = new Set();
  let disposed = 0;
  const team = {
    list: async () => ({ ok: true, boards: [{ id: boardId(1), name: 'Shared' }] }),
    get: () => { throw new Error('boom'); },
    apply: async () => null,
    onChanged: (listener) => { teamListeners.add(listener); return () => teamListeners.delete(listener); },
    dispose: () => { disposed += 1; },
  };
  scoped.setTeam(team);
  assert.equal(scoped.team(), team);
  assert.deepEqual((await source.list({ projectId: PROJECT })).boards.map((b) => b.name), ['Shared']);
  // A throw and an answer that is no object are `io`; a call the team source lacks is `disabled`, never this Jenny's.
  assert.deepEqual(await source.get({ boardId: boardId(1) }), { ok: false, reason: 'io' });
  assert.deepEqual(await source.apply({ boardId: boardId(1), batch: {} }), { ok: false, reason: 'io' });
  assert.deepEqual(await source.duplicate({ boardId: mine.id, name: 'x' }), { ok: false, reason: 'disabled' });
  assert.deepEqual(await source.fetchLinkTitle({ url: 'https://example.invalid/' }), { ok: true, title: 'from this Jenny' });
  assert.deepEqual((await own.list({ projectId: 'project_alpha' })).boards.map((b) => b.name), ['Mine'], 'nothing was written here');

  // In team scope a change of this Jenny's boards is not told; the team's are.
  seen.length = 0;
  await own.create({ projectId: 'project_alpha', name: 'Unseen' });
  [...teamListeners][0]({ kind: 'list' });
  assert.deepEqual(seen, ['list']);

  // Back to this Jenny: the team source is disposed and no longer heard.
  const stale = [...teamListeners][0];
  scoped.setTeam(null);
  assert.deepEqual([disposed, teamListeners.size, scoped.team()], [1, 0, null]);
  stale({ kind: 'list' });
  await own.create({ projectId: 'project_alpha', name: 'Seen' });
  assert.deepEqual(seen, ['list', 'created']);
  scoped.setTeam(null);
  assert.equal(disposed, 1);
  off();
  assert.equal(ownListeners.length, 0, 'the last listener leaving releases this Jenny\'s subscription');
  assert.equal(typeof createBridgeBoardSource, 'function');
});

test('the project tracker: a picked team project is shown until pick(null); the app\'s own project is still followed underneath', async () => {
  let current = { id: 'project_alpha', name: 'Alpha' };
  const listeners = new Set();
  const switcher = { currentProject: () => current, refresh: async () => [], onProjectsChanged: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
  const changes = [];
  const tracker = createProjectTracker({ getProjectSwitcher: async () => switcher, onChange: (project) => changes.push(project.id) });
  assert.equal((await tracker.start()).id, 'project_alpha');
  changes.length = 0;
  for (const bad of [{ id: PROJECT }, { id: '', team: { id: TEAM } }, { id: PROJECT, team: {} }]) tracker.pick(bad);
  assert.deepEqual([changes, tracker.get().id], [[], 'project_alpha'], 'a pick that names no team project is no pick');
  tracker.pick({ id: PROJECT, name: 'Shared', team: { id: TEAM, name: 'One' }, role: () => 'reader', extra: 'dropped' });
  const shown = tracker.get();
  assert.deepEqual([shown.id, shown.name, shown.team, shown.role(), Object.keys(shown).sort()], [PROJECT, 'Shared', { id: TEAM, name: 'One' }, 'reader', ['id', 'name', 'role', 'team']]);
  assert.equal(tracker.nameOf(PROJECT), 'Shared');
  tracker.pick({ id: PROJECT, name: 'Shared', team: { id: TEAM, name: 'One' } });
  assert.deepEqual(changes, [PROJECT], 'the same project picked again is no change');
  current = { id: 'project_beta', name: 'Beta' };
  listeners.forEach((fn) => fn([]));
  assert.deepEqual([changes, tracker.get().id], [[PROJECT], PROJECT], 'the app moving does not move the Board off a team project');
  tracker.pick(null);
  assert.deepEqual([changes, tracker.get().id], [[PROJECT, 'project_beta'], 'project_beta']);
  tracker.pick(null);
  assert.equal(changes.length, 2);
  tracker.stop();
  tracker.pick({ id: PROJECT, name: 'Shared', team: { id: TEAM, name: 'One' } });
  assert.equal(tracker.get().id, 'project_beta');
});

test('the list and the four board changes are one team call each, named by team and project; a role that may not is told why and nothing is sent', async () => {
  const board = teamBoard(1, 'Plan');
  const t = teamSource({ boardList: { ok: true, boards: [row(board)] }, boardCreate: { ok: true, board: { id: board.id, name: 'Plan', rev: 0 } },
    boardRename: { ok: true, rev: 3 }, boardRestore: { ok: true, board: { id: board.id, name: 'Plan', rev: 3 } } }, { role: 'admin' });
  assert.deepEqual((await t.source.list({ projectId: PROJECT })).boards, [row(board)]);
  assert.deepEqual(await t.source.list({ projectId: 'project_other' }), { ok: false, reason: 'not_found', teamReason: '' });
  assert.deepEqual(await t.source.create({ projectId: PROJECT, name: 'Plan' }), { ok: true, board: { id: board.id, name: 'Plan', rev: 0 } });
  assert.deepEqual(await t.source.rename({ boardId: board.id, name: 'Plan B' }), { ok: true });
  assert.deepEqual(await t.source.delete({ boardId: board.id }), { ok: true });
  assert.deepEqual(await t.source.restore({ boardId: board.id }), { ok: true, board: { id: board.id, name: 'Plan', rev: 3 } });
  assert.deepEqual(t.calls, [
    ['boardList', { team_id: TEAM, project_id: PROJECT }],
    ['boardCreate', { team_id: TEAM, project_id: PROJECT, name: 'Plan' }],
    ['boardRename', { ...at(1), name: 'Plan B' }],
    ['boardDelete', at(1)],
    ['boardRestore', at(1)],
  ]);

  // A writer may not delete or restore; a reader changes nothing. The refusal is the board's `read_only` with its own sentence.
  t.calls.length = 0;
  t.holder.role = 'writer';
  for (const name of ['delete', 'restore']) {
    const answer = await t.source[name]({ boardId: board.id });
    assert.deepEqual([answer.ok, answer.reason, answer.message], [false, 'read_only', 'Only an admin of this project can do that.']);
    assert.equal(t.source.can(name), false);
  }
  assert.deepEqual([t.source.can('create'), t.source.whyNot('create'), t.source.can('apply')], [true, '', true]);
  t.holder.role = 'reader';
  const reader = 'You can look at this board. Writers and admins of this project can change it.';
  for (const [name, request] of [['create', { name: 'x' }], ['rename', { boardId: board.id, name: 'x' }], ['apply', { boardId: board.id, batch: { batch_id: 'b', ops: [] } }],
    ['addAsset', { boardId: board.id, bytes: new Uint8Array(4) }], ['decideProposal', { boardId: board.id, proposalId: 'p', action: 'reject' }]]) {
    assert.deepEqual([(await t.source[name](request)).message, t.source.whyNot(name)], [reader, reader], name);
  }
  assert.equal((await t.source.importBoard(board)).message, reader);
  assert.equal((await t.source.presence.lock(uid(101))).message, reader);
  t.holder.role = '';
  assert.equal(t.source.can('apply'), false, 'an unknown role writes nothing');
  assert.deepEqual(t.calls, [], 'nothing was sent');
  // What a team board does not have says so, whatever the role.
  t.holder.role = 'admin';
  assert.equal(t.source.whyNot('undo'), 'Undo and redo are not available on a team board.');
  for (const name of ['duplicate', 'exportFile', 'importFile', 'setSelection', 'resolveFile', 'revealFile', 'setAside']) {
    assert.deepEqual([t.source.whyNot(name), t.source.can(name), typeof t.source[name]], ['Not available on a team board.', false, 'undefined'], name);
  }
  assert.deepEqual([await t.source.undo({ boardId: board.id }), await t.source.redo({ boardId: board.id })],
    [{ ok: false, reason: 'nothing_to_undo', teamReason: '' }, { ok: false, reason: 'nothing_to_redo', teamReason: '' }]);
});

test('get opens the board on this Jenny and holds one board open: the one before is closed, and an answer for a board the page left is not kept', async () => {
  const [one, two] = [teamBoard(1, 'One', note(1, 'first')), teamBoard(2, 'Two')];
  let release;
  const t = teamSource({ boardOpen: (payload) => (payload.board_id === one.id ? opened(one) : new Promise((resolve) => { release = () => resolve(opened(two)); })) });
  const first = await t.source.get({ boardId: one.id });
  assert.deepEqual([first.ok, first.board, first.canUndo, first.canRedo, first.viewOnly], [true, one, false, false, false]);
  assert.deepEqual(t.source.presence.get(), { viewers: ['member_ann'], cursors: [], locks: [] });
  assert.deepEqual(t.calls, [['boardOpen', at(1)]]);

  // The page asks for Two and, before it answers, for One again: Two is closed when its answer comes, and refused.
  const slow = t.source.get({ boardId: two.id });
  await flush();
  assert.deepEqual(t.names(), ['boardOpen', 'boardClose', 'boardOpen']);
  assert.deepEqual(t.calls[1][1], at(1));
  assert.deepEqual(t.source.presence.get(), { viewers: [], cursors: [], locks: [] }, 'who was viewing the board before is not shown on the next');
  const again = t.source.get({ boardId: one.id });
  release();
  assert.deepEqual(await slow, { ok: false, reason: 'io', teamReason: '' });
  assert.equal((await again).ok, true);
  assert.deepEqual(t.calls.slice(3), [['boardClose', at(2)], ['boardOpen', at(1)], ['boardClose', at(2)]]);

  // A reader's board is view-only; a board the host cannot read says so; a board that is gone is the board's `not_found`.
  t.holder.role = 'reader';
  assert.equal((await t.source.get({ boardId: one.id })).viewOnly, true);
  t.answers.boardOpen = { ok: true, board: null, rev: 4, read_only: true, reason: 'unreadable', pending: 0, presence: null };
  assert.deepEqual(await t.source.get({ boardId: one.id }),
    { ok: true, readOnly: true, reason: 'team_unreadable', message: 'The team server cannot read this board, so it cannot be changed.' });
  t.answers.boardOpen = refused('team_board_not_found');
  assert.deepEqual(await t.source.get({ boardId: one.id }), { ok: false, reason: 'not_found', teamReason: 'team_board_not_found' });
  t.answers.boardOpen = () => { throw new Error('ipc'); };
  assert.equal((await t.source.get({ boardId: one.id })).reason, 'io');

  // dispose closes the held board, stops listening and answers nothing after.
  t.calls.length = 0;
  t.source.dispose();
  t.source.dispose();
  assert.deepEqual([t.calls, t.listeners.size], [[['boardClose', at(1)]], 0]);
  assert.equal((await t.source.list({ projectId: PROJECT })).ok, false);
  assert.equal(t.calls.length, 1);
});

test('apply sends only the batch id and the ops; a refusal is one of the board\'s own words, with the team\'s sentence where the board\'s would be wrong', async () => {
  const board = teamBoard(1, 'One');
  const after = teamBoard(1, 'One', note(1, 'mine'));
  const t = teamSource({ boardOpen: opened(board), boardApply: { ok: true, board: after, rev: 0, read_only: false, pending: 1, applied: {}, duplicate: false } },
    { words: { errorText: (error) => `team says ${error.reason}` } });
  await t.source.get({ boardId: board.id });
  const batch = { batch_id: 'b-1', board_id: 'board_forged', actor: 'owner', now: 'x', ops: [note(1, 'mine')] };
  assert.deepEqual(await t.source.apply({ boardId: board.id, batch }), { ok: true, board: after, duplicate: false });
  assert.deepEqual(t.calls[1], ['boardApply', { ...at(1), batch: { batch_id: 'b-1', ops: batch.ops } }]);
  assert.deepEqual(await t.source.apply({ boardId: board.id, batch: null }), { ok: false, reason: 'invalid', teamReason: '' });

  const cases = [
    // [the member side's answer, the reason the page sees, the sentence (undefined: the board's own sentence is said)]
    [refused('team_board_refused', { board: { reason: 'stale', detail: 'content_rev', limit: null, index: 2 } }), 'stale', undefined],
    [refused('team_board_refused', { board: { reason: 'limit', detail: null, limit: 'cards', index: 0 } }), 'limit', undefined],
    [refused('team_board_not_found'), 'not_found', undefined],
    [refused('team_board_limit'), 'limit', undefined],
    [refused('team_project_read_only'), 'read_only', "You can look at this project's boards. Its writers and admins can change them."],
    [refused('role_forbidden'), 'read_only', 'Your role in this project does not allow that.'],
    [refused('team_board_note_locked'), 'io', 'Someone else is editing that note.'],
    [refused('team_board_chat_outside_project'), 'io', 'A chat card on a team board can only point at a conversation of this project.'],
    [refused('team_board_rate_limit'), 'io', 'The team server is busy. Try again in a moment.'],
    [refused('team_board_queue_full'), 'io', 'Too many changes are waiting to be sent. They go out when the team can be reached again.'],
    [refused('disk_pressure'), 'io', 'The team server is low on disk space, so nothing can be added right now.'],
    [refused('team_not_connected'), 'io', 'team says team_not_connected'],
    [null, 'io', 'team says team_unavailable'],
  ];
  for (const [answer, reason, message] of cases) {
    t.answers.boardApply = answer;
    const got = await t.source.apply({ boardId: board.id, batch });
    assert.deepEqual([got.ok, got.reason, got.message], [false, reason, message], JSON.stringify(answer));
  }
  t.answers.boardApply = refused('team_board_refused', { board: { reason: 'stale', detail: 'content_rev', limit: null, index: 2 } });
  assert.deepEqual(await t.source.apply({ boardId: board.id, batch }), { ok: false, reason: 'stale', teamReason: 'team_board_refused', detail: 'content_rev', op_index: 2 });
  // Without the Team tab's words a team reason with no sentence here says the board's own default.
  const bare = teamSource({ boardApply: refused('team_not_connected') });
  assert.deepEqual(await bare.source.apply({ boardId: board.id, batch }), { ok: false, reason: 'io', teamReason: 'team_not_connected' });
});

test('the member side\'s pushes become the page\'s events: another team, project or board is not heard', async () => {
  const board = teamBoard(1, 'One');
  const t = teamSource({ boardOpen: opened(board) });
  const here = { team_id: TEAM, project_id: PROJECT, board_id: board.id };
  t.push({ kind: 'applied', ...here, rev: 1, applied: { batch_id: 'x' }, own: false });
  assert.deepEqual(t.events, [], 'a board that is not open here is not heard');
  await t.source.get({ boardId: board.id });
  const applied = { batch_id: 'b-9', actor: 'member_bob', ops: [] };
  t.push({ kind: 'applied', ...here, rev: 1, applied, actor: 'member_bob', own: false, pending: 0 });
  t.push({ kind: 'reloaded', ...here, rev: 5, pending: 0 });
  t.push({ kind: 'gone', ...here, reason: 'team_board_not_found' });
  t.push({ kind: 'proposals_changed', ...here });
  t.push({ kind: 'list_changed', team_id: TEAM, project_id: PROJECT });
  t.push({ kind: 'refused', ...here, batch_id: 'b-2', reason: 'team_board_note_locked', detail: null, card_id: uid(101), rev: 5, pending: 0 });
  t.push({ kind: 'refused', ...here, batch_id: 'b-3', reason: 'team_board_refused', detail: { reason: 'stale', detail: null, limit: null }, card_id: null, rev: 5, pending: 0 });
  t.push({ kind: 'refused', ...here, batch_id: 'b-4', reason: 'team_board_refused', detail: { reason: 'limit', detail: null, limit: 'journal_bytes' }, card_id: null, rev: 5, pending: 0 });
  assert.deepEqual(t.events, [
    { kind: 'applied', projectId: PROJECT, boardId: board.id, applied, actor: 'member_bob', own: false },
    { kind: 'applied', projectId: PROJECT, boardId: board.id, applied: null },
    { kind: 'applied', projectId: PROJECT, boardId: board.id, applied: null },
    { kind: 'proposals', projectId: PROJECT, boardId: board.id },
    { kind: 'list', projectId: PROJECT },
    { kind: 'refused', projectId: PROJECT, boardId: board.id, batchId: 'b-2', cardId: uid(101), reason: 'io', teamReason: 'team_board_note_locked', message: 'Someone else is editing that note.' },
    { kind: 'refused', projectId: PROJECT, boardId: board.id, batchId: 'b-3', cardId: '', reason: 'stale', teamReason: 'team_board_refused',
      message: 'The team did not take your last change, so it was taken back here.' },
    { kind: 'refused', projectId: PROJECT, boardId: board.id, batchId: 'b-4', cardId: '', reason: 'limit', teamReason: 'team_board_refused',
      message: 'That is too much to change at once on a team board. Change fewer items at a time.' },
  ]);
  t.events.length = 0;
  for (const payload of [null, 'x', { kind: 'applied', ...here, team_id: 'team_two' }, { kind: 'list_changed', team_id: TEAM, project_id: 'project_other' },
    { kind: 'applied', ...here, board_id: boardId(9) }, { kind: 'unknown', ...here }]) t.push(payload);
  assert.deepEqual(t.events, []);

  // Presence: the state the open answered, then each push; watchers are told; pointer and lock are the open board's.
  const seen = [];
  const off = t.source.presence.subscribe((state) => seen.push(state.viewers.length));
  t.push({ kind: 'presence', ...here, viewers: ['member_ann', 'member_bob'], cursors: [{ member_id: 'member_bob', x: 1, y: 2, selected: [] }], locks: [{ card_id: uid(101), member_id: 'member_bob' }] });
  assert.deepEqual([seen, t.source.presence.get().locks], [[2], [{ card_id: uid(101), member_id: 'member_bob' }]]);
  off();
  t.calls.length = 0;
  t.source.presence.cursor({ x: 10, y: 20 });
  assert.deepEqual(await t.source.presence.lock(uid(101)), { ok: true });
  t.answers.boardLock = refused('team_board_note_locked', { held_by: 'member_bob' });
  const lockRefused = await t.source.presence.lock(uid(101));
  assert.deepEqual([lockRefused.ok, lockRefused.message, lockRefused.heldBy], [false, 'Someone else is editing that note.', 'member_bob']);
  assert.deepEqual(await t.source.presence.unlock(), { ok: true });
  assert.deepEqual(t.calls, [['boardCursor', { ...here, x: 10, y: 20, selected: [] }], ['boardLock', { ...here, card_id: uid(101) }],
    ['boardLock', { ...here, card_id: uid(101) }], ['boardUnlock', here]]);
});

test('proposals and pictures: accept additions is the accept with no number, an edit or a removal is its own numbered accept (D16)', async () => {
  const board = teamBoard(1, 'One');
  const proposal = { id: 'p-1', changes: [], auto: null, prompterMemberId: 'member_bob' };
  const decided = { ok: true, proposal, applied: 2, skipped: 1, extra: 'dropped' };
  const t = teamSource({ boardProposals: { ok: true, proposals: [proposal] }, boardProposalAccept: decided, boardProposalReject: decided,
    boardAssetAdd: { ok: true, asset: 'a'.repeat(64), ext: 'png', mime: 'image/png', width: 4, height: 3, bytes: 99 },
    boardAssetRead: { ok: true, bytes: new Uint8Array([1, 2]), mime: 'image/png' } });
  assert.deepEqual(await t.source.listProposals({ boardId: board.id }), { ok: true, proposals: [proposal] });
  const ask = { boardId: board.id, proposalId: 'p-1' };
  assert.deepEqual(await t.source.decideProposal({ ...ask, action: 'accept_additions', n: 7 }), { ok: true, proposal, applied: 2, skipped: 1 });
  await t.source.decideProposal({ ...ask, action: 'accept', n: 3 });
  await t.source.decideProposal({ ...ask, action: 'reject', n: 4 });
  await t.source.decideProposal({ ...ask, action: 'reject' });
  // An accept that names no change, and an action that is not one, are not sent: nothing is accepted in bulk by mistake.
  for (const action of ['accept', 'accept_all', undefined]) assert.deepEqual(await t.source.decideProposal({ ...ask, action }), { ok: false, reason: 'invalid', teamReason: '' });
  const bytes = new Uint8Array([9]);
  assert.deepEqual(await t.source.addAsset({ boardId: board.id, bytes }), { ok: true, asset: 'a'.repeat(64), mime: 'image/png', width: 4, height: 3 });
  assert.deepEqual(await t.source.readAsset({ boardId: board.id, asset: 'a'.repeat(64) }), { ok: true, bytes: new Uint8Array([1, 2]), mime: 'image/png' });
  assert.deepEqual(t.calls, [
    ['boardProposals', at(1)],
    ['boardProposalAccept', { ...at(1), proposal_id: 'p-1' }],
    ['boardProposalAccept', { ...at(1), proposal_id: 'p-1', n: 3 }],
    ['boardProposalReject', { ...at(1), proposal_id: 'p-1', n: 4 }],
    ['boardProposalReject', { ...at(1), proposal_id: 'p-1' }],
    ['boardAssetAdd', { ...at(1), bytes }],
    ['boardAssetRead', { ...at(1), asset: 'a'.repeat(64) }],
  ]);
  for (const [answer, reason] of [[refused('team_board_proposal_closed'), 'closed'], [refused('team_board_proposal_additions_first'), 'additions_first'],
    [refused('team_board_asset_size_limit'), 'too_large'], [refused('team_board_asset_unsupported'), 'unsupported']]) {
    t.answers.boardProposalAccept = answer;
    const got = await t.source.decideProposal({ ...ask, action: 'accept', n: 1 });
    assert.deepEqual([got.reason, got.message], [reason, undefined]);
  }
  t.answers.boardProposalAccept = refused('team_board_not_viewing');
  assert.equal((await t.source.decideProposal({ ...ask, action: 'accept', n: 1 })).message, 'Open this board to answer what Jenny proposes on it.');
  t.answers.boardAssetAdd = refused('team_board_asset_storage_limit');
  assert.equal((await t.source.addAsset({ boardId: board.id, bytes })).message, "This team's boards have used the space they have for pictures.");
  // The two limits of a project's boards say what they are (wave 10 review): deleted boards, and the documents' space.
  t.holder.role = 'admin';
  t.answers.boardDelete = refused('team_board_trash_limit');
  assert.equal((await t.source.delete({ boardId: board.id })).message, 'This project has too many deleted boards. Each is removed for good 7 days after it was deleted.');
  t.answers.boardCreate = refused('team_board_storage_limit');
  assert.equal((await t.source.create({ name: 'More' })).message, "This project's boards have used the space the team server gives them.");
});

test('copy to a team project: the document in one request, then each picture; a refused copy sends no picture and a failed picture is counted', async () => {
  const own = createMemoryBoardSource({ model });
  const mine = (await own.create({ projectId: 'project_alpha', name: 'Mine' })).board;
  await own.apply({ boardId: mine.id, batch: { batch_id: 'b1', board_id: mine.id, actor: 'owner', ops: [note(1, 'ship it')] } });
  const pictures = { ['a'.repeat(64)]: new Uint8Array([1]), ['b'.repeat(64)]: null };
  own.readAsset = async ({ asset }) => (pictures[asset] ? { ok: true, bytes: pictures[asset], mime: 'image/png' } : { ok: false, reason: 'not_found' });
  const made = { id: boardId(7), name: 'Mine' };
  const t = teamSource({ boardImport: { ok: true, board: made, pictures: Object.keys(pictures) }, boardAssetAdd: { ok: true, asset: 'a'.repeat(64), mime: 'image/png', width: 1, height: 1 } });
  assert.deepEqual(await copyBoardToTeam({ own, team: t.source, boardId: mine.id }), { ok: true, board: made, pictures: { sent: 1, failed: 1 } });
  assert.deepEqual(t.names(), ['boardImport', 'boardAssetAdd']);
  const [, sent] = t.calls[0];
  assert.deepEqual([sent.team_id, sent.project_id, sent.board.id, Object.values(sent.board.cards)[0].data.text], [TEAM, PROJECT, mine.id, 'ship it']);
  assert.deepEqual(t.calls[1][1], { team_id: TEAM, project_id: PROJECT, board_id: made.id, bytes: pictures['a'.repeat(64)] });

  t.calls.length = 0;
  t.answers.boardImport = refused('team_board_limit');
  assert.deepEqual(await copyBoardToTeam({ own, team: t.source, boardId: mine.id }), { ok: false, reason: 'limit', teamReason: 'team_board_limit' });
  assert.deepEqual(t.names(), ['boardImport']);
  assert.deepEqual(await copyBoardToTeam({ own, team: t.source, boardId: boardId(99) }), { ok: false, reason: 'not_found' });
  t.holder.role = 'reader';
  t.calls.length = 0;
  assert.equal((await copyBoardToTeam({ own, team: t.source, boardId: mine.id })).reason, 'read_only');
  assert.deepEqual(t.calls, []);
});

// ------------------------------------------------------------------ the page in team scope

function pageHarness(t, { teamAnswers = {}, team = true, prepare = null } = {}) {
  const dom = new JSDOM('<!doctype html><body><section id="boardView"></section></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const { window } = dom;
  const own = createMemoryBoardSource({ model });
  const ownCalls = [];
  const bridge = new Proxy({}, {
    get: (_target, name) => (name === 'onChanged' ? (listener) => own.onChanged(listener) : (request) => { ownCalls.push(name); return own[name](request); }),
  });
  const shared = teamBridge(teamAnswers);
  window.jennyShell = { boards: bridge, ...(team ? { team: shared.bridge } : {}) };
  const switcher = { currentProject: () => ({ id: 'project_alpha', name: 'Alpha' }), refresh: async () => [], onProjectsChanged: () => () => {} };
  const toasts = [];
  if (prepare) prepare(window);
  const page = createBoardPage({ container: window.document.getElementById('boardView'), windowRef: window, storage: window.localStorage,
    getProjectSwitcher: async () => switcher, showToast: (message, options) => toasts.push({ message, ...options }) });
  t.after(() => { page.dispose(); window.close(); });
  const doc = window.document;
  return { window, doc, own, ownCalls, page, toasts, ...shared,
    names: () => [...doc.querySelectorAll('[data-board-id] .session-row__title-text')].map((el) => el.textContent),
    cards: () => [...doc.querySelectorAll('.inv-board-card')].length,
    noteTool: () => doc.querySelector('[data-board-tool="note"]'),
    pick: async (role = 'writer') => { page.pickProject({ id: PROJECT, name: 'Shared', team: { id: TEAM, name: 'One' }, role: () => role }); await flush(); } };
}

test('the page: picking a team project lists and opens its boards through the team bridge, and going back closes the board held there', async (t) => {
  const [one, two] = [teamBoard(1, 'One', note(1, 'first')), teamBoard(2, 'Two')];
  const h = pageHarness(t, { teamAnswers: { boardList: { ok: true, boards: [row(one), row(two)] }, boardOpen: (payload) => opened(payload.board_id === one.id ? one : two) } });
  await h.own.create({ projectId: 'project_alpha', name: 'Mine' });
  await h.page.started;
  await flush();
  assert.deepEqual([h.names(), h.calls, h.page.getTeamSource()], [['Mine'], [], null], 'no team call before a team project is picked');

  await h.pick();
  assert.deepEqual([h.names(), h.page.getProjectId(), h.page.getOpenBoardId(), h.cards()], [['One', 'Two'], PROJECT, one.id, 1]);
  assert.deepEqual(h.calls, [['boardList', { team_id: TEAM, project_id: PROJECT }], ['boardOpen', at(1)]]);
  assert.equal(h.noteTool().disabled, false);
  assert.deepEqual(h.page.getTeamSource().scope, { teamId: TEAM, projectId: PROJECT });

  // A change of this Jenny's own boards does not reload the team list; the team's list change does.
  h.calls.length = 0;
  h.ownCalls.length = 0;
  await h.own.create({ projectId: 'project_alpha', name: 'Unseen' });
  await flush();
  assert.deepEqual([h.calls, h.ownCalls.filter((name) => name === 'list')], [[], []]);
  h.push({ kind: 'list_changed', team_id: TEAM, project_id: PROJECT });
  await flush();
  assert.deepEqual(h.names(), ['One', 'Two']);
  assert.deepEqual(h.calls.map(([name]) => name), ['boardList']);

  // Another member's batch reads the board again; a batch the host turned down is said and read again.
  const more = teamBoard(1, 'One', note(1, 'first'), note(2, 'second'));
  h.answers.boardOpen = opened(more);
  h.push({ kind: 'applied', ...at(1), rev: 2, applied: { batch_id: 'theirs', ops: [] }, actor: 'member_bob', own: false });
  await flush();
  assert.equal(h.cards(), 2);
  h.push({ kind: 'refused', ...at(1), batch_id: 'mine', reason: 'team_board_note_locked', detail: null, card_id: null, rev: 2, pending: 0 });
  await flush();
  assert.deepEqual(h.toasts.map((toast) => [toast.message, toast.tone]), [['Someone else is editing that note.', 'warning']]);
  assert.deepEqual(h.calls.map(([name]) => name), ['boardList', 'boardOpen', 'boardOpen']);

  // Another board of the project: the one before is closed on this Jenny.
  h.calls.length = 0;
  await h.page.openBoard(two.id);
  await flush();
  assert.deepEqual(h.calls, [['boardClose', at(1)], ['boardOpen', at(2)]]);

  // Back to this Jenny's project: the held board is closed, its own boards are listed, and the team is not heard.
  h.calls.length = 0;
  h.page.pickProject(null);
  await flush();
  assert.deepEqual([h.names(), h.page.getProjectId(), h.page.getTeamSource(), h.calls, h.listeners.size], [['Mine', 'Unseen'], 'project_alpha', null, [['boardClose', at(2)]], 0]);
});

test('the page: a reader sees a team board view-only, an unreadable one says why with nothing to press, and leaving the page closes the board', async (t) => {
  const one = teamBoard(1, 'One', note(1, 'first'));
  const h = pageHarness(t, { teamAnswers: { boardList: { ok: true, boards: [row(one)] }, boardOpen: opened(one) } });
  await h.page.started;
  await h.pick('reader');
  assert.deepEqual([h.cards(), h.noteTool().disabled], [1, true]);
  h.answers.boardOpen = { ok: true, board: null, rev: 1, read_only: true, reason: 'unreadable', pending: 0, presence: null };
  await h.page.reload();
  await flush();
  assert.equal(h.doc.querySelector('#boardView').textContent.includes('The team server cannot read this board, so it cannot be changed.'), true);
  assert.equal(h.doc.querySelector('[data-board-action="reveal"], [data-board-action="set-aside"]'), null);
  h.calls.length = 0;
  h.page.dispose();
  assert.deepEqual([h.calls, h.listeners.size], [[['boardClose', at(1)]], 0]);
});

test('the page: with no team bridge a picked team project is not shown: the page stays on this Jenny\'s project', async (t) => {
  const h = pageHarness(t, { team: false });
  await h.own.create({ projectId: 'project_alpha', name: 'Mine' });
  await h.page.started;
  await h.pick();
  assert.deepEqual([h.names(), h.page.getProjectId(), h.page.getTeamSource(), h.calls], [['Mine'], 'project_alpha', null, []]);
});

test('the page: with the team gate on the window the team half is loaded once and attached with what it needs; with no gate nothing is asked for', async (t) => {
  const one = teamBoard(1, 'One');
  const loads = [];
  const attached = [];
  const part = { syncs: 0, disposed: 0, menus: [] };
  const prepare = (window) => {
    window.rendererSettingsScriptManifest = Object.assign([], { teamBoard: [['renderer/features/board/board-source-team.js', 'rendererBoardSourceTeam']] });
    window.rendererTeamTabGate = { ensureTeamAssets: async (request) => {
      loads.push(request.scripts.map(([src]) => src));
      window.rendererBoardTeam = { attachBoardTeam: (ctx) => {
        attached.push(ctx);
        return { sync: () => { part.syncs += 1; }, dispose: () => { part.disposed += 1; }, listState: () => ({ menu: true }), openChat: () => true,
          openProjectMenu: (anchorEl) => part.menus.push(anchorEl) };
      } };
      return true;
    } };
  };
  const h = pageHarness(t, { prepare, teamAnswers: { boardList: { ok: true, boards: [row(one)] }, boardOpen: opened(one) } });
  await h.own.create({ projectId: 'project_alpha', name: 'Mine' });
  await h.page.started;
  await flush();
  assert.deepEqual([loads, attached.length], [[['renderer/features/board/board-source-team.js']], 1]);
  const [ctx] = attached;
  for (const key of ['windowRef', 'document', 'jt', 'notify', 'gate', 'lists', 'rootEl', 'listEl', 'canvas', 'chatHost', 'chat', 'editor', 'own',
    'getProject', 'getTeamSource', 'getBoards', 'getOpenBoardId', 'openBoard', 'pickProject', 'reload', 'redraw']) assert.notEqual(ctx[key], undefined, key);
  assert.deepEqual([ctx.getProject().id, ctx.getTeamSource(), ctx.getBoards().map((b) => b.name), typeof ctx.own.get, ctx.chatHost.hasAttribute('data-board-chat-host')],
    ['project_alpha', null, ['Mine'], 'function', true]);
  // The tab shown again does not load or attach a second time; the part is told when the project or the open board changes.
  h.page.checkProject();
  await flush();
  assert.deepEqual([loads.length, attached.length], [1, 1]);
  const before = part.syncs;
  ctx.pickProject({ id: PROJECT, name: 'Shared', team: { id: TEAM, name: 'One' }, role: () => 'writer' });
  await flush();
  assert.equal(part.syncs > before, true);
  assert.deepEqual([ctx.getProject().team.id, ctx.getTeamSource().scope.projectId, ctx.getBoards().map((b) => b.name), ctx.getOpenBoardId()], [TEAM, PROJECT, ['One'], one.id]);
  h.page.dispose();
  assert.equal(part.disposed, 1);

  // No gate (Team off): nothing is asked for and nothing attaches.
  const off = pageHarness(t, { prepare: (window) => { window.rendererSettingsScriptManifest = Object.assign([], { teamBoard: [['x.js', 'x']] }); } });
  await off.page.started;
  await flush();
  off.page.checkProject();
  await flush();
  assert.deepEqual([off.window.rendererBoardTeam, off.page.getTeamSource(), off.calls], [undefined, null, []]);
});
