'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { BackendService } = require('../../services/backend/backend-service');
const { deleteSession } = require('../../services/backend/backend-sessions');
const { ArtifactWorkspaceService } = require('../../services/artifact-workspace-service');
const { createFakeSafeStorage } = require('../helpers/fake-safe-storage');
const { createTrackedTempDir, cleanupTrackedResources } = require('../helpers/resource-cleanup');

test.afterEach(cleanupTrackedResources);

async function fixture(t, { bound = true } = {}) {
  const userDataPath = createTrackedTempDir('runtime-artifact-lifecycle-');
  const root = createTrackedTempDir('runtime-artifact-root-');
  const uiRoot = createTrackedTempDir('runtime-artifact-ui-');
  const service = new BackendService({ userDataPath, repoRoot: process.cwd(),
    pythonExecutable: process.execPath, safeStorage: createFakeSafeStorage(), defaultModel: 'mock-v1' });
  t.after(() => service.dispose());
  service.artifactService = new ArtifactWorkspaceService({
    configService: { getState: () => ({ toolsWorkspaceRoot: uiRoot }) },
    projectAuthorityProvider: () => service.projectAuthority,
  });
  const project = service.projectService.create({ name: 'Artifact lifecycle' }).project;
  if (bound) assert.equal(service.projectService.bindRoot(project.id, root, { expectedRevision: 0 }).ok, true);
  const session = (await service.createSession({ projectId: project.id })).data;
  return { service, session, root, uiRoot, project };
}

test('canonical deletion cleans the captured project scratch after metadata removal', async (t) => {
  const { service, session, uiRoot } = await fixture(t);
  const created = await service.artifactService.createArtifact(session.id, {
    title: 'Delete me', artifact_kind: 'document', content: 'private',
  });
  const otherPath = path.join(uiRoot, '.jenny', 'artifacts', session.id, 'keep.md');
  fs.mkdirSync(path.dirname(otherPath), { recursive: true });
  fs.writeFileSync(otherPath, 'other project');

  const result = await deleteSession(service, session.id);
  assert.equal(result.deleted, true);
  assert.equal(result.cleanup_status, 'complete');
  assert.equal(service.sessionStore.getSession(session.id), null);
  assert.equal(fs.existsSync(created.metadata.absolute_path), false);
  assert.equal(fs.readFileSync(otherPath, 'utf8'), 'other project');
});

test('unbound conversation deletion completes without using the selected UI root', async (t) => {
  const { service, session, uiRoot } = await fixture(t, { bound: false });
  const result = await deleteSession(service, session.id);
  assert.equal(result.deleted, true);
  assert.equal(result.cleanup_status, 'complete');
  assert.deepEqual(fs.readdirSync(uiRoot), []);
});

test('failed authority preparation preserves scratch and reports degraded cleanup', async (t) => {
  const { service, session } = await fixture(t);
  const created = await service.artifactService.createArtifact(session.id, {
    title: 'Keep evidence', artifact_kind: 'document', content: 'retained',
  });
  service.projectAuthority.captureSession = () => { throw new Error('authority unavailable'); };
  const result = await deleteSession(service, session.id);
  assert.equal(result.deleted, true);
  assert.equal(result.cleanup_status, 'degraded');
  assert.deepEqual(result.cleanup_errors, [{ step: 'artifacts', code: 'cleanup_failed' }]);
  assert.equal(fs.readFileSync(created.metadata.absolute_path, 'utf8'), 'retained');
});

test('artifact cleanup refuses an ancestor junction escaping the captured workspace', async (t) => {
  const { service, session, root } = await fixture(t);
  const outsideRoot = createTrackedTempDir('runtime-artifact-outside-');
  const outsideFile = path.join(outsideRoot, session.id, 'keep.md');
  fs.mkdirSync(path.dirname(outsideFile), { recursive: true });
  fs.writeFileSync(outsideFile, 'outside authority');
  fs.mkdirSync(path.join(root, '.jenny'), { recursive: true });
  fs.symlinkSync(outsideRoot, path.join(root, '.jenny', 'artifacts'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const result = await deleteSession(service, session.id);
  assert.equal(result.deleted, true);
  assert.equal(result.cleanup_status, 'degraded');
  assert.deepEqual(result.cleanup_errors, [{ step: 'artifacts', code: 'cleanup_failed' }]);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside authority');
});
