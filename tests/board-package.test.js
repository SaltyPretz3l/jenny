'use strict';

// new-test-file: a new surface (row 150 slice B10): the .jennyboard format of services/boards/board-package.js, pure
// pack and unpack, and the hostile files unpack refuses. File IO and the dialogs are tests/board-transfer.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const model = require('../services/boards/board-model');
const { PACKAGE_MAX_BYTES, pack, unpack } = require('../services/boards/board-package');

const NOW = '2026-11-13T10:00:00.000Z';
const LATER = '2026-11-14T08:30:00.000Z';
const PROJECT = 'project_alpha';
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function gif(width, height) {
  const out = Buffer.from('474946383961000000008000000000ffffff2c000000000100010000020244010003b', 'hex');
  out.writeUInt16LE(width, 6);
  out.writeUInt16LE(height, 8);
  return out;
}
const PIC_A = gif(1, 1);
const PIC_B = gif(2, 3);

/** A normalized board with every card kind, a group, two connectors and two pictures. */
function fullBoard() {
  const made = model.createBoard({ id: `board_${uid(1)}`, project_id: PROJECT, name: 'Plan', now: NOW });
  const ops = [
    { op: 'group.add', group: { id: uid(10), title: 'Open questions', x: 0, y: 0, w: 900, h: 400 } },
    { op: 'card.add', card: { id: uid(11), kind: 'note', data: { text: 'Keep refresh tokens?\nMobile needs them.', tone: 'amber' }, x: 20, y: 60, group_id: uid(10) } },
    { op: 'card.add', card: { id: uid(12), kind: 'link', data: { url: 'https://example.com/a', title: 'Example' }, x: 300, y: 60 } },
    { op: 'card.add', card: { id: uid(13), kind: 'file', data: { path: 'src/auth/session.ts', title: '' }, x: 20, y: 500 } },
    { op: 'card.add', card: { id: uid(14), kind: 'chat', data: { session_id: 'sess_abc', message_id: 'msg_1', title: 'Auth chat', excerpt: 'We said yes.' }, x: 300, y: 500 } },
    { op: 'card.add', card: { id: uid(15), kind: 'diagram', data: { scene: 'a -> b', title: 'Flow' }, x: 600, y: 500 } },
    { op: 'card.add', card: { id: uid(16), kind: 'image', data: { asset: sha(PIC_A), width: 1, height: 1, alt: 'Logo' }, x: 900, y: 500 } },
    { op: 'card.add', card: { id: uid(17), kind: 'image', data: { asset: sha(PIC_B), width: 2, height: 3, alt: 'Chart' }, x: 1200, y: 500 } },
    { op: 'connector.add', connector: { id: uid(20), from: uid(11), to: uid(12), label: 'leads to' } },
    { op: 'connector.add', connector: { id: uid(21), from: uid(13), to: uid(14), label: '', style: 'dashed', ends: 'both' } },
  ];
  const applied = model.applyBatch(made.board, { batch_id: 'seed', board_id: made.board.id, actor: 'someone', ops }, { now: NOW, authority: true });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  return applied.board;
}

function packed(board = fullBoard(), assets = [{ ext: 'gif', bytes: PIC_A }, { ext: 'gif', bytes: PIC_B }]) {
  const out = pack({ board, assets, now: NOW });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out.text;
}

function unpackOptions() {
  let seq = 500;
  return { makeId: () => uid(++seq), now: LATER, projectId: 'project_beta', newBoardId: `board_${uid(999)}` };
}

const reasonOf = (text) => unpack(text, unpackOptions()).reason;
const withValue = (mutate) => {
  const value = JSON.parse(packed());
  mutate(value);
  return JSON.stringify(value);
};

