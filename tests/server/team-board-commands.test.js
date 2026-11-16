'use strict';

// new-test-file: row 151 slice T2 adds the team.board.* commands and the board snapshot route
// (server/team/boards/board-commands.js, board-routes.js), a new member-facing surface; the store keeps its own
// file (team-board-store.test.js, near the line cap).
//
// The denial matrix, through the real router, authorizer, member store and board store: every operation and the
// route by every role and by people outside the project and the team; forged, foreign and malformed ids; a member
// demoted, removed or revoked while a call waits in the board's queue; limits; retries. Every refusal also shows
// that nothing under team-boards changed.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { BATCH_MAX_BYTES, createTeamBoardCommands } = require('../../server/team/boards/board-commands');
const { createBoardRoutes } = require('../../server/team/boards/board-routes');
const { batch, must, note, tree } = require('./helpers/team-board-kit');
const { createTeamProjectFixture } = require('./helpers/team-project-fixture');

const READ = ['team.board.list', 'team.board.history'];
const WRITE = ['team.board.create', 'team.board.rename', 'team.board.apply'];
const ADMIN = ['team.board.trash', 'team.board.delete', 'team.board.restore'];
const OPERATIONS = [...READ, ...WRITE, ...ADMIN];
const UNKNOWN_BOARD = 'board_00000000-0000-4000-8000-00000000dead';

// What a command is sent with: `p` is { id, live (a board), gone (a board in the trash) }.
const PARAMS = {
  'team.board.list': (p) => ({ project_id: p.id }),
  'team.board.trash': (p) => ({ project_id: p.id }),
  'team.board.history': (p) => ({ project_id: p.id, board_id: p.live }),
  'team.board.create': (p) => ({ project_id: p.id, name: 'Made in the matrix' }),
  'team.board.rename': (p) => ({ project_id: p.id, board_id: p.live, name: 'Renamed in the matrix' }),
  'team.board.apply': (p) => ({ project_id: p.id, board_id: p.live, batch: batch(note('matrix')) }),
  'team.board.delete': (p) => ({ project_id: p.id, board_id: p.live }),
  'team.board.restore': (p) => ({ project_id: p.id, board_id: p.gone }),
};

// Project X: Alice admin, Carl writer, Rae (a read-only team member) reader. Project Y: Bob admin, Carl reader.
// Each has one live board and one in the trash. `root` is the board tree on disk.
async function setup(t, options = {}) {
  const h = await createTeamProjectFixture(t, { boards: true, ...options });
  const id = (who) => h.seats[who].member_id;
  const x = await h.sharedProject('Apollo');
  const y = (await h.ok(h.send('bob', 'team.project.create', { name: 'Zephyr' }), 'create y')).project_id;
  await h.ok(h.send('bob', 'team.project.members.add', { project_id: y, member_id: id('carl'), role: 'reader' }), 'add carl');
  const boards = h.state.boards;
  const seed = async (projectId, admin) => {
    const live = (await must(boards.create({ projectId, actor: admin, name: 'Roadmap' }))).board.id;
    const gone = (await must(boards.create({ projectId, actor: admin, name: 'Old plan' }))).board.id;
    await must(boards.remove({ projectId, boardId: gone, actor: admin }));
    return { id: projectId, live, gone, admin };
  };
  const X = await seed(x, id('alice'));
  const Y = await seed(y, id('bob'));
  // After a call that was let through: the live board is live again and the trashed one is in the trash.
  const settle = async (p) => {
    const live = (await must(boards.list({ projectId: p.id }))).boards.map((board) => board.id);
    if (!live.includes(p.live)) await must(boards.restore({ projectId: p.id, boardId: p.live, actor: p.admin }));
    if (live.includes(p.gone)) await must(boards.remove({ projectId: p.id, boardId: p.gone, actor: p.admin }));
  };
  const root = path.join(fs.realpathSync.native(h.config.userDataPath), 'team-boards');
  // The call's refusal reason, with proof that the disk did not change.
  const refused = async (call, where) => {
    const before = tree(root);
    const answer = await call();
    assert.equal(answer.ok, false, `${where}: ${JSON.stringify(answer).slice(0, 300)}`);
    assert.deepEqual(tree(root), before, `${where} changed the disk`);
    return answer.error.reason;
  };
  return { h, id, X, Y, boards, settle, root, refused };
}

