'use strict';

// new-test-file: a new lane (row 151 hardening, P5-A): the cost of a full 500-card team board on the host. Each case prints
// `perf <name> <ms>` (best of 5 after one warm-up) and asserts a ceiling at ten times what was measured on the development
// machine, rounded up, never under 50 ms: the full suite runs many files at once on throttled cores, so the ceilings catch a
// quadratic regression and are not a benchmark. Everything goes through the real router, authorizer, member store, board store
// and event stream of the project fixture, on a temp profile removed after the last case. The member's client and the page
// are in tests/team-board-perf-500.test.js.
//
// Eight live members: Alice (project admin), Bob, Carl, Dave, Erin, Fay and the owner (writers), Rae (reader). The 500-card
// board is the fixture of tests/helpers/board-fixture-500.js written through team.board.create and six team.board.apply.

const assert = require('node:assert/strict');
const test = require('node:test');
const { performance } = require('node:perf_hooks');

const { BATCH_MAX_BYTES } = require('../../server/team/boards/board-commands');
const { memberAuthor } = require('../../services/backend/message-author');
const { readBoardReply } = require('../../services/boards/board-proposal-turn');
const { buildBoardContextBlock } = require('../../services/boards/board-turn-context');
const fixture = require('../helpers/board-fixture-500');
const { dataFrames } = require('./helpers/session-scope-fixture');
const { must } = require('./helpers/team-board-kit');
const { createTeamProjectFixture } = require('./helpers/team-project-fixture');
const { randomKey } = require('./helpers/team-host-fixture');

const { seedBatches, cardId } = fixture;

// Milliseconds: ten times the best measured, rounded up, never under 50.
const CEILING = {
  'apply one card.place': 130,
  'apply 200 card.place': 140,
  'apply largest batch': 220,
  'snapshot route 500 cards': 50,
  'sync catch-up over 100 one-op batches': 50,
  'sync catch-up over 200 one-op batches (the journal keeps 200)': 50,
  'sync 1,000 behind (journal keeps 200): take a snapshot': 50,
  'list 20 live boards': 50,
  'trash 480 deleted boards': 50,
  'apply one card.place, eight members connected': 110,
  'apply a change over 16 KiB, eight members told to sync': 140,
  'presence eight members view the board': 170,
  'presence 1,000 pointer updates from one member': 170,
  'presence a note lock taken and released 100 times': 2060,
  'presence view and leave 100 times': 2050,
  'turn board section 500 cards': 50,
  'proposal store 40 additions': 140,
  'proposal accept additions': 260,
  'proposal accept one edit': 250,
  'sweep 480 deleted boards, none old enough': 50,
  'board create (small project)': 73,
  'board delete (small project)': 65,
  'board restore (small project)': 65,
  'board create (project with 500 boards in its index)': 75,
  'board delete (project with 500 boards in its index)': 69,
  'board restore (project with 500 boards in its index)': 76,
  'sweep every deleted board old enough, one run': 5060,
};
const ceilingOf = (name) => {
  assert.ok(Object.hasOwn(CEILING, name), `no ceiling for ${name}`);
  return CEILING[name];
};

const EIGHT = ['alice', 'bob', 'carl', 'dave', 'erin', 'fay', 'owner', 'rae'];
const UNLIMITED = { limit: 1_000_000_000 };
const DAY = 24 * 60 * 60 * 1000;
const TRASH_BOARDS = 480;
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const tick = () => new Promise((resolve) => { setImmediate(resolve); });

async function bestOfAsync(run, prepare) {
  if (prepare) await prepare();
  await run();
  let best = Infinity;
  for (let i = 0; i < 5; i += 1) {
    if (prepare) await prepare();
    const from = performance.now();
    await run();
    best = Math.min(best, performance.now() - from);
  }
  return best;
}
function report(t, name, value) {
  t.diagnostic(`perf ${name} ${value.toFixed(1)}`);
  const ceiling = ceilingOf(name);
  assert.ok(value <= ceiling, `${name} took ${value.toFixed(1)} ms, ceiling ${ceiling} ms`);
}

// One host for the whole file, built by the first case; the fixture's after-hooks run once the last case is done.
const cleanups = [];
let built = null;
test.after(async () => { for (const off of cleanups.reverse()) await off(); });
const world = () => { built ??= build(); return built; };

