'use strict';

// Slice 3-4b (docs/plans/TEAM_PROJECTS_SPEC.md "3-4b as built"): team.project.delete through the real
// router, store, directory, authorizer and folder module, with fakes for the application project
// service and the chat store; the router's own conversation delete for a project admin (the 3-3 limit).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createProjectDeleter } = require('../../server/team/team-project-delete');
const { TeamChatStore } = require('../../services/host/team-chat-store');
const { createTeamProjectFixture } = require('./helpers/team-project-fixture');

const projectEntries = (h, id) => h.store.audit.read({ limit: 100 }).entries.filter((entry) => entry.project_id === id);

// A project Alice made with Carl a writer and Rae a reader, two conversations and a file in its folder.
async function populated(h) {
  const id = await h.sharedProject();
  const conversations = [];
  for (const title of ['One', 'Two']) {
    conversations.push((await h.ok(h.send('carl', 'sessions.create', { title, project_id: id }))).session.session_id);
  }
  fs.writeFileSync(path.join(h.roots.projectsRoot, id, 'notes.txt'), 'x');
  fs.mkdirSync(path.join(h.roots.projectsRoot, id, 'sub'));
  fs.writeFileSync(path.join(h.roots.projectsRoot, id, 'sub', 'b.txt'), 'y');
  return { id, conversations };
}

// The fixture's deleter with the router's delete facade changed by `wrap` (a seam the router does not offer).
function deleterWith(h, wrap) {
  return createProjectDeleter({ store: h.store, folders: h.folders,
    router: () => ({ projectDeletes: wrap(h.core.router.projectDeletes) }), sessionStore: () => h.backend.sessionStore,
    records: () => h.state.remover, chat: () => h.state.chat, logger: h.fx.logger });
}
const asActor = (h, who) => ({ member_id: h.seats[who].member_id, owner: who === 'owner' });
const sessionsOf = (h, id) => h.backend.sessionStore.listSessions().filter((summary) => summary.project_id === id);

// Stopped part way: the row is `deleting`, and the reconcile finishes it.
async function stoppedThenFinished(h, id, answer, reason) {
  assert.equal(answer.error?.reason, reason);
  assert.equal(h.store.getProject(id).state, 'deleting');
  const counts = await h.reconcile();
  assert.equal(counts.finished, 1);
  assert.equal(h.store.getProject(id), null);
  assert.equal(h.state.app.records.has(id), false);
  assert.deepEqual(sessionsOf(h, id), []);
  assert.equal(fs.readdirSync(h.roots.projectsRoot).includes(id), false);
}

// Everything a delete may touch, to compare before and after a refusal.
function state(h, id) {
  return JSON.stringify({ row: h.store.getProject(id), record: h.state.app.records.get(id) ?? null,
    sessions: h.backend.sessionStore.listSessions().map((summary) => summary.id).sort(),
    folder: fs.readdirSync(h.roots.projectsRoot).sort(), trash: fs.readdirSync(h.roots.trashRoot).sort(),
    channels: [...h.state.chat.channels].sort(), audit: h.store.audit.read({ limit: 100 }).entries.length });
}

