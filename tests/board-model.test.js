'use strict';

// Behaviour tests for the project board model (plan PROJECT_BOARD_2026-11-13, sections 6.1-6.3 and 6.6):
// the document, the thirteen operations, the two revisions, cascades, inverses, aliases, placement,
// limits and the undo journal. The text form and its parser live in board-text.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('../services/boards/board-model');

const NOW = '2026-11-13T10:00:00.000Z';
const LATER = '2026-11-13T11:00:00.000Z';
const BOARD_ID = 'board_00000000-0000-4000-8000-000000000000';
const AUTH = { now: NOW, authority: true };
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SHA = 'a'.repeat(64);
const BIG = 'x'.repeat(5 * 1024 * 1024);

let batchSeq = 0;
const batch = (ops, actor = 'owner', extra = {}) => ({ batch_id: `b${++batchSeq}`, board_id: BOARD_ID, actor, ops, ...extra });
function fresh() {
  const r = M.createBoard({ id: BOARD_ID, project_id: 'project_alpha', name: 'Auth redesign', now: NOW });
  assert.equal(r.ok, true);
  return r.board;
}
const run = (board, ops, actor, ctx = AUTH) => M.applyBatch(board, batch(ops, actor), ctx);
function ok(board, ops, actor, ctx) {
  const r = run(board, ops, actor, ctx);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  return r;
}
function refused(board, ops, reason, extra = {}) {
  const r = run(board, ops);
  assert.equal(r.ok, false, `expected ${reason}`);
  assert.equal(r.reason, reason, JSON.stringify(r).slice(0, 300));
  for (const [k, v] of Object.entries(extra)) assert.deepEqual(r[k], v, k);
  return r;
}
const note = (n, text = `note ${n}`, extra = {}) => ({ op: 'card.add', card: { id: uid(n), kind: 'note', data: { text }, ...extra } });
const link = (n, url = 'https://example.org/spec', extra = {}) => ({ op: 'card.add', card: { id: uid(n), kind: 'link', data: { url, title: 'Spec' }, ...extra } });
const conn = (n, from, to, extra = {}) => ({ op: 'connector.add', connector: { id: uid(n), from: uid(from), to: uid(to), ...extra } });
const group = (n, title = `Group ${n}`, extra = {}) => ({ op: 'group.add', group: { id: uid(n), title, ...extra } });
const diagram = (scene) => ({ op: 'card.add', card: { id: uid(90), kind: 'diagram', data: { scene, title: 'Flow' }, x: 0, y: 0 } });
function strip(board) {
  const clean = ({ geo_rev, content_rev, updated_at, updated_by, ...rest }) => rest;
  const map = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, clean(v)]));
  return { name: board.name, cards: map(board.cards), connectors: map(board.connectors), groups: map(board.groups) };
}
// g1 holds note A (uid 1); B (uid 2) is a link; connector K (uid 3) runs A -> B.
function base() {
  return ok(fresh(), [group(10, 'Open questions', { x: 0, y: 0 }), note(1, 'Do we keep refresh tokens?', { x: 20, y: 50, group_id: uid(10) }),
    link(2, 'https://example.org/spec', { x: 600, y: 50 }), conn(3, 1, 2, { label: 'blocks' })]).board;
}
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('createBoard gives schema 1 at rev 0, and refuses bad input without throwing', () => {
  const b = fresh();
  assert.deepEqual(b, { schema_version: 1, id: BOARD_ID, project_id: 'project_alpha', name: 'Auth redesign', rev: 0, next_alias: 1,
    created_at: NOW, updated_at: NOW, recent_batches: [], cards: {}, connectors: {}, groups: {} });
  for (const bad of [null, 7, {}, { id: 'board_x', project_id: 'project_a', name: 'n', now: NOW },
    { id: BOARD_ID, project_id: 'project_a', name: BIG, now: NOW }, { id: BOARD_ID, project_id: 'p', name: 'n', now: NOW }]) {
    assert.equal(M.createBoard(bad).ok, false);
  }
});

