'use strict';

// new-test-file: row 151 slice T6 adds the team host's picture store (server/team/boards/board-host-assets.js), a new
// host surface, and the board store's `assetRefs`; team-board-store.test.js is near its line cap.
//
// The store on a real temp profile with the real board store: the four formats stored by content and read back;
// every refusal (type, size, hash, dimensions, ids, a project with no folder) leaves the disk as it was; the project
// cap; links at `assets` and at a picture; `assetRefs` over live boards, the trash, journal inverses and proposals;
// the 7-day sweep, which never removes a picture on a partial view; a project removed with its pictures; a full
// project making room from pictures no board names (wave 9 review); the pixel cap.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { hostFailure } = require('../../server/api-contract');
const { removeTreeSync } = require('../../services/fs-remove-no-follow');
const durable = require('../../services/host/durable-json');
const { TEAM_BOARD_LIMITS, createTeamBoards } = require('../../server/team/boards/team-boards');
const { ROOM_AGE_MS, ROOM_RETRY_MS, createTeamBoardAssets } = require('../../server/team/boards/board-host-assets');
const { batch, must, tree } = require('./helpers/team-board-kit');
const { gif, jpeg, png, sha, webp } = require('./helpers/team-board-pictures');

const DAY = 24 * 60 * 60 * 1000;
const GRACE = 7 * DAY;
const P = 'project_alpha';
const Q = 'project_beta';
const ALICE = 'member_alice';
const START = Date.UTC(2026, 10, 15, 9, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const codeOf = (kind) => hostFailure(kind, 'x').error.code;

/* ------------------------------------------------------------------ harness */

function setup(t, { limits } = {}) {
  const profile = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-team-assets-')));
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-team-assets-outside-')));
  t.after(() => { removeTreeSync(profile); removeTreeSync(outside); });
  const clock = { now: START };
  const logs = [];
  const logger = (level, event, data) => logs.push({ level, event, data });
  const boards = createTeamBoards({ userDataPath: profile, clock: () => clock.now, logger });
  const make = (extra = {}) => createTeamBoardAssets({ userDataPath: profile, clock: () => clock.now, logger,
    refs: (projectId, use) => boards.assetRefs({ projectId, use }), ...extra });
  const root = path.join(profile, 'team-boards');
  const assetsDir = (projectId) => path.join(root, projectId, 'assets');
  const clocksFile = (projectId) => path.join(assetsDir(projectId), 'unreferenced.json');
  return { profile, outside, clock, logs, boards, make, root, assetsDir, clocksFile,
    assets: make(limits ? { limits } : {}),
    clocks: (projectId) => JSON.parse(fs.readFileSync(clocksFile(projectId), 'utf8')),
    writeClocks: (projectId, since) => fs.writeFileSync(clocksFile(projectId), JSON.stringify({ schema_version: 1, since })) };
}

async function newBoard(h, projectId = P, name = 'Plan') {
  return (await must(h.boards.create({ projectId, actor: ALICE, name }), 'create')).board.id;
}
const put = (store, projectId, bytes, hash = sha(bytes)) => store.put({ projectId, hash, bytes });
const image = (asset) => ({ op: 'card.add', card: { id: crypto.randomUUID(), kind: 'image', x: 0, y: 0,
  data: { asset, width: 1, height: 1, alt: '' } } });
const addCards = (h, boardId, ...ops) => must(h.boards.apply({ projectId: P, boardId, actor: ALICE, batch: batch(...ops) }), 'apply');

// The call's refusal, with proof that nothing under team-boards changed.
async function refused(h, call, where) {
  const before = tree(h.root);
  const answer = await call();
  assert.equal(answer.ok, false, `${where}: ${JSON.stringify(answer).slice(0, 300)}`);
  assert.deepEqual(tree(h.root), before, `${where} changed the disk`);
  return answer;
}

/* ------------------------------------------------------------------ the store */

test('a PNG, JPEG, WebP and GIF are stored by content under their extension and read back byte for byte', async (t) => {
  const h = setup(t);
  await newBoard(h);
  const cases = [[png(640, 480), 'png', 'image/png', 640, 480], [jpeg(1024, 768), 'jpg', 'image/jpeg', 1024, 768],
    [webp(33, 17), 'webp', 'image/webp', 33, 17], [gif(9, 7), 'gif', 'image/gif', 9, 7]];
  let total = 0;
  for (const [bytes, ext, type, width, height] of cases) {
    const hash = sha(bytes);
    const answer = await must(h.assets.put({ projectId: P, hash, bytes: new Uint8Array(bytes) }), ext);
    assert.deepEqual(answer, { ok: true, asset: hash, type, width, height, bytes: bytes.length, stored: true }, ext);
    assert.deepEqual(fs.readFileSync(path.join(h.assetsDir(P), `${hash}.${ext}`)), bytes, ext);
    const read = await must(h.assets.read({ projectId: P, hash }), `read ${ext}`);
    assert.equal(Buffer.compare(read.bytes, bytes), 0, ext);
    assert.deepEqual([read.type, read.width, read.height, read.ext], [type, width, height, ext], ext);
    const before = tree(h.root);
    assert.deepEqual(await put(h.assets, P, bytes), { ...answer, stored: false }, `${ext} again`);
    assert.deepEqual(tree(h.root), before, `${ext} again wrote`);
    total += bytes.length;
  }
  assert.deepEqual(await h.assets.usage({ projectId: P }), { ok: true, bytes: total, count: 4 });
  // Two puts of one picture at once: written once.
  const both = await Promise.all([put(h.assets, P, png(2, 2)), put(h.assets, P, png(2, 2))]);
  assert.deepEqual(both.map((answer) => answer.stored).sort(), [false, true]);
  assert.equal(fs.readdirSync(h.assetsDir(P)).length, 5, 'five pictures and no temp file');
});

test('refused and nothing written: other types, sizes, a wrong hash, refused dimensions, bad ids, no project folder', async (t) => {
  const h = setup(t, { limits: { pictureBytes: 4096 } });
  await newBoard(h);
  await must(put(h.assets, P, gif(2, 2)), 'one stored picture');
  const good = png(3, 3);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
  const html = Buffer.from('<!doctype html><title>x</title>');
  const truncated = png(4, 4).subarray(0, 20);
  const over = png(1, 1, Buffer.alloc(4097 - png(1, 1).length));
  const wide = png(100001, 1);
  const cases = [
    ['an SVG', P, svg, sha(svg), 'team_board_asset_unsupported', 'invalid'],
    ['HTML', P, html, sha(html), 'team_board_asset_unsupported', 'invalid'],
    ['text', P, Buffer.from('plain text\n'), sha('plain text\n'), 'team_board_asset_unsupported', 'invalid'],
    ['an empty buffer', P, Buffer.alloc(0), sha(''), 'team_board_asset_invalid', 'invalid'],
    ['not bytes', P, 'not bytes', sha('not bytes'), 'team_board_asset_invalid', 'invalid'],
    ['a truncated PNG', P, truncated, sha(truncated), 'team_board_asset_unsupported', 'invalid'],
    ['one byte over the cap', P, over, sha(over), 'team_board_asset_size_limit', 'limit'],
    ['a hash that is not the bytes\'', P, png(4, 4), sha(png(5, 5)), 'team_board_asset_mismatch', 'invalid'],
    ['dimensions the model refuses', P, wide, sha(wide), 'team_board_asset_dimensions', 'invalid'],
    ['a malformed project id', '../project_alpha', good, sha(good), 'team_board_not_found', 'forbidden'],
    ['another malformed project id', 'nope', good, sha(good), 'team_board_not_found', 'forbidden'],
    ['project_general', 'project_general', good, sha(good), 'team_board_not_found', 'forbidden'],
    ['a project with no folder', Q, good, sha(good), 'team_board_not_found', 'forbidden'],
    ['an upper-case hash', P, good, sha(good).toUpperCase(), 'team_board_asset_invalid', 'invalid'],
    ['a short hash', P, good, sha(good).slice(1), 'team_board_asset_invalid', 'invalid'],
    ['a hash with an extension', P, good, `${sha(good).slice(4)}.png`, 'team_board_asset_invalid', 'invalid'],
  ];
  for (const [where, projectId, bytes, hash, reason, kind] of cases) {
    const answer = await refused(h, () => h.assets.put({ projectId, hash, bytes }), where);
    assert.deepEqual([answer.error.reason, answer.error.code, answer.error.retryable], [reason, codeOf(kind), false], where);
  }
  assert.equal(fs.existsSync(path.join(h.root, Q)), false, 'the project folder was not made');
  // Exactly at the cap is accepted.
  const atCap = png(1, 1, Buffer.alloc(4096 - png(1, 1).length));
  assert.equal((await must(put(h.assets, P, atCap))).bytes, 4096);
});

test('the project cap: the picture that would pass it is refused, the stored ones stay; caps only go down', async (t) => {
  const [a, b, c] = [png(1, 1), png(2, 1), png(3, 1)];
  const h = setup(t, { limits: { assetBytes: a.length + b.length + 10 } });
  await newBoard(h);
  await must(put(h.assets, P, a));
  await must(put(h.assets, P, b));
  const answer = await refused(h, () => put(h.assets, P, c), 'over the project cap');
  assert.deepEqual([answer.error.reason, answer.error.code], ['team_board_asset_storage_limit', codeOf('limit')]);
  assert.equal((await must(put(h.assets, P, a))).stored, false, 'an already stored picture still answers');
  assert.deepEqual(await h.assets.usage({ projectId: P }), { ok: true, bytes: a.length + b.length, count: 2 });
  assert.equal(TEAM_BOARD_LIMITS.assetBytes, 256 * 1024 * 1024);
  assert.throws(() => h.make({ limits: { assetBytes: TEAM_BOARD_LIMITS.assetBytes + 1 } }), RangeError);
  assert.throws(() => h.make({ limits: { pictureBytes: 10 * 1024 * 1024 + 1 } }), RangeError);
  assert.throws(() => h.make({ limits: { pictures: 8193 } }), RangeError);
  assert.throws(() => h.make({ limits: { boards: 1 } }), RangeError);
  // The count cap: the third picture is refused whatever its size, and taken once one is gone.
  const counted = h.make({ limits: { assetBytes: TEAM_BOARD_LIMITS.assetBytes, pictures: 2 } });
  const full = await refused(h, () => put(counted, P, c), 'over the count cap');
  assert.equal(full.error.reason, 'team_board_asset_storage_limit');
  assert.equal((await must(put(counted, P, b))).stored, false, 'a stored picture still answers at the cap');
  assert.deepEqual(await counted.discard({ projectId: P, hash: sha(a) }), { ok: true, removed: true });
  assert.equal((await must(put(counted, P, c))).stored, true);
  assert.throws(() => h.make({ refs: null }), TypeError);
});

test('a full project makes room from pictures no board names once a sweep saw them unused; named and new ones stay', async (t) => {
  const [named, idle, late, fresh, next, more] = [1, 2, 3, 4, 5, 6].map((width) => { const bytes = png(width, 3); return { bytes, hash: sha(bytes) }; });
  const h = setup(t);
  let scans = 0;
  const store = h.make({ limits: { pictures: 4 }, refs: (projectId, use) => { scans += 1; return h.boards.assetRefs({ projectId, use }); } });
  const live = await newBoard(h);
  const on = (pic) => fs.existsSync(path.join(h.assetsDir(P), `${pic.hash}.png`));
  for (const pic of [named, idle, late]) await must(put(store, P, pic.bytes));
  await addCards(h, live, image(named.hash));
  // The sweep starts a clock for the two no board names; one of them is named after it, with no new upload.
  await must(h.assets.sweep());
  await addCards(h, live, image(late.hash));
  await must(put(store, P, fresh.bytes));
  assert.deepEqual(Object.keys(h.clocks(P).since).sort(), [idle.hash, late.hash].sort());
  // Full. The clock has not run ten minutes: nothing goes, and nothing on disk changes.
  h.clock.now = START + ROOM_AGE_MS - 1;
  assert.equal((await refused(h, () => put(store, P, next.bytes), 'full, the clock is young')).error.reason, 'team_board_asset_storage_limit');
  // Asked again within the minute: refused without reading the boards again.
  h.clock.now += ROOM_RETRY_MS - 1;
  await refused(h, () => put(store, P, next.bytes), 'full, asked again at once');
  assert.equal(scans, 1);
  // Old enough: the unused one goes and the new picture is stored; the named ones and the new upload stay.
  h.clock.now += 1;
  assert.equal((await must(put(store, P, next.bytes))).stored, true);
  assert.deepEqual([[named, idle, late, fresh, next].map(on), h.clocks(P).since], [[true, false, true, true, true], { [late.hash]: iso(START) }]);
  // Full again with nothing unused that a sweep has seen: refused, and every picture is still there.
  h.clock.now += ROOM_RETRY_MS;
  assert.equal((await refused(h, () => put(store, P, more.bytes), 'full, nothing to free')).error.reason, 'team_board_asset_storage_limit');
  assert.deepEqual([scans, (await store.usage({ projectId: P })).count], [3, 4]);
  // No view of the boards (the scan refuses): nothing is removed.
  await must(h.assets.sweep());
  h.clock.now += ROOM_AGE_MS + ROOM_RETRY_MS;
  const blind = h.make({ limits: { pictures: 4 }, refs: async () => ({ ok: false }) });
  await refused(h, () => put(blind, P, more.bytes), 'full, no view');
  const log = JSON.stringify(h.logs);
  assert.match(log, /team_board_asset\.room_made/u);
  for (const pic of [named, idle, late, fresh, next]) assert.equal(log.includes(pic.hash), false);
  // A picture of more than 64 million pixels is refused whatever its size in bytes; each side alone was allowed.
  const wide = png(9000, 9000);
  assert.equal((await refused(h, () => put(h.assets, P, wide), 'too many pixels')).error.reason, 'team_board_asset_dimensions');
  assert.equal((await must(put(h.assets, P, png(8000, 8000)))).stored, true);
  assert.throws(() => h.make({ limits: { pixels: 64_000_001 } }), RangeError);
});

test('a picture is found only under its own project, by its name, its content and its hash', async (t) => {
  const h = setup(t);
  await newBoard(h, P);
  await newBoard(h, Q);
  const pic = png(6, 6);
  const hash = sha(pic);
  await must(put(h.assets, P, pic));
  const notFound = async (args, where) => {
    const answer = await refused(h, () => h.assets.read(args), where);
    assert.deepEqual([answer.error.reason, answer.error.code], ['team_board_asset_not_found', codeOf('forbidden')], where);
  };
  await notFound({ projectId: Q, hash }, 'another project');
  await notFound({ projectId: 'project_gamma', hash }, 'a project with no folder');
  await notFound({ projectId: '../project_alpha', hash }, 'a malformed project');
  await notFound({ projectId: P, hash: hash.toUpperCase() }, 'a malformed hash');
  // A file whose bytes are not its name's hash, one whose content is another type, a folder in a picture's place.
  const other = png(7, 7);
  fs.writeFileSync(path.join(h.assetsDir(P), `${sha(other)}.png`), png(8, 8));
  await notFound({ projectId: P, hash: sha(other) }, 'bytes that are not the hash');
  const asGif = png(9, 9);
  fs.writeFileSync(path.join(h.assetsDir(P), `${sha(asGif)}.gif`), asGif);
  await notFound({ projectId: P, hash: sha(asGif) }, 'a PNG stored as a GIF');
  fs.mkdirSync(path.join(h.assetsDir(P), `${'d'.repeat(64)}.png`));
  await notFound({ projectId: P, hash: 'd'.repeat(64) }, 'a folder');
  // discard removes the one picture, and only under its project.
  assert.deepEqual(await h.assets.discard({ projectId: Q, hash }), { ok: true, removed: false });
  assert.deepEqual(await h.assets.discard({ projectId: P, hash }), { ok: true, removed: true });
  await notFound({ projectId: P, hash }, 'discarded');
});

test('links: a junction at assets, a hard-linked picture and a file symlink are never followed', async (t) => {
  const h = setup(t);
  await newBoard(h, P);
  await newBoard(h, Q);
  // A junction at P's assets to a folder outside the profile that holds a picture and an old clock.
  const pic = png(5, 5);
  const target = path.join(h.outside, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, `${sha(pic)}.png`), pic);
  fs.writeFileSync(path.join(target, 'unreferenced.json'), JSON.stringify({ schema_version: 1, since: { [sha(pic)]: iso(START - 8 * DAY) } }));
  fs.symlinkSync(target, h.assetsDir(P), 'junction');
  const outsideBefore = tree(h.outside);
  assert.equal((await refused(h, () => put(h.assets, P, pic), 'put through a junction')).error.reason, 'team_board_unavailable');
  assert.equal((await refused(h, () => put(h.assets, P, png(6, 5)), 'a new picture through a junction')).error.reason, 'team_board_unavailable');
  assert.equal((await h.assets.read({ projectId: P, hash: sha(pic) })).error.reason, 'team_board_asset_not_found');
  const swept = await h.assets.sweep();
  assert.deepEqual([swept.ok, swept.removed, swept.skipped], [true, 0, 1]);
  assert.deepEqual(tree(h.outside), outsideBefore, 'nothing outside changed');
  // A hard link in Q's assets to a file outside.
  await must(put(h.assets, Q, gif(3, 3)));
  const linked = png(6, 6);
  const outsideFile = path.join(h.outside, 'linked.png');
  fs.writeFileSync(outsideFile, linked);
  fs.linkSync(outsideFile, path.join(h.assetsDir(Q), `${sha(linked)}.png`));
  assert.equal((await h.assets.read({ projectId: Q, hash: sha(linked) })).error.reason, 'team_board_asset_not_found');
  assert.equal((await refused(h, () => put(h.assets, Q, linked), 'put over a hard link')).error.reason, 'team_board_unavailable');
  h.writeClocks(Q, { [sha(linked)]: iso(START - 8 * DAY) });
  const again = await h.assets.sweep();
  assert.deepEqual([again.removed, again.skipped], [0, 1], 'P is still skipped and the hard link is kept');
  assert.ok(fs.existsSync(path.join(h.assetsDir(Q), `${sha(linked)}.png`)), 'the hard link was not removed');
  assert.deepEqual(fs.readFileSync(outsideFile), linked);
  // A file symlink needs Developer Mode on Windows.
  await t.test('a file symlink at a picture', async (st) => {
    const linkedGif = gif(4, 4);
    const gifFile = path.join(h.outside, 'linked.gif');
    fs.writeFileSync(gifFile, linkedGif);
    const link = path.join(h.assetsDir(Q), `${sha(linkedGif)}.gif`);
    try { fs.symlinkSync(gifFile, link, 'file'); } catch (error) {
      st.skip(`a file symlink could not be created here (${error.code}); on Windows it needs Developer Mode`);
      return;
    }
    assert.equal((await h.assets.read({ projectId: Q, hash: sha(linkedGif) })).error.reason, 'team_board_asset_not_found');
    assert.equal((await refused(h, () => put(h.assets, Q, linkedGif), 'put over a symlink')).error.reason, 'team_board_unavailable');
    h.writeClocks(Q, { [sha(linkedGif)]: iso(START - 8 * DAY) });
    await h.assets.sweep();
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.deepEqual(fs.readFileSync(gifFile), linkedGif);
  });
});

