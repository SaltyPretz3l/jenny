'use strict';

// new-test-file: row 151 slice T4's wiring is a new surface of the team router: the five presence operations as rows
// of the one registry, their closed schemas, their events and limits, the note-lock rule on a board change and the
// drops. The presence store and its operations on their own are in tests/server/team-board-presence.test.js.
//
// Through the real router, authorizer, member store and event stream (helpers/team-board-live-kit.js).

const assert = require('node:assert/strict');
const test = require('node:test');

const { batch, must } = require('./helpers/team-board-kit');
const { UNKNOWN_BOARD, setupBoards } = require('./helpers/team-board-live-kit');

const CARD = '00000000-0000-4000-8000-000000000001';
const PRESENCE = ['team.board.view', 'team.board.leave', 'team.board.cursor'];
const LOCKS = ['team.board.lock', 'team.board.unlock'];
const PARAMS = {
  'team.board.view': (p) => ({ project_id: p.id, board_id: p.live }),
  'team.board.leave': (p) => ({ project_id: p.id, board_id: p.live }),
  'team.board.cursor': (p) => ({ project_id: p.id, board_id: p.live, x: 10, y: -20.5, selected: [p.note] }),
  'team.board.lock': (p) => ({ project_id: p.id, board_id: p.live, card_id: p.note }),
  'team.board.unlock': (p) => ({ project_id: p.id, board_id: p.live, card_id: p.note }),
};
// [label, who, project key, the reason for a presence row and for a lock row, or 'ok'].
const COLUMNS = [
  ['project admin', 'alice', 'X', 'ok', 'ok'],
  ['project writer', 'carl', 'X', 'ok', 'ok'],
  ['read-only team member with a reader row', 'rae', 'X', 'ok', 'role_forbidden'],
  ['full member with a reader row', 'carl', 'Y', 'ok', 'team_project_read_only'],
  ['member outside the project', 'bob', 'X', 'team_not_found', 'team_not_found'],
  ['owner without a row', 'owner', 'X', 'team_not_found', 'team_not_found'],
  ['pending member', 'pia', 'X', 'member_pending', 'member_pending'],
];

test('T4 matrix: viewing and pointers are a reader\'s, a note\'s lock a writer\'s; a refusal changes nothing', async (t) => {
  const s = await setupBoards(t);
  for (const [label, who, key, presence, lock] of COLUMNS) {
    const p = s[key];
    // In order: view first, so the cursor and the lock have a viewing device; leave last.
    for (const operation of ['team.board.view', 'team.board.cursor', 'team.board.lock', 'team.board.unlock', 'team.board.leave']) {
      const expected = LOCKS.includes(operation) ? lock : presence;
      const where = `${operation} by ${label}`;
      const answer = await s.h.send(who, operation, PARAMS[operation](p));
      if (expected === 'ok') assert.equal(answer.ok, true, `${where}: ${JSON.stringify(answer)}`);
      else assert.equal(answer.error?.reason, expected, where);
    }
    assert.deepEqual(s.host.presence.viewersOf(p.live), [], `${label} left nothing behind`);
    assert.deepEqual(s.host.presence.locksOf(p.live), [], label);
  }
});