test('normalizeBoard round-trips stored JSON and refuses every broken document with a reason', () => {
  const b = base();
  const back = M.normalizeBoard(JSON.parse(JSON.stringify(b)));
  assert.equal(back.ok, true);
  assert.deepEqual(back.board, b);
  const mutate = (fn) => { const doc = JSON.parse(JSON.stringify(b)); fn(doc); return M.normalizeBoard(doc); };
  assert.equal(mutate((d) => { d.schema_version = 2; }).reason, 'newer_schema');
  assert.equal(mutate((d) => { d.schema_version = 0; }).reason, 'invalid');
  assert.equal(mutate((d) => { d.extra = 1; }).reason, 'invalid');
  assert.equal(mutate((d) => { d.cards[uid(1)].extra = 1; }).reason, 'invalid');
  assert.equal(mutate((d) => { d.cards[uid(1)].group_id = uid(77); }).reason, 'invalid'); // a card pointing at a missing group
  assert.equal(mutate((d) => { d.connectors[uid(3)].to = uid(78); }).reason, 'invalid');
  assert.equal(mutate((d) => { d.cards[uid(2)].alias = 'n1'; }).reason, 'invalid'); // wrong letter and a duplicate
  assert.equal(mutate((d) => { d.next_alias = 2; }).reason, 'invalid'); // an alias at or past next_alias
  assert.equal(mutate((d) => { d.name = BIG; }).reason, 'invalid');
  assert.equal(mutate((d) => { d.cards[uid(1)].data.text = BIG; }).reason, 'invalid');
  const proto = JSON.parse(JSON.stringify(b).replace(`"${uid(2)}":{"id":"${uid(2)}"`, `"__proto__":{"id":"__proto__"`));
  assert.equal(M.normalizeBoard(proto).reason, 'invalid');
  assert.equal(Object.prototype.id, undefined);
  for (const junk of [null, 'board', [], 5, { schema_version: 1 }]) assert.equal(M.normalizeBoard(junk).ok, false);
  const crowded = mutate((d) => { for (let i = 0; i < 501; i++) d.cards[uid(1000 + i)] = { ...d.cards[uid(2)], id: uid(1000 + i), alias: null }; });
  assert.deepEqual([crowded.reason, crowded.limit], ['limit', 'cards']);
});

test('every operation applies, and applying its inverse gives back the start apart from revisions', () => {
  const start = base();
  const cases = {
    'card.add': [note(4, 'new', { x: 900, y: 900 })],
    'card.edit': [{ op: 'card.edit', id: uid(1), content_rev: 0, data: { text: 'Changed', tone: 'amber' } }],
    'card.place': [{ op: 'card.place', id: uid(1), x: 300, y: 400, w: 200, h: 100, z: 9 }],
    'card.remove': [{ op: 'card.remove', id: uid(1) }],
    'connector.add': [conn(5, 2, 1, { style: 'dashed', ends: 'both' })],
    'connector.edit': [{ op: 'connector.edit', id: uid(3), content_rev: 0, label: 'needs', style: 'dashed' }],
    'connector.remove': [{ op: 'connector.remove', id: uid(3) }],
    'group.add': [group(11, 'Decisions', { x: 2000, y: 0 })],
    'group.edit': [{ op: 'group.edit', id: uid(10), content_rev: 0, title: 'Answered', tone: 'green' }],
    'group.place': [{ op: 'group.place', id: uid(10), x: -50, y: 10, w: 700, h: 500 }],
    'group.remove': [{ op: 'group.remove', id: uid(10) }],
    'group.assign': [{ op: 'group.assign', card_id: uid(2), group_id: uid(10) }],
    'board.rename': [{ op: 'board.rename', name: 'Auth, take two' }],
  };
  for (const [name, ops] of Object.entries(cases)) {
    const r = ok(start, ops);
    assert.notDeepEqual(strip(r.board), strip(start), `${name} changed nothing`);
    assert.equal(r.board.rev, start.rev + 1);
    const back = M.applyInverse(r.board, r.inverse, { now: LATER, authority: true, batch_id: `undo-${name}` });
    assert.equal(back.ok, true, name);
    assert.deepEqual(back.skipped, [], name);
    assert.deepEqual(strip(back.board), strip(start), name);
  }
  assert.equal(ok(start, cases['card.edit']).board.cards[uid(1)].content_rev, 1);
  assert.equal(ok(start, cases['card.place']).board.cards[uid(1)].geo_rev, 1);
});

