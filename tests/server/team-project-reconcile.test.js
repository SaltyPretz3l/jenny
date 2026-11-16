'use strict';

// Slice 3-4b (docs/plans/TEAM_PROJECTS_SPEC.md "3-4b as built"): the start-up reconcile. Each test
// stops a create or a delete between two of its steps (by running the steps before the stop by hand),
// then runs the reconcile as team-main.js does: the state ends where the decision says, each repair
// wrote one `project_reconciled` entry, and a second reconcile changes nothing.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { TeamChatStore } = require('../../services/host/team-chat-store');
const { createTeamProjectFixture } = require('./helpers/team-project-fixture');

const reconciled = (h) => h.store.audit.read({ limit: 100 }).entries.filter((entry) => entry.kind === 'project_reconciled')
  .map((entry) => [entry.project_id, entry.detail, entry.actor_member_id]);

function snapshot(h) {
  return JSON.stringify({ rows: h.store.snapshot().projects, records: [...h.state.app.records.values()],
    channels: [...h.state.chat.channels].sort(), removed: [...h.state.chat.removed].sort(),
    folders: fs.readdirSync(h.roots.projectsRoot).sort(), trash: fs.readdirSync(h.roots.trashRoot).sort(),
    sessions: h.backend.sessionStore.listSessions().map((summary) => summary.id).sort(),
    audit: h.store.audit.read({ limit: 100 }).entries.length });
}

// Runs the reconcile twice: the second changes nothing and writes nothing.
async function settle(h) {
  const first = await h.reconcile();
  const after = snapshot(h);
  await h.reconcile();
  assert.equal(snapshot(h), after, 'a second reconcile changes nothing');
  return first;
}

const alice = (h) => ({ actorMemberId: h.seats.alice.member_id });
const record = (h, name = 'Crash') => h.state.app.createProject({ name }).project.id;
const folderOf = (h, id) => path.join(h.roots.projectsRoot, id);

test('create stopped after the record, after the folder and after the bind: the record goes, the empty folder to trash', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true });
  const onlyRecord = record(h);
  const withFolder = record(h);
  assert.equal(h.folders.create(withFolder).ok, true);
  const bound = record(h);
  const made = h.folders.create(bound);
  h.state.app.bindProjectRoot({ project_id: bound, root_path: made.path, expected_root_revision: 0 });
  const counts = await settle(h);
  assert.equal(counts.records, 3);
  assert.equal(h.state.app.records.size, 0);
  assert.deepEqual(fs.readdirSync(h.roots.projectsRoot), []);
  assert.deepEqual(fs.readdirSync(h.roots.trashRoot).map((name) => name.split('-')[0]).sort(), [bound, withFolder].sort());
  assert.deepEqual(reconciled(h).map(([id, detail]) => [id, detail]).sort(),
    [[onlyRecord, 'step=record'], [withFolder, 'step=record'], [bound, 'step=record']].sort());
  assert.ok(reconciled(h).every(([, , actor]) => actor === null), 'the host is the actor');
});

test('create stopped after the team row: the channel is made; a row with no root gets its folder made or found, and bound', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true });
  const noChannel = record(h);
  await h.store.createProject({ ...alice(h), projectId: noChannel });
  const created = h.folders.create(noChannel);
  h.state.app.bindProjectRoot({ project_id: noChannel, root_path: created.path, expected_root_revision: 0 });
  const noFolder = record(h);
  await h.store.createProject({ ...alice(h), projectId: noFolder });
  h.state.chat.channels.add(`chan_${noFolder}`);
  const unbound = record(h);
  await h.store.createProject({ ...alice(h), projectId: unbound });
  h.state.chat.channels.add(`chan_${unbound}`);
  h.folders.create(unbound);
  const counts = await settle(h);
  assert.deepEqual([counts.channels, counts.folders, counts.failed], [1, 2, 0]);
  assert.equal(h.state.chat.channels.has(`chan_${noChannel}`), true);
  for (const id of [noFolder, unbound]) {
    assert.equal(h.state.app.records.get(id).root_path, fs.realpathSync.native(folderOf(h, id)));
    assert.equal(h.state.app.records.get(id).root_revision, 1);
  }
  assert.deepEqual(reconciled(h).map(([id, detail]) => [id, detail]).sort(),
    [[noChannel, 'step=channel'], [noFolder, 'step=folder'], [unbound, 'step=folder']].sort());
});