test('T4 forged ids and the closed schemas', async (t) => {
  const s = await setupBoards(t);
  const { X, Y } = s;
  // A board is viewed and locked only through its own project: another project's, a trashed and an unknown board.
  for (const boardId of [Y.live, X.gone, UNKNOWN_BOARD]) {
    for (const operation of ['team.board.view', 'team.board.lock']) {
      assert.equal((await s.h.send('alice', operation, { ...PARAMS[operation](X), board_id: boardId })).error?.reason,
        'team_board_not_found', `${operation} ${boardId}`);
    }
    assert.equal((await s.h.send('alice', 'team.board.cursor', { ...PARAMS['team.board.cursor'](X), board_id: boardId })).error?.reason,
      'team_board_not_viewing');
  }
  // Carl views X's board; naming it under Y (where he reads) reaches nothing and changes nothing in X.
  await s.h.ok(s.h.send('carl', 'team.board.view', s.at(X)));
  await s.h.ok(s.h.send('carl', 'team.board.lock', PARAMS['team.board.lock'](X)));
  assert.equal((await s.h.send('carl', 'team.board.cursor', { ...PARAMS['team.board.cursor'](X), project_id: Y.id })).error?.reason,
    'team_board_not_viewing');
  await s.h.ok(s.h.send('carl', 'team.board.leave', { project_id: Y.id, board_id: X.live }));
  assert.deepEqual(s.host.presence.viewersOf(X.live), [s.id('carl')], 'a leave under another project leaves nothing');
  assert.equal(s.host.presence.lockHolder(X.live, X.note), s.id('carl'));
  // A card that is not a note of the board cannot be locked.
  assert.equal((await s.h.send('carl', 'team.board.lock', { ...s.at(X), card_id: CARD })).error?.reason, 'team_board_card_not_found');
  // The schemas are closed: no member, no extra field, bounded numbers and lists.
  const cursor = PARAMS['team.board.cursor'](X);
  const malformed = [
    ['team.board.view', { ...s.at(X), member_id: s.id('alice') }], ['team.board.view', { project_id: X.id }],
    ['team.board.view', { ...s.at(X), board_id: 'board_x' }], ['team.board.leave', { ...s.at(X), device_id: 'device_x' }],
    ['team.board.cursor', { ...cursor, x: '10' }], ['team.board.cursor', { ...cursor, y: 1e9 }],
    ['team.board.cursor', { ...cursor, selected: Array.from({ length: 65 }, () => CARD) }],
    ['team.board.cursor', { ...cursor, selected: ['note-1'] }], ['team.board.cursor', { ...cursor, member_id: s.id('alice') }],
    ['team.board.cursor', { ...s.at(X), x: 1, y: 2 }], ['team.board.lock', { ...s.at(X), card_id: 'n1' }],
    ['team.board.lock', s.at(X)], ['team.board.unlock', { ...s.at(X), card_id: CARD, force: true }],
  ];
  for (const [operation, params] of malformed) {
    assert.equal((await s.h.send('alice', operation, params)).error?.reason, 'invalid_command_parameters',
      `${operation} ${JSON.stringify(params).slice(0, 100)}`);
  }
});

test('T4 events: viewers, pointers and locks reach the project\'s members only, and are never replayed', async (t) => {
  const s = await setupBoards(t);
  const { X } = s;
  const streams = Object.fromEntries(['alice', 'rae', 'bob', 'owner'].map((who) => [who, s.h.attach(who)]));
  const before = s.h.core.events.cursor;
  const seen = await s.h.ok(s.h.send('carl', 'team.board.view', s.at(X)));
  assert.deepEqual([seen.viewers, seen.locks, seen.lock_ms], [[s.id('carl')], [], 30_000]);
  await s.h.ok(s.h.send('carl', 'team.board.cursor', PARAMS['team.board.cursor'](X)));
  await s.h.ok(s.h.send('carl', 'team.board.lock', PARAMS['team.board.lock'](X)));
  const base = { project_id: X.id, board_id: X.live };
  for (const who of ['alice', 'rae']) {
    assert.deepEqual(s.frames(streams[who], 'team_board_viewers'), [{ ...base, viewers: [s.id('carl')] }], who);
    assert.deepEqual(s.frames(streams[who], 'team_board_cursor'),
      [{ ...base, member_id: s.id('carl'), x: 10, y: -20.5, selected: [X.note] }], who);
    assert.deepEqual(s.frames(streams[who], 'team_board_lock'), [{ ...base, card_id: X.note, member_id: s.id('carl') }], who);
  }
  for (const who of ['bob', 'owner']) assert.equal(streams[who].frames.join('').includes('team_board_'), false, who);
  // A stream that connects later and replays from before gets none of it.
  const late = s.h.attach('alice', { cursor: before });
  assert.equal(late.frames.join('').includes('team_board_'), false);
  // A second view by the same member changes nothing others see.
  await s.h.ok(s.h.send('carl', 'team.board.view', s.at(X)));
  assert.equal(s.frames(streams.alice, 'team_board_viewers').length, 1);
});