// The seven relations of the matrix: [label, who, project key, the reason per row kind or 'ok'].
const COLUMNS = [
  ['project admin', 'alice', 'X', { read: 'ok', write: 'ok', admin: 'ok' }],
  ['project writer', 'carl', 'X', { read: 'ok', write: 'ok', admin: 'role_forbidden' }],
  ['read-only team member with a reader row', 'rae', 'X', { read: 'ok', write: 'role_forbidden', admin: 'role_forbidden' }],
  ['full member with a reader row', 'carl', 'Y', { read: 'ok', write: 'team_project_read_only', admin: 'role_forbidden' }],
  ['member outside the project', 'bob', 'X', { read: 'team_not_found', write: 'team_not_found', admin: 'team_not_found' }],
  ['owner without a row', 'owner', 'X', { read: 'team_not_found', write: 'team_not_found', admin: 'team_not_found' }],
  ['pending member', 'pia', 'X', { read: 'member_pending', write: 'member_pending', admin: 'member_pending' }],
];
const kindOf = (operation) => (READ.includes(operation) ? 'read' : WRITE.includes(operation) ? 'write' : 'admin');

test('T2 matrix: every board operation by every role, and a refusal leaves the disk as it was', async (t) => {
  const s = await setup(t);
  let cells = 0;
  for (const [label, who, key, want] of COLUMNS) {
    for (const operation of OPERATIONS) {
      const p = s[key];
      const where = `${operation} by ${label}`;
      const expected = want[kindOf(operation)];
      cells += 1;
      if (expected !== 'ok') {
        assert.equal(await s.refused(() => s.h.send(who, operation, PARAMS[operation](p)), where), expected, where);
        continue;
      }
      const answer = await s.h.ok(s.h.send(who, operation, PARAMS[operation](p)), where);
      if (operation === 'team.board.create') assert.equal(answer.board.created_by, s.id(who), where);
      if (operation === 'team.board.apply') assert.deepEqual([answer.applied.actor, answer.duplicate], [s.id(who), false], where);
      if (operation === 'team.board.list') assert.ok(answer.boards.some((board) => board.id === p.live), where);
      if (operation === 'team.board.trash') assert.ok(answer.boards.some((board) => board.id === p.gone), where);
      await s.settle(p);
    }
  }
  assert.equal(cells, COLUMNS.length * OPERATIONS.length);
});

test('T2 matrix: the snapshot route by every role; not found is one answer; the answer is never cached', async (t) => {
  const s = await setup(t);
  for (const [label, who, key, want] of COLUMNS) {
    const p = s[key];
    const before = tree(s.root);
    const got = await s.h.boardRoute(who, p.id, p.live);
    assert.equal(got.handled, true, label);
    if (want.read === 'ok') {
      assert.deepEqual([got.status, got.json.ok, got.json.board.id, got.json.read_only], [200, true, p.live, false], label);
      assert.deepEqual([got.headers['Cache-Control'], got.headers['X-Content-Type-Options']], ['no-store', 'nosniff'], label);
      assert.equal(got.headers['Content-Length'], got.bytes.length, label);
    } else {
      assert.notEqual(got.status, 200, label);
      assert.deepEqual([got.json.ok, got.json.error.reason, 'board' in got.json], [false, want.read, false], label);
    }
    assert.deepEqual(tree(s.root), before, `${label} changed the disk`);
  }
  const reason = async (who, projectId, boardId, options) => {
    const got = await s.h.boardRoute(who, projectId, boardId, options);
    assert.deepEqual([got.handled, got.json.ok, 'board' in got.json], [true, false, false]);
    return got.json.error.reason;
  };
  // Inside a project the caller can read: another project's board, a board in the trash, an unknown or malformed id.
  for (const boardId of [s.Y.live, s.X.gone, UNKNOWN_BOARD, 'board_x', s.X.live.toUpperCase(), '..']) {
    assert.equal(await reason('alice', s.X.id, boardId), 'team_board_not_found', boardId);
  }
  // A project the caller cannot see and one that does not exist answer alike, whatever the board id.
  for (const projectId of [s.Y.id, `project_${'f'.repeat(32)}`, 'nope']) {
    assert.equal(await reason('alice', projectId, s.Y.live), 'team_not_found', projectId);
  }
  // No guard, and a connection that is no longer authorized: refused before any read.
  assert.equal(await reason(null, s.X.id, s.X.live), 'role_forbidden');
  assert.equal(await reason('alice', s.X.id, s.X.live, { authorizedNow: () => false }), 'client_required');
  // Other methods and other paths are not this route's.
  for (const [method, pathname] of [['PUT', `/api/v1/projects/${s.X.id}/boards/${s.X.live}`],
    ['GET', `/api/v1/projects/${s.X.id}/boards`], ['GET', `/api/v1/projects/${s.X.id}/boards/${s.X.live}/assets`]]) {
    const routes = createBoardRoutes({ boards: s.boards });
    assert.equal(await routes({ request: { method }, pathname }), false, `${method} ${pathname}`);
  }
});

