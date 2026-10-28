'use strict';

/* Real-git coverage of the working-tree change reads behind the chat workspace
 * rail (row 59 checkpoint 2): status-derived file list, numstat totals with
 * unmeasurable files excluded, bounded untracked reads, and the getChangeDiff
 * path boundary (traversal, absolute, not-in-status, symlink/junction escape). */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { WorkspaceGitService } = require('../services/workspace-git-service');
const {
  MAX_DIFF_CHARS,
  MAX_UNTRACKED_FILE_BYTES,
  countLines,
  createWorkspaceGitChangeSummary,
  isInside,
  parseNumstat,
  resolveContained,
  synthesizeAdditionDiff,
} = require('../services/workspace-git-change-summary');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');
const { fileSymlinkSkip, linkDirectory } = require('./helpers/platform-skips');

const execFileAsync = promisify(execFile);

function git(cwd, args) {
  return execFileAsync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
}

async function createRepo({ commit = true } = {}) {
  const root = createTrackedTempDir('jenny-chatws-git-');
  await git(root, ['init']);
  await git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await git(root, ['config', 'user.email', 'jenny@example.invalid']);
  await git(root, ['config', 'user.name', 'Jenny Tests']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  if (commit) {
    await fs.writeFile(path.join(root, 'README.md'), 'one\ntwo\nthree\n', 'utf8');
    await fs.writeFile(path.join(root, 'gone.txt'), 'bye\n', 'utf8');
    await fs.writeFile(path.join(root, 'old-name.txt'), 'rename me\nline two\nline three\nline four\n', 'utf8');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'initial']);
  }
  return root;
}

function gitService(root, { flag = true } = {}) {
  return new WorkspaceGitService({
    configService: { getToolsWorkspaceRoot: () => root },
    featureFlagProvider: () => ({ workspace_git: flag }),
    logger() {},
  });
}

const fixedNow = () => new Date('2026-10-15T12:00:00.000Z');

test('parseNumstat reads plain, binary and rename records', () => {
  const parsed = parseNumstat('3\t1\ta.txt\0-\t-\timg.png\0\0\0'
    + '2\t2\t\0old.txt\0new.txt\0');
  assert.deepEqual(parsed.get('a.txt'), { binary: false, additions: 3, deletions: 1 });
  assert.deepEqual(parsed.get('img.png'), { binary: true, additions: null, deletions: null });
  assert.deepEqual(parsed.get('new.txt'), { binary: false, additions: 2, deletions: 2 });
  assert.equal(parsed.has('old.txt'), false);
  assert.equal(parseNumstat('').size, 0);
});

test('line counting and the synthesized addition diff are exact', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a\n'), 1);
  assert.equal(countLines('a\nb'), 2);
  const diff = synthesizeAdditionDiff('x.txt', 'a\nb\n');
  assert.match(diff, /^diff --git a\/x\.txt b\/x\.txt\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/x\.txt\n@@ -0,0 \+1,2 @@\n\+a\n\+b\n$/u);
  assert.equal(synthesizeAdditionDiff('e.txt', '').includes('@@'), false);
});

