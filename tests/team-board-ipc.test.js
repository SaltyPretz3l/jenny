'use strict';

// new-test-file: row 151 slice T3 adds the member client's team board IPC family (services/team/board-ipc.js and
// team-board-clients.js), a new renderer-facing surface; tests/team-board-client.test.js covers one board's client
// against the host parts and is its own lane.
//
// Three layers: the closed payload table; the per-team module over a scripted connection (answers rebuilt, the open
// limit, events, connection changes, force local, and from slices T4 and T5 the pointer, the note lock, Jenny's
// proposals and the revert, and from slice T7 a board copied in whole); and one end-to-end run through the real team service, bridge and host, where a writer
// edits a board and a reader's Jenny sees it.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const { hostFailure } = require('../server/api-contract');
const model = require('../services/boards/board-model');
const pkg = require('../services/boards/board-package');
const { BOARD_METHODS: TABLE, BOARD_OPERATIONS } = require('../services/team/board-ipc');
const { validatePayload } = require('../services/team/ipc-methods');
const { createTeamHttp } = require('../services/team/http-client');
const { MAX_OPEN, createTeamBoardClients } = require('../services/team/team-board-clients');
const { BOARD_METHODS, BOARD_PUSH_KINDS } = require('./helpers/team-model-methods');
const { waitUntil } = require('./helpers/team-client-host');
const { projectTeam } = require('./helpers/team-project-client-host');
const { png, sha } = require('./server/helpers/team-board-pictures');

const TEAM = `team_${'a'.repeat(32)}`;
const PROJECT = `project_${'b'.repeat(32)}`;
const NOW = '2026-11-15T09:00:00.000Z';
const boardId = () => `board_${crypto.randomUUID()}`;
const note = (text = 'hello') => ({ op: 'card.add', card: { id: crypto.randomUUID(), kind: 'note', x: 0, y: 0, data: { text } } });
const batch = (...ops) => ({ batch_id: `b-${crypto.randomUUID()}`, ops });
const reasonOf = (answer) => answer?.error?.reason;
// A board document as the desktop's own board store holds one, for a copy to a team project.
function localBoard(name, ...ops) {
  const id = boardId();
  const empty = model.createBoard({ id, project_id: 'project_general', name, now: NOW }).board;
  return model.applyBatch(empty, { batch_id: 'b-1', board_id: id, actor: 'owner', ops }, { now: NOW }).board;
}
// A host refusal as the renderer sees it: the host's code and reason, nothing else.
const denied = (reason) => ({ ok: false, error: { code: hostFailure('forbidden', reason).error.code, reason } });

/* ------------------------------------------------------------------ the payload table */