test('T2: the owner needs a row like anyone else; a revoked member and an unknown device get nothing', async (t) => {
  const s = await setup(t);
  await s.h.ok(s.h.send('owner', 'team.project.join', { project_id: s.X.id, role: 'writer' }), 'owner joins');
  await s.h.ok(s.h.send('owner', 'team.board.list', PARAMS['team.board.list'](s.X)));
  const made = await s.h.ok(s.h.send('owner', 'team.board.create', PARAMS['team.board.create'](s.X)));
  assert.equal(made.board.created_by, s.id('owner'));
  for (const operation of ADMIN) {
    assert.equal(await s.refused(() => s.h.send('owner', operation, PARAMS[operation](s.X)), operation), 'role_forbidden', operation);
  }
  // A board lives only in an active project of the team: General, a project id the team has no row for and (below)
  // a project being deleted are not found for the owner too, and no folder is made.
  for (const projectId of ['project_general', `project_${crypto.randomUUID()}`]) {
    for (const operation of ['team.board.list', 'team.board.create', 'team.board.trash']) {
      const where = `${operation} by the owner outside a team project`;
      assert.equal(await s.refused(() => s.h.send('owner', operation, PARAMS[operation]({ id: projectId })), where), 'team_not_found', where);
    }
    assert.equal((await s.h.boardRoute('owner', projectId, s.X.live)).json.error.reason, 'team_not_found');
    assert.equal(fs.existsSync(path.join(s.root, projectId)), false);
  }
  s.h.state.remover.removeFail = true;
  assert.equal(await s.h.reason(s.h.send('bob', 'team.project.delete', { project_id: s.Y.id })), 'team_project_store_failed');
  assert.equal(s.h.store.getProject(s.Y.id).state, 'deleting');
  assert.equal(await s.h.reason(s.h.send('owner', 'team.board.list', PARAMS['team.board.list'](s.Y))), 'team_not_found');
  assert.equal((await s.h.boardRoute('owner', s.Y.id, s.Y.live)).json.error.reason, 'team_not_found');
  // Carl is revoked: every operation and the route refuse him, in both projects.
  await s.h.ok(s.h.send('owner', 'team.member.revoke', { member_id: s.id('carl') }), 'revoke');
  for (const p of [s.X, s.Y]) {
    for (const operation of OPERATIONS) {
      assert.equal(await s.refused(() => s.h.send('carl', operation, PARAMS[operation](p)), operation), 'member_revoked', operation);
    }
    const got = await s.h.boardRoute('carl', p.id, p.live);
    assert.deepEqual([got.json.ok, got.json.error.reason, 'board' in got.json], [false, 'member_revoked', false]);
  }
  // A device the team has never seen, claiming Alice's member id.
  const stranger = s.h.clients.register('device_stranger');
  for (const operation of OPERATIONS) {
    const where = `${operation} by a stranger`;
    const reason = await s.refused(() => s.h.core.router.dispatch({ api_version: 1, operation,
      request_id: `request_${crypto.randomUUID()}`, client_id: stranger.client_id, boot_epoch: s.h.core.bootEpoch,
      params: PARAMS[operation](s.X) }, { deviceId: 'device_stranger', clientToken: stranger.client_token,
      isAuthenticated: () => true, actor: { member_id: s.id('alice'), device_id: 'device_stranger' } }), where);
    assert.equal(reason, 'member_revoked', where);
  }
});

