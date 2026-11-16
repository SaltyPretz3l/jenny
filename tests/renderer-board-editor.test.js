'use strict';

// new-test-file: a new surface (renderer/features/board/board-editor.js, the board's selection and commands); the canvas and toolbar that drive it are in renderer-board-canvas-editing.test.js.
// Every command of the editor contract runs against the real model and the in-memory source: the batch that was sent, the board
// afterwards, a refusal putting the board back, a read-only board, selection pruning, and undo and redo.

const test = require('node:test');
const assert = require('node:assert/strict');

const model = require('../services/boards/board-model');
const { createMemoryBoardSource } = require('../renderer/features/board/board-source-memory');
const { createBoardEditor } = require('../renderer/features/board/board-editor');

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [A, B, C, D] = [uid(901), uid(902), uid(903), uid(904)];
const G = uid(950);
const K1 = uid(960);

const addCard = (id, kind, data, extra = {}) => ({ op: 'card.add', card: { id, kind, data, x: 0, y: 0, w: 200, h: 100, ...extra } });

async function fixture({ ops = [], editorOptions = {} } = {}) {
  let tick = Date.parse('2026-11-13T10:00:00.000Z');
  let n = 0;
  let sourceIds = 5000;
  const source = createMemoryBoardSource({ model, now: () => new Date((tick += 1000)).toISOString(), makeId: () => uid(sourceIds++) });
  const created = (await source.create({ projectId: 'project_alpha', name: 'Plan' })).board;
  let current = created;
  if (ops.length) {
    const seeded = await source.apply({ boardId: created.id, batch: { batch_id: 'seed1', board_id: created.id, actor: 'owner', ops } });
    assert.equal(seeded.ok, true, JSON.stringify(seeded));
    current = seeded.board;
  }
  const sent = [];
  const realApply = source.apply;
  source.apply = (request) => { sent.push(request); return realApply(request); };
  const notices = [];
  const editor = createBoardEditor({
    model, source, notify: (message, extra) => notices.push({ message, ...extra }), log: () => {},
    makeId: () => uid(++n), now: () => '2026-11-13T12:00:00.000Z', ...editorOptions,
  });
  const events = [];
  editor.onChange((event) => events.push(event.kind));
  editor.setBoard(current, { boardId: current.id });
  events.length = 0;
  const h = {
    editor, source, sent, notices, events, id: created.id,
    server: async () => (await source.get({ boardId: created.id })).board,
    ops: (i = 0) => sent[i].batch.ops,
  };
  return h;
}

const base = () => [
  addCard(A, 'note', { text: 'alpha', tone: null }, { x: 0, y: 0 }),
  addCard(B, 'note', { text: 'beta', tone: null }, { x: 300, y: 0 }),
  addCard(C, 'link', { url: 'https://example.com/', title: 'Example' }, { x: 0, y: 300 }),
];

test('setBoard shows a document and fires board; canEdit follows the board and readOnly; getBoard is the newest document', async () => {
  const h = await fixture();
  assert.equal(h.editor.canEdit(), true);
  assert.equal(h.editor.getBoard().id, h.id);
  const doc = await h.server();
  h.editor.setBoard(doc, { boardId: doc.id, readOnly: true });
  assert.equal(h.editor.canEdit(), false);
  assert.deepEqual(h.events, ['board']);
  h.editor.setBoard(null, { readOnly: true });
  assert.equal(h.editor.getBoard(), null);
  assert.equal(h.editor.canEdit(), false);
  h.editor.setBoard(doc);
  assert.equal(h.editor.canEdit(), true);
  assert.equal(h.editor.canUndo(), false);
  h.editor.setBoard(doc, { canUndo: true, canRedo: true });
  assert.equal(h.editor.canUndo() && h.editor.canRedo(), true, 'the page passes what the source said');
});

test('every command resolves read_only and does nothing on a read-only board or with no board', async () => {
  const h = await fixture({ ops: base() });
  const doc = await h.server();
  h.editor.select([A, B]);
  const calls = [
    () => h.editor.addNote({ x: 1, y: 1 }), () => h.editor.addLink({ url: 'https://example.com' }), () => h.editor.editCard(A, { text: 'x' }),
    () => h.editor.editGroup(G, { title: 'x' }), () => h.editor.setTone('amber'), () => h.editor.removeSelected(),
    () => h.editor.placeItems([{ id: A, x: 5, y: 5 }]), () => h.editor.nudgeSelected(1, 1), () => h.editor.connect(A, B),
    () => h.editor.editConnector(K1, { label: 'x' }), () => h.editor.removeConnector(K1), () => h.editor.groupSelected(), () => h.editor.ungroupSelected(),
    () => h.editor.assignToGroup([A], null), () => h.editor.bringForward(), () => h.editor.sendBack(), () => h.editor.duplicateSelected(),
    () => h.editor.undo(), () => h.editor.redo(),
  ];
  for (const withBoard of [true, false]) {
    h.editor.setBoard(withBoard ? doc : null, { readOnly: true });
    for (const call of calls) {
      const result = await call();
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'read_only');
      assert.equal(typeof result.message, 'string');
    }
  }
  assert.deepEqual(h.sent, [], 'nothing was sent');
  assert.deepEqual(h.notices, []);
  assert.deepEqual((await h.server()).cards, doc.cards);
});