test('pack writes only the board content and each picture once; unpack builds a fresh board the way a duplicate is built', () => {
  const original = fullBoard();
  const text = packed(original, [{ ext: 'gif', bytes: PIC_A }, { ext: 'gif', bytes: PIC_B }, { ext: 'gif', bytes: PIC_A }]);
  const value = JSON.parse(text);
  assert.deepEqual(Object.keys(value), ['format', 'version', 'exported_at', 'board', 'assets']);
  assert.deepEqual([value.format, value.version, value.exported_at], ['jennyboard', 1, NOW]);
  assert.deepEqual(Object.keys(value.board), ['name', 'next_alias', 'cards', 'connectors', 'groups']);
  assert.equal(value.assets.length, 2, 'the same picture goes once');
  assert.deepEqual(value.assets.map((asset) => Object.keys(asset)), [['ext', 'base64'], ['ext', 'base64']]);
  assert.equal(text.includes(original.id), false, 'no board id');
  assert.equal(text.includes(PROJECT), false, 'no project id');

  const out = unpack(text, unpackOptions());
  assert.equal(out.ok, true, JSON.stringify(out));
  const board = out.board;
  assert.equal(model.normalizeBoard(board).ok, true);
  assert.equal(board.id, `board_${uid(999)}`);
  assert.equal(board.project_id, 'project_beta');
  assert.deepEqual([board.rev, board.created_at, board.updated_at, board.recent_batches], [0, LATER, LATER, []]);
  assert.equal(board.name, 'Plan');
  assert.equal(board.next_alias, original.next_alias, 'this board never lost an item, so its number is already one past the highest');
  const oldIds = new Set([...Object.keys(original.cards), ...Object.keys(original.groups), ...Object.keys(original.connectors)]);
  const newIds = [...Object.keys(board.cards), ...Object.keys(board.groups), ...Object.keys(board.connectors)];
  assert.equal(newIds.length, oldIds.size);
  assert.ok(newIds.every((id) => !oldIds.has(id)), 'no item id in common');
  const aliases = (b) => Object.values(b.cards).map((card) => card.alias).concat(Object.values(b.groups).map((g) => g.alias)).sort();
  assert.deepEqual(aliases(board), aliases(original));
  for (const card of Object.values(board.cards)) {
    assert.deepEqual([card.created_by, card.updated_by, card.created_at, card.updated_at, card.geo_rev, card.content_rev], ['owner', 'owner', LATER, LATER, 0, 0]);
  }
  for (const con of Object.values(board.connectors)) assert.ok(board.cards[con.from] && board.cards[con.to], 'references rewritten');
  assert.ok(Object.values(board.cards).some((card) => card.group_id && board.groups[card.group_id]));
  assert.equal(model.boardToText(board).text, model.boardToText(original).text, 'the same text content');
  const chat = Object.values(board.cards).find((card) => card.kind === 'chat');
  assert.deepEqual([chat.data.session_id, chat.data.message_id], ['sess_abc', 'msg_1']);
  assert.equal(Object.values(board.cards).find((card) => card.kind === 'file').data.path, 'src/auth/session.ts');
  assert.deepEqual(out.pictures.map((p, i) => [p.ext, Buffer.compare(Buffer.from(p.bytes), [PIC_A, PIC_B][i])]), [['gif', 0], ['gif', 0]]);
  assert.deepEqual(Object.keys(out.pictures[0]).sort(), ['bytes', 'ext'], 'decoded bytes only, no name');
});

test('pack refuses a board the model refuses, a picture that is not bytes, and text over the cap', () => {
  assert.equal(pack({ board: { name: 'x' }, assets: [], now: NOW }).reason, 'invalid');
  assert.equal(pack({ board: fullBoard(), assets: [{ ext: 'svg', bytes: PIC_A }], now: NOW }).reason, 'asset');
  assert.equal(pack({ board: fullBoard(), assets: [{ ext: 'gif', bytes: 'GIF' }], now: NOW }).reason, 'asset');
  const big = Buffer.alloc(model.LIMITS.image_asset_bytes);
  const many = Array.from({ length: 7 }, () => ({ ext: 'png', bytes: big })); // ~93 MiB of base64, refused before it is encoded
  assert.equal(pack({ board: fullBoard(), assets: many, now: NOW }).reason, 'too_large');
  assert.equal(PACKAGE_MAX_BYTES, 64 * 1024 * 1024);
});

test('65 MiB of text is refused before it is parsed', () => {
  const realParse = JSON.parse;
  let parsed = 0;
  JSON.parse = (...args) => { parsed += 1; return realParse(...args); };
  try {
    assert.equal(reasonOf(' '.repeat(65 * 1024 * 1024)), 'too_large');
  } finally {
    JSON.parse = realParse;
  }
  assert.equal(parsed, 0);
});

