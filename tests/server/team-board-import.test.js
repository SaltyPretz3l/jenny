'use strict';

// new-test-file: row 151 slice T7 (host part) adds the raw board import route (server/team/boards/board-import-route.js),
// a new member-facing surface, and the store's `content` option that serves it.
//
// The denial matrix, through the real router, authorizer, member store and board store: POST by every role and by
// people outside the project and the team; what an imported board is (new ids, the importer's name on every card,
// no journal); the body rules; hostile files; the chat card rule; a member removed, demoted or revoked while the
// body arrives or while the import waits in the store's queue; limits; logs. Every refusal also shows that nothing
// under team-boards changed.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const model = require('../../services/boards/board-model');
const pkg = require('../../services/boards/board-package');
const { IMPORT_LIMITS, createBoardImportRoute } = require('../../server/team/boards/board-import-route');
const { createTeamBoardHost } = require('../../server/team/boards/team-board-host');
const { must, tree } = require('./helpers/team-board-kit');
const { createTeamProjectFixture } = require('./helpers/team-project-fixture');

const START = Date.UTC(2026, 10, 15, 9, 0, 0);
const ISO = '2026-11-01T08:00:00.000Z';
const SECRET_TEXT = 'the launch date is the ninth';

/* ------------------------------------------------------------------ harness */

const sure = (answer, what) => { assert.equal(answer.ok, true, `${what}: ${JSON.stringify(answer).slice(0, 300)}`); return answer; };

// A .jennyboard text as a desktop writes it: two notes joined by a connector inside a group, written by `author`,
// plus whatever `extra` cards. Answers { text, ids, value } (`value` is the parsed package, for hostile edits).
function boardFile({ name = 'Launch plan', author = 'owner', extra = [] } = {}) {
  const id = `board_${crypto.randomUUID()}`;
  const [a, b, c, g] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const empty = sure(model.createBoard({ id, project_id: 'project_general', name, now: ISO }), 'board').board;
  const ops = [
    { op: 'group.add', group: { id: g, title: 'This week', x: 0, y: 0, w: 600, h: 400 } },
    { op: 'card.add', card: { id: a, kind: 'note', x: 20, y: 20, group_id: g, data: { text: SECRET_TEXT } } },
    { op: 'card.add', card: { id: b, kind: 'note', x: 300, y: 20, data: { text: 'second' } } },
    { op: 'connector.add', connector: { id: c, from: a, to: b, label: 'then' } },
    ...extra.map((card) => ({ op: 'card.add', card: { id: crypto.randomUUID(), x: 0, y: 500, ...card } })),
  ];
  const made = sure(model.applyBatch(empty, { batch_id: 'b-1', board_id: id, actor: author, ops }, { now: ISO }), 'batch').board;
  const text = sure(pkg.pack({ board: made, now: ISO }), 'pack').text;
  return { text, ids: [a, b, c, g], value: JSON.parse(text) };
}

const chatCard = (sessionId) => ({ kind: 'chat', data: { session_id: sessionId, message_id: null, title: 'A chat', excerpt: '' } });

