'use strict';

// new-test-file: renderer/features/board/board-diagram-break.js is a new pure module (row 150 slice B9: a drawing's outline
// becomes notes, groups and connectors); it is checked against the real board model so every batch it builds really applies.

const test = require('node:test');
const assert = require('node:assert/strict');

const model = require('../services/boards/board-model');
const { buildParts } = require('../renderer/features/board/board-diagram-break');

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BOARD_ID = 'board_00000000-0000-4000-8000-0000000000bb';
const NOW = '2026-11-13T12:00:00.000Z';
const DIAGRAM = uid(500);
const LIMITS = model.LIMITS;

function boardWith(extra = []) {
  const made = model.createBoard({ id: BOARD_ID, project_id: 'project_alpha', name: 'Plan', now: NOW });
  const ops = [{ op: 'card.add', card: { id: DIAGRAM, kind: 'diagram', data: { scene: 'a A\nb B\na -> b', title: '' }, x: 100, y: 200, w: 360, h: 260 } }]
    .concat(extra);
  const out = model.applyBatch(made.board, { batch_id: 'seed', board_id: made.board.id, actor: 'owner', ops }, { now: NOW });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out.board;
}
function counter(start = 9000) { let n = start; return () => uid(n++); }
function build(board, outline, extra = {}) {
  return buildParts({ card: board.cards[DIAGRAM], outline, board, makeId: counter(), limits: LIMITS, ...extra });
}
const node = (id, label = id.toUpperCase(), group = '') => ({ id, label, group });
const edge = (from, to, label = '', dashed = false) => ({ from, to, label, dashed });
const rectOf = (c) => ({ x: c.x, y: c.y, w: c.w, h: c.h });
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const near = (a, b, gap) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
const adds = (ops, kind) => ops.filter((op) => op.op === kind);

function applyAll(board, result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  const out = model.applyBatch(board, { batch_id: 'break', board_id: board.id, actor: 'owner', ops: result.ops }, { now: NOW });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out;
}

const OUTLINE = () => ({
  nodes: [node('a', 'Alpha', 'g'), node('b', 'Beta', 'g'), node('c', 'Gamma'), node('d', 'Delta')],
  groups: [{ id: 'g', label: 'Core', parent: '' }],
  edges: [edge('a', 'b', 'next'), edge('b', 'c', '', true), edge('c', 'd')],
  positions: { a: { x: 0, y: 0 }, b: { x: 160, y: 0 }, c: { x: 320, y: 0 }, d: { x: 320, y: 90 } },
});

test('nodes, groups and edges become notes, groups and connectors, and the diagram card is removed last', () => {
  const board = boardWith();
  const result = build(board, OUTLINE());
  assert.equal(result.ok, true);
  assert.deepEqual(result.ops.map((op) => op.op), ['group.add', 'card.add', 'card.add', 'card.add', 'card.add', 'connector.add', 'connector.add', 'connector.add', 'card.remove']);
  assert.equal(result.ops.at(-1).id, DIAGRAM);
  const groupOp = adds(result.ops, 'group.add')[0].group;
  assert.equal(groupOp.title, 'Core');
  const notes = adds(result.ops, 'card.add').map((op) => op.card);
  assert.deepEqual(notes.map((c) => c.data), [{ text: 'Alpha', tone: null }, { text: 'Beta', tone: null }, { text: 'Gamma', tone: null }, { text: 'Delta', tone: null }]);
  assert.deepEqual(notes.map((c) => c.group_id), [groupOp.id, groupOp.id, undefined, undefined]);
  assert.ok(notes.every((c) => c.kind === 'note' && c.w === 200 && c.h === 88 && Number.isFinite(c.x) && Number.isFinite(c.y)));
  const cons = adds(result.ops, 'connector.add').map((op) => op.connector);
  assert.deepEqual(cons.map((c) => [c.label, c.style, c.ends]), [['next', 'solid', 'end'], ['', 'dashed', 'end'], ['', 'solid', 'end']]);
  assert.deepEqual([cons[0].from, cons[0].to], [notes[0].id, notes[1].id]);
  assert.deepEqual(result.selectIds, notes.map((c) => c.id));
  const all = result.ops.flatMap((op) => [op.card && op.card.id, op.group && op.group.id, op.connector && op.connector.id]).filter(Boolean);
  assert.equal(new Set(all).size, all.length, 'every new item has its own id');
});

