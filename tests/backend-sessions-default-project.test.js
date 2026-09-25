'use strict';

/* The Workspace folder is the project: a new chat with no explicit project
 * lands in the project bound to the configured Workspace folder (provisioned on
 * demand), General only when no folder is configured. An explicit project id
 * always wins. Asserted at the project-authority boundary with the real
 * application project scope, so the seam inside createSession stays honest. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createSession } = require('../services/backend/backend-sessions');
const { initializeApplicationProjects } = require('../services/projects/application-project-scope');
const { GENERAL_PROJECT_ID } = require('../services/projects/project-schema');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function buildService({ workspaceRoot = '', hostMode = 'desktop' } = {}) {
  const base = createTrackedTempDir('jenny-session-default-project-');
  const folder = path.join(base, 'Ascend');
  fs.mkdirSync(folder);
  const captured = { projectId: null };
  const service = {
    hostMode,
    _emitServiceLog() {},
    configService: {
      getState: () => ({ defaultRunMode: 'ask', toolsWorkspaceRoot: workspaceRoot === 'folder' ? folder : workspaceRoot }),
    },
    sessionStore: {
      createSession({ projectId, preferences }) {
        captured.projectId = projectId;
        return { id: 'session-1', title: 'seeded', project_id: projectId, ...preferences };
      },
    },
  };
  initializeApplicationProjects(service, { userDataPath: path.join(base, 'profile'), hostMode });
  return { service, captured, folder };
}

test('no configured folder keeps new chats in General', async () => {
  const { service, captured } = buildService();
  await createSession(service, { title: 'fresh' });
  assert.equal(captured.projectId, GENERAL_PROJECT_ID);
});

test('a configured Workspace folder becomes the default project for new chats', async () => {
  const { service, captured } = buildService({ workspaceRoot: 'folder' });
  await createSession(service, { title: 'fresh' });
  assert.notEqual(captured.projectId, GENERAL_PROJECT_ID);
  const project = service.projectService.get(captured.projectId);
  assert.equal(project.name, 'Ascend');
  assert.ok(project.root_path);

  await createSession(service, { title: 'second' });
  assert.equal(captured.projectId, project.id, 'provisioned once, reused after');
  assert.equal(service.projectService.list().length, 2);
  assert.equal(service.projectService.get(GENERAL_PROJECT_ID).root_path, null);
});

test('an explicit project id wins over the configured folder', async () => {
  const { service, captured } = buildService({ workspaceRoot: 'folder' });
  await createSession(service, { title: 'explicit', projectId: GENERAL_PROJECT_ID });
  assert.equal(captured.projectId, GENERAL_PROJECT_ID);
});

test('a folder that no longer exists falls back to General without creating a project', async () => {
  const { service, captured, folder } = buildService({ workspaceRoot: 'folder' });
  fs.rmSync(folder, { recursive: true, force: true });
  await createSession(service, { title: 'fresh' });
  assert.equal(captured.projectId, GENERAL_PROJECT_ID);
  assert.equal(service.projectService.list().length, 1);
});

test('hosted profiles keep the General default', async () => {
  const { service, captured } = buildService({ workspaceRoot: 'folder', hostMode: 'server' });
  await createSession(service, { title: 'fresh' });
  assert.equal(captured.projectId, GENERAL_PROJECT_ID);
});
