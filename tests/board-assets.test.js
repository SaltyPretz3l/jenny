'use strict';

// new-test-file: a new surface (row 150 slice B7): the picture store under <userData>/board-assets, its content-only
// type check and header parser, and the 7-day cleanup over boards, journals, proposals and redo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const model = require('../services/boards/board-model');
const { createBoardAssetStore } = require('../services/boards/board-assets');
const { IMAGE_DIM_MAX, imageInfo } = require('../services/boards/board-image-info');
const { GRACE_MS, collectAssetRefs, createBoardAssetSweeper } = require('../services/boards/board-asset-sweep');
const { ASIDE_SCAN_BYTES, createBoardStore } = require('../services/boards/board-store');
const { createBoardService } = require('../services/boards/board-service');
const ids = require('../services/boards/board-ids');

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-11-13T10:00:00.000Z');
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function tempProfile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-board-assets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* ------------------------------------------------------------------ real minimal pictures */

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** A whole, decodable PNG (one row of grey pixels), then whatever `tail` holds. */
function png(width = 1, height = 1, tail = Buffer.alloc(0)) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // depth; colour type 0 (grey)
  const rows = Buffer.alloc((Math.min(width, 64) + 1) * Math.min(height, 4));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0)), tail]);
}
function jpeg(width = 3, height = 2) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  return Buffer.from([0xff, 0xd8, ...app0, 0xff, 0xff, ...sof, 0xff, 0xd9]);
}
function gif(width = 1, height = 1) {
  const out = Buffer.from('474946383961000000008000000000ffffff2c000000000100010000020244010003b', 'hex');
  out.writeUInt16LE(width, 6);
  out.writeUInt16LE(height, 8);
  return out;
}
function webp(kind, width = 5, height = 4) {
  const body = Buffer.alloc(kind === 'VP8 ' ? 18 : kind === 'VP8L' ? 13 : 18);
  if (kind === 'VP8L') {
    body[0] = 0x2f;
    body.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
  } else if (kind === 'VP8 ') {
    body.set([0x9d, 0x01, 0x2a], 3);
    body.writeUInt16LE(width, 6);
    body.writeUInt16LE(height, 8);
  } else {
    body.writeUIntLE(width - 1, 4, 3);
    body.writeUIntLE(height - 1, 7, 3);
  }
  const riff = Buffer.alloc(20);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(12 + body.length, 4);
  riff.write('WEBP', 8, 'latin1');
  riff.write(kind, 12, 'latin1');
  riff.writeUInt32LE(body.length, 16);
  return Buffer.concat([riff, body]);
}

/* ------------------------------------------------------------------ the store */

