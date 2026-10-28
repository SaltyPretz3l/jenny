'use strict';
// WorkspaceGitService row 82 G1/G2 verbs (services/workspace-git-service-extras.js):
// index/commit reads, commit file lists, stash list/apply/drop, branch -d, commit
// --amend / -s, and the single-file `apply --cached` patch gate. Own copy of the
// tiny repo/service fixtures (the service suites sit at the 600-line test ratchet).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { WorkspaceGitService, WRITE_VERBS, assertWriteVerb } = require('../services/workspace-git-service');
const { validateSingleFilePatch } = require('../services/workspace-git-service-extras');
const { runWorkspaceGit } = require('../services/workspace-git-executor');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');
const { linkDirectory } = require('./helpers/platform-skips');

const execFileAsync = promisify(execFile);

function git(cwd, args) {
  return execFileAsync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
}

async function createGitRepo() {
  const repoRoot = createTrackedTempDir('jenny-workspace-git-extras-');
  await git(repoRoot, ['init']);
  await git(repoRoot, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await git(repoRoot, ['config', 'user.email', 'jenny@example.invalid']);
  await git(repoRoot, ['config', 'user.name', 'Jenny Tests']);
  await git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  await git(repoRoot, ['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(repoRoot, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');
  await git(repoRoot, ['add', 'a.txt']);
  await git(repoRoot, ['commit', '-m', 'initial']);
  return repoRoot;
}

function createService(root, { flag = true, exec, trashItemImpl = null } = {}) {
  return new WorkspaceGitService({
    configService: { getToolsWorkspaceRoot: () => root },
    featureFlagProvider: () => ({ workspace_git: flag }),
    ...(exec ? { exec } : {}),
    trashItemImpl,
    logger() {},
  });
}

const read = (root, rel) => fs.readFile(path.join(root, rel), 'utf8');
const headHash = async (root) => (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();

test.afterEach(async () => {
  await cleanupTrackedResources();
});

describe('reads (row 82 G1)', () => {
  test('getFileAtIndex returns the staged content, not the working tree or HEAD', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'a.txt'), 'one\nSTAGED\nthree\n', 'utf8');
    await git(repo, ['add', 'a.txt']);
    await fs.writeFile(path.join(repo, 'a.txt'), 'one\nWORKING\nthree\n', 'utf8');
    const res = await createService(repo).getFileAtIndex({ path: 'a.txt' });
    assert.equal(res.ok, true);
    assert.equal(res.op, 'getFileAtIndex');
    assert.equal(res.found, true);
    assert.equal(res.content, 'one\nSTAGED\nthree\n');
  });

  test('getFileAtIndex reports an untracked or missing path as found:false', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'new.txt'), 'x\n', 'utf8');
    const svc = createService(repo);
    const untracked = await svc.getFileAtIndex({ path: 'new.txt' });
    assert.equal(untracked.ok, true);
    assert.equal(untracked.found, false);
    assert.equal(untracked.reason, 'not_in_index');
    assert.equal((await svc.getFileAtIndex({ path: 'nope.txt' })).found, false);
    await assert.rejects(() => svc.getFileAtIndex({ path: '../escape.txt' }), /inside the workspace/);
  });

  test('getFileAtCommit reads a commit and its parent; a root commit has no parent', async () => {
    const repo = await createGitRepo();
    const first = await headHash(repo);
    await fs.writeFile(path.join(repo, 'a.txt'), 'one\n2\nthree\n', 'utf8');
    await git(repo, ['commit', '-am', 'second']);
    const second = await headHash(repo);
    const svc = createService(repo);
    assert.equal((await svc.getFileAtCommit({ hash: second, path: 'a.txt' })).content, 'one\n2\nthree\n');
    assert.equal((await svc.getFileAtCommit({ hash: second, path: 'a.txt', parent: true })).content, 'one\ntwo\nthree\n');
    const root = await svc.getFileAtCommit({ hash: first, path: 'a.txt', parent: true });
    assert.equal(root.found, false);
    assert.equal(root.reason, 'no_parent');
    const missing = await svc.getFileAtCommit({ hash: second, path: 'nope.txt' });
    assert.equal(missing.found, false);
    assert.equal(missing.reason, 'not_in_commit');
    await assert.rejects(() => svc.getFileAtCommit({ hash: '--all', path: 'a.txt' }), /Invalid commit hash/);
  });

  test('getCommitFiles lists the files a commit touched with their status', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'b.txt'), 'b\n', 'utf8');
    await fs.writeFile(path.join(repo, 'a.txt'), 'changed\n', 'utf8');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'two files']);
    const res = await createService(repo).getCommitFiles({ hash: await headHash(repo) });
    assert.equal(res.ok, true);
    assert.deepEqual(res.files, [
      { status: 'M', path: 'a.txt', origPath: '' },
      { status: 'A', path: 'b.txt', origPath: '' },
    ]);
  });

  test('getLastCommitMessage returns the full message for an amend prefill', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'a.txt'), 'x\n', 'utf8');
    await git(repo, ['commit', '-am', 'Subject line\n\nBody paragraph.']);
    const res = await createService(repo).getLastCommitMessage();
    assert.equal(res.ok, true);
    assert.equal(res.found, true);
    assert.equal(res.message, 'Subject line\n\nBody paragraph.');
  });
});