test('addNote: the model places it, a given spot and text and group are honoured, the batch is exact, and the new card becomes the selection', async () => {
  const h = await fixture({ ops: base() });
  const free = await h.editor.addNote({});
  assert.equal(free.ok, true);
  assert.deepEqual(Object.keys(h.sent[0].batch).sort(), ['actor', 'batch_id', 'board_id', 'ops']);
  assert.equal(h.sent[0].boardId, h.id);
  assert.equal(h.sent[0].batch.actor, 'owner');
  assert.equal(h.sent[0].batch.board_id, h.id);
  assert.deepEqual(h.ops(0), [{ op: 'card.add', card: { id: free.id, kind: 'note', data: { text: '', tone: null } } }]);
  const server = await h.server();
  assert.equal(server.cards[free.id].kind, 'note');
  assert.match(server.cards[free.id].alias, /^n\d+$/, 'the authority gave it an alias');
  assert.deepEqual(h.editor.getSelection(), [free.id]);
  assert.equal(h.editor.getBoard().cards[free.id].alias, server.cards[free.id].alias, 'the board that came back replaced the optimistic one');

  const placed = await h.editor.addNote({ x: 700, y: 120, text: 'line 1\nline 2' });
  const card = (await h.server()).cards[placed.id];
  assert.deepEqual([card.x, card.y, card.data.text], [700, 120, 'line 1\nline 2']);
  assert.deepEqual(h.ops(1)[0].card, { id: placed.id, kind: 'note', data: { text: 'line 1\nline 2', tone: null }, x: 700, y: 120 });
  assert.deepEqual(h.editor.getSelection(), [placed.id]);

  const grouped = await h.editor.groupSelected();
  assert.equal(grouped.ok, true);
  const inside = await h.editor.addNote({ groupId: grouped.id, text: 'in' });
  assert.equal((await h.server()).cards[inside.id].group_id, grouped.id);
  assert.deepEqual(h.events.filter((kind) => kind === 'board').length > 0, true);
});

test('addLink takes http and https, trims, and refuses everything else before anything is sent', async () => {
  const h = await fixture({ ops: base() });
  const made = await h.editor.addLink({ url: '  https://example.org/a?b=1  ', title: 'Org' });
  assert.equal(made.ok, true);
  assert.deepEqual(h.ops(0)[0].card.data, { url: 'https://example.org/a?b=1', title: 'Org' });
  assert.equal((await h.server()).cards[made.id].data.url, 'https://example.org/a?b=1');
  const count = h.sent.length;
  for (const url of ['ftp://example.org/', 'javascript:alert(1)', 'example.org', '', 'http://', 'https://a b.c', 42, undefined]) {
    const result = await h.editor.addLink({ url });
    assert.equal(result.ok, false, String(url));
    assert.equal(result.reason, 'invalid', String(url));
  }
  assert.equal(h.sent.length, count, 'a refused address is not sent');
  assert.equal(h.notices.length, 8);
  assert.equal(h.notices[0].tone, 'warning');
  assert.match(h.notices[0].message, /http/);
});

test('editCard carries the content_rev, sends only a real change, and a stale refusal puts the board back and says so', async () => {
  const h = await fixture({ ops: base() });
  const result = await h.editor.editCard(A, { text: 'alpha 2' });
  assert.equal(result.ok, true);
  assert.deepEqual(h.ops(0), [{ op: 'card.edit', id: A, content_rev: 0, data: { text: 'alpha 2' } }]);
  assert.equal(h.editor.getBoard().cards[A].content_rev, 1);
  const same = await h.editor.editCard(A, { text: 'alpha 2' });
  assert.deepEqual(same, { ok: true, unchanged: true });
  assert.equal(h.sent.length, 1);
  const link = await h.editor.editCard(C, { url: 'https://example.com/new', title: 'New' });
  assert.equal(link.ok, true);
  assert.deepEqual((await h.server()).cards[C].data, { url: 'https://example.com/new', title: 'New' });
  assert.equal((await h.editor.editCard(uid(999), { text: 'x' })).reason, 'missing_target');

  // Someone else changes B behind the editor's back: the editor still holds content_rev 0.
  await h.source.apply({ boardId: h.id, batch: { batch_id: 'other1', board_id: h.id, actor: 'owner', ops: [{ op: 'card.edit', id: B, content_rev: 0, data: { text: 'theirs' } }] } });
  const stale = await h.editor.editCard(B, { text: 'mine' });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale');
  assert.equal(stale.current.data.text, 'theirs');
  assert.equal(h.editor.getBoard().cards[B].data.text, 'beta', 'the board is back as it was');
  assert.equal(h.notices.at(-1).tone, 'warning');
  assert.match(h.notices.at(-1).message, /changed/i);
});