test('a project admin deletes: conversations, folder, channel, record and row go, in the spec order', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true, clock: () => Date.UTC(2026, 10, 12, 9, 30) });
  const { id, conversations } = await populated(h);
  const streams = Object.fromEntries(['alice', 'carl', 'rae', 'bob', 'owner'].map((who) => [who, h.attach(who)]));
  const deleted = await h.ok(h.send('alice', 'team.project.delete', { project_id: id }));
  assert.deepEqual([deleted.project_id, deleted.deleted], [id, true]);
  assert.equal(JSON.stringify(deleted).includes(h.roots.projectsRoot), false, 'no path in the answer');
  for (const who of ['alice', 'carl', 'owner']) assert.equal((await h.listed(who)).includes(id), false, who);
  assert.deepEqual(h.backend.sessionStore.listSessions().filter((summary) => summary.project_id === id), []);
  const heardDeleted = (who, sessionId) => streams[who].frames.some((frame) => frame.includes(sessionId)
    && frame.includes('"deleted"'));
  for (const sessionId of conversations) {
    // Departure (3-4b as built): the row is `deleting` before the conversations go, and the stream's
    // project-bucket check lets only the owner read a deleting project, so only the owner gets these
    // frames; the members are told by team_project_changed (deleting, deleted) below.
    assert.deepEqual(['alice', 'carl', 'rae', 'bob', 'owner'].map((who) => heardDeleted(who, sessionId)),
      [false, false, false, false, true], 'session_changed goes to the audience of the deleting project');
  }
  assert.deepEqual(fs.readdirSync(h.roots.projectsRoot), []);
  assert.deepEqual(fs.readdirSync(h.roots.trashRoot), [`${id}-20261112093000000`]);
  assert.equal(fs.readFileSync(path.join(h.roots.trashRoot, `${id}-20261112093000000`, 'notes.txt'), 'utf8'), 'x');
  // E67 (owner, 2026-11-14): the channel is removed, not archived.
  assert.deepEqual([[...h.state.chat.removed], [...h.state.chat.archived]], [[`chan_${id}`], []]);
  assert.equal(h.state.chat.channels.has(`chan_${id}`), false);
  assert.equal(h.state.app.records.has(id), false);
  assert.equal(h.store.getProject(id), null);
  const kinds = projectEntries(h, id).map((entry) => [entry.kind, entry.detail, entry.actor_member_id]);
  assert.deepEqual(kinds.slice(-2), [['project_deleting', 'conversations=2,files=2', h.seats.alice.member_id],
    ['project_deleted', 'members=3', h.seats.alice.member_id]]);
  for (const who of ['carl', 'rae', 'owner']) {
    assert.deepEqual(h.projectFrames(streams[who]).map((frame) => frame.reason), ['deleting', 'deleted'], who);
  }
  assert.deepEqual(h.projectFrames(streams.bob), []);
  const text = h.logText();
  for (const secret of ['Apollo', 'Olive', 'Alice', h.roots.projectsRoot, h.roots.trashRoot, 'notes.txt']) {
    assert.equal(text.includes(secret), false, `no ${secret} in a log line`);
  }
});

test('the team owner deletes a record with no team row (a create that stopped), and no one else may', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true });
  const made = h.state.app.createProject({ name: 'Stranded' });
  const id = made.project.id;
  const refused = {};
  for (const who of ['alice', 'bob', 'rae', 'pia']) refused[who] = await h.reason(h.send(who, 'team.project.delete', { project_id: id }));
  assert.deepEqual(refused, { alice: 'team_not_found', bob: 'team_not_found', rae: 'role_forbidden', pia: 'member_pending' });
  assert.equal(h.state.app.records.has(id), true);
  await h.ok(h.send('owner', 'team.project.delete', { project_id: id }));
  assert.equal(h.state.app.records.has(id), false);
  assert.equal(await h.reason(h.send('owner', 'team.project.delete', { project_id: id })), 'team_not_found',
    'gone now: reads like a project that never existed');
});

test('a writer, a reader, an outsider, a pending or removed member and a missing actor change nothing', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true });
  const { id } = await populated(h);
  await h.ok(h.send('alice', 'team.project.members.add', { project_id: id, member_id: h.seats.bob.member_id,
    role: 'reader' }));
  await h.ok(h.send('alice', 'team.project.members.remove', { project_id: id, member_id: h.seats.bob.member_id }));
  const before = state(h, id);
  const refused = {};
  for (const who of ['carl', 'rae', 'bob', 'pia']) refused[who] = await h.reason(h.send(who, 'team.project.delete', { project_id: id }));
  assert.deepEqual(refused, { carl: 'role_forbidden', rae: 'role_forbidden', bob: 'team_not_found', pia: 'member_pending' });
  // A forged id the caller cannot see answers as one that does not exist; General is never deleted.
  assert.equal(await h.reason(h.send('carl', 'team.project.delete', { project_id: 'project_missing' })), 'team_not_found');
  assert.equal(await h.reason(h.send('owner', 'team.project.delete', { project_id: 'project_general' })), 'team_not_found');
  // The handler with no live actor behind the call: the router never reaches it, the command refuses.
  const noActor = await h.core.router.dispatch({ api_version: 1, operation: 'team.project.delete', request_id: 'request_x',
    client_id: 'client_none', boot_epoch: h.core.bootEpoch, params: { project_id: id } }, { deviceId: 'device_none',
    clientToken: 'none', isAuthenticated: () => true });
  assert.equal(noActor.error.reason, 'client_unauthorized');
  assert.equal(state(h, id), before);
});