async function build() {
  const clock = { now: Date.now() };
  const limits = Object.fromEntries(['apply', 'change', 'read', 'sync', 'decide', 'presence', 'cursor'].map((name) => [name, UNLIMITED]));
  const h = await createTeamProjectFixture({ after: (off) => cleanups.push(off) }, { boards: true, clock: () => clock.now,
    boardLimits: { commands: limits, route: { ...UNLIMITED, windowMs: 60_000, maxKeys: 64 } } });
  const id = (who) => h.seats[who].member_id;
  // Eight live members: the fixture's pending member goes, three full members come.
  await h.ok(h.send('owner', 'team.member.revoke', { member_id: id('pia') }), 'revoke pia');
  for (const name of ['dave', 'erin', 'fay']) {
    const invite = await h.store.createInvite({ kind: 'new_member', actorMemberId: id('owner'), role: 'member', invitePublicKey: randomKey() });
    assert.equal(invite.ok, true);
    const seat = await h.store.redeem({ inviteId: invite.invite_id, devicePublicKey: randomKey(), displayName: name, label: 'Laptop' });
    assert.equal(seat.ok, true);
    assert.equal((await h.store.admit({ actorMemberId: id('owner'), memberId: seat.member_id })).ok, true);
    h.seats[name] = seat;
  }
  const projectWith = async (name) => {
    const projectId = (await h.ok(h.send('alice', 'team.project.create', { name }), `create ${name}`)).project_id;
    for (const [who, role] of [['bob', 'writer'], ['carl', 'writer'], ['dave', 'writer'], ['erin', 'writer'], ['fay', 'writer'], ['rae', 'reader']]) {
      await h.ok(h.send('alice', 'team.project.members.add', { project_id: projectId, member_id: id(who), role }), `add ${who}`);
    }
    await h.ok(h.send('owner', 'team.project.join', { project_id: projectId, role: 'writer' }), 'owner joins');
    return projectId;
  };
  const project = await projectWith('Atlas');
  const apply = (who, boardId, batch, projectId = project) => h.send(who, 'team.board.apply', { project_id: projectId, board_id: boardId, batch });
  // A board seeded through the commands with the fixture's cards, groups and connectors. The host lets a chat card point only
  // at a conversation of the project, so the fixture's invented session ids become four real conversations of it.
  const chats = Array.from({ length: 4 }, () => conversationIn(h, project));
  let chatCards = 0;
  const real = (ops) => ops.map((op) => (op.op === 'card.add' && op.card.kind === 'chat'
    ? { ...op, card: { ...op.card, data: { ...op.card.data, session_id: chats[chatCards++ % chats.length] } } } : op));
  const seeded = async (name, options) => {
    const boardId = (await h.ok(h.send('alice', 'team.board.create', { project_id: project, name }), 'create')).board.id;
    const batches = seedBatches(options);
    for (const [i, ops] of batches.entries()) {
      const batch = { batch_id: `seed-${boardId}-${i}`, ops: real(ops) };
      assert.ok(bytesOf(batch) <= BATCH_MAX_BYTES, `seed batch ${i} is ${bytesOf(batch)} bytes`);
      await h.ok(apply('alice', boardId, batch), `seed ${i}`);
    }
    return { boardId, applies: batches.length };
  };
  const main = await seeded('Five hundred');
  const room = await seeded('Room to add', { cards: 250, groups: 10, connectors: 300 });
  const read = async (boardId, projectId = project) => (await must(h.state.boards.get({ projectId, boardId }))).board;
  assert.equal(Object.keys((await read(main.boardId)).cards).length, 500);
  assert.equal(Object.keys((await read(room.boardId)).cards).length, 250);
  const streams = {};
  const attachAll = () => { for (const who of EIGHT) streams[who] ??= h.attach(who); };
  const noteIds = Object.values((await read(main.boardId)).cards).filter((card) => card.kind === 'note').map((card) => card.id);
  return { h, id, clock, project, projectWith, apply, read, main, room, streams, attachAll, noteIds, counter: 0 };
}

// A conversation of the project, as the host's session store holds it.
function conversationIn(h, projectId) {
  const sessions = h.backend.sessionStore;
  const made = sessions.createSession({ title: 'Perf' });
  assert.ok(sessions.updateSession(made.id, { project_id: projectId }));
  return made.id;
}

const frameCounts = (w) => Object.fromEntries(EIGHT.map((who) => [who, w.streams[who].frames.length]));
async function untilAll(w, before) {
  for (let tries = 0; tries < 5000 && !EIGHT.every((who) => w.streams[who].frames.length > before[who]); tries += 1) await tick();
  assert.ok(EIGHT.every((who) => w.streams[who].frames.length > before[who]), 'not every member got the event');
}
const lastFrame = (w, who) => dataFrames(w.streams[who].frames.slice(-1)).at(-1);