test('a transient write error answers unavailable, retryable, and latches nothing', async (t) => {
  const h = setup(t);
  await newBoard(h);
  await must(put(h.assets, P, gif(3, 1)), 'the assets folder exists');
  const fault = { on: true };
  const store = h.make({ fileOps: { writeBytes: (filePath, bytes) => {
    if (fault.on) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    return durable.writeBytes(filePath, bytes);
  } } });
  const answer = await refused(h, () => put(store, P, png(2, 3)), 'a locked file');
  assert.deepEqual([answer.error.reason, answer.error.code, answer.error.retryable], ['team_board_unavailable', codeOf('unavailable'), true]);
  fault.on = false;
  assert.equal((await must(put(store, P, png(2, 3)))).stored, true);
});

/* ------------------------------------------------------------------ assetRefs */

test('assetRefs: live boards, the trash, journal inverses and proposals; use runs inside the call; it writes nothing', async (t) => {
  const h = setup(t);
  const [onLive, onTrash, inverseOnly, proposalOnly] = ['live', 'trash', 'inverse', 'proposal'].map((word) => sha(word));
  const live = await newBoard(h);
  const old = await newBoard(h, P, 'Old');
  await addCards(h, live, image(onLive));
  await addCards(h, old, image(onTrash));
  await must(h.boards.remove({ projectId: P, boardId: old, actor: ALICE }));
  const gone = image(inverseOnly);
  await addCards(h, live, gone);
  const rev = (await must(h.boards.get({ projectId: P, boardId: live }))).board.cards[gone.card.id].content_rev;
  await addCards(h, live, { op: 'card.remove', id: gone.card.id, content_rev: rev });
  await must(h.boards.writeProposals({ projectId: P, boardId: live, actor: ALICE,
    proposals: [{ id: 'p1', ops: [{ op: 'card.add', card: { kind: 'image', data: { asset: proposalOnly } } }] }] }));
  const all = [onLive, onTrash, inverseOnly, proposalOnly].sort();
  let seen = null;
  const before = tree(h.root);
  const pending = h.boards.assetRefs({ projectId: P, use: (set) => { seen = [...set].sort(); return 'decided'; } });
  assert.deepEqual(seen, all, 'use ran before the call resolved');
  assert.deepEqual(await pending, { ok: true, assets: all, result: 'decided' });
  assert.deepEqual(await h.boards.assetRefs({ projectId: P }), { ok: true, assets: all });
  assert.deepEqual(tree(h.root), before, 'assetRefs wrote nothing');
  // A board the index lost is still scanned, and the index is not rebuilt.
  fs.rmSync(path.join(h.root, P, 'index.json'));
  const lost = tree(h.root);
  assert.deepEqual((await h.boards.assetRefs({ projectId: P })).assets, all);
  assert.deepEqual(tree(h.root), lost);
  // A project with no folder: nothing referenced, and use still runs.
  let empty = null;
  assert.deepEqual(await h.boards.assetRefs({ projectId: Q, use: (set) => { empty = set; return 1; } }), { ok: true, assets: [], result: 1 });
  assert.deepEqual([empty instanceof Set, empty.size], [true, 0]);
  assert.equal(fs.existsSync(path.join(h.root, Q)), false);
  // Ids and `use` are checked first; use is never called on a refusal.
  const never = () => assert.fail('use must not run');
  for (const projectId of ['project_general', '../x', 7]) {
    assert.equal((await h.boards.assetRefs({ projectId, use: never })).error.reason, 'team_board_not_found', String(projectId));
  }
  assert.equal((await h.boards.assetRefs({ projectId: P, use: 'decide' })).error.reason, 'team_board_invalid');
  assert.equal((await h.boards.assetRefs({ projectId: P, use: () => { throw new Error('boom'); } })).error.reason, 'team_board_unavailable');
});

