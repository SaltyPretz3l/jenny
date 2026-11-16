'use strict';

// new-test-file: row 151 slice T1's journal of applied batches (server/team/boards/board-host-journal.js) and the
// store's `since` read are their own surface; tests/server/team-board-store.test.js holds the store's other cases
// and would pass the 600-line cap with these.
//
// `since` pages in order under maxBytes and never returns an inverse; it answers snapshot below the floor, past the
// head, across an entry with no applied batch, and after a crash between the document and journal writes. The
// journal keeps 200 entries and 1 MiB: the 201st batch drops the first and raises the floor. A batch whose way back
// the journal could not keep is refused before the audit and any write, and a restore brings back only what the
// host itself recorded (the row 151 review).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const durable = require('../../services/host/durable-json');
const { removeTreeSync } = require('../../services/fs-remove-no-follow');
const journals = require('../../server/team/boards/board-host-journal');
const { createTeamBoards } = require('../../server/team/boards/team-boards');

const P = 'project_alpha';
const ALICE = 'member_alice';

function setup(t, options = {}) {
  const profile = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-team-board-journal-')));
  t.after(() => removeTreeSync(profile));
  const make = (extra = {}) => createTeamBoards({ userDataPath: profile, clock: () => Date.UTC(2026, 10, 15, 9),
    ...options, ...extra });
  const root = path.join(profile, 'team-boards', P);
  return { profile, make, boards: make(),
    journal: (boardId) => JSON.parse(fs.readFileSync(path.join(root, `${boardId}.journal.json`), 'utf8')),
    document: (boardId) => JSON.parse(fs.readFileSync(path.join(root, `${boardId}.json`), 'utf8')) };
}

const card = (kind, data, x = 0) => ({ op: 'card.add', card: { id: crypto.randomUUID(), kind, x, y: 0, data } });
const note = (text = 'hello', x = 0) => card('note', { text }, x);
const batch = (...ops) => ({ batch_id: `b-${crypto.randomUUID()}`, ops });

async function must(promise, what = 'call') {
  const answer = await promise;
  assert.equal(answer.ok, true, `${what}: ${JSON.stringify(answer)}`);
  return answer;
}

async function boardWith(h, count) {
  const board = (await must(h.boards.create({ projectId: P, actor: ALICE, name: 'Plan' }))).board;
  for (let n = 0; n < count; n += 1) {
    await must(h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note(`n${n}`, n * 300)) }));
  }
  return board;
}

const since = (h, boardId, afterRev, extra = {}) => must(h.boards.since({ projectId: P, boardId, afterRev, ...extra }));

