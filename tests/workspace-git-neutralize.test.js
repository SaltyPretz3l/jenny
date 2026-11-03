'use strict';

// Row 103: the Workspace Git panel's read-only git calls neutralize repository
// filters and diff drivers, as sidecar/ai/tools/builtins/git_process.py does.
// Real git in a temp repository; each hostile helper writes a marker file when
// it runs, and the marker must never appear after a panel read.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { WorkspaceGitService } = require('../services/workspace-git-service');
const {
  createReadOnlyGitExec,
  neutralizingConfigArguments,
} = require('../services/workspace-git-neutralize');

const NODE = process.execPath.replace(/\\/g, '/');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'core.autocrlf', 'false');
}

function commitAll(dir, message) {
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', message);
}

// A helper command that records it ran. A clean filter also passes stdin
// through (so one that did run still produces content); a diff driver does not
// read stdin.
function markerCommand(marker, { passStdin = true } = {}) {
  const script = `require('fs').writeFileSync(process.argv[1],'ran')${passStdin ? ';process.stdin.pipe(process.stdout)' : ''}`;
  return `"${NODE}" -e "${script}" "${marker.replace(/\\/g, '/')}"`;
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-git-neutralize-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function createService(root) {
  return new WorkspaceGitService({
    configService: { getToolsWorkspaceRoot: () => root },
    featureFlagProvider: () => ({ workspace_git: true }),
    logger() {},
  });
}

// Same size, newer mtime: git cannot trust the stat data and must re-read the
// file through the configured clean filter.
function touchSameSize(file, content) {
  fs.writeFileSync(file, content);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
}

test('status and diff reads never run a configured clean filter', async (t) => {
  const dir = tempDir(t);
  const repo = path.join(dir, 'repo');
  initRepo(repo);
  const tracked = path.join(repo, 'tracked.txt');
  fs.writeFileSync(tracked, 'before\n');
  fs.writeFileSync(path.join(repo, '.gitattributes'), '* filter=evil\n');
  commitAll(repo, 'initial');
  const marker = path.join(dir, 'clean.marker');
  git(repo, 'config', 'filter.evil.clean', markerCommand(marker));
  touchSameSize(tracked, 'after!\n');

  const svc = createService(repo);
  const status = await svc.getStatus();
  assert.equal(status.ok, true, JSON.stringify(status));
  const diff = await svc.getDiff({ path: 'tracked.txt' });
  assert.equal(diff.ok, true, JSON.stringify(diff));
  const staged = await svc.getDiff({ staged: true });
  assert.equal(staged.ok, true, JSON.stringify(staged));
  assert.equal(fs.existsSync(marker), false, 'a panel read ran the repository clean filter');
  assert.match(diff.diff, /tracked\.txt/);
});

test('a user-initiated stage still runs the repository clean filter', async (t) => {
  const dir = tempDir(t);
  const repo = path.join(dir, 'repo');
  initRepo(repo);
  const tracked = path.join(repo, 'tracked.txt');
  fs.writeFileSync(tracked, 'before\n');
  fs.writeFileSync(path.join(repo, '.gitattributes'), '* filter=evil\n');
  commitAll(repo, 'initial');
  const marker = path.join(dir, 'stage.marker');
  git(repo, 'config', 'filter.evil.clean', markerCommand(marker));
  touchSameSize(tracked, 'after!\n');

  const staged = await createService(repo).stage({ paths: ['tracked.txt'] });
  assert.equal(staged.ok, true, JSON.stringify(staged));
  assert.equal(fs.existsSync(marker), true);
});

for (const configKey of ['diff.evil.textconv', 'diff.evil.command']) {
  test(`diff and commit-diff reads never run a configured ${configKey}`, async (t) => {
    const dir = tempDir(t);
    const repo = path.join(dir, 'repo');
    initRepo(repo);
    const tracked = path.join(repo, 'tracked.txt');
    fs.writeFileSync(tracked, 'before\n');
    fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt diff=evil\n');
    commitAll(repo, 'initial');
    fs.writeFileSync(tracked, 'after\n');
    commitAll(repo, 'changed');
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    const marker = path.join(dir, `${configKey}.marker`);
    git(repo, 'config', configKey, markerCommand(marker, { passStdin: false }));
    fs.writeFileSync(tracked, 'working tree\n');

    const svc = createService(repo);
    const diff = await svc.getDiff({});
    const shown = await svc.getCommitDiff({ hash: head });
    assert.equal(fs.existsSync(marker), false, `a panel read ran ${configKey}`);
    assert.equal(diff.ok, true, JSON.stringify(diff));
    assert.match(diff.diff, /^\+working tree$/m);
    assert.equal(shown.ok, true, JSON.stringify(shown));
    assert.match(shown.diff, /^\+after$/m);
  });
}

test('status and diff reads never run a clean filter defined only in a submodule', async (t) => {
  const dir = tempDir(t);
  const repo = path.join(dir, 'repo');
  initRepo(repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  const sub = path.join(repo, 'sub');
  initRepo(sub);
  fs.writeFileSync(path.join(sub, '.gitattributes'), '* filter=evil\n');
  const tracked = path.join(sub, 'f.txt');
  fs.writeFileSync(tracked, 'hello\n');
  commitAll(sub, 'sub');
  const marker = path.join(dir, 'submodule.marker');
  git(sub, 'config', 'filter.evil.clean', markerCommand(marker));
  commitAll(repo, 'parent with a gitlink');
  touchSameSize(tracked, 'hello\n');

  const svc = createService(repo);
  assert.equal((await svc.getStatus()).ok, true);
  assert.equal((await svc.getDiff({})).ok, true);
  assert.equal(fs.existsSync(marker), false, 'a panel read ran a submodule clean filter');
});

test('a repository without filters reads exactly as before', async (t) => {
  const dir = tempDir(t);
  const repo = path.join(dir, 'repo');
  initRepo(repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  commitAll(repo, 'initial');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');

  const svc = createService(repo);
  const status = await svc.getStatus();
  assert.equal(status.ok, true);
  assert.deepEqual(status.files.map((file) => file.path).sort(), ['a.txt', 'new.txt']);
  const diff = await svc.getDiff({ path: 'a.txt' });
  assert.match(diff.diff, /^-one$/m);
  assert.match(diff.diff, /^\+two$/m);
});

test('overrides cover every executable key family and keep the fixed set first', () => {
  const args = neutralizingConfigArguments([
    'core.editor', 'filter.lfs.required', 'Filter.Evil.Clean', 'diff.x.textconv', 'credential.https://h.helper', 'filter.lfs.required',
  ]);
  const pairs = [];
  for (let i = 0; i < args.length; i += 2) {
    assert.equal(args[i], '-c');
    pairs.push(args[i + 1]);
  }
  assert.ok(pairs.indexOf('core.fsmonitor=false') === 0);
  assert.ok(pairs.includes('diff.external='));
  assert.ok(pairs.includes('Filter.Evil.Clean='));
  assert.ok(pairs.includes('diff.x.textconv='));
  assert.ok(pairs.includes('credential.https://h.helper='));
  assert.equal(pairs.filter((pair) => pair === 'filter.lfs.required=false').length, 1);
  assert.equal(pairs.some((pair) => pair.startsWith('core.editor')), false);
});

function fakeExec(listing, calls) {
  return async (_root, args) => {
    calls.push(args);
    if (args[0] === 'config') return typeof listing === 'function' ? listing() : listing;
    return { success: true, stdout: 'ran', stderr: '' };
  };
}

test('an unverifiable or unoverridable config refuses the read without running it', async () => {
  for (const listing of [
    { success: false, reason: 'git_failed', stdout: '', stderr: 'boom' },
    { success: true, stdout: 'filter.a=b.clean\0' },
  ]) {
    const calls = [];
    const read = createReadOnlyGitExec(fakeExec(listing, calls), { fs: { stat: async () => { throw new Error('no fs'); } } });
    const result = await read('/repo', ['status']);
    assert.equal(result.success, false);
    assert.match(result.message, /configuration could not be verified/);
    assert.deepEqual(calls.map((args) => args[0]), ['config']);
  }
});

test('reads get the sidecar read flags; other reads keep their argv after the overrides', async () => {
  const calls = [];
  const read = createReadOnlyGitExec(fakeExec({ success: true, stdout: '' }, calls), { fs: { stat: async () => { throw new Error('no fs'); } } });
  await read('/repo', ['status', '-z']);
  await read('/repo', ['diff', '--cached']);
  await read('/repo', ['show', 'HEAD:./a.txt']);
  await read('/repo', ['blame', '--porcelain']);
  await read('/repo', ['diff', '--ignore-submodules=all']);
  await read('/repo', ['log', '-1']);
  const commands = calls.filter((args) => args[0] !== 'config').map((args) => args.slice(args.lastIndexOf('-c') + 2));
  assert.deepEqual(commands, [
    ['status', '--ignore-submodules=dirty', '-z'],
    ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--cached'],
    ['show', '--no-ext-diff', '--no-textconv', 'HEAD:./a.txt'],
    ['blame', '--no-textconv', '--porcelain'],
    ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all'],
    ['log', '-1'],
  ]);
});

test('config discovery is reused until a config file changes, never when it names an include', async (t) => {
  const dir = tempDir(t);
  const repo = path.join(dir, 'repo');
  initRepo(repo);
  let listing = { success: true, stdout: 'core.bare\0' };
  const calls = [];
  let clock = 0;
  const read = createReadOnlyGitExec(fakeExec(() => listing, calls), { env: {}, now: () => clock });
  const discoveries = () => calls.filter((args) => args[0] === 'config').length;
  await read(repo, ['status']);
  await read(repo, ['status']);
  assert.equal(discoveries(), 1);
  const config = path.join(repo, '.git', 'config');
  fs.appendFileSync(config, '[x]\n\ty = 1\n');
  const later = new Date(Date.now() + 10_000);
  fs.utimesSync(config, later, later);
  await read(repo, ['status']);
  assert.equal(discoveries(), 2);
  clock += 31_000;
  await read(repo, ['status']);
  assert.equal(discoveries(), 3);
  listing = { success: true, stdout: 'include.path\0' };
  clock += 31_000;
  await read(repo, ['status']);
  await read(repo, ['status']);
  assert.equal(discoveries(), 5);
});

test('a .git directory mtime change (git status touches it) still hits the discovery cache', async (t) => {
  const dir = tempDir(t);
  const repo = path.join(dir, 'repo');
  initRepo(repo);
  const calls = [];
  const read = createReadOnlyGitExec(fakeExec(() => ({ success: true, stdout: 'core.bare\0' }), calls), { env: {}, now: () => 0 });
  await read(repo, ['status']);
  const later = new Date(Date.now() + 10_000);
  fs.utimesSync(path.join(repo, '.git'), later, later);
  await read(repo, ['status']);
  assert.equal(calls.filter((args) => args[0] === 'config').length, 1);
});
