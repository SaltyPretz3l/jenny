'use strict';

// new-test-file: a new surface (row 150 slice C5): pinning a chat item to a board from outside the Board page
// (services/boards/board-pin.js), over a real board service, a real picture store and a real project folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const M = require('../services/boards/board-model');
const { createBoardStore } = require('../services/boards/board-store');
const { createBoardService } = require('../services/boards/board-service');
const { createBoardFiles } = require('../services/boards/board-files');
const { createBoardAssetStore } = require('../services/boards/board-assets');
const { REFS_MAX, createBoardPins, createPictureResolver } = require('../services/boards/board-pin');

const { LIMITS } = M;
const ALPHA = 'project_alpha';
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
const SCENE = 'title Sign in\nuser User @user\napp App\nuser -> app';

// <tmp>/project/src/app.js is inside the project folder; <tmp>/outside/secret.txt is not.
async function setup(t, { pictures = {}, withResolver = true } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-board-pin-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(base, 'outside'));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), '1\n');
  fs.writeFileSync(path.join(base, 'outside', 'secret.txt'), 'secret\n');
  const userDataPath = path.join(base, 'profile');
  fs.mkdirSync(userDataPath);
  let seq = 1000;
  const service = createBoardService({ store: createBoardStore({ userDataPath }), makeId: () => uid(++seq), projectExists: () => true });
  const files = createBoardFiles({
    getBoard: (boardId) => service.get({ boardId }),
    captureProject: (projectId) => ({ project_id: projectId, root_path: root }),
  });
  const assets = createBoardAssetStore({ userDataPath });
  const asked = [];
  const resolvePicture = async (ref) => { asked.push(ref); return pictures[ref.id] || { ok: false, reason: 'unavailable' }; };
  const pins = createBoardPins({ service, getFiles: () => files, getAssets: () => assets, ...(withResolver ? { resolvePicture } : {}) });
  const board = (await service.create({ projectId: ALPHA, name: 'Plan' })).board;
  return { base, root, service, pins, board, asked, assetsDir: path.join(userDataPath, 'board-assets'),
    cards: async (boardId = board.id) => Object.values((await service.get({ boardId })).board.cards),
    rev: async (boardId = board.id) => (await service.get({ boardId })).board.rev };
}

const CHAT = { kind: 'chat', sessionId: 'sess_1', messageId: 'msg_9', title: 'Auth redesign', excerpt: 'We could move the token check.' };
const REF = { kind: 'artifact', id: 'art_1', sessionId: 'sess_1' };

test('each kind adds exactly one card with the documented data, one undo step, rev up by one', async (t) => {
  const s = await setup(t, { pictures: { art_1: { ok: true, bytes: PNG } } });
  const items = [
    [{ kind: 'note', text: '  Move the token check.  ' }, 'note', { text: 'Move the token check.', tone: null }],
    [CHAT, 'chat', { session_id: 'sess_1', message_id: 'msg_9', title: 'Auth redesign', excerpt: 'We could move the token check.' }],
    [{ kind: 'diagram', scene: SCENE, title: 'Sign in' }, 'diagram', { scene: SCENE, title: 'Sign in' }],
    [{ kind: 'file', path: 'src/app.js' }, 'file', { path: 'src/app.js', title: 'app.js' }],
    [{ kind: 'image', ref: REF }, 'image', null],
  ];
  for (const [item, kind, data] of items) {
    const before = await s.rev();
    const answer = await s.pins.pin({ boardId: s.board.id, item });
    assert.equal(answer.ok, true, `${kind}: ${JSON.stringify(answer)}`);
    assert.deepEqual([answer.boardId, answer.boardName], [s.board.id, 'Plan']);
    assert.equal(await s.rev(), before + 1, `${kind}: one batch`);
    const card = (await s.cards()).find((entry) => entry.id === answer.cardId);
    assert.equal(card.kind, kind);
    assert.equal(card.created_by, 'owner');
    if (data) assert.deepEqual(card.data, data);
    else assert.deepEqual([card.data.width, card.data.height, card.data.alt, /^[0-9a-f]{64}$/.test(card.data.asset)], [1, 1, '', true]);
  }
  assert.deepEqual(s.asked, [REF]);
  assert.equal((await s.cards()).length, items.length);
  // One undo step each: the newest pin goes, then the one before it.
  assert.equal((await s.service.undo({ boardId: s.board.id })).ok, true);
  assert.equal((await s.cards()).length, items.length - 1);
  assert.equal((await s.service.undo({ boardId: s.board.id })).ok, true);
  assert.equal((await s.cards()).length, items.length - 2);
});