test('assetRefs: an unreadable or corrupt file answers unavailable without calling use; a removed project is not found', async (t) => {
  const h = setup(t);
  const live = await newBoard(h);
  await addCards(h, live, image(sha('x')));
  const never = () => assert.fail('use must not run');
  const doc = path.join(h.root, P, `${live}.json`);
  const kept = fs.readFileSync(doc);
  const journal = path.join(h.root, P, `${live}.journal.json`);
  const journalKept = fs.readFileSync(journal);
  const damage = [
    ['a corrupt document', () => fs.writeFileSync(doc, '{'), () => fs.writeFileSync(doc, kept)],
    ['a document of a newer schema', () => fs.writeFileSync(doc, JSON.stringify({ ...JSON.parse(kept), schema_version: 99 })),
      () => fs.writeFileSync(doc, kept)],
    ['a folder in the journal\'s place', () => { fs.rmSync(journal); fs.mkdirSync(journal); },
      () => { fs.rmdirSync(journal); fs.writeFileSync(journal, journalKept); }],
    ['a corrupt proposals file', () => fs.writeFileSync(path.join(h.root, P, `${live}.proposals.json`), 'nope'),
      () => fs.rmSync(path.join(h.root, P, `${live}.proposals.json`))],
  ];
  for (const [where, harm, heal] of damage) {
    harm();
    const answer = await h.boards.assetRefs({ projectId: P, use: never });
    assert.deepEqual([answer.ok, answer.error.reason, answer.error.retryable], [false, 'team_board_unavailable', true], where);
    heal();
    assert.deepEqual((await h.boards.assetRefs({ projectId: P })).assets, [sha('x')], `${where} healed`);
  }
  await must(h.boards.removeProject({ projectId: P }));
  assert.equal((await h.boards.assetRefs({ projectId: P, use: never })).error.reason, 'team_board_not_found');
});

