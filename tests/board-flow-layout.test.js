'use strict';

// new-test-file: services/boards/board-flow-layout.js is a new pure module (cards first, 2026-11-15: a chain of
// connected cards laid out as a row). It is checked here through the real proposal reader and the real board model.

const test = require('node:test');
const assert = require('node:assert/strict');

const model = require('../services/boards/board-model');
const flow = require('../services/boards/board-flow-layout');
const { readProposal } = require('../services/boards/board-proposal-reader');
const { planAdditions } = require('../services/boards/board-proposal-apply');

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BOARD_ID = 'board_00000000-0000-4000-8000-0000000000aa';
const NOW = '2026-11-15T12:00:00.000Z';
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a, box) => a.x >= box.x && a.y >= box.y && a.x + a.w <= box.x + box.w && a.y + a.h <= box.y + box.h;

function fresh() {
  const made = model.createBoard({ id: BOARD_ID, project_id: 'project_alpha', name: 'Plan', now: NOW });
  assert.equal(made.ok, true);
  return made.board;
}
function counter(start) {
  let n = start;
  return () => uid(n++);
}
/** The board a `board` block leads to once its additions are accepted, with the cards by the first words of their text. */
function accept(board, lines, firstId = 100) {
  const makeId = counter(firstId);
  const read = readProposal({ board, bodies: [lines.join('\n')], sketches: [], sentWhole: [], files: new Map(), makeId });
  const plan = planAdditions(board, read.changes.filter((c) => c.state === 'pending'), { now: NOW, makeId });
  const cards = Object.values(plan.board.cards);
  const card = (start) => cards.find((c) => c.kind === 'note' && c.data.text.startsWith(start));
  return { read, plan, cards, card, groups: Object.values(plan.board.groups) };
}

const ROUTER = [
  'group API router as r',
  'note **Incoming request** in r as s1',
  '  | A client calls',
  'note **Route match** in r as s2',
  'note **Auth check** in r as s3',
  'note **Input validation** in r as s4',
  'note **Handler and log** in r as s5',
  's1 -> s2', 's2 -> s3', 's3 -> s4', 's4 -> s5',
  'note The router is the only public entry point in r as n1',
  'note Missing object-level authz = IDOR in r as n3',
  'note No audit log = breach goes undetected until too late in r as n5',
  'n1 --> s1', 'n3 --> s3', 's5 --> n5',
];

test('a chain of new notes becomes a row, each remark under its step, inside a group that fits', () => {
  const out = accept(fresh(), ROUTER);
  assert.deepEqual(out.plan.skipped, []);
  assert.equal(out.plan.applied.length, 16);
  const steps = ['**Incoming', '**Route', '**Auth', '**Input', '**Handler'].map(out.card);
  steps.forEach((step, i) => {
    assert.equal(step.y, steps[0].y, 'steps share a row');
    if (i) assert.ok(step.x >= steps[i - 1].x + steps[i - 1].w + 24, 'left to right with room for the arrow');
  });
  [['The router', 0], ['Missing', 2], ['No audit', 4]].forEach(([start, at]) => {
    const remark = out.card(start);
    assert.equal(remark.x, steps[at].x, `${start} sits under its step`);
    assert.ok(remark.y >= steps[at].y + steps[at].h + 24);
  });
  assert.equal(out.groups.length, 1);
  const box = out.groups[0];
  out.cards.forEach((card) => assert.ok(inside(card, box), 'the group holds every card'));
  const right = Math.max(...out.cards.map((c) => c.x + c.w));
  const bottom = Math.max(...out.cards.map((c) => c.y + c.h));
  assert.deepEqual([box.x + box.w - right, box.y + box.h - bottom], [16, 16], 'and is no larger than they need');
  out.cards.forEach((a, i) => out.cards.slice(i + 1).forEach((b) => assert.equal(hit(a, b), false)));
  assert.ok(steps[0].h < 160 && out.card('The router').h < 160, 'a note is as tall as its text needs');
  assert.equal(Object.keys(out.plan.board.connectors).length, 7);
});