describe('stash list / apply / pop / drop (row 82 G1)', () => {
  async function twoStashes() {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'a.txt'), 'first edit\n', 'utf8');
    await git(repo, ['stash', 'push', '-m', 'first']);
    await fs.writeFile(path.join(repo, 'a.txt'), 'second edit\n', 'utf8');
    await git(repo, ['stash', 'push', '-m', 'second']);
    return repo;
  }

  test('listStashes returns newest first with index, ref and subject', async () => {
    const repo = await twoStashes();
    const res = await createService(repo).listStashes();
    assert.equal(res.ok, true);
    assert.deepEqual(res.stashes.map((entry) => [entry.index, entry.ref, entry.subject]), [
      [0, 'stash@{0}', 'On main: second'],
      [1, 'stash@{1}', 'On main: first'],
    ]);
    assert.match(res.stashes[0].sha, /^[0-9a-f]{40}$/);
  });

  test('apply keeps the entry, drop removes it, pop by index applies and removes', async () => {
    const repo = await twoStashes();
    const svc = createService(repo);
    const applied = await svc.stash({ op: 'apply', index: 1 });
    assert.equal(applied.ok, true);
    assert.equal(applied.operation, 'apply');
    assert.equal(await read(repo, 'a.txt'), 'first edit\n');
    assert.equal((await svc.listStashes()).stashes.length, 2);
    await git(repo, ['checkout', '--', 'a.txt']);
    assert.equal((await svc.stash({ op: 'drop', index: 0 })).ok, true);
    const left = (await svc.listStashes()).stashes;
    assert.deepEqual(left.map((entry) => entry.subject), ['On main: first']);
    assert.equal((await svc.stash({ op: 'pop', index: 0 })).stashed, true);
    assert.equal(await read(repo, 'a.txt'), 'first edit\n');
    assert.equal((await svc.listStashes()).stashes.length, 0);
  });

  test('a stash index must be a small non-negative integer', async () => {
    const repo = await twoStashes();
    const svc = createService(repo);
    for (const index of [-1, 1.5, 'stash@{0}', '0; rm', 1000]) {
      await assert.rejects(() => svc.stash({ op: 'drop', index }), /Invalid stash entry/, String(index));
    }
  });
});

