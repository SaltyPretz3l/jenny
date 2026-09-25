'use strict';

// Deleting a project (owner-approved 2026-09-20, "Projects v2"): the entry goes
// away, its idle chats move to General, nothing on disk is touched, General
// itself is protected, and a busy chat anywhere in the project blocks the whole
// delete so no chat is half-moved out from under a running turn.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { ProjectApplicationService } = require('../../services/projects/project-application-service');
const { GENERAL_PROJECT_ID } = require('../../services/projects/project-schema');
const { ProjectService } = require('../../services/projects/project-service');
const { ProjectStore } = require('../../services/projects/project-store');
const { ProjectWorkspacePool } = require('../../services/projects/project-workspace-pool');
const { ToolPermissionStore } = require('../../services/tools/tool-permission-store');
const { cleanupTrackedResources, createTrackedTempDir } = require('../helpers/resource-cleanup');

test.afterEach(async () => cleanupTrackedResources());

function createFixture({ workspaceRoot = '' } = {}) {
  const root = createTrackedTempDir('jenny-project-delete-');
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  const folder = path.join(root, 'Ascend');
  fs.mkdirSync(folder);
  const projectStore = new ProjectStore(path.join(profile, 'projects.json'), {
    now: () => '2026-09-20T12:00:00.000Z',
  });
  let idCounter = 0;
  const projectService = new ProjectService({
    store: projectStore,
    idFactory: () => `project_created_${++idCounter}`,
    canonicalizeRoot: (value) => (value === null ? null : path.resolve(String(value))),
    now: () => '2026-09-20T12:01:00.000Z',
  });
  const sessionStore = new ElectronSessionStore(path.join(profile, 'sessions.json'), { writeDebounceMs: 0 });
  const workspacePool = new ProjectWorkspacePool({ projectService });
  const projectAuthority = {
    captureProject(projectId) {
      const captured = workspacePool.capture(projectId);
      if (!captured.ok) {
        throw Object.assign(new Error('Project authority unavailable.'), {
          code: 'CMP-PROJECT-0002', reason: captured.reason,
        });
      }
      return captured.authority;
    },
  };
  const busySessions = new Set();
  const application = new ProjectApplicationService({
    projectService,
    projectStore,
    projectAuthority,
    sessionStore,
    permissionStore: new ToolPermissionStore(path.join(profile, 'tool-permissions.json')),
    isSessionBusy: (sessionId) => busySessions.has(sessionId),
    resolveWorkspaceRoot: () => workspaceRoot,
    now: () => '2026-09-20T12:02:00.000Z',
  });
  return { root, folder, projectService, sessionStore, busySessions, application, projectStore };
}

test('delete refuses malformed requests, unknown projects and General', () => {
  const fixture = createFixture();
  assert.equal(fixture.application.deleteProject().error.reason, 'invalid_project_request');
  assert.equal(fixture.application.deleteProject({ project_id: 'project_x', extra: 1 }).error.reason, 'invalid_project_request');
  assert.equal(fixture.application.deleteProject({ project_id: 'not a project' }).error.reason, 'invalid_project_id');
  assert.equal(fixture.application.deleteProject({ project_id: 'project_missing' }).error.reason, 'project_not_found');
  const general = fixture.application.deleteProject({ project_id: GENERAL_PROJECT_ID });
  assert.equal(general.ok, false);
  assert.equal(general.error.reason, 'general_protected');
  assert.equal(general.error.code, 'CMP-PROJECT-0001');
  assert.match(general.error.message, /General/u);
  assert.equal(fixture.projectService.list().length, 1, 'General is still there');
});

test('delete moves idle chats to General, removes the entry and reports whether the Workspace was bound to it', () => {
  const fixture = createFixture();
  const created = fixture.application.createProject({ name: 'Ascend' }).project;
  fixture.application.bindProjectRoot({ project_id: created.id, root_path: fixture.folder, expected_root_revision: 0 });
  const one = fixture.sessionStore.createSession({ title: 'One' });
  const two = fixture.sessionStore.createSession({ title: 'Two' });
  const elsewhere = fixture.sessionStore.createSession({ title: 'Elsewhere' });
  for (const session of [one, two]) {
    assert.equal(fixture.application.assignSessionProject({ session_id: session.id, project_id: created.id }).ok, true);
  }

  const boundFixture = createFixture({ workspaceRoot: fixture.folder });
  // The bound flag is judged against the configured Workspace root; probe it on a
  // fixture whose root IS this folder before the unbound case below.
  const boundProject = boundFixture.application.createProject({ name: 'Bound' }).project;
  boundFixture.application.bindProjectRoot({ project_id: boundProject.id, root_path: fixture.folder, expected_root_revision: 0 });
  const boundResult = boundFixture.application.deleteProject({ project_id: boundProject.id });
  assert.equal(boundResult.ok, true);
  assert.equal(boundResult.workspace_bound, true);
  assert.equal(boundResult.moved_sessions, 0);

  const result = fixture.application.deleteProject({ project_id: created.id });
  assert.equal(result.ok, true);
  assert.equal(result.project.id, created.id);
  assert.equal(result.project.name, 'Ascend');
  assert.equal(result.moved_sessions, 2);
  assert.equal(result.workspace_bound, false);
  assert.equal(fixture.projectService.get(created.id), null);
  assert.equal(fixture.sessionStore.getSessionSummary(one.id).project_id, GENERAL_PROJECT_ID);
  assert.equal(fixture.sessionStore.getSessionSummary(two.id).project_id, GENERAL_PROJECT_ID);
  assert.equal(fixture.sessionStore.getSessionSummary(elsewhere.id).project_id, GENERAL_PROJECT_ID);
  assert.equal(fs.existsSync(fixture.folder), true, 'the folder on disk is never touched');
  assert.equal(fixture.application.listProjects().projects.length, 1);
});

