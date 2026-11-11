'use strict';

// Row 106 synced workspace: the restore point taken before write-back and the
// Changed-files Undo that restores from it. Real git in temp repos: the probe
// gate, the pinned refs/jenny/sandbox/<session>/<n> checkpoint (worktree and
// index untouched), neutralized host git (hooks, filters and fsmonitor never
// run), sandbox-only retention, and the recovery IPC routing a sandbox ref to
// the chat's project root instead of the IDE root.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createSandboxRestorePoints } = require('../services/execution/sandbox-restore-point');
const { registerWorkspaceRecoveryIpcHandlers } = require('../services/workspace-recovery-ipc-handlers');
const { getBridgeChannel } = require('../services/ipc-contract');
const { WorkspaceGitService } = require('../services/workspace-git-service');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');
const { createGitRepo, createTrash, git } = require('./helpers/workspace-recovery-harness');

const NODE = process.execPath.replace(/\\/g, '/');
const SESSION = 'sess_1730000000000_abcdef012345';
const SANDBOX_REF_RE = /^refs\/jenny\/sandbox\/sess_1730000000000_abcdef012345\/([1-9][0-9]*)$/;

test.afterEach(async () => {
  await cleanupTrackedResources();
});

async function refs(repo, prefix) {
  const listed = await git(repo, ['for-each-ref', '--format=%(refname)', prefix]);
  return listed.stdout.split(/\r?\n/).filter(Boolean).sort();
}

async function show(repo, spec) {
  return (await git(repo, ['show', spec])).stdout;
}

async function repoState(repo) {
  const status = (await git(repo, ['status', '--porcelain=v1', '-uall'])).stdout;
  const index = (await git(repo, ['ls-files', '-s'])).stdout;
  return { status, index };
}

// Committed: tracked.txt, same.txt. Then: tracked.txt modified, notes.txt untracked.
async function seedRepo() {
  const repo = await createGitRepo('jenny-sandbox-rp-');
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'tracked before\n');
  await fs.writeFile(path.join(repo, 'same.txt'), 'unchanged\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'initial']);
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'tracked dirty\n');
  await fs.writeFile(path.join(repo, 'notes.txt'), 'notes untracked\n');
  return repo;
}

// A helper command that records it ran; a clean filter also passes stdin
// through, the others never read stdin.
function markerCommand(marker, { passStdin = false } = {}) {
  const script = `require('fs').writeFileSync(process.argv[1],'ran')${passStdin ? ';process.stdin.pipe(process.stdout)' : ''}`;
  return `"${NODE}" -e "${script}" "${marker.replace(/\\/g, '/')}"`;
}

function plainGit(cwd, args) {
  execFileSync('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
}

// Same size, newer mtime: git cannot trust the stat data and re-reads the file
// through the configured clean filter.
function touchSameSize(file, content) {
  fsSync.writeFileSync(file, content);
  const later = new Date(Date.now() + 5000);
  fsSync.utimesSync(file, later, later);
}

function recoveryRig({ chatRoot, ideRoot, trash = createTrash(), sessions = { [SESSION]: chatRoot } }) {
  const handlers = new Map();
  const gitService = new WorkspaceGitService({
    configService: { getToolsWorkspaceRoot: () => ideRoot },
    featureFlagProvider: () => ({ workspace_git: true }),
    trashItemImpl: trash.trashItem,
    logger() {},
  });
  const projectAuthority = {
    captureSession(sessionId) {
      if (!Object.prototype.hasOwnProperty.call(sessions, sessionId)) throw new Error('session_not_found');
      return { project_id: 'proj_a', root_path: sessions[sessionId], root_id: `root:${sessions[sessionId]}` };
    },
    requireCurrent: (authority) => authority,
  };
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike: { handle: (channel, handler) => handlers.set(channel, handler) },
    backendService: { projectAuthority, sidecarClient: { request: async () => ({}) } },
    ipcAuthorization: {},
    gitService,
    ideService: null,
    sandboxTrashItem: trash.trashItem,
  });
  return {
    trash,
    invoke: (methodPath, payload) => handlers.get(getBridgeChannel(methodPath, 'invoke'))({}, payload),
  };
}

