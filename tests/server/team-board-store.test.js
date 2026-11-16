'use strict';

// new-test-file: row 151 slice T1 adds the team host's board store (server/team/boards/), a new host surface; the
// desktop board store keeps its own tests (tests/board-store.test.js, tests/board-service.test.js).
//
// The store on a real temp profile: create, list, get, rename, remove, the trash and restore; apply with the actor
// argument, consecutive revisions under concurrency, duplicates and model refusals; a missing actor and `recheck`
// on every mutating call; one not-found answer; the storage cap; read-only documents and a newer index; links;
// the 7-day sweep; removing a project. Every refusal also shows that nothing on disk changed.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { removeTreeSync } = require('../../services/fs-remove-no-follow');
const { TEAM_BOARD_REASONS, createTeamBoards } = require('../../server/team/boards/team-boards');
const { batch, must, note, tree } = require('./helpers/team-board-kit');

const DAY = 24 * 60 * 60 * 1000;
const P = 'project_alpha';
const Q = 'project_beta';
const ALICE = 'member_alice';
const BOB = 'member_bob';
const START = Date.UTC(2026, 10, 15, 9, 0, 0);

function setup(t, options = {}) {
  const profile = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-team-boards-')));
  t.after(() => removeTreeSync(profile));
  const clock = { now: START };
  const logs = [];
  const make = (extra = {}) => createTeamBoards({ userDataPath: profile, clock: () => clock.now,
    logger: (level, event, data) => logs.push({ level, event, data }), ...options, ...extra });
  const root = path.join(profile, 'team-boards');
  const file = (projectId, name) => path.join(root, projectId, name);
  return { profile, root, clock, logs, boards: make(), make, file,
    doc: (projectId, boardId) => file(projectId, `${boardId}.json`),
    journalFile: (projectId, boardId) => file(projectId, `${boardId}.journal.json`),
    readJson: (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8')) };
}

const reasonOf = (answer) => answer?.error?.reason;

async function newBoard(h, projectId = P, name = 'Plan', actor = ALICE) {
  return (await must(h.boards.create({ projectId, actor, name }), 'create')).board;
}

test('the reason words are one frozen list of lowercase words', () => {
  assert.equal(Object.isFrozen(TEAM_BOARD_REASONS), true);
  assert.deepEqual([...TEAM_BOARD_REASONS].sort(), ['team_board_invalid', 'team_board_limit', 'team_board_not_found',
    'team_board_read_only', 'team_board_refused', 'team_board_storage_limit', 'team_board_trash_limit', 'team_board_unavailable']);
});

test('create, list, get, rename, remove, listDeleted and restore', async (t) => {
  const h = setup(t);
  assert.deepEqual(await h.boards.list({ projectId: P }), { ok: true, boards: [] });
  assert.equal(fs.existsSync(h.root), false, 'listing a project with no folder creates nothing');
  const board = await newBoard(h);
  assert.match(board.id, /^board_[0-9a-f-]{36}$/u);
  assert.deepEqual(board, { id: board.id, name: 'Plan', rev: 0, created_at: new Date(START).toISOString(),
    updated_at: new Date(START).toISOString(), created_by: ALICE });
  assert.equal(h.readJson(h.doc(P, board.id)).project_id, P);
  assert.equal(h.readJson(h.file(P, 'index.json')).boards[board.id].created_by, ALICE);
  assert.deepEqual((await must(h.boards.list({ projectId: P }))).boards, [board]);
  const got = await must(h.boards.get({ projectId: P, boardId: board.id }));
  assert.deepEqual([got.board.name, got.rev, got.read_only], ['Plan', 0, false]);

  h.clock.now += 1000;
  const renamed = await must(h.boards.rename({ projectId: P, boardId: board.id, actor: BOB, name: 'Renamed' }));
  assert.equal(renamed.rev, 1);
  assert.equal((await must(h.boards.get({ projectId: P, boardId: board.id }))).board.name, 'Renamed');
  const journal = h.readJson(h.journalFile(P, board.id));
  assert.deepEqual(journal.entries.map((entry) => [entry.rev, entry.actor]), [[1, BOB]]);
  assert.equal((await must(h.boards.list({ projectId: P }))).boards[0].name, 'Renamed');

  h.clock.now += 1000;
  await must(h.boards.remove({ projectId: P, boardId: board.id, actor: BOB }));
  assert.deepEqual((await must(h.boards.list({ projectId: P }))).boards, []);
  const deleted = (await must(h.boards.listDeleted({ projectId: P }))).boards;
  assert.deepEqual(deleted.map((row) => [row.id, row.deleted_at, row.deleted_by]),
    [[board.id, new Date(START + 2000).toISOString(), BOB]]);
  assert.equal(reasonOf(await h.boards.get({ projectId: P, boardId: board.id })), 'team_board_not_found');
  assert.equal(fs.existsSync(h.doc(P, board.id)), true, 'the files stay in the trash');
  assert.equal(reasonOf(await h.boards.remove({ projectId: P, boardId: board.id, actor: BOB })), 'team_board_not_found');
  const restored = await must(h.boards.restore({ projectId: P, boardId: board.id, actor: ALICE }));
  assert.equal(restored.board.id, board.id);
  assert.deepEqual((await must(h.boards.list({ projectId: P }))).boards.map((row) => row.id), [board.id]);
  assert.deepEqual((await must(h.boards.listDeleted({ projectId: P }))).boards, []);
  assert.equal(reasonOf(await h.boards.restore({ projectId: P, boardId: board.id, actor: ALICE })), 'team_board_not_found');

  const before = tree(h.root);
  for (const name of ['', 'two\nlines', 'x'.repeat(201), 42, null]) {
    assert.equal(reasonOf(await h.boards.create({ projectId: P, actor: ALICE, name })), 'team_board_invalid', String(name));
    assert.equal(reasonOf(await h.boards.rename({ projectId: P, boardId: board.id, actor: ALICE, name })), 'team_board_invalid');
  }
  assert.deepEqual(tree(h.root), before);
});

test('the 20-board cap counts live boards only, and restore is refused at the cap', async (t) => {
  const h = setup(t);
  const ids = [];
  for (let n = 0; n < 20; n += 1) {
    h.clock.now += 1;
    ids.push((await newBoard(h, P, `Board ${n}`)).id);
  }
  assert.deepEqual((await must(h.boards.list({ projectId: P }))).boards.map((row) => row.id), ids, 'oldest first');
  let before = tree(h.root);
  const over = await h.boards.create({ projectId: P, actor: ALICE, name: 'One too many' });
  assert.deepEqual([over.error.reason, over.error.code], ['team_board_limit', 'CMP-HOST-0007']);
  assert.deepEqual(tree(h.root), before);
  await must(h.boards.remove({ projectId: P, boardId: ids[0], actor: ALICE }));
  const again = await newBoard(h, P, 'In the freed seat');
  assert.equal((await must(h.boards.usage({ projectId: P }))).live, 20);
  before = tree(h.root);
  assert.equal(reasonOf(await h.boards.restore({ projectId: P, boardId: ids[0], actor: ALICE })), 'team_board_limit');
  assert.deepEqual(tree(h.root), before);
  await must(h.boards.remove({ projectId: P, boardId: again.id, actor: ALICE }));
  await must(h.boards.restore({ projectId: P, boardId: ids[0], actor: ALICE }));
  const usage = await must(h.boards.usage({ projectId: P }));
  assert.deepEqual([usage.live, usage.deleted], [20, 1]);
  assert.equal(usage.bytes > 0, true);
});

test('apply stores the actor argument, and twenty concurrent batches get consecutive revisions in call order', async (t) => {
  const h = setup(t);
  const board = await newBoard(h);
  const forged = { ...batch(note('first')), actor: 'member_mallory', now: '1999-01-01T00:00:00Z' };
  const first = await must(h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: forged }));
  assert.deepEqual([first.rev, first.duplicate, first.applied.actor], [1, false, ALICE]);
  const card = Object.values((await must(h.boards.get({ projectId: P, boardId: board.id }))).board.cards)[0];
  assert.deepEqual([card.created_by, card.created_at], [ALICE, new Date(START).toISOString()]);
  const batches = Array.from({ length: 20 }, (_, n) => batch(note(`n${n}`, n * 300)));
  const answers = await Promise.all(batches.map((b, n) => h.boards.apply({ projectId: P, boardId: board.id,
    actor: n % 2 ? ALICE : BOB, batch: b })));
  assert.deepEqual(answers.map((answer) => answer.rev), Array.from({ length: 20 }, (_, n) => n + 2));
  const journal = h.readJson(h.journalFile(P, board.id));
  assert.deepEqual(journal.entries.map((entry) => entry.rev), Array.from({ length: 21 }, (_, n) => n + 1));
  assert.deepEqual(journal.entries.slice(1).map((entry) => entry.batch_id), batches.map((b) => b.batch_id));
  assert.deepEqual(journal.entries.map((entry) => entry.actor), [ALICE, ...batches.map((_, n) => (n % 2 ? ALICE : BOB))]);
  assert.equal(journal.entries.every((entry) => entry.inverse && entry.applied), true);
  assert.equal(h.readJson(h.file(P, 'index.json')).boards[board.id].rev, 21);
});