test('since pages in order under maxBytes, never returns an inverse, and answers snapshot outside the journal', async (t) => {
  const h = setup(t);
  const board = await boardWith(h, 5);
  const all = await since(h, board.id, 0);
  assert.deepEqual([all.rev, all.more, all.batches.map((item) => item.rev)], [5, false, [1, 2, 3, 4, 5]]);
  for (const item of all.batches) {
    assert.equal(Object.hasOwn(item, 'inverse'), false);
    assert.equal(item.actor, ALICE);
    assert.equal(item.applied.ops[0].op, 'card.add');
  }
  assert.deepEqual((await since(h, board.id, 3)).batches.map((item) => item.rev), [4, 5]);
  assert.deepEqual(await since(h, board.id, 5), { ok: true, rev: 5, batches: [], more: false });
  assert.deepEqual(await since(h, board.id, 6), { ok: true, rev: 5, snapshot: true }, 'past the head');
  const one = Buffer.byteLength(JSON.stringify([all.batches[0]]), 'utf8');
  const maxBytes = one * 2 + 40;
  const seen = [];
  for (let after = 0, more = true; more;) {
    const page = await since(h, board.id, after, { maxBytes });
    assert.equal(Buffer.byteLength(JSON.stringify(page.batches), 'utf8') <= maxBytes, true);
    assert.equal(page.batches.length > 0, true);
    seen.push(...page.batches.map((item) => item.rev));
    after = page.batches[page.batches.length - 1].rev;
    more = page.more;
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  assert.deepEqual(await since(h, board.id, 0, { maxBytes: 10 }), { ok: true, rev: 5, snapshot: true },
    'no page can carry the first batch');
  for (const bad of [-1, 1.5, '1', null]) {
    assert.equal((await h.boards.since({ projectId: P, boardId: board.id, afterRev: bad })).error.reason, 'team_board_invalid');
  }
  const entry = await must(h.boards.journalEntry({ projectId: P, boardId: board.id, rev: 2 }));
  assert.deepEqual([entry.entry.rev, entry.entry.inverse.ops[0].op], [2, 'card.remove'], 'the inverse is kept for revert');
  assert.equal((await h.boards.journalEntry({ projectId: P, boardId: board.id, rev: 9 })).error.reason, 'team_board_not_found');
});

test('the 201st batch drops the first entry and raises floor_rev; since below the floor is a snapshot', async (t) => {
  const h = setup(t);
  const board = await boardWith(h, 201);
  const journal = h.journal(board.id);
  assert.equal(journal.entries.length, 200);
  assert.deepEqual([journal.floor_rev, journal.entries[0].rev, journal.entries[199].rev], [1, 2, 201]);
  assert.deepEqual(await since(h, board.id, 0), { ok: true, rev: 201, snapshot: true });
  assert.deepEqual((await since(h, board.id, 1, { maxBytes: 2 * 1024 * 1024 })).batches.length, 200);
  assert.equal((await h.boards.journalEntry({ projectId: P, boardId: board.id, rev: 1 })).error.reason, 'team_board_not_found');
});

test('a batch whose way back the journal cannot keep is refused before the audit and before any write', async (t) => {
  const h = setup(t);
  const board = (await must(h.boards.create({ projectId: P, actor: ALICE, name: 'Big' }))).board;
  const diagrams = () => Array.from({ length: 35 }, (_, n) => card('diagram', { scene: 'd'.repeat(16000) }, n * 400));
  await must(h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(...diagrams()) }));
  await must(h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(...diagrams()) }));
  const before = { document: h.document(board.id), journal: h.journal(board.id) };
  const cards = Object.values(before.document.cards);
  assert.equal(cards.length, 70);
  const removeOf = (list) => batch(...list.map((item) => ({ op: 'card.remove', id: item.id })));
  const audits = [];
  const audit = (event) => { audits.push(event); return null; };
  // The removal is a few KiB; its way back holds 70 cards of 16 KB, more than the journal keeps for one batch.
  const refusedAll = await h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: removeOf(cards), audit });
  assert.deepEqual([refusedAll.ok, refusedAll.error.reason, refusedAll.board.reason, refusedAll.board.limit],
    [false, 'team_board_refused', 'limit', 'journal_bytes']);
  assert.deepEqual(audits, [], 'a removal that did not happen is not in the audit');
  assert.deepEqual(h.document(board.id), before.document);
  assert.deepEqual(h.journal(board.id), before.journal);

  // Half of it goes, is audited, and an admin can take it back.
  const first = await must(h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: removeOf(cards.slice(0, 35)), audit }));
  assert.deepEqual(audits, [{ kind: 'apply', removed: 35 }]);
  assert.equal(Object.keys(h.document(board.id).cards).length, 35);
  assert.notEqual((await must(h.boards.journalEntry({ projectId: P, boardId: board.id, rev: first.rev }))).entry.inverse, null);
  const back = await must(h.boards.revert({ projectId: P, boardId: board.id, actor: ALICE, rev: first.rev }));
  assert.equal(back.applied.ops.length, 35);
  assert.equal(Object.keys(h.document(board.id).cards).length, 70);

  // The journal module itself still trims an entry it is handed (the store refuses before that can matter).
  const entry = { rev: 1, batch_id: 'b1', actor: ALICE, at: '2026-11-15T09:00:00.000Z', applied: { ops: [] },
    inverse: { ops: [{ text: 'x'.repeat(journals.CAPS.bytes) }] } };
  const pushed = journals.pushEntry({ schema_version: 1, floor_rev: 0, entries: [] }, entry);
  assert.deepEqual(pushed.entries.map((item) => [item.rev, item.inverse]), [[1, null]]);
});