test('sentBatch knows its own batches until the board is set again, and a save against an older base is refused once', async () => {
  const h = await fixture({ ops: base() });
  const base0 = { rev: h.editor.getBoard().cards[A].content_rev };
  assert.equal((await h.editor.editCard(B, { text: 'beta 2' })).ok, true);
  const own = h.sent[0].batch.batch_id;
  assert.deepEqual([h.editor.sentBatch(own), h.editor.sentBatch('other1'), h.editor.sentBatch(undefined)], [true, false, false]);
  await h.source.apply({ boardId: h.id, batch: { batch_id: 'other1', board_id: h.id, actor: 'owner', ops: [{ op: 'card.edit', id: A, content_rev: 0, data: { text: 'theirs' } }] } });
  h.editor.setBoard(await h.server(), { boardId: h.id });
  assert.equal(h.editor.sentBatch(own), false, 'the board was set since: the page reads it');
  const refused = await h.editor.editCard(A, { text: 'mine' }, base0);
  assert.deepEqual([refused.ok, refused.reason, h.sent.length, base0.rev], [false, 'stale', 2, 1], 'nothing more sent; the base moved to the card as it is');
  assert.equal((await h.editor.editCard(A, { text: 'mine' }, base0)).ok, true);
  assert.equal((await h.server()).cards[A].data.text, 'mine');
});

test('editGroup and setTone change notes and groups only; none clears; an unknown colour is refused', async () => {
  const h = await fixture({ ops: [...base(), { op: 'group.add', group: { id: G, title: 'Team', x: 600, y: 300, w: 300, h: 200 } }] });
  assert.equal((await h.editor.editGroup(G, { title: 'Crew', tone: 'blue' })).ok, true);
  assert.deepEqual(h.ops(0), [{ op: 'group.edit', id: G, content_rev: 0, title: 'Crew', tone: 'blue' }]);
  assert.equal((await h.editor.editGroup(G, { title: '' })).ok, false, 'a group needs a title');
  h.editor.select([A, C, G]);
  const toned = await h.editor.setTone('amber');
  assert.equal(toned.ok, true);
  const server = await h.server();
  assert.equal(server.cards[A].data.tone, 'amber');
  assert.equal(server.groups[G].tone, 'amber');
  assert.equal(server.cards[C].data.url, 'https://example.com/', 'a link has no tone and is left alone');
  assert.deepEqual(h.ops(1).map((op) => op.op).sort(), ['card.edit', 'group.edit']);
  assert.deepEqual(await h.editor.setTone('amber'), { ok: true, unchanged: true });
  assert.equal((await h.editor.setTone(null)).ok, true);
  assert.equal((await h.server()).cards[A].data.tone, null);
  assert.equal((await h.editor.setTone('purple')).reason, 'invalid');
  h.editor.select([C]);
  assert.equal((await h.editor.setTone('red')).ok, false, 'nothing here takes a colour');
});