test('a restored card keeps the creator the host recorded at its removal, never the batch\'s word', async (t) => {
  const h = setup(t);
  const board = await newBoard(h);
  const apply = (actor, ...ops) => must(h.boards.apply({ projectId: P, boardId: board.id, actor, batch: batch(...ops) }));
  const cards = async () => (await must(h.boards.get({ projectId: P, boardId: board.id }))).board.cards;
  const added = note('by Alice');
  await apply(ALICE, added);
  const made = (await cards())[added.card.id];
  h.clock.now += 60_000;
  await apply(BOB, { op: 'card.remove', id: made.id, content_rev: made.content_rev });
  h.clock.now += 60_000;
  // Bob undoes his removal and claims the card for Mallory, in 1999. The journal's record of the removal wins.
  const forged = { created_by: 'member_mallory', created_at: '1999-01-01T00:00:00Z' };
  await apply(BOB, { op: 'card.add', restore: true, card: { ...made, ...forged } });
  const back = (await cards())[made.id];
  assert.deepEqual([back.created_by, back.created_at, back.updated_by, back.alias], [ALICE, made.created_at, BOB, made.alias]);
  assert.equal(back.updated_at, new Date(h.clock.now).toISOString());
  // A restore of a card the journal never saw removed counts as made now by the member who sent it.
  const fresh = { ...note('never removed').card, ...forged };
  await apply(BOB, { op: 'card.add', restore: true, card: fresh }, { op: 'card.add', card: { ...note('plain').card, ...forged } });
  const after = await cards();
  for (const card of Object.values(after).filter((item) => item.id !== made.id)) {
    assert.deepEqual([card.created_by, card.created_at], [BOB, new Date(h.clock.now).toISOString()], card.data.text);
  }
  assert.equal(JSON.stringify(after).includes('member_mallory'), false);
  // A batch whose operations are not a list is still the model's to refuse.
  assert.equal(reasonOf(await h.boards.apply({ projectId: P, boardId: board.id, actor: BOB, batch: { batch_id: 'b-x', ops: 'card.add' } })),
    'team_board_refused');
});