describe('probe', () => {
  test('is available at the top level of a repository with a born HEAD', async () => {
    const repo = await seedRepo();
    assert.deepEqual(await createSandboxRestorePoints().probe(repo), { available: true });
  });

  test('reports not_git for a plain folder, a repository subfolder and a repository without commits', async () => {
    const points = createSandboxRestorePoints();
    const plain = createTrackedTempDir('jenny-sandbox-plain-');
    assert.deepEqual(await points.probe(plain), { available: false, reason: 'not_git' });
    const repo = await seedRepo();
    const sub = path.join(repo, 'sub');
    await fs.mkdir(sub);
    await fs.writeFile(path.join(sub, 'x.txt'), 'x\n');
    assert.deepEqual(await points.probe(sub), { available: false, reason: 'not_git' });
    const empty = await createGitRepo('jenny-sandbox-empty-');
    assert.deepEqual(await points.probe(empty), { available: false, reason: 'not_git' });
  });

  test('reports unavailable when the untracked files exceed the checkpoint caps, and never throws', async () => {
    const repo = await seedRepo();
    await fs.writeFile(path.join(repo, 'more.txt'), 'more\n');
    await fs.writeFile(path.join(repo, 'extra.txt'), 'extra\n');
    const capped = createSandboxRestorePoints({ untrackedLimits: { maxFiles: 2 } });
    assert.deepEqual(await capped.probe(repo), { available: false, reason: 'unavailable' });
    const points = createSandboxRestorePoints();
    assert.deepEqual(await points.probe(''), { available: false, reason: 'unavailable' });
    assert.deepEqual(await points.probe(null), { available: false, reason: 'unavailable' });
    const missingGit = createSandboxRestorePoints({ exec: async () => ({ success: false, reason: 'spawn_failed', stdout: '', stderr: '', message: 'spawn git ENOENT' }) });
    assert.deepEqual(await missingGit.probe(repo), { available: false, reason: 'unavailable' });
  });

  test('reports unavailable during an unresolved merge, before approval rather than after it', async () => {
    const repo = await seedRepo();
    await git(repo, ['commit', '-am', 'dirty']);
    await git(repo, ['checkout', '-b', 'other', 'HEAD~1']);
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'theirs\n');
    await git(repo, ['commit', '-am', 'theirs']);
    await git(repo, ['merge', 'main']).catch(() => null); // exits 1 on the conflict
    assert.notEqual((await git(repo, ['ls-files', '--unmerged'])).stdout, '');
    assert.deepEqual(await createSandboxRestorePoints().probe(repo), { available: false, reason: 'unavailable' });
  });
});

describe('create', () => {
  test('pins refs/jenny/sandbox/<session>/<n> with tracked and untracked changes, touching neither worktree nor index', async () => {
    const repo = await seedRepo();
    const before = await repoState(repo);
    const points = createSandboxRestorePoints();
    const first = await points.create({ root: repo, sessionId: SESSION, signal: null });
    assert.equal(first.kind, 'git_checkpoint');
    assert.equal(SANDBOX_REF_RE.exec(first.ref)?.[1], '1');
    assert.match(first.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(Object.keys(first).sort(), ['created_at', 'kind', 'ref']);
    assert.equal(await show(repo, `${first.ref}:tracked.txt`), 'tracked dirty\n');
    assert.equal(await show(repo, `${first.ref}^3:notes.txt`), 'notes untracked\n');
    assert.deepEqual(await repoState(repo), before);
    assert.equal(await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8'), 'tracked dirty\n');
    const second = await points.create({ root: repo, sessionId: SESSION });
    assert.equal(SANDBOX_REF_RE.exec(second.ref)?.[1], '2');
    assert.deepEqual(await refs(repo, 'refs/jenny/checkpoints'), []);
  });

  test('a clean tree still yields a restore point (HEAD pinned)', async () => {
    const repo = await createGitRepo('jenny-sandbox-clean-');
    await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'initial']);
    const head = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
    const point = await createSandboxRestorePoints().create({ root: repo, sessionId: SESSION });
    assert.equal((await git(repo, ['rev-parse', point.ref])).stdout.trim(), head);
  });

  test('throws for a folder without a restore point and for an aborted signal', async () => {
    const points = createSandboxRestorePoints();
    const plain = createTrackedTempDir('jenny-sandbox-plain-');
    await assert.rejects(points.create({ root: plain, sessionId: SESSION }));
    const empty = await createGitRepo('jenny-sandbox-empty-');
    await assert.rejects(points.create({ root: empty, sessionId: SESSION }));
    const repo = await seedRepo();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(points.create({ root: repo, sessionId: SESSION, signal: controller.signal }));
    await fs.writeFile(path.join(repo, 'more.txt'), 'more\n');
    await assert.rejects(createSandboxRestorePoints({ untrackedLimits: { maxFiles: 1 } }).create({ root: repo, sessionId: SESSION }));
    assert.deepEqual(await refs(repo, 'refs/jenny'), []);
  });

  test('sandbox retention prunes only sandbox refs; a turn checkpoint survives', async () => {
    const repo = await seedRepo();
    await git(repo, ['update-ref', 'refs/jenny/checkpoints/sess_turn/1', 'HEAD']);
    const points = createSandboxRestorePoints({ retention: { perSession: 2 } });
    for (let index = 0; index < 3; index += 1) await points.create({ root: repo, sessionId: SESSION });
    assert.deepEqual(await refs(repo, 'refs/jenny/sandbox'), [
      `refs/jenny/sandbox/${SESSION}/2`,
      `refs/jenny/sandbox/${SESSION}/3`,
    ]);
    assert.deepEqual(await refs(repo, 'refs/jenny/checkpoints'), ['refs/jenny/checkpoints/sess_turn/1']);
  });
});

