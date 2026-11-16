'use strict';

// new-test-file: row 151 slice T3 adds what the host announces about a board (server/team/boards/board-events.js)
// and the team.board.sync command, a new surface; the commands test (team-board-commands.test.js) is near its cap.
//
// Through the real router, authorizer, member store, board store and event stream: who is told of a batch and of a
// list change and with what, the 16 KiB rule and the project's inline allowance, the order of announcements, a
// flood that must leave other buckets' events in the replay buffer, and team.board.sync (roles, forged ids, a gap,
// pages, "take a snapshot", its own limit, and a member removed while a read waits).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { SYNC_PAGE_BYTES } = require('../../server/team/boards/board-commands');
const { BOARD_EVENT_LIMITS, createBoardEvents } = require('../../server/team/boards/board-events');
const { dataFrames } = require('./helpers/session-scope-fixture');
const { batch, must, note, tree } = require('./helpers/team-board-kit');
const { createTeamProjectFixture } = require('./helpers/team-project-fixture');

const CHANGED = 'team_board_changed';
const LIST = 'team_board_list_changed';
const UNKNOWN_BOARD = 'board_00000000-0000-4000-8000-00000000dead';
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

// Project X: Alice admin, Carl writer, Rae (a read-only team member) reader. Project Y: Bob admin. One live board
// each, and X has one in the trash.
async function setup(t, options = {}) {
  const h = await createTeamProjectFixture(t, { boards: true, ...options });
  const id = (who) => h.seats[who].member_id;
  const x = await h.sharedProject('Apollo');
  const y = (await h.ok(h.send('bob', 'team.project.create', { name: 'Zephyr' }), 'create y')).project_id;
  const boards = h.state.boards;
  const live = (await must(boards.create({ projectId: x, actor: id('alice'), name: 'Roadmap' }))).board.id;
  const gone = (await must(boards.create({ projectId: x, actor: id('alice'), name: 'Old plan' }))).board.id;
  await must(boards.remove({ projectId: x, boardId: gone, actor: id('alice') }));
  const other = (await must(boards.create({ projectId: y, actor: id('bob'), name: 'Theirs' }))).board.id;
  const apply = (who, ops, boardId = live) => h.send(who, 'team.board.apply', { project_id: x, board_id: boardId,
    batch: Array.isArray(ops) ? batch(...ops) : ops });
  const sync = (who, afterRev, boardId = live, projectId = x) => h.send(who, 'team.board.sync',
    { project_id: projectId, board_id: boardId, after_rev: afterRev });
  return { h, id, x, y, live, gone, other, boards, apply, sync,
    root: path.join(fs.realpathSync.native(h.config.userDataPath), 'team-boards') };
}

// A stream's board events, as { type, project_id, board_id?, rev?, batch? }.
const boardFrames = (response) => dataFrames(response.frames).filter((frame) => frame.event_type.startsWith('team_board_'))
  .map(({ event_type: type, api_version: _v, boot_epoch: _b, cursor: _c, ...rest }) => ({ type, ...rest }));
const big = (count = 5) => Array.from({ length: count }, (_, index) => note('n'.repeat(4000), index));