test('since pages the journal after a revision and never returns an inverse', async (t) => {
  const h = setup(t);
  const board = await newBoard(h);
  for (let n = 0; n < 3; n += 1) await must(h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note()) }));
  const page = await must(h.boards.since({ projectId: P, boardId: board.id, afterRev: 1 }));
  assert.deepEqual([page.rev, page.more, page.batches.map((item) => item.rev)], [3, false, [2, 3]]);
  assert.deepEqual(Object.keys(page.batches[0]).sort(), ['actor', 'applied', 'at', 'batch_id', 'rev']);
  assert.equal((await must(h.boards.since({ projectId: P, boardId: board.id, afterRev: 4 }))).snapshot, true);
});

test('a duplicate batch writes nothing; a model refusal writes nothing and carries the model\'s reason', async (t) => {
  const h = setup(t);
  const board = await newBoard(h);
  const sent = batch(note('once'));
  await must(h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: sent }));
  const before = tree(h.root);
  assert.deepEqual(await h.boards.apply({ projectId: P, boardId: board.id, actor: BOB, batch: sent }),
    { ok: true, rev: 1, applied: null, duplicate: true });
  const cardId = sent.ops[0].card.id;
  const stale = await h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE,
    batch: batch({ op: 'card.edit', id: cardId, content_rev: 7, data: { text: 'late' } }) });
  assert.deepEqual([stale.ok, stale.error.reason, stale.error.code], [false, 'team_board_refused', 'CMP-HOST-0004']);
  assert.equal(stale.board.reason, 'stale');
  assert.equal(stale.board.index, 0);
  const malformed = await h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE,
    batch: batch(note('fine'), { op: 'card.wobble' }) });
  assert.deepEqual([malformed.error.reason, malformed.error.code, malformed.board.reason, malformed.board.index],
    ['team_board_refused', 'CMP-HOST-0001', 'invalid', 1]);
  const missing = await h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE,
    batch: batch({ op: 'card.remove', id: crypto.randomUUID(), content_rev: 0 }) });
  assert.deepEqual([missing.error.code, missing.board.reason], ['CMP-HOST-0004', 'missing_target']);
  assert.equal(reasonOf(await h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: null })), 'team_board_invalid');
  assert.deepEqual(tree(h.root), before);
});