test('T4: a note another member holds is not edited or removed; moving it, and the holder\'s own edit, go through', async (t) => {
  let now = 1_000_000;
  const s = await setupBoards(t, { boardPresenceNow: () => now });
  const { X } = s;
  await s.h.ok(s.h.send('carl', 'team.board.view', s.at(X)));
  await s.h.ok(s.h.send('alice', 'team.board.view', s.at(X)));
  await s.h.ok(s.h.send('carl', 'team.board.lock', PARAMS['team.board.lock'](X)));
  const rev = async () => (await s.board(X)).cards[X.note].content_rev;
  const edit = async (who, text) => s.h.send(who, 'team.board.apply', s.at(X, {
    batch: batch({ op: 'card.edit', id: X.note, content_rev: await rev(), data: { text } }) }));
  for (const ops of [[{ op: 'card.edit', id: X.note, content_rev: await rev(), data: { text: 'Alice was here' } }],
    [{ op: 'card.remove', id: X.note }]]) {
    const refusal = await s.h.send('alice', 'team.board.apply', s.at(X, { batch: batch(...ops) }));
    assert.deepEqual([refusal.error?.reason, refusal.held_by], ['team_board_note_locked', s.id('carl')], ops[0].op);
  }
  assert.equal((await s.h.send('alice', 'team.board.lock', PARAMS['team.board.lock'](X))).held_by, s.id('carl'));
  await s.h.ok(s.h.send('alice', 'team.board.apply', s.at(X, { batch: batch({ op: 'card.place', id: X.note, x: 40, y: 40 }) })), 'move');
  await s.h.ok(edit('carl', 'Carl wrote this'), 'the holder edits');
  assert.equal((await s.board(X)).cards[X.note].data.text, 'Carl wrote this');
  // Unlocked, or the lease run out (30 seconds without a renewal): the note is anyone's again.
  await s.h.ok(s.h.send('carl', 'team.board.unlock', PARAMS['team.board.unlock'](X)));
  await s.h.ok(edit('alice', 'Alice after the unlock'));
  await s.h.ok(s.h.send('carl', 'team.board.lock', PARAMS['team.board.lock'](X)));
  assert.equal((await edit('alice', 'too early')).error?.reason, 'team_board_note_locked');
  now += 30_001;
  await s.h.ok(edit('alice', 'Alice after the lease'));
});

test('T4 drops: a member who loses the project, their role or their device loses their viewing and their locks', async (t) => {
  const s = await setupBoards(t);
  const { X } = s;
  const carl = s.id('carl');
  const viewing = () => s.host.presence.viewersOf(X.live);
  const look = async () => {
    await s.h.ok(s.h.send('carl', 'team.board.view', s.at(X)));
    await s.h.ok(s.h.send('carl', 'team.board.lock', PARAMS['team.board.lock'](X)));
    assert.deepEqual([viewing(), s.host.presence.lockHolder(X.live, X.note)], [[carl], carl]);
  };
  const gone = (what) => assert.deepEqual([viewing(), s.host.presence.lockHolder(X.live, X.note)], [[], null], what);
  const stream = s.h.attach('alice');

  await look();
  await s.h.ok(s.h.send('alice', 'team.project.members.setRole', { project_id: X.id, member_id: carl, role: 'reader' }));
  gone('a project role change');
  assert.deepEqual(s.frames(stream, 'team_board_lock').at(-1), { project_id: X.id, board_id: X.live, card_id: X.note, member_id: null });
  assert.deepEqual(s.frames(stream, 'team_board_viewers').at(-1), { project_id: X.id, board_id: X.live, viewers: [] });
  assert.equal((await s.h.send('carl', 'team.board.lock', PARAMS['team.board.lock'](X))).error?.reason, 'team_project_read_only');
  await s.h.ok(s.h.send('alice', 'team.project.members.setRole', { project_id: X.id, member_id: carl, role: 'writer' }));

  // The device's last stream closes (two were open).
  await look();
  const device = s.h.seats.carl.device_id;
  s.host.onMemberStream(carl, device, 'open');
  s.host.onMemberStream(carl, device, 'open');
  s.host.onMemberStream(carl, device, 'close');
  assert.deepEqual(viewing(), [carl], 'one stream is still open');
  s.host.onMemberStream(carl, device, 'close');
  gone('the last stream closed');

  await look();
  await s.h.ok(s.h.send('alice', 'team.project.members.remove', { project_id: X.id, member_id: carl }));
  gone('removed from the project');
  await s.h.ok(s.h.send('alice', 'team.project.members.add', { project_id: X.id, member_id: carl, role: 'writer' }));

  await look();
  await s.h.ok(s.h.send('owner', 'team.member.revoke', { member_id: carl }));
  gone('revoked');

  // Deleting the project drops everyone viewing its boards.
  await s.h.ok(s.h.send('alice', 'team.board.view', s.at(X)));
  await s.h.ok(s.h.send('alice', 'team.project.delete', { project_id: X.id }));
  assert.deepEqual(viewing(), []);
});

