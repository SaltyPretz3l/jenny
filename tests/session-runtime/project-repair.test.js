'use strict';

// Project repair (PO review 2026-09-27, D1/D5 + perf): a moved or missing
// folder can be re-located onto the SAME project (never a second project), a
// folder already owned by another project is refused, `projects.list` says
// whether each folder exists and which project IS the Workspace (real paths, so
// a junction or subst drive still matches), and the list is built from one
// store snapshot with folder probes cached per (project, root_revision).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { ApplicationProjectAuthority } = require('../../services/projects/application-project-scope');
const { ProjectApplicationService } = require('../../services/projects/project-application-service');
const { ProjectFolderStatus } = require('../../services/projects/project-folder-status');
const { GENERAL_PROJECT_ID } = require('../../services/projects/project-schema');
const { ProjectService } = require('../../services/projects/project-service');
const { ProjectStore } = require('../../services/projects/project-store');
const { ProjectWorkspacePool } = require('../../services/projects/project-workspace-pool');
const { ToolPermissionStore } = require('../../services/tools/tool-permission-store');
const { cleanupTrackedResources, createTrackedTempDir } = require('../helpers/resource-cleanup');

test.afterEach(async () => cleanupTrackedResources());

function countingFs() {
  const calls = { realpath: 0, stat: 0 };
  const fsPromises = {
    realpath: async (value) => { calls.realpath += 1; return fs.promises.realpath(value); },
    stat: async (value, options) => { calls.stat += 1; return fs.promises.stat(value, options); },
  };
  return { calls, fsPromises };
}

function createFixture({ workspaceRoot = '', ttlMs = 60_000, isSessionBusy } = {}) {
  const root = createTrackedTempDir('jenny-project-repair-');
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  const projectStore = new ProjectStore(path.join(profile, 'projects.json'), {
    now: () => '2026-09-27T12:00:00.000Z',
  });
  let snapshots = 0;
  const getSnapshot = projectStore.getSnapshot.bind(projectStore);
  projectStore.getSnapshot = () => { snapshots += 1; return getSnapshot(); };
  let idCounter = 0;
  const projectService = new ProjectService({
    store: projectStore,
    idFactory: () => `project_created_${++idCounter}`,
    now: () => '2026-09-27T12:01:00.000Z',
  });
  const sessionStore = new ElectronSessionStore(path.join(profile, 'sessions.json'), { writeDebounceMs: 0 });
  const workspacePool = new ProjectWorkspacePool({ projectService });
  const projectAuthority = new ApplicationProjectAuthority({
    store: projectStore, projectService, workspacePool, sessionStore, restrictRoots: false, rootBoundary: null,
  });
  const probe = countingFs();
  const busySessions = new Set();
  let configuredRoot = workspaceRoot;
  const application = new ProjectApplicationService({
    projectService,
    projectStore,
    projectAuthority,
    sessionStore,
    permissionStore: new ToolPermissionStore(path.join(profile, 'tool-permissions.json')),
    isSessionBusy: isSessionBusy || ((sessionId) => busySessions.has(sessionId)),
    resolveWorkspaceRoot: () => configuredRoot,
    folderStatus: new ProjectFolderStatus({ fsPromises: probe.fsPromises, ttlMs }),
    now: () => '2026-09-27T12:02:00.000Z',
  });
  const folder = (name) => {
    const target = path.join(root, name);
    fs.mkdirSync(target, { recursive: true });
    return target;
  };
  return {
    root,
    projectStore,
    projectService,
    sessionStore,
    busySessions,
    application,
    probe,
    folder,
    snapshotCount: () => snapshots,
    resetSnapshots: () => { snapshots = 0; },
    setWorkspaceRoot: (value) => { configuredRoot = value; },
  };
}

function createBound(fixture, name, folderPath) {
  const created = fixture.application.createProject({ name }).project;
  const bound = fixture.application.bindProjectRoot({
    project_id: created.id, root_path: folderPath, expected_root_revision: 0,
  });
  assert.equal(bound.ok, true, JSON.stringify(bound));
  return bound.project;
}