test('a busy chat anywhere in the project blocks the delete and nothing moves', () => {
  const fixture = createFixture();
  const created = fixture.application.createProject({ name: 'Ascend' }).project;
  const idle = fixture.sessionStore.createSession({ title: 'Idle' });
  const busy = fixture.sessionStore.createSession({ title: 'Busy' });
  for (const session of [idle, busy]) {
    assert.equal(fixture.application.assignSessionProject({ session_id: session.id, project_id: created.id }).ok, true);
  }
  fixture.busySessions.add(busy.id);
  const refused = fixture.application.deleteProject({ project_id: created.id });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.reason, 'session_busy');
  assert.equal(refused.error.busy_count, 1);
  assert.equal(fixture.projectService.get(created.id)?.id, created.id, 'project still exists');
  assert.equal(fixture.sessionStore.getSessionSummary(idle.id).project_id, created.id, 'idle chat was not moved either');
});

test('a read-only project store refuses the delete before any chat is moved', () => {
  const fixture = createFixture();
  const created = fixture.application.createProject({ name: 'Ascend' }).project;
  const session = fixture.sessionStore.createSession({ title: 'Stay' });
  assert.equal(fixture.application.assignSessionProject({ session_id: session.id, project_id: created.id }).ok, true);
  fixture.projectStore._readOnlyReason = 'future_schema';
  const refused = fixture.application.deleteProject({ project_id: created.id });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'CMP-PROJECT-0003');
  assert.equal(fixture.sessionStore.getSessionSummary(session.id).project_id, created.id);
});

test('workspace_bound is judged by canonical root identity, not string equality (Windows casing)', { skip: process.platform !== 'win32' ? 'case-insensitive roots are a Windows contract' : false }, () => {
  const fixture = createFixture();
  const shouted = createFixture({ workspaceRoot: fixture.folder.toUpperCase() });
  const created = shouted.application.createProject({ name: 'Ascend' }).project;
  shouted.application.bindProjectRoot({ project_id: created.id, root_path: fixture.folder, expected_root_revision: 0 });
  const result = shouted.application.deleteProject({ project_id: created.id });
  assert.equal(result.ok, true);
  assert.equal(result.workspace_bound, true, 'G:\\A and g:\\a are the same Workspace folder');
});

test('an unreadable chat inventory refuses the delete instead of treating it as "no chats, none busy"', () => {
  const fixture = createFixture();
  const created = fixture.application.createProject({ name: 'Ascend' }).project;
  const session = fixture.sessionStore.createSession({ title: 'One' });
  assert.equal(fixture.application.assignSessionProject({ session_id: session.id, project_id: created.id }).ok, true);
  fixture.sessionStore.listSessionRecords = () => { throw new Error('disk offline'); };
  const result = fixture.application.deleteProject({ project_id: created.id });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'session_inventory_unavailable');
  assert.match(result.error.message, /chat list could not be read/);
  assert.ok(fixture.projectService.get(created.id), 'the project survives');
});

test('a failed project-store write puts the already-moved chats back: a refused delete leaves no chat in General', () => {
  const fixture = createFixture();
  const created = fixture.application.createProject({ name: 'Ascend' }).project;
  const one = fixture.sessionStore.createSession({ title: 'One' });
  const two = fixture.sessionStore.createSession({ title: 'Two' });
  for (const session of [one, two]) {
    assert.equal(fixture.application.assignSessionProject({ session_id: session.id, project_id: created.id }).ok, true);
  }
  fixture.projectService.remove = () => ({ ok: false, reason: 'write_failed' });
  const result = fixture.application.deleteProject({ project_id: created.id });
  assert.equal(result.ok, false);
  const details = JSON.stringify(result);
  assert.match(details, /"moved_sessions":0/, 'nothing is left moved');
  assert.match(details, /"restored_sessions":2/);
  assert.equal(fixture.sessionStore.getSessionSummary(one.id).project_id, created.id);
  assert.equal(fixture.sessionStore.getSessionSummary(two.id).project_id, created.id);
  assert.ok(fixture.projectService.get(created.id));
});
