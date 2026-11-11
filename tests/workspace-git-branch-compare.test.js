'use strict';

/* Real-git coverage of the whole-branch read behind the chat workspace Changes
 * page (chat session bar slice 5): base resolution (registry, origin/HEAD, main,
 * master), the merge-base file list with uncommitted and untracked work, honest
 * not_applicable states, and the getBranchChangeDiff membership + containment
 * boundary. Every case runs a real temp repository. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { WorkspaceGitService } = require('../services/workspace-git-service');
const { MAX_DIFF_CHARS } = require('../services/workspace-git-change-summary');
const {
  createWorkspaceGitBranchCompare,
  parseNameStatus,
  registryBaseRef,
} = require('../services/workspace-git-branch-compare');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');
const { fileSymlinkSkip, linkDirectory } = require('./helpers/platform-skips');

const execFileAsync = promisify(execFile);
const fixedNow = () => new Date('2026-11-09T12:00:00.000Z');

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
  return stdout.trim();
}

async function write(root, name, text) {
  await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await fs.writeFile(path.join(root, name), text, 'utf8');
}

async function commitAll(root, message) {
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

async function initRepo(root, { trunk = 'main' } = {}) {
  await git(root, ['init']);
  await git(root, ['symbolic-ref', 'HEAD', `refs/heads/${trunk}`]);
  await git(root, ['config', 'user.email', 'jenny@example.invalid']);
  await git(root, ['config', 'user.name', 'Jenny Tests']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await git(root, ['config', 'core.symlinks', 'true']);
}

// main: initial commit + one later commit (other.txt); feature: branched at the
// initial commit with two commits, then uncommitted, untracked and binary work.
async function createBranchRepo() {
  const root = createTrackedTempDir('jenny-branch-compare-');
  await initRepo(root);
  await write(root, 'README.md', 'one\ntwo\nthree\n');
  await write(root, 'gone.txt', 'bye\n');
  await write(root, 'old-name.txt', 'rename me\nline two\nline three\nline four\n');
  const initial = await commitAll(root, 'initial');
  await git(root, ['checkout', '-b', 'feature']);
  await write(root, 'README.md', 'one\ntwo\nthree\nfour\n'); // +1
  await write(root, 'feat.txt', 'a\nb\n'); // +2
  await commitAll(root, 'feature one');
  await fs.rm(path.join(root, 'gone.txt'));
  await git(root, ['mv', 'old-name.txt', 'new-name.txt']);
  await commitAll(root, 'feature two');
  await git(root, ['checkout', 'main']);
  await write(root, 'other.txt', 'main only\n');
  await commitAll(root, 'main moves on');
  await git(root, ['checkout', 'feature']);
  await write(root, 'feat.txt', 'a\nb\nc\n'); // uncommitted +1
  await write(root, 'fresh.txt', 'x\ny\nz\n'); // untracked +3
  await fs.writeFile(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  return { root, initial };
}

function gitService(root) {
  return new WorkspaceGitService({
    configService: { getToolsWorkspaceRoot: () => root },
    featureFlagProvider: () => ({ workspace_git: true }),
    logger() {},
  });
}

function compare() {
  return createWorkspaceGitBranchCompare({ now: fixedNow });
}

async function listOf(root, extra = {}) {
  return compare().listBranchChanges({ gitService: gitService(root), root, workspaceId: 'root_a', ...extra });
}

test('the branch list is everything since the merge-base plus uncommitted and untracked work', async (t) => {
  t.after(cleanupTrackedResources);
  const { root, initial } = await createBranchRepo();
  const result = await listOf(root);
  assert.equal(result.state, 'available');
  assert.equal(result.sampled_at, '2026-11-09T12:00:00.000Z');
  assert.equal(result.reason, 'some_files_unmeasured'); // the binary file has no line counts
  const { data } = result;
  assert.equal(data.scope, 'branch');
  assert.equal(data.workspace_id, 'root_a');
  assert.equal(data.base_ref, 'main');
  assert.equal(data.branch, 'feature');
  assert.equal(data.ref, 'feature');
  assert.equal(data.merge_base, initial.slice(0, 9));
  assert.equal(data.commit_count, 2);
  assert.equal(data.truncated, false);
  const byPath = Object.fromEntries(data.files.map((file) => [file.path, file]));
  assert.deepEqual(Object.keys(byPath).sort(), [
    'README.md', 'blob.bin', 'feat.txt', 'fresh.txt', 'gone.txt', 'new-name.txt',
  ]);
  assert.equal(byPath['other.txt'], undefined); // main's own later commit is not on the branch
  assert.deepEqual([byPath['README.md'].change, byPath['README.md'].additions, byPath['README.md'].deletions], ['modified', 1, 0]);
  assert.deepEqual([byPath['feat.txt'].change, byPath['feat.txt'].additions, byPath['feat.txt'].deletions], ['added', 3, 0]);
  assert.deepEqual([byPath['gone.txt'].change, byPath['gone.txt'].additions, byPath['gone.txt'].deletions], ['deleted', 0, 1]);
  assert.deepEqual([byPath['new-name.txt'].change, byPath['new-name.txt'].orig_path], ['renamed', 'old-name.txt']);
  assert.deepEqual([byPath['fresh.txt'].change, byPath['fresh.txt'].additions], ['untracked', 3]);
  assert.deepEqual([byPath['blob.bin'].change, byPath['blob.bin'].binary, byPath['blob.bin'].additions], ['untracked', true, null]);
  assert.equal(data.file_count, 6);
  assert.deepEqual([data.additions, data.deletions], [1 + 3 + 0 + 0 + 3, 1]);
  assert.deepEqual(Object.keys(data).sort(), [
    'additions', 'base_ref', 'branch', 'commit_count', 'deletions', 'file_count', 'files', 'head',
    'merge_base', 'ref', 'scope', 'truncated', 'workspace_id',
  ]);
});

test('being on the base branch, detached, without a base, without commits or without a common ancestor is not applicable', async (t) => {
  t.after(cleanupTrackedResources);
  const { root } = await createBranchRepo();
  await git(root, ['stash', '--include-untracked']);

  await git(root, ['checkout', 'main']);
  const onBase = await listOf(root);
  assert.deepEqual([onBase.state, onBase.reason, onBase.data], ['not_applicable', 'on_base_branch', null]);
  assert.equal(onBase.sampled_at, '2026-11-09T12:00:00.000Z');

  await git(root, ['checkout', '--detach', 'feature']);
  const detached = await listOf(root);
  assert.deepEqual([detached.state, detached.reason, detached.data], ['not_applicable', 'no_base', null]);

  await git(root, ['checkout', 'feature']);
  await git(root, ['checkout', '--orphan', 'lone']);
  await git(root, ['rm', '-rf', '--quiet', '.']);
  await write(root, 'solo.txt', 'unrelated\n');
  await commitAll(root, 'unrelated history');
  const noAncestor = await listOf(root);
  assert.deepEqual([noAncestor.state, noAncestor.reason, noAncestor.data], ['not_applicable', 'no_base', null]);

  await git(root, ['checkout', 'feature']);
  await git(root, ['branch', '-m', 'main', 'trunk-renamed']);
  const noBase = await listOf(root);
  assert.deepEqual([noBase.state, noBase.reason, noBase.data], ['not_applicable', 'no_base', null]);

  const empty = createTrackedTempDir('jenny-branch-compare-empty-');
  await initRepo(empty);
  await write(empty, 'a.txt', 'x\n');
  const unborn = await listOf(empty);
  assert.deepEqual([unborn.state, unborn.reason, unborn.data], ['not_applicable', 'no_base', null]);
});

test('local master is the fallback when there is no main', async (t) => {
  t.after(cleanupTrackedResources);
  const { root } = await createBranchRepo();
  await git(root, ['branch', '-m', 'main', 'master']);
  const result = await listOf(root);
  assert.equal(result.state, 'available');
  assert.equal(result.data.base_ref, 'master');
  assert.equal(result.data.commit_count, 2);
});

test('origin/HEAD outranks local main and shows its bare name; on that branch the checkout is the base', async (t) => {
  t.after(cleanupTrackedResources);
  const { root, initial } = await createBranchRepo();
  await git(root, ['update-ref', 'refs/remotes/origin/trunk', initial]);
  await git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
  const viaOrigin = await listOf(root);
  assert.equal(viaOrigin.state, 'available');
  assert.equal(viaOrigin.data.base_ref, 'trunk');
  assert.equal(viaOrigin.data.merge_base, initial.slice(0, 9));
  assert.equal(viaOrigin.data.commit_count, 2);

  await git(root, ['stash', '--include-untracked']);
  await git(root, ['checkout', '-b', 'trunk', initial]);
  const onTrunk = await listOf(root);
  assert.deepEqual([onTrunk.state, onTrunk.reason], ['not_applicable', 'on_base_branch']);

  // A dangling origin/HEAD falls through to local main.
  await git(root, ['checkout', 'feature']);
  await git(root, ['update-ref', '-d', 'refs/remotes/origin/trunk']);
  const dangling = await listOf(root);
  assert.equal(dangling.data.base_ref, 'main');
});

test('a worktree registry base wins when it exists and is safe, and is ignored otherwise', async (t) => {
  t.after(cleanupTrackedResources);
  const { root } = await createBranchRepo();
  await git(root, ['stash', '--include-untracked']);
  await git(root, ['checkout', '-b', 'develop', 'feature']);
  await write(root, 'dev.txt', 'dev\n');
  await commitAll(root, 'develop work');
  await git(root, ['checkout', '-b', 'topic']);
  await write(root, 'topic.txt', 'topic\n');
  await commitAll(root, 'topic work');

  const viaRegistry = await listOf(root, { registryBase: 'develop' });
  assert.equal(viaRegistry.data.base_ref, 'develop');
  assert.equal(viaRegistry.data.commit_count, 1);
  assert.deepEqual(viaRegistry.data.files.map((file) => file.path), ['topic.txt']);
  const viaMain = await listOf(root);
  assert.equal(viaMain.data.base_ref, 'main');
  assert.equal(viaMain.data.commit_count, 4);

  for (const ignored of ['topic', 'HEAD', 'no-such-branch', '--upload-pack=evil', '../escape', 'refs/heads/../x', 'a b', '']) {
    const result = await listOf(root, { registryBase: ignored });
    assert.equal(result.data.base_ref, 'main', JSON.stringify(ignored));
  }
});

test('registryBaseRef matches the entry by worktree path and ignores blanks', () => {
  const root = path.join(path.resolve('.'), 'wt-a');
  const entries = [
    { id: 'wt_1', worktree_path: path.join(path.resolve('.'), 'wt-b'), base_ref: 'other' },
    { id: 'wt_2', worktree_path: root, base_ref: ' develop ' },
  ];
  assert.equal(registryBaseRef(entries, root), 'develop');
  assert.equal(registryBaseRef(entries, path.join(path.resolve('.'), 'nowhere')), null);
  assert.equal(registryBaseRef([{ worktree_path: root, base_ref: null }], root), null);
  assert.equal(registryBaseRef([{ worktree_path: root }], root), null);
  assert.equal(registryBaseRef(null, root), null);
  assert.equal(registryBaseRef(entries, ''), null);
});

test('parseNameStatus reads plain, rename and copy records', () => {
  assert.deepEqual(parseNameStatus('M\0a.txt\0A\0b.txt\0D\0c.txt\0T\0d.txt\0R087\0old.txt\0new.txt\0C100\0src.txt\0dup.txt\0'), [
    { path: 'a.txt', origPath: null, change: 'modified' },
    { path: 'b.txt', origPath: null, change: 'added' },
    { path: 'c.txt', origPath: null, change: 'deleted' },
    { path: 'd.txt', origPath: null, change: 'type_changed' },
    { path: 'new.txt', origPath: 'old.txt', change: 'renamed' },
    { path: 'dup.txt', origPath: 'src.txt', change: 'copied' },
  ]);
  assert.deepEqual(parseNameStatus(''), []);
});

test('getBranchChangeDiff returns committed, uncommitted, untracked, deleted and renamed diffs', async (t) => {
  t.after(cleanupTrackedResources);
  const { root } = await createBranchRepo();
  const svc = compare();
  const ask = (p) => svc.getBranchChangeDiff({ gitService: gitService(root), root, path: p });

  const readme = await ask('README.md');
  assert.deepEqual([readme.ok, readme.change, readme.binary, readme.truncated], [true, 'modified', false, false]);
  assert.match(readme.diff, /\+four/u);

  const feat = await ask('feat.txt'); // committed as a,b and extended by an uncommitted c
  assert.equal(feat.change, 'added');
  assert.match(feat.diff, /\+a\n\+b\n\+c/u);

  const fresh = await ask('fresh.txt');
  assert.deepEqual([fresh.ok, fresh.change], [true, 'untracked']);
  assert.match(fresh.diff, /^diff --git a\/fresh\.txt b\/fresh\.txt\nnew file mode/u);

  const blob = await ask('blob.bin');
  assert.deepEqual([blob.ok, blob.binary, blob.diff], [true, true, '']);

  const gone = await ask('gone.txt');
  assert.deepEqual([gone.ok, gone.change], [true, 'deleted']);
  assert.match(gone.diff, /-bye/u);

  const renamed = await ask('new-name.txt');
  assert.deepEqual([renamed.ok, renamed.change], [true, 'renamed']);
  assert.match(renamed.diff, /rename from old-name\.txt/u);
});

test('getBranchChangeDiff caps a huge diff at MAX_DIFF_CHARS', async (t) => {
  t.after(cleanupTrackedResources);
  const { root } = await createBranchRepo();
  await write(root, 'huge.txt', `${'x'.repeat(99)}\n`.repeat(3000)); // ~300 KB of added lines
  await commitAll(root, 'huge');
  const result = await compare().getBranchChangeDiff({ gitService: gitService(root), root, path: 'huge.txt' });
  assert.deepEqual([result.ok, result.truncated], [true, true]);
  assert.equal(result.diff.length, MAX_DIFF_CHARS);
});

test('a path outside the branch list is refused: main-only, unchanged, traversal, absolute, or no comparison', async (t) => {
  t.after(cleanupTrackedResources);
  const { root } = await createBranchRepo();
  const svc = compare();
  const service = gitService(root);
  for (const candidate of ['other.txt', 'nope.txt', '../README.md', '/etc/passwd', 'C:\\Windows\\win.ini', 'README.md/..', '']) {
    const result = await svc.getBranchChangeDiff({ gitService: service, root, path: candidate });
    assert.deepEqual([result.ok, result.reason], [false, 'path_not_changed'], JSON.stringify(candidate));
  }
  await git(root, ['stash', '--include-untracked']);
  await git(root, ['checkout', 'main']);
  const onBase = await svc.getBranchChangeDiff({ gitService: service, root, path: 'other.txt' });
  assert.deepEqual([onBase.ok, onBase.reason], [false, 'path_not_changed']);
  const noWorkspace = await svc.getBranchChangeDiff({ gitService: service, root: null, path: 'README.md' });
  assert.deepEqual([noWorkspace.ok, noWorkspace.reason], [false, 'no_workspace']);
  const noService = await svc.listBranchChanges({ gitService: null, root });
  assert.deepEqual([noService.state, noService.reason], ['unavailable', 'no_workspace']);
});

test('a listed path that resolves outside the root through a link is refused before any read', async (t) => {
  t.after(cleanupTrackedResources);
  const { root } = await createBranchRepo();
  const outside = createTrackedTempDir('jenny-branch-outside-');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'top\nsecret\n', 'utf8');
  linkDirectory(outside, path.join(root, 'jdir'));
  const real = gitService(root);
  // Deterministic on every platform: a status list that names a path behind the junction.
  const lying = {
    getStatus: async (args) => {
      const status = await real.getStatus(args);
      return {
        ...status,
        files: [...status.files, { path: 'jdir/secret.txt', origPath: null, index: '?', worktree: '?', state: 'untracked', staged: false }],
      };
    },
  };
  const svc = compare();
  const escaped = await svc.getBranchChangeDiff({ gitService: lying, root, path: 'jdir/secret.txt' });
  assert.deepEqual([escaped.ok, escaped.reason], [false, 'path_outside_workspace']);

  const skip = fileSymlinkSkip();
  if (skip) {
    t.diagnostic(`file symlink escape skipped: ${skip}`);
    return;
  }
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'), 'file');
  await commitAll(root, 'commit a link that points outside');
  const list = await svc.listBranchChanges({ gitService: real, root });
  assert.ok(list.data.files.some((file) => file.path === 'link.txt'));
  const link = await svc.getBranchChangeDiff({ gitService: real, root, path: 'link.txt' });
  assert.deepEqual([link.ok, link.reason], [false, 'path_outside_workspace']);
});

test('the listing is capped and says so; counts degrade honestly when a git read fails', async (t) => {
  t.after(cleanupTrackedResources);
  const { root } = await createBranchRepo();
  for (let i = 0; i < 520; i += 1) await write(root, `many/f${String(i).padStart(4, '0')}.txt`, `${i}\n`);
  await commitAll(root, 'many files');
  const result = await listOf(root);
  assert.equal(result.state, 'available');
  assert.equal(result.data.files.length, 500);
  assert.equal(result.data.truncated, true);
  assert.equal(result.data.file_count, 500);

  const failing = createWorkspaceGitBranchCompare({
    now: fixedNow,
    exec: async (cwd, args, options) => {
      if (args.includes('--numstat')) return { success: false, reason: 'git_failed', stdout: '', stderr: 'boom', message: 'boom' };
      return require('../services/workspace-git-executor').runWorkspaceGit(cwd, args, options);
    },
  });
  const degraded = await failing.listBranchChanges({ gitService: gitService(root), root });
  assert.equal(degraded.state, 'available');
  assert.equal(degraded.reason, 'counts_unavailable');

  const broken = createWorkspaceGitBranchCompare({
    now: fixedNow,
    exec: async (cwd, args, options) => {
      if (args.includes('--name-status')) throw new Error('spawn exploded at C:\\secret');
      return require('../services/workspace-git-executor').runWorkspaceGit(cwd, args, options);
    },
  });
  const failed = await broken.listBranchChanges({ gitService: gitService(root), root });
  assert.deepEqual([failed.state, failed.reason, failed.data], ['unavailable', 'git_failed', null]);
  assert.doesNotMatch(JSON.stringify(failed), /secret|exploded/u);
});

test('the branch read never writes: refs, index and the working tree are untouched', async (t) => {
  t.after(cleanupTrackedResources);
  const { root } = await createBranchRepo();
  const snapshot = async () => ({
    refs: await git(root, ['for-each-ref']),
    status: await git(root, ['status', '--porcelain=v1', '--untracked-files=all']),
    index: await git(root, ['ls-files', '--stage']),
  });
  const before = await snapshot();
  await listOf(root);
  await compare().getBranchChangeDiff({ gitService: gitService(root), root, path: 'README.md' });
  assert.deepEqual(await snapshot(), before);
});