test('a create whose folder or bind failed answers folder: false and the next start binds it', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true });
  h.state.app.bindFail = true;
  const refusedBind = await h.ok(h.send('alice', 'team.project.create', { name: 'Bind Refused' }));
  h.state.app.bindFail = false;
  fs.renameSync(h.roots.projectsRoot, `${h.roots.projectsRoot}-away`);
  const noRoot = await h.ok(h.send('alice', 'team.project.create', { name: 'Root Away' }));
  fs.renameSync(`${h.roots.projectsRoot}-away`, h.roots.projectsRoot);
  assert.deepEqual([refusedBind.folder, noRoot.folder], [false, false]);
  const lines = h.fx.logs.filter((entry) => entry.event === 'team_project.folder_failed');
  assert.deepEqual(lines.map((entry) => entry.fields.reason), ['project_store_failed', 'team_project_root_unavailable']);
  assert.equal(JSON.stringify(lines).includes(h.roots.projectsRoot), false);
  const counts = await settle(h);
  assert.equal(counts.folders, 2);
  for (const answer of [refusedBind, noRoot]) assert.notEqual(h.state.app.records.get(answer.project_id).root_path, null);
});

test('delete stopped after each step: the reconcile finishes it from there', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true });
  const stops = ['marked', 'conversations', 'folder', 'channel', 'record'];
  const ids = {};
  for (const stop of stops) {
    const id = await h.sharedProject(`Stop ${stop}`);
    await h.ok(h.send('carl', 'sessions.create', { title: 'C', project_id: id }));
    ids[stop] = id;
    await h.store.markProjectDeleting({ ...alice(h), projectId: id, counts: { conversations: 1, files: 0 } });
    if (stop === 'marked') continue;
    for (const summary of h.backend.sessionStore.listSessions().filter((entry) => entry.project_id === id)) {
      await h.core.router.projectDeletes.remove(summary.id);
    }
    if (stop === 'conversations') continue;
    h.folders.trash(id);
    if (stop === 'folder') continue;
    await h.state.chat.removeChannel({ channelId: `chan_${id}` });
    if (stop === 'channel') continue;
    h.state.remover.remove(id);
  }
  const counts = await settle(h);
  assert.equal(counts.finished, stops.length);
  assert.deepEqual(h.store.snapshot().projects, []);
  assert.equal(h.state.app.records.size, 0);
  assert.deepEqual(h.backend.sessionStore.listSessions(), []);
  assert.deepEqual(fs.readdirSync(h.roots.projectsRoot), []);
  assert.equal(fs.readdirSync(h.roots.trashRoot).length, stops.length);
  // E67: every project's channel is removed (a second removal of one already gone is ok), none archived.
  assert.deepEqual([h.state.chat.removed.size, h.state.chat.archived.size], [stops.length, 0]);
  assert.equal(Object.values(ids).some((id) => h.state.chat.channels.has(`chan_${id}`)), false);
  assert.deepEqual(reconciled(h).map(([id, detail]) => [id, detail]).sort(),
    Object.values(ids).map((id) => [id, 'step=removed']).sort());
});

test('cases 5 and 6 never remove a folder that holds a file or a record that holds a conversation', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true });
  const withFile = record(h);
  h.folders.create(withFile);
  fs.writeFileSync(path.join(folderOf(h, withFile), 'keep.txt'), 'k');
  const withConversation = record(h);
  await h.ok(h.send('owner', 'sessions.create', { title: 'Owner', project_id: withConversation }));
  fs.mkdirSync(folderOf(h, 'project_nobody'));
  fs.writeFileSync(path.join(folderOf(h, 'project_nobody'), 'stray.txt'), 's');
  fs.mkdirSync(folderOf(h, 'project_emptyorphan'));
  const counts = await settle(h);
  assert.deepEqual([counts.records, counts.records_kept, counts.orphan_folders], [0, 2, 2]);
  assert.equal(h.state.app.records.has(withFile) && h.state.app.records.has(withConversation), true);
  assert.equal(fs.readFileSync(path.join(folderOf(h, withFile), 'keep.txt'), 'utf8'), 'k');
  assert.deepEqual(fs.readdirSync(h.roots.projectsRoot).sort(), [withFile, 'project_emptyorphan', 'project_nobody'].sort());
  assert.deepEqual(reconciled(h), []);
  const line = h.fx.logs.filter((entry) => entry.event === 'team_project.reconciled').at(-1);
  assert.deepEqual(line.fields, counts);
});