test('the six card kinds take their data; links take http and https only; bad shapes are invalid', () => {
  const r = ok(fresh(), [
    note(1, 'Line one\nLine two'), { op: 'card.add', card: { id: uid(2), kind: 'file', data: { path: 'src/auth/session.ts', title: 'session.ts' } } },
    { op: 'card.add', card: { id: uid(3), kind: 'image', data: { asset: SHA, width: 640, height: 480, alt: 'Login screen' } } },
    link(4, 'HTTP://example.org/a'), { op: 'card.add', card: { id: uid(5), kind: 'chat', data: { session_id: 's1', message_id: 'm2', title: 'Chat', excerpt: 'Said so' } } },
    { op: 'card.add', card: { id: uid(6), kind: 'diagram', data: { scene: 'a A\nb B\na -> b', title: 'Flow' } } }]);
  assert.deepEqual(Object.values(r.board.cards).map((c) => c.alias), ['n1', 'f2', 'i3', 'l4', 'c5', 'd6']);
  assert.equal(r.board.cards[uid(1)].created_by, 'owner');
  assert.equal(r.board.cards[uid(3)].w, 320); // an image's default size follows its aspect
  assert.equal(r.board.cards[uid(3)].h, 240);
  for (const bad of [link(9, 'ftp://example.org'), link(9, 'javascript:alert(1)'), link(9, 'https://'), link(9, 'https://a b'),
    { op: 'card.add', card: { id: uid(9), kind: 'file', data: { path: '../secret' } } },
    { op: 'card.add', card: { id: uid(9), kind: 'file', data: { path: 'C:/Windows' } } },
    { op: 'card.add', card: { id: uid(9), kind: 'image', data: { asset: 'nothex', width: 1, height: 1 } } },
    { op: 'card.add', card: { id: uid(9), kind: 'chat', data: { session_id: 's', excerpt: 'e'.repeat(401) } } },
    { op: 'card.add', card: { id: uid(9), kind: 'video', data: {} } }, { op: 'card.add', card: { id: uid(9), kind: 'note', data: { text: 'a\rb' } } },
    { op: 'card.add', card: { id: uid(9), kind: 'note', data: { text: 'x', html: '<b>' } } }, { op: 'card.add', card: { id: uid(9), kind: 'note', data: { text: 'x' }, x: 5 } },
    { op: 'card.add', card: { id: uid(9), kind: 'note', data: { text: 'x' }, x: Infinity, y: 0 } }, { op: 'card.unknown' }, null, 'card.add',
    { op: 'card.edit', id: uid(1), content_rev: 0, data: JSON.parse('{"__proto__":{"polluted":true},"text":"x"}') }]) {
    refused(r.board, [bad], 'invalid');
  }
  assert.equal({}.polluted, undefined);
});

test('refusal reasons: stale with current, missing_target, exists, limit and invalid', () => {
  const b = base();
  const stale = refused(b, [{ op: 'card.edit', id: uid(1), content_rev: 3, data: { text: 'x' } }], 'stale');
  assert.equal(stale.current.data.text, 'Do we keep refresh tokens?');
  assert.equal(stale.current.content_rev, 0);
  refused(b, [{ op: 'connector.edit', id: uid(3), content_rev: 1, label: 'x' }], 'stale');
  refused(b, [{ op: 'group.edit', id: uid(10), content_rev: 1, title: 'x' }], 'stale');
  for (const ops of [[{ op: 'card.edit', id: uid(50), content_rev: 0, data: { text: 'x' } }], [{ op: 'card.place', id: uid(50), x: 1 }],
    [{ op: 'card.remove', id: uid(50) }], [conn(51, 1, 50)], [{ op: 'connector.remove', id: uid(50) }], [{ op: 'group.remove', id: uid(50) }],
    [{ op: 'group.assign', card_id: uid(1), group_id: uid(50) }], [{ op: 'group.assign', card_id: uid(50), group_id: null }],
    [note(52, 'x', { group_id: uid(50) })], [{ op: 'group.place', id: uid(50), x: 1 }]]) {
    refused(b, ops, 'missing_target');
  }
  refused(b, [note(1)], 'exists');
  refused(b, [conn(3, 1, 2)], 'exists');
  refused(b, [group(1)], 'exists'); // an id is unique across cards, connectors and groups
  for (const ops of [[note(53, 'x', { id: '__proto__' })], [note(53, 'x', { id: 'constructor' })], [conn(54, 1, 1)],
    [{ op: 'card.place', id: uid(1) }], [{ op: 'board.rename', name: '' }], [{ op: 'board.rename', name: 'a\nb' }]]) {
    refused(b, ops, 'invalid');
  }
  assert.equal(M.applyBatch(b, { ...batch([note(55)]), board_id: 'board_00000000-0000-4000-8000-000000000999' }, AUTH).reason, 'invalid');
  assert.equal(M.applyBatch(b, { ...batch([note(55)]), batch_id: BIG }, AUTH).reason, 'invalid');
  assert.equal(M.applyBatch(b, batch([]), AUTH).reason, 'invalid');
  assert.equal(M.applyBatch(b, batch([note(55)]), { authority: true }).reason, 'invalid'); // no time given
  const big = refused(b, [note(56, BIG)], 'invalid');
  assert.equal(big.limit, 'note_chars');
});

test('a batch is atomic: one refused operation refuses all of it and reports its index', () => {
  const b = base();
  const before = JSON.stringify(b);
  const r = refused(b, [note(4), { op: 'card.edit', id: uid(1), content_rev: 9, data: { text: 'x' } }, note(5)], 'stale');
  assert.equal(r.op_index, 1);
  assert.equal(JSON.stringify(b), before);
});