describe('branch -d (row 82 G1)', () => {
  test('deletes a merged branch and refuses an unmerged one (never -D)', async () => {
    const repo = await createGitRepo();
    await git(repo, ['branch', 'merged']);
    await git(repo, ['checkout', '-b', 'unmerged']);
    await fs.writeFile(path.join(repo, 'u.txt'), 'u\n', 'utf8');
    await git(repo, ['add', 'u.txt']);
    await git(repo, ['commit', '-m', 'unmerged work']);
    await git(repo, ['checkout', 'main']);
    const svc = createService(repo);
    const deleted = await svc.deleteBranch({ name: 'merged' });
    assert.equal(deleted.ok, true);
    assert.equal(deleted.deleted, true);
    const refused = await svc.deleteBranch({ name: 'unmerged' });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'not_fully_merged');
    const branches = (await git(repo, ['branch', '--list', '--format=%(refname:short)'])).stdout;
    assert.match(branches, /unmerged/);
    assert.doesNotMatch(branches, /^merged$/m);
    await assert.rejects(() => svc.deleteBranch({ name: '-D' }), /Invalid branch/);
  });

  test('the branch argv is exactly branch -d -- <name>', async () => {
    const repo = await createGitRepo();
    const seen = [];
    const exec = async (cwd, args) => {
      if (args.includes('--is-inside-work-tree')) return { success: true, stdout: `true\n${repo}\n` };
      if (args.includes('--show-toplevel')) return { success: true, stdout: `${repo}\n` };
      seen.push(args);
      return { success: true, stdout: '', stderr: '' };
    };
    await createService(repo, { exec }).deleteBranch({ name: 'topic/x' });
    assert.deepEqual(seen, [['branch', '-d', '--', 'topic/x']]);
  });
});

describe('commit --amend / -s (row 82 G1)', () => {
  test('amend rewrites the last commit message without adding a commit', async () => {
    const repo = await createGitRepo();
    const svc = createService(repo);
    const res = await svc.commit({ message: 'initial, reworded', amend: true });
    assert.equal(res.ok, true);
    assert.equal(res.committed, true);
    assert.equal((await git(repo, ['rev-list', '--count', 'HEAD'])).stdout.trim(), '1');
    assert.equal((await git(repo, ['log', '-1', '--format=%s'])).stdout.trim(), 'initial, reworded');
  });

  test('sign-off appends a Signed-off-by trailer', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'a.txt'), 'signed\n', 'utf8');
    await git(repo, ['add', 'a.txt']);
    assert.equal((await createService(repo).commit({ message: 'signed', signoff: true })).committed, true);
    assert.match((await git(repo, ['log', '-1', '--format=%B'])).stdout, /Signed-off-by: Jenny Tests <jenny@example\.invalid>/);
  });

  test('only literal true turns on amend or sign-off', async () => {
    const repo = await createGitRepo();
    const seen = [];
    const exec = async (cwd, args) => {
      if (args.includes('--is-inside-work-tree')) return { success: true, stdout: `true\n${repo}\n` };
      if (args.includes('--show-toplevel')) return { success: true, stdout: `${repo}\n` };
      seen.push(args);
      return { success: true, stdout: '[main abc1234] m', stderr: '' };
    };
    const svc = createService(repo, { exec });
    await svc.commit({ message: 'm', amend: 'yes', signoff: 1 });
    await svc.commit({ message: 'm', amend: true, signoff: true });
    assert.deepEqual(seen, [['commit', '-m', 'm'], ['commit', '--amend', '-s', '-m', 'm']]);
  });
});