test('a restore brings back only what the host recorded: revisions, short name and creator are never the batch\'s word', async (t) => {
  const h = setup(t);
  const TOP = Number.MAX_SAFE_INTEGER;
  const board = (await must(h.boards.create({ projectId: P, actor: ALICE, name: 'Restores' }))).board;
  const apply = (actor, ...ops) => h.boards.apply({ projectId: P, boardId: board.id, actor, batch: batch(...ops) });
  const cardOf = (id) => h.document(board.id).cards[id];

  // A card the journal never held: a forged restore is an ordinary new card, at revision 0 under the next short name.
  const forged = crypto.randomUUID();
  await must(apply('member_carl', { op: 'card.add', restore: true, card: { id: forged, kind: 'note', x: 0, y: 0, data: { text: 'x' },
    geo_rev: TOP, content_rev: TOP, alias: 'n999999999', created_by: ALICE, created_at: '2020-01-01T00:00:00.000Z' } }));
  const made = cardOf(forged);
  assert.deepEqual([made.geo_rev, made.content_rev, made.alias, made.created_by], [0, 0, 'n1', 'member_carl']);
  await must(apply('member_carl', { op: 'card.place', id: forged, geo_rev: 0, x: 40, y: 40 },
    { op: 'card.edit', id: forged, content_rev: 0, data: { text: 'y' } }));
  // The board is still one the model reads, on a store that has nothing in memory: readable, editable, removable.
  const fresh = h.make();
  const got = await must(fresh.get({ projectId: P, boardId: board.id }));
  assert.deepEqual([got.read_only, got.board.cards[forged].geo_rev], [false, 1]);
  await must(fresh.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note('still room for a card', 900)) }));
  assert.ok(h.document(board.id).next_alias < 10, 'the short names did not run out');

  // The same forgery on a group and on a connector.
  const group = crypto.randomUUID();
  await must(fresh.apply({ projectId: P, boardId: board.id, actor: 'member_carl', batch: batch({ op: 'group.add', restore: true,
    group: { id: group, title: 'G', x: 2000, y: 0, w: 400, h: 300, geo_rev: TOP, content_rev: TOP, alias: 'g999999999' } }) }));
  const storedGroup = h.document(board.id).groups[group];
  assert.deepEqual([storedGroup.geo_rev, storedGroup.content_rev, /^g[0-9]$/u.test(storedGroup.alias)], [0, 0, true]);

  // A real removal and its real way back: the host's record is what returns.
  const mine = note('alice wrote this', 1500);
  await must(fresh.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(mine) }));
  await must(fresh.apply({ projectId: P, boardId: board.id, actor: ALICE,
    batch: batch({ op: 'card.place', id: mine.card.id, geo_rev: 0, x: 1600, y: 10 }) }));
  const kept = cardOf(mine.card.id);
  const removed = await must(fresh.apply({ projectId: P, boardId: board.id, actor: 'member_bob',
    batch: batch({ op: 'card.remove', id: mine.card.id }) }));
  // Bob restores the id as another kind: that is not Alice's card, so it is Bob's, made now.
  await must(fresh.apply({ projectId: P, boardId: board.id, actor: 'member_bob', batch: batch({ op: 'card.add', restore: true,
    card: { id: mine.card.id, kind: 'diagram', x: 0, y: 900, data: { scene: 'flowchart' }, created_by: ALICE } }) }));
  assert.deepEqual([cardOf(mine.card.id).kind, cardOf(mine.card.id).created_by], ['diagram', 'member_bob']);
  await must(fresh.apply({ projectId: P, boardId: board.id, actor: 'member_bob', batch: batch({ op: 'card.remove', id: mine.card.id }) }));
  // An admin's revert of the first removal brings Alice's note back as the host recorded it.
  await must(fresh.revert({ projectId: P, boardId: board.id, actor: 'member_admin', rev: removed.rev }));
  const returned = cardOf(mine.card.id);
  assert.deepEqual([returned.kind, returned.created_by, returned.created_at, returned.alias, returned.geo_rev],
    ['note', ALICE, kept.created_at, kept.alias, kept.geo_rev]);
});

test('a crash between the document and journal writes: since never serves a hole', async (t) => {
  let failNext = false;
  const h = setup(t, { fileOps: { writeText: (filePath, text) => {
    if (failNext && filePath.endsWith('.journal.json')) {
      failNext = false;
      throw Object.assign(new Error('injected'), { code: 'EIO' });
    }
    return durable.writeText(filePath, text);
  } } });
  const board = await boardWith(h, 1);
  failNext = true;
  const landed = await h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note('lost', 300)) });
  assert.deepEqual([landed.ok, landed.rev], [true, 2], 'the document landed: the change is committed');
  assert.equal(h.document(board.id).rev, 2);
  assert.deepEqual(h.journal(board.id).entries.map((entry) => entry.rev), [1], 'the journal is one entry short');
  for (const store of [h.boards, h.make()]) {
    assert.deepEqual(await must(store.since({ projectId: P, boardId: board.id, afterRev: 1 })), { ok: true, rev: 2, snapshot: true });
    assert.deepEqual(await must(store.since({ projectId: P, boardId: board.id, afterRev: 0 })), { ok: true, rev: 2, snapshot: true });
    assert.deepEqual(await must(store.since({ projectId: P, boardId: board.id, afterRev: 2 })), { ok: true, rev: 2, batches: [], more: false });
  }
  await must(h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note('next', 600)) }));
  const journal = h.journal(board.id);
  assert.deepEqual([journal.floor_rev, journal.entries.map((entry) => entry.rev)], [2, [1, 3]]);
  assert.deepEqual((await since(h, board.id, 2)).batches.map((item) => item.rev), [3]);
  assert.deepEqual(await since(h, board.id, 1), { ok: true, rev: 3, snapshot: true });
});