test('place is last write wins and never refuses for a moved content_rev; remove wins over an edit', () => {
  const b = base();
  const edited = ok(b, [{ op: 'card.edit', id: uid(1), content_rev: 0, data: { text: 'v2' } }]).board;
  const placed = ok(edited, [{ op: 'card.place', id: uid(1), x: 5, y: 6, geo_rev: 42 }], 'other').board;
  assert.deepEqual([placed.cards[uid(1)].x, placed.cards[uid(1)].geo_rev], [5, 1]);
  const again = ok(placed, [{ op: 'card.place', id: uid(1), x: 7 }]).board;
  assert.deepEqual([again.cards[uid(1)].x, again.cards[uid(1)].y, again.cards[uid(1)].geo_rev], [7, 6, 2]);
  const removed = ok(b, [{ op: 'card.remove', id: uid(1), content_rev: 0 }], 'other').board;
  refused(removed, [{ op: 'card.edit', id: uid(1), content_rev: 0, data: { text: 'late' } }], 'missing_target');
});

test('a resent batch is a harmless duplicate; the ring of recent batch ids holds at most 32', () => {
  const b = fresh();
  const sent = batch([note(1)]);
  const first = M.applyBatch(b, sent, AUTH);
  const second = M.applyBatch(first.board, sent, AUTH);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.board, first.board);
  let board = first.board;
  for (let i = 0; i < 40; i++) board = ok(board, [{ op: 'card.place', id: uid(1), x: i }]).board;
  assert.equal(board.recent_batches.length, 32);
});

test('removing a card cascades its connectors; removing a group releases its cards; undo restores both', () => {
  const b = ok(base(), [note(4, 'C', { x: 20, y: 300, group_id: uid(10) }), conn(5, 4, 2)]).board;
  const r = ok(b, [{ op: 'card.remove', id: uid(2) }, { op: 'connector.remove', id: uid(3) }]); // already cascaded: a no-op
  assert.deepEqual(Object.keys(r.board.connectors), []);
  assert.deepEqual(r.applied.ops.map((o) => `${o.op} ${o.id}`), [`connector.remove ${uid(3)}`, `connector.remove ${uid(5)}`, `card.remove ${uid(2)}`]);
  const undone = M.applyInverse(r.board, r.inverse, { now: LATER, authority: true, batch_id: 'u1' });
  assert.deepEqual(strip(undone.board), strip(b));
  assert.equal(undone.board.cards[uid(2)].alias, 'l3'); // the alias comes back with the card
  const g = ok(b, [{ op: 'group.remove', id: uid(10) }]);
  assert.deepEqual([g.board.cards[uid(1)].group_id, g.board.cards[uid(4)].group_id], [null, null]);
  assert.deepEqual(g.applied.ops.map((o) => o.op), ['group.assign', 'group.assign', 'group.remove']);
  const back = M.applyInverse(g.board, g.inverse, { now: LATER, authority: true, batch_id: 'u2' });
  assert.deepEqual(strip(back.board), strip(b));
});

test('the applied batch replays on another copy at the same revision to the same board', () => {
  const b = base();
  const r = ok(b, [note(4, 'near', { group_id: uid(10) }), { op: 'card.remove', id: uid(2) }, group(11, 'Free'), note(5, 'joined'), conn(6, 5, 1)]);
  const replay = M.applyBatch(b, r.applied, { now: '2030-01-01T00:00:00.000Z', authority: false });
  assert.equal(replay.ok, true);
  assert.deepEqual(replay.board, r.board);
  assert.deepEqual(replay.applied.ops, r.applied.ops);
});

test('the authority assigns aliases by kind and never reuses one; a renderer keeps what the batch carries', () => {
  let b = ok(fresh(), [note(1, 'a', { alias: 'n99' }), group(2), link(3)]).board;
  assert.deepEqual([b.cards[uid(1)].alias, b.groups[uid(2)].alias, b.cards[uid(3)].alias, b.next_alias], ['n1', 'g2', 'l3', 4]);
  b = ok(b, [{ op: 'card.remove', id: uid(1) }]).board;
  b = ok(b, [note(4)]).board;
  assert.equal(b.cards[uid(4)].alias, 'n4');
  const local = { now: NOW, authority: false };
  const optimistic = ok(b, [note(5)], 'owner', local).board;
  assert.equal(optimistic.cards[uid(5)].alias, null);
  const echoed = ok(b, [note(6, 'x', { alias: 'n12' })], 'owner', local).board;
  assert.deepEqual([echoed.cards[uid(6)].alias, echoed.next_alias], ['n12', 13]);
  assert.equal(run(b, [note(7, 'x', { alias: 'n4' })], 'owner', local).reason, 'exists');
  assert.equal(run(b, [note(7, 'x', { alias: 'f9' })], 'owner', local).reason, 'invalid');
});