const placeOps = (w, count, base = 0) => Array.from({ length: count }, (_, i) => ({ op: 'card.place', id: cardId(1 + ((base + i) % 500)), x: 50 + (w.counter % 9000), y: 20 + i }));
// Edits of the given notes to `body`, each with the content_rev the host holds now.
async function editOps(w, noteIds, body) {
  const { cards } = await w.read(w.main.boardId);
  return noteIds.map((noteId) => ({ op: 'card.edit', id: noteId, content_rev: cards[noteId].content_rev, data: { text: body } }));
}
const batchOf = (w, ops) => ({ batch_id: `perf-${++w.counter}`, ops });

test('apply: one card.place (a drag end) and a batch of 200', async (t) => {
  const w = await world();
  const { h } = w;
  let params = null;
  let rev = (await w.read(w.main.boardId)).rev;
  const check = (answer, ops) => {
    assert.equal(answer.ok, true, JSON.stringify(answer).slice(0, 300));
    assert.equal(answer.duplicate, false);
    assert.ok(answer.applied.ops.length >= ops, `applied ${answer.applied.ops.length}`);
    assert.equal(answer.rev, rev + 1);
    rev = answer.rev;
  };
  report(t, 'apply one card.place', await bestOfAsync(async () => check(await h.send('carl', 'team.board.apply', params), 1),
    () => { params = { project_id: w.project, board_id: w.main.boardId, batch: batchOf(w, placeOps(w, 1, w.counter)) }; }));
  report(t, 'apply 200 card.place', await bestOfAsync(async () => check(await h.send('carl', 'team.board.apply', params), 200),
    () => { params = { project_id: w.project, board_id: w.main.boardId, batch: batchOf(w, placeOps(w, 200)) }; }));
  const board = await w.read(w.main.boardId);
  assert.equal(board.cards[cardId(1)].x, 50 + ((w.counter - 1) % 9000));
});

test('apply: the largest batch the host accepts, note texts edited', async (t) => {
  const w = await world();
  const text = (n) => `${n} ${'lorem ipsum dolor '.repeat(300)}`.slice(0, 4000);
  // Edits of 4,000-character notes until the next one would pass the limit; the body differs on every run.
  const biggest = async () => {
    const batch = batchOf(w, []);
    for (const op of await editOps(w, w.noteIds, text(w.counter))) {
      if (bytesOf({ ...batch, ops: [...batch.ops, op] }) > BATCH_MAX_BYTES) break;
      batch.ops.push(op);
    }
    return batch;
  };
  let params = null;
  report(t, 'apply largest batch', await bestOfAsync(async () => {
    const answer = await w.h.send('dave', 'team.board.apply', params);
    assert.equal(answer.ok, true, JSON.stringify(answer).slice(0, 300));
    assert.equal(answer.applied.ops.length, params.batch.ops.length);
  }, async () => { params = { project_id: w.project, board_id: w.main.boardId, batch: await biggest() }; }));
  const size = bytesOf(params.batch);
  t.diagnostic(`size apply batch ${params.batch.ops.length} ops ${size} bytes of ${BATCH_MAX_BYTES}`);
  assert.ok(size <= BATCH_MAX_BYTES && size > BATCH_MAX_BYTES - 8192, `${size} bytes`);
});

test('snapshot route: the 500-card board a member downloads on open', async (t) => {
  const w = await world();
  let bytes = 0;
  report(t, 'snapshot route 500 cards', await bestOfAsync(async () => {
    const got = await w.h.boardRoute('rae', w.project, w.main.boardId);
    assert.deepEqual([got.status, got.json.ok, Object.keys(got.json.board.cards).length], [200, true, 500]);
    bytes = got.bytes.length;
  }));
  t.diagnostic(`size snapshot ${bytes}`);
});