test('a host with no projects root reconciles rows and records with no folder step', async (t) => {
  const h = await createTeamProjectFixture(t);
  const unbound = record(h);
  const row = record(h);
  await h.store.createProject({ ...alice(h), projectId: row });
  const first = await h.reconcile();
  assert.deepEqual([first.records, first.channels, first.folders], [1, 1, 0]);
  assert.equal(h.state.app.records.has(unbound), false);
  assert.equal(h.state.app.records.get(row).root_path, null);
});

test('a reconcile that meets an unreadable store or record list logs and returns', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true });
  h.state.app.listProjects = () => { throw new Error('down'); };
  const counts = await h.reconcile();
  assert.equal(counts.finished + counts.records, 0);
  assert.equal(h.fx.logs.filter((entry) => entry.event === 'team_project.reconcile_skipped').length, 1);
});

test('the reconcile transition takes no actor and refuses a bad id or step; removed needs a row', async (t) => {
  const h = await createTeamProjectFixture(t);
  assert.equal((await h.store.reconcileProject({ projectId: '../x', step: 'record' })).error.reason, 'team_project_id_invalid');
  assert.equal((await h.store.reconcileProject({ projectId: 'project_x', step: 'anything' })).error.reason,
    'team_project_reconcile_invalid');
  assert.equal((await h.store.reconcileProject({ projectId: 'project_x', step: 'removed' })).error.reason, 'team_not_found');
  assert.deepEqual(reconciled(h), []);
  const id = await h.sharedProject();
  const streams = ['carl', 'bob'].map((who) => h.attach(who));
  assert.equal((await h.store.reconcileProject({ projectId: id, step: 'removed' })).ok, true);
  assert.deepEqual(reconciled(h), [[id, 'step=removed', null]]);
  assert.deepEqual(streams.map((stream) => h.projectFrames(stream).map((frame) => frame.reason)), [['deleted'], []]);
});

test('a record list that is read-only changes nothing; General in the list is never touched', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true });
  h.state.app.records.set('project_general', { id: 'project_general', name: 'General', root_path: null, root_revision: 0 });
  const stranded = record(h);
  const deleting = await h.sharedProject('Deleting');
  await h.store.markProjectDeleting({ ...alice(h), projectId: deleting, counts: { conversations: 0, files: 0 } });
  h.state.app.readOnly = true;
  const before = snapshot(h);
  const counts = await h.reconcile();
  assert.equal(snapshot(h), before, 'nothing is judged from a read-only list');
  assert.equal(Object.values(counts).every((value) => value === 0), true);
  const skipped = h.fx.logs.filter((entry) => entry.event === 'team_project.reconcile_skipped');
  assert.deepEqual(skipped.map((entry) => entry.fields), [{ reason: 'records_read_only' }]);
  h.state.app.readOnly = false;
  const after = await settle(h);
  assert.deepEqual([after.finished, after.records], [1, 1]);
  assert.equal(h.state.app.records.has(stranded), false);
  assert.equal(h.state.app.records.has('project_general'), true);
  assert.equal(reconciled(h).some(([id]) => id === 'project_general'), false);
});

test('an active row with no record is left and counted; a record bound outside the projects root is kept', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true });
  const active = await h.sharedProject('Active orphan');
  await h.ok(h.send('carl', 'sessions.create', { title: 'Keep', project_id: active }));
  h.state.remover.remove(active);
  const outside = record(h, 'Outside');
  const elsewhere = path.join(path.dirname(h.roots.projectsRoot), 'elsewhere');
  fs.mkdirSync(elsewhere);
  h.state.app.bindProjectRoot({ project_id: outside, root_path: elsewhere, expected_root_revision: 0 });
  const counts = await settle(h);
  assert.deepEqual([counts.rows_without_record, counts.records_kept, counts.finished, counts.records], [1, 1, 0, 0]);
  assert.equal(h.store.getProject(active).state, 'active');
  assert.equal(h.backend.sessionStore.listSessions().some((summary) => summary.project_id === active), true);
  assert.equal(fs.readdirSync(h.roots.projectsRoot).includes(active), true);
  assert.equal(h.state.app.records.has(outside), true);
  assert.deepEqual(reconciled(h), []);
  // The owner's or an admin's Delete still removes the row with no record.
  await h.ok(h.send('alice', 'team.project.delete', { project_id: active }));
  assert.equal(h.store.getProject(active), null);
});