test('T2 forged ids: a board is reached only through its own project, and the schema is closed', async (t) => {
  const s = await setup(t);
  const { X, Y } = s;
  const withBoard = ['team.board.rename', 'team.board.apply', 'team.board.delete', 'team.board.restore', 'team.board.history'];
  const body = (operation, projectId, boardId) => ({ ...PARAMS[operation]({ id: projectId, live: boardId, gone: boardId }) });
  // Bob is an admin of Y: Y's project id with X's board ids reaches nothing. Alice likewise from X.
  for (const [who, own, other] of [['bob', Y, X], ['alice', X, Y]]) {
    for (const operation of withBoard) {
      for (const boardId of [other.live, other.gone, UNKNOWN_BOARD]) {
        const where = `${operation} by ${who} on ${boardId}`;
        assert.equal(await s.refused(() => s.h.send(who, operation, body(operation, own.id, boardId)), where),
          'team_board_not_found', where);
      }
    }
    // The other project's id is refused by the one authorization function, whatever the board id.
    for (const operation of OPERATIONS) {
      for (const projectId of [other.id, `project_${'f'.repeat(32)}`]) {
        const where = `${operation} by ${who} in ${projectId}`;
        assert.equal(await s.refused(() => s.h.send(who, operation, body(operation, projectId, own.live)), where),
          'team_not_found', where);
      }
    }
  }
  // Carl writes in X and only reads in Y: X's board named under Y is refused by his role in Y, and X is untouched.
  assert.equal(await s.refused(() => s.h.send('carl', 'team.board.apply', body('team.board.apply', Y.id, X.live)), 'carl'),
    'team_project_read_only');
  // A board in the trash takes no batch and no rename; a live board cannot be restored.
  for (const operation of ['team.board.rename', 'team.board.apply', 'team.board.delete']) {
    assert.equal(await s.refused(() => s.h.send('alice', operation, body(operation, X.id, X.gone)), operation),
      'team_board_not_found', operation);
  }
  assert.equal(await s.refused(() => s.h.send('alice', 'team.board.restore', body('team.board.restore', X.id, X.live)), 'restore'),
    'team_board_not_found');
  // The closed schema: malformed ids, a member named in the params or the batch, unknown fields, bad names.
  const good = PARAMS['team.board.apply'](X);
  const malformed = [
    ['team.board.apply', { ...good, board_id: 'board_x' }], ['team.board.apply', { ...good, board_id: `../${X.live}` }],
    ['team.board.apply', { ...good, board_id: X.live.toUpperCase() }], ['team.board.apply', { ...good, actor: s.id('alice') }],
    ['team.board.apply', { ...good, member_id: s.id('alice') }], ['team.board.apply', { ...good, batch: { ...good.batch, actor: s.id('alice') } }],
    ['team.board.apply', { ...good, batch: { ...good.batch, now: '1999-01-01T00:00:00Z' } }],
    ['team.board.apply', { ...good, batch: { ...good.batch, batch_id: 'has space' } }],
    ['team.board.apply', { ...good, batch: { ...good.batch, ops: 'card.add' } }], ['team.board.apply', { ...good, batch: null }],
    ['team.board.apply', { project_id: X.id, board_id: X.live }], ['team.board.apply', { ...good, project_id: '../x' }],
    ['team.board.create', { project_id: X.id, name: '' }], ['team.board.create', { project_id: X.id, name: 'n'.repeat(201) }],
    ['team.board.create', { project_id: X.id }], ['team.board.create', { project_id: X.id, name: 'Plan', id: UNKNOWN_BOARD }],
    ['team.board.rename', { project_id: X.id, board_id: X.live, name: 7 }], ['team.board.delete', { board_id: X.live }],
    ['team.board.list', { project_id: X.id, board_id: X.live }], ['team.board.list', {}], ['team.board.sync', { project_id: X.id }],
    ['team.board.history', { project_id: X.id }], ['team.board.history', { project_id: X.id, board_id: X.live, after_rev: 0 }],
  ];
  for (const [operation, params] of malformed) {
    const where = `${operation} ${JSON.stringify(params).slice(0, 120)}`;
    assert.equal(await s.refused(() => s.h.send('alice', operation, params), where), 'invalid_command_parameters', where);
  }
  // A name the schema lets through and the board model refuses (two lines), and operations that do not exist.
  assert.equal(await s.refused(() => s.h.send('alice', 'team.board.create', { project_id: X.id, name: 'two\nlines' }), 'name'),
    'team_board_invalid');
  for (const operation of ['team.board.purge', 'team.board.get']) {
    assert.equal(await s.refused(() => s.h.send('alice', operation, { project_id: X.id }), operation), 'invalid_command_envelope', operation);
  }
  // What a member's batch says about its author is not kept: the host writes the caller.
  // A plain add and a `restore` add (the undo of a removal, whose creator the board model would otherwise keep).
  const claim = (text) => ({ ...note(text).card, created_by: s.id('alice'), created_at: '1999-01-01T00:00:00Z' });
  const forged = batch({ op: 'card.add', card: claim('mine') }, { op: 'card.add', restore: true, card: claim('mine too') });
  const applied = await s.h.ok(s.h.send('carl', 'team.board.apply', { project_id: X.id, board_id: X.live, batch: forged }));
  assert.equal(applied.applied.actor, s.id('carl'));
  const now = (await must(s.boards.get({ projectId: X.id, boardId: X.live }))).board.cards;
  for (const op of forged.ops) {
    assert.equal(now[op.card.id].created_by, s.id('carl'), op.card.data.text);
    assert.notEqual(now[op.card.id].created_at, '1999-01-01T00:00:00Z', op.card.data.text);
  }
});

