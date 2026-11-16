'use strict';

// new-test-file: row 151 slice T6 adds the raw board picture routes (server/team/boards/board-asset-routes.js), a new
// member-facing surface; the store keeps its own file (team-board-assets.test.js).
//
// The denial matrix, through the real router, authorizer, member store and board store: PUT and GET by every role
// and by people outside the project and the team; forged, foreign and malformed ids; the exact download headers; the
// body rules; a member removed, demoted or revoked while the body is half sent or while a read is awaited; limits;
// logs. Every refusal also shows that nothing under team-boards changed.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { downloadDisposition } = require('../../server/download-headers');
const { createBoardAssetRoutes } = require('../../server/team/boards/board-asset-routes');
const { createTeamBoardAssets } = require('../../server/team/boards/board-host-assets');
const { createTeamBoardHost } = require('../../server/team/boards/team-board-host');
const { must, tree } = require('./helpers/team-board-kit');
const { gif, jpeg, png, sha, webp } = require('./helpers/team-board-pictures');
const { createTeamProjectFixture } = require('./helpers/team-project-fixture');

const UNKNOWN_BOARD = 'board_00000000-0000-4000-8000-00000000dead';
const START = Date.UTC(2026, 10, 15, 9, 0, 0);

/* ------------------------------------------------------------------ harness */

// Project X: Alice admin, Carl writer, Rae (a read-only team member) reader. Project Y: Bob admin, Carl reader.
// Each has one live board and one in the trash. `routes(options)` builds another route set on the same stores.
async function setup(t, { limits, wrapAssets = (value) => value } = {}) {
  const h = await createTeamProjectFixture(t, { boards: true });
  const id = (who) => h.seats[who].member_id;
  const x = await h.sharedProject('Apollo');
  const y = (await h.ok(h.send('bob', 'team.project.create', { name: 'Zephyr' }), 'create y')).project_id;
  await h.ok(h.send('bob', 'team.project.members.add', { project_id: y, member_id: id('carl'), role: 'reader' }), 'add carl');
  const boards = h.state.boards;
  const seed = async (projectId, admin) => {
    const live = (await must(boards.create({ projectId, actor: admin, name: 'Roadmap' }))).board.id;
    const gone = (await must(boards.create({ projectId, actor: admin, name: 'Old plan' }))).board.id;
    await must(boards.remove({ projectId, boardId: gone, actor: admin }));
    return { id: projectId, live, gone };
  };
  const X = await seed(x, id('alice'));
  const Y = await seed(y, id('bob'));
  const profile = fs.realpathSync.native(h.config.userDataPath);
  const assets = createTeamBoardAssets({ userDataPath: profile, logger: h.fx.logger,
    refs: (projectId, use) => boards.assetRefs({ projectId, use }) });
  const now = { value: START };
  const disk = { ok: true };
  const make = (options = {}) => createBoardAssetRoutes({ boards, assets: wrapAssets(assets), clock: () => now.value,
    logger: h.fx.logger, canAdmit: () => disk.ok, ...(limits ? { limits } : {}), ...options });
  const routes = make();
  const url = (projectId, boardId, hash) => `/api/v1/projects/${projectId}/boards/${boardId}/assets/${hash}`;
  const putPic = (who, projectId, boardId, bytes, { hash = sha(bytes), via = routes, ...options } = {}) => h.fileRoute(who, 'PUT',
    url(projectId, boardId, hash), { routes: via, body: bytes, ...options });
  const getPic = (who, projectId, boardId, hash, { via = routes, ...options } = {}) => h.fileRoute(who, 'GET',
    url(projectId, boardId, hash), { routes: via, ...options });
  const root = path.join(profile, 'team-boards');
  // A refused request's reason, with proof that the disk did not change and no picture went out.
  const refused = async (call, where) => {
    const before = tree(root);
    const got = await call();
    assert.equal(got.handled, true, where);
    assert.deepEqual([got.json?.ok, got.headers['Content-Disposition']], [false, undefined], `${where}: ${got.bytes.toString().slice(0, 200)}`);
    assert.deepEqual(tree(root), before, `${where} changed the disk`);
    return got.json.error.reason;
  };
  const setRole = (who, role, projectId = X.id) => h.ok(h.send('alice', 'team.project.members.setRole',
    { project_id: projectId, member_id: id(who), role }), role);
  return { h, id, X, Y, assets, routes, make, now, disk, url, putPic, getPic, root, refused, profile, setRole };
}