test('hostile files: each is refused with its own reason and nothing throws', () => {
  const cases = [
    ['not JSON', '{"format": "jennyboard",', 'not_json'],
    ['not text', 42, 'not_json'],
    ['a JSON array', '[1, 2, 3]', 'format'],
    ['format wrong', withValue((v) => { v.format = 'excalidraw'; }), 'format'],
    ['version 2', withValue((v) => { v.version = 2; }), 'version'],
    ['version text', withValue((v) => { v.version = '1'; }), 'format'],
    ['board missing', withValue((v) => { delete v.board; }), 'format'],
    ['exported_at not a time', withValue((v) => { v.exported_at = 'yesterday'; }), 'format'],
    ['a journal', withValue((v) => { v.journal = []; }), 'unknown_key'],
    ['proposals', withValue((v) => { v.proposals = []; }), 'unknown_key'],
    ...['recent_batches', 'id', 'project_id', 'rev'].map((key) => [`board.${key}`, withValue((v) => { v.board[key] = key === 'rev' ? 3 : key === 'recent_batches' ? [] : 'x'; }), 'unknown_key']),
    ...['name', 'asset'].map((key) => [`asset.${key}`, withValue((v) => { v.assets[0][key] = 'f'.repeat(64); }), 'unknown_key']),
    ['a connector to a missing card', withValue((v) => { Object.values(v.board.connectors)[0].to = uid(77); }), 'invalid'],
    ['two cards with one alias', withValue((v) => { const cards = Object.values(v.board.cards).filter((c) => c.kind === 'image'); cards[1].alias = cards[0].alias; }), 'invalid'],
    ['an alias past next_alias', withValue((v) => { v.board.next_alias = 2; }), 'invalid'],
    ['a card in a missing group', withValue((v) => { Object.values(v.board.cards)[0].group_id = uid(78); }), 'invalid'],
    ['a note of 4,001 characters', withValue((v) => { Object.values(v.board.cards).find((c) => c.kind === 'note').data.text = 'x'.repeat(4001); }), 'invalid'],
    ['an unknown card field', withValue((v) => { Object.values(v.board.cards)[0].secret = 1; }), 'invalid'],
    ['base64 that is not base64', withValue((v) => { v.assets[0].base64 = 'not base64!'; }), 'asset'],
    ['an asset that is not a string pair', withValue((v) => { v.assets[0].ext = 5; }), 'asset'],
    ['an asset type that is not a picture', withValue((v) => { v.assets[0].ext = 'svg'; }), 'asset'],
    ['an asset that is not an object', withValue((v) => { v.assets[0] = 'gif'; }), 'asset'],
    ['an asset of 10 MiB + 1 byte', withValue((v) => { v.assets[0].base64 = Buffer.alloc(model.LIMITS.image_asset_bytes + 1).toString('base64'); }), 'asset'],
    ['10,000 asset entries', withValue((v) => { v.assets = Array.from({ length: 10000 }, () => ({ ext: 'gif', base64: PIC_A.toString('base64') })); }), 'limit'],
  ];
  for (const [name, text, reason] of cases) {
    let out;
    assert.doesNotThrow(() => { out = unpack(text, unpackOptions()); }, name);
    assert.equal(out.ok, false, name);
    assert.equal(out.reason, reason, name);
  }
});

test('501 cards come back as the model says (limit), and a document nested 100 levels deep is refused', () => {
  const tooMany = withValue((v) => {
    const card = Object.values(v.board.cards).find((c) => c.kind === 'note');
    v.board.cards = {};
    v.board.connectors = {};
    for (let i = 0; i < 501; i += 1) v.board.cards[uid(2000 + i)] = { ...card, id: uid(2000 + i), alias: null };
  });
  const expected = model.normalizeBoard({ ...JSON.parse(tooMany).board, schema_version: 1, id: `board_${uid(1)}`, project_id: PROJECT, rev: 0,
    created_at: NOW, updated_at: NOW, recent_batches: [] }).reason;
  assert.equal(reasonOf(tooMany), expected);
  assert.equal(expected, 'limit');
  let nested = '"deep"';
  for (let i = 0; i < 100; i += 1) nested = `{"a":${nested}}`;
  assert.equal(reasonOf(withValue((v) => { v.board.cards = 'NESTED'; }).replace('"NESTED"', nested)), 'limit');
  assert.equal(reasonOf(`${'['.repeat(100)}${']'.repeat(100)}`), 'limit');
});