/* ------------------------------------------------------------------ the sweep */

test('sweep: unreferenced for 7 days and 1 ms goes, exactly 7 days stays; a reference drops the clock', async (t) => {
  const h = setup(t);
  const live = await newBoard(h);
  const [kept, gone, saved] = [png(1, 2), png(2, 2), png(3, 2)].map((bytes) => ({ bytes, hash: sha(bytes) }));
  for (const pic of [kept, gone, saved]) await must(put(h.assets, P, pic.bytes));
  await addCards(h, live, image(kept.hash));
  assert.deepEqual(await h.assets.sweep(), { ok: true, removed: 0, kept: 3, skipped: 0 });
  assert.deepEqual(h.clocks(P), { schema_version: 1, since: { [gone.hash]: iso(START), [saved.hash]: iso(START) } });
  // Referenced again before the deadline: its clock goes.
  h.clock.now = START + 3 * DAY;
  await addCards(h, live, image(saved.hash));
  await must(h.assets.sweep());
  assert.deepEqual(h.clocks(P).since, { [gone.hash]: iso(START) });
  // Unchanged clocks are not written again.
  const settled = tree(h.root);
  await must(h.assets.sweep());
  assert.deepEqual(tree(h.root), settled);
  h.clock.now = START + GRACE;
  assert.deepEqual(await h.assets.sweep(), { ok: true, removed: 0, kept: 3, skipped: 0 });
  assert.ok(fs.existsSync(path.join(h.assetsDir(P), `${gone.hash}.png`)), 'exactly 7 days stays');
  h.clock.now = START + GRACE + 1;
  assert.deepEqual(await h.assets.sweep(), { ok: true, removed: 1, kept: 2, skipped: 0 });
  assert.equal(fs.existsSync(path.join(h.assetsDir(P), `${gone.hash}.png`)), false);
  assert.deepEqual(h.clocks(P).since, {});
  h.clock.now = START + 30 * DAY;
  await must(h.assets.sweep());
  for (const pic of [kept, saved]) assert.ok(fs.existsSync(path.join(h.assetsDir(P), `${pic.hash}.png`)), 'referenced pictures stay');
  // A referenced picture with a clock loses it; a clock for a picture no longer on disk is dropped.
  h.writeClocks(P, { [kept.hash]: iso(START), [sha('not on disk')]: iso(START) });
  await must(h.assets.sweep());
  assert.deepEqual(h.clocks(P).since, {});
  // Other files in assets are left alone.
  fs.writeFileSync(path.join(h.assetsDir(P), 'notes.txt'), 'mine');
  h.clock.now = START + 60 * DAY;
  await must(h.assets.sweep());
  assert.equal(fs.readFileSync(path.join(h.assetsDir(P), 'notes.txt'), 'utf8'), 'mine');
  // The log carries counts and reason words, never a hash or a path.
  const log = JSON.stringify(h.logs);
  assert.match(log, /team_board_asset\.swept/u);
  for (const secret of [kept.hash, gone.hash, saved.hash, h.profile, h.profile.replaceAll('\\', '\\\\')]) {
    assert.equal(log.includes(secret), false);
  }
});