test('a running turn in any conversation refuses the delete and nothing changes', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true });
  const { id, conversations } = await populated(h);
  h.backend.sessionTurnActors = { hasActiveLifecycle: (sessionId) => sessionId === conversations[1] };
  const before = state(h, id);
  const answer = await h.send('alice', 'team.project.delete', { project_id: id });
  assert.equal(answer.error.reason, 'team_project_busy');
  assert.equal(answer.error.code, 'CMP-HOST-0004');
  assert.equal(state(h, id), before);
  delete h.backend.sessionTurnActors;
  await h.ok(h.send('alice', 'team.project.delete', { project_id: id }));
});

test('a host with no projects root deletes with no folder step', async (t) => {
  const h = await createTeamProjectFixture(t);
  const id = await h.sharedProject();
  assert.equal(h.state.app.records.get(id).root_path, null);
  await h.ok(h.send('alice', 'team.project.delete', { project_id: id }));
  assert.deepEqual(projectEntries(h, id).map((entry) => entry.detail).slice(-2), ['conversations=0,files=0', 'members=3']);
  assert.equal(h.state.app.records.has(id), false);
});

test('a step that fails stops the delete with the row deleting; the reconcile finishes it', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true });
  const { id } = await populated(h);
  h.state.remover.removeFail = true;
  assert.equal(await h.reason(h.send('alice', 'team.project.delete', { project_id: id })), 'team_project_store_failed');
  assert.equal(h.store.getProject(id).state, 'deleting');
  assert.equal(fs.readdirSync(h.roots.trashRoot).length, 1, 'the steps before it stay done');
  assert.equal(h.fx.logs.filter((entry) => entry.event === 'team_project.delete_stopped').length, 1);
  assert.equal(await h.reason(h.send('alice', 'team.project.delete', { project_id: id })), 'team_not_found',
    'a deleting project is the owner\'s to read and the reconcile\'s to finish');
  h.state.remover.removeFail = false;
  const counts = await h.reconcile();
  assert.equal(counts.finished, 1);
  assert.equal(h.store.getProject(id), null);
  assert.equal(h.state.app.records.has(id), false);
});

test('3-3 limit: a project admin who is not the owner deletes a project conversation through the router', async (t) => {
  const h = await createTeamProjectFixture(t);
  const id = await h.sharedProject();
  const sessionId = (await h.ok(h.send('carl', 'sessions.create', { title: 'Mine', project_id: id }))).session.session_id;
  const carl = h.attach('carl');
  const lease = await h.ok(h.send('alice', 'control.acquire', {}, { session_id: sessionId }));
  const snapshot = h.core.router.snapshot(sessionId);
  const deleted = await h.ok(h.send('alice', 'sessions.delete', {}, { session_id: sessionId,
    control_generation: lease.lease.generation, expected_revision: snapshot.session.revision }));
  assert.equal(deleted.deleted, true);
  assert.equal(carl.frames.some((frame) => frame.includes(sessionId) && frame.includes('"deleted"')), true);
});

test('a conversation moved to another project is announced to the old project\'s members too', async (t) => {
  const h = await createTeamProjectFixture(t);
  const from = await h.sharedProject('From');
  const to = (await h.ok(h.send('alice', 'team.project.create', { name: 'To' }))).project_id;
  const sessionId = (await h.ok(h.send('alice', 'sessions.create', { title: 'Moving', project_id: from }))).session.session_id;
  h.backend.projectApplicationService = h.state.app;
  h.state.app.assignSessionProject = ({ session_id: id, project_id: projectId }) => ({ ok: true,
    session: h.backend.sessionStore.updateSession(id, { project_id: projectId }) });
  const carl = h.attach('carl');
  const lease = await h.ok(h.send('alice', 'control.acquire', {}, { session_id: sessionId }));
  const moved = await h.send('alice', 'projects.assignSession', { project_id: to }, { session_id: sessionId,
    control_generation: lease.lease.generation, expected_revision: h.core.router.snapshot(sessionId).session.revision });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(carl.frames.some((frame) => frame.includes(sessionId) && frame.includes('project_assigned')), true,
    'Carl is in the old project only and still hears that it left');
});