test('with a card in the way, the parts sit to the right of everything, start at the card\'s height, never overlap and keep their gap', () => {
  const board = boardWith([
    { op: 'card.add', card: { id: uid(503), kind: 'note', data: { text: 'in the way', tone: null }, x: 480, y: 200, w: 240, h: 160 } },
    { op: 'card.add', card: { id: uid(501), kind: 'note', data: { text: 'far', tone: null }, x: 2000, y: 40, w: 240, h: 160 } },
    { op: 'group.add', group: { id: uid(502), title: 'Wide', x: 0, y: 900, w: 3000, h: 200 } },
  ]);
  const result = build(board, OUTLINE());
  const notes = adds(result.ops, 'card.add').map((op) => op.card);
  const groups = adds(result.ops, 'group.add').map((op) => op.group);
  const edgeRight = 3000;
  const items = notes.map(rectOf).concat(groups.map(rectOf));
  assert.equal(Math.min(...items.map((r) => r.x)), edgeRight + 96);
  assert.equal(Math.min(...items.map((r) => r.y)), 200);
  notes.forEach((a, i) => notes.slice(i + 1).forEach((b) => assert.equal(near(rectOf(a), rectOf(b), 24), false, 'a gap of at least 24')));
  const old = Object.values(board.cards).map(rectOf).concat(Object.values(board.groups).map(rectOf));
  items.forEach((r) => old.forEach((o) => assert.equal(hit(r, o), false)));
  const g = groups[0];
  notes.filter((c) => c.group_id === g.id).forEach((c) => assert.ok(c.x >= g.x + 16 && c.y >= g.y + 40 && c.x + c.w + 16 <= g.x + g.w && c.y + c.h + 16 <= g.y + g.h, 'inside with padding'));
  const left = notes.map((c) => c.x);
  assert.ok(left[0] < left[1] && left[1] < left[2], 'the drawing\'s left to right order is kept');
  assert.ok(notes[3].y > notes[2].y, 'and its top to bottom order');
});

test('the batch applies on a real board, the diagram card is gone, and one inverse brings it back and removes every part', () => {
  const board = boardWith();
  const result = build(board, OUTLINE());
  const out = applyAll(board, result);
  assert.equal(out.board.cards[DIAGRAM], undefined);
  assert.equal(Object.keys(out.board.cards).length, 4);
  assert.equal(Object.keys(out.board.connectors).length, 3);
  assert.equal(Object.keys(out.board.groups).length, 1);
  result.selectIds.forEach((id) => assert.ok(out.board.cards[id]));
  const back = model.applyInverse(out.board, out.inverse, { now: NOW, batch_id: 'undo-break' });
  assert.equal(back.ok, true);
  assert.deepEqual(back.skipped, []);
  assert.deepEqual(Object.keys(back.board.cards), [DIAGRAM]);
  assert.deepEqual(back.board.cards[DIAGRAM].data, board.cards[DIAGRAM].data);
  assert.deepEqual(back.board.connectors, {});
  assert.deepEqual(back.board.groups, {});
});

test('nested groups are flattened: a node belongs to its innermost group, and a group with no node of its own is not made', () => {
  const board = boardWith();
  const outline = {
    nodes: [node('a', 'A', 'inner'), node('b', 'B', 'outer'), node('c', 'C', 'ghost')],
    groups: [{ id: 'outer', label: 'Outer', parent: '' }, { id: 'inner', label: 'Inner', parent: 'outer' }, { id: 'empty', label: 'Empty', parent: '' }],
    edges: [], positions: null,
  };
  const result = build(board, outline);
  const groups = adds(result.ops, 'group.add').map((op) => op.group);
  assert.deepEqual(groups.map((g) => g.title).sort(), ['Inner', 'Outer']);
  const byTitle = Object.fromEntries(groups.map((g) => [g.title, g.id]));
  const notes = adds(result.ops, 'card.add').map((op) => op.card);
  assert.equal(notes.find((c) => c.data.text === 'A').group_id, byTitle.Inner);
  assert.equal(notes.find((c) => c.data.text === 'B').group_id, byTitle.Outer);
  assert.equal(notes.find((c) => c.data.text === 'C').group_id, undefined, 'a group that does not exist leaves the note free');
  applyAll(board, result);
  const alone = build(board, { nodes: [node('a', 'A', 'inner')], groups: outline.groups, edges: [], positions: null });
  assert.equal(adds(alone.ops, 'group.add').length, 1, 'the outer group holds nothing of its own');
});

test('an edge to an unknown node, an edge from a node to itself and nothing else are dropped', () => {
  const board = boardWith();
  const outline = { nodes: [node('a'), node('b')], groups: [], edges: [edge('a', 'b'), edge('a', 'zzz'), edge('zzz', 'b'), edge('a', 'a')], positions: null };
  const result = build(board, outline);
  assert.equal(adds(result.ops, 'connector.add').length, 1);
  applyAll(board, result);
});