test('a missing or malformed actor is refused on every mutating method and nothing is written', async (t) => {
  const h = setup(t);
  const board = await newBoard(h);
  const trashed = await newBoard(h, P, 'Trashed');
  await must(h.boards.remove({ projectId: P, boardId: trashed.id, actor: ALICE }));
  const before = tree(h.root);
  const calls = {
    create: (actor, recheck) => h.boards.create({ projectId: P, actor, recheck, name: 'New' }),
    apply: (actor, recheck) => h.boards.apply({ projectId: P, boardId: board.id, actor, recheck, batch: batch(note()) }),
    rename: (actor, recheck) => h.boards.rename({ projectId: P, boardId: board.id, actor, recheck, name: 'New name' }),
    remove: (actor, recheck) => h.boards.remove({ projectId: P, boardId: board.id, actor, recheck }),
    restore: (actor, recheck) => h.boards.restore({ projectId: P, boardId: trashed.id, actor, recheck }),
    writeProposals: (actor, recheck) => h.boards.writeProposals({ projectId: P, boardId: board.id, actor, recheck,
      proposals: [{ a: 1 }] }),
  };
  for (const [method, call] of Object.entries(calls)) {
    for (const actor of [undefined, null, '', ' member', '-member', 'm'.repeat(201), 42, {}, ['member_alice']]) {
      const recheck = () => { throw new Error('recheck must not run for a refused actor'); };
      const answer = await call(actor, recheck);
      assert.equal(reasonOf(answer), 'team_board_invalid', `${method} ${JSON.stringify(actor)}`);
    }
  }
  assert.deepEqual(tree(h.root), before);
});

test('recheck runs once per mutating call inside the queue, and its failure stops the call with nothing written', async (t) => {
  const h = setup(t);
  const seen = [];
  const spy = (name) => async () => { seen.push(name); return null; };
  const board = (await must(h.boards.create({ projectId: P, actor: ALICE, name: 'Plan', recheck: spy('create') }))).board;
  const trashed = await newBoard(h, P, 'Trashed');
  await must(h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note()), recheck: spy('apply') }));
  await must(h.boards.rename({ projectId: P, boardId: board.id, actor: ALICE, name: 'Two', recheck: spy('rename') }));
  await must(h.boards.writeProposals({ projectId: P, boardId: board.id, actor: ALICE, proposals: [], recheck: spy('writeProposals') }));
  await must(h.boards.remove({ projectId: P, boardId: trashed.id, actor: ALICE, recheck: spy('remove') }));
  await must(h.boards.restore({ projectId: P, boardId: trashed.id, actor: ALICE, recheck: spy('restore') }));
  assert.deepEqual(seen, ['create', 'apply', 'rename', 'writeProposals', 'remove', 'restore']);

  const denial = { ok: false, error: { code: 'CMP-HOST-0003', reason: 'role_forbidden', retryable: false } };
  const deny = async () => denial;
  const before = tree(h.root);
  const denied = [
    await h.boards.create({ projectId: P, actor: ALICE, name: 'No', recheck: deny }),
    await h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note()), recheck: deny }),
    await h.boards.rename({ projectId: P, boardId: board.id, actor: ALICE, name: 'No', recheck: deny }),
    await h.boards.writeProposals({ projectId: P, boardId: board.id, actor: ALICE, proposals: [{ a: 1 }], recheck: deny }),
    await h.boards.remove({ projectId: P, boardId: board.id, actor: ALICE, recheck: deny }),
  ];
  for (const answer of denied) assert.equal(answer, denial, 'the recheck answer is returned as it is');
  await must(h.boards.remove({ projectId: P, boardId: trashed.id, actor: ALICE }));
  const inTrash = tree(h.root);
  assert.equal(await h.boards.restore({ projectId: P, boardId: trashed.id, actor: ALICE, recheck: deny }), denial);
  assert.deepEqual(tree(h.root), inTrash, 'a denied restore leaves the board in the trash');
  await must(h.boards.restore({ projectId: P, boardId: trashed.id, actor: ALICE }));
  // Only null or undefined lets a call through: a falsy or success-shaped verdict, or a throw, is a refusal.
  for (const verdict of [false, 0, '', true, 'ok', { ok: true }, []]) {
    for (const recheck of [async () => verdict, () => verdict]) {
      assert.equal(reasonOf(await h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note()), recheck })),
        'team_board_unavailable', `apply ${JSON.stringify(verdict)}`);
      assert.equal(reasonOf(await h.boards.create({ projectId: P, actor: ALICE, name: 'No', recheck })),
        'team_board_unavailable', `create ${JSON.stringify(verdict)}`);
    }
  }
  assert.equal(reasonOf(await h.boards.remove({ projectId: P, boardId: board.id, actor: ALICE,
    recheck: async () => { throw new Error('directory gone'); } })), 'team_board_unavailable');
  assert.deepEqual(tree(h.root), before, 'document, journal, index and proposals bytes unchanged');
  assert.equal(reasonOf(await h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note()),
    recheck: 'not a function' })), 'team_board_invalid');

  // A recheck that fails after a delay holds the queue; the call behind it starts after and is served.
  const order = [];
  const slow = async () => { order.push('slow start'); await new Promise((resolve) => setTimeout(resolve, 40)); order.push('slow end'); return denial; };
  const quick = async () => { order.push('quick'); return null; };
  const [late, next] = await Promise.all([
    h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note('held')), recheck: slow }),
    h.boards.apply({ projectId: P, boardId: board.id, actor: BOB, batch: batch(note('next')), recheck: quick }),
  ]);
  assert.equal(late, denial);
  assert.deepEqual(order, ['slow start', 'slow end', 'quick']);
  assert.equal(next.rev, 3, 'the held call wrote nothing, so the next one takes the following revision');
});