function hunkPatch(file, body) {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${body}`;
}

describe('apply --cached (row 82 G2)', () => {
  test('stages exactly the patched hunk and leaves the working tree alone', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'a.txt'), 'ONE\ntwo\nTHREE\n', 'utf8');
    const patch = hunkPatch('a.txt', '@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n');
    const res = await createService(repo).applyPatch({ patch, cached: true });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.path, 'a.txt');
    assert.equal((await git(repo, ['show', ':a.txt'])).stdout, 'ONE\ntwo\nthree\n');
    assert.equal(await read(repo, 'a.txt'), 'ONE\ntwo\nTHREE\n');
  });

  test('refuses --3way, a worktree apply, and unknown options before git runs', async () => {
    const repo = await createGitRepo();
    let applies = 0;
    const exec = async (cwd, args) => {
      if (args.includes('--is-inside-work-tree')) return { success: true, stdout: `true\n${repo}\n` };
      if (args.includes('--show-toplevel')) return { success: true, stdout: `${repo}\n` };
      if (args[0] === 'apply') applies += 1;
      return { success: true, stdout: '', stderr: '' };
    };
    const svc = createService(repo, { exec });
    const patch = hunkPatch('a.txt', '@@ -1 +1 @@\n-one\n+ONE\n');
    await assert.rejects(() => svc.applyPatch({ patch, cached: true, threeWay: true }), /3-way/);
    await assert.rejects(() => svc.applyPatch({ patch, cached: true, args: ['--3way'] }), /3-way|option/);
    await assert.rejects(() => svc.applyPatch({ patch }), /index/);
    assert.equal(applies, 0);
  });

  test('the validator accepts one file and refuses every other patch shape', () => {
    const ok = validateSingleFilePatch(hunkPatch('src/a b.txt', '@@ -2,3 +2,4 @@\n x\n-y\n+Y\n+Z\n z\n\\ No newline at end of file\n'));
    assert.equal(ok.path, 'src/a b.txt');
    const refusals = [
      ['two files', hunkPatch('a.txt', '@@ -1 +1 @@\n-a\n+b\n') + '--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-a\n+b\n', /one file/],
      ['rename', 'diff --git a/a.txt b/c.txt\nsimilarity index 90%\nrename from a.txt\nrename to c.txt\n', /rename/i],
      ['renamed paths', '--- a/a.txt\n+++ b/c.txt\n@@ -1 +1 @@\n-a\n+b\n', /rename|same file/i],
      ['binary', 'diff --git a/i.png b/i.png\nindex 1..2 100644\nGIT binary patch\nliteral 3\n', /binary/i],
      ['binary notice', 'diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n', /binary/i],
      ['new file', '--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+n\n', /create|delete/i],
      ['deleted file', '--- a/a.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n', /create|delete/i],
      ['mode change', 'diff --git a/a.txt b/a.txt\nold mode 100644\nnew mode 100755\n', /header|mode/i],
      ['no hunk', '--- a/a.txt\n+++ b/a.txt\n', /hunk/i],
      ['short hunk', '--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n-a\n+b\n', /hunk/i],
      ['junk body', '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n*junk\n', /unexpected/i],
      ['quoted path', '--- "a/a\\ttab"\n+++ "b/a\\ttab"\n@@ -1 +1 @@\n-a\n+b\n', /quoted|path/i],
      ['nul', '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\0\n+b\n', /NUL/],
      // git cuts a header name at a tab: `f\tg` would validate while git patches `f`.
      ['tab in path', '--- a/f\tg\n+++ b/f\tg\n@@ -1 +1 @@\n-a\n+b\n', /control/],
      ['tab in diff --git', 'diff --git a/f\tg b/f\tg\n--- a/f\tg\n+++ b/f\tg\n@@ -1 +1 @@\n-a\n+b\n', /control/],
      ['carriage return in path', '--- a/f\r\n+++ b/f\r\n@@ -1 +1 @@\n-a\n+b\n', /control/],
      ['oversize', '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+' + 'b'.repeat(1024 * 1024) + '\n', /too large/],
    ];
    for (const [name, patch, pattern] of refusals) {
      assert.throws(() => validateSingleFilePatch(patch), (error) => {
        assert.equal(error.code, 'CMP-GIT-0410', name);
        assert.match(error.message, pattern, name);
        return true;
      }, name);
    }
  });

  test('the +++ target must stay inside the root (lexical and junction escapes)', async () => {
    const repo = await createGitRepo();
    const outside = createTrackedTempDir('jenny-workspace-git-extras-outside-');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'one\n', 'utf8');
    linkDirectory(outside, path.join(repo, 'link'));
    const svc = createService(repo);
    await assert.rejects(() => svc.applyPatch({ cached: true, patch: hunkPatch('../x.txt', '@@ -1 +1 @@\n-a\n+b\n') }), /inside the workspace/);
    await assert.rejects(() => svc.applyPatch({ cached: true, patch: hunkPatch('link/secret.txt', '@@ -1 +1 @@\n-one\n+two\n') }), /outside the workspace root/);
  });

  test('a disabled feature degrades before any validation or spawn', async () => {
    const repo = await createGitRepo();
    let spawned = 0;
    const svc = createService(repo, { flag: false, exec: async () => { spawned += 1; return { success: true, stdout: '' }; } });
    const results = await Promise.all([
      svc.applyPatch({ patch: 'junk', cached: true }), svc.deleteBranch({ name: 'x' }),
      svc.getFileAtIndex({ path: 'a.txt' }), svc.getFileAtCommit({ hash: 'a'.repeat(40), path: 'a.txt' }),
      svc.getCommitFiles({ hash: 'a'.repeat(40) }), svc.listStashes(), svc.getLastCommitMessage(),
      svc.stash({ op: 'drop', index: 0 }),
    ]);
    for (const res of results) assert.equal(res.reason, 'feature_disabled', res.op);
    assert.equal(spawned, 0);
  });
});

describe('cleanup wave G2/G3: blameFile and discardFiles', () => {
  test('blameFile blames every HEAD line of a file in one spawn', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\n', 'utf8');
    await git(repo, ['commit', '-am', 'second']);
    const spawned = [];
    const exec = (cwd, args, opts) => { spawned.push(args[0]); return runWorkspaceGit(cwd, args, opts); };
    const res = await createService(repo, { exec }).blameFile({ path: 'a.txt' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.found, true);
    assert.deepEqual(res.lines.map((line) => [line.line, line.summary]), [[1, 'initial'], [2, 'second'], [3, 'initial'], [4, 'second']]);
    assert.deepEqual(spawned, ['rev-parse', 'blame']);
    const missing = await createService(repo).blameFile({ path: 'nope.txt' });
    assert.deepEqual([missing.ok, missing.found, missing.reason], [true, false, 'not_in_head']);
  });

  async function dirtyRepo(tracked, untracked) {
    const repo = createTrackedTempDir('jenny-workspace-git-discard-');
    await git(repo, ['init']);
    for (const args of [['config', 'user.email', 'j@example.invalid'], ['config', 'user.name', 'J'], ['config', 'commit.gpgsign', 'false'], ['config', 'core.autocrlf', 'false']]) await git(repo, args);
    await fs.mkdir(path.join(repo, 'src'));
    const names = Array.from({ length: tracked }, (_v, i) => `src/f${i} [x].txt`);
    await Promise.all(names.map((name) => fs.writeFile(path.join(repo, name), `${name}\n`, 'utf8')));
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'base']);
    await Promise.all(names.map((name, i) => (i % 10 === 0 ? fs.rm(path.join(repo, name)) : fs.writeFile(path.join(repo, name), 'edited\n', 'utf8'))));
    const fresh = Array.from({ length: untracked }, (_v, i) => `new${i}.txt`);
    await Promise.all(fresh.map((name) => fs.writeFile(path.join(repo, name), 'n\n', 'utf8')));
    return { repo, paths: [...names, ...fresh] };
  }

  async function treeState(repo) {
    const status = (await git(repo, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout;
    const files = (await fs.readdir(path.join(repo, 'src'))).sort();
    const contents = await Promise.all(files.map((name) => read(path.join(repo, 'src'), name)));
    return { status, files, contents, root: (await fs.readdir(repo)).sort() };
  }

  test('discardFiles on 200 tracked + 5 untracked files runs at most 3 restore spawns and leaves the tree equal to per-file discard', async () => {
    const trash = async (absolute) => fs.rm(absolute);
    const batch = await dirtyRepo(200, 5);
    const verbs = [];
    const exec = (cwd, args, opts) => { verbs.push(args[0]); return runWorkspaceGit(cwd, args, opts); };
    const res = await createService(batch.repo, { exec, trashItemImpl: trash }).discardFiles({ paths: batch.paths });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.op, 'discardFiles');
    assert.deepEqual([res.tracked.length, res.untracked.length, res.failed.length], [200, 5, 0]);
    assert.ok(verbs.filter((verb) => verb === 'restore').length <= 3, verbs.join(','));
    assert.ok(verbs.length <= 8, `spawns: ${verbs.join(',')}`);

    const single = await dirtyRepo(200, 5);
    const svc = createService(single.repo, { trashItemImpl: trash });
    for (const rel of single.paths) assert.equal((await svc.discardFile({ path: rel })).ok, true, rel);
    assert.deepEqual(await treeState(batch.repo), await treeState(single.repo));
    assert.equal((await treeState(batch.repo)).status, '');
  });

  test('discardFiles keeps the single-file refusals per path and contains every path', async () => {
    const { repo } = await dirtyRepo(2, 0);
    await fs.mkdir(path.join(repo, 'dir'));
    await fs.writeFile(path.join(repo, 'dir', 'x.txt'), 'x\n', 'utf8');
    const noTrash = await createService(repo).discardFiles({ paths: ['src/f1 [x].txt', 'dir', 'loose.txt'] });
    assert.equal(noTrash.ok, true);
    assert.deepEqual(noTrash.tracked, ['src/f1 [x].txt']);
    assert.deepEqual(noTrash.failed.map((entry) => [entry.path, entry.reason]), [['dir', 'directory_unsupported'], ['loose.txt', 'trash_unavailable']]);
    await assert.rejects(() => createService(repo).discardFiles({ paths: ['../escape.txt'] }), /inside the workspace/);
  });

  test('discardFiles trashes untracked files only after every restore succeeded', async () => {
    const { repo } = await dirtyRepo(2, 1);
    const trashed = [];
    const trash = async (absolute) => { trashed.push(absolute); await fs.rm(absolute); };
    const exec = (cwd, args, opts) => (args[0] === 'restore'
      ? Promise.resolve({ success: false, stdout: '', stderr: "error: path 'src/f1 [x].txt' is unmerged", message: 'unmerged', reason: 'exit' })
      : runWorkspaceGit(cwd, args, opts));
    const res = await createService(repo, { exec, trashItemImpl: trash }).discardFiles({ paths: ['src/f1 [x].txt', 'new0.txt'] });
    assert.equal(res.ok, false);
    assert.deepEqual(trashed, [], 'a failed restore leaves the untracked file in place');
    assert.equal(await read(repo, 'new0.txt'), 'n\n');
  });

  test('discardFiles restores through literal stdin pathspecs only', async () => {
    const repo = await createGitRepo();
    const seen = [];
    const exec = async (cwd, args, opts) => {
      if (args.includes('--is-inside-work-tree')) return { success: true, stdout: `true\n${repo}\n` };
      if (args[0] === 'ls-files') return { success: true, stdout: 'a.txt\0' };
      seen.push({ args, input: opts && opts.input });
      return { success: true, stdout: '', stderr: '' };
    };
    await createService(repo, { exec }).discardFiles({ paths: ['a.txt'] });
    assert.deepEqual(seen, [{ args: ['restore', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], input: ':(literal)a.txt\0' }]);
  });
});

describe('write allowlist (row 82 G1/G2)', () => {
  test('WRITE_VERBS gains exactly branch and apply; network verbs stay forbidden', () => {
    assert.deepEqual([...WRITE_VERBS].sort(), ['add', 'apply', 'branch', 'checkout', 'commit', 'reset', 'restore', 'stash', 'update-ref']);
    for (const verb of ['fetch', 'pull', 'push', 'rm', 'clean', 'config', 'remote']) {
      assert.throws(() => assertWriteVerb(verb), /unexpected git verb/);
    }
  });
});
