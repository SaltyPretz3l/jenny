'use strict';

// Slice 3-9: the member client for shared projects (services/team/team-projects.js, project-list.js,
// project-conversations.js) through team-service.js against the real in-process team host with the project half
// (tests/helpers/team-client-host.js `projects: true`): each method's host operation and exact params, refused
// payloads, role boundaries, the list's re-reads, the conversation and lease flow, and that nothing is left running.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { CONVERSATION_LIMITS, createProjectConversations } = require('../services/team/project-conversations');
const { createProjectList } = require('../services/team/project-list');
const { PROJECT_OPERATIONS } = require('../services/team/ipc-methods');
const { attachTeamChat } = require('./helpers/team-chat-hook');
const { pause, waitUntil } = require('./helpers/team-client-host');
const {
  BACKGROUND, PROJECT_METHODS, drained, fakeTimers, lastPush, online, projectTeam, sentBy,
} = require('./helpers/team-project-client-host');

test('the method list is the 36 project methods, each with its mapped operation', () => {
  // Row 175 wave 5: the reader view's two methods follow the shared list.
  // Row 175 round 2b: regenerate, edit and resend, branch, ask a teammate, hand the driver seat.
  assert.deepEqual(Object.keys(PROJECT_OPERATIONS), [...PROJECT_METHODS, 'projectFiles', 'projectFileRead',
    'projectRegenerate', 'projectEditResend', 'projectBranch', 'projectAskTeammate', 'projectHandDriver']);
  assert.equal(PROJECT_OPERATIONS.conversationPreferences, 'sessions.preferences', 'row 172: leased, as conversationSend');
  assert.deepEqual([PROJECT_OPERATIONS.projectFiles, PROJECT_OPERATIONS.projectFileRead],
    ['team.project.files.list', 'team.project.files.read']);
});

// Row 175 wave 5: the reader view through main and the real host: each method's operation and exact params, the answer
// rebuilt to its fields, a member outside the project refused by the host, a bad path refused in main.
test('row 175 wave 5: projectFiles and projectFileRead reach the host as their operations; a bad path never leaves main', async (t) => {
  const f = await projectTeam(t);
  const { teamId, projectId, seen, reader, outsider } = f;
  const folder = path.join(f.host.env.parts.projectsRoot, projectId, 'docs');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'a.md'), '# Atlas');
  const ids = { team_id: teamId, project_id: projectId };
  const sentOps = (sent) => sent.map((command) => [command.operation, command.params]);
  const listed = await sentBy(seen, () => reader.call('projectFiles', { ...ids, dir: 'docs' }), ['team.project.files.list']);
  assert.deepEqual(sentOps(listed.sent), [['team.project.files.list', { project_id: projectId, dir: 'docs' }]]);
  assert.deepEqual(listed.answer, { ok: true, entries: [{ path: 'docs/a.md', size: 7, kind: 'file' }], next_cursor: null,
    total: 1, capped: false });
  const page = await reader.call('projectFiles', { ...ids, cursor: 0 });
  assert.deepEqual(page.entries.map((entry) => [entry.path, entry.kind]), [['docs', 'dir'], ['docs/a.md', 'file']]);
  const read = await sentBy(seen, () => reader.call('projectFileRead', { ...ids, path: 'docs/a.md' }), ['team.project.files.read']);
  assert.deepEqual(sentOps(read.sent), [['team.project.files.read', { project_id: projectId, path: 'docs/a.md' }]]);
  assert.deepEqual(read.answer, { ok: true, path: 'docs/a.md', size: 7, text: '# Atlas', truncated: false, binary: false });
  assert.equal((await outsider.call('projectFileRead', { ...ids, path: 'docs/a.md' })).error.reason, 'team_not_found');
  const before = seen.length;
  for (const [method, payload] of [
    ['projectFileRead', { ...ids, path: '../outside.txt' }], ['projectFileRead', { ...ids, path: '/etc/passwd' }],
    ['projectFileRead', { ...ids, path: 'docs\\a.md' }], ['projectFileRead', { ...ids, path: '.env' }],
    ['projectFileRead', { ...ids, path: 'C:/Windows/win.ini' }], ['projectFileRead', { ...ids }],
    ['projectFileRead', { ...ids, path: 'docs/a.md', cursor: 0 }], ['projectFiles', { ...ids, dir: 'docs/..' }],
    ['projectFiles', { ...ids, cursor: -1 }], ['projectFiles', { ...ids, path: 'docs/a.md' }]]) {
    assert.equal((await reader.call(method, payload)).ok, false, `${method} ${JSON.stringify(payload)}`);
  }
  assert.deepEqual(seen.slice(before).filter((command) => command.operation.startsWith('team.project.files.')), []);
});

