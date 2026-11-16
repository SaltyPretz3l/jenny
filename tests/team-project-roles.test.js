'use strict';

// new-test-file: role and membership outcomes through the member client against the real in-process team host (row 123
// slice 3-9 fix list items 5, 20, 21, 23): every refusal names its reason, ids from another project and an unknown
// project, the turn rule on a take over, a member removed or made read-only while a conversation is open, and a team
// role change re-reading the list. tests/team-project-ipc.test.js holds the mapping, the list and the lease flow.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { tempProfile, waitUntil } = require('./helpers/team-client-host');
const { drained, lastPush, projectTeam } = require('./helpers/team-project-client-host');

const reasonOf = (answer) => (answer.ok === false ? answer.error.reason : `ok ${JSON.stringify(answer).slice(0, 80)}`);

test('every refused call through the client names its reason; the final ones are not retryable', async (t) => {
  const picks = [];
  const f = await projectTeam(t, { projectOptions: { transferOptions: { pickFolder: async () => picks.shift() ?? null } } });
  const { teamId, projectId, writer, reader, outsider, owner } = f;
  const team = { team_id: teamId };
  const ids = { ...team, project_id: projectId };
  const writerAsks = {
    projectRename: { ...ids, name: 'Renamed' },
    projectDelete: ids,
    projectSetMember: { ...ids, member_id: reader.member.member_id, role: 'writer' },
    projectRemoveMember: { ...ids, member_id: reader.member.member_id },
  };
  for (const [method, value] of Object.entries(writerAsks)) {
    assert.equal(reasonOf(await writer.call(method, value)), 'role_forbidden', `writer ${method}`);
  }
  // The reader: an upload is refused at begin, a decision before any approval is looked up.
  const folder = path.join(tempProfile(t, 'jenny-roles-src-'), 'src');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'a.txt'), 'a');
  picks.push(folder);
  assert.equal((await reader.call('uploadFolder', ids)).started, true);
  assert.ok(await waitUntil(() => lastPush(reader, 'transfer')?.state === 'failed'), 'the reader upload ended');
  assert.equal(lastPush(reader, 'transfer').reason, 'team_project_read_only');
  const created = await writer.call('conversationCreate', ids);
  const s = { ...team, session_id: created.session.session_id };
  const decide = { ...s, stream_id: 'stream_1', approval_id: 'approval_1', decision_revision: 'r1', approved: true };
  assert.equal(reasonOf(await reader.call('conversationDecide', decide)), 'team_project_read_only', 'reader decide');
  // Another project the writer is not on, and a project the host does not know: the host's not-found (it never says
  // whether the project exists), final, never retryable.
  const other = await owner.call('projectCreate', { ...team, name: 'Borealis' });
  const otherSession = (await owner.call('conversationCreate', { ...team, project_id: other.project_id })).session.session_id;
  const finals = [
    ['writer conversationCreate in another project', writer, 'conversationCreate', { ...team, project_id: other.project_id }],
    ['writer conversationOpen in another project', writer, 'conversationOpen', { ...team, session_id: otherSession }],
    ['writer projectMembers of another project', writer, 'projectMembers', { ...team, project_id: other.project_id }],
    ['an unknown project', writer, 'projectMembers', { ...team, project_id: 'project_zzzzzzzzzzzz' }],
    ['outsider open', outsider, 'conversationOpen', s],
    ['outsider members', outsider, 'projectMembers', ids],
  ];
  for (const [label, one, method, value] of finals) {
    const answer = await one.call(method, value);
    assert.deepEqual(answer.error, { code: 'CMP-HOST-0003', reason: 'team_not_found' }, label);
    assert.equal(answer.error.retryable, undefined, label);
  }
  // A leased call on a conversation this member could not open is the client's own refusal, sent nowhere.
  assert.equal(reasonOf(await outsider.call('conversationRename', { ...s, title: 'x' })), 'team_conversation_not_open');
  // A team id this device holds no seat in is the client's own refusal.
  assert.equal(reasonOf(await writer.call('projectMembers', { team_id: 'team_unknownTeamId123', project_id: projectId })),
    'team_not_found');
});

test('a take over while another member\'s turn runs is refused control_turn_active through the client', async (t) => {
  const f = await projectTeam(t);
  const { teamId, projectId, writer, owner, outsider } = f;
  const team = { team_id: teamId };
  await owner.call('projectAddMember', { ...team, project_id: projectId, member_id: outsider.member.member_id, role: 'writer' });
  const s = { ...team, session_id: (await writer.call('conversationCreate', { ...team, project_id: projectId })).session.session_id };
  await writer.call('conversationOpen', s);
  assert.equal((await writer.call('conversationSend', { ...s, prompt: 'go' })).ok, true, 'the writer\'s turn runs');
  await outsider.call('conversationOpen', s);
  const refused = await outsider.call('conversationControl', { ...s, action: 'takeover' });
  assert.equal(reasonOf(refused), 'control_turn_active');
  assert.equal(lastPush(writer, 'lease')?.held, true, 'the writer keeps the lease');
});