test('sync: a catch-up over the journal, and a caller further behind than the journal keeps', async (t) => {
  const w = await world();
  const { h } = w;
  const sync = (afterRev) => h.send('rae', 'team.board.sync', { project_id: w.project, board_id: w.main.boardId, after_rev: afterRev });
  const behind = async (count) => {
    for (let i = 0; i < count; i += 1) await h.ok(w.apply('carl', w.main.boardId, batchOf(w, placeOps(w, 1, w.counter))));
    return (await w.read(w.main.boardId)).rev;
  };
  let head = await behind(100);
  report(t, 'sync catch-up over 100 one-op batches', await bestOfAsync(async () => {
    const answer = await sync(head - 100);
    assert.deepEqual([answer.ok, answer.batches.length, answer.more, answer.batches[0].rev, answer.batches.at(-1).rev], [true, 100, false, head - 99, head]);
  }));
  head = await behind(100);
  report(t, 'sync catch-up over 200 one-op batches (the journal keeps 200)', await bestOfAsync(async () => {
    const answer = await sync(head - 200);
    assert.deepEqual([answer.ok, answer.batches.length, answer.more, answer.batches.at(-1).rev], [true, 200, false, head]);
  }));
  // 1,000 behind is more than the journal's 200 batches (board-model LIMITS.journal_batches): the answer is "take a snapshot".
  report(t, 'sync 1,000 behind (journal keeps 200): take a snapshot', await bestOfAsync(async () => {
    const answer = await sync(head - 201);
    assert.deepEqual([answer.ok, answer.snapshot, answer.rev], [true, true, head]);
  }));
});

// A project with 20 live boards and TRASH_BOARDS deleted ones (the index at about 500 of its 511 entries).
async function crowded(w) {
  if (!w.crowd) {
    w.crowd = (async () => {
      const projectId = await w.projectWith('Quarry');
      const store = w.h.state.boards;
      const from = performance.now();
      for (let i = 0; i < 19 + TRASH_BOARDS; i += 1) {
        const made = await must(store.create({ projectId, actor: w.id('alice'), name: `Board ${i}` }));
        if (i >= 19) await must(store.remove({ projectId, boardId: made.board.id, actor: w.id('alice') }));
      }
      w.seedMs = performance.now() - from;
      return projectId;
    })();
  }
  return w.crowd;
}

test('list and trash: a project with 20 live boards and a full trash', async (t) => {
  const w = await world();
  const projectId = await crowded(w);
  t.diagnostic(`seed ${19 + TRASH_BOARDS} boards, ${TRASH_BOARDS} of them deleted, took ${w.seedMs.toFixed(0)} ms`);
  await w.h.ok(w.h.send('alice', 'team.board.create', { project_id: projectId, name: 'The twentieth' }));
  report(t, 'list 20 live boards', await bestOfAsync(async () => {
    const answer = await w.h.ok(w.h.send('carl', 'team.board.list', { project_id: projectId }));
    assert.equal(answer.boards.length, 20);
  }));
  report(t, `trash ${TRASH_BOARDS} deleted boards`, await bestOfAsync(async () => {
    const answer = await w.h.ok(w.h.send('alice', 'team.board.trash', { project_id: projectId }));
    assert.equal(answer.boards.length, TRASH_BOARDS);
  }));
});

test('events: one change reaches eight members; a change too large to travel inline sends the rev alone', async (t) => {
  const w = await world();
  w.attachAll();
  const timed = async (name, makeBatch, inline) => {
    let sent = null;
    let before = null;
    report(t, name, await bestOfAsync(async () => {
      const answer = await w.h.send('carl', 'team.board.apply', sent);
      assert.equal(answer.ok, true, JSON.stringify(answer).slice(0, 200));
      await untilAll(w, before);
    }, async () => { sent = { project_id: w.project, board_id: w.main.boardId, batch: await makeBatch() }; before = frameCounts(w); }));
    for (const who of EIGHT) {
      const frame = lastFrame(w, who);
      assert.deepEqual([frame.event_type, frame.board_id, 'batch' in frame], ['team_board_changed', w.main.boardId, inline], `${who} ${name}`);
    }
  };
  await timed('apply one card.place, eight members connected', () => batchOf(w, placeOps(w, 1, w.counter)), true);
  const big = async () => batchOf(w, await editOps(w, w.noteIds.slice(0, 6), `${w.counter} ${'x'.repeat(3900)}`));
  assert.ok(bytesOf(await big()) > 16 * 1024);
  await timed('apply a change over 16 KiB, eight members told to sync', big, false);
});