test('placeItems is one batch; a group brings its members by the same delta unless a member is listed itself; no change sends nothing', async () => {
  const h = await fixture({ ops: [
    { op: 'group.add', group: { id: G, title: 'Team', x: 0, y: 0, w: 500, h: 400 } },
    addCard(A, 'note', { text: 'a', tone: null }, { x: 20, y: 60, group_id: G }),
    addCard(B, 'note', { text: 'b', tone: null }, { x: 260, y: 60, group_id: G }),
    addCard(C, 'note', { text: 'c', tone: null }, { x: 700, y: 0 }),
  ] });
  assert.deepEqual(await h.editor.placeItems([{ id: C, x: 700, y: 0 }]), { ok: true, unchanged: true });
  assert.deepEqual(await h.editor.placeItems([]), { ok: true, unchanged: true });
  assert.equal(h.sent.length, 0);
  const moved = await h.editor.placeItems([{ id: G, x: 100, y: 50 }]);
  assert.equal(moved.ok, true);
  assert.equal(h.sent.length, 1, 'one batch');
  assert.deepEqual(h.ops(0).map((op) => op.op).sort(), ['card.place', 'card.place', 'group.place']);
  let server = await h.server();
  assert.deepEqual([server.groups[G].x, server.groups[G].y], [100, 50]);
  assert.deepEqual([server.cards[A].x, server.cards[A].y, server.cards[B].x, server.cards[B].y], [120, 110, 360, 110]);
  assert.deepEqual([server.cards[C].x, server.cards[C].y], [700, 0]);

  await h.editor.placeItems([{ id: G, x: 0, y: 0 }, { id: A, x: 500, y: 500 }]);
  server = await h.server();
  assert.deepEqual([server.cards[A].x, server.cards[A].y], [500, 500], 'the listed member keeps its own place');
  assert.deepEqual([server.cards[B].x, server.cards[B].y], [260, 60], 'the other follows the group');
  assert.equal(h.ops(1).length, 3, 'the listed member is not moved twice');

  const resized = await h.editor.placeItems([{ id: C, x: 700, y: 0, w: 300, h: 150 }]);
  assert.equal(resized.ok, true);
  assert.deepEqual([(await h.server()).cards[C].w, (await h.server()).cards[C].h], [300, 150]);
  assert.equal((await h.editor.placeItems([{ id: uid(999), x: 1, y: 1 }])).reason, 'missing_target');
  assert.equal((await h.editor.placeItems([{ id: C, x: 7e6, y: 0 }])).ok, false, 'a coordinate out of range is refused');
  assert.equal(h.editor.getBoard().cards[C].x, 700);
});

test('nudgeSelected is placeItems on the selection', async () => {
  const h = await fixture({ ops: base() });
  h.editor.select([A, B]);
  assert.equal((await h.editor.nudgeSelected(10, -5)).ok, true);
  const server = await h.server();
  assert.deepEqual([server.cards[A].x, server.cards[A].y, server.cards[B].x, server.cards[B].y, server.cards[C].x], [10, -5, 310, -5, 0]);
  assert.equal(h.sent.length, 1);
  h.editor.clearSelection();
  assert.equal((await h.editor.nudgeSelected(1, 1)).ok, false);
});

test('connect joins two cards; itself and a repeat are exists and send nothing; the other direction is a new connector', async () => {
  const h = await fixture({ ops: base() });
  const first = await h.editor.connect(A, B, { label: 'then' });
  assert.equal(first.ok, true);
  assert.deepEqual(h.ops(0), [{ op: 'connector.add', connector: { id: first.id, from: A, to: B, label: 'then' } }]);
  const server = await h.server();
  assert.deepEqual([server.connectors[first.id].from, server.connectors[first.id].to, server.connectors[first.id].label], [A, B, 'then']);
  assert.equal(h.sent.length, 1);
  for (const [from, to] of [[A, A], [A, B]]) {
    const result = await h.editor.connect(from, to);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'exists');
  }
  assert.equal(h.sent.length, 1, 'nothing was sent for either');
  assert.equal((await h.editor.connect(B, A)).ok, true);
  assert.equal((await h.editor.connect(A, uid(999))).reason, 'missing_target');
  assert.equal((await h.editor.connect(A, C, { label: 'x'.repeat(201) })).ok, false);
});

test('editConnector changes label, style, ends and tone; removeConnector removes it; the connector selection follows', async () => {
  const h = await fixture({ ops: [...base(), { op: 'connector.add', connector: { id: K1, from: A, to: B } }] });
  assert.equal((await h.editor.editConnector(K1, { label: 'uses', style: 'dashed', ends: 'both', tone: 'green' })).ok, true);
  assert.deepEqual(h.ops(0), [{ op: 'connector.edit', id: K1, content_rev: 0, label: 'uses', style: 'dashed', ends: 'both', tone: 'green' }]);
  assert.deepEqual((await h.server()).connectors[K1].style, 'dashed');
  assert.deepEqual(await h.editor.editConnector(K1, { label: 'uses' }), { ok: true, unchanged: true });
  assert.equal((await h.editor.editConnector(K1, { style: 'wavy' })).ok, false);
  h.editor.selectConnector(K1);
  assert.equal(h.editor.getSelectedConnector(), K1);
  assert.equal((await h.editor.removeConnector(K1)).ok, true);
  assert.equal(h.editor.getSelectedConnector(), '');
  assert.equal(Object.keys((await h.server()).connectors).length, 0);
  assert.equal((await h.editor.removeConnector(K1)).ok, false);
});