test('owner any: the team owner deletes an active project they never joined; its admin of another project may not', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true });
  const { id } = await populated(h);
  const other = (await h.ok(h.send('bob', 'team.project.create', { name: 'Other' }))).project_id;
  assert.equal(await h.reason(h.send('bob', 'team.project.delete', { project_id: id })), 'team_not_found',
    'the admin of another project');
  assert.equal(h.store.directory.projectRole(h.seats.owner.member_id, id), null, 'the owner holds no row');
  await h.ok(h.send('owner', 'team.project.delete', { project_id: id }));
  assert.equal(h.store.getProject(id), null);
  const entries = projectEntries(h, id).slice(-2).map((entry) => [entry.kind, entry.actor_member_id]);
  assert.deepEqual(entries, [['project_deleting', h.seats.owner.member_id], ['project_deleted', h.seats.owner.member_id]]);
  assert.equal(await h.reason(h.send('owner', 'team.project.rename', { project_id: other, name: 'X' })), 'team_not_found',
    'owner any reaches no other operation');
});

test('the real ProjectApplicationService and ProjectService: a delete and a stranded record removal finish', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true, realProjects: true });
  const records = () => h.state.app.listProjects().projects.map((record) => record.id);
  const id = (await h.ok(h.send('alice', 'team.project.create', { name: 'Real' }))).project_id;
  assert.equal(records().includes(id), true);
  await h.ok(h.send('alice', 'team.project.delete', { project_id: id }));
  assert.equal(records().includes(id), false);
  assert.equal(h.store.getProject(id), null);
  const stranded = h.state.app.createProject({ name: 'Stranded' }).project.id;
  const counts = await h.reconcile();
  assert.deepEqual([counts.records, counts.failed], [1, 0]);
  assert.equal(records().includes(stranded), false);
  assert.equal(records().includes('project_general'), true, 'General is never touched');
});

test('a turn that starts after the pre-check stops the delete at that conversation', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true });
  const { id, conversations } = await populated(h);
  const sessions = h.backend.sessionStore;
  const real = sessions.getActiveTurn.bind(sessions);
  // The index-only pre-check sees no turn; the router's own check inside the queue does.
  sessions.getActiveTurn = (sessionId) => (sessionId === conversations[1] ? { stream_id: 'stream_late' } : real(sessionId));
  const answer = await h.send('alice', 'team.project.delete', { project_id: id });
  assert.equal(sessionsOf(h, id).some((summary) => summary.id === conversations[1]), true);
  assert.equal(fs.readdirSync(h.roots.projectsRoot).includes(id), true, 'nothing after the stop ran');
  delete sessions.getActiveTurn;
  await stoppedThenFinished(h, id, answer, 'team_project_busy');
});

test('a conversation delete that answers not deleted stops the delete', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true });
  const { id, conversations } = await populated(h);
  const real = h.backend.deleteSession.bind(h.backend);
  h.backend.deleteSession = async (sessionId) => (sessionId === conversations[0] ? { deleted: false } : real(sessionId));
  const answer = await h.send('alice', 'team.project.delete', { project_id: id });
  assert.equal(h.state.app.records.has(id), true);
  delete h.backend.deleteSession;
  await stoppedThenFinished(h, id, answer, 'team_project_store_failed');
});

test('a trash step that refuses stops the delete after the conversations', async (t) => {
  const clock = { now: Date.UTC(2026, 10, 12, 9, 30) };
  const h = await createTeamProjectFixture(t, { projectsRoot: true, clock: () => clock.now });
  const { id } = await populated(h);
  fs.mkdirSync(path.join(h.roots.trashRoot, `${id}-20261112093000000`));
  const answer = await h.send('alice', 'team.project.delete', { project_id: id });
  assert.deepEqual(sessionsOf(h, id), []);
  assert.equal(fs.readdirSync(h.roots.projectsRoot).includes(id), true);
  clock.now += 1;
  await stoppedThenFinished(h, id, answer, 'team_project_root_unavailable');
});

test('a folder that cannot be counted, or is past the cap, never blocks the delete; the audit says so', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true, countCaps: { files: 1 } });
  const unknown = await h.sharedProject('Unknown');
  // A file where the folder should be: no count can be made, and the trash still moves it.
  fs.rmdirSync(path.join(h.roots.projectsRoot, unknown));
  fs.writeFileSync(path.join(h.roots.projectsRoot, unknown), 'f');
  await h.ok(h.send('alice', 'team.project.delete', { project_id: unknown }));
  const { id: capped } = await populated(h);
  await h.ok(h.send('alice', 'team.project.delete', { project_id: capped }));
  const details = (id) => projectEntries(h, id).filter((entry) => entry.kind === 'project_deleting').map((entry) => entry.detail);
  assert.deepEqual([details(unknown), details(capped)], [['conversations=0,files=unknown'], ['conversations=2,files_at_least=1']]);
  assert.deepEqual(fs.readdirSync(h.roots.projectsRoot), []);
});