test('presence: eight viewers, a burst of pointers, note locks, view and leave', async (t) => {
  const w = await world();
  w.attachAll();
  const { h } = w;
  const at = { project_id: w.project, board_id: w.main.boardId };
  const note = w.noteIds[3];
  const viewAll = async () => { for (const who of EIGHT) await h.ok(h.send(who, 'team.board.view', at), `${who} views`); };
  const leaveAll = async () => { for (const who of EIGHT) await h.ok(h.send(who, 'team.board.leave', at), `${who} leaves`); };
  report(t, 'presence eight members view the board', await bestOfAsync(async () => {
    await viewAll();
    assert.equal(w.h.state.boardHost.presence.viewersOf(w.main.boardId).length, 8);
  }, leaveAll));
  const pointers = async () => {
    for (let i = 0; i < 1000; i += 1) await h.ok(h.send('carl', 'team.board.cursor', { ...at, x: i % 900, y: (i * 7) % 600, selected: [note] }));
  };
  const from = w.streams.alice.frames.length;
  report(t, 'presence 1,000 pointer updates from one member', await bestOfAsync(pointers));
  const seen = dataFrames(w.streams.alice.frames.slice(from)).filter((frame) => frame.event_type === 'team_board_cursor');
  assert.equal(seen.length, 6000);
  assert.deepEqual([seen.at(-1).member_id, seen.at(-1).x, seen.at(-1).selected], [w.id('carl'), 999 % 900, [note]]);
  report(t, 'presence a note lock taken and released 100 times', await bestOfAsync(async () => {
    for (let i = 0; i < 100; i += 1) {
      await h.ok(h.send('carl', 'team.board.lock', { ...at, card_id: note }), 'lock');
      assert.equal(w.h.state.boardHost.presence.lockHolder(w.main.boardId, note), w.id('carl'));
      await h.ok(h.send('carl', 'team.board.unlock', { ...at, card_id: note }), 'unlock');
    }
    assert.equal(w.h.state.boardHost.presence.lockHolder(w.main.boardId, note), null);
  }));
  report(t, 'presence view and leave 100 times', await bestOfAsync(async () => {
    for (let i = 0; i < 100; i += 1) {
      await h.ok(h.send('erin', 'team.board.view', at), 'view');
      await h.ok(h.send('erin', 'team.board.leave', at), 'leave');
    }
    assert.equal(w.h.state.boardHost.presence.viewersOf(w.main.boardId).includes(w.id('erin')), false);
  }));
  await leaveAll();
});

// A conversation in the project, a turn stamped with `boardId` sent by Carl, and the board section the host builds for it.
let turns = 0;
function turn(w, boardId, sessionId) {
  const sessions = w.h.backend.sessionStore;
  const n = ++turns;
  const streamId = `stream_perf_${n}`;
  assert.ok(sessions.appendMessage(sessionId, { id: `user_${n}`, role: 'user', content: 'Plan this', board_id: boardId, author: memberAuthor(w.id('carl')) }));
  return { n, streamId, section: () => buildBoardContextBlock(w.h.backend, { boardId, sessionId, streamId }),
    reply: (...lines) => {
      assert.ok(sessions.appendMessage(sessionId, { id: `reply_${n}`, role: 'assistant', content: ['Here is my proposal.', '```board', ...lines, '```', ''].join('\n') }));
      return readBoardReply(w.h.backend, { sessionId, streamId });
    },
    proposalId: `${sessionId}:reply_${n}:1` };
}
const conversation = (w) => conversationIn(w.h, w.project);

test('turn: the board section the host builds for the 500-card board', async (t) => {
  const w = await world();
  const sessionId = conversation(w);
  let current = null;
  let block = null;
  report(t, 'turn board section 500 cards', await bestOfAsync(async () => {
    block = await current.section();
    assert.ok(block && block.kind === 'board' && block.sentWhole.length > 0);
  }, () => { current = turn(w, w.main.boardId, sessionId); }));
  t.diagnostic(`size turn board section ${block.content.length} chars, ${block.sentWhole.length} whole, ${block.omitted.length} omitted`);
});