test('new cards are placed next to what they connect to, else in their group (which grows), else right of the content', () => {
  const b = base();
  const r = ok(b, [note(4, 'near'), conn(5, 4, 2), note(6, 'grouped', { group_id: uid(10) }), note(7, 'free'), note(8, 'free too')]);
  const c = r.board.cards;
  const B = c[uid(2)];
  assert.deepEqual([c[uid(4)].x, c[uid(4)].y], [B.x + B.w + 24, B.y]);
  const g = r.board.groups[uid(10)];
  assert.ok(c[uid(6)].x >= g.x && c[uid(6)].y + c[uid(6)].h <= g.y + g.h, 'inside the grown group');
  assert.ok(g.h > b.groups[uid(10)].h && g.geo_rev === 1);
  assert.ok(r.applied.ops.some((o) => o.op === 'group.place' && o.id === uid(10)));
  const right = Math.max(...[...Object.values(b.cards), ...Object.values(b.groups)].map((i) => i.x + i.w));
  assert.ok(c[uid(7)].x > right && c[uid(8)].x === c[uid(7)].x && c[uid(8)].y > c[uid(7)].y);
  const all = Object.values(c);
  for (const a of all) for (const o of all) if (a !== o) assert.ok(!overlaps(a, o), `${a.alias} overlaps ${o.alias}`);
  const again = ok(b, [note(4, 'near'), conn(5, 4, 2), note(6, 'grouped', { group_id: uid(10) }), note(7, 'free'), note(8, 'free too')]);
  assert.deepEqual(again.board.cards, r.board.cards); // deterministic
  const planned = M.placeNewCards(b, [{ id: uid(4), kind: 'note', near: uid(2) }, { id: uid(6), kind: 'note', group_id: uid(10) },
    { id: uid(7), kind: 'note' }, { id: uid(8), kind: 'note' }]);
  assert.equal(planned.ok, true);
  for (const n of [4, 6, 7, 8]) assert.deepEqual([planned.positions[uid(n)].x, planned.positions[uid(n)].y], [c[uid(n)].x, c[uid(n)].y]);
  assert.equal(planned.grown[uid(10)].h, g.h);
  assert.deepEqual(M.placeNewCards(fresh(), [{ id: uid(1), kind: 'note' }]).positions[uid(1)], { x: 0, y: 0, w: 240, h: 160 });
  assert.equal(M.placeNewCards(b, [{ id: '__proto__', kind: 'note' }]).ok, false);
  // A card that names a group and connects to a card elsewhere goes into the group: a member sits inside its group's box.
  const both = ok(b, [note(4, 'member', { group_id: uid(10) }), conn(5, 4, 2)]).board;
  const box = both.groups[uid(10)];
  const member = both.cards[uid(4)];
  assert.ok(member.x >= box.x && member.x + member.w <= box.x + box.w && member.y >= box.y && member.y + member.h <= box.y + box.h);
  // At the edge of the coordinate range a placed card stays inside it, so the stored board still loads.
  const edge = ok(ok(fresh(), [note(1, 'far', { x: 1e6, y: 1e6 })]).board, [note(2, 'placed'), note(3, 'near'), conn(4, 3, 1)]).board;
  for (const c of Object.values(edge.cards)) assert.ok(Math.abs(c.x) <= 1e6 && Math.abs(c.y) <= 1e6, `${c.alias} at ${c.x},${c.y}`);
  assert.equal(M.normalizeBoard(JSON.parse(JSON.stringify(edge))).ok, true);
});

test('review sequence: A adds a card, B connects to it, A undoes; the card and the connector stay', () => {
  const added = ok(base(), [note(4, 'A added')], 'alice');
  const linked = ok(added.board, [conn(5, 2, 4)], 'bob').board;
  const undo = M.applyInverse(linked, added.inverse, { now: LATER, authority: true, batch_id: 'alice-undo' });
  assert.equal(undo.ok, true);
  assert.deepEqual(undo.skipped.map((s) => [s.op, s.reason]), [['card.remove', 'referenced']]);
  assert.ok(undo.board.cards[uid(4)] && undo.board.connectors[uid(5)]);
  assert.equal(undo.board, linked); // nothing applied, nothing changed
});

test('review sequence: a move by B during A\'s two unconfirmed edits keeps both edits and the move', () => {
  const start = base();
  const e1 = batch([{ op: 'card.edit', id: uid(1), content_rev: 0, data: { text: 'v1' } }], 'alice');
  const e2 = batch([{ op: 'card.edit', id: uid(1), content_rev: 1, data: { text: 'v2' } }], 'alice');
  const local = { now: NOW, authority: false };
  const mine1 = M.applyBatch(start, e1, local);
  const mine2 = M.applyBatch(mine1.board, e2, local);
  const move = M.applyBatch(start, batch([{ op: 'card.place', id: uid(1), x: 777, y: 88 }], 'bob'), AUTH);
  const main1 = M.applyBatch(move.board, e1, AUTH);
  const main2 = M.applyBatch(main1.board, e2, AUTH);
  assert.equal(main1.ok && main2.ok, true);
  const card = main2.board.cards[uid(1)];
  assert.deepEqual([card.data.text, card.x, card.y, card.content_rev, card.geo_rev], ['v2', 777, 88, 2, 1]);
  const theirs = M.applyBatch(mine2.board, move.applied, local);
  assert.deepEqual(strip(theirs.board), strip(main2.board));
  const undo = M.applyInverse(main2.board, main2.inverse, { now: LATER, authority: true, batch_id: 'u-e2' });
  assert.deepEqual([undo.board.cards[uid(1)].data.text, undo.board.cards[uid(1)].x], ['v1', 777]);
  const undoMove = M.applyInverse(main2.board, move.inverse, { now: LATER, authority: true, batch_id: 'u-move' });
  assert.deepEqual(undoMove.skipped, []); // edits never block undoing a move
});