// Project X: Alice admin, Carl writer, Rae (a read-only team member) reader. Project Y: Bob admin, Carl reader.
async function setup(t, { limits, wrapBoards } = {}) {
  const h = await createTeamProjectFixture(t, { boards: true, ...(wrapBoards ? { wrapBoards } : {}) });
  const id = (who) => h.seats[who].member_id;
  const x = await h.sharedProject('Apollo');
  const y = (await h.ok(h.send('bob', 'team.project.create', { name: 'Zephyr' }), 'create y')).project_id;
  await h.ok(h.send('bob', 'team.project.members.add', { project_id: y, member_id: id('carl'), role: 'reader' }), 'add carl');
  const boards = h.state.boards;
  const sessions = h.backend.sessionStore;
  const sessionProject = (sessionId) => sessions.peekSessionSummary(sessionId)?.project_id ?? null;
  const profile = fs.realpathSync.native(h.config.userDataPath);
  const now = { value: START };
  const disk = { ok: true };
  const make = (options = {}) => createBoardImportRoute({ boards: wrapBoards ? wrapBoards(boards) : boards, sessionProject,
    clock: () => now.value, logger: h.fx.logger, canAdmit: () => disk.ok, ...(limits ? { limits } : {}), ...options });
  const routes = make();
  const send = (who, projectId, body, { via = routes, ...options } = {}) => h.fileRoute(who, 'POST',
    `/api/v1/projects/${projectId}/boards/import`, { routes: via, body: Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'), ...options });
  const root = path.join(profile, 'team-boards');
  // A refused request's reason, with proof that the disk did not change.
  const refused = async (call, where) => {
    const before = tree(root);
    const got = await call();
    assert.equal(got.handled, true, where);
    assert.equal(got.json?.ok, false, `${where}: ${got.bytes.toString().slice(0, 200)}`);
    assert.deepEqual(tree(root), before, `${where} changed the disk`);
    return got.json.error.reason;
  };
  const setRole = (who, role, projectId = x) => h.ok(h.send('alice', 'team.project.members.setRole',
    { project_id: projectId, member_id: id(who), role }), role);
  const session = (title, projectId) => {
    const made = sessions.createSession({ title });
    if (projectId) assert.ok(sessions.updateSession(made.id, { project_id: projectId }));
    return made.id;
  };
  const listed = async (projectId) => (await must(boards.list({ projectId }))).boards;
  return { h, id, X: { id: x }, Y: { id: y }, boards, routes, make, now, disk, send, root, refused, profile, setRole, session, listed };
}

async function until(condition, what) {
  for (let tries = 0; tries < 5000; tries += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const COLUMNS = [
  ['project admin', 'alice', 'X', 'ok'],
  ['project writer', 'carl', 'X', 'ok'],
  ['read-only team member with a reader row', 'rae', 'X', 'role_forbidden'],
  ['full member with a reader row', 'carl', 'Y', 'team_project_read_only'],
  ['member outside the project', 'bob', 'X', 'team_not_found'],
  ['owner without a row', 'owner', 'X', 'team_not_found'],
  ['pending member', 'pia', 'X', 'member_pending'],
];

/* ------------------------------------------------------------------ the matrix */

test('T7 import matrix: POST by every role, then no guard, a dead connection and a revoked member', async (t) => {
  const s = await setup(t);
  for (const [label, who, key, want] of COLUMNS) {
    const p = s[key];
    const file = boardFile({ name: `From ${who}`, author: 'someone_else' });
    if (want !== 'ok') {
      assert.equal(await s.refused(() => s.send(who, p.id, file.text), label), want, label);
      continue;
    }
    const got = await s.send(who, p.id, file.text);
    assert.deepEqual([got.status, got.json.ok, got.json.board.name, got.json.board.rev, got.json.board.created_by],
      [200, true, `From ${who}`, 0, s.id(who)], `${label}: ${got.bytes.toString().slice(0, 200)}`);
    assert.deepEqual(Object.keys(got.json).sort(), ['board', 'ok'], label);
    assert.ok((await s.listed(p.id)).some((board) => board.id === got.json.board.id), label);
    // The board as stored: the file's content under new ids, every card the importer's, and no history.
    const stored = (await must(s.boards.get({ projectId: p.id, boardId: got.json.board.id }))).board;
    const cards = Object.values(stored.cards);
    const [con] = Object.values(stored.connectors);
    const [group] = Object.values(stored.groups);
    assert.deepEqual([stored.project_id, stored.rev, stored.recent_batches, cards.length], [p.id, 0, [], 2], label);
    for (const old of file.ids) assert.equal(JSON.stringify(stored).includes(old), false, `${label}: an id from the file`);
    for (const card of cards) {
      assert.deepEqual([card.created_by, card.updated_by, card.geo_rev, card.content_rev], [s.id(who), s.id(who), 0, 0], label);
      assert.notEqual(card.created_at, ISO, label);
    }
    const first = cards.find((card) => card.data.text === SECRET_TEXT);
    assert.deepEqual([first.group_id, con.label, con.from, Object.hasOwn(stored.cards, con.to), group.title],
      [group.id, 'then', first.id, true, 'This week'], label);
    const since = await must(s.boards.since({ projectId: p.id, boardId: stored.id, afterRev: 0 }));
    assert.deepEqual([since.rev, since.batches ?? []], [0, []], label);
    assert.deepEqual((await must(s.boards.readProposals({ projectId: p.id, boardId: stored.id }))).proposals, [], label);
  }
  const file = boardFile();
  assert.equal(await s.refused(() => s.send(null, s.X.id, file.text), 'no guard'), 'role_forbidden');
  assert.equal(await s.refused(() => s.send('alice', s.X.id, file.text, { authorizedNow: () => false }), 'dead'), 'client_required');
  await s.h.ok(s.h.send('owner', 'team.member.revoke', { member_id: s.id('carl') }), 'revoke');
  for (const key of ['X', 'Y']) assert.equal(await s.refused(() => s.send('carl', s[key].id, file.text), 'revoked'), 'member_revoked');
  // Other methods and paths are not this route's; a project id that is no project's answers as an unseen one does.
  for (const [method, pathname] of [['GET', `/api/v1/projects/${s.X.id}/boards/import`], ['PUT', `/api/v1/projects/${s.X.id}/boards/import`],
    ['POST', `/api/v1/projects/${s.X.id}/boards/import/x`], ['POST', `/api/v1/projects/${s.X.id}/boards`]]) {
    assert.equal(await s.routes({ request: { method }, pathname }), false, `${method} ${pathname}`);
  }
  for (const projectId of ['project_unknown', '..', 'project_general']) {
    assert.equal(await s.refused(() => s.send('alice', projectId, file.text), projectId), 'team_not_found', projectId);
  }
});

/* ------------------------------------------------------------------ the body */

test('T7 import body rules: the length header, the cap before the body, a short body, text that is not a board file', async (t) => {
  const s = await setup(t, { limits: { bodyBytes: 8192 } });
  const { X } = s;
  const file = boardFile();
  const post = (options, where, body = file.text) => s.refused(() => s.send('alice', X.id, body, options), where);
  assert.equal(await post({ length: null }, 'no length'), 'team_board_import_invalid');
  assert.equal(await post({ length: 0 }, 'zero', ''), 'team_board_import_invalid');
  for (const length of ['abc', '-1', '01', '1e3', ' 12']) assert.equal(await post({ length }, `length ${length}`), 'team_board_import_invalid');
  // Over the cap: refused before a byte is read; drained when small, not read at all when large.
  const drained = await s.send('alice', X.id, Buffer.alloc(9000, 0x20));
  assert.deepEqual([drained.json.error.reason, drained.flowing], ['team_board_import_size_limit', true]);
  const before = tree(s.root);
  const stopped = await s.send('alice', X.id, Buffer.alloc(20000, 0x20));
  assert.deepEqual([stopped.json.error.reason, stopped.answeredBeforeEnd, stopped.flowing, stopped.headers.Connection],
    ['team_board_import_size_limit', true, false, 'close']);
  assert.deepEqual(tree(s.root), before);
  s.now.value += 60_001;
  assert.equal(await post({ length: Buffer.byteLength(file.text) + 5 }, 'short body'), 'team_board_import_size_limit');
  // Not UTF-8, not JSON, not a board file, a newer file, an unknown key, a picture aboard.
  const edited = (change) => { const value = structuredClone(file.value); change(value); return JSON.stringify(value); };
  const bad = [
    [Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), 'team_board_import_invalid', 'not UTF-8'],
    ['{"format":', 'team_board_import_invalid', 'not JSON'],
    ['[]', 'team_board_import_invalid', 'an array'],
    [edited((v) => { v.format = 'other'; }), 'team_board_import_invalid', 'another format'],
    [edited((v) => { v.version = 2; }), 'team_board_import_version', 'a newer file'],
    [edited((v) => { v.journal = []; }), 'team_board_import_invalid', 'an unknown top key'],
    [edited((v) => { v.board.proposals = []; }), 'team_board_import_invalid', 'an unknown board key'],
    [edited((v) => { v.board.rev = 9; }), 'team_board_import_invalid', 'a rev'],
    [edited((v) => { v.board.name = ''; }), 'team_board_import_invalid', 'no name'],
    [edited((v) => { v.assets = [{ ext: 'png', base64: 'AAAA' }]; }), 'team_board_import_invalid', 'a picture'],
    [edited((v) => { Object.values(v.board.cards)[0].kind = 'script'; }), 'team_board_import_invalid', 'an unknown card kind'],
    [edited((v) => { Object.values(v.board.connectors)[0].to = crypto.randomUUID(); }), 'team_board_import_invalid', 'a loose connector'],
  ];
  for (const [body, want, where] of bad) {
    s.now.value += 60_001; // each of these spends one of the member's ten imports a minute
    assert.equal(await post({}, where, body), want, where);
  }
  assert.equal((await s.listed(X.id)).length, 0);
  assert.equal((await s.send('alice', X.id, file.text)).status, 200, 'the file itself is taken');
  assert.throws(() => s.make({ limits: { bodyBytes: IMPORT_LIMITS.bodyBytes + 1 } }), RangeError);
  assert.throws(() => s.make({ limits: { uploads: 1 } }), RangeError);
  assert.throws(() => createBoardImportRoute({ sessionProject: () => null }), TypeError);
  assert.throws(() => createBoardImportRoute({ boards: s.boards }), TypeError);
});

test('T7 import: a chat card must name a conversation of the project; the board cap; nothing written on a refusal', async (t) => {
  const s = await setup(t);
  const { X, Y } = s;
  const [inX, inY, general] = [s.session('In X', X.id), s.session('In Y', Y.id), s.session('General')];
  const good = await s.send('carl', X.id, boardFile({ extra: [chatCard(inX)] }).text);
  assert.equal(good.status, 200, good.bytes.toString().slice(0, 200));
  const stored = (await must(s.boards.get({ projectId: X.id, boardId: good.json.board.id }))).board;
  assert.equal(Object.values(stored.cards).find((card) => card.kind === 'chat').data.session_id, inX);
  for (const sessionId of [inY, general, 'session_does_not_exist']) {
    const file = boardFile({ extra: [chatCard(sessionId)] });
    assert.equal(await s.refused(() => s.send('carl', X.id, file.text), sessionId), 'team_board_chat_outside_project', sessionId);
  }
  // The rule is the board's project: Y's conversation goes on Y's board.
  assert.equal((await s.send('bob', Y.id, boardFile({ extra: [chatCard(inY)] }).text)).status, 200);
  // The project's cap of live boards holds here as it does for a create.
  s.now.value += 60_001;
  const routes = s.make({ limits: {} });
  for (let n = (await s.listed(X.id)).length; n < model.LIMITS.boards_per_project; n += 1) {
    await must(s.boards.create({ projectId: X.id, actor: s.id('alice'), name: `Board ${n}` }));
  }
  assert.equal(await s.refused(() => s.send('alice', X.id, boardFile().text, { via: routes }), 'the cap'), 'team_board_limit');
});

/* ------------------------------------------------------------------ while it is in flight */

test('T7 import: a member removed, demoted or revoked while the body arrives or while the import waits is refused', async (t) => {
  const creates = [];
  const s = await setup(t, { wrapBoards: (store) => ({ ...store, create: (args) => { creates.push(args.actor); return store.create(args); } }) });
  const { X } = s;
  const carl = s.id('carl');
  const cases = [
    ['removed', () => s.h.ok(s.h.send('alice', 'team.project.members.remove', { project_id: X.id, member_id: carl })), 'team_not_found',
      () => s.h.ok(s.h.send('alice', 'team.project.members.add', { project_id: X.id, member_id: carl, role: 'writer' }))],
    ['demoted', () => s.setRole('carl', 'reader'), 'team_project_read_only', () => s.setRole('carl', 'writer')],
  ];
  for (const [what, change, want, undo] of cases) {
    assert.equal(await s.refused(() => s.send('carl', X.id, boardFile().text, { during: change }), what), want, what);
    assert.deepEqual(creates, [], `${what}: nothing reached the store`);
    await undo();
  }
  // Demoted while the import waits in the project's queue behind another create: the check inside the queue refuses.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const holder = s.boards.create({ projectId: X.id, actor: s.id('alice'), name: 'Holder', recheck: () => gate.then(() => null) });
  const waiting = s.send('carl', X.id, boardFile({ name: 'Queued' }).text);
  await until(() => creates.length === 1, 'the queued import');
  await s.setRole('carl', 'reader');
  release();
  await must(holder, 'holder');
  const got = await waiting;
  assert.deepEqual([got.json.ok, got.json.error.reason], [false, 'team_project_read_only']);
  assert.deepEqual((await s.listed(X.id)).map((board) => board.name), ['Holder']);
  await s.setRole('carl', 'writer');
  creates.length = 0;
  assert.equal(await s.refused(() => s.send('carl', X.id, boardFile().text, { during: () => s.h.ok(s.h.send('owner',
    'team.member.revoke', { member_id: carl })) }), 'revoked'), 'member_revoked');
  assert.deepEqual(creates, [], 'revoked: nothing reached the store');
});

test('T7 import limits: a member\'s own rate, one import in flight, the disk gate; logs hold no text of the board', async (t) => {
  const s = await setup(t, { limits: { imports: 2 } });
  const { X } = s;
  for (const name of ['One', 'Two']) assert.equal((await s.send('alice', X.id, boardFile({ name }).text)).status, 200);
  assert.equal(await s.refused(() => s.send('alice', X.id, boardFile().text), 'third'), 'team_board_rate_limit');
  assert.equal((await s.send('carl', X.id, boardFile({ name: 'Carl has his own count' }).text)).status, 200);
  s.now.value += 60_001;
  assert.equal((await s.send('alice', X.id, boardFile({ name: 'After the window' }).text)).status, 200);
  // A second import while the same member's first body is still arriving.
  const routes = s.make({ limits: {} });
  let second = null;
  const first = await s.send('alice', X.id, boardFile({ name: 'Held' }).text, { via: routes, during: async () => {
    second = await s.send('alice', X.id, boardFile({ name: 'Second' }).text, { via: routes });
  } });
  assert.equal(first.status, 200);
  assert.deepEqual([second.json.error.reason, second.json.error.retryable], ['team_board_upload_limit', true]);
  assert.equal((await s.listed(X.id)).some((board) => board.name === 'Second'), false);
  s.disk.ok = false;
  assert.equal(await s.refused(() => s.send('alice', X.id, boardFile().text, { via: routes }), 'disk'), 'disk_pressure');
  const log = s.h.logText();
  assert.match(log, /team_board_import\.route_refused/u);
  for (const secret of [SECRET_TEXT, 'Launch plan', 'This week', s.profile, s.profile.replaceAll('\\', '\\\\')]) {
    assert.equal(log.includes(secret), false, secret);
  }
});

/* ------------------------------------------------------------------ the store's option and the host's chain */

test('T7 store: `content` gives create its first board, and only a board of that id, that project and rev 0', async (t) => {
  const s = await setup(t);
  const { X } = s;
  const actor = s.id('alice');
  const create = (content) => s.boards.create({ projectId: X.id, actor, content });
  const framed = ({ boardId, now }, change = (board) => board) => ({ ok: true,
    board: change(sure(model.createBoard({ id: boardId, project_id: X.id, name: 'Made whole', now }), 'board').board) });
  const made = await must(create((frame) => framed(frame)));
  assert.deepEqual([made.board.name, made.board.created_by, made.board.rev], ['Made whole', actor, 0]);
  const cases = [
    [(frame) => framed(frame, (board) => ({ ...board, id: `board_${crypto.randomUUID()}` })), 'team_board_invalid', 'another id'],
    [(frame) => framed(frame, (board) => ({ ...board, project_id: 'project_elsewhere' })), 'team_board_invalid', 'another project'],
    [(frame) => framed(frame, (board) => ({ ...board, rev: 3 })), 'team_board_invalid', 'a rev'],
    [(frame) => framed(frame, (board) => ({ ...board, recent_batches: ['b-1'] })), 'team_board_invalid', 'a batch'],
    [(frame) => framed(frame, (board) => ({ ...board, extra: true })), 'team_board_invalid', 'an unknown key'],
    [() => ({ ok: true }), 'team_board_invalid', 'no board'],
    [() => ({ ok: false, error: { reason: 'the_callers_own' } }), 'the_callers_own', 'a failure of its own'],
    [() => { throw new Error('x'); }, 'team_board_unavailable', 'a throw'],
    [() => null, 'team_board_unavailable', 'nothing'],
    [() => ({ ok: 1, board: {} }), 'team_board_unavailable', 'not a verdict'],
  ];
  for (const [content, want, where] of cases) {
    const before = tree(s.root);
    assert.equal((await create(content)).error?.reason, want, where);
    assert.deepEqual(tree(s.root), before, where);
  }
  assert.equal((await s.boards.create({ projectId: X.id, actor, content: 'text' })).error?.reason, 'team_board_invalid');
  assert.equal((await s.listed(X.id)).length, 1);
});

test('T7 wiring: the board host serves the import on its one chain, and the list change reaches the project', async (t) => {
  const h = await createTeamProjectFixture(t);
  const x = await h.sharedProject('Apollo');
  const told = [];
  const host = createTeamBoardHost({ userDataPath: fs.realpathSync.native(h.config.userDataPath), directory: h.store.directory,
    sessionProject: () => null, publish: (type, payload) => { told.push([type, payload?.project_id]); }, clock: () => START,
    logger: h.fx.logger, audit: () => ({ ok: true }), statfs: () => ({ bavail: 1e9, bsize: 4096, blocks: 2e9 }) });
  const url = `/api/v1/projects/${x}/boards/import`;
  const got = await h.fileRoute('carl', 'POST', url, { routes: host.routes, body: Buffer.from(boardFile().text, 'utf8') });
  assert.deepEqual([got.status, got.json.board.name], [200, 'Launch plan'], got.bytes.toString().slice(0, 200));
  const snapshot = await h.fileRoute('rae', 'GET', `/api/v1/projects/${x}/boards/${got.json.board.id}`, { routes: host.routes });
  assert.deepEqual([snapshot.status, Object.keys(snapshot.json.board.cards).length], [200, 2]);
  assert.ok(told.some(([type, projectId]) => /list/u.test(type) && projectId === x), JSON.stringify(told));
  const chat = await h.fileRoute('carl', 'POST', url, { routes: host.routes,
    body: Buffer.from(boardFile({ extra: [chatCard('session_private')] }).text, 'utf8') });
  assert.equal(chat.json.error.reason, 'team_board_chat_outside_project');
});