// The store as the commands and the route see it: `seen` lists the calls that reached it; `afterGet`, when set,
// is awaited after a read came back.
function spied(seen, hold) {
  return (store) => ({ ...store, ...Object.fromEntries(['list', 'listDeleted', 'create', 'get', 'apply', 'rename', 'remove', 'restore']
    .map((name) => [name, async (input) => {
      seen.push(name);
      const answer = await store[name](input);
      if (name === 'get' && hold.afterGet) await hold.afterGet;
      return answer;
    }])) });
}
async function until(condition, what) {
  for (let tries = 0; tries < 5000; tries += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('T2: a member demoted, removed or revoked while a call waits in the board\'s queue is not served', async (t) => {
  const seen = [];
  const s = await setup(t, { wrapBoards: spied(seen, {}) });
  const { X } = s;
  const carl = s.id('carl');
  const setRole = (role) => s.h.ok(s.h.send('alice', 'team.project.members.setRole', { project_id: X.id, member_id: carl, role }), role);
  // [what Carl holds first, his call, what changes while it waits, the refusal]
  const cases = [
    ['writer', 'team.board.apply', () => setRole('reader'), 'team_project_read_only'],
    ['writer', 'team.board.rename', () => setRole('reader'), 'team_project_read_only'],
    ['admin', 'team.board.delete', () => setRole('writer'), 'role_forbidden'],
    ['writer', 'team.board.apply', () => s.h.ok(s.h.send('alice', 'team.project.members.remove', { project_id: X.id, member_id: carl })), 'team_not_found'],
    ['writer', 'team.board.apply', () => s.h.ok(s.h.send('owner', 'team.member.revoke', { member_id: carl })), 'member_revoked'],
  ];
  for (const [role, operation, change, want] of cases) {
    const where = `${operation} then ${want}`;
    const held = (await s.h.ok(s.h.send('alice', 'team.project.members.list', { project_id: X.id }))).members
      .some((member) => member.member_id === carl);
    if (held) await setRole(role);
    else await s.h.ok(s.h.send('alice', 'team.project.members.add', { project_id: X.id, member_id: carl, role }), 'add back');
    // Alice's batch holds the board's queue: its own check waits for `release`.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const holder = s.boards.apply({ projectId: X.id, boardId: X.live, actor: s.id('alice'), batch: batch(note('holder')),
      recheck: () => gate.then(() => null) });
    const rev = (await must(s.boards.get({ projectId: X.id, boardId: X.live }))).rev;
    seen.length = 0;
    const waiting = s.h.send('carl', operation, PARAMS[operation](X));
    // The router let Carl through and his call is in the store, behind Alice's.
    await until(() => seen.length === 1, where);
    await change();
    const before = tree(s.root);
    release();
    assert.equal((await must(holder, 'holder')).rev, rev + 1, where);
    const answer = await waiting;
    assert.deepEqual([answer.ok, answer.error?.reason], [false, want], where);
    const now = await must(s.boards.get({ projectId: X.id, boardId: X.live }), where);
    assert.deepEqual([now.rev, now.board.name], [rev + 1, 'Roadmap'], where);
    // Only the holder's batch reached the disk.
    assert.notDeepEqual(tree(s.root), before, where);
    assert.equal(Object.values(now.board.cards).filter((card) => card.data.text === 'matrix').length, 0, where);
  }
});

