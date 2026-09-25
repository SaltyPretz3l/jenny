'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { ArtifactWorkspaceService } = require('../../services/artifact-workspace-service');
const { PNG } = require('../helpers/preview-capture-fixture');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('../helpers/resource-cleanup');

test.afterEach(cleanupTrackedResources);

const AUTHORITY_FIELDS = [
  'project_id', 'root_path', 'root_id', 'root_revision', 'device_id', 'inode',
];

function sameAuthority(left, right) {
  return AUTHORITY_FIELDS.every((field) => left?.[field] === right?.[field]);
}

function makeAuthorityProvider(projectRoots, sessionProjects) {
  const authorities = new Map();
  for (const [projectId, rootPath] of Object.entries(projectRoots)) {
    authorities.set(projectId, Object.freeze({
      project_id: projectId,
      root_path: rootPath,
      root_id: rootPath ? `root_${projectId}` : null,
      root_revision: 1,
      device_id: rootPath ? '1' : null,
      inode: rootPath ? '1' : null,
    }));
  }
  const sessions = new Map(Object.entries(sessionProjects));
  const error = (reason) => Object.assign(new Error(reason), { reason });
  return {
    captureSession(sessionId) {
      const projectId = sessions.get(sessionId);
      if (!projectId) throw error('session_not_found');
      const authority = authorities.get(projectId);
      if (!authority) throw error('project_not_found');
      return authority;
    },
    requireCurrent(authority) {
      const current = authorities.get(authority?.project_id);
      if (!current || !sameAuthority(current, authority)) throw error('project_authority_stale');
      return authority;
    },
    moveSession(sessionId, projectId) {
      sessions.set(sessionId, projectId);
    },
    removeSession(sessionId) {
      sessions.delete(sessionId);
    },
    authority(projectId) {
      return authorities.get(projectId);
    },
    rebind(projectId, rootPath) {
      const previous = authorities.get(projectId);
      authorities.set(projectId, Object.freeze({
        ...previous,
        root_path: rootPath,
        root_id: rootPath ? `root_${projectId}_${previous.root_revision + 1}` : null,
        root_revision: previous.root_revision + 1,
      }));
    },
  };
}

function generatedArtifact(sessionId, root, artifactId, fileName = 'note.md') {
  const absolutePath = path.join(root, '.jenny', 'artifacts', sessionId, fileName);
  return {
    artifact_id: artifactId,
    artifact_kind: 'document',
    title: 'Note',
    file_name: fileName,
    display_path: `.jenny/artifacts/${sessionId}/${fileName}`,
    absolute_path: absolutePath,
    language: 'markdown',
    editable: true,
    status: 'available',
  };
}

test('project authority roots replace global config and null roots fail closed', async () => {
  const alphaRoot = createTrackedTempDir('artifact-authority-alpha-');
  const attackerRoot = createTrackedTempDir('artifact-authority-global-');
  const provider = makeAuthorityProvider(
    { project_alpha: alphaRoot, project_general: null },
    { session_alpha: 'project_alpha', session_general: 'project_general' }
  );
  const service = new ArtifactWorkspaceService({
    configService: { getState: () => ({ toolsWorkspaceRoot: attackerRoot }) },
    projectAuthorityProvider: () => provider,
  });

  const alpha = service.forSessionAuthority(provider.authority('project_alpha'), 'session_alpha');
  const created = await alpha.createArtifact('session_alpha', {
    artifact_kind: 'document', title: 'Scoped', content: 'alpha',
  });
  assert.equal(created.metadata.absolute_path.startsWith(alphaRoot), true);
  assert.equal(fs.readdirSync(attackerRoot).length, 0);

  const general = service.forSessionAuthority(provider.authority('project_general'), 'session_general');
  await assert.rejects(
    general.createArtifact('session_general', {
      artifact_kind: 'document', title: 'Blocked', content: 'none',
    }),
    (error) => error.code === 'CMP-ARTIFACT-0001'
  );
});

test('bound facades reject forged session ids and independently authorize a shared physical root', async () => {
  const sharedRoot = createTrackedTempDir('artifact-authority-shared-');
  const provider = makeAuthorityProvider(
    { project_alpha: sharedRoot, project_beta: sharedRoot },
    { session_alpha: 'project_alpha', session_beta: 'project_beta' }
  );
  const service = new ArtifactWorkspaceService({ projectAuthorityProvider: provider });
  const alpha = service.forSessionAuthority(provider.authority('project_alpha'), 'session_alpha');
  const beta = service.forSessionAuthority(provider.authority('project_beta'), 'session_beta');

  assert.throws(
    () => alpha.createArtifact('session_beta', { title: 'Forged', content: 'private' }),
    (error) => error.code === 'CMP-ARTIFACT-0014'
  );
  const [alphaArtifact, betaArtifact] = await Promise.all([
    alpha.createArtifact('session_alpha', { title: 'Shared name', content: 'alpha' }),
    beta.createArtifact('session_beta', { title: 'Shared name', content: 'beta' }),
  ]);
  assert.match(alphaArtifact.metadata.display_path, /session_alpha/u);
  assert.match(betaArtifact.metadata.display_path, /session_beta/u);
  assert.equal(fs.readFileSync(alphaArtifact.metadata.absolute_path, 'utf8'), 'alpha');
  assert.equal(fs.readFileSync(betaArtifact.metadata.absolute_path, 'utf8'), 'beta');

  const clone = await alpha.cloneSessionArtifactsForBranch('session_alpha', 'session_beta');
  assert.deepEqual(clone, { cloned: false, reason: 'project_authority_mismatch' });
});

