'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { componentProblem, validateRelativePath, protectionPolicy, isProtected, isSyncExcluded,
  discoverProtectionPolicy, foldName } = require('../services/execution/sandbox-protected-paths');

test('every P0a alias of a protected name is protected or refused before it reaches the folder', () => {
  const policy = protectionPolicy();
  // Exact names, case variants and Unicode case folds that NTFS treats as the same name.
  for (const rel of ['.git/config', '.GIT/config', '.Git/hooks/pre-commit', 'sub/.git', '.gıt/config',
    '.HUSKY/pre-commit', 'NODE_MODULES/x.js', 'pkg/node_modules/a/index.js', '.venv/bin/python',
    'VENV/lib/x.py', '.jenny/state.json', '.JENNY/x']) {
    assert.equal(isProtected(rel, policy), true, rel);
  }
  // Aliases that Windows resolves to a protected name are refused as path problems.
  for (const rel of ['GIT~1/config', 'git~1/config', 'NODE_M~1/x.js', '.git./config', '.git /config',
    'a/.husky./pre-commit']) {
    assert.equal(validateRelativePath(rel).ok, false, rel);
  }
  assert.equal(isProtected('src/index.js', policy), false);
  assert.equal(isProtected('docs/gitignore.md', policy), false);
  assert.equal(isProtected('.github/workflows/ci.yml', policy), false);
  assert.equal(isProtected('.gitignore', policy), false);
});

test('component rules refuse reserved device names, short names, trailing dots and Windows-invalid bytes', () => {
  for (const name of ['', '.', '..', 'CON', 'con.txt', 'Nul', 'nul.tar.gz', 'COM1', 'lpt9.log', 'COM¹', 'CONIN$',
    'PROGRA~1', 'file~2.txt', 'name.', 'name ', 'a:b', 'a|b', 'a<b', 'a>b', 'a"b', 'a?b', 'a*b', 'a\\b',
    'tab\there', 'x'.repeat(256)]) {
    assert.equal(typeof componentProblem(name), 'string', JSON.stringify(name));
  }
  for (const name of ['readme.md', 'hello ü.txt', 'console.log', 'connect.js', 'com10', 'a~b', 'x'.repeat(255)]) {
    assert.equal(componentProblem(name), null, name);
  }
  assert.equal(validateRelativePath('/abs').ok, false);
  assert.equal(validateRelativePath('a//b').ok, false);
  assert.equal(validateRelativePath('a/../b').ok, false);
  assert.equal(validateRelativePath('a/b\0').ok, false);
  assert.equal(validateRelativePath(42).ok, false);
  assert.deepEqual(validateRelativePath('src/app.js'), { ok: true, components: ['src', 'app.js'] });
});

test('fold treats NTFS-equivalent spellings as one name', () => {
  assert.equal(foldName('.GIT'), '.git');
  assert.equal(foldName('.gıt'), '.git');
  assert.equal(foldName('.huſky'), '.husky');
  assert.equal(foldName('.git. . '), '.git');
});

test('sync exclusions keep git and venv folders out but sync node_modules and hook folders', () => {
  const policy = protectionPolicy({ hooks: ['tools/hooks'], gitDirs: ['.bare'] });
  for (const rel of ['.git', '.GIT/config', 'a/.git', '.jenny/x', '.venv/x', 'venv', '.bare/config', '.BARE/HEAD']) {
    assert.equal(isSyncExcluded(rel, policy), true, rel);
  }
  for (const rel of ['node_modules/x.js', '.husky/pre-commit', 'tools/hooks/h.sh', 'src/a.js']) {
    assert.equal(isSyncExcluded(rel, policy), false, rel);
  }
  assert.equal(isProtected('tools/hooks/h.sh', policy), true);
  assert.equal(isProtected('TOOLS/Hooks/h.sh', policy), true);
  assert.equal(isProtected('tools/hooksx/h.sh', policy), false);
  // A HEAD file would make a planted objects/ + refs/ layout a repository git honours.
  assert.equal(isProtected('vendor/evil.git/HEAD', policy), true);
  assert.equal(isProtected('docs/Head', policy), true);
  assert.equal(isProtected('vendor/evil.git/config', policy), false);
  assert.equal(isProtected('.bare/config', policy), true);
});

test('policy discovery reads hooksPath, in-root includes and in-root gitdirs from the repository config', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-protected-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  await fs.writeFile(path.join(root, '.git', 'config'), [
    '[core]', '\tbare = false', '\thooksPath = tools/hooks', '[include]', '\tpath = ../config/git.inc',
    '[includeIf "gitdir:~/work/"]', '\tpath = "~/outside.inc"', '[INCLUDE]', '\tPath = ../../escape.inc', '',
  ].join('\n'));
  const policy = await discoverProtectionPolicy(root);
  assert.deepEqual(policy.hooks, ['tools/hooks']);
  assert.deepEqual(policy.includes, ['config/git.inc']);
  assert.equal(isProtected('config/git.inc', policy), true);
  assert.equal(isProtected('tools/hooks/pre-commit', policy), true);

  // A worktree whose .git file points at an in-root gitdir protects and excludes that folder too.
  const worktree = path.join(base, 'wt');
  await fs.mkdir(path.join(worktree, '.bare'), { recursive: true });
  await fs.writeFile(path.join(worktree, '.git'), 'gitdir: .bare\n');
  await fs.writeFile(path.join(worktree, '.bare', 'config'), '[core]\n\thooksPath = /etc/hooks\n');
  const second = await discoverProtectionPolicy(worktree);
  assert.deepEqual(second.gitDirs, ['.bare']);
  assert.deepEqual(second.hooks, []);
  assert.equal(isSyncExcluded('.bare/HEAD', second), true);

  // A missing repository is an empty policy, never an error.
  const plain = path.join(base, 'plain');
  await fs.mkdir(plain);
  assert.deepEqual(await discoverProtectionPolicy(plain), protectionPolicy());
});

test('a linked worktree reads the shared config, its own config.worktree and include files transitively', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-protected-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const main = path.join(base, 'main');
  const linked = path.join(base, 'linked');
  const gitDir = path.join(main, '.git', 'worktrees', 'linked');
  await fs.mkdir(gitDir, { recursive: true });
  await fs.mkdir(linked);
  await fs.writeFile(path.join(linked, '.git'), `gitdir: ${gitDir}\n`);
  await fs.writeFile(path.join(gitDir, 'commondir'), '../..\n');
  await fs.writeFile(path.join(main, '.git', 'config'), `[include]\n\tpath = ${path.join(linked, 'cfg', 'a.inc').split(path.sep).join('/')}\n`);
  await fs.mkdir(path.join(linked, 'cfg'));
  await fs.writeFile(path.join(linked, 'cfg', 'a.inc'), '[include]\n\tpath = b.inc\n');
  await fs.writeFile(path.join(linked, 'cfg', 'b.inc'), '[core]\n\thooksPath = .githooks\n');
  await fs.writeFile(path.join(gitDir, 'config.worktree'), '[core]\n\thooksPath = wt-hooks\n');
  const policy = await discoverProtectionPolicy(linked);
  assert.deepEqual(policy.hooks, ['.githooks', 'wt-hooks']);
  assert.deepEqual(policy.includes, ['cfg/a.inc', 'cfg/b.inc']);
  assert.equal(isProtected('.githooks/pre-commit', policy), true);
  assert.deepEqual(policy.gitDirs, []);
});