function fullBoard() {
  let b = fresh();
  for (let start = 0; start < 500; start += 200) {
    const ops = [];
    for (let i = start; i < Math.min(500, start + 200); i++) ops.push(note(1000 + i, `card ${i}`, { x: (i % 25) * 300, y: Math.floor(i / 25) * 200 }));
    b = ok(b, ops).board;
  }
  for (let start = 0; start < 1000; start += 200) {
    const ops = [];
    for (let k = start; k < start + 200; k++) { const i = k % 500; const j = (i + 1 + Math.floor(k / 500)) % 500; ops.push(conn(5000 + k, 1000 + i, 1000 + j)); }
    b = ok(b, ops).board;
  }
  return b;
}

test('review sequence: select-all delete on a full board (500 cards, 1,000 connectors) applies in under a second', () => {
  const full = fullBoard();
  assert.deepEqual([Object.keys(full.cards).length, Object.keys(full.connectors).length], [500, 1000]);
  refused(full, [note(9999)], 'limit', { limit: 'cards' });
  refused(full, [conn(9998, 1000, 1003)], 'limit', { limit: 'connectors' });
  const ops = Object.keys(full.cards).map((id) => ({ op: 'card.remove', id }));
  const t0 = performance.now();
  const r = M.applyBatch(full, batch(ops), AUTH);
  const ms = performance.now() - t0;
  assert.equal(r.ok, true);
  assert.ok(ms < 1000, `took ${ms} ms`);
  assert.deepEqual([Object.keys(r.board.cards).length, Object.keys(r.board.connectors).length], [0, 0]);
  assert.equal(r.applied.ops.length, 1500);
  const back = M.applyInverse(r.board, r.inverse, { now: LATER, authority: true, batch_id: 'undo-all' });
  assert.deepEqual(back.skipped, []);
  assert.deepEqual(strip(back.board), strip(full));
});

test('undo puts back every step of a batch that touched one item more than once, and redo does them again', () => {
  const b = ok(fresh(), [group(20, 'Mine'), note(1), note(2)]).board;
  const ctx = (id) => ({ now: LATER, authority: true, batch_id: id });
  const many = ok(b, [
    { op: 'group.assign', card_id: uid(1), group_id: uid(20) }, { op: 'card.place', id: uid(1), x: 5, y: 5 }, { op: 'card.place', id: uid(1), x: 9, y: 9 },
    { op: 'group.place', id: uid(20), w: 900 }, { op: 'group.place', id: uid(20), w: 1200 },
    { op: 'card.edit', id: uid(2), content_rev: 0, data: { text: 'one' } }, { op: 'card.edit', id: uid(2), content_rev: 1, data: { text: 'two' } },
    note(3, 'made and changed'), { op: 'card.edit', id: uid(3), content_rev: 0, data: { text: 'changed' } },
  ]);
  const undone = M.applyInverse(many.board, many.inverse, ctx('u-many'));
  assert.deepEqual(undone.skipped, []);
  const at = (board, n) => [board.cards[uid(n)].x, board.cards[uid(n)].y, board.cards[uid(n)].group_id, board.cards[uid(n)].data.text];
  assert.deepEqual(at(undone.board, 1), at(b, 1));
  assert.deepEqual(at(undone.board, 2), at(b, 2));
  assert.equal(undone.board.groups[uid(20)].w, b.groups[uid(20)].w);
  assert.equal(undone.board.cards[uid(3)], undefined, 'the card the batch made and then changed is gone again');
  const redone = M.applyInverse(undone.board, undone.inverse, ctx('r-many'));
  assert.deepEqual(redone.skipped, []);
  assert.deepEqual([at(redone.board, 1), at(redone.board, 2), redone.board.groups[uid(20)].w, redone.board.cards[uid(3)].data.text],
    [[9, 9, uid(20), 'note 1'], [at(b, 2)[0], at(b, 2)[1], null, 'two'], 1200, 'changed']);
  // Someone else's change in between is still respected: the first step on the item is compared as it is.
  const theirs = ok(many.board, [{ op: 'card.place', id: uid(1), x: 77 }], 'bob').board;
  const partly = M.applyInverse(theirs, many.inverse, ctx('u-theirs'));
  assert.deepEqual(partly.skipped.filter((s) => s.id === uid(1)).map((s) => s.reason), ['moved', 'moved', 'moved']);
  assert.deepEqual([partly.board.cards[uid(1)].x, partly.board.cards[uid(1)].group_id], [77, uid(20)]);
});