test('each project method reaches the host as its operation with exactly its params', async (t) => {
  const f = await projectTeam(t);
  const { owner, writer, teamId, projectId, seen } = f;
  const team = { team_id: teamId };
  const expectOne = async (one, method, payload, operation, params, envelope = {}) => {
    const { answer, sent } = await sentBy(seen, () => one.call(method, { ...team, ...payload }), [operation]);
    const mine = sent.filter((command) => command.operation === operation);
    assert.equal(mine.length >= 1, true, `${method} sent ${JSON.stringify(sent.map((c) => c.operation))}`);
    assert.deepEqual(mine[0].params, params, method);
    for (const [name, check] of Object.entries(envelope)) assert.equal(check(mine[0][name]), true, `${method} ${name}`);
    return answer;
  };
  // Row 175: the list is read when the team comes online, with exactly its params; once current, list calls answer
  // from it with no request (fix 15).
  await drained(writer, seen);
  assert.ok(seen.some((c) => c.operation === 'projects.list' && JSON.stringify(c.params) === '{}'), 'read at connect');
  const kept = await sentBy(seen, () => writer.call('projectList', team), ['projects.list', 'sessions.list'], writer);
  assert.deepEqual([kept.answer.ok, kept.sent], [true, []], 'served from the kept list');
  await expectOne(owner, 'projectRename', { project_id: projectId, name: 'Atlas Two' }, 'team.project.rename',
    { project_id: projectId, name: 'Atlas Two' });
  await expectOne(owner, 'projectMembers', { project_id: projectId }, 'team.project.members.list', { project_id: projectId });
  await expectOne(owner, 'projectSetMember', { project_id: projectId, member_id: f.reader.member.member_id, role: 'writer' },
    'team.project.members.setRole', { project_id: projectId, member_id: f.reader.member.member_id, role: 'writer' });
  await expectOne(owner, 'projectAudit', { project_id: projectId, limit: 5 }, 'team.project.audit.read',
    { project_id: projectId, limit: 5 });
  await drained(writer, seen);
  const listed = await sentBy(seen, () => writer.call('projectConversations', { ...team, project_id: projectId }),
    ['projects.list', 'sessions.list'], writer);
  assert.deepEqual([listed.answer.ok, listed.sent], [true, []], 'conversations served from the kept list');
  const created = await expectOne(writer, 'conversationCreate', { project_id: projectId, title: 'Plan' }, 'sessions.create',
    { project_id: projectId, title: 'Plan' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const sessionId = created.session.session_id;
  const bySession = { session_id: (value) => value === sessionId };
  const leased = { ...bySession, control_generation: Number.isSafeInteger, expected_revision: (v) => typeof v === 'string' };
  const s = { session_id: sessionId };
  const opened = await expectOne(writer, 'conversationOpen', s, 'sessions.snapshot', { max_messages: 20 }, bySession);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  await expectOne(writer, 'conversationControl', { ...s, action: 'take' }, 'control.acquire', {}, bySession);
  const sent = await expectOne(writer, 'conversationSend', { ...s, prompt: 'hello' }, 'chat.send', { prompt: 'hello' }, leased);
  assert.equal(sent.ok, true, JSON.stringify(sent));
  await expectOne(writer, 'conversationCancel', { ...s, stream_id: 'stream_1' }, 'chat.cancel', { stream_id: 'stream_1' }, leased);
  await expectOne(writer, 'conversationRename', { ...s, title: 'Plan B' }, 'sessions.rename', { title: 'Plan B' }, leased);
  const decide = { stream_id: 'stream_1', approval_id: 'approval_x', decision_revision: 'rev_1', approved: true };
  await expectOne(writer, 'conversationDecide', { ...s, ...decide }, 'approval.resolve', decide, bySession);
  const answer = { stream_id: 'stream_1', question_ref: 'question_x', answers: [{ question_id: 'q1', answer: 'yes' }] };
  await expectOne(writer, 'conversationAnswer', { ...s, ...answer }, 'questions.answer', answer, bySession);
  await expectOne(writer, 'conversationDecline', { ...s, stream_id: 'stream_1', question_ref: 'question_x' }, 'questions.decline',
    { stream_id: 'stream_1', question_ref: 'question_x' }, bySession);
  await expectOne(writer, 'conversationControl', { ...s, action: 'release' }, 'control.release', {},
    { ...bySession, control_generation: Number.isSafeInteger });
  // A delete with no lease held takes it first (an admin's, on a conversation with no running turn).
  const spare = await owner.call('conversationCreate', { ...team, project_id: projectId });
  await owner.call('conversationOpen', { ...team, session_id: spare.session.session_id });
  const del = await sentBy(seen, () => owner.call('conversationDelete', { ...team, session_id: spare.session.session_id }));
  assert.deepEqual(del.sent.map((c) => c.operation), ['control.acquire', 'sessions.delete'], JSON.stringify(del.answer));
  assert.deepEqual(del.sent[1].params, {});
  assert.equal(del.sent[1].session_id, spare.session.session_id);
  assert.equal(leased.expected_revision(del.sent[1].expected_revision), true);
  assert.equal(del.answer.ok, true, JSON.stringify(del.answer));
  // Row 169, the list's row menu: a rename of a conversation this client has not open reads its revision, borrows
  // the lease and hands it back; the host applies the title and the conversation is still not open here.
  const rowMade = await writer.call('conversationCreate', { ...team, project_id: projectId });
  const rowIds = { ...team, session_id: rowMade.session.session_id };
  const rowRenamed = await sentBy(seen, () => writer.call('conversationRename', { ...rowIds, title: 'From the list' }), ['sessions.snapshot']);
  assert.deepEqual(rowRenamed.sent.map((c) => c.operation), ['sessions.snapshot', 'control.acquire', 'sessions.rename', 'control.release'],
    JSON.stringify(rowRenamed.answer));
  assert.equal(rowRenamed.answer.ok, true, JSON.stringify(rowRenamed.answer));
  assert.equal((await writer.call('conversationSend', { ...rowIds, prompt: 'x' })).error.reason, 'team_conversation_not_open');
  const rowRead = await writer.call('conversationOpen', rowIds);
  assert.equal(rowRead.snapshot.session.title, 'From the list');
  assert.equal(rowRead.snapshot.control, null, 'the borrowed lease was handed back');
  // Row 169: the page before a message is the host's own paging, for an open conversation.
  const olderPage = await expectOne(writer, 'conversationOpen', { session_id: rowIds.session_id, before_message_id: 'msg_none' }, 'sessions.snapshot',
    { max_messages: 20, before_message_id: 'msg_none' }, { session_id: (value) => value === rowIds.session_id });
  assert.equal(olderPage.error.reason, 'message_cursor_unknown', 'the host answers a cursor it does not know; the conversation stays open');
  assert.equal((await writer.call('conversationOpen', rowIds)).ok, true);
  await writer.call('conversationClose', rowIds);
  // Closing a conversation that holds no lease sends nothing.
  const reopened = await writer.call('conversationCreate', { ...team, project_id: projectId });
  await writer.call('conversationOpen', { ...team, session_id: reopened.session.session_id });
  const closed = await sentBy(seen, () => writer.call('conversationClose', { ...team, session_id: reopened.session.session_id }));
  assert.deepEqual(closed, { answer: { ok: true }, sent: [] });
  await expectOne(f.outsider, 'projectUnjoined', {}, 'team.project.unjoined', {});
  await expectOne(f.outsider, 'projectJoin', { project_id: projectId, role: 'reader' }, 'team.project.join',
    { project_id: projectId, role: 'reader' });
  await expectOne(owner, 'projectRemoveMember', { project_id: projectId, member_id: f.reader.member.member_id },
    'team.project.members.remove', { project_id: projectId, member_id: f.reader.member.member_id });
  await expectOne(writer, 'projectLeave', { project_id: projectId }, 'team.project.leave', { project_id: projectId });
  const second = await owner.call('projectCreate', { ...team, name: 'Beacon' });
  await expectOne(owner, 'projectAddMember', { project_id: second.project_id, member_id: writer.member.member_id, role: 'reader' },
    'team.project.members.add', { project_id: second.project_id, member_id: writer.member.member_id, role: 'reader' });
  await expectOne(owner, 'projectCreate', { name: 'Comet' }, 'team.project.create', { name: 'Comet' });
  await expectOne(owner, 'projectDelete', { project_id: second.project_id }, 'team.project.delete', { project_id: second.project_id });
  // Slice 3-10: the rule methods and a decision's `always` (the owner is Atlas's admin).
  const added = await expectOne(owner, 'projectRuleAdd', { project_id: projectId, tool_name: 'edit_file', folder: 'posts' },
    'team.project.rules.add', { project_id: projectId, tool_name: 'edit_file', folder: 'posts' });
  assert.equal(added.ok, true, JSON.stringify(added));
  const rulesRead = await expectOne(owner, 'projectRules', { project_id: projectId }, 'team.project.rules.list', { project_id: projectId });
  assert.deepEqual(rulesRead.rules.map((rule) => [rule.rule_seq, rule.tool_name, rule.folder]), [[added.rule_seq, 'edit_file', 'posts']]);
  assert.equal(rulesRead.open_request_count, 0);
  await expectOne(owner, 'projectRuleAnswer', { project_id: projectId, request_seq: 9, outcome: 'decline', reason: 'Not now' },
    'team.project.rules.answer', { project_id: projectId, request_seq: 9, outcome: 'decline', reason: 'Not now' });
  const removed = await expectOne(owner, 'projectRuleRemove', { project_id: projectId, rule_seq: added.rule_seq },
    'team.project.rules.remove', { project_id: projectId, rule_seq: added.rule_seq });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  const always = { stream_id: 'stream_1', approval_id: 'approval_x', decision_revision: 'rev_1', approved: true, always: 'ask' };
  const tried = await expectOne(owner, 'conversationDecide', { session_id: sessionId, ...always }, 'approval.resolve', always,
    bySession);
  assert.equal(tried.ok, false, 'no approval waits: the host answers stale');
});

test('a bad payload is refused in main with zero host requests', async (t) => {
  const f = await projectTeam(t);
  const { teamId, projectId, seen, host } = f;
  const s = 'sess_00000000000000000000000000000000';
  const bad = [
    ['projectList', { team_id: teamId, extra: 1 }], ['projectList', null],
    ['projectCreate', { team_id: teamId, name: '' }], ['projectCreate', { team_id: teamId, name: 'x'.repeat(81) }],
    ['projectRename', { team_id: teamId, project_id: 'project_../x', name: 'A' }],
    ['projectDelete', { team_id: teamId, project_id: 42 }],
    ['projectAddMember', { team_id: teamId, project_id: projectId, member_id: 'member_x', role: 'owner' }],
    ['projectSetMember', { team_id: teamId, project_id: projectId, member_id: 'device_x', role: 'writer' }],
    ['projectJoin', { team_id: teamId, project_id: projectId }],
    ['projectAudit', { team_id: teamId, project_id: projectId, limit: 101 }],
    ['conversationCreate', { team_id: teamId, project_id: projectId, title: 'x'.repeat(81) }],
    ['conversationOpen', { team_id: teamId, session_id: '../etc' }],
    ['conversationSend', { team_id: teamId, session_id: s, prompt: 'x'.repeat(100_001) }],
    ['conversationSend', { team_id: teamId, session_id: s }],
    ['conversationControl', { team_id: teamId, session_id: s, action: 'steal' }],
    ['conversationDecide', { team_id: teamId, session_id: s, stream_id: 'stream_1', approval_id: 'a', decision_revision: 'r', approved: 'yes' }],
    ['conversationAnswer', { team_id: teamId, session_id: s, stream_id: 'stream_1', question_ref: 'q', answers: [1] }],
    ['uploadFolder', { team_id: teamId, project_id: projectId, path: 'C:\\x' }],
    ['downloadProject', { team_id: teamId, project_id: projectId, folder: '/tmp' }],
    ['uploadCancel', { team_id: teamId, project_id: projectId }],
    ['projectMembers', { team_id: teamId, project_id: 'project_bad id' }],
    ['projectRemoveMember', { team_id: teamId, project_id: projectId, member_id: 'device_x' }],
    ['projectLeave', { team_id: teamId, project_id: projectId, extra: true }],
    ['projectUnjoined', { team_id: 7 }],
    ['conversationClose', { team_id: teamId, session_id: 'sess_../x' }],
    ['conversationCloseAll', { team_id: teamId, session_id: s }],
    ['conversationOpen', { team_id: teamId, session_id: s, before_message_id: '' }],
    ['conversationCancel', { team_id: teamId, session_id: s, stream_id: 5 }],
    ['conversationRename', { team_id: teamId, session_id: s, title: '' }],
    ['conversationDelete', { team_id: teamId }],
    ['conversationDecline', { team_id: teamId, session_id: s, stream_id: 'stream_1', question_ref: 42 }],
    ['downloadCancel', { team_id: teamId, project_id: projectId, folder: 'x' }],
    ['projectConversations', { team_id: teamId, project_id: projectId, cursor: 'x' }],
    ['projectRules', { team_id: teamId, project_id: projectId, rule_seq: 1 }],
    ['projectRuleAdd', { team_id: teamId, project_id: projectId, tool_name: 'run_command', folder: null }],
    ['projectRuleRemove', { team_id: teamId, project_id: projectId, rule_seq: 0 }],
    ['projectRuleAnswer', { team_id: teamId, project_id: projectId, request_seq: 1, outcome: 'decline', reason: 'x'.repeat(201) }],
    ['conversationDecide', { team_id: teamId, session_id: s, stream_id: 'stream_1', approval_id: 'a', decision_revision: 'r', approved: false, always: 'ask' }],
    ['conversationPreferences', { team_id: teamId, session_id: s }], ['conversationPreferences', { team_id: teamId, session_id: s, team_tools: {} }],
  ];
  const methods = new Set(bad.map(([method]) => method));
  assert.deepEqual(PROJECT_METHODS.filter((method) => !methods.has(method)), [], 'every project method has a bad case');
  const before = seen.length;
  const logs = host.env.logs.length;
  for (const [method, payload] of bad) {
    const answer = await f.writer.call(method, payload);
    assert.equal(answer.ok, false, `${method} ${JSON.stringify(payload)}`);
    assert.equal(answer.error.code, 'invalid_request', method);
  }
  const unknown = await f.writer.call('projectList', { team_id: 'team_unknownTeamId123' });
  assert.equal(unknown.error.reason, 'team_not_found');
  await drained(f.writer, seen);
  assert.deepEqual(seen.slice(before).filter((c) => !BACKGROUND.has(c.operation)), []);
  assert.deepEqual(host.env.logs.slice(logs).filter((line) => line.event === 'team_command.answered'
    && !BACKGROUND.has(line.fields.operation)), []);
});

test('role boundaries hold through the client; rows carry roles and no host path', async (t) => {
  const f = await projectTeam(t);
  const { teamId, projectId } = f;
  const team = { team_id: teamId };
  const listed = await f.writer.call('projectList', team);
  assert.deepEqual(listed.projects.map((row) => [row.id, row.role]), [[projectId, 'writer']]);
  assert.equal(JSON.stringify(listed).includes('root_path'), false);
  assert.equal((await f.outsider.call('projectList', team)).projects.length, 0);
  // The creating owner's stored row is admin (team.project.create); the list reports the effective role (fix 2).
  assert.equal((await f.owner.call('projectList', team)).projects[0].role, 'admin');
  const refusedAdd = await f.writer.call('projectAddMember', { ...team, project_id: projectId,
    member_id: f.outsider.member.member_id, role: 'reader' });
  assert.equal(refusedAdd.ok, false);
  const created = await f.writer.call('conversationCreate', { ...team, project_id: projectId });
  const s = { ...team, session_id: created.session.session_id };
  assert.equal((await f.reader.call('conversationOpen', s)).ok, true, 'a reader reads');
  const readerSend = await f.reader.call('conversationSend', { ...s, prompt: 'hi' });
  assert.equal(readerSend.ok, false);
  assert.equal(readerSend.error.reason, 'team_project_read_only', JSON.stringify(readerSend));
  const outsiderOpen = await f.outsider.call('conversationOpen', s);
  assert.equal(outsiderOpen.ok, false);
  // A conversation in a project this member does not hold: a final refusal, never the retryable one.
  const outsiderCreate = await f.outsider.call('conversationCreate', { ...team, project_id: projectId });
  assert.equal(outsiderCreate.ok, false);
  assert.equal(outsiderCreate.error.retryable, undefined, JSON.stringify(outsiderCreate));
  const conversations = await f.outsider.call('projectConversations', { ...team, project_id: projectId });
  assert.deepEqual(conversations.error.reason, 'team_not_found');
});

test('the list is read again on a project change, a resync, a reconnect, a role change and a delete', async (t) => {
  const f = await projectTeam(t);
  const { teamId, projectId, writer, owner } = f;
  const team = { team_id: teamId };
  // Row 175: the list is kept from connect (no project call needed), so a new event stream reads it again and pushes it.
  await drained(owner, f.seen); // the owner's own re-reads after setup settle first
  const settled = f.seen.filter((c) => c.operation === 'projects.list').length;
  f.host.dropEventStreams(writer.member.device_id);
  await online(writer, teamId);
  assert.ok(await waitUntil(() => f.seen.filter((c) => c.operation === 'projects.list').length > settled), 'read with no project call');
  assert.ok(await waitUntil(() => Boolean(lastPush(writer, 'projects'))), 'and pushed');
  await writer.call('projectList', team);
  const named = (name) => () => lastPush(writer, 'projects')?.projects.some((row) => row.name === name);
  await owner.call('projectRename', { ...team, project_id: projectId, name: 'Renamed' });
  assert.ok(await waitUntil(named('Renamed')), 'team_project_changed re-reads');
  await owner.call('projectSetMember', { ...team, project_id: projectId, member_id: writer.member.member_id, role: 'reader' });
  assert.ok(await waitUntil(() => lastPush(writer, 'projects')?.projects[0]?.role === 'reader'), 'a role change re-reads');
  const reads = () => f.seen.filter((c) => c.operation === 'projects.list').length;
  let count = reads();
  // A new event stream opens with resync_required.
  f.host.dropEventStreams(writer.member.device_id);
  assert.ok(await waitUntil(() => reads() > count, { attempts: 300, interval: 20 }), 'a resync re-reads');
  count = reads();
  await f.host.restartHost();
  await online(writer, teamId);
  assert.ok(await waitUntil(() => reads() > count, { attempts: 300, interval: 20 }), 'a reconnect re-reads');
  const created = await owner.call('conversationCreate', { ...team, project_id: projectId });
  await writer.call('projectList', team);
  await writer.call('conversationOpen', { ...team, session_id: created.session.session_id });
  await owner.call('projectDelete', { ...team, project_id: projectId });
  assert.ok(await waitUntil(() => lastPush(writer, 'projects')?.projects.length === 0), 'a delete drops the project');
  assert.ok(lastPush(writer, 'closed', (p) => p.session_id === created.session.session_id), 'its open conversation closes');
  assert.equal(writer.service.projectResources().conversations, 0);
});

test('a read an event overtook is dropped and read again', async () => {
  const pending = [];
  const sent = [];
  const manager = { command: (operation) => new Promise((resolve) => { sent.push(operation); pending.push([operation, resolve]); }) };
  const answer = (operation, value) => {
    const at = pending.findIndex(([op]) => op === operation);
    assert.notEqual(at, -1, `no ${operation} pending`);
    pending.splice(at, 1)[0][1](value);
  };
  const pushes = [];
  const list = createProjectList({ manager, teamId: 'team_a', push: (p) => pushes.push(p) });
  const first = list.refresh();
  list.onEvent({ event_type: 'team_project_changed', project_id: 'project_aaaaaaaaaaaa', reason: 'renamed' });
  answer('projects.list', { ok: true, projects: [{ id: 'project_old', name: 'Old', root_revision: 1, role: 'writer' }], files_supported: false });
  await pause(5);
  assert.equal(pushes.length, 0, 'the overtaken answer is not shown');
  assert.equal(sent.filter((op) => op === 'projects.list').length, 2, 'read again');
  answer('projects.list', { ok: true, projects: [{ id: 'project_new', name: 'New', root_revision: 2, role: 'writer' }], files_supported: false });
  await pause(5);
  while (pending.some(([op]) => op === 'sessions.list')) answer('sessions.list', { ok: true, sessions: [] });
  await first;
  await pause(5);
  assert.equal(pushes.at(-1).projects[0].name, 'New');
  list.stop();
});

test('the conversation and lease flow: viewing, take over, refused heartbeat, not viewing, unattended', async (t) => {
  const f = await projectTeam(t);
  const { teamId, projectId, writer, owner } = f;
  const team = { team_id: teamId };
  const created = await writer.call('conversationCreate', { ...team, project_id: projectId });
  const sessionId = created.session.session_id;
  const s = { ...team, session_id: sessionId };
  await writer.call('conversationOpen', s);
  assert.ok(await waitUntil(() => lastPush(writer, 'viewers')?.viewers.includes(writer.member.member_id)), 'viewing at open');
  // A tick sends the viewing heartbeat; a send without the lease takes it first.
  const views = () => f.seen.filter((c) => c.operation === 'session.view').length;
  const v = views();
  writer.timers.tick();
  assert.ok(await waitUntil(() => views() > v));
  assert.equal((await writer.call('conversationSend', { ...s, prompt: 'go' })).ok, true);
  assert.equal(lastPush(writer, 'lease')?.held, true);
  // Another member's plain take is refused as it is, once.
  await owner.call('conversationOpen', s);
  const before = f.seen.length;
  const refused = await owner.call('conversationSend', { ...s, prompt: 'me too' });
  assert.equal(refused.error.reason, 'control_lease_unavailable');
  assert.equal(f.seen.slice(before).filter((c) => c.operation === 'control.acquire').length, 1, 'never looped');
  // A take over by the owner: the writer's lease ends on the control_changed naming someone else.
  assert.equal((await owner.call('conversationControl', { ...s, action: 'takeover' })).ok, true);
  assert.ok(await waitUntil(() => lastPush(writer, 'lease')?.held === false), 'lease dropped on control_changed');
  const forwarded = lastPush(writer, 'conversation_event', (p) => p.event_type === 'control_changed');
  assert.equal(forwarded.event.member_id, f.me.member_id);
  assert.equal(JSON.stringify(writer.pushes).includes('client_id'), false, 'no client id in a push');
  // A waiting approval in a turn the writer started: a writer whose device is not viewing is refused by the host.
  const backend = f.host.env.core.composition.backend;
  backend.approveToolCall = (key) => backend.pendingToolApprovals.delete(key); // as team-approvals-fixture.js
  await owner.call('conversationControl', { ...s, action: 'release' });
  backend.cancelChatStream(backend.sessionStore.peekActiveTurn(sessionId).stream_id);
  const now = new Date().toISOString();
  backend.sessionStore.appendMessage(sessionId, { id: 'message_turn', role: 'user', content: 'x',
    author: { kind: 'member', member_id: writer.member.member_id } });
  backend.sessionStore.setActiveTurn(sessionId, { request_id: 'stream_turn', stream_id: 'stream_turn',
    user_message_id: 'message_turn', started_at: now, last_event_at: now, status: 'awaiting_assistant' });
  const turn = backend.sessionStore.peekActiveTurn(sessionId);
  const approvalId = `approval_${sessionId}_call_1`;
  backend.pendingToolApprovals.set(approvalId, { approvalId, sessionId, streamId: turn.stream_id, callId: 'call_1',
    toolName: 'write_file', toolInput: { path: 'a.txt', content: 'x' }, messageId: 'message_tool', resolve: () => {} });
  backend.emit('chat-stream', { type: 'tool_approval_needed', sessionId, streamId: turn.stream_id, approvalId,
    callId: 'call_1', toolName: 'write_file', summary: 'Write a.txt' });
  const decisionRevision = f.host.env.core.router.snapshot(sessionId).pending_approvals
    .find((entry) => entry.approval_id === approvalId).decision_revision;
  await owner.call('projectAddMember', { ...team, project_id: projectId, member_id: f.outsider.member.member_id, role: 'writer' });
  const notViewing = await f.outsider.call('conversationDecide', { ...s, stream_id: turn.stream_id, approval_id: approvalId,
    decision_revision: decisionRevision, approved: true });
  assert.equal(notViewing.error.reason, 'approval_not_viewing', JSON.stringify(notViewing));
  // The viewing writer may decide; the forwarded decision_changed names the approver.
  const decided = await writer.call('conversationDecide', { ...s, stream_id: turn.stream_id, approval_id: approvalId,
    decision_revision: decisionRevision, approved: true });
  assert.equal(decided.ok, true, JSON.stringify(decided));
  assert.ok(await waitUntil(() => lastPush(writer, 'conversation_event', (p) => p.event_type === 'decision_changed'
    && p.event.approver_member_id === writer.member.member_id && p.event.approved === true)), 'approver forwarded');
  // An unattended approval is forwarded for an open conversation and counted on the list.
  await writer.call('projectList', team);
  f.host.publishEvent('approval_unattended', { session_id: sessionId, stream_id: 'stream_1', approval_id: 'approval_u',
    prompter_member_id: writer.member.member_id });
  assert.ok(await waitUntil(() => lastPush(writer, 'conversation_event', (p) => p.event_type === 'approval_unattended')));
  // The count change pushes that conversation's entry alone (fix 14).
  assert.ok(await waitUntil(() => lastPush(writer, 'activity', (p) => p.session_id === sessionId)?.approvals === 1));
});

test('a refused heartbeat ends the lease; at most eight conversations open per team', async (t) => {
  const f = await projectTeam(t);
  const { teamId, projectId, writer, owner } = f;
  const team = { team_id: teamId };
  const ids = [];
  for (let i = 0; i < CONVERSATION_LIMITS.MAX_OPEN + 1; i += 1) {
    ids.push((await owner.call('conversationCreate', { ...team, project_id: projectId })).session.session_id);
  }
  for (const id of ids.slice(0, CONVERSATION_LIMITS.MAX_OPEN)) assert.equal((await writer.call('conversationOpen', { ...team, session_id: id })).ok, true);
  assert.equal((await writer.call('conversationOpen', { ...team, session_id: ids.at(-1) })).error.reason, 'team_conversation_limit');
  // Fix list M4a: opening one already open answers a fresh snapshot and keeps the one entry.
  const again = await writer.call('conversationOpen', { ...team, session_id: ids[0] });
  assert.equal(again.snapshot.session.session_id, ids[0], JSON.stringify(again));
  assert.equal(writer.service.projectResources().conversations, CONVERSATION_LIMITS.MAX_OPEN);
  const s = { ...team, session_id: ids[0] };
  assert.equal((await writer.call('conversationControl', { ...s, action: 'take' })).ok, true);
  // The writer becomes a reader: the host drops its lease and sends no event; the next heartbeat is refused.
  await owner.call('projectSetMember', { ...team, project_id: projectId, member_id: writer.member.member_id, role: 'reader' });
  await drained(writer, f.seen);
  writer.timers.tick();
  assert.ok(await waitUntil(() => lastPush(writer, 'lease', (p) => p.session_id === ids[0])?.held === false), 'refused heartbeat');
  assert.equal(writer.service.projectResources().timers, CONVERSATION_LIMITS.MAX_OPEN, 'one viewing timer each, no lease timer');
});

test('fix list M4: after a reload with no close, opening again keeps one entry; close-all releases the lease and the view', async (t) => {
  const f = await projectTeam(t);
  const { teamId, projectId, writer, owner } = f;
  const team = { team_id: teamId };
  const s = { ...team, session_id: (await owner.call('conversationCreate', { ...team, project_id: projectId })).session.session_id };
  const counts = () => { const r = writer.service.projectResources(); return { conversations: r.conversations, timers: r.timers }; };
  assert.equal((await writer.call('conversationOpen', s)).ok, true);
  assert.equal((await writer.call('conversationControl', { ...s, action: 'take' })).ok, true);
  // The renderer reloads: nothing was closed. The new one opens it again.
  const again = await writer.call('conversationOpen', s);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.snapshot.session.session_id, s.session_id);
  assert.deepEqual(counts(), { conversations: 1, timers: 2 }, 'one entry: one view timer and the lease heartbeat');
  await drained(writer, f.seen);
  const closed = await sentBy(f.seen, () => writer.call('conversationCloseAll', team), ['control.release'], writer);
  assert.equal(closed.answer.ok, true);
  assert.equal(closed.sent.filter((command) => command.operation === 'control.release').length, 1, 'the held lease released');
  assert.deepEqual(counts(), { conversations: 0, timers: 0 }, 'no view heartbeat, no lease heartbeat');
  assert.equal((await owner.call('conversationOpen', s)).ok, true);
  assert.equal((await owner.call('conversationControl', { ...s, action: 'take' })).ok, true, 'the lease is free for another member');
});

test('nothing is left running after leave, revoke, drop and stopAll', async (t) => {
  const f = await projectTeam(t);
  const { teamId, projectId } = f;
  const team = { team_id: teamId };
  const created = await f.owner.call('conversationCreate', { ...team, project_id: projectId });
  const s = { ...team, session_id: created.session.session_id };
  for (const one of [f.writer, f.reader]) {
    await one.call('conversationOpen', s);
    assert.equal(one.service.projectResources().timers >= 1, true);
  }
  await f.writer.call('conversationControl', { ...s, action: 'take' });
  assert.deepEqual(f.writer.service.projectResources().timers, 2);
  // Leave: the team is gone from this Jenny.
  assert.equal((await f.writer.service.handle('leave', team)).ok, true);
  assert.ok(await waitUntil(() => lastPush(f.writer, 'team_gone')), 'leave drops the team');
  assert.deepEqual(f.writer.service.projectResources(), { teams: 0, conversations: 0, timers: 0, reads: 0, transfers: 0 });
  assert.equal(f.writer.timers.size(), 0);
  // Revoke: the owner revokes the reader.
  assert.equal((await f.owner.call('memberRevoke', { ...team, member_id: f.reader.member.member_id })).ok, true);
  assert.ok(await waitUntil(() => lastPush(f.reader, 'team_gone'), { attempts: 300, interval: 20 }), 'revoke drops the team');
  assert.deepEqual(f.reader.service.projectResources().timers, 0);
  assert.equal(f.reader.timers.size(), 0);
  // stopAll: the owner's open conversation ends with its timers.
  await f.owner.call('conversationOpen', s);
  await f.owner.service.stopAll();
  assert.deepEqual(f.owner.service.projectResources(), { teams: 0, conversations: 0, timers: 0, reads: 0, transfers: 0 });
  assert.equal(f.owner.timers.size(), 0);
});

test('a stale revision is answered as it is, one snapshot read takes the current one, nothing is resent', async () => {
  const sent = [];
  const snapshot = (rev) => ({ ok: true, snapshot: { cursor: 1, session: { session_id: 'sess_a', title: 'T', revision: rev,
    plan_mode: false }, messages: [], message_count: 0, has_more: false, active_turn: null, pending_approvals: [],
    pending_questions: [] } });
  let revision = 'boot:1';
  const manager = { command: async (operation, params, { envelope }) => {
    sent.push([operation, envelope.expected_revision ?? null]);
    if (operation === 'sessions.snapshot') return snapshot(revision);
    if (operation === 'control.acquire') return { ok: true, lease: { session_id: 'sess_a', client_id: 'c', generation: 1, expires_at: 1 } };
    if (operation === 'chat.send') {
      return envelope.expected_revision === revision ? { ok: true, revision }
        : { ok: false, error: { code: 'CMP-HOST-0004', reason: 'revision_conflict', retryable: true } };
    }
    return { ok: true, viewing: true, viewers: [] };
  } };
  const timers = fakeTimers();
  const conv = createProjectConversations({ manager, teamId: 'team_a', online: () => true, timers });
  assert.equal((await conv.call('conversationOpen', { session_id: 'sess_a' })).ok, true, 'opened');
  revision = 'boot:2';
  const refused = await conv.call('conversationSend', { session_id: 'sess_a', prompt: 'hi' });
  assert.deepEqual(refused, { ok: false, error: { code: 'CMP-HOST-0004', reason: 'revision_conflict', retryable: true } });
  assert.deepEqual(sent.filter(([op]) => op === 'chat.send'), [['chat.send', 'boot:1']], 'sent once');
  assert.equal((await conv.call('conversationSend', { session_id: 'sess_a', prompt: 'hi' })).ok, true, 'the next try lands');
  assert.deepEqual(sent.filter(([op]) => op === 'chat.send').at(-1), ['chat.send', 'boot:2']);
  conv.stop();
  assert.equal(timers.size(), 0);
});

// Owner report (team overview B3): a project's channel reaches its members' chat rows as soon as it exists, with no
// reconnect (the host announces it with team_chat_channel `created` to the channel's audience); a member outside the
// project receives no event (its chat client never resyncs for it) and holds no row.
test('a project created while chat runs is a chat row for its member at once; a member outside it gets nothing', async (t) => {
  const f = await projectTeam(t);
  const chat = await attachTeamChat(t, f.host);
  f.host.env.parts.chatStore = chat.store;
  const overviews = [];
  const chatHook = f.host.env.commandHook;
  f.host.env.commandHook = (command) => {
    if (command?.operation === 'team.chat.overview') overviews.push(f.host.env.context.clients.clients.get(command.client_id)?.deviceId);
    return chatHook(command);
  };
  const rows = async (one) => (await one.call('chatOverview', { team_id: f.teamId })).channels.map((row) => row.channel_id);
  for (const one of [f.owner, f.outsider]) assert.ok((await rows(one)).includes('chan_team'), `${one.name} chat loaded`);
  const readsBy = (one) => overviews.filter((deviceId) => deviceId === (one === f.owner ? f.me : one.member).device_id).length;
  // The setup's member changes resync the owner's chat once more, a second after its first load (the resync floor):
  // that resync must be over before the create, or it would bring the channel in by itself.
  for (let settled = false, i = 0; !settled && i < 5; i += 1) {
    const reads = readsBy(f.owner) + readsBy(f.outsider);
    await pause(1200);
    settled = readsBy(f.owner) + readsBy(f.outsider) === reads;
  }
  const before = { owner: readsBy(f.owner), outsider: readsBy(f.outsider) };
  const created = await f.owner.call('projectCreate', { team_id: f.teamId, name: 'Borealis' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const channelId = `chan_${created.project_id}`;
  let held = false;
  for (let i = 0; i < 150 && !held; i += 1) {
    held = (await rows(f.owner)).includes(channelId);
    if (!held) await pause(20);
  }
  assert.equal(held, true, 'the creator holds the project channel row without a reconnect');
  assert.ok(readsBy(f.owner) > before.owner, 'brought by the channel event: one overview resync');
  await pause(100);
  assert.equal((await rows(f.outsider)).includes(channelId), false, 'no row outside the project');
  assert.equal(readsBy(f.outsider), before.outsider, 'no channel event reached the member outside the project');
});
