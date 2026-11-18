'use strict';

// new-test-file: tests/team-project-conversations.test.js (project-list.js's unit lane) is at the 600-line cap.
// Row 175 F9: project-list.js seeds the per-conversation activity and this member's waiting approvals from the host's
// `sessions.list` counts at connect, on a resync and on a reconnect, against a fake manager (no host); live events take
// over from the first one that names an approval; a malformed count from the host is dropped by main.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createProjectList } = require('../services/team/project-list');

const PROJECT = 'project_aaaaaaaaaaaa';
const S1 = 'sess_1111111111111111111111111111111a';
const S2 = 'sess_2222222222222222222222222222222b';
const S3 = 'sess_3333333333333333333333333333333c';

function listOf(role, sessions) {
  const answers = {
    'projects.list': { ok: true, projects: [{ id: PROJECT, name: 'Atlas', root_revision: 1, role }], files_supported: true },
    'sessions.list': { ok: true, sessions },
  };
  const pushes = [];
  const manager = { command: async (operation) => answers[operation] ?? { ok: true } };
  const list = createProjectList({ manager, teamId: 'team_a', push: (payload) => pushes.push(payload) });
  return { list, pushes, answers };
}
const row = (sessionId, waiting) => ({ session_id: sessionId, title: 'T', project_id: PROJECT, ...(waiting ? { waiting } : {}) });
const lastWaiting = (pushes, sessionId) => pushes.filter((p) => p.kind === 'project_waiting' && p.session_id === sessionId).at(-1);
const turn = () => new Promise((resolve) => setImmediate(resolve));

test('counts present at connect are seeded into the activity the store takes, and the waiting count of a writer', async () => {
  const { list, pushes } = listOf('writer', [row(S1, { approvals: 2, questions: 1 }), row(S2, { approvals: 0, questions: 0 }),
    row(S3, { approvals: 0, questions: 3 })]);
  assert.equal((await list.refresh()).ok, true);
  const view = pushes.filter((p) => p.kind === 'projects').at(-1);
  assert.deepEqual(view.activity, { [S1]: { approvals: 2, running: false, questions: 1 },
    [S3]: { approvals: 0, running: false, questions: 3 } });
  assert.deepEqual(lastWaiting(pushes, S1), { kind: 'project_waiting', team_id: 'team_a', session_id: S1, count: 2 });
  assert.equal(lastWaiting(pushes, S2), undefined, 'nothing waits there: no push');
  list.stop();
});

test('a reader\'s activity is seeded but nothing waits for them', async () => {
  const { list, pushes } = listOf('reader', [row(S1, { approvals: 1, questions: 0 })]);
  await list.refresh();
  assert.deepEqual(list.view().activity, { [S1]: { approvals: 1, running: false } });
  assert.equal(pushes.some((p) => p.kind === 'project_waiting'), false);
  list.stop();
});

test('live events take over from the seeded counts: a decision, a question answered, the run\'s end', async () => {
  const { list, pushes } = listOf('admin', [row(S1, { approvals: 1, questions: 1 }), row(S2, { approvals: 1, questions: 0 })]);
  await list.refresh();
  // The seeded approval is decided (its id was never seen live): the count goes, for the store and the waiting count.
  list.onEvent({ event_type: 'decision_changed', session_id: S1, stream_id: 'stream_1', approval_id: 'approval_x',
    prompter_member_id: null, approver_member_id: null, approved: true });
  assert.deepEqual(pushes.filter((p) => p.kind === 'activity').at(-1), { kind: 'activity', team_id: 'team_a', session_id: S1,
    approvals: 0, running: false, questions: 1 });
  assert.equal(lastWaiting(pushes, S1).count, 0);
  list.onEvent({ event_type: 'decision_changed', session_id: S1, stream_id: 'stream_1', question_ref: 'question_1',
    prompter_member_id: null });
  assert.deepEqual(pushes.filter((p) => p.kind === 'activity').at(-1), { kind: 'activity', team_id: 'team_a', session_id: S1,
    approvals: 0, running: false });
  // The host republishes the seeded approval as unattended: it counts once, by its id now.
  list.onEvent({ event_type: 'approval_unattended', session_id: S2, stream_id: 'stream_2', approval_id: 'approval_y',
    prompter_member_id: null });
  assert.equal(list.view().activity[S2].approvals, 1);
  assert.equal(lastWaiting(pushes, S2).count, 1);
  list.onEvent({ event_type: 'chat_stream', session_id: S2, stream_id: 'stream_2', event: { type: 'complete' } });
  assert.deepEqual(list.view().activity, {});
  assert.equal(lastWaiting(pushes, S2).count, 0);
  list.stop();
});

