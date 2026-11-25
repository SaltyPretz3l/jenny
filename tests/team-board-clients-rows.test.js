'use strict';

// new-test-file: tests/team-board-ipc.test.js is at its 600-line cap. The list rows of services/team/team-board-clients.js
// (H17): a row the host index rebuilt with no known creator is a row, one bad row never fails the whole list, and the
// list is as long as the host's index allows.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { ENTRIES_MAX } = require('../server/team/boards/board-host-index');
const { createTeamBoardClients } = require('../services/team/team-board-clients');

const TEAM = `team_${'a'.repeat(32)}`;
const PROJECT = `project_${'b'.repeat(32)}`;
const NOW = '2026-11-15T09:00:00.000Z';
const reasonOf = (answer) => answer?.error?.reason;

function setup() {
  const manager = {
    answers: {},
    snapshot: () => ({ state: 'online', member_state: 'active', member_id: 'member_me', role: 'member' }),
    onEvent: () => () => {},
    command: async (operation) => manager.answers[operation],
    borrow: () => ({ online: true, ensureClient: async () => null, link: null }),
  };
  const boards = createTeamBoardClients({ managerOf: (teamId) => (teamId === TEAM ? manager : null), push: () => {} });
  return { manager, boards };
}

const row = (extra = {}) => ({ id: `board_${crypto.randomUUID()}`, name: 'Plan', rev: 1, created_at: NOW, updated_at: NOW,
  created_by: 'member_alice', ...extra });
const list = (s, method = 'boardList') => s.boards.call(method, { team_id: TEAM, project_id: PROJECT });

test('H17: a board the host index rebuilt with no creator is listed, beside the rows that have one', async () => {
  const s = setup();
  const rebuilt = row({ name: 'Recovered', created_by: null });
  const normal = row();
  s.manager.answers['team.board.list'] = { ok: true, boards: [rebuilt, normal] };
  assert.deepEqual(await list(s), { ok: true, boards: [rebuilt, normal] });
  const gone = { ...rebuilt, deleted_at: NOW, deleted_by: 'member_bob' };
  s.manager.answers['team.board.trash'] = { ok: true, boards: [gone] };
  assert.deepEqual(await list(s, 'boardTrash'), { ok: true, boards: [gone] });
  // Only a creator that is null or a member token is a creator; the other fields are still checked.
  for (const created_by of ['', 7, undefined, 'x'.repeat(161)]) {
    s.manager.answers['team.board.list'] = { ok: true, boards: [row({ created_by })] };
    assert.equal(reasonOf(await list(s)), 'team_response_invalid', String(created_by));
  }
  // A trashed row still needs the member who deleted it.
  s.manager.answers['team.board.trash'] = { ok: true, boards: [{ ...gone, deleted_by: null }] };
  assert.equal(reasonOf(await list(s, 'boardTrash')), 'team_response_invalid');
});

test('H17: the list holds as many rows as the host index does (511), no more', async () => {
  const s = setup();
  const many = (count) => Array.from({ length: count }, (_unused, n) => row({ name: `Board ${n}` }));
  assert.equal(ENTRIES_MAX, 511);
  s.manager.answers['team.board.list'] = { ok: true, boards: many(ENTRIES_MAX) };
  assert.equal((await list(s)).boards.length, ENTRIES_MAX);
  // A trash of more than the old 256 rows is a trash.
  const gone = Array.from({ length: 300 }, (_unused, n) => row({ name: `Old ${n}`, deleted_at: NOW, deleted_by: 'member_bob' }));
  s.manager.answers['team.board.trash'] = { ok: true, boards: gone };
  assert.equal((await list(s, 'boardTrash')).boards.length, 300);
  s.manager.answers['team.board.list'] = { ok: true, boards: many(ENTRIES_MAX + 1) };
  assert.equal(reasonOf(await list(s)), 'team_response_invalid');
});