describe('neutralized host git', () => {
  test('hooks, clean filters and fsmonitor never run during probe, create, preflight or restore', async () => {
    const repo = await seedRepo();
    const markers = createTrackedTempDir('jenny-sandbox-markers-');
    const hookMarker = path.join(markers, 'hook.marker');
    const filterMarker = path.join(markers, 'filter.marker');
    const fsmonitorMarker = path.join(markers, 'fsmonitor.marker');
    const hooks = path.join(markers, 'hooks');
    await fs.mkdir(hooks);
    await fs.writeFile(path.join(hooks, 'reference-transaction'), `#!/bin/sh\n${markerCommand(hookMarker)} </dev/null\nexit 0\n`, { mode: 0o755 });
    await fs.writeFile(path.join(repo, '.gitattributes'), '*.txt filter=evil\n');
    await git(repo, ['add', '.gitattributes']);
    await git(repo, ['commit', '-m', 'attributes']);
    await git(repo, ['config', 'core.hooksPath', hooks.replace(/\\/g, '/')]);
    await git(repo, ['config', 'filter.evil.clean', markerCommand(filterMarker, { passStdin: true })]);
    await git(repo, ['config', 'core.fsmonitor', markerCommand(fsmonitorMarker)]);

    // Control: plain git runs each hostile helper.
    touchSameSize(path.join(repo, 'tracked.txt'), 'tracked DIRTY\n');
    plainGit(repo, ['update-ref', 'refs/control/x', 'HEAD']);
    plainGit(repo, ['stash', 'create']);
    plainGit(repo, ['status', '--porcelain']);
    for (const marker of [hookMarker, filterMarker, fsmonitorMarker]) {
      assert.equal(fsSync.existsSync(marker), true, `control: ${path.basename(marker)} did not run under plain git`);
      fsSync.rmSync(marker);
    }
    plainGit(repo, ['update-ref', '-d', 'refs/control/x']);
    fsSync.rmSync(hookMarker, { force: true });

    touchSameSize(path.join(repo, 'tracked.txt'), 'tracked dirtY\n');
    const points = createSandboxRestorePoints();
    assert.deepEqual(await points.probe(repo), { available: true });
    const point = await points.create({ root: repo, sessionId: SESSION });
    assert.equal(await show(repo, `${point.ref}:tracked.txt`), 'tracked dirtY\n');
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'by the command\n');
    await fs.writeFile(path.join(repo, 'made.txt'), 'made by the command\n');
    const rig = recoveryRig({ chatRoot: repo, ideRoot: createTrackedTempDir('jenny-sandbox-ide-') });
    const preflight = await rig.invoke('workspaceRecovery.preflightCheckpointFiles', {
      ref: point.ref, sessionId: SESSION, files: [{ path: 'tracked.txt' }, { path: 'made.txt' }],
    });
    assert.equal(preflight.ok, true, JSON.stringify(preflight));
    const restored = await rig.invoke('workspaceRecovery.restoreCheckpointFiles', {
      ref: point.ref, sessionId: SESSION, paths: ['tracked.txt'], removePaths: ['made.txt'],
    });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8'), 'tracked dirtY\n');
    for (const marker of [hookMarker, filterMarker, fsmonitorMarker]) {
      assert.equal(fsSync.existsSync(marker), false, `${path.basename(marker)} ran on the sandbox path`);
    }
  });
});