test('undo skips an inverse when content_rev or geo_rev moved or someone refers to the item, and never removes their work', () => {
  const b = base();
  const ctx = (id) => ({ now: LATER, authority: true, batch_id: id });
  const edit = ok(b, [{ op: 'card.edit', id: uid(1), content_rev: 0, data: { text: 'mine' } }], 'alice');
  const theirEdit = ok(edit.board, [{ op: 'card.edit', id: uid(1), content_rev: 1, data: { text: 'theirs' } }], 'bob').board;
  const u1 = M.applyInverse(theirEdit, edit.inverse, ctx('u1'));
  assert.deepEqual([u1.skipped[0].reason, u1.board.cards[uid(1)].data.text], ['changed', 'theirs']);
  const move = ok(b, [{ op: 'card.place', id: uid(2), x: 1 }], 'alice');
  const moved = ok(move.board, [{ op: 'card.place', id: uid(2), x: 2 }], 'bob').board;
  assert.equal(M.applyInverse(moved, move.inverse, ctx('u2')).skipped[0].reason, 'moved');
  const made = ok(b, [group(20, 'Mine', { x: 3000, y: 0 })], 'alice');
  const filled = ok(made.board, [{ op: 'group.assign', card_id: uid(2), group_id: uid(20) }], 'bob').board;
  const u3 = M.applyInverse(filled, made.inverse, ctx('u3'));
  assert.deepEqual([u3.skipped[0].reason, Boolean(u3.board.groups[uid(20)])], ['referenced', true]);
  const gone = ok(edit.board, [{ op: 'card.remove', id: uid(1) }], 'bob').board;
  assert.equal(M.applyInverse(gone, edit.inverse, ctx('u4')).skipped[0].reason, 'missing_target');
  const renamed = ok(b, [{ op: 'board.rename', name: 'Mine' }], 'alice');
  const theirName = ok(renamed.board, [{ op: 'board.rename', name: 'Theirs' }], 'bob').board;
  assert.equal(M.applyInverse(theirName, renamed.inverse, ctx('u5')).skipped[0].reason, 'changed');
  const u6 = M.applyInverse(edit.board, edit.inverse, ctx('u6'));
  const redo = M.applyInverse(u6.board, u6.inverse, ctx('r6'));
  assert.equal(redo.board.cards[uid(1)].data.text, 'mine');
  const resent = M.applyInverse(redo.board, u6.inverse, ctx('r6'));
  assert.equal(resent.duplicate, true);
});

test('limits at their edge and one past: cards, connectors, groups, notes, diagrams, operations a batch', () => {
  assert.ok(Object.isFrozen(M.LIMITS));
  assert.deepEqual(M.LIMITS, { boards_per_project: 20, cards: 500, connectors: 1000, groups: 50, note_chars: 4000, diagram_chars: 16384,
    diagram_lines: 400, diagram_nodes: 120, document_bytes: 2097152, image_asset_bytes: 10485760, image_assets_total_bytes: 209715200,
    journal_batches: 200, journal_bytes: 1048576, proposals: 20, proposals_bytes: 524288, batch_ops: 200, proposal_ops: 40 });
  assert.deepEqual([...M.CARD_KINDS], ['note', 'file', 'image', 'link', 'chat', 'diagram']);
  let groups = fresh();
  const gops = [];
  for (let i = 0; i < 50; i++) gops.push(group(100 + i, `g${i}`, { x: i * 600, y: 0 }));
  groups = ok(groups, gops).board;
  refused(groups, [group(200)], 'limit', { limit: 'groups' });
  const b = fresh();
  ok(b, [note(1, 'n'.repeat(4000))]);
  refused(b, [note(1, 'n'.repeat(4001))], 'invalid', { limit: 'note_chars' });
  ok(b, [diagram('a'.repeat(16384))]);
  refused(b, [diagram('a'.repeat(16385))], 'invalid', { limit: 'diagram_chars' });
  ok(b, [diagram('\n'.repeat(399))]);
  refused(b, [diagram('\n'.repeat(400))], 'invalid', { limit: 'diagram_lines' });
  const nodes = (n) => Array.from({ length: n }, (_, i) => `n${i} Node ${i}`).concat(['title T', 'n0 -> n1 go', 'step S: s | n0']).join('\n');
  ok(b, [diagram(nodes(120))]);
  refused(b, [diagram(nodes(121))], 'invalid', { limit: 'diagram_nodes' });
  const adds = (n) => Array.from({ length: n }, (_, i) => note(3000 + i, 'x', { x: i * 300, y: 0 }));
  ok(b, adds(200));
  refused(b, adds(201), 'limit', { limit: 'batch_ops', op_index: -1 }); // the hostile 201-operation batch
});

