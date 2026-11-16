'use strict';

// new-test-file: services/boards/board-tidy.js is a new pure module (row 150 slice B9: arranging cards in a grid);
// its operations are checked against the real board model, which is why this is not part of board-model.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const model = require('../services/boards/board-model');
const placement = require('../services/boards/board-placement');
const tidy = require('../services/boards/board-tidy');

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BOARD_ID = 'board_00000000-0000-4000-8000-0000000000aa';
const NOW = '2026-11-13T12:00:00.000Z';
const G = uid(700);
const G2 = uid(701);

function fresh() {
  const made = model.createBoard({ id: BOARD_ID, project_id: 'project_alpha', name: 'Plan', now: NOW });
  assert.equal(made.ok, true);
  return made.board;
}
function apply(board, ops, batchId = `b${board.rev}`) {
  const out = model.applyBatch(board, { batch_id: batchId, board_id: board.id, actor: 'owner', ops }, { now: NOW });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out;
}
const note = (id, x, y, extra = {}) => ({ op: 'card.add', card: { id, kind: 'note', data: { text: id.slice(-3), tone: null }, x, y, w: 200, h: 100, ...extra } });
const group = (id, x, y, w, h) => ({ op: 'group.add', group: { id, title: 'Group', x, y, w, h } });
const rectOf = (item) => ({ x: item.x, y: item.y, w: item.w, h: item.h });
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const ids = (list) => list.map((n) => uid(n));

/** A group G at (100,100) holding five 200x100 notes 801..805 in a scrambled order. */
function groupBoard() {
  const spots = { 801: [140, 300], 802: [500, 140], 803: [140, 140], 804: [500, 300], 805: [820, 140] };
  const ops = [group(G, 100, 100, 1200, 600)].concat(Object.keys(spots).map((n) => note(uid(n), spots[n][0], spots[n][1], { group_id: G })));
  return apply(fresh(), ops).board;
}
function applyOps(board, result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ops.length) return board;
  return apply(board, result.ops, `tidy${board.rev}`).board;
}

test('a group of five becomes a three-column grid inside the group, in reading order, and the group fits it', () => {
  const board = groupBoard();
  const before = JSON.stringify(board);
  const result = tidy.tidyOps(board, { groupId: G });
  assert.equal(JSON.stringify(board), before, 'the board is not touched');
  assert.equal(result.ok, true);
  assert.ok(result.ops.every((op) => op.op === 'card.place' || op.op === 'group.place'));
  const next = applyOps(board, result);
  // Reading order: 803 (140,140), 802 (500,140), 805 (820,140), 801 (140,300), 804 (500,300).
  const order = [803, 802, 805, 801, 804];
  order.forEach((n, i) => {
    const card = next.cards[uid(n)];
    assert.deepEqual([card.x, card.y], [100 + 16 + (i % 3) * 224, 100 + 40 + Math.floor(i / 3) * 124], `card ${n}`);
    assert.deepEqual([card.w, card.h], [200, 100], 'sizes are kept');
  });
  const g = next.groups[G];
  assert.deepEqual([g.x, g.y, g.w, g.h], [100, 100, 3 * 200 + 2 * 24 + 32, 2 * 100 + 24 + 16 + 40]);
  assert.ok(Object.values(next.cards).every((c) => c.x >= g.x && c.y >= g.y && c.x + c.w <= g.x + g.w && c.y + c.h <= g.y + g.h));
  result.ops.forEach((op) => assert.ok(Number.isInteger(op.x ?? 0) && Number.isInteger(op.y ?? 0) && Number.isInteger(op.w ?? 0) && Number.isInteger(op.h ?? 0)));
});