test('pins land in free space: no two cards overlap, and a card is never placed on an earlier one', async (t) => {
  const s = await setup(t);
  for (let n = 0; n < 4; n += 1) assert.equal((await s.pins.pin({ boardId: s.board.id, item: { kind: 'note', text: `note ${n}` } })).ok, true);
  const cards = await s.cards();
  for (const a of cards) {
    for (const b of cards) {
      if (a === b) continue;
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.equal(apart, true, `${a.alias} and ${b.alias} overlap`);
    }
  }
});

test('a note past the limit is cut and ends in an ellipsis; a chat excerpt is stored at 400, a title at 200', async (t) => {
  const s = await setup(t);
  const long = await s.pins.pin({ boardId: s.board.id, item: { kind: 'note', text: 'x'.repeat(LIMITS.note_chars + 50) } });
  assert.equal(long.ok, true);
  const note = (await s.cards()).find((card) => card.id === long.cardId);
  assert.equal(note.data.text.length, LIMITS.note_chars);
  assert.equal(note.data.text.endsWith('…'), true);
  const exact = await s.pins.pin({ boardId: s.board.id, item: { kind: 'note', text: 'y'.repeat(LIMITS.note_chars) } });
  assert.equal((await s.cards()).find((card) => card.id === exact.cardId).data.text.length, LIMITS.note_chars, 'at the limit is not cut');
  const chat = await s.pins.pin({ boardId: s.board.id, item: { ...CHAT, excerpt: 'e'.repeat(2000), title: 't'.repeat(900) } });
  const card = (await s.cards()).find((entry) => entry.id === chat.cardId);
  assert.deepEqual([card.data.excerpt.length, card.data.title.length], [400, 200]);
  // Selected text may hold a carriage return, a tab and other controls: the model's own text rule is met.
  const rough = await s.pins.pin({ boardId: s.board.id, item: { kind: 'note', text: 'a\r\nb\tc\u0007d' } });
  assert.equal((await s.cards()).find((entry) => entry.id === rough.cardId).data.text, 'a\nb\tc d');
});

test('a scene past the model limit is refused, not cut, and adds nothing', async (t) => {
  const s = await setup(t);
  const before = await s.rev();
  assert.deepEqual(await s.pins.pin({ boardId: s.board.id, item: { kind: 'diagram', scene: 'a'.repeat(LIMITS.diagram_chars + 1), title: '' } }),
    { ok: false, reason: 'invalid', limit: 'diagram_chars' });
  assert.deepEqual(await s.pins.pin({ boardId: s.board.id, item: { kind: 'diagram', scene: ' \n ', title: '' } }), { ok: false, reason: 'invalid' });
  assert.equal(await s.rev(), before);
});

test('a malformed request is invalid and changes nothing', async (t) => {
  const s = await setup(t, { pictures: { art_1: { ok: true, bytes: PNG } } });
  const before = await s.rev();
  const withProto = JSON.parse('{"kind":"note","text":"x","__proto__":{"kind":"note"}}');
  const bad = [
    { boardId: s.board.id, item: { ...CHAT, extra: 1 } },
    { boardId: s.board.id, item: { kind: 'note', text: 'x', tone: 'red' } },
    { boardId: s.board.id, item: withProto },
    { boardId: s.board.id, item: { kind: 'note' } },
    { boardId: s.board.id, item: { kind: 'note', text: '   ' } },
    { boardId: s.board.id, item: { kind: 'note', text: 5 } },
    { boardId: s.board.id, item: { kind: 'note', text: 'x'.repeat(2 * 1024 * 1024) } },
    { boardId: s.board.id, item: { kind: 'link', url: 'https://example.com/' } },
    { boardId: s.board.id, item: { kind: '__proto__' } },
    { boardId: s.board.id, item: { kind: 'file', path: '' } },
    { boardId: s.board.id, item: { kind: 'file', path: 'a'.repeat(1025) } },
    { boardId: s.board.id, item: { kind: 'file' } },
    { boardId: s.board.id, item: { kind: 'image' } },
    { boardId: s.board.id, item: { kind: 'image', ref: { ...REF, kind: 'path' } } },
    { boardId: s.board.id, item: { kind: 'image', ref: { ...REF, extra: 1 } } },
    { boardId: s.board.id, item: { kind: 'image', ref: { kind: 'artifact', id: 'a' } } },
    { boardId: s.board.id, item: { kind: 'image', ref: 'C:\\pic.png' } },
    { boardId: s.board.id, item: { ...CHAT, sessionId: 'a/b' } },
    { boardId: s.board.id, item: { ...CHAT, messageId: 'm'.repeat(201) } },
    { boardId: s.board.id, item: { ...CHAT, messageId: '' } },
    { boardId: s.board.id, item: { ...CHAT, title: 7 } },
    { boardId: s.board.id, item: { ...CHAT, excerpt: undefined } },
    { boardId: s.board.id, item: [] },
    { boardId: s.board.id },
    { boardId: 'board_x', item: CHAT },
    { boardId: s.board.id, item: CHAT, extra: true },
    null, 'x', [], undefined,
  ];
  for (const request of bad) assert.deepEqual(await s.pins.pin(request), { ok: false, reason: 'invalid' }, JSON.stringify(request) && JSON.stringify(request).slice(0, 80));
  assert.equal(await s.rev(), before);
  assert.equal((await s.cards()).length, 0);
  assert.deepEqual(s.asked, [], 'no picture was asked for');
});

