'use strict';

/* The Workspace folder is the project: choosing a folder provisions the project
 * bound to it (once), new chats default into it, General stays folderless, and
 * hosted profiles never provision implicitly. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { GENERAL_PROJECT_ID } = require('../../services/projects/project-schema');
const { ProjectService, canonicalizeProjectRoot } = require('../../services/projects/project-service');
const { ProjectStore } = require('../../services/projects/project-store');
const {
  ensureWorkspaceProject,
  resolveDefaultSessionProjectId,
} = require('../../services/projects/workspace-project-provisioner');
const { cleanupTrackedResources, createTrackedTempDir } = require('../helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createService({ hostMode = 'desktop', workspaceRoot = '', idFactory } = {}) {
  const base = createTrackedTempDir('jenny-workspace-project-');
  const profile = path.join(base, 'profile');
  fs.mkdirSync(profile);
  const folder = path.join(base, 'Ascend');
  fs.mkdirSync(folder);
  let counter = 0;
  const projectStore = new ProjectStore(path.join(profile, 'projects.json'));
  const projectService = new ProjectService({
    store: projectStore,
    idFactory: idFactory || (() => `project_ws_${++counter}`),
  });
  const logs = [];
  const service = {
    hostMode,
    projectStore,
    projectService,
    configService: { getToolsWorkspaceRoot: () => workspaceRoot },
    _emitServiceLog: (level, event, details) => logs.push({ level, event, details }),
  };
  return { service, folder, projectService, logs };
}

test('choosing a folder provisions one project named after it and binds the folder', () => {
  const { service, folder, projectService, logs } = createService();

  const first = ensureWorkspaceProject(service, folder, { reason: 'workspace_root_commit' });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(first.project.name, 'Ascend');
  assert.equal(first.project.root_path, canonicalizeProjectRoot(folder));
  assert.equal(first.project.root_revision, 1);

  const second = ensureWorkspaceProject(service, folder, { reason: 'session_create' });
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.equal(second.project.id, first.project.id);
  assert.equal(projectService.list().length, 2, 'General plus the workspace project');
  assert.equal(projectService.get(GENERAL_PROJECT_ID).root_path, null, 'General stays unbound');
  assert.deepEqual(
    logs.filter((entry) => entry.event === 'projects.workspace_project_provisioned').length,
    1
  );
});

test('a folder the owner already bound by hand is reused, earliest project first', () => {
  const { service, folder, projectService } = createService();
  const manual = projectService.create({ name: 'My hand-made project' }).project;
  projectService.bindRoot(manual.id, folder);
  const later = projectService.create({ name: 'Duplicate' }).project;
  projectService.bindRoot(later.id, folder);

  const result = ensureWorkspaceProject(service, folder);
  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.equal(result.project.id, manual.id);
});

test('missing, invalid, or vanished folders fail legibly and create nothing', () => {
  const { service, folder, projectService } = createService();
  assert.equal(ensureWorkspaceProject(service, '').reason, 'workspace_root_unset');
  assert.equal(ensureWorkspaceProject(service, 'relative/folder').reason, 'invalid_root');
  assert.equal(ensureWorkspaceProject(service, path.join(folder, 'gone')).reason, 'root_unavailable');
  assert.equal(projectService.list().length, 1);
});

test('hosted profiles and missing project services never provision implicitly', () => {
  const hosted = createService({ hostMode: 'server' });
  assert.equal(ensureWorkspaceProject(hosted.service, hosted.folder).reason, 'host_mode_server');
  assert.equal(hosted.projectService.list().length, 1);
  assert.equal(ensureWorkspaceProject({}, hosted.folder).reason, 'project_service_unavailable');
  assert.equal(resolveDefaultSessionProjectId({}), GENERAL_PROJECT_ID);
});

test('a read-only project store refuses provisioning', () => {
  const { service, folder } = createService();
  service.projectStore = { getStatus: () => ({ read_only: true, reason: 'corrupt_store' }) };
  const result = ensureWorkspaceProject(service, folder);
  assert.equal(result.reason, 'project_store_read_only');
  assert.equal(result.store_reason, 'corrupt_store');
});

test('new chats default into the configured workspace project, else General', () => {
  const unset = createService();
  assert.equal(resolveDefaultSessionProjectId(unset.service), GENERAL_PROJECT_ID);

  const configured = createService();
  configured.service.configService = { getToolsWorkspaceRoot: () => configured.folder };
  const projectId = resolveDefaultSessionProjectId(configured.service);
  assert.match(projectId, /^project_ws_1$/u);
  assert.equal(resolveDefaultSessionProjectId(configured.service), projectId, 'idempotent');
  assert.equal(configured.projectService.get(projectId).name, 'Ascend');

  const stateOnly = createService();
  stateOnly.service.configService = { getState: () => ({ toolsWorkspaceRoot: stateOnly.folder }) };
  assert.equal(stateOnly.projectService.get(resolveDefaultSessionProjectId(stateOnly.service)).name, 'Ascend');
});