test('tidying twice gives no operations the second time, and an empty group gives none at all', () => {
  const board = groupBoard();
  const once = applyOps(board, tidy.tidyOps(board, { groupId: G }));
  assert.deepEqual(tidy.tidyOps(once, { groupId: G }), { ok: true, ops: [] });
  const whole = applyOps(board, tidy.tidyOps(board, {}));
  assert.deepEqual(tidy.tidyOps(whole, {}), { ok: true, ops: [] });
  const empty = apply(fresh(), [group(G, 10, 10, 300, 200)]).board;
  assert.deepEqual(tidy.tidyOps(empty, { groupId: G }), { ok: true, ops: [] });
});

test('a card with a fractional size still lands on whole numbers and keeps its neighbours apart', () => {
  const board = apply(fresh(), [note(uid(801), 0, 0, { w: 200.5, h: 100.25 }), note(uid(802), 10, 0), note(uid(803), 20, 0)]).board;
  const next = applyOps(board, tidy.tidyOps(board, { ids: ids([801, 802, 803]) }));
  Object.values(next.cards).forEach((c) => assert.ok(Number.isInteger(c.x) && Number.isInteger(c.y)));
  const list = Object.values(next.cards);
  list.forEach((a, i) => list.slice(i + 1).forEach((b) => assert.equal(hit(rectOf(a), rectOf(b)), false)));
});

test('{ ids } arranges free cards from the corner of their box; grouped cards in a mixed list are left out', () => {
  const board = apply(fresh(), [
    group(G, 1000, 1000, 600, 400),
    note(uid(801), 300, 200), note(uid(802), 700, 220), note(uid(803), 320, 600),
    note(uid(804), 1040, 1050, { group_id: G }),
  ]).board;
  const result = tidy.tidyOps(board, { ids: ids([801, 802, 803, 804]) });
  const next = applyOps(board, result);
  assert.deepEqual([next.cards[uid(801)].x, next.cards[uid(801)].y], [300, 200], 'the corner of the box');
  assert.deepEqual([next.cards[uid(802)].x, next.cards[uid(802)].y], [300 + 224, 200]);
  assert.deepEqual([next.cards[uid(803)].x, next.cards[uid(803)].y], [300, 200 + 124]);
  assert.deepEqual([next.cards[uid(804)].x, next.cards[uid(804)].y], [1040, 1050], 'the grouped card stayed');
  assert.deepEqual(rectOf(next.groups[G]), rectOf(board.groups[G]));
  assert.equal(result.ops.some((op) => op.id === uid(804) || op.id === G), false);
});

test('{ ids } of cards that all sit in one group arranges them from their own corner, and the group still fits every member', () => {
  const board = groupBoard();
  const result = tidy.tidyOps(board, { ids: ids([803, 802]) });
  const next = applyOps(board, result);
  assert.deepEqual([next.cards[uid(803)].x, next.cards[uid(803)].y], [140, 140]);
  assert.deepEqual([next.cards[uid(802)].x, next.cards[uid(802)].y], [140 + 224, 140]);
  assert.deepEqual([next.cards[uid(801)].x, next.cards[uid(801)].y], [140, 300], 'a member not listed stays');
  const g = next.groups[G];
  Object.values(next.cards).forEach((c) => assert.ok(c.x + c.w + 16 <= g.x + g.w && c.y + c.h + 16 <= g.y + g.h, 'inside with padding'));
});