test('the four types are accepted by their bytes alone, with the header\'s size and the hash as the name', (t) => {
  const store = createBoardAssetStore({ userDataPath: tempProfile(t) });
  const cases = [
    [png(640, 480), 'png', 'image/png', 640, 480],
    [jpeg(1024, 768), 'jpg', 'image/jpeg', 1024, 768],
    [webp('VP8L', 33, 17), 'webp', 'image/webp', 33, 17],
    [webp('VP8 ', 300, 200), 'webp', 'image/webp', 300, 200],
    [webp('VP8X', 70000, 2), 'webp', 'image/webp', 70000, 2],
    [gif(9, 7), 'gif', 'image/gif', 9, 7],
  ];
  for (const [bytes, ext, mime, width, height] of cases) {
    // No name or declared type is ever asked for: the store sees only bytes (a Uint8Array view works as well).
    const answer = store.add(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    assert.equal(answer.ok, true, `${ext} ${JSON.stringify(answer)}`);
    assert.deepEqual([answer.ext, answer.mime, answer.width, answer.height, answer.bytes], [ext, mime, width, height, bytes.length]);
    assert.ok(ids.isAssetId(answer.asset));
    assert.ok(fs.existsSync(path.join(store.root, `${answer.asset}.${ext}`)));
  }
});

test('an SVG, HTML, a text file and an empty buffer are unsupported; a PNG header with an SVG after it is a PNG', (t) => {
  const store = createBoardAssetStore({ userDataPath: tempProfile(t) });
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
  for (const bytes of [svg, Buffer.from('<!doctype html><title>x</title>'), Buffer.from('plain text\n'), Buffer.alloc(0), 'not bytes', null]) {
    assert.equal(store.add(bytes).reason, bytes === null || typeof bytes === 'string' ? 'invalid' : 'unsupported');
  }
  assert.deepEqual(fs.readdirSync(path.dirname(store.root)), [], 'nothing was written');
  const disguised = store.add(png(12, 34, svg));
  assert.deepEqual([disguised.ok, disguised.ext, disguised.width, disguised.height], [true, 'png', 12, 34]);
});

test('truncated and hostile headers of all four types never throw and are refused', () => {
  const whole = [png(5, 5), jpeg(5, 5), webp('VP8L'), webp('VP8 '), webp('VP8X'), gif(5, 5)];
  const headerLength = [24, 31, 25, 30, 30, 10]; // the shortest prefix that holds each size (the JPEG's frame header ends at 31)
  whole.forEach((bytes, index) => {
    for (let cut = 0; cut < headerLength[index]; cut += 1) {
      const answer = imageInfo(bytes.subarray(0, cut));
      assert.equal(answer.ok, false, `type ${index} cut at ${cut}`);
    }
  });
  const soi = [0xff, 0xd8, 0xff];
  const hostile = [
    Buffer.from([...soi, 0xe0, 0x00, 0x00]), // a segment length under 2
    Buffer.from([...soi, 0xe0, 0xff, 0xff, 0x00]), // a length past the end
    Buffer.concat([Buffer.from(soi), Buffer.alloc(100000, 0xff)]), // fill bytes forever
    Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(Array.from({ length: 5000 }, () => [0xff, 0xd0]).flat())]), // restart markers only
    Buffer.from([...soi, 0xda, 0x00, 0x08]), // scan data before any frame
    Buffer.from([...soi, 0xc0, 0x00, 0x04, 0x08, 0x00]), // a frame header too short to hold a size
    (() => { const b = png(5, 5); b.writeUInt32BE(14, 8); return b; })(), // IHDR of the wrong length
    (() => { const b = webp('VP8 '); b[23] = 0; return b; })(), // no VP8 start code
    (() => { const b = webp('VP8L'); b[20] = 0; return b; })(), // no VP8L signature
    Buffer.from('RIFF\0\0\0\0WEBPABCD'), // an unknown chunk
  ];
  for (const bytes of hostile) assert.deepEqual(imageInfo(bytes), { ok: false, reason: 'unsupported' });
  assert.deepEqual(imageInfo(png(0, 5)), { ok: false, reason: 'dimensions' });
  assert.deepEqual(imageInfo(png(IMAGE_DIM_MAX + 1, 5)), { ok: false, reason: 'dimensions' });
  assert.deepEqual(imageInfo(gif(0, 1)), { ok: false, reason: 'dimensions' });
  assert.equal(imageInfo(png(IMAGE_DIM_MAX, 1)).ok, true);
});

test('the dimension cap is the model\'s: an image card of IMAGE_DIM_MAX is taken and one more is refused', () => {
  const board = model.createBoard({ id: `board_${uid(1)}`, project_id: 'project_alpha', name: 'B', now: '2026-11-13T10:00:00.000Z' }).board;
  const add = (width) => model.applyBatch(board, { batch_id: `w${width}`, board_id: board.id, actor: 'owner',
    ops: [{ op: 'card.add', card: { id: uid(2), kind: 'image', data: { asset: 'a'.repeat(64), width, height: 1, alt: '' } } }] },
  { now: '2026-11-13T10:00:00.000Z' });
  assert.equal(add(IMAGE_DIM_MAX).ok, true);
  assert.equal(add(IMAGE_DIM_MAX + 1).ok, false);
});

test('10 MB + 1 byte is refused before anything is hashed or written; the total cap answers full', (t) => {
  const userDataPath = tempProfile(t);
  const store = createBoardAssetStore({ userDataPath });
  const big = Buffer.concat([png(4, 4), Buffer.alloc(model.LIMITS.image_asset_bytes)]);
  assert.equal(big.length > model.LIMITS.image_asset_bytes, true);
  assert.deepEqual(store.add(big), { ok: false, reason: 'too_large' });
  assert.equal(fs.existsSync(store.root), false, 'no folder, no file');

  const small = createBoardAssetStore({ userDataPath, totalBytes: png(1, 1).length + png(2, 2).length - 1 });
  assert.equal(small.add(png(1, 1)).ok, true);
  assert.deepEqual(small.add(png(2, 2)), { ok: false, reason: 'full' });
  assert.equal(small.add(png(1, 1)).ok, true, 'a picture already stored still answers');
  assert.equal(small.list().length, 1);
});