test('the board methods are a closed table: twenty methods, eleven of them one host operation each', () => {
  assert.deepEqual(Object.keys(TABLE), [...BOARD_METHODS]);
  assert.deepEqual(BOARD_OPERATIONS, { boardList: 'team.board.list', boardTrash: 'team.board.trash',
    boardCreate: 'team.board.create', boardRename: 'team.board.rename', boardDelete: 'team.board.delete',
    boardRestore: 'team.board.restore', boardOpen: null, boardApply: null, boardClose: null,
    boardCursor: null, boardLock: null, boardUnlock: null, boardProposals: 'team.board.proposal.list',
    boardProposalAccept: 'team.board.proposal.accept', boardProposalReject: 'team.board.proposal.reject',
    boardRevert: 'team.board.revert', boardHistory: 'team.board.history', boardAssetAdd: null, boardAssetRead: null, boardImport: null });
  const board = boardId();
  const card = crypto.randomUUID();
  const optional = { boardCursor: ['selected'], boardProposalAccept: ['n'], boardProposalReject: ['n'] };
  const good = {
    boardList: { team_id: TEAM, project_id: PROJECT }, boardTrash: { team_id: TEAM, project_id: PROJECT },
    boardCreate: { team_id: TEAM, project_id: PROJECT, name: 'Roadmap' },
    boardRename: { team_id: TEAM, project_id: PROJECT, board_id: board, name: 'Plan' },
    boardDelete: { team_id: TEAM, project_id: PROJECT, board_id: board }, boardRestore: { team_id: TEAM, project_id: PROJECT, board_id: board },
    boardOpen: { team_id: TEAM, project_id: PROJECT, board_id: board }, boardClose: { team_id: TEAM, project_id: PROJECT, board_id: board },
    boardApply: { team_id: TEAM, project_id: PROJECT, board_id: board, batch: batch(note()) },
    boardCursor: { team_id: TEAM, project_id: PROJECT, board_id: board, x: -12.5, y: 40, selected: [card] },
    boardLock: { team_id: TEAM, project_id: PROJECT, board_id: board, card_id: card },
    boardUnlock: { team_id: TEAM, project_id: PROJECT, board_id: board }, boardProposals: { team_id: TEAM, project_id: PROJECT, board_id: board },
    boardProposalAccept: { team_id: TEAM, project_id: PROJECT, board_id: board, proposal_id: 'p-1', n: 2 },
    boardProposalReject: { team_id: TEAM, project_id: PROJECT, board_id: board, proposal_id: 'p-1', n: 2 },
    boardRevert: { team_id: TEAM, project_id: PROJECT, board_id: board, rev: 3 },
    boardHistory: { team_id: TEAM, project_id: PROJECT, board_id: board },
    boardAssetAdd: { team_id: TEAM, project_id: PROJECT, board_id: board, bytes: new Uint8Array([1, 2, 3]) },
    boardAssetRead: { team_id: TEAM, project_id: PROJECT, board_id: board, asset: 'a'.repeat(64) },
    boardImport: { team_id: TEAM, project_id: PROJECT, board: { id: board } },
  };
  for (const method of BOARD_METHODS) {
    assert.deepEqual(validatePayload(method, good[method]), { ok: true, value: good[method] }, method);
    assert.equal(validatePayload(method, { ...good[method], extra: 1 }).ok, false, `${method} with an unknown field`);
    for (const field of Object.keys(good[method])) {
      const { [field]: _dropped, ...rest } = good[method];
      assert.equal(validatePayload(method, rest).ok, optional[method]?.includes(field) === true, `${method} without ${field}`);
    }
    for (const [field, bad] of [['team_id', 'board_x'], ['project_id', 'project_general'], ['project_id', '../x']]) {
      assert.equal(validatePayload(method, { ...good[method], [field]: bad }).ok, false, `${method} ${field} ${bad}`);
    }
    if ('board_id' in good[method]) {
      for (const bad of ['board_x', board.toUpperCase(), `${board}/..`, 7]) {
        assert.equal(validatePayload(method, { ...good[method], board_id: bad }).ok, false, `${method} board ${bad}`);
      }
    }
  }
  for (const name of ['', 'x'.repeat(201), 'two\nlines', 7]) {
    assert.equal(validatePayload('boardCreate', { ...good.boardCreate, name }).ok, false, `name ${JSON.stringify(name)}`);
  }
  const apply = (value) => validatePayload('boardApply', { ...good.boardApply, batch: value }).ok;
  for (const bad of [null, [], { ops: [note()] }, { batch_id: 'b 1', ops: [note()] }, { batch_id: 'b1', ops: [] },
    { batch_id: 'b1', ops: ['x'] }, { batch_id: 'b1', ops: [note()], actor: 'member_x' }, { batch_id: 'b1', ops: [note()], now: NOW },
    { batch_id: 'b1', ops: Array.from({ length: 4097 }, () => ({})) }]) {
    assert.equal(apply(bad), false, JSON.stringify(bad)?.slice(0, 80));
  }
  const bad = (method, change) => assert.equal(validatePayload(method, { ...good[method], ...change }).ok, false, `${method} ${JSON.stringify(change).slice(0, 60)}`);
  for (const change of [{ x: Number.NaN }, { y: Infinity }, { x: 10_000_001 }, { x: '1' }, { selected: ['card'] },
    { selected: Array.from({ length: 65 }, () => card) }, { selected: card }]) bad('boardCursor', change);
  for (const value of ['card', card.toUpperCase(), 7, null]) bad('boardLock', { card_id: value });
  for (const method of ['boardProposalAccept', 'boardProposalReject']) {
    for (const change of [{ proposal_id: '' }, { proposal_id: 'x'.repeat(501) }, { proposal_id: 'a\nb' }, { proposal_id: 7 },
      { n: 0 }, { n: 1.5 }, { n: '2' }, { n: 100_001 }]) bad(method, change);
  }
  for (const rev of [0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) bad('boardRevert', { rev });
  for (const value of ['abc', [1, 2], new Uint8Array(0), null, { byteLength: 3 }]) bad('boardAssetAdd', { bytes: value });
  for (const value of ['a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(64)}.png`, `../${'a'.repeat(61)}`, 7]) bad('boardAssetRead', { asset: value });
  for (const value of ['text', [1], null, 7]) bad('boardImport', { board: value });
  // A conversation turn may name one board; nothing but a board id is taken.
  const send = { team_id: TEAM, session_id: 'sess_1700000000000_abcdef012345', prompt: 'hi' };
  assert.equal(validatePayload('conversationSend', { ...send, board_id: board }).ok, true);
  for (const value of ['board_x', '', null, 7, `${board}/..`]) {
    assert.equal(validatePayload('conversationSend', { ...send, board_id: value }).ok, false, `send board ${value}`);
  }
});

test('the team service loads the board table only: no board client and no board model until the first board call', () => {
  // A fresh process: this file's own requires would hide it.
  const script = 'require("./services/team/team-service");'
    + 'process.stdout.write(JSON.stringify(Object.keys(require.cache).map((file) => file.replaceAll("\\\\", "/"))'
    + '.filter((file) => /services\\/(team\\/(board-client|team-board-clients)|boards\\/board-model)/u.test(file))));';
  const out = execFileSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), []);
});

/* ------------------------------------------------------------------ the module over a scripted connection */

function scripted({ member = 'member_me' } = {}) {
  const listeners = new Set();
  const manager = {
    row: { state: 'online', member_state: 'active', member_id: member, role: 'member' },
    answers: {},
    snapshots: new Map(),
    calls: [],
    snapshot: () => ({ ...manager.row }),
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(event) { for (const listener of [...listeners]) listener(event); },
    listeners,
    async command(operation, params) {
      manager.calls.push({ operation, params });
      const answer = manager.answers[operation];
      return typeof answer === 'function' ? answer(params) : answer;
    },
    borrow: () => ({ online: manager.row.state === 'online', ensureClient: async () => null,
      link: { client: { client_id: 'client_1', client_token: 'token' },
        session: { boardSnapshot: async (_client, projectId, id) => manager.snapshots.get(`${projectId}/${id}`)
          ?? hostFailure('forbidden', 'team_board_not_found', 'request_1'),
        boardAssetPut: async (_client, sent) => { manager.pictures.push(sent); return manager.answers.put(sent); },
        boardAssetGet: async (_client, asked) => manager.answers.get(asked),
        boardImport: async (_client, sent) => { manager.imports.push(sent); return manager.answers.copy(sent); } } } }),
    pictures: [],
    imports: [],
  };
  manager.board = (id = boardId()) => {
    manager.snapshots.set(`${PROJECT}/${id}`, { ok: true, board: model.createBoard({ id, project_id: PROJECT, name: 'Plan', now: NOW }).board });
    return id;
  };
  return manager;
}

// Real timers that never keep the test process alive (an open board's presence beats every 15 seconds).
const quietTimers = { setTimeout: (body, ms) => setTimeout(body, ms).unref(), clearTimeout };

function setup({ held = { on: false } } = {}) {
  const manager = scripted();
  const managers = new Map([[TEAM, manager]]);
  const pushes = [];
  const boards = createTeamBoardClients({ managerOf: (teamId) => managers.get(teamId) ?? null, isHeld: () => held.on,
    push: (payload) => pushes.push(payload), timers: quietTimers });
  const at = (id) => ({ team_id: TEAM, project_id: PROJECT, board_id: id });
  return { manager, managers, pushes, boards, held, at };
}

test('a plain call is one host command and its answer is rebuilt field by field', async () => {
  const s = setup();
  const id = boardId();
  const row = { id, name: 'Roadmap', rev: 3, created_at: NOW, updated_at: NOW, created_by: 'member_alice' };
  s.manager.answers['team.board.list'] = { ok: true, boards: [{ ...row, secret: 'x' }], extra: true };
  assert.deepEqual(await s.boards.call('boardList', { team_id: TEAM, project_id: PROJECT }), { ok: true, boards: [row] });
  assert.deepEqual(s.manager.calls, [{ operation: 'team.board.list', params: { project_id: PROJECT } }]);
  const gone = { ...row, deleted_at: NOW, deleted_by: 'member_bob' };
  s.manager.answers['team.board.trash'] = { ok: true, boards: [gone] };
  assert.deepEqual(await s.boards.call('boardTrash', { team_id: TEAM, project_id: PROJECT }), { ok: true, boards: [gone] });
  s.manager.answers['team.board.create'] = { ok: true, board: { ...model.createBoard({ id, project_id: PROJECT, name: 'New', now: NOW }).board } };
  assert.deepEqual(await s.boards.call('boardCreate', { team_id: TEAM, project_id: PROJECT, name: 'New' }),
    { ok: true, board: { id, name: 'New', rev: 0 } });
  s.manager.answers['team.board.rename'] = { ok: true, rev: 4, name: 'ignored' };
  assert.deepEqual(await s.boards.call('boardRename', { ...s.at(id), name: 'Plan' }), { ok: true, rev: 4 });
  assert.deepEqual(s.manager.calls.at(-1), { operation: 'team.board.rename', params: { project_id: PROJECT, board_id: id, name: 'Plan' } });
  s.manager.answers['team.board.delete'] = { ok: true, anything: 1 };
  assert.deepEqual(await s.boards.call('boardDelete', s.at(id)), { ok: true });
  // A malformed answer is refused, never passed on.
  for (const boards of [[{ ...row, id: 'board_x' }], [{ ...row, rev: -1 }], [{ ...row, created_at: 'yesterday' }], 'rows',
    Array.from({ length: 257 }, () => row)]) {
    s.manager.answers['team.board.list'] = { ok: true, boards };
    assert.equal(reasonOf(await s.boards.call('boardList', { team_id: TEAM, project_id: PROJECT })), 'team_response_invalid');
  }
  s.manager.answers['team.board.trash'] = { ok: true, boards: [row] };
  assert.equal(reasonOf(await s.boards.call('boardTrash', { team_id: TEAM, project_id: PROJECT })), 'team_response_invalid');
  // A refusal keeps its code and reason and nothing else; no answer at all is a connection failure.
  const refusal = hostFailure('forbidden', 'team_not_found', 'request_1');
  s.manager.answers['team.board.restore'] = { ...refusal, error: { ...refusal.error, detail: '/path' }, more: 1 };
  assert.deepEqual(await s.boards.call('boardRestore', s.at(id)), denied('team_not_found'));
  s.manager.answers['team.board.restore'] = () => { throw new Error('reset'); };
  assert.equal(reasonOf(await s.boards.call('boardRestore', s.at(id))), 'team_unavailable');
});

test('open, apply and close; at most eight boards a team; a board that did not open holds no slot', async () => {
  const s = setup();
  s.manager.answers['team.board.apply'] = () => new Promise(() => {}); // the host never answers in this test
  const first = s.manager.board();
  const opened = await s.boards.call('boardOpen', s.at(first));
  assert.deepEqual([opened.ok, opened.board.id, opened.rev, opened.read_only, opened.pending], [true, first, 0, false, 0]);
  assert.deepEqual(opened.presence, { viewers: [], cursors: [], locks: [], mine: null });
  assert.equal((await s.boards.call('boardOpen', s.at(first))).ok, true, 'opening again answers the same board');
  // The one timer is the presence heartbeat of the open board; one view was sent, not two.
  assert.deepEqual(s.boards.resources(), { teams: 1, boards: 1, pending: 0, timers: 1 });
  assert.deepEqual(s.manager.calls.map((call) => call.operation), ['team.board.view']);
  // A batch goes on the member's view at once.
  const applied = await s.boards.call('boardApply', { ...s.at(first), batch: batch(note('one')) });
  assert.deepEqual([applied.ok, applied.pending, Object.keys(applied.board.cards).length], [true, 1, 1]);
  assert.equal(s.manager.calls.at(-1).operation, 'team.board.apply');
  // The model's refusal of a batch keeps its closed words and sends nothing.
  const before = s.manager.calls.length;
  const refused = await s.boards.call('boardApply', { ...s.at(first), batch: batch({ op: 'card.remove', id: crypto.randomUUID(), content_rev: 1 }) });
  assert.deepEqual([refused.ok, reasonOf(refused), typeof refused.board.reason, refused.board.index], [false, 'team_board_refused', 'string', 0]);
  assert.equal(s.manager.calls.length, before);
  // A board that is not open, and one the host does not serve.
  const other = boardId();
  assert.equal(reasonOf(await s.boards.call('boardApply', { ...s.at(other), batch: batch(note()) })), 'team_board_not_open');
  assert.deepEqual(await s.boards.call('boardOpen', s.at(other)), denied('team_board_not_found'));
  assert.equal(s.boards.resources().boards, 1, 'the refused board holds no slot');
  // Eight open boards; the ninth is refused until one closes.
  for (let i = 1; i < MAX_OPEN; i += 1) assert.equal((await s.boards.call('boardOpen', s.at(s.manager.board()))).ok, true);
  const ninth = s.manager.board();
  assert.equal(reasonOf(await s.boards.call('boardOpen', s.at(ninth))), 'team_board_open_limit');
  assert.deepEqual(await s.boards.call('boardClose', s.at(first)), { ok: true });
  assert.deepEqual(s.manager.calls.at(-1), { operation: 'team.board.leave', params: { project_id: PROJECT, board_id: first } });
  assert.deepEqual(await s.boards.call('boardClose', s.at(first)), { ok: true }, 'closing twice is fine');
  assert.equal((await s.boards.call('boardOpen', s.at(ninth))).ok, true);
  assert.equal(reasonOf(await s.boards.call('boardApply', { ...s.at(first), batch: batch(note()) })), 'team_board_not_open');
  s.boards.stopAll();
  assert.deepEqual(s.boards.resources(), { teams: 0, boards: 0, pending: 0, timers: 0 });
  assert.equal(reasonOf(await s.boards.call('boardList', { team_id: TEAM, project_id: PROJECT })), 'team_disposed');
});

test('events and connection changes: who hears what; a new connection, a revoked team and force local', async () => {
  const s = setup();
  const [a, b] = [s.manager.board(), s.manager.board()];
  // Before any board call nothing listens.
  assert.equal(s.manager.listeners.size, 0);
  s.manager.answers['team.board.list'] = { ok: true, boards: [] };
  await s.boards.call('boardList', { team_id: TEAM, project_id: PROJECT });
  assert.equal(s.manager.listeners.size, 1, 'one listener a team, from the first board call');
  s.manager.emit({ event_type: 'team_board_list_changed', project_id: PROJECT });
  s.manager.emit({ event_type: 'team_board_list_changed', project_id: '../x' });
  s.manager.emit({ event_type: 'team_project_changed', project_id: PROJECT, reason: 'renamed' });
  assert.deepEqual(s.pushes, [{ kind: 'list_changed', team_id: TEAM, project_id: PROJECT }]);
  await s.boards.call('boardOpen', s.at(a));
  await s.boards.call('boardOpen', s.at(b));
  // A change to board a past what its client holds: only a's client asks the host for it.
  s.manager.answers['team.board.sync'] = (params) => ({ ok: true, rev: 0, batches: [], more: false, asked: params.board_id });
  s.manager.calls.length = 0;
  s.manager.emit({ event_type: 'team_board_changed', project_id: PROJECT, board_id: a, rev: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(s.manager.calls.map((call) => [call.operation, call.params.board_id]), [['team.board.sync', a]]);
  // The stream lost its place: every open board catches up. Back online: the same.
  for (const act of [() => s.manager.emit({ event_type: 'resync_required', reason: 'replay_unavailable' }),
    () => { s.manager.row.state = 'reconnecting'; s.boards.connectionChanged(TEAM, s.manager);
      s.manager.row.state = 'online'; s.boards.connectionChanged(TEAM, s.manager); }]) {
    s.manager.calls.length = 0;
    act();
    await new Promise((resolve) => setImmediate(resolve));
    const asked = (operation) => s.manager.calls.filter((call) => call.operation === operation).map((call) => call.params.board_id).sort();
    assert.deepEqual(asked('team.board.sync'), [a, b].sort());
    // Back online, each open board also says again that this member is viewing it.
    assert.deepEqual(asked('team.board.view'), s.manager.calls.length === 2 ? [] : [a, b].sort());
  }
  // Force local: every call is refused, nothing is sent and no event is fed.
  s.held.on = true;
  s.manager.calls.length = 0;
  const pushed = s.pushes.length;
  assert.equal((await s.boards.call('boardList', { team_id: TEAM, project_id: PROJECT })).ok, false);
  assert.equal((await s.boards.call('boardApply', { ...s.at(a), batch: batch(note()) })).ok, false);
  s.manager.emit({ event_type: 'team_board_list_changed', project_id: PROJECT });
  s.manager.emit({ event_type: 'team_board_changed', project_id: PROJECT, board_id: a, rev: 9 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([s.manager.calls.length, s.pushes.length], [0, pushed]);
  s.held.on = false;
  // A team with no connection; a new connection for the team closes the old one's boards; so does a revoked team.
  assert.equal(reasonOf(await s.boards.call('boardList', { team_id: `team_${'c'.repeat(32)}`, project_id: PROJECT })), 'team_not_found');
  const next = scripted();
  s.managers.set(TEAM, next);
  s.boards.connectionChanged(TEAM, next);
  assert.deepEqual([s.boards.resources().boards, s.manager.listeners.size], [0, 0]);
  const open = s.at(next.board());
  await s.boards.call('boardOpen', open);
  next.row.state = 'revoked';
  s.boards.connectionChanged(TEAM, next);
  assert.deepEqual([s.boards.resources(), next.listeners.size, s.pushes.at(-1)], [{ teams: 0, boards: 0, pending: 0, timers: 0 }, 0, { kind: 'gone', reason: 'team_board_closed', ...open }]);
  await s.boards.call('boardOpen', s.at(next.board()));
  s.boards.drop(TEAM);
  assert.equal(s.boards.resources().teams, 0);
});

test('presence, proposals and revert: the pointer and the note lock of an open board, answers rebuilt', async () => {
  const s = setup();
  const [me, ann] = ['member_me', `member_${'a'.repeat(32)}`];
  s.manager.row.member_id = `member_${'e'.repeat(32)}`;
  const self = s.manager.row.member_id;
  const [a, other] = [s.manager.board(), s.manager.board()];
  const card = crypto.randomUUID();
  s.manager.answers['team.board.view'] = { ok: true, viewers: [self, ann], locks: [{ card_id: card, member_id: ann }], secret: 1 };
  // A board that is not open has no pointer, lock or presence.
  for (const [method, more] of [['boardCursor', { x: 1, y: 2 }], ['boardLock', { card_id: card }], ['boardUnlock', {}]]) {
    assert.equal(reasonOf(await s.boards.call(method, { ...s.at(a), ...more })), 'team_board_not_open', method);
  }
  await s.boards.call('boardOpen', s.at(a));
  const presence = () => s.pushes.filter((push) => push.kind === 'presence').at(-1);
  assert.ok(await waitUntil(() => presence()?.viewers.length === 2, { attempts: 200, interval: 5 }), 'the first view was pushed');
  assert.deepEqual(presence(), { kind: 'presence', team_id: TEAM, project_id: PROJECT, board_id: a,
    viewers: [ann, self].sort(), cursors: [], locks: [{ card_id: card, member_id: ann }], mine: null });
  // Another member's pointer on this board is shown; one for a board that is not open, or malformed, is not.
  s.manager.emit({ event_type: 'team_board_cursor', project_id: PROJECT, board_id: other, member_id: ann, x: 1, y: 1, selected: [] });
  s.manager.emit({ event_type: 'team_board_cursor', project_id: PROJECT, board_id: a, member_id: 'ann', x: 1, y: 1, selected: [] });
  s.manager.emit({ event_type: 'team_board_cursor', project_id: PROJECT, board_id: a, member_id: ann, x: 5, y: 6, selected: [card], more: me });
  assert.ok(await waitUntil(() => presence()?.cursors.length === 1, { attempts: 200, interval: 5 }));
  assert.deepEqual(presence().cursors, [{ member_id: ann, x: 5, y: 6, selected: [card] }]);
  // This member's pointer: answered at once, sent as one host command.
  assert.deepEqual(await s.boards.call('boardCursor', { ...s.at(a), x: 3, y: 4 }), { ok: true });
  assert.deepEqual(s.manager.calls.at(-1), { operation: 'team.board.cursor', params: { project_id: PROJECT, board_id: a, x: 3, y: 4, selected: [] } });
  // The note lock: a refusal names who holds it and nothing else of the host's answer.
  s.manager.answers['team.board.lock'] = { ...hostFailure('conflict', 'team_board_note_locked', 'request_1'), held_by: ann, path: '/x' };
  assert.deepEqual(await s.boards.call('boardLock', { ...s.at(a), card_id: card }),
    { ok: false, error: { code: hostFailure('conflict', 'x').error.code, reason: 'team_board_note_locked' }, held_by: ann });
  const mine = crypto.randomUUID();
  s.manager.answers['team.board.lock'] = { ok: true };
  assert.deepEqual(await s.boards.call('boardLock', { ...s.at(a), card_id: mine }), { ok: true });
  assert.ok(await waitUntil(() => presence()?.mine === mine, { attempts: 200, interval: 5 }));
  assert.deepEqual(await s.boards.call('boardUnlock', s.at(a)), { ok: true });
  assert.deepEqual(s.manager.calls.at(-1), { operation: 'team.board.unlock', params: { project_id: PROJECT, board_id: a, card_id: mine } });
  // Jenny's proposals: the desktop's shape and the prompter, rebuilt; anything else is refused whole.
  const change = { n: 1, line: 'note "Ship it"', type: 'note', class: 'addition', state: 'pending', reason: '', summary: { text: 'Ship it', group: '' } };
  const proposal = { id: 'p-1', sessionId: 'sess_1700000000000_abcdef012345', messageId: 'm-1', state: 'pending', open: true,
    createdAt: NOW, madeAgainstRev: 4, overflow: 0, counts: { pending: 1, applied: 0 }, auto: null, changes: [change],
    preview: { cards: [{ n: 1, kind: 'note', x: 0, y: 0, w: 240, h: 120, groupId: '' }], groups: [] }, prompterMemberId: ann };
  s.manager.answers['team.board.proposal.list'] = { ok: true, proposals: [{ ...proposal, auto: { applied: 3 }, ops: [1],
    changes: [{ ...change, ops: [{ op: 'card.add' }] }] }], more: 1 };
  assert.deepEqual(await s.boards.call('boardProposals', s.at(a)), { ok: true, proposals: [proposal] });
  for (const broken of [{ ...proposal, sessionId: '../x' }, { ...proposal, prompterMemberId: 'someone' }, { ...proposal, changes: [{ ...change, n: 0 }] },
    { ...proposal, changes: [{ ...change, summary: { text: { html: '<b>' } } }] }, { ...proposal, preview: { cards: [{ n: 1, kind: 'note', x: 'left' }], groups: [] } }]) {
    s.manager.answers['team.board.proposal.list'] = { ok: true, proposals: [broken] };
    assert.equal(reasonOf(await s.boards.call('boardProposals', s.at(a))), 'team_response_invalid');
  }
  s.manager.answers['team.board.proposal.accept'] = { ok: true, proposal: { ...proposal, state: 'accepted', open: false }, applied: 1, skipped: 0, batchId: 'b' };
  assert.deepEqual(await s.boards.call('boardProposalAccept', { ...s.at(a), proposal_id: 'p-1', n: 1 }),
    { ok: true, proposal: { ...proposal, state: 'accepted', open: false }, applied: 1, skipped: 0 });
  assert.deepEqual(s.manager.calls.at(-1), { operation: 'team.board.proposal.accept', params: { project_id: PROJECT, board_id: a, proposal_id: 'p-1', n: 1 } });
  s.manager.answers['team.board.proposal.reject'] = hostFailure('conflict', 'team_board_proposal_closed', 'request_1');
  assert.equal(reasonOf(await s.boards.call('boardProposalReject', { ...s.at(a), proposal_id: 'p-1' })), 'team_board_proposal_closed');
  s.manager.answers['team.board.revert'] = { ok: true, rev: 9, reverted: 20, skipped: 0, applied: { ops: [] } };
  assert.deepEqual(await s.boards.call('boardRevert', { ...s.at(a), rev: 8 }), { ok: true, rev: 9, reverted: 20, skipped: 0 });
  s.manager.answers['team.board.revert'] = { ok: true, rev: 9 };
  assert.equal(reasonOf(await s.boards.call('boardRevert', { ...s.at(a), rev: 8 })), 'team_response_invalid');
  s.manager.answers['team.board.history'] = { ok: true, rev: 9, changes: [{ rev: 9, actor: 'member_a', at: '2026-11-15T10:42:00.000Z', kind: 'revert', of_rev: 8, ops: { 'card.add': 20 }, takeable: true, reverted: false, text: 'x' }] };
  assert.deepEqual([await s.boards.call('boardHistory', s.at(a)), s.manager.calls.at(-1).operation].map((v) => v.changes?.[0].of_rev ?? v), [8, 'team.board.history']);
  // The host's word that the proposals changed reaches the page for an open board only.
  const before = s.pushes.length;
  s.manager.emit({ event_type: 'team_board_proposals_changed', project_id: PROJECT, board_id: other });
  s.manager.emit({ event_type: 'team_board_proposals_changed', project_id: PROJECT, board_id: a, proposals: [proposal] });
  assert.deepEqual(s.pushes.slice(before).filter((push) => push.kind !== 'presence'),
    [{ kind: 'proposals_changed', team_id: TEAM, project_id: PROJECT, board_id: a }]);
  s.boards.stopAll();
  assert.deepEqual(s.boards.resources(), { teams: 0, boards: 0, pending: 0, timers: 0 });
});

test('a board picture: checked before it is sent, named by its hash, and checked again when it comes back', async () => {
  const s = setup();
  const id = boardId();
  const picture = png(3, 2);
  const asset = sha(picture);
  const stored = { ok: true, asset, type: 'image/png', width: 3, height: 2, bytes: picture.length, stored: true, path: '/x' };
  s.manager.answers.put = () => stored;
  assert.deepEqual(await s.boards.call('boardAssetAdd', { ...s.at(id), bytes: new Uint8Array(picture) }),
    { ok: true, asset, ext: 'png', mime: 'image/png', width: 3, height: 2, bytes: picture.length });
  assert.deepEqual([s.manager.pictures.length, s.manager.pictures[0].projectId, s.manager.pictures[0].boardId, s.manager.pictures[0].hash],
    [1, PROJECT, id, asset]);
  assert.ok(s.manager.pictures[0].bytes.equals(picture));
  // Not a picture, a picture too wide, and one over the size cap are refused here: nothing is sent.
  for (const [bytes, reason] of [[Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'team_board_asset_unsupported'],
    [png(100_001, 1), 'team_board_asset_dimensions'], [Buffer.alloc(10 * 1024 * 1024 + 1), 'team_board_asset_size_limit']]) {
    assert.equal(reasonOf(await s.boards.call('boardAssetAdd', { ...s.at(id), bytes })), reason);
  }
  assert.equal(s.manager.pictures.length, 1);
  // The host's refusal keeps its reason; an answer naming another picture or type is not taken as stored.
  s.manager.answers.put = () => hostFailure('forbidden', 'team_project_read_only', 'request_1');
  assert.deepEqual(await s.boards.call('boardAssetAdd', { ...s.at(id), bytes: picture }), denied('team_project_read_only'));
  for (const wrong of [{ ...stored, asset: 'b'.repeat(64) }, { ...stored, type: 'image/gif' }]) {
    s.manager.answers.put = () => wrong;
    assert.equal(reasonOf(await s.boards.call('boardAssetAdd', { ...s.at(id), bytes: picture })), 'team_response_invalid');
  }
  s.manager.answers.put = () => { throw new Error('reset'); };
  assert.equal(reasonOf(await s.boards.call('boardAssetAdd', { ...s.at(id), bytes: picture })), 'team_unavailable');
  // A read: the bytes must be the picture the name says, and an image of the type the host said.
  s.manager.answers.get = () => ({ ok: true, bytes: picture, type: 'image/png' });
  const read = await s.boards.call('boardAssetRead', { ...s.at(id), asset });
  assert.deepEqual([read.ok, read.mime, read.bytes.equals(picture), Object.keys(read).length], [true, 'image/png', true, 3]);
  for (const answer of [{ ok: true, bytes: png(1, 1), type: 'image/png' }, { ok: true, bytes: picture, type: 'image/jpeg' },
    { ok: true, bytes: 'text', type: 'image/png' }]) {
    s.manager.answers.get = () => answer;
    assert.equal(reasonOf(await s.boards.call('boardAssetRead', { ...s.at(id), asset })), 'team_response_invalid');
  }
  s.manager.answers.get = () => hostFailure('forbidden', 'team_board_asset_not_found', 'request_1');
  assert.deepEqual(await s.boards.call('boardAssetRead', { ...s.at(id), asset }), denied('team_board_asset_not_found'));
  // Offline: nothing is sent.
  s.manager.row.state = 'reconnecting';
  assert.equal(reasonOf(await s.boards.call('boardAssetAdd', { ...s.at(id), bytes: picture })), 'team_not_connected');
  s.boards.stopAll();
});

test('a board copied to a team project: read by the model first, a private chat card leaves as its title, the answer rebuilt', async () => {
  const s = setup();
  const [chat, plain, asset] = [crypto.randomUUID(), crypto.randomUUID(), 'd'.repeat(64)];
  const private_ = ['sess_private_1', 'msg_private_1', 'we said forty'];
  const plainDoc = localBoard('Mine',
    { op: 'card.add', card: { id: chat, kind: 'chat', x: 0, y: 0, data: { session_id: private_[0], message_id: private_[1], title: 'Pricing talk', excerpt: private_[2] } } },
    { op: 'card.add', card: { id: crypto.randomUUID(), kind: 'image', x: 0, y: 300, data: { asset, width: 4, height: 3 } } },
    { op: 'card.add', card: { id: plain, kind: 'note', x: 300, y: 0, data: { text: 'ship it' } } },
    { op: 'connector.add', connector: { id: crypto.randomUUID(), from: chat, to: plain } });
  // The chat card carries an alias, as one Jenny has named does.
  const doc = { ...plainDoc, next_alias: 2, cards: { ...plainDoc.cards, [chat]: { ...plainDoc.cards[chat], alias: 'c1' } } };
  const made = boardId();
  const at = { team_id: TEAM, project_id: PROJECT };
  s.manager.answers.copy = () => ({ ok: true, board: { id: made, name: 'Mine', rev: 0, created_by: 'member_me', secret: 'x' } });
  assert.deepEqual(await s.boards.call('boardImport', { ...at, board: doc }), { ok: true, board: { id: made, name: 'Mine' }, pictures: [asset] });
  const [sent] = s.manager.imports;
  const text = sent.bytes.toString('utf8');
  const file = JSON.parse(text);
  assert.deepEqual([sent.projectId, file.assets, file.board.cards[chat].kind, file.board.cards[chat].data, file.board.cards[chat].alias],
    [PROJECT, [], 'note', { text: 'Pricing talk', tone: null }, 'n1']);
  for (const secret of [...private_, doc.id, 'project_general']) assert.equal(text.includes(secret), false, secret);
  // What was sent is a file the host's reader takes.
  assert.equal(pkg.unpack(text, { makeId: () => crypto.randomUUID(), now: NOW, projectId: PROJECT, newBoardId: made }).ok, true);
  // A document the model refuses sends nothing; a host refusal is passed on; an answer that names no board is refused.
  for (const bad of [{ id: 'x' }, { ...doc, rev: -1 }, { ...doc, extra: 1 }]) {
    assert.equal(reasonOf(await s.boards.call('boardImport', { ...at, board: bad })), 'team_board_import_invalid');
  }
  assert.equal(s.manager.imports.length, 1);
  s.manager.answers.copy = () => hostFailure('forbidden', 'team_project_read_only', 'request_1');
  assert.deepEqual(await s.boards.call('boardImport', { ...at, board: doc }), denied('team_project_read_only'));
  for (const answer of [{ ok: true }, { ok: true, board: { id: 'board_x', name: 'Mine' } }, { ok: true, board: { id: made, name: '' } }]) {
    s.manager.answers.copy = () => answer;
    assert.equal(reasonOf(await s.boards.call('boardImport', { ...at, board: doc })), 'team_response_invalid');
  }
  s.manager.answers.copy = () => { throw new Error('socket'); };
  assert.equal(reasonOf(await s.boards.call('boardImport', { ...at, board: doc })), 'team_unavailable');
  s.manager.row.state = 'reconnecting';
  assert.equal(reasonOf(await s.boards.call('boardImport', { ...at, board: doc })), 'team_not_connected');
  s.boards.stopAll();
});

test('the http client sends a board picture only to its own route, by its own two calls', async () => {
  const http = createTeamHttp({ port: 9, launchSecret: new Uint8Array(crypto.randomBytes(32)) });
  const refused = (error) => ['team_request_invalid', 'team_path_invalid', 'team_request_too_large'].includes(error.reason);
  const path = `/api/v1/projects/${PROJECT}/boards/${boardId()}/assets/${'a'.repeat(64)}`;
  const picture = png();
  for (const bad of [path.replace('/assets/', '/asset/'), `${path}0`, path.slice(0, -1), path.replace(PROJECT, 'project_../x'),
    `${path}/..`, path.replace('board_', 'board_X')]) {
    await assert.rejects(http.putBoardAsset(bad, picture), refused, bad);
    await assert.rejects(http.getBoardAsset(bad), refused, bad);
  }
  await assert.rejects(http.putBoardAsset(path, Buffer.alloc(0)), refused);
  await assert.rejects(http.putBoardAsset(path, Buffer.alloc(10 * 1024 * 1024 + 1)), refused);
  await assert.rejects(http.putBoardAsset(path, 'text'), refused);
  // No other call reaches the route.
  await assert.rejects(http.request('GET', path), refused);
  await assert.rejects(http.request('PUT', path, { body: {} }), refused);
  await assert.rejects(http.putPart(path, picture), refused);
  await assert.rejects(http.getPart(path), refused);
  await assert.rejects(http.openStream(path), refused);
  await assert.rejects(http.openRequestStream('GET', path), refused);
  // The import route takes one POST of at most 2 MiB, by its own call only.
  const copy = `/api/v1/projects/${PROJECT}/boards/import`;
  for (const bad of [`${copy}/x`, copy.replace(PROJECT, 'project_../x'), copy.replace('/import', '/imports'), path]) {
    await assert.rejects(http.postBoardImport(bad, picture), refused, bad);
  }
  for (const body of [Buffer.alloc(0), Buffer.alloc(2 * 1024 * 1024 + 1), 'text']) await assert.rejects(http.postBoardImport(copy, body), refused);
  await assert.rejects(http.request('POST', copy, { body: {} }), refused);
  await assert.rejects(http.putPart(copy, picture), refused);
  await assert.rejects(http.putBoardAsset(copy, picture), refused);
  await assert.rejects(http.postChatUpload(copy, picture, { type: 'image/png' }), refused);
  await assert.rejects(http.openRequestStream('POST', copy), refused);
  assert.equal(http.openSockets(), 0, 'no socket opened');
  http.dispose();
});

/* ------------------------------------------------------------------ end to end */

test('end to end: a writer edits a team board through the real service and host, and a reader sees it', { timeout: 110_000 }, async (t) => {
  const team = await projectTeam(t);
  const { owner, writer, reader, outsider, teamId, projectId } = team;
  const project = { team_id: teamId, project_id: projectId };
  const pushed = (seat, kind, more = () => true) => seat.boardPushes.find((payload) => payload.kind === kind && more(payload));
  const until = async (check, what) => assert.ok(await waitUntil(check, { attempts: 400, interval: 10 }), what);
  const seat = (one) => one.boardPushes.filter((payload) => payload.kind === 'presence').at(-1);
  // Nothing of the board module exists before the first board call.
  assert.equal(reader.service.boardResources(), null);
  const created = await writer.call('boardCreate', { ...project, name: 'Roadmap' });
  assert.deepEqual([created.ok, created.board.name, created.board.rev], [true, 'Roadmap', 0], JSON.stringify(created));
  const board = { ...project, board_id: created.board.id };
  for (const seat of [owner, writer, reader]) {
    const listed = await seat.call('boardList', project);
    assert.deepEqual(listed.boards.map((row) => [row.id, row.name]), [[created.board.id, 'Roadmap']], seat.name);
  }
  assert.deepEqual(await outsider.call('boardList', project), denied('team_not_found'));
  assert.equal((await outsider.call('boardOpen', board)).ok, false);
  assert.deepEqual(outsider.service.boardResources().boards, 0);
  // Both open the board; the writer adds a note; the reader's Jenny is told, with the batch.
  const [mine, theirs] = [await writer.call('boardOpen', board), await reader.call('boardOpen', board)];
  assert.deepEqual([mine.ok, mine.rev, theirs.ok, theirs.board.id], [true, 0, true, created.board.id]);
  const first = batch(note('ship it'));
  const applied = await writer.call('boardApply', { ...board, batch: first });
  assert.deepEqual([applied.ok, applied.pending], [true, 1], JSON.stringify(applied).slice(0, 300));
  await until(() => pushed(reader, 'applied', (payload) => payload.rev === 1), 'the reader heard the batch');
  const heard = pushed(reader, 'applied');
  assert.deepEqual([heard.team_id, heard.project_id, heard.board_id, heard.own, heard.applied.batch_id],
    [teamId, projectId, created.board.id, false, first.batch_id]);
  await until(() => pushed(writer, 'applied', (payload) => payload.own === true && payload.pending === 0), 'the writer was confirmed');
  const seen = await reader.call('boardOpen', board);
  assert.deepEqual(Object.values(seen.board.cards).map((card) => card.data.text), ['ship it']);
  // Each sees who is viewing; the writer holds the note, and the reader's Jenny is told who holds it.
  const both = [writer.member.member_id, reader.member.member_id].sort();
  for (const seat of [writer, reader]) {
    await until(() => pushed(seat, 'presence', (payload) => payload.viewers.length === 2), `${seat.name} sees both viewers`);
    assert.deepEqual(seat.boardPushes.filter((payload) => payload.kind === 'presence').at(-1).viewers, both);
  }
  const noteId = Object.keys(seen.board.cards)[0];
  assert.deepEqual(await writer.call('boardLock', { ...board, card_id: noteId }), { ok: true });
  await until(() => pushed(reader, 'presence', (payload) => payload.locks.length === 1), 'the reader sees the lock');
  assert.deepEqual(seat(reader).locks, [{ card_id: noteId, member_id: writer.member.member_id }]);
  assert.equal(reasonOf(await reader.call('boardLock', { ...board, card_id: noteId })), 'team_project_read_only');
  // No proposal yet; a reader may read the list and may not decide; only an admin reverts, and not a held note.
  assert.deepEqual(await reader.call('boardProposals', board), { ok: true, proposals: [] });
  assert.equal(reasonOf(await reader.call('boardProposalReject', { ...board, proposal_id: 'p-1' })), 'team_project_read_only');
  assert.equal(reasonOf(await writer.call('boardRevert', { ...board, rev: 1 })), 'role_forbidden');
  const held = await owner.call('boardRevert', { ...board, rev: 1 });
  assert.equal(reasonOf(held), 'team_board_note_locked', JSON.stringify(held));
  assert.deepEqual(await writer.call('boardUnlock', board), { ok: true });
  await until(() => seat(reader).locks.length === 0, 'the reader sees the note released');
  // A picture: the writer sends it through the host's route and the reader fetches the same bytes; a reader sends none.
  const picture = png(4, 3);
  const sent = await writer.call('boardAssetAdd', { ...board, bytes: new Uint8Array(picture) });
  assert.deepEqual(sent, { ok: true, asset: sha(picture), ext: 'png', mime: 'image/png', width: 4, height: 3, bytes: picture.length }, JSON.stringify(sent));
  const fetched = await reader.call('boardAssetRead', { ...board, asset: sent.asset });
  assert.deepEqual([fetched.ok, fetched.mime, Buffer.from(fetched.bytes).equals(picture)], [true, 'image/png', true], JSON.stringify(fetched).slice(0, 200));
  assert.equal(reasonOf(await reader.call('boardAssetAdd', { ...board, bytes: png(5, 5) })), 'team_project_read_only');
  assert.equal(reasonOf(await outsider.call('boardAssetRead', { ...board, asset: sent.asset })), 'team_not_found');
  assert.equal(reasonOf(await reader.call('boardAssetRead', { ...board, asset: 'c'.repeat(64) })), 'team_board_asset_not_found');
  // A turn may name a board of the conversation's project, and no other.
  const made = await writer.call('conversationCreate', project);
  const talk = { team_id: teamId, session_id: made.session.session_id };
  await writer.call('conversationOpen', talk);
  assert.equal(reasonOf(await writer.call('conversationSend', { ...talk, prompt: 'look', board_id: `board_${crypto.randomUUID()}` })), 'team_board_not_found');
  assert.equal((await writer.call('conversationSend', { ...talk, prompt: 'look', board_id: created.board.id })).ok, true);
  // A reader's batch shows at once and is taken back when the host refuses it.
  const tried = await reader.call('boardApply', { ...board, batch: batch(note('mine')) });
  assert.equal(tried.ok, true);
  await until(() => pushed(reader, 'refused'), 'the reader was refused');
  assert.equal(pushed(reader, 'refused').reason, 'team_project_read_only');
  assert.equal(Object.keys((await reader.call('boardOpen', board)).board.cards).length, 1);
  // A rename tells every member who has asked about boards that the list changed.
  assert.equal((await writer.call('boardRename', { ...board, name: 'Plan' })).ok, true);
  await until(() => pushed(reader, 'list_changed'), 'the reader heard the list change');
  assert.deepEqual(pushed(reader, 'list_changed'), { kind: 'list_changed', ...project });
  // A board copied in whole: the writer's own document becomes a new board of the project, every card the writer's.
  const desk = localBoard('From my desk', note('from a desk'));
  const copied = await writer.call('boardImport', { ...project, board: desk });
  assert.deepEqual([copied.ok, copied.board?.name, copied.pictures], [true, 'From my desk', []], JSON.stringify(copied));
  const there = { ...project, board_id: copied.board.id };
  const shown = await reader.call('boardOpen', there);
  assert.deepEqual(Object.values(shown.board.cards).map((card) => [card.data.text, card.created_by, card.id in desk.cards]),
    [['from a desk', writer.member.member_id, false]]);
  assert.deepEqual(await reader.call('boardClose', there), { ok: true });
  assert.equal(reasonOf(await reader.call('boardImport', { ...project, board: desk })), 'team_project_read_only');
  assert.equal(reasonOf(await outsider.call('boardImport', { ...project, board: desk })), 'team_not_found');
  // The owner (a project admin) deletes it: an open client is told it is gone, and the trash lists it.
  assert.equal((await owner.call('boardDelete', board)).ok, true);
  assert.deepEqual((await owner.call('boardTrash', project)).boards.map((row) => row.name), ['Plan']);
  assert.equal(reasonOf(await writer.call('boardTrash', project)), 'role_forbidden');
  assert.deepEqual(await reader.call('boardClose', board), { ok: true });
  assert.equal(reasonOf(await reader.call('boardOpen', board)), 'team_board_not_found');
  for (const seat of [writer, reader]) {
    for (const payload of seat.boardPushes) assert.ok(BOARD_PUSH_KINDS.includes(payload.kind), payload.kind);
  }
});