test('listChanges reports files, per-file counts and totals; binary files are excluded from totals', async (t) => {
  t.after(cleanupTrackedResources);
  const root = await createRepo();
  await fs.writeFile(path.join(root, 'README.md'), 'one\nTWO\nthree\nfour\n', 'utf8'); // +2 -1
  await fs.rm(path.join(root, 'gone.txt'));
  await git(root, ['mv', 'old-name.txt', 'new-name.txt']);
  await fs.writeFile(path.join(root, 'new-name.txt'), 'rename me\nline two\nline three\nLINE FOUR\n', 'utf8'); // +1 -1
  await git(root, ['add', 'new-name.txt']);
  await fs.writeFile(path.join(root, 'fresh.txt'), 'a\nb\nc\n', 'utf8'); // untracked +3
  await fs.writeFile(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  const svc = createWorkspaceGitChangeSummary({ now: fixedNow });
  const result = await svc.listChanges({ gitService: gitService(root), root, workspaceId: 'root_abc' });

  assert.equal(result.state, 'available');
  assert.equal(result.sampled_at, '2026-10-15T12:00:00.000Z');
  assert.equal(result.reason, 'some_files_unmeasured');
  const data = result.data;
  assert.equal(data.workspace_id, 'root_abc');
  assert.equal(data.scope, 'working_tree');
  assert.equal(data.branch, 'main');
  assert.equal(data.ref, 'main');
  assert.match(data.head, /^[0-9a-f]{4,}$/u);
  assert.equal(data.truncated, false);
  const byPath = Object.fromEntries(data.files.map((file) => [file.path, file]));
  assert.deepEqual(Object.keys(byPath).sort(), ['README.md', 'blob.bin', 'fresh.txt', 'gone.txt', 'new-name.txt']);
  assert.deepEqual([byPath['README.md'].additions, byPath['README.md'].deletions, byPath['README.md'].change], [2, 1, 'modified']);
  assert.deepEqual([byPath['gone.txt'].additions, byPath['gone.txt'].deletions, byPath['gone.txt'].change], [0, 1, 'deleted']);
  assert.equal(byPath['new-name.txt'].change, 'renamed');
  assert.equal(byPath['new-name.txt'].orig_path, 'old-name.txt');
  assert.deepEqual([byPath['new-name.txt'].additions, byPath['new-name.txt'].deletions], [1, 1]);
  assert.deepEqual([byPath['fresh.txt'].additions, byPath['fresh.txt'].deletions, byPath['fresh.txt'].change], [3, 0, 'untracked']);
  assert.equal(byPath['blob.bin'].binary, true);
  assert.equal(byPath['blob.bin'].additions, null);
  assert.equal(byPath['blob.bin'].deletions, null);
  assert.equal(data.file_count, 5);
  assert.equal(data.additions, 2 + 0 + 1 + 3);
  assert.equal(data.deletions, 1 + 1 + 1 + 0);
});

test('a clean repo has zero files and known zero totals; an unborn repo reports its branch with a null head', async (t) => {
  t.after(cleanupTrackedResources);
  const clean = await createRepo();
  const svc = createWorkspaceGitChangeSummary({ now: fixedNow });
  const cleanResult = await svc.listChanges({ gitService: gitService(clean), root: clean, workspaceId: 'w' });
  assert.equal(cleanResult.state, 'available');
  assert.equal(cleanResult.reason, null);
  assert.deepEqual([cleanResult.data.file_count, cleanResult.data.additions, cleanResult.data.deletions], [0, 0, 0]);

  const unborn = await createRepo({ commit: false });
  await fs.writeFile(path.join(unborn, 'a.txt'), 'x\ny\n', 'utf8');
  await git(unborn, ['add', 'a.txt']);
  const unbornResult = await svc.listChanges({ gitService: gitService(unborn), root: unborn, workspaceId: 'w' });
  assert.equal(unbornResult.state, 'available');
  assert.equal(unbornResult.data.head, null);
  assert.equal(unbornResult.data.branch, 'main');
  assert.equal(unbornResult.data.files[0].change, 'added');
  assert.deepEqual([unbornResult.data.files[0].additions, unbornResult.data.files[0].deletions], [2, 0]);
});

test('non-Git, disabled and rootless workspaces degrade to states, never zero counts', async (t) => {
  t.after(cleanupTrackedResources);
  const plain = createTrackedTempDir('jenny-chatws-plain-');
  const svc = createWorkspaceGitChangeSummary({ now: fixedNow });
  const notRepo = await svc.listChanges({ gitService: gitService(plain), root: plain });
  assert.deepEqual([notRepo.state, notRepo.reason, notRepo.data], ['not_applicable', 'not_a_git_repository', null]);
  const repo = await createRepo();
  const disabled = await svc.listChanges({ gitService: gitService(repo, { flag: false }), root: repo });
  assert.deepEqual([disabled.state, disabled.reason, disabled.data], ['unavailable', 'feature_disabled', null]);
  const rootless = await svc.listChanges({ gitService: gitService(''), root: '' });
  assert.deepEqual([rootless.state, rootless.reason, rootless.data], ['unavailable', 'no_workspace', null]);
  const noRoot = await svc.listChanges({ gitService: gitService(''), root: repo });
  assert.deepEqual([noRoot.state, noRoot.reason], ['unavailable', 'no_workspace']);
});

test('an untracked file over the read bound is unmeasured, not zero, and its diff is truncated', async (t) => {
  t.after(cleanupTrackedResources);
  const root = await createRepo();
  const big = `${'x'.repeat(99)}\n`.repeat(Math.ceil(MAX_UNTRACKED_FILE_BYTES / 100) + 50);
  await fs.writeFile(path.join(root, 'big.txt'), big, 'utf8');
  const svc = createWorkspaceGitChangeSummary({ now: fixedNow });
  const list = await svc.listChanges({ gitService: gitService(root), root });
  const entry = list.data.files.find((file) => file.path === 'big.txt');
  assert.deepEqual([entry.additions, entry.deletions, entry.binary], [null, null, false]);
  assert.equal(list.data.additions, null);
  const diff = await svc.getChangeDiff({ gitService: gitService(root), root, path: 'big.txt' });
  assert.equal(diff.ok, true);
  assert.equal(diff.truncated, true);
  assert.ok(diff.diff.length <= MAX_DIFF_CHARS);
  assert.match(diff.diff, /^diff --git a\/big\.txt b\/big\.txt\nnew file mode/u);
});

test('getChangeDiff returns tracked, deleted, renamed, untracked and binary diffs for status-listed paths', async (t) => {
  t.after(cleanupTrackedResources);
  const root = await createRepo();
  await fs.writeFile(path.join(root, 'README.md'), 'one\nTWO\nthree\n', 'utf8');
  await fs.rm(path.join(root, 'gone.txt'));
  await git(root, ['mv', 'old-name.txt', 'new-name.txt']);
  await fs.writeFile(path.join(root, 'new text.txt'), 'hello\nworld', 'utf8');
  await fs.writeFile(path.join(root, 'a[1].txt'), 'bracket\n', 'utf8');
  await fs.writeFile(path.join(root, 'a1.txt'), 'plain\n', 'utf8');
  await fs.writeFile(path.join(root, 'blob.bin'), Buffer.from([0, 9, 9, 0]));
  const svc = createWorkspaceGitChangeSummary({ now: fixedNow });
  const service = gitService(root);
  const call = (p) => svc.getChangeDiff({ gitService: service, root, path: p });

  const modified = await call('README.md');
  assert.deepEqual([modified.ok, modified.change, modified.binary, modified.truncated], [true, 'modified', false, false]);
  assert.match(modified.diff, /^-two$/mu);
  assert.match(modified.diff, /^\+TWO$/mu);

  const deleted = await call('gone.txt');
  assert.equal(deleted.change, 'deleted');
  assert.match(deleted.diff, /^-bye$/mu);

  const renamed = await call('new-name.txt');
  assert.equal(renamed.change, 'renamed');
  assert.match(renamed.diff, /rename from old-name\.txt/u);

  const untracked = await call('new text.txt');
  assert.equal(untracked.change, 'untracked');
  assert.match(untracked.diff, /@@ -0,0 \+1,2 @@\n\+hello\n\+world\n$/u);

  const binary = await call('blob.bin');
  assert.deepEqual([binary.ok, binary.binary, binary.diff], [true, true, '']);

  // A literal path: the bracket name addresses only itself (tracked-side check).
  await git(root, ['add', 'a[1].txt', 'a1.txt']);
  const bracket = await call('a[1].txt');
  assert.match(bracket.diff, /^\+bracket$/mu);
  assert.doesNotMatch(bracket.diff, /plain/u);
});

test('getChangeDiff refuses traversal, absolute, drive, not-in-status and NUL paths without reading', async (t) => {
  t.after(cleanupTrackedResources);
  const root = await createRepo();
  const outside = createTrackedTempDir('jenny-chatws-outside-');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret\n', 'utf8');
  await fs.writeFile(path.join(root, 'changed.txt'), 'x\n', 'utf8');
  let reads = 0;
  const countingFs = new Proxy(fs, {
    get(target, prop) {
      if (prop === 'open' || prop === 'readFile') reads += 1;
      return target[prop];
    },
  });
  const svc = createWorkspaceGitChangeSummary({ fs: countingFs, now: fixedNow });
  const service = gitService(root);
  const bad = [
    '../secret.txt',
    `..${path.sep}${path.basename(outside)}${path.sep}secret.txt`,
    path.join(outside, 'secret.txt'),
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    'sub/../changed.txt',
    './changed.txt',
    'README.md', // tracked but unchanged: not in the status list
    'does-not-exist.txt',
    'changed.txt\0',
    '',
  ];
  for (const candidate of bad) {
    const result = await svc.getChangeDiff({ gitService: service, root, path: candidate });
    assert.equal(result.ok, false, JSON.stringify(candidate));
    assert.equal(result.reason, 'path_not_changed', JSON.stringify(candidate));
  }
  assert.equal(reads, 0);
  const ok = await svc.getChangeDiff({ gitService: service, root, path: 'changed.txt' });
  assert.equal(ok.ok, true);
});

test('a status-listed path that resolves outside the root through a link is refused before any read', async (t) => {
  t.after(cleanupTrackedResources);
  const root = await createRepo();
  const outside = createTrackedTempDir('jenny-chatws-outside-');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'one\ntwo\nthree\nfour\nfive\n', 'utf8');
  const links = ['jdir'];
  linkDirectory(outside, path.join(root, 'jdir'));
  // File symlinks need Developer Mode or an elevated token on Windows; the
  // junction above always runs, the file link adds coverage where it is possible.
  if (!fileSymlinkSkip()) {
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'), 'file');
    links.push('link.txt');
  }
  let opens = 0;
  const watchingFs = new Proxy(fs, {
    get(target, prop) {
      if (prop === 'open' || prop === 'readFile') opens += 1;
      return target[prop];
    },
  });
  const svc = createWorkspaceGitChangeSummary({ fs: watchingFs, now: fixedNow });
  const escapes = [];
  if (links.includes('jdir')) escapes.push('jdir/secret.txt');
  if (links.includes('link.txt')) escapes.push('link.txt');
  // Deterministic: a status list that (as git may on some platforms) names a path
  // behind the link must still be refused by the real-path containment.
  const lying = {
    getStatus: async () => ({
      ok: true,
      branch: 'main',
      detached: false,
      files: escapes.map((p) => ({ path: p, origPath: null, index: '?', worktree: '?', state: 'untracked', staged: false })),
    }),
  };
  for (const candidate of escapes) {
    const result = await svc.getChangeDiff({ gitService: lying, root, path: candidate });
    assert.deepEqual([result.ok, result.reason], [false, 'path_outside_workspace'], candidate);
  }
  assert.equal(opens, 0);

  // Real git: whatever the platform lists for the links, nothing outside is measured or leaked.
  const list = await svc.listChanges({ gitService: gitService(root), root });
  const linked = list.data.files.filter((file) => file.path === 'jdir' || file.path.startsWith('jdir/') || file.path === 'link.txt');
  for (const file of linked) {
    assert.equal(file.additions, null, file.path);
    const diff = await svc.getChangeDiff({ gitService: gitService(root), root, path: file.path });
    if (diff.ok) assert.doesNotMatch(diff.diff, /top|one\n|five/u);
  }
  assert.equal(opens, 0);
});

test('resolveContained resolves a deleted leaf through its parent and refuses escapes', async (t) => {
  t.after(cleanupTrackedResources);
  const root = await createRepo();
  await fs.mkdir(path.join(root, 'sub'));
  const inside = await resolveContained(root, 'sub/missing.txt');
  assert.equal(inside.ok, true);
  assert.equal(inside.exists, false);
  assert.ok(isInside(inside.rootReal, inside.real));
  const outside = createTrackedTempDir('jenny-chatws-outside-');
  linkDirectory(outside, path.join(root, 'out'));
  const escaped = await resolveContained(root, 'out/never-created.txt');
  assert.deepEqual([escaped.ok, escaped.reason], [false, 'path_outside_workspace']);
});