test('bindRoot refuses a folder that already belongs to a different project and names it', () => {
  const fixture = createFixture();
  const shared = fixture.folder('Shared');
  const owner = createBound(fixture, 'Owner', shared);
  const other = fixture.application.createProject({ name: 'Other' }).project;

  const refused = fixture.application.bindProjectRoot({
    project_id: other.id, root_path: shared, expected_root_revision: 0,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.reason, 'folder_already_project');
  assert.equal(refused.error.conflict_project_id, owner.id);
  assert.equal(refused.error.conflict_project_name, 'Owner');
  assert.equal(fixture.projectService.get(other.id).root_revision, 0, 'nothing was bound');

  // The service layer (used by the provisioner and hosted commands) refuses too.
  const direct = fixture.projectService.bindRoot(other.id, shared, { expectedRevision: 0 });
  assert.equal(direct.ok, false);
  assert.equal(direct.reason, 'folder_already_project');
  assert.equal(direct.conflict_project_id, owner.id);

  // Re-binding the owner to its own folder is not a conflict.
  const same = fixture.application.bindProjectRoot({
    project_id: owner.id, root_path: shared, expected_root_revision: owner.root_revision,
  });
  assert.equal(same.ok, true);
  assert.equal(same.unchanged, true);
});

test('rebinding a project to a new folder keeps its id and bumps root_revision', () => {
  const fixture = createFixture();
  const project = createBound(fixture, 'Ascend', fixture.folder('Ascend'));
  assert.equal(project.root_revision, 1);
  const moved = fixture.folder('Ascend-moved');
  const rebound = fixture.application.bindProjectRoot({
    project_id: project.id, root_path: moved, expected_root_revision: 1,
  });
  assert.equal(rebound.ok, true);
  assert.equal(rebound.project.id, project.id);
  assert.equal(rebound.project.root_revision, 2);
  assert.equal(rebound.project.root_path, fs.realpathSync.native(moved));
});

for (const operation of ['set', 'change', 'clear']) {
  test(`root busy guard: refuses ${operation} with the delete failure and preserves the project`, async () => {
    const fixture = createFixture();
    const project = operation === 'set'
      ? fixture.application.createProject({ name: 'Busy' }).project
      : createBound(fixture, 'Busy', fixture.folder('Original'));
    const session = fixture.sessionStore.createSession({ title: 'Busy', projectId: project.id });
    fixture.busySessions.add(session.id);
    const before = fixture.projectService.get(project.id);
    const result = fixture.application.bindProjectRoot({
      project_id: project.id,
      root_path: operation === 'clear' ? null : fixture.folder('New'),
      expected_root_revision: project.root_revision,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result, await fixture.application.deleteProject({ project_id: project.id }));
    assert.equal(result.error.reason, 'session_busy');
    assert.equal(result.error.busy_count, 1);
    assert.deepEqual(fixture.projectService.get(project.id), before);
  });
}

for (const [name, isSessionBusy, storedPatch] of [
  ['throwing lifecycle', () => { throw new Error('registry unavailable'); }, {}],
  ['unknown lifecycle', () => undefined, {}],
  ['stored turn', () => false, { active_turn: {
    request_id: 'stream_busy', stream_id: 'stream_busy', user_message_id: 'message_busy',
    started_at: '2026-10-02T12:00:00.000Z', last_event_at: '2026-10-02T12:00:00.000Z', status: 'streaming',
  } }],
  ['stored question', () => false, { pending_question_batch: {
    batch_id: 'batch_busy', questions: [{ id: 'question_busy', prompt: 'Choose?', options: [{ id: 'yes', label: 'Yes' }] }],
  } }],
  ['stored plan', () => false, { pending_plan_proposal: {
    proposal_id: 'plan_busy', title: 'Busy plan', steps: [{ id: 'step_busy', label: 'Work' }],
  } }],
]) {
  test(`root busy guard: ${name} counts as busy`, () => {
    const fixture = createFixture({ isSessionBusy });
    const project = createBound(fixture, 'Busy', fixture.folder('Original'));
    const session = fixture.sessionStore.createSession({ title: 'Busy', projectId: project.id });
    fixture.sessionStore.updateSession(session.id, storedPatch);
    for (const key of Object.keys(storedPatch)) {
      assert.ok(fixture.sessionStore.listSessionRecords().find((record) => record.id === session.id)[key]);
    }
    const before = fixture.projectService.get(project.id);
    const result = fixture.application.bindProjectRoot({
      project_id: project.id, root_path: fixture.folder('New'), expected_root_revision: 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.reason, 'session_busy');
    assert.equal(result.error.busy_count, 1);
    assert.deepEqual(fixture.projectService.get(project.id), before);
  });
}

test('root busy guard: idle chats bind and a busy chat in another project does not block', () => {
  const fixture = createFixture();
  const project = createBound(fixture, 'Idle', fixture.folder('Original'));
  const other = fixture.application.createProject({ name: 'Other' }).project;
  fixture.sessionStore.createSession({ title: 'Idle', projectId: project.id });
  const busy = fixture.sessionStore.createSession({ title: 'Busy', projectId: other.id });
  fixture.busySessions.add(busy.id);
  const result = fixture.application.bindProjectRoot({
    project_id: project.id, root_path: fixture.folder('New'), expected_root_revision: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.project.root_revision, 2);
  assert.equal(fixture.application.bindProjectRoot({
    project_id: project.id, root_path: null, expected_root_revision: 2,
  }).ok, true);
});

test('root busy guard: the same canonical root and an already clear root remain unchanged while busy', () => {
  const fixture = createFixture();
  const folder = fixture.folder('Original');
  const project = createBound(fixture, 'Busy', folder);
  const clear = fixture.application.createProject({ name: 'Clear' }).project;
  for (const [current, rootPath] of [[project, folder], [project, `${folder}${path.sep}.`], [clear, null]]) {
    const session = fixture.sessionStore.createSession({ title: 'Busy', projectId: current.id });
    fixture.busySessions.add(session.id);
    const before = fixture.projectService.get(current.id);
    const result = fixture.application.bindProjectRoot({
      project_id: current.id, root_path: rootPath, expected_root_revision: current.root_revision,
    });
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
    assert.deepEqual(fixture.projectService.get(current.id), before);
  }
});

test('root busy guard: unreadable inventories fail closed before binding or opening the picker', async () => {
  const fixture = createFixture();
  const project = createBound(fixture, 'Unknown', fixture.folder('Original'));
  const before = fixture.projectService.get(project.id);
  const pick = picker({ canceled: false, path: fixture.folder('New') });
  fixture.sessionStore.listSessionRecords = () => { throw new Error('inventory unavailable'); };
  const result = fixture.application.bindProjectRoot({
    project_id: project.id, root_path: fixture.root, expected_root_revision: 1,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'session_inventory_unavailable');
  const chosen = await fixture.application.chooseProjectRoot({ project_id: project.id, expected_root_revision: 1 }, pick);
  assert.equal(chosen.reason, 'session_inventory_unavailable');
  assert.equal(pick.calls.length, 0);
  assert.deepEqual(fixture.projectService.get(project.id), before);
});

test('root busy guard: a busy project refuses the picker with the existing flat failure', async () => {
  const fixture = createFixture();
  const project = createBound(fixture, 'Busy', fixture.folder('Original'));
  const before = fixture.projectService.get(project.id);
  const session = fixture.sessionStore.createSession({ title: 'Busy', projectId: project.id });
  fixture.busySessions.add(session.id);
  const pick = picker({ canceled: false, path: fixture.folder('New') });
  const result = await fixture.application.chooseProjectRoot({ project_id: project.id, expected_root_revision: 1 }, pick);
  const deleted = await fixture.application.deleteProject({ project_id: project.id });
  assert.deepEqual(result, { ok: false, reason: 'session_busy', busy_count: 1, error: deleted.error });
  assert.equal(pick.calls.length, 0);
  assert.deepEqual(fixture.projectService.get(project.id), before);
});

test('root busy guard: a chat becoming busy after the picker resolves refuses the bind', async () => {
  const fixture = createFixture();
  const project = createBound(fixture, 'Idle', fixture.folder('Original'));
  const before = fixture.projectService.get(project.id);
  const session = fixture.sessionStore.createSession({ title: 'Idle', projectId: project.id });
  const pickedPath = fixture.folder('New');
  const pick = picker(() => Promise.resolve({ canceled: false, path: pickedPath }).then((result) => {
    fixture.busySessions.add(session.id);
    return result;
  }));
  const result = await fixture.application.chooseProjectRoot({ project_id: project.id, expected_root_revision: 1 }, pick);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'session_busy');
  assert.equal(result.busy_count, 1);
  assert.equal(pick.calls.length, 1);
  assert.deepEqual(fixture.projectService.get(project.id), before);
});

test('projects.list reports folder_exists and is_current and keeps every existing field', async () => {
  const fixture = createFixture();
  const present = fixture.folder('Present');
  const doomed = fixture.folder('Doomed');
  const presentProject = createBound(fixture, 'Present', present);
  const doomedProject = createBound(fixture, 'Doomed', doomed);
  fs.rmSync(doomed, { recursive: true, force: true });
  fixture.setWorkspaceRoot(present);

  const listed = await fixture.application.listProjectsWithStatus();
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.storage, { read_only: false, reason: null });
  const byId = Object.fromEntries(listed.projects.map((row) => [row.id, row]));
  for (const row of listed.projects) {
    for (const key of ['id', 'name', 'root_path', 'root_id', 'root_revision', 'runtime_preferences',
      'created_at', 'updated_at', 'authority_key', 'folder_exists', 'is_current']) {
      assert.ok(Object.hasOwn(row, key), `${row.id} keeps ${key}`);
    }
  }
  assert.equal(byId[GENERAL_PROJECT_ID].folder_exists, null, 'General has no folder');
  assert.equal(byId[GENERAL_PROJECT_ID].is_current, false);
  assert.match(byId[GENERAL_PROJECT_ID].authority_key, /^authority_[a-f0-9]{64}$/u);
  assert.equal(byId[presentProject.id].folder_exists, true);
  assert.equal(byId[presentProject.id].is_current, true);
  assert.match(byId[presentProject.id].authority_key, /^authority_[a-f0-9]{64}$/u);
  assert.equal(byId[doomedProject.id].folder_exists, false);
  assert.equal(byId[doomedProject.id].is_current, false);
  assert.equal(byId[doomedProject.id].authority_key, '', 'a missing folder cannot be approved');

  // The sync list (hosted commands) still answers with the historical shape.
  const sync = fixture.application.listProjects();
  assert.equal(sync.ok, true);
  assert.equal(sync.projects.length, 3);
});

test('is_current follows the real path: a Workspace opened through a junction still matches its project', async (t) => {
  const fixture = createFixture();
  const real = fixture.folder('RealFolder');
  const link = path.join(fixture.root, 'LinkedFolder');
  try {
    fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`directory link unavailable: ${error.code || error.message}`);
    return;
  }
  const project = createBound(fixture, 'Real', real);
  fixture.setWorkspaceRoot(link);
  const listed = await fixture.application.listProjectsWithStatus();
  assert.equal(listed.projects.find((row) => row.id === project.id).is_current, true);
});

test('the list reads one store snapshot and folder probes are cached per root_revision', async () => {
  const fixture = createFixture();
  const projects = [];
  for (let index = 0; index < 6; index += 1) {
    projects.push(createBound(fixture, `P${index}`, fixture.folder(`P${index}`)));
  }
  fixture.resetSnapshots();
  await fixture.application.listProjectsWithStatus();
  assert.equal(fixture.snapshotCount(), 1, 'one snapshot for the whole list, not one per project');
  const afterFirst = { ...fixture.probe.calls };
  assert.ok(afterFirst.realpath >= 6, 'the first list probes each folder');

  await fixture.application.listProjectsWithStatus();
  await fixture.application.listProjectsWithStatus();
  assert.deepEqual(fixture.probe.calls, afterFirst, 'repeat lists reuse the cached probes');

  // A rebind bumps root_revision, so that project is probed afresh.
  const rebound = fixture.application.bindProjectRoot({
    project_id: projects[0].id, root_path: fixture.folder('P0-moved'), expected_root_revision: 1,
  });
  assert.equal(rebound.ok, true);
  await fixture.application.listProjectsWithStatus();
  assert.ok(fixture.probe.calls.realpath > afterFirst.realpath, 'the rebound project was re-probed');
});

test('the sync list no longer copies the whole document once per project', () => {
  const fixture = createFixture();
  for (let index = 0; index < 5; index += 1) fixture.application.createProject({ name: `P${index}` });
  fixture.resetSnapshots();
  const listed = fixture.application.listProjects();
  assert.equal(listed.projects.length, 6);
  assert.equal(fixture.snapshotCount(), 1);
});

function picker(result) {
  const calls = [];
  return {
    calls,
    pickFolder: async (options) => { calls.push(options); return typeof result === 'function' ? result() : result; },
  };
}

test('chooseRoot: the main process picks the folder and rebinds the same project', async () => {
  const fixture = createFixture();
  const project = createBound(fixture, 'Ascend', fixture.folder('Ascend'));
  const located = fixture.folder('Ascend-located');
  const pick = picker({ canceled: false, path: located });
  const result = await fixture.application.chooseProjectRoot(
    { project_id: project.id, expected_root_revision: 1 }, pick,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.project.id, project.id, 'same project, never a second one');
  assert.equal(result.project.root_revision, 2);
  assert.equal(result.project.root_path, fs.realpathSync.native(located));
  assert.equal(pick.calls.length, 1);
  assert.equal(fixture.projectService.list().length, 2, 'General + the one project');
});

test('chooseRoot: a canceled picker changes nothing', async () => {
  const fixture = createFixture();
  const project = createBound(fixture, 'Ascend', fixture.folder('Ascend'));
  const result = await fixture.application.chooseProjectRoot(
    { project_id: project.id, expected_root_revision: 1 }, picker({ canceled: true, path: '' }),
  );
  assert.deepEqual(
    { ok: result.ok, reason: result.reason },
    { ok: false, reason: 'canceled' },
  );
  assert.equal(fixture.projectService.get(project.id).root_revision, 1);
});

test('chooseRoot: a folder owned by another project is refused with its id and name', async () => {
  const fixture = createFixture();
  const taken = fixture.folder('Taken');
  const owner = createBound(fixture, 'Owner', taken);
  const project = createBound(fixture, 'Ascend', fixture.folder('Ascend'));
  const result = await fixture.application.chooseProjectRoot(
    { project_id: project.id, expected_root_revision: 1 }, picker({ canceled: false, path: taken }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'folder_already_project');
  assert.equal(result.conflict_project_id, owner.id);
  assert.equal(result.conflict_project_name, 'Owner');
  assert.equal(fixture.projectService.get(project.id).root_revision, 1);
});

test('chooseRoot: the current Workspace project, General, unknown and stale requests are refused before the picker opens', async () => {
  const fixture = createFixture();
  const current = fixture.folder('Current');
  const project = createBound(fixture, 'Current', current);
  fixture.setWorkspaceRoot(current);
  const pick = picker({ canceled: false, path: fixture.folder('Elsewhere') });
  const cases = [
    [{ project_id: project.id, expected_root_revision: 1 }, 'project_is_current'],
    [{ project_id: GENERAL_PROJECT_ID, expected_root_revision: 0 }, 'general_root_reserved'],
    [{ project_id: 'project_missing', expected_root_revision: 0 }, 'project_not_found'],
    [{ project_id: project.id, expected_root_revision: 0 }, 'stale_root_revision'],
    [{ project_id: project.id, expected_root_revision: 1, root_path: current }, 'invalid_project_request'],
    [{ project_id: project.id }, 'invalid_project_request'],
    [undefined, 'invalid_project_request'],
  ];
  for (const [payload, reason] of cases) {
    const result = await fixture.application.chooseProjectRoot(payload, pick);
    assert.equal(result.ok, false, reason);
    assert.equal(result.reason, reason);
    assert.equal(result.error?.reason, reason, 'the coded error rides along');
  }
  assert.equal(pick.calls.length, 0, 'the renderer can never drive the picker into a refused rebind');
});

test('chooseRoot: without a picker (hosted/minimal hosts) it is unavailable, and a second concurrent pick is refused', async () => {
  const fixture = createFixture();
  const project = createBound(fixture, 'Ascend', fixture.folder('Ascend'));
  const none = await fixture.application.chooseProjectRoot({ project_id: project.id, expected_root_revision: 1 }, {});
  assert.equal(none.reason, 'folder_picker_unavailable');

  let release;
  const slow = { pickFolder: () => new Promise((resolve) => { release = resolve; }) };
  const first = fixture.application.chooseProjectRoot({ project_id: project.id, expected_root_revision: 1 }, slow);
  const second = await fixture.application.chooseProjectRoot({ project_id: project.id, expected_root_revision: 1 }, slow);
  assert.equal(second.reason, 'choose_in_progress');
  release({ canceled: true, path: '' });
  assert.equal((await first).reason, 'canceled');
});

test('revealFolder opens only the named project\'s own folder and refuses General, unknown ids and missing folders', async () => {
  const fixture = createFixture();
  const target = fixture.folder('Reveal');
  const project = createBound(fixture, 'Reveal', target);
  const opened = [];
  const openFolder = async (folder) => { opened.push(folder); return ''; };

  assert.deepEqual(await fixture.application.revealProjectFolder({ project_id: project.id }, { openFolder }), { ok: true });
  assert.equal(opened.length, 1);
  assert.equal(fs.realpathSync.native(opened[0]), fs.realpathSync.native(target));

  const reason = async (payload, deps = { openFolder }) => (await fixture.application.revealProjectFolder(payload, deps)).error?.reason;
  assert.equal(await reason({ project_id: GENERAL_PROJECT_ID }), 'general_root_reserved');
  assert.equal(await reason({ project_id: 'project_nope' }), 'project_not_found');
  assert.equal(await reason({ project_id: project.id, root_path: target }), 'invalid_project_request');
  assert.equal(await reason({ project_id: project.id }, {}), 'reveal_unavailable');
  assert.equal(await reason({ project_id: project.id }, { openFolder: async () => 'Failed to open' }), 'reveal_unavailable');
  fs.rmSync(target, { recursive: true, force: true });
  assert.equal(await reason({ project_id: project.id }), 'project_folder_missing');
  assert.equal(opened.length, 1, 'a refused request never reaches the OS');
});

test('chooseRoot re-checks "current" after the picker closes: a Workspace switch while it was open refuses the rebind', async () => {
  const fixture = createFixture();
  const original = fixture.folder('Switched');
  const project = createBound(fixture, 'Switched', original);
  let release;
  const slow = { pickFolder: () => new Promise((resolve) => { release = resolve; }) };
  const pending = fixture.application.chooseProjectRoot({ project_id: project.id, expected_root_revision: 1 }, slow);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof release, 'function', 'the picker is open');
  fixture.setWorkspaceRoot(original);
  release({ canceled: false, path: fixture.folder('Other') });
  assert.equal((await pending).reason, 'project_is_current');
  assert.equal(fixture.projectService.get(project.id).root_path, project.root_path, 'the in-use folder is not rebound');
});

test('revealFolder re-checks the project after its folder probe: a delete or rebind during the probe opens nothing', async () => {
  const fixture = createFixture();
  const opened = [];
  const openFolder = async (folder) => { opened.push(folder); return ''; };
  const deleted = createBound(fixture, 'Gone', fixture.folder('Gone'));
  const pendingDelete = fixture.application.revealProjectFolder({ project_id: deleted.id }, { openFolder });
  assert.equal(fixture.projectService.remove(deleted.id).ok, true, 'the project is deleted while the probe waits');
  assert.equal((await pendingDelete).error?.reason, 'project_not_found');

  const moved = createBound(fixture, 'Moved', fixture.folder('Moved'));
  const pendingRebind = fixture.application.revealProjectFolder({ project_id: moved.id }, { openFolder });
  assert.equal(fixture.application.bindProjectRoot({
    project_id: moved.id, root_path: fixture.folder('MovedElsewhere'), expected_root_revision: moved.root_revision,
  }).ok, true);
  assert.equal((await pendingRebind).error?.reason, 'project_folder_missing');
  assert.deepEqual(opened, [], 'neither stale folder reaches the OS');
});

test('revealFolder refuses a registered path that now resolves somewhere else (a junction swapped in)', async (t) => {
  const fixture = createFixture();
  const registered = fixture.folder('Registered');
  const project = createBound(fixture, 'Registered', registered);
  const elsewhere = fixture.folder('Elsewhere');
  fs.rmSync(registered, { recursive: true, force: true });
  try {
    fs.symlinkSync(elsewhere, registered, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`cannot create a directory link here: ${error.code}`);
    return;
  }
  const opened = [];
  const result = await fixture.application.revealProjectFolder({ project_id: project.id }, {
    openFolder: async (folder) => { opened.push(folder); return ''; },
  });
  assert.equal(result.error?.reason, 'project_folder_missing');
  assert.deepEqual(opened, []);
});