test('not found is one answer: another project, an unknown project, a malformed id, a deleted board, a case variant', async (t) => {
  const h = setup(t);
  const board = await newBoard(h, P);
  await newBoard(h, Q);
  const trashed = await newBoard(h, P, 'Trashed');
  await must(h.boards.remove({ projectId: P, boardId: trashed.id, actor: ALICE }));
  const asks = [
    { projectId: Q, boardId: board.id },
    { projectId: 'project_unknown', boardId: board.id },
    { projectId: P, boardId: 'board_not-a-uuid' },
    { projectId: P, boardId: board.id.toUpperCase() },
    { projectId: 'general', boardId: board.id },
    { projectId: 'project_general', boardId: board.id },
    { projectId: P, boardId: trashed.id },
    { projectId: 'project_Alpha', boardId: board.id },
  ];
  const before = tree(h.root);
  const answers = [];
  for (const ask of asks) {
    answers.push(await h.boards.get(ask));
    answers.push(await h.boards.apply({ ...ask, actor: ALICE, batch: batch(note()) }));
    answers.push(await h.boards.since({ ...ask, afterRev: 0 }));
    answers.push(await h.boards.journalEntry({ ...ask, rev: 1 }));
    answers.push(await h.boards.readProposals(ask));
    answers.push(await h.boards.writeProposals({ ...ask, actor: ALICE, proposals: [] }));
    answers.push(await h.boards.rename({ ...ask, actor: ALICE, name: 'X' }));
  }
  // A live board is not in the trash.
  answers.push(await h.boards.restore({ projectId: P, boardId: board.id, actor: ALICE }));
  for (const answer of answers) assert.deepEqual(answer, answers[0]);
  assert.equal(answers[0].error.reason, 'team_board_not_found');
  assert.equal(reasonOf(await h.boards.create({ projectId: 'project_Alpha', actor: ALICE, name: 'Case' })),
    process.platform === 'linux' ? undefined : 'team_board_not_found', 'a case variant never writes into the other folder');
  if (process.platform !== 'linux') assert.deepEqual(tree(h.root), before);
  const text = JSON.stringify(h.logs);
  for (const marker of ['Plan', 'Trashed', h.profile]) assert.equal(text.includes(marker), false, marker);
});