test('a __proto__ key at each level is refused and pollutes nothing', () => {
  const proto = (mutate) => withValue((v) => mutate(v)).replace('"PROTO_KEY"', '"__proto__"');
  assert.equal(reasonOf(proto((v) => { v.PROTO_KEY = { polluted: true }; })), 'unknown_key');
  assert.equal(reasonOf(proto((v) => { v.board.PROTO_KEY = { polluted: true }; })), 'unknown_key');
  assert.equal(reasonOf(proto((v) => { v.assets[0].PROTO_KEY = { polluted: true }; })), 'unknown_key');
  assert.equal(reasonOf(proto((v) => { v.board.cards.PROTO_KEY = { polluted: true }; })), 'invalid');
  assert.equal(reasonOf(proto((v) => { Object.values(v.board.cards)[0].data.PROTO_KEY = { polluted: true }; })), 'invalid');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test('authorship, revisions and times in the file are never kept: a card by someone else comes out the owner\'s', () => {
  const text = withValue((v) => {
    for (const card of Object.values(v.board.cards)) Object.assign(card, { created_by: 'someone-else', updated_by: 'model', geo_rev: 41, content_rev: 7, created_at: '2001-01-01T00:00:00.000Z' });
    for (const group of Object.values(v.board.groups)) Object.assign(group, { geo_rev: 9, content_rev: 9 });
    for (const con of Object.values(v.board.connectors)) con.content_rev = 5;
  });
  const out = unpack(text, unpackOptions());
  assert.equal(out.ok, true, JSON.stringify(out));
  for (const card of Object.values(out.board.cards)) assert.deepEqual([card.created_by, card.updated_by, card.geo_rev, card.content_rev, card.created_at], ['owner', 'owner', 0, 0, LATER]);
  for (const group of Object.values(out.board.groups)) assert.deepEqual([group.geo_rev, group.content_rev], [0, 0]);
  for (const con of Object.values(out.board.connectors)) assert.equal(con.content_rev, 0);
});

test('the next short name is counted from the items in the file, so a number at the ceiling cannot close the board (wave 10 review)', () => {
  const CEILING = 999999999;
  const highest = (board) => Math.max(...[...Object.values(board.cards), ...Object.values(board.groups)].map((item) => Number(item.alias.slice(1))));
  const out = unpack(withValue((v) => { v.board.next_alias = CEILING + 1; }), unpackOptions());
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.board.next_alias, highest(out.board) + 1);
  const added = model.applyBatch(out.board, { batch_id: 'after', board_id: out.board.id, actor: 'owner',
    ops: [{ op: 'card.add', card: { id: uid(700), kind: 'note', data: { text: 'Still room' } } }] }, { now: LATER, authority: true });
  assert.equal(added.ok, true, JSON.stringify(added));
  // An item that holds the ceiling itself leaves no number to give: refused, not imported closed.
  const top = withValue((v) => { v.board.next_alias = CEILING + 1; Object.values(v.board.cards)[0].alias = `n${CEILING}`; });
  assert.deepEqual(unpack(top, unpackOptions()), { ok: false, reason: 'limit', limit: 'aliases' });
  // A board with nothing on it starts at 1.
  const empty = unpack(withValue((v) => { Object.assign(v.board, { next_alias: 77, cards: {}, connectors: {}, groups: {} }); v.assets = []; }), unpackOptions());
  assert.deepEqual([empty.ok, empty.board.next_alias], [true, 1]);
});

test('an image card whose picture is not in the file stays on the board; a name handed in replaces the file\'s', () => {
  const text = withValue((v) => { v.assets = []; });
  const out = unpack(text, { ...unpackOptions(), name: 'Plan (imported)' });
  assert.equal(out.ok, true);
  assert.equal(Object.values(out.board.cards).filter((card) => card.kind === 'image').length, 2);
  assert.deepEqual(out.pictures, []);
  assert.equal(out.board.name, 'Plan (imported)');
  assert.equal(unpack(packed(), { ...unpackOptions(), projectId: 'not a project' }).reason, 'invalid');
});