test('T2: a member removed while the snapshot is read gets the denial, never the board', async (t) => {
  const seen = [];
  const hold = {};
  const s = await setup(t, { wrapBoards: spied(seen, hold) });
  let release;
  hold.afterGet = new Promise((resolve) => { release = resolve; });
  const reading = s.h.boardRoute('carl', s.X.id, s.X.live);
  await until(() => seen.includes('get'), 'the read');
  await s.h.ok(s.h.send('alice', 'team.project.members.remove', { project_id: s.X.id, member_id: s.id('carl') }));
  release();
  const got = await reading;
  assert.notEqual(got.status, 200);
  assert.deepEqual([got.json.ok, got.json.error.reason, 'board' in got.json], [false, 'team_not_found', false]);
  assert.equal(got.bytes.includes('Roadmap'), false);
});

test('T2 limits: a member\'s own rate for batches, list changes and reads, the snapshot rate and the batch size', async (t) => {
  const now = { value: Date.UTC(2026, 10, 15, 9, 0, 0) };
  const s = await setup(t, { clock: () => now.value, boardLimits: {
    commands: { apply: { limit: 2 }, change: { limit: 1 }, read: { limit: 3 } }, route: { limit: 1, windowMs: 60_000, maxKeys: 64 } } });
  const { X } = s;
  const send = (who, operation) => s.h.send(who, operation, PARAMS[operation](X));
  for (const [operation, limit] of [['team.board.apply', 2], ['team.board.rename', 1], ['team.board.list', 3]]) {
    for (let n = 0; n < limit; n += 1) await s.h.ok(send('alice', operation), `${operation} ${n}`);
    assert.equal(await s.refused(() => send('alice', operation), operation), 'team_board_rate_limit', operation);
  }
  // The four list changes share one count; a read of the trash shares the read count.
  assert.equal(await s.refused(() => send('alice', 'team.board.create'), 'create'), 'team_board_rate_limit');
  assert.equal(await s.refused(() => send('alice', 'team.board.delete'), 'delete'), 'team_board_rate_limit');
  assert.equal(await s.refused(() => send('alice', 'team.board.trash'), 'trash'), 'team_board_rate_limit');
  // Another member has their own count, and a refused stranger to the project spends nobody's.
  await s.h.ok(send('carl', 'team.board.apply'), 'carl applies');
  for (let n = 0; n < 5; n += 1) assert.equal(await s.h.reason(send('bob', 'team.board.apply')), 'team_not_found');
  await s.h.ok(send('carl', 'team.board.apply'), 'carl applies again');
  // Nor Bob's own: both of his batches in his own project still go through.
  for (let n = 0; n < 2; n += 1) await s.h.ok(s.h.send('bob', 'team.board.apply', PARAMS['team.board.apply'](s.Y)), `bob ${n}`);
  // The window passes.
  now.value += 60_001;
  await s.h.ok(send('alice', 'team.board.apply'), 'after the window');
  // The snapshot route: one a minute here, each member their own.
  assert.equal((await s.h.boardRoute('alice', X.id, X.live)).status, 200);
  const second = await s.h.boardRoute('alice', X.id, X.live);
  assert.deepEqual([second.json.ok, second.json.error.reason, 'board' in second.json], [false, 'team_board_rate_limit', false]);
  assert.equal((await s.h.boardRoute('rae', X.id, X.live)).status, 200);
  // A batch over 256 KiB is refused before the store sees it.
  now.value += 60_001;
  const big = batch(note('x'.repeat(BATCH_MAX_BYTES)));
  assert.equal(await s.refused(() => s.h.send('alice', 'team.board.apply', { project_id: X.id, board_id: X.live, batch: big }), 'big'),
    'team_board_batch_limit');
});