test('the storage cap, lowered by the constructor, refuses the write that would pass it and leaves the files', async (t) => {
  const h = setup(t);
  assert.throws(() => h.make({ limits: { storageBytes: 65 * 1024 * 1024 } }), RangeError, 'the cap can only be lowered');
  assert.throws(() => h.make({ limits: { pictures: 1 } }), RangeError);
  const board = await newBoard(h);
  const used = (await must(h.boards.usage({ projectId: P }))).bytes;
  const capped = h.make({ limits: { storageBytes: used + 3000 } });
  await must(capped.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note('small')) }));
  const before = tree(h.root);
  const refused = await capped.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note('x'.repeat(4000))) });
  assert.deepEqual([refused.error.reason, refused.error.code], ['team_board_storage_limit', 'CMP-HOST-0007']);
  assert.equal(reasonOf(await capped.writeProposals({ projectId: P, boardId: board.id, actor: ALICE,
    proposals: [{ text: 'y'.repeat(4000) }] })), 'team_board_storage_limit');
  const tight = h.make({ limits: { storageBytes: (await must(h.boards.usage({ projectId: P }))).bytes + 100 } });
  assert.equal(reasonOf(await tight.create({ projectId: P, actor: ALICE, name: 'Does not fit' })), 'team_board_storage_limit');
  assert.deepEqual(tree(h.root), before);
  // Over the cap, a write that grows the project is refused and one that shrinks it is not.
  await must(h.boards.writeProposals({ projectId: P, boardId: board.id, actor: ALICE, proposals: [{ text: 'q'.repeat(500) }] }));
  const over = h.make({ limits: { storageBytes: (await must(h.boards.usage({ projectId: P }))).bytes - 100 } });
  assert.equal(reasonOf(await over.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note()) })),
    'team_board_storage_limit');
  await must(over.writeProposals({ projectId: P, boardId: board.id, actor: ALICE, proposals: [] }));
});

test('proposals are stored as an opaque bounded list of plain objects', async (t) => {
  const h = setup(t);
  const board = await newBoard(h);
  assert.deepEqual(await h.boards.readProposals({ projectId: P, boardId: board.id }), { ok: true, proposals: [] });
  const list = [{ id: 'p1', ops: [{ op: 'card.add' }] }, { id: 'p2' }];
  await must(h.boards.writeProposals({ projectId: P, boardId: board.id, actor: ALICE, proposals: list }));
  assert.deepEqual((await must(h.boards.readProposals({ projectId: P, boardId: board.id }))).proposals, list);
  const before = tree(h.root);
  const cyclic = {};
  cyclic.self = cyclic;
  for (const proposals of [null, {}, [1], ['p'], [[]], [null], Array.from({ length: 21 }, () => ({})),
    [{ text: 'z'.repeat(600 * 1024) }], [cyclic], [new Date(0)]]) {
    assert.equal(reasonOf(await h.boards.writeProposals({ projectId: P, boardId: board.id, actor: ALICE, proposals })),
      'team_board_invalid');
  }
  assert.deepEqual(tree(h.root), before);
});

test('read-only documents: another project\'s id, a damaged file and a newer schema refuse every mutation', async (t) => {
  const h = setup(t);
  const cases = {
    project_mismatch: (raw) => JSON.stringify({ ...JSON.parse(raw), project_id: Q }),
    corrupt: (raw) => raw.slice(0, raw.length - 5),
    newer_schema: (raw) => JSON.stringify({ ...JSON.parse(raw), schema_version: 2 }),
  };
  for (const [reason, damage] of Object.entries(cases)) {
    const board = await newBoard(h, P, `Broken ${reason}`);
    await must(h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note()) }));
    fs.writeFileSync(h.doc(P, board.id), damage(fs.readFileSync(h.doc(P, board.id), 'utf8')));
    const fresh = h.make();
    const before = tree(h.root);
    const got = await must(fresh.get({ projectId: P, boardId: board.id }));
    assert.deepEqual([got.read_only, got.reason, got.board], [true, reason, null], reason);
    const answers = [
      await fresh.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note()) }),
      await fresh.rename({ projectId: P, boardId: board.id, actor: ALICE, name: 'Fixed' }),
      await fresh.remove({ projectId: P, boardId: board.id, actor: ALICE }),
      await fresh.writeProposals({ projectId: P, boardId: board.id, actor: ALICE, proposals: [] }),
    ];
    for (const answer of answers) assert.equal(reasonOf(answer), 'team_board_read_only', reason);
    assert.deepEqual((await must(fresh.since({ projectId: P, boardId: board.id, afterRev: 0 }))).snapshot, true);
    assert.equal((await fresh.sweep()).ok, true);
    assert.deepEqual(tree(h.root), before, `${reason}: byte-identical afterwards`);
  }
});

test('a newer index schema makes the project unavailable and is never rewritten', async (t) => {
  const h = setup(t);
  const board = await newBoard(h);
  const indexPath = h.file(P, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify({ ...h.readJson(indexPath), schema_version: 2 }));
  const fresh = h.make();
  const before = tree(h.root);
  const answers = [
    await fresh.list({ projectId: P }),
    await fresh.get({ projectId: P, boardId: board.id }),
    await fresh.create({ projectId: P, actor: ALICE, name: 'More' }),
    await fresh.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note()) }),
    await fresh.remove({ projectId: P, boardId: board.id, actor: ALICE }),
  ];
  for (const answer of answers) {
    assert.deepEqual([answer.error.reason, answer.error.retryable], ['team_board_unavailable', true]);
  }
  await fresh.sweep();
  assert.deepEqual(tree(h.root), before);
});