test('a flow lands to the right of what is on the board, and cards outside it are placed around it', () => {
  let board = fresh();
  board = model.applyBatch(board, { batch_id: 'b1', board_id: board.id, actor: 'owner',
    ops: [{ op: 'card.add', card: { id: uid(1), kind: 'note', data: { text: 'Here first', tone: null }, x: 40, y: 80, w: 240, h: 160 } }] }, { now: NOW }).board;
  const out = accept(board, ['note Alone', 'note One as a', 'note Two as b', 'note Three as c', 'a -> b', 'b -> c', 'note Also alone']);
  assert.deepEqual(out.plan.skipped, []);
  const [one, two, three] = ['One', 'Two', 'Three'].map(out.card);
  assert.deepEqual([one.x, one.y], [40 + 240 + 48, 80]);
  assert.ok(one.y === two.y && two.y === three.y && one.x < two.x && two.x < three.x);
  out.cards.forEach((a, i) => out.cards.slice(i + 1).forEach((b) => assert.equal(hit(a, b), false, `${a.data.text} and ${b.data.text}`)));
  assert.deepEqual([out.card('Alone').w, out.card('Alone').h], [240, 160], 'a card outside a flow keeps the default size');
});

test('what is not a flow is left to default placement', () => {
  const pair = accept(fresh(), ['note One as a', 'note Two as b', 'a -> b']);
  assert.deepEqual([pair.card('One').w, pair.card('Two').w], [240, 240], 'two cards are not a flow');
  const ring = accept(fresh(), ['note One as a', 'note Two as b', 'note Three as c', 'a -> b', 'b -> c', 'c -> a']);
  assert.deepEqual(ring.cards.map((c) => c.w), [240, 240, 240], 'arrows in a circle are not a flow');
  let board = accept(fresh(), ['group Old']).plan.board;
  const alias = Object.values(board.groups)[0].alias;
  const old = accept(board, [`note One in ${alias} as a`, `note Two in ${alias} as b`, `note Three in ${alias} as c`, 'a -> b', 'b -> c'], 300);
  assert.deepEqual(old.cards.map((c) => c.w), [240, 240, 240], 'a group a person already has is not rearranged');
  assert.deepEqual(old.plan.skipped, []);
});

test('flowLayout: branches go under the chain, two flows stack, bad input gives nothing', () => {
  const n = (id, h = 64) => ({ id, w: 200, h });
  const fork = flow.flowLayout({ nodes: [n('a'), n('b'), n('c'), n('d'), n('side'), n('pre')],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }, { from: 'b', to: 'side' }, { from: 'pre', to: 'a', soft: true }] });
  assert.deepEqual(['a', 'b', 'c', 'd'].map((id) => fork.rects[id].x), [0, 248, 496, 744]);
  assert.deepEqual([fork.rects.side.x, fork.rects.side.y], [248, 104]);
  assert.deepEqual([fork.rects.pre.x, fork.rects.pre.y], [0, 104], 'a dashed arrow into the first step does not lengthen the chain');
  const two = flow.flowLayout({ nodes: ['a', 'b', 'c', 'p', 'q', 'r', 'lone'].map((id) => n(id)),
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'p', to: 'q' }, { from: 'q', to: 'r' }, { from: 'lone', to: 'nobody' }] });
  assert.equal(two.flows.length, 2);
  assert.equal(two.rects.p.y, 64 + 48);
  assert.equal(two.rects.lone, undefined);
  [null, {}, { nodes: 'x', edges: [] }, { nodes: [{ id: 'a', w: -1, h: 2 }], edges: [{}] }].forEach((bad) => assert.deepEqual(flow.flowLayout(bad).flows, []));
  assert.deepEqual(flow.arrange(null, [{ op: {} }]), [{ op: {} }]);
  const twice = flow.flowLayout({ nodes: [n('a'), n('b'), n('c')], edges: [{ from: 'a', to: 'b', soft: true }, { from: 'a', to: 'b' }, { from: 'b', to: 'c' }] });
  assert.equal(twice.flows.length, 1, 'a solid arrow counts when a dashed one between the same two cards came first');
  assert.deepEqual(flow.fitNote('Short'), { w: 200, h: 65 });
  assert.equal(flow.fitNote('x'.repeat(4000)).h, flow.fitNote('y\n'.repeat(40)).h, 'height is capped');
});