test('a delete stopped part way through its conversations is finished', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true });
  const id = await h.sharedProject('Half');
  for (const title of ['One', 'Two']) await h.ok(h.send('carl', 'sessions.create', { title, project_id: id }));
  await h.store.markProjectDeleting({ ...alice(h), projectId: id, counts: { conversations: 2, files: 0 } });
  const [first] = h.backend.sessionStore.listSessions().filter((summary) => summary.project_id === id);
  assert.equal((await h.core.router.projectDeletes.remove(first.id)).deleted, true);
  const counts = await settle(h);
  assert.equal(counts.finished, 1);
  assert.deepEqual(h.backend.sessionStore.listSessions().filter((summary) => summary.project_id === id), []);
  assert.equal(h.store.getProject(id), null);
});

test('the start is still asked whether it is cancelled between rows', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true });
  await h.sharedProject('One');
  await h.sharedProject('Two');
  let asked = 0;
  const cancelled = Object.assign(new Error('team_start_cancelled'), { reason: 'team_start_cancelled' });
  await assert.rejects(h.reconcile({ alive: () => { asked += 1; if (asked === 2) throw cancelled; } }), cancelled);
  assert.equal(asked, 2);
});

test('E67: at start the real chat store loses every project channel whose project is gone, and a cut removal is finished', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true });
  const profileDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-e67-reconcile-')));
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  const chatDir = path.join(profileDir, 'team-chat');
  const chat = new TeamChatStore({ profileDir, logger: h.fx.logger });
  assert.equal(chat.open().ok, true);
  for (const channelId of ['chan_team', 'chan_project_oldone', 'chan_project_oldtwo']) {
    assert.equal((await chat.createChannel({ channelId })).ok, true);
  }
  // Earlier builds archived a deleted project's channel and kept it for good.
  for (const channelId of ['chan_project_oldone', 'chan_project_oldtwo']) {
    assert.equal((await chat.archiveChannel({ channelId })).ok, true);
  }
  assert.equal((await chat.openDirect({ memberIds: [h.seats.alice.member_id, h.seats.bob.member_id] })).ok, true);
  h.state.chat = chat;
  const live = await h.sharedProject('Live');
  const deleting = await h.sharedProject('Deleting');
  await h.store.markProjectDeleting({ ...alice(h), projectId: deleting, counts: { conversations: 0, files: 0 } });
  // A removal cut after its index commit: the folder is left with no index row.
  fs.mkdirSync(path.join(chatDir, 'chan_project_cut'));
  fs.writeFileSync(path.join(chatDir, 'chan_project_cut', 'channel.json'), '{}');
  const counts = await h.reconcile();
  assert.deepEqual([counts.finished, counts.channels_removed, counts.failed], [1, 2, 0]);
  const names = (store) => store.listChannels().channels.map((info) => info.channel_id).sort();
  const listed = names(chat);
  assert.deepEqual(listed.filter((id) => !id.startsWith('chan_dm_')), ['chan_team', `chan_${live}`].sort());
  assert.equal(listed.filter((id) => id.startsWith('chan_dm_')).length, 1, 'a direct conversation is never touched');
  for (const name of ['chan_project_oldone', 'chan_project_oldtwo', 'chan_project_cut', `chan_${deleting}`]) {
    assert.equal(fs.existsSync(path.join(chatDir, name)), false, name);
  }
  const restarted = new TeamChatStore({ profileDir });
  assert.equal(restarted.open().ok, true);
  assert.deepEqual(names(restarted), listed);
  // One line, by count only.
  const lines = h.fx.logs.filter((entry) => entry.event === 'team_chat.dead_channels_removed');
  assert.deepEqual(lines.map((entry) => entry.fields), [{ removed: 2, leftovers: 1 }]);
  assert.equal((await h.reconcile()).channels_removed, 0, 'a second start removes nothing');
});