test('project root rebinding while a shared write lock waits makes admitted writes stale', async () => {
  const root = createTrackedTempDir('artifact-authority-write-race-');
  const reboundRoot = createTrackedTempDir('artifact-authority-write-rebound-');
  const provider = makeAuthorityProvider(
    { project_alpha: root },
    { session_alpha: 'project_alpha' }
  );
  let releaseWrite;
  let firstWriteStarted;
  const writeStarted = new Promise((resolve) => { firstWriteStarted = resolve; });
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  let held = false;
  const service = new ArtifactWorkspaceService({
    projectAuthorityProvider: provider,
    fsImpl: {
      ...fs.promises,
      async writeFile(target, content, options) {
        if (!held && String(target).includes('locked.md.tmp-')) {
          held = true;
          firstWriteStarted();
          await writeGate;
        }
        return fs.promises.writeFile(target, content, options);
      },
    },
  });
  const facade = service.forSessionAuthority(provider.authority('project_alpha'), 'session_alpha');
  const first = facade.createArtifact('session_alpha', {
    title: 'Locked', file_name: 'locked.md', content: 'first',
  });
  await writeStarted;
  const second = facade.createArtifact('session_alpha', {
    title: 'Locked', file_name: 'locked.md', content: 'second',
  });
  provider.rebind('project_alpha', reboundRoot);
  releaseWrite();

  const results = await Promise.allSettled([first, second]);
  assert.equal(results.every((result) => result.status === 'rejected'), true);
  const scratch = path.join(root, '.jenny', 'artifacts', 'session_alpha');
  assert.deepEqual(fs.readdirSync(scratch), []);
});

test('canonical reads discard bytes when session authority changes during file IO', async () => {
  const root = createTrackedTempDir('artifact-authority-read-race-');
  const provider = makeAuthorityProvider(
    { project_alpha: root, project_beta: root },
    { session_alpha: 'project_alpha' }
  );
  const metadata = generatedArtifact('session_alpha', root, 'artifact_note');
  fs.mkdirSync(path.dirname(metadata.absolute_path), { recursive: true });
  fs.writeFileSync(metadata.absolute_path, 'secret', 'utf8');
  const service = new ArtifactWorkspaceService({
    projectAuthorityProvider: provider,
    sessionMessageReader: async () => [{ tool_result: { generated_artifacts: [metadata] } }],
    fsImpl: {
      ...fs.promises,
      async readFile(target, ...args) {
        const result = await fs.promises.readFile(target, ...args);
        if (target === metadata.absolute_path) provider.moveSession('session_alpha', 'project_beta');
        return result;
      },
    },
  });
  const facade = service.forSessionAuthority(provider.authority('project_alpha'), 'session_alpha');

  await assert.rejects(
    facade.readArtifact('session_alpha', 'artifact_note'),
    (error) => error.details?.reason === 'project_authority_stale'
  );
});

test('preview capture revalidates authority after the shared physical-root wait', async () => {
  const root = createTrackedTempDir('artifact-authority-preview-race-');
  const provider = makeAuthorityProvider(
    { project_alpha: root, project_beta: root },
    { session_alpha: 'project_alpha', session_beta: 'project_beta' }
  );
  let releaseMarker;
  let markerStarted;
  const markerGate = new Promise((resolve) => { releaseMarker = resolve; });
  const markerSeen = new Promise((resolve) => { markerStarted = resolve; });
  let held = false;
  const service = new ArtifactWorkspaceService({
    projectAuthorityProvider: provider,
    fsImpl: {
      ...fs.promises,
      async writeFile(target, content, options) {
        if (!held && path.basename(String(target)) === '.preview-captures.initialized') {
          held = true;
          markerStarted();
          await markerGate;
        }
        return fs.promises.writeFile(target, content, options);
      },
    },
  });
  const alpha = service.forSessionAuthority(provider.authority('project_alpha'), 'session_alpha');
  const beta = service.forSessionAuthority(provider.authority('project_beta'), 'session_beta');
  const first = alpha.createBinaryArtifact('session_alpha', {
    previewScreenshot: true, content: PNG, width: 2, height: 1,
  });
  await markerSeen;
  const second = beta.createBinaryArtifact('session_beta', {
    previewScreenshot: true, content: PNG, width: 2, height: 1,
  });
  const secondRejected = assert.rejects(
    second,
    (error) => error.details?.reason === 'project_authority_stale'
  );
  await new Promise((resolve) => setImmediate(resolve));
  provider.moveSession('session_beta', 'project_alpha');
  releaseMarker();

  await first;
  await secondRejected;
  const files = fs.readdirSync(path.join(root, '.jenny', 'artifacts'), { recursive: true })
    .filter((entry) => entry.endsWith('.png'));
  assert.equal(files.length, 1);
});

