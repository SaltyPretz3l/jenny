'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  JENNY_GITIGNORE_CONTENT,
  ensureJennyDirGitignore,
  ensureJennyDirGitignoreSync,
} = require('../services/jenny-project-dir');
const { ArtifactWorkspaceService } = require('../services/artifact-workspace-service');
const { writeScheduledTasksFile, resolveScheduledTasksPath } = require('../services/scheduler-tasks-store');
const { createWorkspaceRestoreStage } = require('../services/data-lifecycle/workspace-restore-durability');
const { createTrackedTempDir, cleanupTrackedResources } = require('./helpers/resource-cleanup');

test.afterEach(cleanupTrackedResources);

function makeJennyDir() {
  const root = createTrackedTempDir('jenny-project-dir-');
  const jennyDir = path.join(root, '.jenny');
  fs.mkdirSync(jennyDir);
  return { root, jennyDir, gitignore: path.join(jennyDir, '.gitignore') };
}

test('the gitignore content ignores everything and says who created it', () => {
  const lines = JENNY_GITIGNORE_CONTENT.split('\n');
  assert.match(lines[0], /^# Created by Jenny/);
  assert.equal(lines[1], '*');
});

test('async helper writes .jenny/.gitignore = * into a fresh .jenny folder', async () => {
  const { jennyDir, gitignore } = makeJennyDir();
  assert.equal(await ensureJennyDirGitignore(jennyDir), true);
  assert.equal(fs.readFileSync(gitignore, 'utf8'), JENNY_GITIGNORE_CONTENT);
});

test('sync helper writes .jenny/.gitignore = * into a fresh .jenny folder', () => {
  const { jennyDir, gitignore } = makeJennyDir();
  assert.equal(ensureJennyDirGitignoreSync(jennyDir), true);
  assert.equal(fs.readFileSync(gitignore, 'utf8'), JENNY_GITIGNORE_CONTENT);
});

test('an existing .jenny/.gitignore is left byte-identical', async () => {
  const { jennyDir, gitignore } = makeJennyDir();
  const owned = Buffer.from('# mine\r\n!keep.json\r\n', 'utf8');
  fs.writeFileSync(gitignore, owned);
  assert.equal(await ensureJennyDirGitignore(jennyDir), false);
  assert.equal(ensureJennyDirGitignoreSync(jennyDir), false);
  assert.deepEqual(fs.readFileSync(gitignore), owned);
});

test('a write failure is swallowed, never thrown', async () => {
  const { jennyDir } = makeJennyDir();
  const failing = {
    lstat: async () => fs.lstatSync(jennyDir),
    writeFile: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
    lstatSync: () => fs.lstatSync(jennyDir),
    writeFileSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  };
  assert.equal(await ensureJennyDirGitignore(jennyDir, { fs: failing }), false);
  assert.equal(ensureJennyDirGitignoreSync(jennyDir, { fs: failing }), false);
  // A missing .jenny folder is also a quiet no-op (the helper never creates it).
  const missing = path.join(createTrackedTempDir('jenny-project-dir-missing-'), '.jenny');
  assert.equal(await ensureJennyDirGitignore(missing), false);
  assert.equal(ensureJennyDirGitignoreSync(missing), false);
  assert.equal(fs.existsSync(missing), false);
});

test('only a folder named .jenny is touched (never a profile or other directory)', async () => {
  const root = createTrackedTempDir('jenny-project-dir-other-');
  assert.equal(await ensureJennyDirGitignore(root), false);
  assert.equal(ensureJennyDirGitignoreSync(root), false);
  assert.equal(fs.existsSync(path.join(root, '.gitignore')), false);
});

test('artifact creation in a project leaves .jenny self-ignoring', async () => {
  const root = createTrackedTempDir('jenny-project-dir-artifact-');
  const service = new ArtifactWorkspaceService({
    configService: { getState: () => ({ toolsWorkspaceRoot: root }) },
  });
  await service.createArtifact('session-1', { title: 'Plan', content: '# Plan', language: 'markdown' });
  assert.equal(fs.readFileSync(path.join(root, '.jenny', '.gitignore'), 'utf8'), JENNY_GITIGNORE_CONTENT);
});

test('scheduled task writes into a project leave .jenny self-ignoring; profile paths get none', () => {
  const root = createTrackedTempDir('jenny-project-dir-tasks-');
  writeScheduledTasksFile(resolveScheduledTasksPath({ workspaceRoot: root }), { version: 1, tasks: [] });
  assert.equal(fs.readFileSync(path.join(root, '.jenny', '.gitignore'), 'utf8'), JENNY_GITIGNORE_CONTENT);

  const userDataPath = createTrackedTempDir('jenny-project-dir-profile-');
  const profileTasks = resolveScheduledTasksPath({ userDataPath });
  writeScheduledTasksFile(profileTasks, { version: 1, tasks: [] });
  assert.equal(fs.existsSync(path.join(path.dirname(profileTasks), '.gitignore')), false);
});

test('workspace restore staging leaves .jenny self-ignoring', () => {
  const root = createTrackedTempDir('jenny-project-dir-restore-');
  createWorkspaceRestoreStage(path.join(root, '.jenny', '.restore-staging'));
  assert.equal(fs.readFileSync(path.join(root, '.jenny', '.gitignore'), 'utf8'), JENNY_GITIGNORE_CONTENT);
});

test('opening the project skills folder leaves .jenny self-ignoring; the user skills folder gets nothing', () => {
  const { createScopeFolder } = require('../services/skills-project-scope');
  const root = createTrackedTempDir('jenny-project-dir-skills-');
  createScopeFolder(path.join(root, '.jenny', 'skills'), { project: true });
  assert.equal(fs.readFileSync(path.join(root, '.jenny', '.gitignore'), 'utf8'), JENNY_GITIGNORE_CONTENT);

  const home = createTrackedTempDir('jenny-project-dir-user-skills-');
  createScopeFolder(path.join(home, '.companion', 'skills'));
  assert.equal(fs.existsSync(path.join(home, '.companion', '.gitignore')), false);
});