test('a resync and a reconnect clear the counts and the read that follows seeds them again', async () => {
  const { list, pushes, answers } = listOf('writer', [row(S1, { approvals: 1, questions: 0 })]);
  await list.refresh();
  answers['sessions.list'] = { ok: true, sessions: [row(S1, { approvals: 0, questions: 0 }), row(S2, { approvals: 1, questions: 0 })] };
  list.onEvent({ event_type: 'resync_required' });
  for (let i = 0; i < 5; i += 1) await turn();
  assert.deepEqual(list.view().activity, { [S2]: { approvals: 1, running: false } });
  assert.equal(lastWaiting(pushes, S1).count, 0);
  assert.equal(lastWaiting(pushes, S2).count, 1);
  list.clearActivity();
  assert.deepEqual(list.view().activity, {});
  assert.equal(lastWaiting(pushes, S2).count, 0);
  await list.refresh();
  assert.deepEqual(list.view().activity, { [S2]: { approvals: 1, running: false } });
  list.stop();
});

test('a malformed count from the host is dropped by main and seeds nothing; an older host\'s rows change nothing', async () => {
  const { list, pushes } = listOf('writer', [row(S1, { approvals: 999, questions: 0 }), row(S2, { approvals: '1', questions: 0 }),
    row(S3)]);
  await list.refresh();
  const view = pushes.filter((p) => p.kind === 'projects').at(-1);
  assert.equal(view.conversations.length, 3, 'the rows stay');
  assert.equal(view.conversations.some((r) => Object.hasOwn(r, 'waiting')), false);
  assert.deepEqual(view.activity, {});
  assert.equal(pushes.some((p) => p.kind === 'project_waiting'), false);
  list.stop();
});

// Row 175 F13 (D8): the host sends `teammate_asked` to the asked member alone; main tells it as an `asked` notice.
test('a teammate\'s ask is an asked notice naming the asker, each time; a malformed one tells nothing', async () => {
  const { list, pushes } = listOf('reader', [row(S1)]);
  await list.refresh();
  const asker = 'member_aaaaaaaaaaaaaaaaaaaaaa';
  const ask = { event_type: 'teammate_asked', session_id: S1, project_id: PROJECT, asker_member_id: asker,
    asked_member_id: 'member_bbbbbbbbbbbbbbbbbbbbbb' };
  list.onEvent(ask);
  list.onEvent({ ...ask, approval_id: 'approval_1', text: 'secret prompt' });
  list.onEvent({ ...ask, asker_member_id: 'Alice' });
  const told = pushes.filter((p) => p.kind === 'project_notice');
  assert.deepEqual(told.map(({ notice_id: _id, ...rest }) => rest), [
    { kind: 'project_notice', team_id: 'team_a', session_id: S1, project_id: PROJECT, title: 'T', notice: 'asked', asker_member_id: asker },
    { kind: 'project_notice', team_id: 'team_a', session_id: S1, project_id: PROJECT, title: 'T', notice: 'asked', asker_member_id: asker,
      approval_id: 'approval_1' }]);
  assert.notEqual(told[0].notice_id, told[1].notice_id);
  list.stop();
});