test('sweep: a refs answer that is not exactly ok, or throws, removes nothing and writes no clock', async (t) => {
  const h = setup(t);
  const live = await newBoard(h);
  const old = png(7, 7);
  await must(put(h.assets, P, old));
  h.writeClocks(P, { [sha(old)]: iso(START - 8 * DAY) });
  const variants = [
    ['not ok', async () => ({ ok: false, error: { reason: 'team_board_unavailable' } })],
    ['throws', () => { throw new Error('boom'); }], ['rejects', async () => { throw new Error('boom'); }],
    ['false', async () => false], ['0', async () => 0], ['empty string', async () => ''], ['undefined', async () => undefined],
    ['ok: 1', async () => ({ ok: 1, assets: [] })], ['ok without calling use', async () => ({ ok: true, assets: [] })],
  ];
  for (const [where, refs] of variants) {
    const before = tree(h.root);
    const answer = await h.make({ refs }).sweep();
    assert.deepEqual([answer.ok, answer.removed, answer.skipped], [true, 0, 1], where);
    assert.deepEqual(tree(h.root), before, `${where} changed the disk`);
  }
  // The real store on a partial view: a corrupt document skips the project.
  const doc = path.join(h.root, P, `${live}.json`);
  const kept = fs.readFileSync(doc);
  fs.writeFileSync(doc, '{');
  const before = tree(h.root);
  assert.deepEqual(await h.assets.sweep(), { ok: true, removed: 0, kept: 0, skipped: 1 });
  assert.deepEqual(tree(h.root), before);
  fs.writeFileSync(doc, kept);
  assert.deepEqual(await h.assets.sweep(), { ok: true, removed: 1, kept: 0, skipped: 0 });
  assert.match(JSON.stringify(h.logs), /team_board_asset\.sweep_skipped/u);
});