test('a missing or damaged index is rebuilt from the documents on disk', async (t) => {
  const h = setup(t);
  const one = await newBoard(h, P, 'One');
  h.clock.now += 1;
  const two = await newBoard(h, P, 'Two');
  await must(h.boards.apply({ projectId: P, boardId: two.id, actor: BOB, batch: batch(note()) }));
  for (const damage of [() => fs.unlinkSync(h.file(P, 'index.json')), () => fs.writeFileSync(h.file(P, 'index.json'), '{"boa')]) {
    damage();
    const rows = (await must(h.make().list({ projectId: P }))).boards;
    assert.deepEqual(rows.map((row) => [row.id, row.name, row.rev, row.created_by]),
      [[one.id, 'One', 0, null], [two.id, 'Two', 1, BOB]]);
    assert.equal(h.readJson(h.file(P, 'index.json')).schema_version, 1, 'the rebuilt index is written');
  }
});

test('links at team-boards, at a project folder and at a document are never followed', async (t) => {
  const h = setup(t);
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-team-boards-outside-')));
  t.after(() => removeTreeSync(outside));
  // A real board to copy, made in a second profile.
  const other = setup(t);
  const board = await newBoard(other);
  fs.cpSync(path.join(other.root, P), path.join(outside, P), { recursive: true });
  const outsideBefore = tree(outside);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';

  fs.symlinkSync(outside, h.root, linkType);
  for (const answer of [await h.boards.list({ projectId: P }), await h.boards.get({ projectId: P, boardId: board.id }),
    await h.boards.create({ projectId: P, actor: ALICE, name: 'Through' }), await h.boards.removeProject({ projectId: P })]) {
    assert.equal(reasonOf(answer), 'team_board_unavailable');
  }
  assert.deepEqual(tree(outside), outsideBefore);
  fs.unlinkSync(h.root);

  fs.mkdirSync(h.root);
  fs.symlinkSync(path.join(outside, P), path.join(h.root, P), linkType);
  const fresh = h.make();
  for (const answer of [await fresh.list({ projectId: P }), await fresh.get({ projectId: P, boardId: board.id }),
    await fresh.create({ projectId: P, actor: ALICE, name: 'Through' })]) {
    assert.equal(reasonOf(answer), 'team_board_unavailable');
  }
  assert.deepEqual(tree(outside), outsideBefore);
  await must(fresh.removeProject({ projectId: P }), 'the link itself goes; nothing behind it');
  assert.equal(fs.existsSync(path.join(h.root, P)), false);
  assert.deepEqual(tree(outside), outsideBefore);

  // h.boards keeps the project closed after its refused removeProject (fail closed): a new store goes on.
  const mine = (await must(h.make().create({ projectId: P, actor: ALICE, name: 'Mine' }))).board;
  const target = path.join(outside, P, `${board.id}.json`);
  fs.unlinkSync(h.doc(P, mine.id));
  // A hard link (no privilege needed on any platform) is a second name for another file: never read or written.
  fs.linkSync(target, h.doc(P, mine.id));
  const hard = await must(h.make().get({ projectId: P, boardId: mine.id }));
  assert.deepEqual([hard.read_only, hard.reason, hard.board], [true, 'unsafe', null]);
  assert.equal(reasonOf(await h.make().apply({ projectId: P, boardId: mine.id, actor: ALICE, batch: batch(note()) })),
    'team_board_read_only');
  assert.deepEqual(tree(outside), outsideBefore);
  fs.unlinkSync(h.doc(P, mine.id));
  try {
    fs.symlinkSync(target, h.doc(P, mine.id), 'file');
  } catch (error) {
    if (error.code === 'EPERM') {
      t.diagnostic('a file symlink needs Developer Mode on Windows: the file-link case is skipped');
      return;
    }
    throw error;
  }
  const linked = await must(h.make().get({ projectId: P, boardId: mine.id }));
  assert.deepEqual([linked.read_only, linked.board], [true, null]);
  assert.equal(reasonOf(await h.make().apply({ projectId: P, boardId: mine.id, actor: ALICE, batch: batch(note()) })),
    'team_board_read_only');
  assert.deepEqual(tree(outside), outsideBefore);
});