test('the same bytes twice are one file, written once', (t) => {
  const store = createBoardAssetStore({ userDataPath: tempProfile(t) });
  const first = store.add(png(3, 3));
  const file = path.join(store.root, `${first.asset}.png`);
  const earlier = new Date(Math.floor(fs.statSync(file).mtimeMs / 1000) * 1000 - 60000);
  fs.utimesSync(file, earlier, earlier);
  const again = store.add(png(3, 3));
  assert.deepEqual(again, first);
  assert.deepEqual(fs.readdirSync(store.root), [`${first.asset}.png`]);
  assert.ok(Math.abs(fs.statSync(file).mtimeMs - earlier.getTime()) < 1, 'not written again');
});

test('read answers the bytes and type; a name that is not a SHA-256 is refused before the disk is touched', (t) => {
  const userDataPath = tempProfile(t);
  const store = createBoardAssetStore({ userDataPath });
  const added = store.add(gif(2, 2));
  const read = store.read(added.asset);
  assert.equal(read.ok, true);
  assert.deepEqual([read.mime, Buffer.compare(read.bytes, gif(2, 2))], ['image/gif', 0]);
  assert.deepEqual(store.read('b'.repeat(64)), { ok: false, reason: 'not_found' });
  // The folder made unreadable as a folder: a call that reached the disk would answer io, not invalid.
  fs.rmSync(store.root, { recursive: true });
  fs.writeFileSync(store.root, 'not a folder');
  for (const name of ['../boards/index', `${added.asset}.gif`, added.asset.toUpperCase(), '', null, 'a'.repeat(63)]) {
    assert.deepEqual(store.read(name), { ok: false, reason: 'invalid' });
  }
  assert.deepEqual(store.read(added.asset), { ok: false, reason: 'io' });
});

test('read and list never follow a link: a junction at the folder, or one named like a picture', (t) => {
  const userDataPath = tempProfile(t);
  const outside = path.join(userDataPath, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'x'), 'secret');
  const store = createBoardAssetStore({ userDataPath });
  const added = store.add(png(2, 2));
  const fakeName = `${'c'.repeat(64)}.png`;
  fs.symlinkSync(outside, path.join(store.root, fakeName), 'junction');
  assert.deepEqual(store.read('c'.repeat(64)), { ok: false, reason: 'not_found' });
  assert.deepEqual(store.list().map((entry) => entry.asset), [added.asset]);

  const other = path.join(tempProfile(t), 'profile');
  fs.mkdirSync(other);
  fs.symlinkSync(store.root, path.join(other, 'board-assets'), 'junction');
  const linked = createBoardAssetStore({ userDataPath: other });
  assert.deepEqual(linked.read(added.asset), { ok: false, reason: 'io' });
  assert.deepEqual(linked.add(png(5, 5)), { ok: false, reason: 'io' });
  assert.deepEqual(linked.list(), []);
});

/* ------------------------------------------------------------------ the cleanup */

function sweepEnv(t) {
  const userDataPath = tempProfile(t);
  const env = { clock: T0, seq: 100, userDataPath };
  env.assets = createBoardAssetStore({ userDataPath });
  env.store = createBoardStore({ userDataPath });
  env.service = createBoardService({
    store: env.store, now: () => new Date(env.clock), makeId: () => uid(++env.seq), projectExists: () => true,
  });
  env.sweeper = createBoardAssetSweeper({
    assets: env.assets, store: env.store, now: () => env.clock, getRedoInverses: () => env.service.redoInverses(),
  });
  env.sweepAt = (days) => { env.clock = T0 + days * DAY; return env.sweeper.sweepNow(); };
  env.stored = (asset) => env.assets.list().some((entry) => entry.asset === asset);
  return env;
}
const imageCard = (n, asset) => ({ op: 'card.add', card: { id: uid(n), kind: 'image', data: { asset, width: 2, height: 2, alt: '' }, x: 0, y: 0 } });
async function boardWith(env, ops) {
  const board = (await env.service.create({ projectId: 'project_alpha', name: 'Pictures' })).board;
  if (ops.length) {
    const applied = await env.service.apply({ boardId: board.id, batch: { batch_id: `seed-${board.id}`, board_id: board.id, ops } });
    assert.equal(applied.ok, true, JSON.stringify(applied).slice(0, 300));
  }
  return board;
}