test('sweep: a corrupt clocks file is rebuilt; a newer one is left byte for byte', async (t) => {
  const h = setup(t);
  await newBoard(h);
  const pic = png(4, 2);
  await must(put(h.assets, P, pic));
  fs.writeFileSync(h.clocksFile(P), 'not json');
  h.clock.now = START + 100 * DAY;
  assert.deepEqual(await h.assets.sweep(), { ok: true, removed: 0, kept: 1, skipped: 0 });
  assert.deepEqual(h.clocks(P), { schema_version: 1, since: { [sha(pic)]: iso(START + 100 * DAY) } });
  const newer = JSON.stringify({ schema_version: 2, since: { [sha(pic)]: iso(START) } });
  fs.writeFileSync(h.clocksFile(P), newer);
  h.clock.now = START + 200 * DAY;
  assert.deepEqual(await h.assets.sweep(), { ok: true, removed: 0, kept: 0, skipped: 1 });
  assert.equal(fs.readFileSync(h.clocksFile(P), 'utf8'), newer);
  assert.ok(fs.existsSync(path.join(h.assetsDir(P), `${sha(pic)}.png`)));
});

test('a project removed with removeProject takes its pictures; it is never made again', async (t) => {
  const h = setup(t);
  await newBoard(h);
  const pic = png(9, 2);
  await must(put(h.assets, P, pic));
  await must(h.boards.removeProject({ projectId: P }));
  assert.equal(fs.existsSync(path.join(h.root, P)), false);
  assert.equal((await put(h.assets, P, pic)).error.reason, 'team_board_not_found');
  assert.equal((await h.assets.read({ projectId: P, hash: sha(pic) })).error.reason, 'team_board_asset_not_found');
  assert.deepEqual(await h.assets.sweep(), { ok: true, removed: 0, kept: 0, skipped: 0 });
  assert.equal(fs.existsSync(path.join(h.root, P)), false);
});