test('removeSelected removes cards with their connectors, groups release their cards, and a selected connector goes alone', async () => {
  const h = await fixture({ ops: [...base(), { op: 'group.add', group: { id: G, title: 'Team', x: 600, y: 0, w: 300, h: 300 } },
    addCard(D, 'note', { text: 'd', tone: null }, { x: 620, y: 40, group_id: G }), { op: 'connector.add', connector: { id: K1, from: A, to: B } }] });
  h.editor.selectConnector(K1);
  assert.equal((await h.editor.removeSelected()).ok, true);
  assert.deepEqual(h.ops(0), [{ op: 'connector.remove', id: K1 }]);
  assert.equal(Object.keys((await h.server()).cards).length, 4);
  await h.editor.connect(A, B);
  h.editor.select([A, G]);
  assert.equal((await h.editor.removeSelected()).ok, true);
  const server = await h.server();
  assert.equal(server.cards[A], undefined);
  assert.equal(Object.keys(server.connectors).length, 0, 'the connector went with its card');
  assert.equal(server.groups[G], undefined);
  assert.equal(server.cards[D].group_id, null, 'the group released its card');
  assert.deepEqual(h.editor.getSelection(), []);
  assert.equal((await h.editor.removeSelected()).ok, false, 'nothing selected');
});

test('groupSelected wraps the selected cards in a group, ungroupSelected frees them, assignToGroup moves them in and out', async () => {
  const h = await fixture({ ops: base() });
  assert.equal((await h.editor.groupSelected()).ok, false, 'needs a card');
  h.editor.select([A, B]);
  const grouped = await h.editor.groupSelected();
  assert.equal(grouped.ok, true);
  assert.equal(h.sent.length, 1, 'one batch');
  assert.deepEqual(h.ops(0).map((op) => op.op), ['group.add', 'group.assign', 'group.assign']);
  let server = await h.server();
  const group = server.groups[grouped.id];
  assert.ok(group.x < 0 && group.y < 0 && group.x + group.w > 500 && group.y + group.h > 100, 'the box holds both cards');
  assert.equal(server.cards[A].group_id, grouped.id);
  assert.equal(server.cards[B].group_id, grouped.id);
  assert.equal(server.cards[C].group_id, null);
  assert.deepEqual(h.editor.getSelection(), [grouped.id]);
  assert.equal((await h.editor.ungroupSelected()).ok, true);
  server = await h.server();
  assert.equal(server.groups[grouped.id], undefined);
  assert.equal(server.cards[A].group_id, null);
  assert.deepEqual(h.editor.getSelection().sort(), [A, B].sort(), 'the freed cards are selected');
  assert.equal((await h.editor.ungroupSelected()).ok, false, 'no group selected');

  h.editor.select([A]);
  const second = await h.editor.groupSelected();
  assert.equal((await h.editor.assignToGroup([B, C], second.id)).ok, true);
  assert.equal((await h.server()).cards[C].group_id, second.id);
  assert.deepEqual(await h.editor.assignToGroup([B, C], second.id), { ok: true, unchanged: true });
  assert.equal((await h.editor.assignToGroup([B], null)).ok, true);
  assert.equal((await h.server()).cards[B].group_id, null);
  assert.equal((await h.editor.assignToGroup([B], uid(999))).reason, 'missing_target');
});

test('bringForward puts the selection above every other card and sendBack below, each keeping its own order', async () => {
  const h = await fixture({ ops: base() });
  const z = async () => Object.fromEntries(Object.values((await h.server()).cards).map((card) => [card.id, card.z]));
  const before = await z();
  assert.deepEqual([before[A], before[B], before[C]], [0, 1, 2]);
  h.editor.select([A, B]);
  assert.equal((await h.editor.bringForward()).ok, true);
  let now = await z();
  assert.ok(now[C] < now[A] && now[A] < now[B], 'A and B are above C, A still below B');
  h.editor.select([A]);
  assert.equal((await h.editor.sendBack()).ok, true);
  now = await z();
  assert.ok(now[A] < now[C] && now[C] < now[B], 'A went below C, which is below B');
  assert.deepEqual(await h.editor.sendBack(), { ok: true, unchanged: true }, 'already at the back');
  h.editor.select([A, B, C]);
  assert.deepEqual(await h.editor.bringForward(), { ok: true, unchanged: true }, 'nothing above them');
});