test('T2 retries: a list change answers an exact retry as it did first; a repeated batch writes nothing; a model refusal keeps its words', async (t) => {
  const s = await setup(t);
  const { X } = s;
  const fixed = { request_id: `request_${crypto.randomUUID()}` };
  const params = { project_id: X.id, name: 'Made once' };
  const first = await s.h.ok(s.h.send('alice', 'team.board.create', params, fixed));
  assert.deepEqual(await s.h.send('alice', 'team.board.create', params, fixed), first);
  const named = (await s.h.ok(s.h.send('alice', 'team.board.list', { project_id: X.id }))).boards.filter((board) => board.name === 'Made once');
  assert.equal(named.length, 1);
  // The same batch twice: the second answers as a duplicate and the disk is as the first left it.
  const sent = batch(note('once'));
  const applied = await s.h.ok(s.h.send('carl', 'team.board.apply', { project_id: X.id, board_id: X.live, batch: sent }));
  assert.deepEqual([applied.rev, applied.duplicate, applied.applied.batch_id], [1, false, sent.batch_id]);
  const before = tree(s.root);
  assert.deepEqual(await s.h.ok(s.h.send('alice', 'team.board.apply', { project_id: X.id, board_id: X.live, batch: sent })),
    { ok: true, rev: 1, applied: null, duplicate: true });
  assert.deepEqual(tree(s.root), before);
  // A stale edit: the store's refusal reaches the member with the model's reason and the failing operation's index.
  const stale = await s.h.send('carl', 'team.board.apply', { project_id: X.id, board_id: X.live,
    batch: batch({ op: 'card.edit', id: sent.ops[0].card.id, content_rev: 7, data: { text: 'late' } }) }, fixed);
  assert.deepEqual([stale.ok, stale.error.reason, stale.error.code, stale.error.request_id, stale.board.reason, stale.board.index],
    [false, 'team_board_refused', 'CMP-HOST-0004', fixed.request_id, 'stale', 0]);
  assert.deepEqual(tree(s.root), before);
  // The log names the operation and the reason, never a board's name or a card's text.
  const log = s.h.logText();
  assert.match(log, /team_board\.command_answered/u);
  for (const secret of ['Made once', 'Roadmap', 'once"', 'late']) assert.equal(log.includes(secret), false, secret);
});

test('T2: the commands refuse a call that arrives without the router\'s check, receipt or a live member', async () => {
  const calls = [];
  const store = Object.fromEntries(['list', 'listDeleted', 'create', 'get', 'apply', 'rename', 'remove', 'restore']
    .map((name) => [name, async (input) => { calls.push(name); return name === 'apply' ? { ok: true, rev: 1, applied: {}, input } : { ok: true, boards: [] }; }]));
  let live = { member_id: 'member_a', state: 'active' };
  const audit = () => ({ ok: true });
  const commands = createTeamBoardCommands({ boards: store, directory: { liveActor: () => live }, sessionProject: () => null, audit });
  const command = (operation) => ({ operation, request_id: 'request_1', params: { project_id: 'project_a', board_id: UNKNOWN_BOARD,
    name: 'n', batch: { batch_id: 'b', ops: [] } } });
  const reason = async (operation, options) => (await commands.dispatch(command(operation), { deviceId: 'device_a' }, options)).error?.reason;
  assert.deepEqual([commands.handles('team.board.apply'), commands.handles('team.board.planted'), commands.handles('toString')], [true, false, false]);
  assert.equal(await reason('team.board.planted', {}), 'unsupported_operation');
  for (const operation of OPERATIONS) {
    assert.equal(await reason(operation, { runReceipt: (_c, _x, run) => run() }), 'role_forbidden', `${operation} without recheck`);
    assert.equal(await reason(operation, undefined), 'role_forbidden', `${operation} without options`);
  }
  for (const operation of ['team.board.create', 'team.board.rename', 'team.board.delete', 'team.board.restore']) {
    assert.equal(await reason(operation, { recheck: () => null }), 'team_board_unavailable', `${operation} without a receipt`);
  }
  for (const gone of [null, { member_id: 'member_a', state: 'pending' }, { member_id: '', state: 'active' }]) {
    live = gone;
    assert.equal(await reason('team.board.list', { recheck: () => null }), 'role_forbidden');
  }
  assert.deepEqual(calls, []);
  // The check the store is handed: the router's verdict first, then "still the same active member".
  live = { member_id: 'member_a', state: 'active' };
  let handed = null;
  store.apply = async (input) => { handed = input; return { ok: true, rev: 1, applied: { batch_id: 'b' }, private: 'kept by the store' }; };
  let verdict = null;
  const answer = await commands.dispatch(command('team.board.apply'), { deviceId: 'device_a' }, { recheck: () => verdict });
  assert.deepEqual(answer, { ok: true, rev: 1, applied: { batch_id: 'b' }, duplicate: false });
  assert.deepEqual([handed.projectId, handed.boardId, handed.actor], ['project_a', UNKNOWN_BOARD, 'member_a']);
  assert.equal(handed.recheck(), null);
  verdict = { ok: false, error: { reason: 'team_not_found' } };
  assert.equal(handed.recheck(), verdict);
  verdict = null;
  for (const other of [{ member_id: 'member_b', state: 'active' }, { member_id: 'member_a', state: 'revoked' }, null]) {
    live = other;
    assert.equal(handed.recheck().error.reason, 'role_forbidden');
  }
  assert.throws(() => createTeamBoardCommands({ directory: { liveActor: () => null }, sessionProject: () => null, audit }), TypeError);
  assert.throws(() => createTeamBoardCommands({ boards: store, sessionProject: () => null, audit }), TypeError);
  assert.throws(() => createTeamBoardCommands({ boards: store, directory: { liveActor: () => null }, audit }), TypeError);
  assert.throws(() => createTeamBoardCommands({ boards: store, directory: { liveActor: () => null }, sessionProject: () => null }), TypeError);
  assert.throws(() => createBoardRoutes({}), TypeError);
});