test('without positions, or with positions that pile up, a grid keeps the notes apart', () => {
  const board = boardWith();
  const nodes = Array.from({ length: 7 }, (_, i) => node(`n${i}`, `Note ${i}`));
  for (const positions of [null, {}, 'x', { n0: { x: 0, y: 0 } }, Object.fromEntries(nodes.map((n) => [n.id, { x: 5, y: 5 }])), Object.fromEntries(nodes.map((n) => [n.id, { x: NaN, y: 1 }]))]) {
    const result = build(board, { nodes, groups: [], edges: [], positions });
    assert.equal(result.ok, true);
    const notes = adds(result.ops, 'card.add').map((op) => rectOf(op.card));
    notes.forEach((a, i) => notes.slice(i + 1).forEach((b) => assert.equal(near(a, b, 24), false)));
    assert.deepEqual(notes.map((r) => [r.x, r.y]), [...notes].sort((p, q) => p.y - q.y || p.x - q.x).map((r) => [r.x, r.y]), 'grid order is outline order');
    applyAll(board, result);
  }
});

test('two groups whose boxes would overlap are laid out as blocks, left to right, with free notes after them', () => {
  const board = boardWith();
  const outline = {
    nodes: [node('a1', 'A1', 'ga'), node('b1', 'B1', 'gb'), node('a2', 'A2', 'ga'), node('f', 'Free')],
    groups: [{ id: 'ga', label: 'A', parent: '' }, { id: 'gb', label: 'B', parent: '' }],
    edges: [edge('a1', 'b1')],
    positions: { a1: { x: 0, y: 0 }, b1: { x: 300, y: 0 }, a2: { x: 600, y: 0 }, f: { x: 300, y: 300 } },
  };
  const result = build(board, outline);
  assert.equal(result.ok, true);
  const groups = adds(result.ops, 'group.add').map((op) => op.group);
  const notes = adds(result.ops, 'card.add').map((op) => op.card);
  assert.equal(hit(rectOf(groups[0]), rectOf(groups[1])), false, 'the boxes do not overlap');
  const free = notes.find((c) => c.data.text === 'Free');
  groups.forEach((g) => assert.equal(hit(rectOf(g), rectOf(free)), false, 'a free note is outside every box'));
  assert.ok(free.x >= Math.max(...groups.map((g) => g.x + g.w)), 'free notes come after the groups');
  groups.forEach((g) => notes.filter((c) => c.group_id === g.id).forEach((c) => assert.ok(c.x >= g.x + 16 && c.y >= g.y + 40 && c.x + c.w + 16 <= g.x + g.w && c.y + c.h + 16 <= g.y + g.h)));
  applyAll(board, result);
});

test('an outline with no nodes is empty; too many operations or a full board is too_many; bad input is invalid', () => {
  const board = boardWith();
  assert.deepEqual(build(board, { nodes: [], groups: [], edges: [], positions: null }), { ok: false, reason: 'empty' });
  const many = Array.from({ length: 120 }, (_, i) => node(`n${i}`));
  const links = Array.from({ length: 119 }, (_, i) => edge(`n${i}`, `n${i + 1}`));
  assert.deepEqual(build(board, { nodes: many, groups: [], edges: links, positions: null }), { ok: false, reason: 'too_many' }, '120 notes and 119 arrows is over 200 operations');
  assert.equal(build(board, { nodes: many.slice(0, 80), groups: [], edges: links.slice(0, 79), positions: null }).ok, true);
  const full = { cards: 5, groups: 1, connectors: 3, batch_ops: 200 };
  assert.equal(build(board, OUTLINE(), { limits: full }).ok, true, 'the notes are added before the diagram goes: one card and four notes fit in five');
  assert.equal(build(board, OUTLINE(), { limits: { ...full, cards: 4 } }).reason, 'too_many');
  assert.equal(build(board, OUTLINE(), { limits: { ...full, groups: 0 } }).reason, 'too_many');
  assert.equal(build(board, OUTLINE(), { limits: { ...full, connectors: 2 } }).reason, 'too_many');
  const bad = [null, {}, { card: board.cards[DIAGRAM] }, { card: board.cards[DIAGRAM], outline: null, board, makeId: counter() },
    { card: board.cards[DIAGRAM], outline: { nodes: 'x' }, board, makeId: counter(), limits: LIMITS },
    { card: board.cards[DIAGRAM], outline: OUTLINE(), board, makeId: null, limits: LIMITS },
    { card: { id: 'x' }, outline: OUTLINE(), board, makeId: counter(), limits: LIMITS }];
  bad.forEach((input) => { let out; assert.doesNotThrow(() => { out = buildParts(input); }); assert.equal(out.ok, false); assert.equal(out.reason, 'invalid'); });
});