test('duplicateSelected copies cards 24 and 24 away and selects the copies', async () => {
  const h = await fixture({ ops: base() });
  h.editor.select([A, C]);
  const result = await h.editor.duplicateSelected();
  assert.equal(result.ok, true);
  assert.equal(result.ids.length, 2);
  const server = await h.server();
  const copyOfA = server.cards[result.ids[0]];
  assert.deepEqual([copyOfA.x, copyOfA.y, copyOfA.w, copyOfA.h, copyOfA.data.text], [24, 24, 200, 100, 'alpha']);
  assert.equal(server.cards[result.ids[1]].data.url, 'https://example.com/');
  assert.deepEqual(h.editor.getSelection(), result.ids);
  assert.equal(h.sent.length, 1);
  h.editor.clearSelection();
  assert.equal((await h.editor.duplicateSelected()).ok, false);
});

test('undo and redo walk the journal, tell the flags, and stay quiet when there is nothing', async () => {
  const h = await fixture({ ops: base() });
  assert.equal(h.editor.canUndo(), false);
  const added = await h.editor.addNote({ x: 900, y: 0, text: 'new' });
  assert.equal(h.editor.canUndo(), true);
  assert.equal(h.editor.canRedo(), false);
  const undone = await h.editor.undo();
  assert.equal(undone.ok, true);
  assert.equal((await h.server()).cards[added.id], undefined);
  assert.equal(h.editor.getBoard().cards[added.id], undefined);
  assert.equal(h.editor.canRedo(), true);
  assert.equal(h.editor.canUndo(), true, 'the seeded batch is also in the journal');
  assert.equal((await h.editor.redo()).ok, true);
  assert.ok((await h.server()).cards[added.id]);
  await h.editor.undo();
  await h.editor.undo();
  const nothing = await h.editor.undo();
  assert.deepEqual([nothing.ok, nothing.reason], [false, 'nothing_to_undo']);
  assert.equal(h.editor.canUndo(), false);
  assert.deepEqual(h.notices, [], 'no toast for nothing to undo');
  assert.equal((await h.editor.redo()).ok, true);
  assert.equal(h.editor.canUndo(), true);
  assert.deepEqual(h.events.includes('board'), true);
});

test('a skipped undo is told through notify', async () => {
  const h = await fixture({ ops: base() });
  const doc = await h.server();
  const answer = { ok: true, board: doc, applied: null, skipped: [{ op_index: 0, op: 'card.edit', id: A, reason: 'changed' }, { op_index: 1, op: 'card.remove', id: B, reason: 'referenced' }], canUndo: false, canRedo: true };
  h.source.undo = async () => answer;
  const result = await h.editor.undo();
  assert.equal(result.ok, true);
  assert.equal(result.skipped.length, 2);
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].tone, 'warning');
  assert.match(h.notices[0].message, /2/);
  assert.equal(h.editor.canUndo(), false);
  assert.equal(h.editor.canRedo(), true);
  h.source.undo = async () => ({ ok: false, reason: 'read_only' });
  assert.equal((await h.editor.undo()).reason, 'read_only');
  assert.equal(h.notices.length, 2, 'a real refusal is told');
});

test('a refusal from the source puts the board back, tells the person, and the optimistic board was on screen meanwhile', async () => {
  const h = await fixture({ ops: base() });
  const before = h.editor.getBoard();
  let release;
  h.source.apply = (request) => { h.sent.push(request); return new Promise((resolve) => { release = () => resolve({ ok: false, reason: 'io' }); }); };
  const pending = h.editor.addNote({ x: 5, y: 5, text: 'fleeting' });
  assert.equal(Object.keys(h.editor.getBoard().cards).length, 4, 'the card is there at once');
  assert.deepEqual(h.events, ['board', 'selection'], 'views repaint at once');
  release();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'io');
  assert.deepEqual(h.editor.getBoard(), before, 'the board is back');
  assert.deepEqual(h.editor.getSelection(), []);
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].tone, 'warning');
  h.source.apply = () => { throw new Error('ipc gone'); };
  const thrown = await h.editor.addNote({ x: 6, y: 6 });
  assert.deepEqual([thrown.ok, thrown.reason], [false, 'io'], 'a throwing source does not reject');
  h.source.apply = async () => ({ ok: false, reason: 'invalid', op_index: 0, limit: 'note_chars' });
  const limited = await h.editor.addNote({ x: 6, y: 6 });
  assert.equal(limited.limit, 'note_chars');
  assert.match(limited.message, /4,000/);
});