test('T4 limits: a cursor is counted by device, presence calls by member, and neither spends the board\'s other limits', async (t) => {
  const s = await setupBoards(t, { boardLimits: { commands: { cursor: { limit: 3 }, presence: { limit: 4 } } } });
  const { X } = s;
  await s.h.ok(s.h.send('carl', 'team.board.view', s.at(X)));
  await s.h.ok(s.h.send('alice', 'team.board.view', s.at(X)));
  const cursor = (who) => s.h.send(who, 'team.board.cursor', PARAMS['team.board.cursor'](X));
  for (let sent = 0; sent < 3; sent += 1) await s.h.ok(cursor('carl'));
  assert.equal((await cursor('carl')).error?.reason, 'team_board_rate_limit');
  await s.h.ok(cursor('alice'), 'another device has its own count');
  for (let sent = 0; sent < 3; sent += 1) await s.h.ok(s.h.send('carl', 'team.board.view', s.at(X)));
  assert.equal((await s.h.send('carl', 'team.board.view', s.at(X))).error?.reason, 'team_board_rate_limit');
  await s.h.ok(s.h.send('carl', 'team.board.list', { project_id: X.id }));
  await s.h.ok(s.h.send('carl', 'team.board.apply', s.at(X, { batch: batch({ op: 'card.place', id: X.note, x: 1, y: 1 }) })));
  // A limited cursor is not logged (it could be hundreds a minute), and no log line names a card.
  const answered = s.h.fx.logs.filter((entry) => entry.event === 'team_board.command_answered').map((entry) => entry.fields);
  assert.deepEqual(answered, [{ operation: 'team.board.view', ok: false, reason: 'team_board_rate_limit' }]);
  assert.equal(s.h.logText().includes(X.note), false);
  assert.equal((await must(s.boards.get({ projectId: X.id, boardId: X.live }))).board.cards[X.note].x, 1);
});

test('T4 drops: deleting a board takes its viewers and locks with it and tells the project; restoring it starts clean', async (t) => {
  const s = await setupBoards(t);
  const { X } = s;
  const carl = s.id('carl');
  const stream = s.h.attach('alice');
  await s.h.ok(s.h.send('carl', 'team.board.view', s.at(X)));
  await s.h.ok(s.h.send('carl', 'team.board.lock', PARAMS['team.board.lock'](X)));
  assert.deepEqual([s.host.presence.viewersOf(X.live), s.host.presence.lockHolder(X.live, X.note)], [[carl], carl]);
  await s.h.ok(s.h.send('alice', 'team.board.delete', { project_id: X.id, board_id: X.live }));
  assert.deepEqual([s.host.presence.viewersOf(X.live), s.host.presence.lockHolder(X.live, X.note)], [[], null],
    'nobody is left viewing a board in the trash');
  assert.deepEqual(s.frames(stream, 'team_board_viewers').at(-1), { project_id: X.id, board_id: X.live, viewers: [] });
  assert.deepEqual(s.frames(stream, 'team_board_lock').at(-1), { project_id: X.id, board_id: X.live, card_id: X.note, member_id: null });
  assert.equal(s.host.presence.resources().boards, 0);
  await s.h.ok(s.h.send('alice', 'team.board.restore', { project_id: X.id, board_id: X.live }));
  assert.deepEqual(s.host.presence.viewersOf(X.live), []);
});