// The store with each call listed in `seen`, and `hold[name]` (a promise) awaited after that call came back.
function held(seen, hold) {
  return (store) => Object.fromEntries(Object.keys(store).map((name) => [name, async (input) => {
    seen.push(name);
    const answer = await store[name](input);
    if (hold[name]) await hold[name];
    return answer;
  }]));
}
async function until(condition, what) {
  for (let tries = 0; tries < 5000; tries += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('T3: a batch is announced to the project\'s members with the item sync serves; a batch over 16 KiB sends its rev alone', async (t) => {
  const s = await setup(t);
  const streams = Object.fromEntries(['alice', 'carl', 'rae', 'bob', 'owner'].map((who) => [who, s.h.attach(who)]));
  const small = batch(note('small'));
  const first = await s.h.ok(s.apply('carl', small), 'small');
  const served = (await s.h.ok(s.sync('rae', first.rev - 1), 'sync')).batches;
  assert.deepEqual(served.map((item) => Object.keys(item)), [['rev', 'batch_id', 'actor', 'at', 'applied']]);
  assert.deepEqual([served[0].rev, served[0].batch_id, served[0].actor], [first.rev, small.batch_id, s.id('carl')]);
  assert.deepEqual(served[0].applied, first.applied);
  const expected = [{ type: CHANGED, project_id: s.x, board_id: s.live, rev: first.rev, batch: served[0] }];
  for (const who of ['alice', 'carl', 'rae']) assert.deepEqual(boardFrames(streams[who]), expected, who);
  // A member outside the project and the owner without a row are told nothing.
  for (const who of ['bob', 'owner']) assert.deepEqual(boardFrames(streams[who]), [], who);

  // Over 16 KiB: the rev alone; the batch is read with sync.
  const second = await s.h.ok(s.apply('alice', big()), 'big');
  assert.ok(bytesOf(second.applied) > BOARD_EVENT_LIMITS.inlineBytes);
  assert.deepEqual(boardFrames(streams.rae)[1], { type: CHANGED, project_id: s.x, board_id: s.live, rev: second.rev });
  assert.deepEqual((await s.h.ok(s.sync('rae', first.rev))).batches.map((item) => item.applied), [second.applied]);

  // A refused batch and a repeated one announce nothing.
  const before = boardFrames(streams.alice).length;
  const refusal = await s.apply('carl', [{ op: 'card.edit', id: 'no-such-card', data: { text: 'x' } }]);
  assert.equal(refusal.error.reason, 'team_board_refused');
  assert.equal((await s.h.ok(s.apply('carl', small))).duplicate, true);
  assert.equal(boardFrames(streams.alice).length, before);
  // Nothing an outsider received names the project's board.
  assert.equal(streams.bob.frames.join('').includes(s.live), false);
});

test('T3: a board created, renamed, deleted or restored tells the project\'s members to read the list again', async (t) => {
  const s = await setup(t);
  const streams = { alice: s.h.attach('alice'), rae: s.h.attach('rae'), bob: s.h.attach('bob') };
  const list = { type: LIST, project_id: s.x };
  const made = (await s.h.ok(s.h.send('carl', 'team.board.create', { project_id: s.x, name: 'Sprint' }))).board.id;
  assert.deepEqual(boardFrames(streams.rae), [list]);
  const renamed = await s.h.ok(s.h.send('carl', 'team.board.rename', { project_id: s.x, board_id: made, name: 'Sprint 2' }));
  const frames = boardFrames(streams.rae);
  // The rename is a batch on the board (its own rev) and a list change.
  assert.deepEqual(frames.slice(1).map((frame) => [frame.type, frame.rev]), [[CHANGED, renamed.rev], [LIST, undefined]]);
  assert.deepEqual(frames[1].batch.applied.ops.map((op) => op.op), ['board.rename']);
  await s.h.ok(s.h.send('alice', 'team.board.delete', { project_id: s.x, board_id: made }));
  await s.h.ok(s.h.send('alice', 'team.board.restore', { project_id: s.x, board_id: made }));
  assert.deepEqual(boardFrames(streams.rae).slice(3), [list, list]);
  assert.deepEqual(boardFrames(streams.alice), boardFrames(streams.rae));
  assert.deepEqual(boardFrames(streams.bob), []);
  // A list event names the project and nothing else: no board id, no name.
  for (const frame of boardFrames(streams.rae).filter((entry) => entry.type === LIST)) assert.deepEqual(frame, list);
});

test('T3 order: batches sent at once are announced in the host\'s rev order, the order sync serves', async (t) => {
  const s = await setup(t);
  const stream = s.h.attach('rae');
  const start = (await must(s.boards.get({ projectId: s.x, boardId: s.live }))).rev;
  const sent = [];
  for (let index = 0; index < 30; index += 1) sent.push(s.apply(index % 2 ? 'carl' : 'alice', [note(`n${index}`, index)]));
  const answers = await Promise.all(sent);
  assert.ok(answers.every((answer) => answer.ok === true));
  const frames = boardFrames(stream);
  assert.deepEqual(frames.map((frame) => frame.rev), Array.from({ length: 30 }, (_, index) => start + 1 + index));
  const served = (await s.h.ok(s.sync('rae', start))).batches;
  assert.deepEqual(frames.map((frame) => frame.batch), served);
  assert.deepEqual(new Set(answers.map((answer) => answer.rev)).size, 30);
});

test('T3: a member taken off the project is told nothing more, live or on replay; a member who reconnects gets the replay', async (t) => {
  const s = await setup(t);
  const cursor = s.h.core.events.cursor;
  const carl = s.h.attach('carl');
  const one = await s.h.ok(s.apply('alice', [note('before')]));
  assert.deepEqual(boardFrames(carl).map((frame) => frame.rev), [one.rev]);
  await s.h.ok(s.h.send('alice', 'team.project.members.remove', { project_id: s.x, member_id: s.id('carl') }));
  const two = await s.h.ok(s.apply('alice', [note('after')]));
  assert.deepEqual(boardFrames(carl).map((frame) => frame.rev), [one.rev]);
  // On a reconnect from before both: not even the batch from while Carl was a member.
  assert.deepEqual(boardFrames(s.h.attach('carl', { cursor })), []);
  assert.deepEqual(boardFrames(s.h.attach('rae', { cursor })).map((frame) => frame.rev), [one.rev, two.rev]);
  // A revoked member's stream identity fails the same check.
  await s.h.ok(s.h.send('owner', 'team.member.revoke', { member_id: s.id('rae') }));
  assert.deepEqual(boardFrames(s.h.attach('rae', { cursor })), []);
});

test('T3 flood: boards never fill the project\'s replay bucket, so other buckets\' events stay in the replay buffer', async (t) => {
  const s = await setup(t);
  const stream = s.h.core.events.events;
  const cursor = s.h.core.events.cursor;
  const floor = stream.floor;
  // An event in another bucket, published before the flood.
  s.h.core.events.publish('team_project_changed', { project_id: s.y, reason: 'renamed' }, { audience: new Set([s.id('alice')]) });
  const item = (rev, size) => ({ rev, batch_id: `flood-${rev}`, actor: s.id('carl'), at: new Date().toISOString(),
    applied: { batch_id: `flood-${rev}`, ops: [{ op: 'card.edit', id: 'c', data: { text: 'x'.repeat(size) } }] } });
  const announce = (rev, size) => s.h.state.boardEvents.onChange({ kind: 'applied', projectId: s.x, boardId: s.live,
    renamed: false, item: item(rev, size) });
  // 600 batches just under 16 KiB (9 MiB, far more than eight members may send in the window), then 100 large ones.
  for (let rev = 1; rev <= 600; rev += 1) announce(rev, 15_000);
  for (let rev = 601; rev <= 700; rev += 1) announce(rev, 200_000);
  const replay = dataFrames(s.h.attach('alice', { cursor }).frames);
  assert.equal(replay.some((frame) => frame.event_type === 'resync_required'), false);
  assert.deepEqual(replay.filter((frame) => frame.event_type === 'team_project_changed').map((frame) => frame.project_id), [s.y]);
  assert.equal(stream.floor, floor, 'the flood trimmed the replay buffer');
  const frames = replay.filter((frame) => frame.event_type === CHANGED);
  assert.deepEqual(frames.map((frame) => frame.rev), Array.from({ length: 700 }, (_, index) => index + 1));
  const inline = frames.filter((frame) => 'batch' in frame);
  assert.ok(inline.length >= 60 && inline.every((frame) => frame.rev <= 600), `inline ${inline.length}`);
  assert.ok(inline.reduce((sum, frame) => sum + bytesOf(frame.batch), 0) <= BOARD_EVENT_LIMITS.windowBytes);
  // The project's bucket holds the inline allowance and 700 small frames: well under the stream's 2 MiB a bucket.
  assert.ok(stream.streamSizes.get(`project:${s.x}`) < 1.5 * 1024 * 1024, String(stream.streamSizes.get(`project:${s.x}`)));
  assert.deepEqual(s.h.state.boardEvents.resources(), { projects: 1, entries: inline.length });
});

test('T3: the 16 KiB boundary, the allowance and its window, and a publisher or clock that fails', async (t) => {
  const s = await setup(t);
  const sent = [];
  let now = 1_000_000;
  let broken = null;
  const events = (limits = {}) => createBoardEvents({ directory: s.h.store.directory, clock: () => { if (broken === 'clock') throw new Error('x'); return now; },
    limits, publish: (type, payload, options) => { if (broken === 'publish') throw new Error('x'); sent.push({ type, payload, options }); } });
  const sized = (bytes) => {
    const item = { rev: 1, batch_id: 'b', actor: s.id('alice'), at: '2026-11-15T00:00:00.000Z', applied: { ops: [{ text: '' }] } };
    item.applied.ops[0].text = 'x'.repeat(bytes - bytesOf(item));
    assert.equal(bytesOf(item), bytes);
    return item;
  };
  const tell = (target, item, projectId = s.x) => target.onChange({ kind: 'applied', projectId, boardId: s.live, renamed: false, item });
  const plain = events();
  tell(plain, sized(BOARD_EVENT_LIMITS.inlineBytes));
  tell(plain, sized(BOARD_EVENT_LIMITS.inlineBytes + 1));
  assert.deepEqual(sent.map((entry) => 'batch' in entry.payload), [true, false]);
  // The audience is the project's members now, under the project's bucket.
  assert.deepEqual([...sent[0].options.audience].sort(), [s.id('alice'), s.id('carl'), s.id('rae')].sort());
  assert.deepEqual([sent[0].type, sent[0].options.bucket, Object.keys(sent[0].options).sort()],
    [CHANGED, `project:${s.x}`, ['audience', 'bucket']]);

  // The allowance: 2500 bytes in a 1000 ms window; a project's count is its own.
  sent.length = 0;
  const tight = events({ inlineBytes: 1000, windowBytes: 2500, windowMs: 1000 });
  for (let index = 0; index < 3; index += 1) tell(tight, sized(1000));
  tell(tight, sized(1000), s.y);
  assert.deepEqual(sent.map((entry) => 'batch' in entry.payload), [true, true, false, true]);
  now += 1000;
  tell(tight, sized(1000));
  assert.equal('batch' in sent.at(-1).payload, true);
  assert.deepEqual(tight.resources(), { projects: 1, entries: 1 });

  // A clock that throws sends the rev alone; a publisher that throws never reaches the caller.
  broken = 'clock';
  tell(tight, sized(400));
  assert.equal('batch' in sent.at(-1).payload, false);
  broken = 'publish';
  assert.doesNotThrow(() => tell(tight, sized(400)));
  broken = null;
  // A project with no team row is the owner's alone (project-visibility.js projectAccess), as for every project event.
  tell(plain, sized(400), 'project_nobody');
  assert.deepEqual([...sent.at(-1).options.audience], [s.id('owner')]);
  // A directory that names nobody, a malformed change and an unknown kind publish nothing.
  const count = sent.length;
  tell(createBoardEvents({ directory: {}, publish: (...args) => sent.push(args) }), sized(400));
  plain.onChange(null);
  plain.onChange({ kind: 'applied', projectId: s.x, boardId: s.live, item: { rev: 'x' } });
  plain.onChange({ kind: 'other', projectId: s.x });
  assert.equal(sent.length, count);
  plain.onChange({ kind: 'list', projectId: s.x });
  assert.deepEqual([sent.at(-1).type, sent.at(-1).payload], [LIST, { project_id: s.x }]);
  // Limits only go down; a publisher is required.
  assert.throws(() => events({ inlineBytes: BOARD_EVENT_LIMITS.inlineBytes + 1 }), RangeError);
  assert.throws(() => events({ planted: 1 }), RangeError);
  assert.throws(() => createBoardEvents({ directory: s.h.store.directory }), TypeError);
});

test('T3 sync: by project role; a board is reached only through its own project; the schema is closed', async (t) => {
  const s = await setup(t);
  const first = await s.h.ok(s.apply('carl', [note('one')]));
  for (const who of ['alice', 'carl', 'rae']) {
    const answer = await s.h.ok(s.sync(who, first.rev - 1), who);
    assert.deepEqual([answer.rev, answer.batches.length, answer.more], [first.rev, 1, false], who);
  }
  const before = tree(s.root);
  const refusals = [
    ['a member outside the project', () => s.sync('bob', 0), 'team_not_found'],
    ['the owner without a row', () => s.sync('owner', 0), 'team_not_found'],
    ['a pending member', () => s.sync('pia', 0), 'member_pending'],
    ['another project\'s board under this project', () => s.sync('alice', 0, s.other), 'team_board_not_found'],
    ['this project\'s board under another project', () => s.sync('bob', 0, s.live, s.y), 'team_board_not_found'],
    ['a board in the trash', () => s.sync('alice', 0, s.gone), 'team_board_not_found'],
    ['an unknown board', () => s.sync('alice', 0, UNKNOWN_BOARD), 'team_board_not_found'],
    ['a malformed board id', () => s.sync('alice', 0, 'board_1'), 'invalid_command_parameters'],
    ['a negative rev', () => s.sync('alice', -1), 'invalid_command_parameters'],
    ['a fractional rev', () => s.sync('alice', 1.5), 'invalid_command_parameters'],
    ['a rev as text', () => s.sync('alice', '1'), 'invalid_command_parameters'],
    ['no rev', () => s.h.send('alice', 'team.board.sync', { project_id: s.x, board_id: s.live }), 'invalid_command_parameters'],
    ['a member id', () => s.h.send('alice', 'team.board.sync', { project_id: s.x, board_id: s.live, after_rev: 0,
      member_id: s.id('carl') }), 'invalid_command_parameters'],
    ['a page size', () => s.h.send('alice', 'team.board.sync', { project_id: s.x, board_id: s.live, after_rev: 0,
      max_bytes: 1 }), 'invalid_command_parameters'],
  ];
  for (const [label, call, reason] of refusals) {
    const answer = await call();
    assert.deepEqual([answer.ok, answer.error?.reason], [false, reason], label);
    assert.equal('batches' in answer || 'rev' in answer, false, label);
  }
  await s.h.ok(s.h.send('owner', 'team.member.revoke', { member_id: s.id('rae') }));
  assert.equal(await s.h.reason(s.sync('rae', 0)), 'member_revoked');
  assert.deepEqual(tree(s.root), before, 'a sync changed the disk');
});

test('T3 sync: a gap is filled in order, pages stay under 512 KiB, and an old or future rev says take a snapshot', async (t) => {
  const s = await setup(t);
  const start = (await must(s.boards.get({ projectId: s.x, boardId: s.live }))).rev;
  // Nothing after the head: an empty page, not a snapshot.
  assert.deepEqual(await s.h.ok(s.sync('rae', start)), { ok: true, rev: start, batches: [], more: false });
  assert.deepEqual(await s.h.ok(s.sync('rae', start + 1)), { ok: true, rev: start, snapshot: true });
  // Four batches of about 200 KiB: two pages.
  const applied = [];
  for (let index = 0; index < 4; index += 1) applied.push(await must(s.boards.apply({ projectId: s.x, boardId: s.live,
    actor: s.id('alice'), batch: batch(...big(50)) })));
  const pageOne = await s.h.ok(s.sync('rae', start));
  assert.deepEqual([pageOne.rev, pageOne.more, pageOne.batches.map((item) => item.rev)], [start + 4, true, [start + 1, start + 2]]);
  assert.ok(bytesOf(pageOne.batches) <= SYNC_PAGE_BYTES);
  const pageTwo = await s.h.ok(s.sync('rae', pageOne.batches.at(-1).rev));
  assert.deepEqual([pageTwo.more, pageTwo.batches.map((item) => item.rev)], [false, [start + 3, start + 4]]);
  assert.deepEqual([...pageOne.batches, ...pageTwo.batches].map((item) => item.applied), applied.map((answer) => answer.applied));
  // A rev the journal no longer holds (it keeps 200 batches and 1 MiB): take a snapshot.
  const fresh = (await must(s.boards.create({ projectId: s.x, actor: s.id('alice'), name: 'Long' }))).board.id;
  for (let index = 0; index < 205; index += 1) {
    await must(s.boards.apply({ projectId: s.x, boardId: fresh, actor: s.id('alice'),
      batch: batch({ op: 'board.rename', name: `Long ${index}` }) }));
  }
  const head = (await must(s.boards.get({ projectId: s.x, boardId: fresh }))).rev;
  assert.deepEqual(await s.h.ok(s.sync('rae', 0, fresh)), { ok: true, rev: head, snapshot: true });
  const tail = await s.h.ok(s.sync('rae', head - 3, fresh));
  assert.deepEqual([tail.more, tail.batches.map((item) => item.rev)], [false, [head - 2, head - 1, head]]);
});

test('T3: a member removed or revoked while a read waits gets the refusal, not the data; sync has its own limit', async (t) => {
  const seen = [];
  const hold = {};
  const s = await setup(t, { wrapBoards: held(seen, hold), boardLimits: { commands: { sync: { limit: 3 } } } });
  await s.h.ok(s.apply('alice', [note('secret plan')]));
  const waits = async (name, send, change, reason) => {
    let release;
    hold[name] = new Promise((resolve) => { release = resolve; });
    seen.length = 0;
    const reading = send();
    await until(() => seen.includes(name), name);
    await change();
    release();
    hold[name] = null;
    const answer = await reading;
    assert.deepEqual([answer.ok, answer.error?.reason], [false, reason], name);
    assert.equal(JSON.stringify(answer).includes('secret plan') || 'boards' in answer || 'batches' in answer, false, name);
  };
  await waits('since', () => s.sync('carl', 0), () => s.h.ok(s.h.send('alice', 'team.project.members.remove',
    { project_id: s.x, member_id: s.id('carl') })), 'team_not_found');
  await waits('list', () => s.h.send('rae', 'team.board.list', { project_id: s.x }),
    () => s.h.ok(s.h.send('owner', 'team.member.revoke', { member_id: s.id('rae') })), 'member_revoked');
  // The sync limit is a member's own and is not the list's.
  for (let index = 0; index < 3; index += 1) await s.h.ok(s.sync('alice', 0), `sync ${index}`);
  assert.equal(await s.h.reason(s.sync('alice', 0)), 'team_board_rate_limit');
  await s.h.ok(s.h.send('alice', 'team.board.list', { project_id: s.x }));
});