describe('Undo through the recovery IPC', () => {
  test('a sandbox ref restores in the chat root, not the IDE root, and its rollback is the Redo target', async () => {
    const chatRoot = await seedRepo();
    const ideRoot = await seedRepo();
    const point = await createSandboxRestorePoints().create({ root: chatRoot, sessionId: SESSION });
    // The "command" (written back by the host).
    await fs.writeFile(path.join(chatRoot, 'tracked.txt'), 'by the command\n');
    await fs.writeFile(path.join(chatRoot, 'notes.txt'), 'notes by the command\n');
    await fs.writeFile(path.join(chatRoot, 'made.txt'), 'made by the command\n');
    const ideBefore = await repoState(ideRoot);
    const indexBefore = (await git(chatRoot, ['ls-files', '-s'])).stdout;
    const rig = recoveryRig({ chatRoot, ideRoot });

    const preflight = await rig.invoke('workspaceRecovery.preflightCheckpointFiles', {
      ref: point.ref, sessionId: SESSION,
      files: [{ path: 'tracked.txt' }, { path: 'notes.txt' }, { path: 'made.txt' }],
    });
    assert.equal(preflight.ok, true, JSON.stringify(preflight));
    assert.deepEqual(preflight.files.map((file) => [file.path, file.inCheckpoint, file.exists]), [
      ['tracked.txt', 'tracked', true],
      ['notes.txt', 'untracked', true],
      ['made.txt', 'absent', true],
    ]);

    const restored = await rig.invoke('workspaceRecovery.restoreCheckpointFiles', {
      ref: point.ref, sessionId: SESSION, paths: ['tracked.txt', 'notes.txt'], removePaths: ['made.txt'],
    });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.deepEqual(restored.restored, ['tracked.txt', 'notes.txt']);
    assert.deepEqual(restored.removed, ['made.txt']);
    assert.deepEqual(restored.failed, []);
    assert.match(restored.rollbackRef, /^refs\/jenny\/sandbox\/[^/]+\/[1-9][0-9]*$/);
    assert.equal(await fs.readFile(path.join(chatRoot, 'tracked.txt'), 'utf8'), 'tracked dirty\n');
    assert.equal(await fs.readFile(path.join(chatRoot, 'notes.txt'), 'utf8'), 'notes untracked\n');
    assert.equal(fsSync.existsSync(path.join(chatRoot, 'made.txt')), false);
    assert.equal(rig.trash.items.length, 1);
    assert.equal((await git(chatRoot, ['ls-files', '-s'])).stdout, indexBefore);
    assert.deepEqual(await repoState(ideRoot), ideBefore);
    assert.deepEqual(await refs(ideRoot, 'refs/jenny'), []);
    assert.deepEqual(await refs(chatRoot, 'refs/jenny/checkpoints'), []);

    // Redo: the rollback ref puts the command's version back.
    const redo = await rig.invoke('workspaceRecovery.restoreCheckpointFiles', {
      ref: restored.rollbackRef, sessionId: SESSION, paths: ['tracked.txt'],
    });
    assert.equal(redo.ok, true, JSON.stringify(redo));
    assert.equal(await fs.readFile(path.join(chatRoot, 'tracked.txt'), 'utf8'), 'by the command\n');
  });

  test('payload rules: a sandbox ref needs a known session; a turn checkpoint ref keeps its old shape', async () => {
    const chatRoot = await seedRepo();
    const point = await createSandboxRestorePoints().create({ root: chatRoot, sessionId: SESSION });
    const rig = recoveryRig({ chatRoot, ideRoot: chatRoot });
    const files = [{ path: 'tracked.txt' }];
    const noSession = await rig.invoke('workspaceRecovery.preflightCheckpointFiles', { ref: point.ref, files });
    assert.equal(noSession.ok, false);
    assert.equal(noSession.reason, 'session_invalid');
    const unknown = await rig.invoke('workspaceRecovery.preflightCheckpointFiles', { ref: point.ref, files, sessionId: 'sess_other' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.reason, 'root_unavailable');
    const turnWithSession = await rig.invoke('workspaceRecovery.preflightCheckpointFiles', {
      ref: 'refs/jenny/checkpoints/sess_a/1', files, sessionId: SESSION,
    });
    assert.equal(turnWithSession.ok, false);
    assert.equal(turnWithSession.reason, 'payload_invalid');
    const badRef = await rig.invoke('workspaceRecovery.restoreCheckpointFiles', {
      ref: 'refs/jenny/sandbox/../x/1', paths: ['tracked.txt'], sessionId: SESSION,
    });
    assert.equal(badRef.ok, false);
    assert.equal(badRef.reason, 'ref_invalid');
  });
});