test('an unreferenced picture is kept at 6 days and removed at 7; one referenced again starts over', async (t) => {
  const env = sweepEnv(t);
  const lonely = env.assets.add(png(1, 1)).asset;
  const back = env.assets.add(png(2, 2)).asset;
  assert.deepEqual(env.sweepAt(0), { ok: true, removed: [] });
  assert.deepEqual(Object.keys(env.assets.readIndex().since).sort(), [lonely, back].sort());
  env.sweepAt(3);
  const board = await boardWith(env, [imageCard(1, back)]);
  env.sweepAt(4);
  assert.deepEqual(Object.keys(env.assets.readIndex().since), [lonely], 'a referenced picture loses its clock');
  assert.equal((await env.service.apply({ boardId: board.id, batch: { batch_id: 'drop', board_id: board.id, ops: [{ op: 'card.remove', id: uid(1) }] } })).ok, true);
  fs.rmSync(env.store.root, { recursive: true }); // the board and its journal are gone for good
  assert.deepEqual(env.sweepAt(6.9), { ok: true, removed: [] });
  assert.equal(env.stored(lonely), true);
  assert.deepEqual(env.sweepAt(7), { ok: true, removed: [lonely] });
  assert.equal(env.stored(lonely), false);
  assert.equal(env.stored(back), true, 'its clock started at day 6.9');
  assert.deepEqual(env.sweepAt(13.8), { ok: true, removed: [] });
  assert.deepEqual(env.sweepAt(13.9), { ok: true, removed: [back] });
});

test('a card, a journal inverse, a proposal, a deleted-but-restorable board and a redo step each keep a picture', async (t) => {
  const env = sweepEnv(t);
  const [onCard, inJournal, inProposal, onDeleted, inRedo, none] = [1, 2, 3, 4, 5, 6].map((n) => env.assets.add(png(n, 1)).asset);
  await boardWith(env, [imageCard(1, onCard)]);
  const journal = await boardWith(env, [imageCard(2, inJournal)]);
  await env.service.apply({ boardId: journal.id, batch: { batch_id: 'rm', board_id: journal.id, ops: [{ op: 'card.remove', id: uid(2) }] } });
  const proposed = await boardWith(env, []);
  env.store.writeProposals(proposed.id, [{ id: 'p1', status: 'pending', ops: [{ op: 'card.add', card: { kind: 'image', data: { asset: inProposal } } }] }]);
  const deleted = await boardWith(env, [imageCard(4, onDeleted)]);
  assert.equal((await env.service.delete({ boardId: deleted.id })).ok, true);
  const redo = await boardWith(env, [imageCard(5, inRedo)]);
  assert.equal((await env.service.undo({ boardId: redo.id })).ok, true);
  assert.equal(JSON.stringify(env.store.readDocument(redo.id).value).includes(inRedo), false, 'only the redo step names it');

  env.sweepAt(0);
  const result = env.sweepAt(8);
  assert.deepEqual(result, { ok: true, removed: [none] });
  for (const asset of [onCard, inJournal, inProposal, onDeleted, inRedo]) assert.equal(env.stored(asset), true);
});