test('configured lazy authority absence never falls back to the UI workspace root', async () => {
  const root = createTrackedTempDir('artifact-authority-absent-');
  const service = new ArtifactWorkspaceService({
    configService: { getState: () => ({ toolsWorkspaceRoot: root }) },
    projectAuthorityProvider: () => null,
  });
  await assert.rejects(
    service.createArtifact('session_alpha', { title: 'Blocked', content: 'none' }),
    (error) => error.details?.reason === 'project_authority_unavailable'
  );
  assert.deepEqual(fs.readdirSync(root), []);
});

test('branch clone rechecks an initially absent target after planning and rejects another project claim', async () => {
  const root = createTrackedTempDir('artifact-authority-branch-race-');
  const provider = makeAuthorityProvider(
    { project_alpha: root, project_beta: root },
    { session_source: 'project_alpha' }
  );
  const sourceDir = path.join(root, '.jenny', 'artifacts', 'session_source');
  let claimed = false;
  const service = new ArtifactWorkspaceService({
    projectAuthorityProvider: provider,
    fsImpl: {
      ...fs.promises,
      async readdir(target, options) {
        const entries = await fs.promises.readdir(target, options);
        if (!claimed && target === sourceDir) {
          claimed = true;
          provider.moveSession('session_target', 'project_beta');
        }
        return entries;
      },
    },
  });
  const source = service.forSessionAuthority(provider.authority('project_alpha'), 'session_source');
  await source.createArtifact('session_source', { title: 'Source', content: 'copy me' });

  const result = await source.cloneSessionArtifactsForBranch('session_source', 'session_target');
  assert.deepEqual(result, { cloned: false, reason: 'project_authority_mismatch' });
  assert.equal(fs.existsSync(path.join(root, '.jenny', 'artifacts', 'session_target')), false);
});

test('prepared deletion and failed-branch cleanup require an absent, unreused session id', async () => {
  const root = createTrackedTempDir('artifact-authority-cleanup-');
  const provider = makeAuthorityProvider(
    { project_alpha: root, project_beta: root, project_general: null },
    {
      session_delete: 'project_alpha',
      session_source: 'project_alpha',
      session_general: 'project_general',
    }
  );
  const service = new ArtifactWorkspaceService({ projectAuthorityProvider: provider });
  const deleting = service.forSessionAuthority(provider.authority('project_alpha'), 'session_delete');
  const created = await deleting.createArtifact('session_delete', {
    title: 'Delete me', content: 'owned bytes',
  });
  const deletion = deleting.prepareSessionDeletion('session_delete');
  provider.removeSession('session_delete');
  provider.moveSession('session_delete', 'project_beta');
  await assert.rejects(
    deletion.deleteSessionArtifacts(),
    (error) => error.details?.reason === 'artifact_session_reused'
  );
  assert.equal(fs.existsSync(created.metadata.absolute_path), true);
  provider.removeSession('session_delete');
  assert.deepEqual(await deletion.deleteSessionArtifacts(), { deleted: true });

  const general = service.forSessionAuthority(provider.authority('project_general'), 'session_general');
  const emptyDeletion = general.prepareSessionDeletion('session_general');
  provider.removeSession('session_general');
  assert.deepEqual(await emptyDeletion.deleteSessionArtifacts(), { deleted: false });

  const source = service.forSessionAuthority(provider.authority('project_alpha'), 'session_source');
  await source.createArtifact('session_source', { title: 'Branch source', content: 'copy' });
  const clone = await source.cloneSessionArtifactsForBranch('session_source', 'session_branch');
  assert.equal(clone.cloned, true);
  assert.equal(typeof clone.cleanupArtifacts, 'function');
  provider.moveSession('session_branch', 'project_alpha');
  await assert.rejects(
    clone.cleanupArtifacts(),
    (error) => error.details?.reason === 'artifact_session_reused'
  );
  provider.removeSession('session_branch');
  assert.deepEqual(await clone.cleanupArtifacts(), { deleted: true });
});