test('a picture damaged on disk is written again when it is sent again (P5)', async (t) => {
  const h = setup(t);
  await newBoard(h);
  const bytes = png(3, 3);
  const file = path.join(h.assetsDir(P), `${sha(bytes)}.png`);
  assert.equal((await must(put(h.assets, P, bytes))).stored, true);
  // The same length with other bytes, then a cut file: neither is the picture its name says.
  for (const broken of [Buffer.alloc(bytes.byteLength, 7), bytes.subarray(0, 20)]) {
    fs.writeFileSync(file, broken);
    assert.equal((await h.assets.read({ projectId: P, hash: sha(bytes) })).ok, false, 'a damaged file is not served');
    assert.equal((await must(put(h.assets, P, bytes))).stored, true, 'sent again, it is stored again');
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal((await must(h.assets.read({ projectId: P, hash: sha(bytes) }))).bytes.equals(bytes), true);
  }
  assert.deepEqual(fs.readdirSync(h.assetsDir(P)).filter((name) => name !== 'unreferenced.json'), [`${sha(bytes)}.png`]);
  assert.equal(h.logs.filter((entry) => entry.event === 'team_board_asset.repaired').length, 2);
  assert.equal((await must(put(h.assets, P, bytes))).stored, false, 'a sound picture still answers as already there');
});