async function until(condition, what) {
  for (let tries = 0; tries < 5000; tries += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const COLUMNS = [
  ['project admin', 'alice', 'X', 'ok', 'ok'],
  ['project writer', 'carl', 'X', 'ok', 'ok'],
  ['read-only team member with a reader row', 'rae', 'X', 'role_forbidden', 'ok'],
  ['full member with a reader row', 'carl', 'Y', 'team_project_read_only', 'ok'],
  ['member outside the project', 'bob', 'X', 'team_not_found', 'team_not_found'],
  ['owner without a row', 'owner', 'X', 'team_not_found', 'team_not_found'],
  ['pending member', 'pia', 'X', 'member_pending', 'member_pending'],
];

/* ------------------------------------------------------------------ the matrix */

test('T6 matrix: PUT and GET by every role, then a revoked member and no guard; a refusal leaves the disk as it was', async (t) => {
  const s = await setup(t);
  const seeded = { X: png(1, 9), Y: png(2, 9) };
  await must(s.assets.put({ projectId: s.X.id, hash: sha(seeded.X), bytes: seeded.X }));
  await must(s.assets.put({ projectId: s.Y.id, hash: sha(seeded.Y), bytes: seeded.Y }));
  let n = 0;
  for (const [label, who, key, wantPut, wantGet] of COLUMNS) {
    const p = s[key];
    n += 1;
    const bytes = png(10 + n, 1);
    if (wantPut === 'ok') {
      const got = await s.putPic(who, p.id, p.live, bytes);
      assert.deepEqual([got.status, got.json], [200, { ok: true, asset: sha(bytes), type: 'image/png', width: 10 + n, height: 1,
        bytes: bytes.length, stored: true }], label);
      assert.ok(fs.existsSync(path.join(s.root, p.id, 'assets', `${sha(bytes)}.png`)), label);
    } else {
      assert.equal(await s.refused(() => s.putPic(who, p.id, p.live, bytes), `PUT by ${label}`), wantPut, `PUT by ${label}`);
    }
    if (wantGet === 'ok') {
      const got = await s.getPic(who, p.id, p.live, sha(seeded[key]));
      assert.deepEqual([got.status, Buffer.compare(got.bytes, seeded[key])], [200, 0], `GET by ${label}`);
    } else {
      assert.equal(await s.refused(() => s.getPic(who, p.id, p.live, sha(seeded[key])), `GET by ${label}`), wantGet, `GET by ${label}`);
    }
  }
  // No guard at all, and a connection that is no longer authorized.
  assert.equal(await s.refused(() => s.putPic(null, s.X.id, s.X.live, png(3, 9)), 'PUT without a guard'), 'role_forbidden');
  assert.equal(await s.refused(() => s.getPic(null, s.X.id, s.X.live, sha(seeded.X)), 'GET without a guard'), 'role_forbidden');
  assert.equal(await s.refused(() => s.putPic('alice', s.X.id, s.X.live, png(4, 9), { authorizedNow: () => false }), 'PUT'), 'client_required');
  assert.equal(await s.refused(() => s.getPic('alice', s.X.id, s.X.live, sha(seeded.X), { authorizedNow: () => false }), 'GET'), 'client_required');
  // Carl is revoked: both routes refuse him in both projects.
  await s.h.ok(s.h.send('owner', 'team.member.revoke', { member_id: s.id('carl') }), 'revoke');
  for (const key of ['X', 'Y']) {
    assert.equal(await s.refused(() => s.putPic('carl', s[key].id, s[key].live, png(5, 9)), 'PUT revoked'), 'member_revoked');
    assert.equal(await s.refused(() => s.getPic('carl', s[key].id, s[key].live, sha(seeded[key])), 'GET revoked'), 'member_revoked');
  }
  // Other methods and paths are not these routes'.
  const hash = sha(seeded.X);
  for (const [method, pathname] of [['POST', s.url(s.X.id, s.X.live, hash)], ['DELETE', s.url(s.X.id, s.X.live, hash)],
    ['HEAD', s.url(s.X.id, s.X.live, hash)], ['GET', `/api/v1/projects/${s.X.id}/boards/${s.X.live}/assets`],
    ['GET', `/api/v1/projects/${s.X.id}/boards/${s.X.live}`], ['PUT', `${s.url(s.X.id, s.X.live, hash)}/x`]]) {
    assert.equal(await s.routes({ request: { method }, pathname }), false, `${method} ${pathname}`);
  }
  assert.throws(() => createBoardAssetRoutes({ boards: s.h.state.boards }), TypeError);
  assert.throws(() => createBoardAssetRoutes({ assets: s.assets }), TypeError);
});

test('T6 forged ids: a picture is reached only through a live board of its own project', async (t) => {
  const s = await setup(t);
  const { X, Y } = s;
  const inY = png(6, 1);
  assert.equal((await s.putPic('bob', Y.id, Y.live, inY)).status, 200);
  const pic = png(7, 1);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  // Inside X, which Alice can see: another project's board, a board in the trash, unknown and malformed boards.
  for (const boardId of [Y.live, X.gone, UNKNOWN_BOARD, 'board_x', X.live.toUpperCase(), '..']) {
    assert.equal(await s.refused(() => s.putPic('alice', X.id, boardId, pic), `PUT on ${boardId}`), 'team_board_not_found');
    assert.equal(await s.refused(() => s.getPic('alice', X.id, boardId, sha(inY)), `GET on ${boardId}`), 'team_board_not_found');
  }
  // A malformed hash: invalid on upload, not found on download.
  for (const hash of [sha(pic).toUpperCase(), sha(pic).slice(2), `${sha(svg).slice(4)}.png`, `${sha(svg)}.png`]) {
    assert.equal(await s.refused(() => s.putPic('alice', X.id, X.live, pic, { hash }), `PUT ${hash}`), 'team_board_asset_invalid');
    assert.equal(await s.refused(() => s.getPic('alice', X.id, X.live, hash), `GET ${hash}`), 'team_board_not_found');
  }
  // Another project's id, with this project's board: the guard's one answer.
  for (const projectId of [Y.id, `project_${'f'.repeat(32)}`, 'nope']) {
    assert.equal(await s.refused(() => s.putPic('alice', projectId, X.live, pic), `PUT in ${projectId}`), 'team_not_found');
    assert.equal(await s.refused(() => s.getPic('alice', projectId, X.live, sha(inY)), `GET in ${projectId}`), 'team_not_found');
  }
  // Carl reads Y and writes X: Y's picture is not found under X, and found under Y.
  assert.equal(await s.refused(() => s.getPic('carl', X.id, X.live, sha(inY)), 'Y picture under X'), 'team_board_asset_not_found');
  assert.equal(await s.refused(() => s.getPic('carl', X.id, X.live, sha(pic)), 'never stored'), 'team_board_asset_not_found');
  assert.equal((await s.getPic('carl', Y.id, Y.live, sha(inY))).status, 200);
  // Carl uploads Y's picture under X: a copy of X's own, Y's untouched.
  assert.equal((await s.putPic('carl', X.id, X.live, inY)).json.stored, true);
  assert.ok(fs.existsSync(path.join(s.root, Y.id, 'assets', `${sha(inY)}.png`)));
});

test('T6: a download carries exactly five headers and the type its bytes say; a refusal carries no picture', async (t) => {
  const s = await setup(t);
  const { X } = s;
  for (const [bytes, ext, type] of [[png(12, 3), 'png', 'image/png'], [jpeg(8, 6), 'jpg', 'image/jpeg'],
    [webp(9, 4), 'webp', 'image/webp'], [gif(5, 5), 'gif', 'image/gif']]) {
    const hash = sha(bytes);
    const stored = await s.putPic('carl', X.id, X.live, bytes);
    assert.deepEqual([stored.status, stored.json.type, stored.json.stored], [200, type, true], ext);
    const got = await s.getPic('rae', X.id, X.live, hash);
    assert.equal(got.status, 200, ext);
    assert.deepEqual(got.headers, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Disposition': downloadDisposition(`${hash}.${ext}`) }, ext);
    assert.equal(Buffer.compare(got.bytes, bytes), 0, ext);
    const denied = await s.getPic('bob', X.id, X.live, hash);
    assert.deepEqual([denied.json.ok, denied.bytes.includes(bytes), 'Content-Disposition' in denied.headers], [false, false, false], ext);
    // The same picture again answers stored: false and writes nothing.
    const before = tree(s.root);
    assert.equal((await s.putPic('alice', X.id, X.live, bytes)).json.stored, false, ext);
    assert.deepEqual(tree(s.root), before, ext);
  }
});

test('T6 body rules: the length header, the cap before the body, a short body, a wrong hash, an SVG', async (t) => {
  const s = await setup(t, { limits: { pictureBytes: 4096 } });
  const { X } = s;
  const pic = png(3, 3);
  const put = (options, where, bytes = pic) => s.refused(() => s.putPic('alice', X.id, X.live, bytes, options), where);
  assert.equal(await put({ length: null }, 'no length'), 'team_board_asset_invalid');
  assert.equal(await put({ length: 0 }, 'zero', Buffer.alloc(0)), 'team_board_asset_invalid');
  for (const length of ['abc', '-1', '01', '1e3', ' 12']) {
    assert.equal(await put({ length }, `length ${length}`), 'team_board_asset_invalid');
  }
  // Over the cap: refused before a byte is read; drained when small, not read at all when large.
  const over = png(1, 1, Buffer.alloc(5000));
  const drained = await s.putPic('alice', X.id, X.live, over);
  assert.deepEqual([drained.json.error.reason, drained.flowing], ['team_board_asset_size_limit', true]);
  const huge = png(1, 1, Buffer.alloc(9000));
  const before = tree(s.root);
  const stopped = await s.putPic('alice', X.id, X.live, huge);
  assert.deepEqual([stopped.json.error.reason, stopped.answeredBeforeEnd, stopped.flowing], ['team_board_asset_size_limit', true, false]);
  assert.equal(stopped.headers.Connection, 'close');
  assert.deepEqual(tree(s.root), before, 'nothing of the body reached the store');
  // A body shorter than it declared.
  assert.equal(await put({ length: pic.length + 5 }, 'short body'), 'team_board_asset_size_limit');
  // A hash that is not the bytes', and an SVG under its own hash.
  assert.equal(await put({ hash: sha(png(4, 4)) }, 'mismatch'), 'team_board_asset_mismatch');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
  assert.equal(await put({}, 'svg', svg), 'team_board_asset_unsupported');
  // Exactly at the cap is taken.
  const atCap = png(1, 1, Buffer.alloc(4096 - png(1, 1).length));
  assert.equal((await s.putPic('alice', X.id, X.live, atCap)).json.bytes, 4096);
});

test('T6: a member removed, demoted or revoked while the body arrives, or while a read is awaited, gets nothing', async (t) => {
  const puts = [];
  const hold = { read: null, entered: false, afterPut: null };
  const s = await setup(t, { wrapAssets: (store) => ({ ...store,
    put: async (args) => {
      puts.push(args.hash);
      const answer = await store.put(args);
      if (hold.afterPut) await hold.afterPut();
      return answer;
    },
    read: async (args) => {
      const answer = await store.read(args);
      hold.entered = true;
      if (hold.read) await hold.read;
      return answer;
    } }) });
  const { X } = s;
  const carl = s.id('carl');
  const cases = [
    ['removed', () => s.h.ok(s.h.send('alice', 'team.project.members.remove', { project_id: X.id, member_id: carl })), 'team_not_found',
      () => s.h.ok(s.h.send('alice', 'team.project.members.add', { project_id: X.id, member_id: carl, role: 'writer' }))],
    ['demoted', () => s.setRole('carl', 'reader'), 'team_project_read_only', () => s.setRole('carl', 'writer')],
  ];
  let n = 0;
  for (const [what, change, want, undo] of cases) {
    n += 1;
    const bytes = png(20 + n, 2);
    assert.equal(await s.refused(() => s.putPic('carl', X.id, X.live, bytes, { during: change }), what), want, what);
    assert.deepEqual(puts, [], `${what}: nothing reached the store`);
    await undo();
  }
  // A read held after the store answered: Carl is removed before a byte goes out.
  const stored = png(30, 2);
  assert.equal((await s.putPic('alice', X.id, X.live, stored)).status, 200);
  puts.length = 0;
  let release;
  hold.read = new Promise((resolve) => { release = resolve; });
  const reading = s.getPic('carl', X.id, X.live, sha(stored));
  await until(() => hold.entered, 'the read');
  await s.h.ok(s.h.send('alice', 'team.project.members.remove', { project_id: X.id, member_id: carl }));
  release();
  const got = await reading;
  assert.deepEqual([got.json.ok, got.json.error.reason, got.bytes.includes(stored)], [false, 'team_not_found', false]);
  hold.read = null;
  await s.h.ok(s.h.send('alice', 'team.project.members.add', { project_id: X.id, member_id: carl, role: 'writer' }));
  // Demoted while the picture was being written: refused, and the picture just stored is taken away again.
  const late = png(45, 2);
  hold.afterPut = () => s.setRole('carl', 'reader');
  assert.equal(await s.refused(() => s.putPic('carl', X.id, X.live, late), 'demoted after the write'), 'team_project_read_only');
  assert.deepEqual(puts, [sha(late)], 'the picture had reached the store');
  assert.equal(fs.existsSync(path.join(s.root, X.id, 'assets', `${sha(late)}.png`)), false);
  hold.afterPut = null;
  puts.length = 0;
  await s.setRole('carl', 'writer');
  // Revoked while the body arrives.
  const last = png(40, 2);
  assert.equal(await s.refused(() => s.putPic('carl', X.id, X.live, last, { during: () => s.h.ok(s.h.send('owner',
    'team.member.revoke', { member_id: carl })) }), 'revoked'), 'member_revoked');
  assert.deepEqual(puts, [], 'revoked: nothing reached the store');
});

test('T6 limits: a member\'s own upload and read rates, two uploads in flight, the disk gate; logs hold no hash or path', async (t) => {
  const s = await setup(t, { limits: { uploads: 2, reads: 3 } });
  const { X } = s;
  const pics = [png(50, 1), png(51, 1), png(52, 1), png(53, 1)];
  for (const bytes of pics.slice(0, 2)) assert.equal((await s.putPic('alice', X.id, X.live, bytes)).status, 200);
  assert.equal(await s.refused(() => s.putPic('alice', X.id, X.live, pics[2]), 'third upload'), 'team_board_rate_limit');
  assert.equal((await s.putPic('carl', X.id, X.live, pics[2])).status, 200, 'Carl has his own count');
  for (let i = 0; i < 3; i += 1) assert.equal((await s.getPic('alice', X.id, X.live, sha(pics[0]))).status, 200);
  assert.equal(await s.refused(() => s.getPic('alice', X.id, X.live, sha(pics[0])), 'fourth read'), 'team_board_rate_limit');
  assert.equal((await s.getPic('rae', X.id, X.live, sha(pics[0]))).status, 200, 'Rae has her own count');
  s.now.value += 60_001;
  assert.equal((await s.putPic('alice', X.id, X.live, pics[3])).status, 200, 'after the window');
  // A third upload while two of the same member's bodies are still arriving.
  const routes = s.make({ limits: {} });
  const [a, b, c] = [png(60, 1), png(61, 1), png(62, 1)];
  let third = null;
  const first = await s.putPic('alice', X.id, X.live, a, { via: routes, during: async () => {
    const second = await s.putPic('alice', X.id, X.live, b, { via: routes, during: async () => {
      third = await s.putPic('alice', X.id, X.live, c, { via: routes });
    } });
    assert.equal(second.status, 200);
  } });
  assert.equal(first.status, 200);
  assert.deepEqual([third.json.error.reason, third.json.error.retryable], ['team_board_upload_limit', true]);
  assert.equal(fs.existsSync(path.join(s.root, X.id, 'assets', `${sha(c)}.png`)), false);
  assert.equal((await s.putPic('carl', X.id, X.live, c, { via: routes })).status, 200, 'another member is not held');
  // The disk gate.
  s.disk.ok = false;
  const pressure = png(70, 1);
  assert.equal(await s.refused(() => s.putPic('alice', X.id, X.live, pressure, { via: routes }), 'disk'), 'disk_pressure');
  assert.equal((await s.getPic('alice', X.id, X.live, sha(a), { via: routes })).status, 200, 'reads still go');
  // The log names the route and reasons, never a hash, a path or a byte.
  const log = s.h.logText();
  assert.match(log, /team_board_asset\.route_refused/u);
  for (const bytes of [...pics, a, b, c, pressure]) {
    assert.equal(log.includes(sha(bytes)), false);
    assert.equal(log.includes(bytes.toString('base64')), false);
  }
  for (const secret of [s.profile, s.profile.replaceAll('\\', '\\\\')]) assert.equal(log.includes(secret), false);
});

test('T6 wiring: the board host serves the snapshot and the pictures on one chain and sweeps both stores', async (t) => {
  const h = await createTeamProjectFixture(t);
  const x = await h.sharedProject('Apollo');
  const profile = fs.realpathSync.native(h.config.userDataPath);
  let now = START;
  const host = createTeamBoardHost({ userDataPath: profile, directory: h.store.directory, sessionProject: () => null,
    publish: () => {}, clock: () => now, logger: h.fx.logger, audit: () => ({ ok: true }),
    statfs: () => ({ bavail: 1e9, bsize: 4096, blocks: 2e9 }) });
  const board = (await must(host.store.create({ projectId: x, actor: h.seats.alice.member_id, name: 'Roadmap' }))).board.id;
  const pic = png(77, 3);
  const url = `/api/v1/projects/${x}/boards/${board}/assets/${sha(pic)}`;
  const stored = await h.fileRoute('carl', 'PUT', url, { routes: host.routes, body: pic });
  assert.deepEqual([stored.status, stored.json.stored], [200, true], JSON.stringify(stored.json));
  const got = await h.fileRoute('rae', 'GET', url, { routes: host.routes });
  assert.deepEqual([got.status, Buffer.compare(got.bytes, pic)], [200, 0]);
  const snapshot = await h.fileRoute('rae', 'GET', `/api/v1/projects/${x}/boards/${board}`, { routes: host.routes });
  assert.deepEqual([snapshot.status, snapshot.json.board.id], [200, board]);
  assert.equal(await host.routes({ request: { method: 'GET' }, pathname: '/api/v1/elsewhere' }), false);
  // No card names the picture: the second sweep task starts its clock and removes it after 7 days.
  assert.deepEqual(host.sweeps.map(([event]) => event), ['team.board_sweep_failed', 'team.board_asset_sweep_failed']);
  const file = path.join(profile, 'team-boards', x, 'assets', `${sha(pic)}.png`);
  assert.deepEqual(await host.sweeps[1][1](), { ok: true, removed: 0, kept: 1, skipped: 0 });
  now += 7 * 24 * 60 * 60 * 1000 + 1;
  assert.deepEqual(await host.sweeps[1][1](), { ok: true, removed: 1, kept: 0, skipped: 0 });
  assert.equal(fs.existsSync(file), false);
});