test('an unreadable board source removes nothing; a link in the folder is not followed; a corrupt index is rebuilt', async (t) => {
  const env = sweepEnv(t);
  const lonely = env.assets.add(png(1, 1)).asset;
  const outside = path.join(env.userDataPath, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  fs.symlinkSync(outside, path.join(env.assets.root, `${'d'.repeat(64)}.png`), 'junction');
  const board = await boardWith(env, []);
  env.sweepAt(0);
  fs.writeFileSync(path.join(env.store.root, `${board.id}.journal.json`), '{ not json');
  assert.deepEqual(env.sweepAt(8), { ok: false, removed: [], skipped: 'unreadable_source' });
  assert.equal(env.stored(lonely), true);
  fs.rmSync(path.join(env.store.root, `${board.id}.journal.json`));

  fs.writeFileSync(path.join(env.assets.root, ids.ASSET_INDEX_FILE), '{ broken');
  assert.deepEqual(env.sweepAt(9), { ok: true, removed: [] }, 'a lost clock starts over');
  const rebuilt = JSON.parse(fs.readFileSync(path.join(env.assets.root, ids.ASSET_INDEX_FILE), 'utf8'));
  assert.deepEqual(rebuilt, { schema_version: 1, since: { [lonely]: T0 + 9 * DAY } });
  assert.deepEqual(env.sweepAt(16), { ok: true, removed: [lonely] });
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep', 'the link target is untouched');
  assert.equal(fs.lstatSync(path.join(env.assets.root, `${'d'.repeat(64)}.png`)).isSymbolicLink(), true, 'the link itself is not a picture');
});

test('a board set aside keeps its pictures, damaged or not; a set-aside file too large to scan holds the cleanup', async (t) => {
  const env = sweepEnv(t);
  const [onCard, inJournal, inWreck, none] = [1, 2, 3, 4].map((n) => env.assets.add(png(n, 1)).asset);
  const board = await boardWith(env, [imageCard(1, onCard), imageCard(2, inJournal)]);
  await env.service.apply({ boardId: board.id, batch: { batch_id: 'rm', board_id: board.id, ops: [{ op: 'card.remove', id: uid(2) }] } });
  const wreck = await boardWith(env, []);
  fs.writeFileSync(path.join(env.store.root, `${wreck.id}.json`), `{"cards":[{"data":{"asset":"${inWreck}"`); // cut short: no JSON
  assert.deepEqual(env.sweepAt(0), { ok: false, removed: [], skipped: 'unreadable_source' }, 'a listed board that cannot be read holds the pass');
  for (const id of [board.id, wreck.id]) assert.ok(env.store.setAsideFiles(id, T0), id);
  assert.deepEqual(env.store.listDocumentIds(), [], 'neither is a listed board now');
  fs.symlinkSync(env.assets.root, path.join(env.store.root, 'x.json.aside-1'), 'junction'); // not one of ours: passed over

  assert.deepEqual(env.sweepAt(1), { ok: true, removed: [] });
  assert.deepEqual(env.sweepAt(9), { ok: true, removed: [none] });
  for (const asset of [onCard, inJournal, inWreck]) assert.equal(env.stored(asset), true);

  const lonely = env.assets.add(png(5, 1)).asset;
  env.sweepAt(10);
  const huge = path.join(env.store.root, 'y.json.aside-2');
  fs.writeFileSync(huge, '');
  fs.truncateSync(huge, ASIDE_SCAN_BYTES + 1);
  assert.deepEqual(env.sweepAt(20), { ok: false, removed: [], skipped: 'unreadable_source' });
  assert.equal(env.stored(lonely), true);
  fs.rmSync(huge);
  assert.deepEqual(env.sweepAt(21), { ok: true, removed: [lonely] });
});

test('a picture added again loses its clock; maybeSweep runs once, then at most once a day, and swallows a failure', (t) => {
  const env = sweepEnv(t);
  const asset = env.assets.add(png(1, 1)).asset;
  env.sweepAt(0);
  assert.equal(env.assets.readIndex().since[asset], T0);
  env.assets.add(png(1, 1));
  assert.equal(env.assets.readIndex().since[asset], undefined);

  const queued = [];
  const logs = [];
  let clock = T0;
  let passes = 0;
  const sweeper = createBoardAssetSweeper({
    assets: { list: () => { passes += 1; throw new Error('disk gone'); }, readIndex: () => ({ since: {} }), writeIndex: () => true, remove: () => true },
    store: env.store, now: () => clock, schedule: (fn) => queued.push(fn), logger: (level, event) => logs.push(`${level}:${event}`),
  });
  assert.equal(sweeper.maybeSweep(), true);
  assert.equal(sweeper.maybeSweep(), false, 'one pass at a time');
  assert.equal(passes, 0, 'nothing runs on the caller\'s turn');
  queued.shift()();
  assert.equal(passes, 1);
  assert.deepEqual(logs, ['WARN:boards.asset_sweep_failed']);
  clock += DAY - 1;
  assert.equal(sweeper.maybeSweep(), false);
  clock += 1;
  assert.equal(sweeper.maybeSweep(), true);
  assert.equal(GRACE_MS, 7 * DAY);
});

test('collectAssetRefs walks without interpreting and stops at its depth bound', () => {
  const refs = new Set();
  assert.equal(collectAssetRefs({ a: [{ data: { asset: 'e'.repeat(64) } }, { asset: 'not-a-hash' }], asset: 'F'.repeat(64) }, refs), true);
  assert.deepEqual([...refs], ['e'.repeat(64)]);
  let deep = {};
  const top = deep;
  for (let i = 0; i < 80; i += 1) { deep.next = {}; deep = deep.next; }
  assert.equal(collectAssetRefs(top, new Set()), false);
});