test('a file outside the project folder is refused by the file check and adds nothing', async (t) => {
  const s = await setup(t);
  const before = await s.rev();
  for (const [file, reason] of [[path.join(s.base, 'outside', 'secret.txt'), 'outside'], ['../outside/secret.txt', 'outside'], ['src/missing.js', 'not_found'], ['src', 'not_file']]) {
    assert.deepEqual(await s.pins.pin({ boardId: s.board.id, item: { kind: 'file', path: file } }), { ok: false, reason }, file);
  }
  assert.equal(await s.rev(), before);
  // An absolute path inside the folder is stored relative.
  const inside = await s.pins.pin({ boardId: s.board.id, item: { kind: 'file', path: path.join(s.root, 'src', 'app.js') } });
  assert.equal((await s.cards()).find((card) => card.id === inside.cardId).data.path, 'src/app.js');
});

test('a picture whose bytes are HTML or SVG is refused by the picture store and adds no card', async (t) => {
  const html = new TextEncoder().encode('<html><body>hi</body></html>');
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
  const s = await setup(t, { pictures: { page: { ok: true, bytes: html }, vector: { ok: true, bytes: svg }, string: { ok: true, bytes: 'png' },
    big: { ok: true, bytes: new Uint8Array(LIMITS.image_asset_bytes + 1) }, gone: { ok: false, reason: 'unavailable' } } });
  const before = await s.rev();
  for (const [id, reason] of [['page', 'unsupported'], ['vector', 'unsupported'], ['string', 'invalid'], ['big', 'too_large'], ['gone', 'unavailable'], ['nothing', 'unavailable']]) {
    assert.deepEqual(await s.pins.pin({ boardId: s.board.id, item: { kind: 'image', ref: { ...REF, id } } }), { ok: false, reason }, id);
  }
  assert.equal(await s.rev(), before);
  assert.equal(fs.existsSync(s.assetsDir) ? fs.readdirSync(s.assetsDir).filter((name) => name !== 'unreferenced.json').length : 0, 0, 'nothing was stored');
});

test('without a picture resolver an image answers unavailable', async (t) => {
  const s = await setup(t, { withResolver: false });
  assert.deepEqual(await s.pins.pin({ boardId: s.board.id, item: { kind: 'image', ref: REF } }), { ok: false, reason: 'unavailable' });
  assert.equal((await s.cards()).length, 0);
});

test('an unknown board is not_found, a full board passes the model limit on, and nothing is added', async (t) => {
  const s = await setup(t, { pictures: { art_1: { ok: true, bytes: PNG } } });
  const missing = `board_${uid(5)}`;
  assert.deepEqual(await s.pins.pin({ boardId: missing, item: { kind: 'note', text: 'x' } }), { ok: false, reason: 'not_found' });
  assert.deepEqual(await s.pins.pin({ boardId: missing, item: { kind: 'image', ref: REF } }), { ok: false, reason: 'not_found' });
  assert.deepEqual(s.asked, [], 'no picture is read for a board that is not there');
  assert.equal(fs.existsSync(s.assetsDir), false, 'and none is stored');
  let n = 0;
  for (const count of [200, 200, 100]) {
    const ops = Array.from({ length: count }, () => ({ op: 'card.add', card: { id: uid(++n), kind: 'note', data: { text: `n${n}` } } }));
    const done = await s.service.apply({ boardId: s.board.id, batch: { batch_id: `fill-${n}`, board_id: s.board.id, actor: 'owner', ops } });
    assert.equal(done.ok, true, JSON.stringify(done).slice(0, 200));
  }
  const full = await s.rev();
  assert.deepEqual(await s.pins.pin({ boardId: s.board.id, item: { kind: 'note', text: 'one more' } }), { ok: false, reason: 'limit', limit: 'cards' });
  assert.equal(await s.rev(), full);
});