test('the whole board packs groups and free cards into rows without overlap, members stay inside their group, and one undo puts everything back', () => {
  const ops = [
    group(G, 100, 100, 900, 500), group(G2, 2000, 100, 600, 400),
    note(uid(801), 150, 160, { group_id: G }), note(uid(802), 450, 160, { group_id: G }), note(uid(803), 750, 160, { group_id: G }),
    note(uid(804), 2050, 160, { group_id: G2 }), note(uid(805), 2300, 300, { group_id: G2 }),
  ];
  for (let i = 0; i < 9; i += 1) ops.push(note(uid(810 + i), 40 + ((i * 397) % 3000), 900 + ((i * 211) % 700)));
  const board = apply(fresh(), ops).board;
  const result = tidy.tidyOps(board, {});
  assert.equal(result.ok, true);
  const applied = apply(board, result.ops, 'tidy-whole');
  const next = applied.board;
  const blocks = Object.values(next.groups).map(rectOf).concat(Object.values(next.cards).filter((c) => !c.group_id).map(rectOf));
  blocks.forEach((a, i) => blocks.slice(i + 1).forEach((b) => assert.equal(hit(a, b), false, 'two blocks overlap')));
  Object.values(next.cards).filter((c) => c.group_id).forEach((c) => {
    const g = next.groups[c.group_id];
    assert.ok(c.x >= g.x + 16 && c.y >= g.y + 40 && c.x + c.w + 16 <= g.x + g.w && c.y + c.h + 16 <= g.y + g.h, 'a member is inside its group');
  });
  const widest = Math.max(...blocks.map((b) => b.w));
  const left = Math.min(...blocks.map((b) => b.x));
  assert.ok(Math.max(...blocks.map((b) => b.x + b.w)) - left <= Math.max(1600, widest), 'rows wrap at the width');
  const back = model.applyInverse(next, applied.inverse, { now: NOW, batch_id: 'undo-tidy' });
  assert.equal(back.ok, true);
  assert.deepEqual(back.skipped, []);
  Object.values(board.cards).forEach((c) => assert.deepEqual(rectOf(back.board.cards[c.id]), rectOf(c)));
  Object.values(board.groups).forEach((g) => assert.deepEqual(rectOf(back.board.groups[g.id]), rectOf(g)));
});

test('a group moves with its members: one group.place and one card.place each, only the fields that change', () => {
  const board = apply(fresh(), [
    note(uid(801), 0, 0),
    group(G, 600, 300, 400, 300), note(uid(802), 640, 360, { group_id: G }),
  ]).board;
  const result = tidy.tidyOps(board, {});
  const places = result.ops.filter((op) => op.id === G || op.id === uid(802));
  assert.equal(places.filter((op) => op.op === 'group.place').length, 1);
  assert.equal(places.filter((op) => op.op === 'card.place').length, 1);
  result.ops.forEach((op) => assert.ok(Object.keys(op).every((key) => ['op', 'id', 'x', 'y', 'w', 'h'].includes(key))));
  result.ops.filter((op) => op.op === 'card.place').forEach((op) => assert.deepEqual(Object.keys(op).sort(), ['id', 'op', 'x', 'y']));
});

test('past 200 operations the answer is too_many; unknown groups and cards are not_found', () => {
  let board = fresh();
  for (let part = 0; part < 2; part += 1) {
    const ops = [];
    for (let i = 0; i < 105; i += 1) { const n = part * 105 + i; ops.push(note(uid(1000 + n), 5000 + (n % 7) * 13, n * 150)); }
    board = apply(board, ops).board;
  }
  assert.deepEqual(tidy.tidyOps(board, {}), { ok: false, reason: 'too_many' });
  assert.deepEqual(tidy.tidyOps(board, { ids: ids([1000, 1001]) }).ok, true);
  assert.deepEqual(tidy.tidyOps(groupBoard(), { groupId: uid(999) }), { ok: false, reason: 'not_found' });
  assert.deepEqual(tidy.tidyOps(groupBoard(), { ids: ids([998, 999]) }), { ok: false, reason: 'not_found' });
});