test('a read-only record store, refused disk admission, an unusable trash or a non-owner on a record with no row change nothing', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true });
  const { id } = await populated(h);
  const before = state(h, id);
  h.state.app.readOnly = true;
  assert.equal(await h.reason(h.send('alice', 'team.project.delete', { project_id: id })), 'team_project_store_failed');
  h.state.app.readOnly = false;
  const refusedDisk = await deleterWith(h, (deletes) => ({ ...deletes, admit: () => false }))
    .run({ projectId: id, actor: asActor(h, 'alice') }, h.state.app);
  assert.equal(refusedDisk.error.reason, 'disk_pressure');
  fs.renameSync(h.roots.trashRoot, h.roots.trashRoot + '-away');
  assert.equal(await h.reason(h.send('alice', 'team.project.delete', { project_id: id })), 'team_project_root_unavailable');
  fs.renameSync(h.roots.trashRoot + '-away', h.roots.trashRoot);
  assert.equal(state(h, id), before);
  const stranded = h.state.app.createProject({ name: 'Stranded' }).project.id;
  const plain = deleterWith(h, (deletes) => deletes);
  assert.equal((await plain.run({ projectId: stranded, actor: asActor(h, 'alice') }, h.state.app)).error.reason, 'team_not_found');
  assert.equal(h.state.app.records.has(stranded), true);
  await h.ok(h.send('alice', 'team.project.delete', { project_id: id }));
  await h.ok(h.send('owner', 'team.project.delete', { project_id: stranded }));
});

test('an actor revoked between the mark and the last step: the host removes the row and the delete answers ok', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true });
  const { id } = await populated(h);
  let revoked = false;
  const revoking = deleterWith(h, (deletes) => ({ ...deletes, remove: async (sessionId) => {
    if (!revoked) {
      revoked = true;
      const done = await h.store.revokeMember({ actorMemberId: h.seats.owner.member_id, memberId: h.seats.alice.member_id });
      assert.equal(done.ok, true);
    }
    return deletes.remove(sessionId);
  } }));
  const answer = await revoking.run({ projectId: id, actor: asActor(h, 'alice') }, h.state.app);
  assert.deepEqual([answer.ok, answer.deleted], [true, true]);
  assert.equal(h.store.getProject(id), null);
  assert.equal(h.state.app.records.has(id), false);
  const entries = projectEntries(h, id).filter((entry) => ['project_deleting', 'project_deleted', 'project_reconciled']
    .includes(entry.kind)).map((entry) => [entry.kind, entry.detail, entry.actor_member_id]);
  assert.deepEqual(entries, [['project_deleting', 'conversations=2,files=2', h.seats.alice.member_id],
    ['project_reconciled', 'step=removed', null]]);
  assert.equal(h.fx.logs.filter((entry) => entry.event === 'team_project.delete_finished_by_host').length, 1);
});

test('H19: a conversation created while the mark is awaited is deleted with the others, not orphaned', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true });
  const { id } = await populated(h);
  let late = null;
  const store = new Proxy(h.store, { get: (target, key) => {
    if (key === 'markProjectDeleting') {
      return async (input) => {
        const marked = await target.markProjectDeleting(input);
        late = h.backend.sessionStore.createSession({ title: 'Late', projectId: id }).id;
        return marked;
      };
    }
    return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
  } });
  const deleter = createProjectDeleter({ store, folders: h.folders, router: () => h.core.router,
    sessionStore: () => h.backend.sessionStore, records: () => h.state.remover, chat: () => h.state.chat, logger: h.fx.logger });
  const answer = await deleter.run({ projectId: id, actor: asActor(h, 'alice') }, h.state.app);
  assert.deepEqual([answer.ok, answer.deleted], [true, true], JSON.stringify(answer));
  assert.equal(typeof late, 'string', 'the late conversation was made');
  assert.deepEqual(sessionsOf(h, id), [], 'no conversation of the deleted project is left');
  assert.equal(h.backend.sessionStore.getSession(late), null);
});