test('H4: put asks the caller\'s check inside the queue before any write; a refusal writes nothing, a pass stores', async (t) => {
  const h = setup(t);
  await newBoard(h);
  const bytes = png(5, 5);
  const denied = () => hostFailure('forbidden', 'role_forbidden');
  const answer = await refused(h, () => h.assets.put({ projectId: P, hash: sha(bytes), bytes, recheck: denied }), 'a denied check');
  assert.equal(answer.error.reason, 'role_forbidden');
  assert.equal((await must(h.assets.put({ projectId: P, hash: sha(bytes), bytes, recheck: () => null }))).stored, true);
  // A picture already stored is answered as stored: false, and a check that refuses still refuses it.
  assert.equal((await h.assets.put({ projectId: P, hash: sha(bytes), bytes, recheck: denied })).error?.reason, 'role_forbidden');
  assert.equal((await h.assets.put({ projectId: P, hash: sha(bytes), bytes, recheck: () => { throw new Error('x'); } })).ok, false);
});

test('H4: discard with ifUnreferenced removes a picture no board names and keeps one a card names', async (t) => {
  const h = setup(t);
  const live = await newBoard(h);
  const [named, loose] = [png(6, 6), png(7, 7)];
  await must(put(h.assets, P, named));
  await must(put(h.assets, P, loose));
  await addCards(h, live, image(sha(named)));
  assert.deepEqual(await h.assets.discard({ projectId: P, hash: sha(named), ifUnreferenced: true }), { ok: true, removed: false });
  assert.equal(fs.existsSync(path.join(h.assetsDir(P), `${sha(named)}.png`)), true, 'the named picture stays');
  assert.deepEqual(await h.assets.discard({ projectId: P, hash: sha(loose), ifUnreferenced: true }), { ok: true, removed: true });
  assert.equal(fs.existsSync(path.join(h.assetsDir(P), `${sha(loose)}.png`)), false);
  // No view of the boards: nothing is removed.
  const blind = h.make({ refs: async () => ({ ok: false }) });
  await must(put(h.assets, P, loose));
  assert.equal((await blind.discard({ projectId: P, hash: sha(loose), ifUnreferenced: true })).ok, false);
  assert.equal(fs.existsSync(path.join(h.assetsDir(P), `${sha(loose)}.png`)), true);
});

test('a damaged clocks file does not keep a re-uploaded picture on the list a full project frees from', async (t) => {
  const [first, second, third] = [png(11, 3), png(12, 3), png(13, 3)];
  const h = setup(t);
  const store = h.make({ limits: { pictures: 2 } });
  await newBoard(h);
  await must(put(store, P, first));
  await must(put(store, P, second));
  // The first picture's clock is the oldest; one more entry is not a valid hash, so the file reads as rebuilt.
  h.writeClocks(P, { [sha(first)]: iso(START - 2 * DAY), [sha(second)]: iso(START - DAY), nothash: iso(START) });
  assert.equal((await must(put(store, P, first))).stored, false, 'sent again: a card is about to name it');
  assert.equal((await must(put(store, P, third))).stored, true, 'the project was full: the idle one went');
  const on = (bytes) => fs.existsSync(path.join(h.assetsDir(P), `${sha(bytes)}.png`));
  assert.deepEqual([first, second, third].map(on), [true, false, true]);
});