test('the picture resolver reads a picture only after its size is checked, and only an image artifact', async () => {
  const reads = [];
  const stats = [];
  const make = (artifact, size, isFile = true) => createPictureResolver({ artifactService: { resolveArtifact: async () => artifact } }, {
    statSync: (file) => { stats.push(file); return { size, isFile: () => isFile }; },
    readFileSync: (file) => { reads.push(file); return Buffer.from(PNG); },
  });
  const image = { status: 'available', artifact_kind: 'image', absolute_path: '/store/pic.png' };
  assert.deepEqual(await make(image, LIMITS.image_asset_bytes + 1)(REF), { ok: false, reason: 'too_large' });
  assert.deepEqual(reads, [], 'an oversize picture is never read');
  const read = await make(image, PNG.length)(REF);
  assert.deepEqual([read.ok, Array.from(read.bytes)], [true, Array.from(PNG)]);
  assert.deepEqual(reads, ['/store/pic.png']);
  assert.deepEqual(await make({ ...image, artifact_kind: 'text' }, 1)(REF), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await make({ ...image, status: 'missing' }, 1)(REF), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await make(image, 1, false)(REF), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await make(image, 1)({ ...REF, kind: 'attachment' }), { ok: false, reason: 'unavailable' }, 'a user-attached picture has no exported resolver');
  assert.deepEqual(await createPictureResolver({})(REF), { ok: false, reason: 'unavailable' });
  assert.equal(reads.length, 1);
});

test('chatRefs returns only this session\'s chat cards from the project\'s boards', async (t) => {
  const s = await setup(t);
  const second = (await s.service.create({ projectId: ALPHA, name: 'Second' })).board;
  const other = (await s.service.create({ projectId: 'project_beta', name: 'Elsewhere' })).board;
  const one = await s.pins.pin({ boardId: s.board.id, item: CHAT });
  const two = await s.pins.pin({ boardId: second.id, item: { ...CHAT, messageId: 'msg_10' } });
  await s.pins.pin({ boardId: s.board.id, item: { ...CHAT, sessionId: 'sess_2' } });
  await s.pins.pin({ boardId: s.board.id, item: { kind: 'note', text: 'not a chat' } });
  await s.pins.pin({ boardId: other.id, item: CHAT });
  assert.deepEqual(await s.pins.chatRefs({ projectId: ALPHA, sessionId: 'sess_1' }), { ok: true, refs: [
    { messageId: 'msg_9', boardId: s.board.id, boardName: 'Plan', cardId: one.cardId },
    { messageId: 'msg_10', boardId: second.id, boardName: 'Second', cardId: two.cardId },
  ] });
  assert.deepEqual(await s.pins.chatRefs({ projectId: ALPHA, sessionId: 'nobody' }), { ok: true, refs: [] });
  for (const bad of [{ projectId: 'x', sessionId: 'sess_1' }, { projectId: ALPHA }, { projectId: ALPHA, sessionId: 'a/b' }, { projectId: ALPHA, sessionId: 's', extra: 1 }, null]) {
    assert.deepEqual(await s.pins.chatRefs(bad), { ok: false, reason: 'invalid' });
  }
});

test('chatRefs skips a board that cannot be read and stops at the cap', async () => {
  const chatCard = (n, session = 's1') => ({ id: uid(n), kind: 'chat', data: { session_id: session, message_id: `m${n}`, title: '', excerpt: '' } });
  const boards = [{ id: `board_${uid(1)}`, name: 'Broken' }, { id: `board_${uid(2)}`, name: 'Odd' }, { id: `board_${uid(3)}`, name: 'Big' }];
  const service = {
    list: async () => ({ ok: true, boards }),
    get: async ({ boardId }) => {
      if (boardId === boards[0].id) throw new Error('unreadable');
      if (boardId === boards[1].id) return { ok: true, board: null, readOnly: true };
      return { ok: true, readOnly: false, board: { name: 'Big', cards: Object.fromEntries(Array.from({ length: 250 }, (_v, n) => [uid(n + 10), chatCard(n + 10)])) } };
    },
  };
  const pins = createBoardPins({ service, getFiles: () => null, getAssets: () => null });
  const answer = await pins.chatRefs({ projectId: ALPHA, sessionId: 's1' });
  assert.equal(answer.ok, true);
  assert.equal(answer.refs.length, REFS_MAX);
  assert.equal(REFS_MAX, 200);
  assert.ok(answer.refs.every((ref) => ref.boardId === boards[2].id && ref.boardName === 'Big'));
  const broken = createBoardPins({ service: { list: async () => { throw new Error('boom'); } } });
  assert.deepEqual(await broken.chatRefs({ projectId: ALPHA, sessionId: 's1' }), { ok: false, reason: 'io' });
  assert.deepEqual(await broken.pin({ boardId: boards[0].id, item: CHAT }), { ok: false, reason: 'io' });
});