test('hostile input answers invalid and never throws', () => {
  const board = groupBoard();
  const hostile = JSON.parse(JSON.stringify(board));
  Object.defineProperty(hostile.cards, '__proto__', { value: { id: '__proto__', x: 1, y: 1, w: 10, h: 10, group_id: null }, enumerable: true });
  const nan = JSON.parse(JSON.stringify(board));
  nan.cards[uid(801)].x = NaN;
  const huge = JSON.parse(JSON.stringify(board));
  huge.cards[uid(801)].w = Infinity;
  const cases = [
    [null, {}], [undefined, {}], ['board', {}], [[], {}], [{}, {}], [{ cards: [], groups: {} }, {}],
    [board, null], [board, 'x'], [board, []], [board, { groupId: 5 }], [board, { ids: 'nope' }], [board, { ids: [] }], [board, { ids: [5, null] }],
    [hostile, {}], [hostile, { groupId: G }], [nan, {}], [nan, { groupId: G }], [huge, { ids: ids([801]) }],
    [board, { groupId: '__proto__' }], [board, { ids: ['__proto__'] }],
  ];
  for (const [input, target] of cases) {
    let out;
    assert.doesNotThrow(() => { out = tidy.tidyOps(input, target); });
    assert.deepEqual(out, { ok: false, reason: out.reason }, 'a refusal');
    assert.ok(['invalid', 'not_found'].includes(out.reason));
  }
  assert.equal(tidy.tidyOps(hostile, {}).reason, 'invalid');
  assert.equal(tidy.tidyOps(nan, {}).reason, 'invalid');
  assert.equal(tidy.tidyOps(board, null).reason, 'invalid');
  assert.equal(tidy.tidyOps(board, { groupId: G, ids: ids([801]) }).reason, 'invalid', 'one target at a time');
});

test('the constants equal the placement module, checked against groups the model placed', () => {
  assert.deepEqual([tidy.GAP, tidy.PAD, tidy.HEADER], [24, 16, 40]);
  const base = apply(fresh(), [group(G, 100, 100, 500, 300)]).board;
  const cards = [801, 802, 803, 804].map((n) => note(uid(n), undefined, undefined, { group_id: G, x: undefined, y: undefined }));
  const out = apply(base, cards).board;
  const [a, b, c] = [801, 802, 803].map((n) => out.cards[uid(n)]);
  assert.deepEqual([a.x, a.y], [100 + tidy.PAD, 100 + tidy.HEADER], 'the first card of a group');
  assert.equal(b.x - (a.x + a.w), tidy.GAP, 'the gap between two cards');
  assert.equal(c.y - (a.y + a.h), tidy.GAP, 'and between two rows');
  const narrow = apply(fresh(), [group(G, 100, 100, 300, 300)]).board;
  const grown = placement.placeNewCards(narrow, [{ id: uid(804), kind: 'note', w: 600, h: 100, group_id: G }]);
  assert.equal(grown.grown[G].w, tidy.PAD + 600 + tidy.PAD, 'padding at the side the group grew');
  assert.deepEqual(tidy.tidyOps(out, { groupId: G }).ops.filter((op) => op.op === 'card.place'), [], 'a group the model placed is already tidy');
});

test('the Tidy tool registers itself with the card kinds seam as one toolbar tool that runs the editor command', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const kinds = require('../renderer/features/board/board-card-kinds');
  const { createTidyTool } = require('../renderer/features/board/board-tidy-tool');
  const registered = [];
  const sandbox = { rendererBoardCardKinds: { register: (name, factory) => registered.push([name, factory]) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/features/board/board-tidy-tool.js'), 'utf8'), sandbox);
  assert.deepEqual(registered.map(([name]) => name), ['tidy']);
  assert.equal(typeof registered[0][1], 'function');
  const calls = [];
  const parts = kinds.createBoardCardKinds({ factories: new Map([['tidy', createTidyTool]]), editor: { tidy: () => { calls.push('tidy'); return Promise.resolve({ ok: true }); } } });
  assert.equal(parts.tools().length, 1);
  const [tool] = parts.tools();
  assert.deepEqual([tool.id, tool.order, tool.label], ['tidy', 60, 'Tidy']);
  assert.equal(tool.title, 'Arrange the selected group or cards in a grid. With nothing selected, the whole board.');
  await tool.run();
  assert.deepEqual(calls, ['tidy']);
  assert.equal(createTidyTool({}), null, 'no editor, no tool');
  assert.equal(createTidyTool(null), null);
});