test('T2: a chat card may point only at a conversation of the board\'s own project (plan 8.7)', async (t) => {
  const seen = [];
  const s = await setup(t, { wrapBoards: spied(seen, {}) });
  const { X, Y } = s;
  const sessions = s.h.backend.sessionStore;
  const session = (title, projectId) => {
    const { id } = sessions.createSession({ title });
    if (projectId) assert.ok(sessions.updateSession(id, { project_id: projectId }));
    return id;
  };
  const [inX, movedLater, inY, general] = [session('In X', X.id), session('Moves', X.id), session('In Y', Y.id), session('General')];
  const chat = (data) => ({ op: 'card.add', card: { id: crypto.randomUUID(), kind: 'chat', x: 0, y: 0, data } });
  const pin = (sessionId) => chat({ session_id: sessionId, title: 'A chat', excerpt: 'what was said' });
  const apply = (who, p, ...ops) => s.h.send(who, 'team.board.apply', { project_id: p.id, board_id: p.live, batch: batch(...ops) });
  const good = pin(inX);
  await s.h.ok(apply('carl', X, note('beside it'), good), 'a conversation of X');
  // Carl can read Y, and still cannot put Y's conversation on X's board. Every outside conversation answers alike.
  const answers = [];
  for (const data of [{ session_id: inY }, { session_id: general }, { session_id: 'session_does_not_exist' }, { session_id: 7 }, {}]) {
    const before = tree(s.root);
    const answer = await apply('carl', X, note('rides along'), chat({ title: 'A chat', excerpt: '', ...data }));
    assert.deepEqual([answer.ok, answer.error?.reason, answer.error?.code], [false, 'team_board_chat_outside_project', 'CMP-HOST-0003'],
      JSON.stringify(data));
    assert.deepEqual(tree(s.root), before, JSON.stringify(data));
    answers.push({ ...answer, error: { ...answer.error, request_id: '' } });
  }
  for (const answer of answers) assert.deepEqual(answer, answers[0]);
  // An edit cannot re-point the card; an edit that names no conversation goes through.
  const rev = (await must(s.boards.get({ projectId: X.id, boardId: X.live }))).board.cards[good.card.id].content_rev;
  const edit = (data) => ({ op: 'card.edit', id: good.card.id, content_rev: rev, data });
  assert.equal(await s.refused(() => apply('carl', X, edit({ session_id: inY })), 're-point'), 'team_board_chat_outside_project');
  await s.h.ok(apply('carl', X, edit({ title: 'Renamed' })), 'a title edit');
  // The rule is the board's project, not the caller: Y's admin pins Y's conversation there and not X's.
  await s.h.ok(apply('bob', Y, pin(inY)), 'a conversation of Y');
  assert.equal(await s.refused(() => apply('bob', Y, pin(inX)), 'bob'), 'team_board_chat_outside_project');
  // A conversation moved out of the project while the batch waits in the queue is refused too.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const holder = s.boards.apply({ projectId: X.id, boardId: X.live, actor: s.id('alice'), batch: batch(note('holder')),
    recheck: () => gate.then(() => null) });
  seen.length = 0;
  const waiting = apply('carl', X, pin(movedLater));
  await until(() => seen.length === 1, 'the queued pin');
  assert.ok(sessions.updateSession(movedLater, { project_id: Y.id }));
  release();
  await must(holder, 'holder');
  assert.equal((await waiting).error?.reason, 'team_board_chat_outside_project');
  const cards = Object.values((await must(s.boards.get({ projectId: X.id, boardId: X.live }))).board.cards);
  assert.deepEqual(cards.filter((card) => card.kind === 'chat').map((card) => card.data.session_id), [inX]);
});