test('proposals: 40 additions stored, accepted; one edit accepted; every decision audited', async (t) => {
  const w = await world();
  const { h } = w;
  const sessionId = conversation(w);
  const at = { project_id: w.project, board_id: w.room.boardId };
  await h.ok(h.send('carl', 'team.board.view', at), 'carl views');
  const audited = () => h.approvals.audit().read({ projectId: w.project }).entries.filter((entry) => entry.board_id === w.room.boardId);
  const additions = Array.from({ length: 40 }, (_, i) => `note Idea ${i + 1} from Jenny`);
  let current = null;
  let proposal = null;
  const stored = async () => { proposal = await current.reply(...additions); assert.equal(proposal.counts.additions, 40); };
  const prepare = async () => { current = turn(w, w.room.boardId, sessionId); assert.ok(await current.section()); };
  report(t, 'proposal store 40 additions', await bestOfAsync(stored, prepare));
  // The answers are read after the timed runs: what was written (cards, audit entries) is checked once all six have run.
  const cards = () => w.read(w.room.boardId).then((board) => Object.keys(board.cards).length);
  const accepted = [];
  const decide = async (extra) => {
    accepted.push(await h.ok(h.send('carl', 'team.board.proposal.accept', { ...at, proposal_id: current.proposalId, ...extra }), 'accept'));
  };
  const entries = audited().length;
  const size = await cards();
  report(t, 'proposal accept additions', await bestOfAsync(() => decide({}), async () => { await prepare(); await stored(); }));
  assert.deepEqual(accepted.map((answer) => [answer.applied, answer.skipped]), Array(6).fill([40, 0]));
  assert.equal(await cards(), size + 6 * 40);
  assert.deepEqual(audited().slice(entries).map((entry) => [entry.kind, entry.actor_member_id, entry.prompter_member_id, entry.detail]),
    Array(6).fill(['board_proposal_accepted', w.id('carl'), w.id('carl'), { change: 0, count: 40 }]), 'one audit entry for each decision');
  accepted.length = 0;
  report(t, 'proposal accept one edit', await bestOfAsync(() => decide({ n: 1 }), async () => {
    current = turn(w, w.room.boardId, sessionId);
    const alias = (await current.section()).sentWhole.find((name) => /^n\d+$/u.test(name));
    assert.ok(alias, 'a note sent whole');
    assert.equal((await current.reply(`edit ${alias} Edited by Jenny ${current.n}`)).counts.edits, 1);
  }));
  assert.deepEqual(accepted.map((answer) => answer.applied), Array(6).fill(1));
  assert.deepEqual(audited().slice(entries + 6).map((entry) => [entry.kind, entry.actor_member_id, entry.detail]),
    Array(6).fill(['board_proposal_accepted', w.id('carl'), { change: 1, count: 1 }]), 'one audit entry for each decision');
});

test('sweep: nothing old enough to remove; then every deleted board old enough; create, delete and restore', async (t) => {
  const w = await world();
  const { h } = w;
  const crowd = await crowded(w);
  report(t, `sweep ${TRASH_BOARDS} deleted boards, none old enough`, await bestOfAsync(async () => {
    const swept = await must(h.state.boards.sweep());
    assert.deepEqual([swept.removed, swept.failed], [0, 0]);
  }));
  // Three index writes on an empty board: in the small project, and in the one whose index holds about 500 entries.
  const small = w.project;
  const cycle = async (projectId, name) => {
    const best = { create: Infinity, delete: Infinity, restore: Infinity };
    for (let i = 0; i < 6; i += 1) {
      const stage = async (key, who, operation, params) => {
        const from = performance.now();
        const answer = await h.ok(h.send(who, operation, { project_id: projectId, ...params }), `${key}`);
        if (i > 0) best[key] = Math.min(best[key], performance.now() - from);
        return answer;
      };
      const made = (await stage('create', 'carl', 'team.board.create', { name: `Cycle ${i}` })).board.id;
      await stage('delete', 'alice', 'team.board.delete', { board_id: made });
      const back = await stage('restore', 'alice', 'team.board.restore', { board_id: made });
      assert.equal(back.board.id, made);
      await h.ok(h.send('alice', 'team.board.delete', { project_id: projectId, board_id: made }));
    }
    for (const [key, value] of Object.entries(best)) report(t, `board ${key} (${name})`, value);
  };
  await cycle(small, 'small project');
  // The crowded project holds its 20 live boards: one goes to the trash so a create has room.
  const live = (await h.ok(h.send('alice', 'team.board.list', { project_id: crowd }))).boards;
  await h.ok(h.send('alice', 'team.board.delete', { project_id: crowd, board_id: live[0].id }));
  await cycle(crowd, 'project with 500 boards in its index');
  // The clock moves past seven days: every deleted board of the project is old enough (one run: it removes them).
  w.clock.now += 8 * DAY;
  const from = performance.now();
  const swept = await must(h.state.boards.sweep());
  const took = performance.now() - from;
  assert.ok(swept.removed >= TRASH_BOARDS, `removed ${swept.removed}`);
  assert.equal(swept.failed, 0);
  assert.equal((await must(h.state.boards.listDeleted({ projectId: crowd }))).boards.length, 0);
  t.diagnostic(`swept ${swept.removed} deleted boards`);
  report(t, 'sweep every deleted board old enough, one run', took);
});