test('a member removed from the project with a conversation open: closed, both timers stopped, nothing more sent', async (t) => {
  const f = await projectTeam(t);
  const { teamId, projectId, writer, owner } = f;
  const team = { team_id: teamId };
  const s = { ...team, session_id: (await owner.call('conversationCreate', { ...team, project_id: projectId })).session.session_id };
  // As the screen does: the conversation is picked from its project's list, so the client knows its project.
  await writer.call('projectConversations', { ...team, project_id: projectId });
  assert.equal((await writer.call('conversationOpen', s)).ok, true);
  assert.equal((await writer.call('conversationControl', { ...s, action: 'take' })).ok, true);
  assert.equal(writer.service.projectResources().timers, 2, 'a viewing timer and a lease timer');
  await owner.call('projectRemoveMember', { ...team, project_id: projectId, member_id: writer.member.member_id });
  assert.ok(await waitUntil(() => lastPush(writer, 'closed', (p) => p.session_id === s.session_id)), 'closed pushed');
  assert.equal(lastPush(writer, 'closed').reason, 'project_not_found');
  assert.deepEqual([writer.service.projectResources().conversations, writer.service.projectResources().timers], [0, 0]);
  await drained(writer, f.seen);
  const before = f.seen.length;
  writer.timers.tick();
  await drained(writer, f.seen);
  assert.deepEqual(f.seen.slice(before).map((c) => c.operation).filter((op) => op === 'session.view' || op === 'control.heartbeat'), []);
});

test('a member made read-only while holding the lease: the lease ends with its reason, the conversation stays open', async (t) => {
  const f = await projectTeam(t);
  const { teamId, projectId, writer, owner } = f;
  const team = { team_id: teamId };
  const s = { ...team, session_id: (await owner.call('conversationCreate', { ...team, project_id: projectId })).session.session_id };
  await writer.call('projectConversations', { ...team, project_id: projectId });
  await writer.call('conversationOpen', s);
  assert.equal((await writer.call('conversationControl', { ...s, action: 'take' })).ok, true);
  await owner.call('projectSetMember', { ...team, project_id: projectId, member_id: writer.member.member_id, role: 'reader' });
  // No tick: the list re-read on the members change ends it.
  assert.ok(await waitUntil(() => lastPush(writer, 'lease', (p) => p.session_id === s.session_id)?.held === false), 'lease ended');
  assert.equal(lastPush(writer, 'lease').reason, 'team_project_read_only');
  assert.deepEqual([writer.service.projectResources().conversations, writer.service.projectResources().timers], [1, 1]);
  await drained(writer, f.seen);
  const before = f.seen.length;
  writer.timers.tick();
  // The tick's view reaches the host (a reader keeps viewing); a heartbeat would have gone with it.
  assert.ok(await waitUntil(() => f.seen.slice(before).some((c) => c.operation === 'session.view')), 'a reader keeps viewing');
  await drained(writer, f.seen);
  assert.equal(f.seen.slice(before).some((c) => c.operation === 'control.heartbeat'), false, 'no heartbeat after the lease ended');
});

test('F1: the owner\'s list on a host holding General answers the real projects; General is never addressable', async (t) => {
  const f = await projectTeam(t);
  const { teamId, projectId, owner, writer } = f;
  const team = { team_id: teamId };
  // The host's application store holds General, as a deployed host's projects.json does.
  f.host.env.parts.app.records.set('project_general', { id: 'project_general', name: 'General', root_path: null,
    root_revision: 0 });
  const listed = await owner.call('projectList', team);
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.deepEqual([listed.projects.map((row) => row.id), listed.projects_truncated], [[projectId], false]);
  const created = await owner.call('conversationCreate', { ...team, project_id: projectId });
  assert.equal(created.ok, true);
  const conversations = await owner.call('projectConversations', { ...team, project_id: projectId });
  assert.equal(conversations.ok, true, JSON.stringify(conversations));
  assert.deepEqual(conversations.conversations.map((row) => row.session_id), [created.session.session_id]);
  assert.ok(lastPush(owner, 'projects', (p) => Array.isArray(p.projects)), 'a projects push with rows');
  assert.equal(owner.pushes.some((p) => p.kind === 'projects' && p.projects === null && p.files_supported === true), false);
  // A project method naming General is refused in main before any request.
  await drained(owner, f.seen);
  const before = f.seen.length;
  for (const [method, value] of [['projectMembers', { ...team, project_id: 'project_general' }],
    ['projectConversations', { ...team, project_id: 'project_general' }],
    ['conversationCreate', { ...team, project_id: 'project_general' }]]) {
    assert.deepEqual((await owner.call(method, value)).error, { code: 'invalid_request', reason: 'team_request_invalid' }, method);
  }
  await drained(owner, f.seen);
  assert.equal(f.seen.length, before, 'nothing sent to the host');
  // A member never gets General: its list is as before.
  assert.deepEqual((await writer.call('projectList', team)).projects.map((row) => [row.id, row.role]), [[projectId, 'writer']]);
});

// The host sends no event for a team role change; the client learns it at its next status read (a reconnect), and the
// changed facts read the list again.
test('a team role change to read-only reads the list again', async (t) => {
  const f = await projectTeam(t);
  const { teamId, writer, owner } = f;
  await writer.call('projectList', { team_id: teamId });
  await drained(writer, f.seen);
  const lists = () => f.seen.filter((c) => c.operation === 'projects.list').length;
  const before = lists();
  assert.equal((await owner.call('memberSetRole', { team_id: teamId, member_id: writer.member.member_id, role: 'read_only' })).ok, true);
  f.host.dropEventStreams(writer.member.device_id);
  assert.ok(await waitUntil(() => writer.states.at(-1)?.teams.find((row) => row.team_id === teamId)?.role === 'read_only',
    { attempts: 300, interval: 20 }), 'the new role read');
  assert.ok(await waitUntil(() => lists() > before), 'the list was read again');
  await drained(writer, f.seen);
  // Served from the kept list (no read of its own): it shows the effective role only because it was read again.
  const served = f.seen.length;
  const listed = await writer.call('projectList', { team_id: teamId });
  assert.deepEqual(listed.projects.map((row) => row.role), ['reader'], 'the effective role');
  assert.equal(f.seen.length, served, 'answered from the list');
});