test('the 2 MiB document limit binds on additions and edits, never on removals', () => {
  const cap = M.LIMITS.document_bytes;
  let b = fresh();
  let n = 20000;
  for (let round = 0; round < 2; round++) {
    b = ok(b, Array.from({ length: 125 }, (_, i) => note(n++, 'é'.repeat(4000), { x: i * 300, y: round * 200 }))).board;
  }
  while (cap - M.boardBytes(b) > 4000) {
    b = ok(b, [note(n++, 'é'.repeat(Math.min(4000, Math.floor((cap - M.boardBytes(b) - 2000) / 2))), { x: 0, y: 1000 })]).board;
  }
  const before = M.boardBytes(b);
  const probe = (text, id) => M.applyBatch(b, { batch_id: id, board_id: BOARD_ID, actor: 'owner', ops: [note(1, text, { x: 0, y: 5000 })] }, AUTH);
  const overhead = M.boardBytes(probe('a', 'probe-1').board) - before - 1;
  const exact = probe('a'.repeat(cap - before - overhead), 'probe-2');
  assert.equal(exact.ok, true);
  assert.equal(M.boardBytes(exact.board), cap);
  const over = probe('a'.repeat(cap - before - overhead + 1), 'probe-3');
  assert.deepEqual([over.ok, over.reason, over.limit], [false, 'limit', 'document_bytes']);
  const grow = M.applyBatch(exact.board, batch([{ op: 'card.edit', id: uid(1), content_rev: 0, data: { text: 'a'.repeat(cap - before - overhead + 1) } }]), AUTH);
  assert.equal(grow.limit, 'document_bytes');
  const shrink = ok(exact.board, [{ op: 'card.remove', id: uid(1) }]);
  assert.ok(M.boardBytes(shrink.board) < cap);
  assert.equal(M.normalizeBoard(JSON.parse(JSON.stringify(exact.board))).ok, true);
});

test('pushJournal keeps 200 batches and 1 MiB, drops the oldest first, and reports an inverse over the cap', () => {
  let journal = [];
  for (let i = 0; i < 200; i++) journal = M.pushJournal(journal, { batch_id: `b${i}`, inverse: { ops: [] } }).journal;
  assert.equal(journal.length, 200);
  const next = M.pushJournal(journal, { batch_id: 'b200', inverse: { ops: [] } });
  assert.deepEqual([next.journal.length, next.dropped, next.journal[0].batch_id, next.journal[199].batch_id], [200, 1, 'b1', 'b200']);
  assert.equal(journal.length, 200); // the input is not mutated
  const half = { batch_id: 'big', inverse: { blob: 'z'.repeat(600 * 1024) } };
  const twice = M.pushJournal(M.pushJournal([], half).journal, { ...half, batch_id: 'big2' });
  assert.deepEqual([twice.journal.length, twice.dropped, twice.journal[0].batch_id], [1, 1, 'big2']);
  assert.ok(twice.bytes <= M.LIMITS.journal_bytes);
  const huge = M.pushJournal(journal, { batch_id: 'huge', inverse: { blob: BIG } });
  assert.deepEqual([huge.ok, huge.undoable, huge.reason, huge.journal.length], [false, false, 'too_large', 200]);
  const small = M.pushJournal([], { batch_id: 'x', inverse: { ops: [] } }, { batches: 1, bytes: 1024 });
  assert.equal(M.pushJournal(small.journal, { batch_id: 'y', inverse: { ops: [] } }, { batches: 1, bytes: 1024 }).journal[0].batch_id, 'y');
});

test('hostile input never throws from any public function', () => {
  const b = base();
  const hostile = [null, undefined, 0, 'x', [], {}, BIG, { ops: null }, new Proxy({}, { get() { throw new Error('boom'); }, ownKeys() { throw new Error('boom'); } })];
  for (const h of hostile) {
    assert.equal(M.normalizeBoard(h).ok, false);
    assert.equal(M.applyBatch(b, h, AUTH).ok, false);
    assert.equal(M.applyBatch(h, batch([note(9)]), AUTH).ok, false);
    assert.equal(M.applyInverse(b, h, { now: NOW }).ok, false);
    assert.equal(M.placeNewCards(h, h).ok, false);
    assert.equal(typeof M.boardToText(h).text, 'string');
    assert.ok(Array.isArray(M.parseBoardText(h).statements));
    assert.equal(typeof M.pushJournal(h, h).ok, 'boolean');
  }
  refused(b, [note(9, BIG)], 'invalid');
  refused(b, [{ op: 'connector.add', connector: { id: uid(9), from: uid(1), to: uid(2), label: BIG } }], 'invalid');
  refused(b, [{ op: 'board.rename', name: BIG }], 'invalid');
  assert.equal(Object.prototype.polluted, undefined);
});