test('sweep removes a board deleted 7 days and 1 ms ago, files and index entry, and keeps one deleted 6 days ago', async (t) => {
  const h = setup(t);
  const old = await newBoard(h, P, 'Old');
  const young = await newBoard(h, P, 'Young');
  const live = await newBoard(h, P, 'Live');
  for (const board of [old, young]) {
    await must(h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note()) }));
    await must(h.boards.writeProposals({ projectId: P, boardId: board.id, actor: ALICE, proposals: [{ a: 1 }] }));
  }
  await must(h.boards.remove({ projectId: P, boardId: old.id, actor: ALICE }));
  h.clock.now += DAY + 1;
  await must(h.boards.remove({ projectId: P, boardId: young.id, actor: ALICE }));
  h.clock.now = START + 7 * DAY;
  assert.deepEqual(await h.boards.sweep(), { ok: true, removed: 0, failed: 0 }, 'exactly 7 days is kept');
  h.clock.now = START + 7 * DAY + 1;
  assert.deepEqual(await h.boards.sweep(), { ok: true, removed: 1, failed: 0 });
  const names = fs.readdirSync(path.join(h.root, P));
  assert.equal(names.some((name) => name.startsWith(old.id)), false, 'document, journal and proposals gone');
  assert.equal(names.filter((name) => name.startsWith(young.id)).length, 3);
  assert.equal(h.readJson(h.file(P, 'index.json')).boards[old.id], undefined);
  assert.deepEqual((await must(h.boards.listDeleted({ projectId: P }))).boards.map((row) => row.id), [young.id]);
  assert.deepEqual((await must(h.boards.list({ projectId: P }))).boards.map((row) => row.id), [live.id]);
  assert.equal(reasonOf(await h.boards.restore({ projectId: P, boardId: old.id, actor: ALICE })), 'team_board_not_found');
});

test('removeProject removes the folder with its assets, answers ok when absent, and a call queued behind it is not found', async (t) => {
  const h = setup(t);
  const board = await newBoard(h);
  const keep = await newBoard(h, Q);
  await must(h.boards.writeProposals({ projectId: P, boardId: board.id, actor: ALICE, proposals: [{ a: 1 }] }));
  fs.mkdirSync(path.join(h.root, P, 'assets', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(h.root, P, 'assets', 'nested', 'a.png'), 'png');
  const release = {};
  const held = new Promise((resolve) => { release.go = resolve; });
  const first = h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note()),
    recheck: async () => { await held; return null; } });
  const removal = h.boards.removeProject({ projectId: P });
  const behind = h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note()) });
  const create = h.boards.create({ projectId: P, actor: ALICE, name: 'After' });
  release.go();
  const [applied, removed, late, made] = await Promise.all([first, removal, behind, create]);
  assert.equal(applied.rev, 1, 'the call ahead of the removal finishes first');
  assert.deepEqual(removed, { ok: true });
  assert.equal(reasonOf(late), 'team_board_not_found');
  assert.equal(reasonOf(made), 'team_board_not_found');
  assert.equal(fs.existsSync(path.join(h.root, P)), false, 'nothing recreated the folder');
  assert.deepEqual(await h.boards.list({ projectId: P }), { ok: true, boards: [] });
  assert.deepEqual(await h.boards.removeProject({ projectId: P }), { ok: true }, 'again: already gone');
  assert.deepEqual(await h.boards.removeProject({ projectId: 'project_never' }), { ok: true });
  assert.deepEqual((await must(h.boards.list({ projectId: Q }))).boards.map((row) => row.id), [keep.id]);
});

test('a clock, id maker or path guard that fails is a refusal, never a default', async (t) => {
  const h = setup(t);
  const board = await newBoard(h);
  const before = tree(h.root);
  const broken = [
    h.make({ clock: () => Number.NaN }),
    h.make({ clock: () => { throw new Error('no time'); } }),
    h.make({ makeId: () => 'NOT-A-UUID' }),
    h.make({ assertSafePath: () => { throw new Error('unsafe'); } }),
  ];
  for (const store of broken) {
    assert.equal(reasonOf(await store.create({ projectId: P, actor: ALICE, name: 'New' })), 'team_board_unavailable');
  }
  for (const store of [broken[0], broken[1], broken[3]]) {
    assert.equal(reasonOf(await store.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note()) })),
      'team_board_unavailable');
  }
  assert.deepEqual(tree(h.root), before);
  assert.throws(() => createTeamBoards({ userDataPath: 'relative/profile' }), TypeError);
  assert.throws(() => createTeamBoards({ userDataPath: h.profile, assertSafePath: null }), TypeError);
});