test('E67: with the real chat store a deleted project\'s channel, messages, attachments and index row leave the host', async (t) => {
  const h = await createTeamProjectFixture(t);
  const profileDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-e67-delete-')));
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  const chatDir = path.join(profileDir, 'team-chat');
  const chat = new TeamChatStore({ profileDir, logger: h.fx.logger });
  assert.equal(chat.open().ok, true);
  assert.equal((await chat.createChannel({ channelId: 'chan_team' })).ok, true);
  h.state.chat = chat;
  const carl = h.attach('carl');
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const id = await h.sharedProject(`Apollo ${cycle}`);
    const channelId = `chan_${id}`;
    const author = { channelId, actorId: h.seats.carl.member_id, deviceId: h.seats.carl.device_id };
    const staged = await chat.stageAttachment({ channelId, memberId: author.actorId, name: 'a.txt', mime: 'text/plain',
      bytes: Buffer.from(`bytes ${cycle}`) });
    assert.equal(staged.ok, true, JSON.stringify(staged));
    const posted = await chat.post({ ...author, requestId: `req_${cycle}`, text: 'hello', attachmentIds: [staged.attachment.id] });
    assert.equal(posted.ok, true, JSON.stringify(posted));
    assert.equal((await chat.markRead({ channelId, actorId: author.actorId, seq: 1 })).ok, true);
    assert.equal(fs.existsSync(path.join(chatDir, 'blobs', channelId, staged.attachment.id)), true);
    await h.ok(h.send('alice', 'team.project.delete', { project_id: id }));
    assert.deepEqual(chat.listChannels().channels.map((info) => info.channel_id), ['chan_team'], `cycle ${cycle}`);
    for (const where of [channelId, path.join('blobs', channelId)]) {
      assert.equal(fs.existsSync(path.join(chatDir, where)), false, where);
    }
    assert.equal(chat.channelHeader(channelId).error.reason, 'team_chat_not_found');
  }
  const index = JSON.parse(fs.readFileSync(path.join(chatDir, 'index.json'), 'utf8'));
  assert.deepEqual(index.channels.map((entry) => entry.channel_id), ['chan_team']);
  assert.equal(chat.totalBytes(), 0, 'no byte of a removed channel is still counted');
  // Members who were viewing it hear the existing gone event, once per project.
  const gone = h.projectFrames(carl).map((frame) => frame.reason).filter((reason) => reason === 'deleting' || reason === 'deleted');
  assert.deepEqual(gone, ['deleting', 'deleted', 'deleting', 'deleted', 'deleting', 'deleted']);
});

test('row 151 T1: a deleted project\'s boards go with it; a board removal that fails stops at `boards` and the reconcile finishes', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true, boards: true });
  const boardsRoot = path.join(fs.realpathSync.native(h.config.userDataPath), 'team-boards');
  const withBoard = async (name) => {
    const id = await h.sharedProject(name);
    const made = await h.state.boards.create({ projectId: id, actor: h.seats.alice.member_id, name: 'Plan' });
    assert.equal(made.ok, true, JSON.stringify(made));
    fs.mkdirSync(path.join(boardsRoot, id, 'assets'));
    fs.writeFileSync(path.join(boardsRoot, id, 'assets', 'a.png'), 'png');
    return id;
  };
  const id = await withBoard('Apollo');
  await h.ok(h.send('alice', 'team.project.delete', { project_id: id }));
  assert.equal(fs.existsSync(path.join(boardsRoot, id)), false, 'boards, journals, proposals and assets go at once');
  assert.equal(h.store.getProject(id), null);

  const real = h.state.boards;
  const unavailable = { ok: false, error: { code: 'CMP-HOST-0005', reason: 'team_board_unavailable', retryable: true } };
  for (const [what, replacement] of [['a refused removal', { ...real, removeProject: async () => unavailable }],
    ['no board store behind the dependency', null]]) {
    const other = await withBoard(`Second ${what}`);
    h.state.boards = replacement;
    const answer = await h.send('alice', 'team.project.delete', { project_id: other });
    assert.equal(answer.error?.reason, 'team_board_unavailable', what);
    assert.equal(h.store.getProject(other).state, 'deleting', what);
    assert.equal(fs.existsSync(path.join(boardsRoot, other)), true, what);
    assert.equal(h.state.chat.channels.has(`chan_${other}`), true, `${what}: the steps after it did not run`);
    const stopped = h.fx.logs.filter((entry) => entry.event === 'team_project.delete_stopped').at(-1);
    assert.deepEqual([stopped.fields.step, stopped.fields.reason], ['boards', 'team_board_unavailable']);
    h.state.boards = real;
    const counts = await h.reconcile();
    assert.equal(counts.finished, 1, what);
    assert.equal(h.store.getProject(other), null);
    assert.equal(fs.existsSync(path.join(boardsRoot, other)), false);
  }
});