test('a batch the model refuses here is not sent, and the limit is named in plain words', async () => {
  const h = await fixture({ ops: base() });
  const long = await h.editor.addNote({ text: 'x'.repeat(4001) });
  assert.deepEqual([long.ok, long.reason, long.limit], [false, 'invalid', 'note_chars']);
  assert.match(long.message, /4,000/);
  assert.equal(h.sent.length, 0);
  assert.match(h.notices[0].message, /4,000/);
  const ops = [];
  for (let i = 0; i < 497; i += 1) ops.push(addCard(uid(2000 + i), 'note', { text: '', tone: null }, { x: i, y: 1000 }));
  for (let from = 0; from < ops.length; from += 150) {
    const batch = { batch_id: `fill${from}`, board_id: h.id, actor: 'owner', ops: ops.slice(from, from + 150) };
    assert.equal((await h.source.apply({ boardId: h.id, batch })).ok, true);
  }
  h.editor.setBoard(await h.server(), { boardId: h.id });
  assert.equal(Object.keys(h.editor.getBoard().cards).length, 500);
  const sentBefore = h.sent.length;
  const full = await h.editor.addNote({});
  assert.deepEqual([full.ok, full.reason, full.limit], [false, 'limit', 'cards']);
  assert.match(full.message, /500/);
  assert.equal(h.sent.length, sentBefore);
  const dup = await h.editor.addLink({ url: 'https://example.com/' });
  assert.equal(dup.reason, 'limit');
});

test('selection: select, add, toggle, selectAll, unknown ids dropped, connector exclusive, pruned when the board changes from outside', async () => {
  const h = await fixture({ ops: [...base(), { op: 'group.add', group: { id: G, title: 'Team', x: 600, y: 0, w: 300, h: 300 } }, { op: 'connector.add', connector: { id: K1, from: A, to: B } }] });
  const { editor } = h;
  editor.select([A, uid(999), 'junk']);
  assert.deepEqual(editor.getSelection(), [A]);
  assert.equal(editor.isSelected(A), true);
  assert.equal(editor.isSelected(B), false);
  editor.select([B], { add: true });
  assert.deepEqual(editor.getSelection(), [A, B], 'in the order selected');
  editor.select([C]);
  assert.deepEqual(editor.getSelection(), [C], 'without add it replaces');
  editor.toggle(A);
  editor.toggle(C);
  assert.deepEqual(editor.getSelection(), [A]);
  editor.toggle(uid(999));
  assert.deepEqual(editor.getSelection(), [A]);
  editor.selectAll();
  assert.deepEqual(editor.getSelection().sort(), [A, B, C, G].sort());
  editor.selectConnector(K1);
  assert.deepEqual([editor.getSelection(), editor.getSelectedConnector()], [[], K1], 'selecting a connector clears the cards');
  editor.select([A]);
  assert.equal(editor.getSelectedConnector(), '', 'selecting a card clears the connector');
  editor.selectConnector(uid(999));
  assert.equal(editor.getSelectedConnector(), '');
  assert.deepEqual(editor.getSelection(), [A], 'an unknown connector changes nothing');
  editor.selectConnector('');
  editor.clearSelection();
  assert.deepEqual(editor.getSelection(), []);

  editor.select([A, B, G]);
  h.events.length = 0;
  const outside = JSON.parse(JSON.stringify(await h.server()));
  delete outside.cards[A];
  delete outside.connectors[K1];
  delete outside.groups[G];
  editor.setBoard(outside, { boardId: outside.id });
  assert.deepEqual(editor.getSelection(), [B]);
  assert.deepEqual(h.events.sort(), ['board', 'selection']);
  editor.selectConnector('');
  const unsubscribe = editor.onChange(() => { throw new Error('a listener must not break the editor'); });
  editor.select([C]);
  unsubscribe();
  editor.select([B]);
  assert.deepEqual(editor.getSelection(), [B]);
});

test('dispose stops the editor: listeners are dropped and a late command resolves a refusal', async () => {
  const h = await fixture({ ops: base() });
  let heard = 0;
  h.editor.onChange(() => { heard += 1; });
  h.editor.dispose();
  h.editor.dispose();
  h.editor.select([A]);
  assert.equal(heard, 0);
  const result = await h.editor.addNote({});
  assert.equal(result.ok, false);
  assert.equal(h.sent.length, 0);
});

/* ---------------------------------------------------------------- tidy and applyParts (row 150 slice B9) */

const tidyModule = require('../services/boards/board-tidy');

const grouped = () => [{ op: 'group.add', group: { id: G, title: 'Box', x: -50, y: -50, w: 1500, h: 900 } }]
  .concat(base().map((op, i) => ({ op: 'card.add', card: { ...op.card, ...(i < 2 ? { group_id: G } : {}) } })));