test('a failed first write answers unavailable, writes nothing and does not latch the store', async (t) => {
  let failDocument = false;
  const h = setup(t, { fileOps: { writeText: (filePath, text) => {
    if (failDocument && /board_[0-9a-f-]+\.json$/u.test(filePath)) {
      failDocument = false;
      throw Object.assign(new Error('injected'), { code: 'EBUSY' });
    }
    return durable.writeText(filePath, text);
  } } });
  const board = await boardWith(h, 1);
  failDocument = true;
  const failed = await h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note('x', 300)) });
  assert.deepEqual([failed.error.reason, failed.error.retryable], ['team_board_unavailable', true]);
  assert.equal(h.document(board.id).rev, 1);
  const next = await must(h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note('y', 600)) }));
  assert.equal(next.rev, 2, 'the next call reads the disk and is served');
});

test('a stored journal is read against its document: damaged, newer, short and long', () => {
  const entry = (rev) => ({ rev, batch_id: `b${rev}`, actor: ALICE, at: '2026-11-15T09:00:00.000Z', applied: { ops: [] },
    inverse: { ops: [] } });
  const stored = { schema_version: 1, floor_rev: 0, entries: [entry(1), entry(2), entry(3)] };
  assert.deepEqual(journals.readJournal(stored, 3), { status: 'ok', journal: stored });
  assert.deepEqual(journals.readJournal(null, 4).journal, { schema_version: 1, floor_rev: 4, entries: [] });
  assert.equal(journals.readJournal({ ...stored, schema_version: 2 }, 3).status, 'newer');
  for (const damaged of [[], { ...stored, extra: 1 }, { ...stored, entries: [entry(2), entry(1)] },
    { ...stored, entries: [{ ...entry(1), actor: '' }] }, { ...stored, entries: [{ ...entry(1), applied: null }] }]) {
    assert.deepEqual(journals.readJournal(damaged, 3), { status: 'damaged', journal: { schema_version: 1, floor_rev: 3, entries: [] } });
  }
  assert.deepEqual(journals.readJournal(stored, 5).journal.floor_rev, 5, 'short of the document: the floor rises');
  const long = journals.readJournal(stored, 2).journal;
  assert.deepEqual([long.floor_rev, long.entries.map((item) => item.rev)], [2, [1, 2]], 'entries past the document go');
  const pushed = journals.pushEntry(stored, entry(4));
  assert.deepEqual(pushed.entries.map((item) => item.rev), [1, 2, 3, 4]);
  assert.deepEqual(stored.entries.length, 3, 'the input is not changed');
  assert.deepEqual(journals.since(pushed, 4, 1, 1024 * 1024).batches.map((item) => item.rev), [2, 3, 4]);
  assert.deepEqual(journals.since({ ...pushed, entries: [entry(1), entry(3), entry(4)] }, 4, 1, 1024 * 1024),
    { snapshot: true }, 'a hole is never served');
});

test('a batch sent again is a duplicate while the journal holds it, past the model\'s ring of 32 ids (P5)', async (t) => {
  const h = setup(t);
  const board = (await must(h.boards.create({ projectId: P, actor: ALICE, name: 'Plan' }))).board;
  const apply = (sent) => h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: sent });
  const added = batch(note('first'));
  await must(apply(added));
  const moved = batch({ op: 'card.place', id: added.ops[0].card.id, x: 40, y: 0 });
  await must(apply(moved));
  for (let n = 0; n < 40; n += 1) await must(apply(batch(note(`n${n}`, (n + 1) * 300))));
  assert.equal(h.document(board.id).recent_batches.includes(added.batch_id), false, 'the ring has forgotten both');
  const before = JSON.stringify([h.document(board.id), h.journal(board.id)]);
  // An add sent again would be refused as already there, and a move applied again, if they were judged as new.
  for (const sent of [added, moved]) {
    assert.deepEqual(await apply(sent), { ok: true, rev: 42, applied: null, duplicate: true });
  }
  assert.equal(JSON.stringify([h.document(board.id), h.journal(board.id)]), before, 'nothing was written');
  // The bound: once the journal has dropped the entry (200 batches), the batch is judged as new.
  for (let n = 0; n < 200; n += 1) await must(apply(batch(note(`m${n}`, (n + 50) * 300))));
  assert.equal(h.journal(board.id).entries.some((entry) => entry.batch_id === added.batch_id), false);
  assert.equal((await apply(added)).error?.reason, 'team_board_refused');
});