test('a label of 4,001 characters, one with control characters, and an empty label do not make the batch fail', () => {
  const board = boardWith();
  const outline = {
    nodes: [node('long', 'x'.repeat(4001), 'g'), node('ctl', 'one\u0000two\u001bthree\nfour\u2028five'), node('blank', ''), node('only-controls', '\u0001\u0002')],
    groups: [{ id: 'g', label: `${'t'.repeat(300)}\n\u0007`, parent: '' }],
    edges: [edge('long', 'ctl', `${'e'.repeat(500)}\n\u0000`), edge('ctl', 'blank', '\u0009tab')],
    positions: null,
  };
  const result = build(board, outline);
  assert.equal(result.ok, true);
  const notes = adds(result.ops, 'card.add').map((op) => op.card);
  assert.ok(notes[0].data.text.length <= LIMITS.note_chars);
  assert.equal(notes[2].data.text, 'blank', 'an empty label shows the id');
  assert.ok(notes[3].data.text.length > 0);
  const out = applyAll(board, result);
  assert.ok(Object.values(out.board.groups)[0].title.length <= 200);
  Object.values(out.board.connectors).forEach((c) => assert.ok(c.label.length <= 200));
});

// ------------------------------------------------------------------ cards first (2026-11-15): in place, as a row, still connected

const CHAIN = () => ({
  nodes: [node('a', 'Request'), node('b', 'Route'), node('c', 'Auth'), node('d', 'Handler')], groups: [],
  edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')],
  positions: { a: { x: 0, y: 0 }, b: { x: 400, y: 30 }, c: { x: 900, y: 0 }, d: { x: 1700, y: 10 } },
});

test('a chain of steps breaks apart where the card was, as an even row, inside the card\'s group, which grows to hold it', () => {
  const GROUP = uid(600);
  const made = model.createBoard({ id: BOARD_ID, project_id: 'project_alpha', name: 'Plan', now: NOW });
  const seeded = model.applyBatch(made.board, { batch_id: 'seed', board_id: made.board.id, actor: 'owner', ops: [
    { op: 'group.add', group: { id: GROUP, title: 'API router', x: 80, y: 150, w: 420, h: 340 } },
    { op: 'card.add', card: { id: DIAGRAM, kind: 'diagram', data: { scene: 'a A', title: '' }, x: 100, y: 200, w: 360, h: 260, group_id: GROUP } },
  ] }, { now: NOW });
  const board = seeded.board;
  const result = build(board, CHAIN());
  const notes = adds(result.ops, 'card.add').map((op) => op.card);
  assert.deepEqual(notes.map((c) => [c.x, c.y]), [[100, 200], [348, 200], [596, 200], [844, 200]], 'the card\'s corner, then every 248');
  assert.ok(notes.every((c) => c.group_id === GROUP));
  assert.deepEqual(result.ops.at(-2), { op: 'group.place', id: GROUP, w: 844 + 200 + 16 - 80, h: 340 });
  const out = applyAll(board, result);
  const box = out.board.groups[GROUP];
  Object.values(out.board.cards).forEach((c) => assert.ok(c.x + c.w + 16 <= box.x + box.w && c.y + c.h + 16 <= box.y + box.h));
  const back = model.applyInverse(out.board, out.inverse, { now: NOW, batch_id: 'undo-break' });
  assert.deepEqual([back.ok, Object.keys(back.board.cards), back.board.groups[GROUP].w], [true, [DIAGRAM], 420], 'one Undo puts the card and the group back');
});

test('a connector that ended on the diagram card is drawn again to the part nearest its other end', () => {
  const under = (id, x) => ({ op: 'card.add', card: { id, kind: 'note', data: { text: 'remark', tone: null }, x, y: 520, w: 200, h: 100 } });
  const link = (id, from, to, label, style) => ({ op: 'connector.add', connector: { id, from, to, label, style, ends: 'end' } });
  const board = boardWith([under(uid(601), 100), under(uid(602), 860),
    link(uid(611), uid(601), DIAGRAM, 'risk', 'dashed'), link(uid(612), DIAGRAM, uid(602), '', 'solid')]);
  const result = build(board, CHAIN());
  const notes = adds(result.ops, 'card.add').map((op) => op.card);
  assert.equal(notes[0].x, 100, 'the remarks sit below the row, so the parts take the card\'s place');
  const again = adds(result.ops, 'connector.add').map((op) => op.connector).slice(3);
  assert.deepEqual(again.map((c) => [c.from, c.to, c.label, c.style]), [[uid(601), notes[0].id, 'risk', 'dashed'], [notes[3].id, uid(602), '', 'solid']]);
  const out = applyAll(board, result);
  assert.equal(Object.keys(out.board.connectors).length, 5, 'three arrows of the drawing and the two that were on the card');
  assert.equal(build(board, CHAIN(), { limits: { ...LIMITS, connectors: 6 } }).reason, 'too_many', 'the two old connectors still count until the card goes');
});