test('tidy arranges the selected group, the selected cards, or the whole board: one batch, the selection kept, Undo ready', async () => {
  const h = await fixture({ ops: grouped(), editorOptions: { tidy: tidyModule } });
  h.editor.select([G]);
  assert.equal((await h.editor.tidy()).ok, true);
  assert.equal(h.sent.length, 1, 'one batch');
  assert.ok(h.ops(0).every((op) => op.op === 'card.place' || op.op === 'group.place'));
  assert.deepEqual(h.editor.getSelection(), [G], 'the selection is kept');
  assert.equal(h.editor.canUndo(), true);
  assert.deepEqual([(await h.server()).cards[B].x, (await h.server()).cards[B].y], [-50 + 16 + 224, -50 + 40]);
  assert.deepEqual(await h.editor.tidy(G), { ok: true, unchanged: true }, 'a group id as the argument; already tidy sends nothing');
  assert.equal(h.sent.length, 1);

  h.editor.select([C]);
  assert.deepEqual(await h.editor.tidy(), { ok: true, unchanged: true }, 'one free card is already where its grid starts');
  h.editor.select([A, B, C]);
  assert.equal((await h.editor.tidy()).ok, true, 'cards in a group are left out; the free one stays put');
  assert.equal(h.sent.length, 1);

  const free = await fixture({ ops: base().map((op, i) => ({ op: 'card.add', card: { ...op.card, x: i * 40, y: i * 700 } })), editorOptions: { tidy: tidyModule } });
  free.editor.select([A, B, C]);
  assert.equal((await free.editor.tidy()).ok, true);
  assert.equal(free.sent.length, 1);
  free.editor.clearSelection();
  assert.equal((await free.editor.tidy()).ok, true, 'nothing selected tidies the whole board');
  assert.equal(free.sent.length, 2);
  assert.deepEqual([(await free.server()).cards[C].x, (await free.server()).cards[C].y], [448, 0], 'packed into a row after the other two');
  assert.equal((await free.editor.undo()).ok, true);
  assert.deepEqual([(await free.server()).cards[C].x, (await free.server()).cards[C].y], [0, 124], 'one undo puts the whole tidy back');
});

test('tidy tells the person what went wrong in plain words, and says unavailable when its module is missing', async () => {
  const h = await fixture({ ops: base(), editorOptions: { tidy: { tidyOps: (_board, target) => ({ ok: false, reason: target.groupId ? 'too_many' : 'invalid' }) } } });
  h.editor.select([A]);
  const none = await h.editor.tidy();
  assert.deepEqual([none.ok, none.reason, none.message], [false, 'invalid', 'Could not tidy.']);
  const many = await h.editor.tidy(G);
  assert.deepEqual([many.reason, many.message], ['too_many', 'That is too many cards to tidy at once. Select fewer.']);
  assert.deepEqual(h.notices.map((n) => n.message), ['Could not tidy.', 'That is too many cards to tidy at once. Select fewer.']);
  const bare = await fixture({ ops: base() });
  const missing = await bare.editor.tidy();
  assert.deepEqual([missing.ok, missing.reason], [false, 'unavailable']);
  bare.editor.setBoard(bare.editor.getBoard(), { readOnly: true });
  assert.equal((await bare.editor.tidy()).reason, 'read_only');
  assert.equal(bare.sent.length, 0);
});

test('applyParts runs a prepared list as one batch and selects the parts that exist; anything else is refused', async () => {
  const h = await fixture({ ops: base() });
  const N1 = uid(970);
  const N2 = uid(971);
  const parts = [addCard(N1, 'note', { text: 'one', tone: null }, { x: 900, y: 0 }), addCard(N2, 'note', { text: 'two', tone: null }, { x: 900, y: 200 }),
    { op: 'connector.add', connector: { id: uid(972), from: N1, to: N2 } }, { op: 'card.remove', id: C }];
  const result = await h.editor.applyParts(parts, [N1, N2, uid(999)]);
  assert.equal(result.ok, true);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.editor.getSelection(), [N1, N2]);
  assert.equal((await h.server()).cards[C], undefined);
  for (const bad of [[], null, 'x', [{ op: 'card.place', id: A, x: 1, y: 1 }], [{ op: 'card.remove', id: A }, { op: 'board.rename', name: 'No' }], Array.from({ length: 201 }, () => parts[0]), [null]]) {
    const out = await h.editor.applyParts(bad, []);
    assert.deepEqual([out.ok, out.reason], [false, 'invalid']);
  }
  assert.equal(h.sent.length, 1, 'nothing else was sent');
  assert.equal((await h.editor.undo()).ok, true);
  assert.ok((await h.server()).cards[C], 'one undo brings the removed card back');
  assert.equal((await h.server()).cards[N1], undefined);
});
