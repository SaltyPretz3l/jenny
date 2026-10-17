'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  captureCommandProposalBinding,
  captureCommonBinding,
  captureGitProposalBinding,
  recheckCommandBinding,
  recheckGitBinding,
  shellForBackend,
} = require('../services/chat-proposal-binding');
const { canonicalJson, sha256Hex } = require('../services/chat-proposal-git-facts');
const { WorkspaceGitService } = require('../services/workspace-git-service');
const { runWorkspaceGit } = require('../services/workspace-git-executor');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');

const SESSION = 'sess_1';

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function git(cwd, args, input) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', input, windowsHide: true }).trim();
}

function createRepo({ commit = true } = {}) {
  const root = createTrackedTempDir('jenny-proposal-binding-');
  git(root, ['init']);
  git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  for (const [key, value] of [['user.email', 'jenny@example.invalid'], ['user.name', 'Jenny Tests'],
    ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(root, ['config', key, value]);
  if (commit) {
    for (const name of ['README.md', 'a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(root, name), `${name}\n`);
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'deep.txt'), 'deep\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'initial']);
  }
  return root;
}

// Fake backend: real WorkspaceGitService over a real temp repo, stubbed authority/session owners.
function createBackend(root, options = {}) {
  const state = {
    root,
    authority: {
      project_id: 'proj_1', root_path: root, root_id: 'root_abc', root_revision: 3, device_id: 'dev_1', inode: 'ino_1',
    },
    sandbox: false,
    flag: options.flag !== false,
    summary: { run_mode: 'ask', plan_mode: false, preferred_model: 'model-x', reasoning_effort: 'high' },
    calls: [],
  };
  const exec = (cwd, args, execOptions) => {
    state.calls.push({ args, input: execOptions?.input ?? null });
    return runWorkspaceGit(cwd, args, execOptions);
  };
  const service = new WorkspaceGitService({
    configService: { getToolsWorkspaceRoot: () => state.root },
    featureFlagProvider: () => ({ workspace_git: state.flag }),
    exec,
    logger() {},
  });
  const stale = () => Object.assign(new Error('Project authority is stale.'), { reason: 'project_authority_stale' });
  const backend = {
    projectAuthority: {
      captureSession: () => {
        if (state.captureError) throw state.captureError;
        return { ...state.authority };
      },
      requireCurrent: (authority) => {
        if (authority.root_revision !== state.authority.root_revision) throw stale();
      },
    },
    resolveProjectWorkspaceServices: (authority) => {
      backend.projectAuthority.requireCurrent(authority);
      return { workspaceGitService: service };
    },
    sessionStore: { getSessionSummary: () => state.summary },
    get commandSandbox() { return { enabled: state.sandbox }; },
  };
  return { backend, state };
}

const captureGit = (backend, paths, extra = {}) => captureGitProposalBinding({
  backendService: backend, sessionId: SESSION, trusted: null, paths, ...extra,
});

function recordFor(binding) {
  return { source_session_id: SESSION, binding };
}

describe('git binding capture', () => {
  test('captures modified, added, deleted, renamed, untracked and binary paths with exact oids', async () => {
    const root = createRepo();
    const headOid = git(root, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(root, 'added.txt'), 'added\n');
    git(root, ['add', 'added.txt']);
    fs.unlinkSync(path.join(root, 'b.txt'));
    git(root, ['mv', 'c.txt', 'c2.txt']);
    fs.writeFileSync(path.join(root, 'u.txt'), 'untracked\n');
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 255, 0, 7]));
    const { backend } = createBackend(root);

    const result = await captureGit(backend, ['u.txt', 'a.txt', 'added.txt', 'b.txt', 'c2.txt', 'bin.dat']);
    assert.equal(result.ok, true, JSON.stringify(result));
    const { binding } = result;
    assert.equal(binding.git.ref, 'refs/heads/main');
    assert.equal(binding.git.head, headOid);
    assert.deepEqual(binding.git.paths.map((fact) => fact.path),
      ['a.txt', 'added.txt', 'b.txt', 'bin.dat', 'c2.txt', 'u.txt']);
    const byPath = Object.fromEntries(binding.git.paths.map((fact) => [fact.path, fact]));

    const blob = (rel) => git(root, ['hash-object', rel]);
    assert.equal(byPath['a.txt'].worktree_status, 'M');
    assert.equal(byPath['a.txt'].worktree_oid, blob('a.txt'));
    assert.equal(byPath['a.txt'].head_oid, git(root, ['rev-parse', 'HEAD:a.txt']));
    assert.equal(byPath['a.txt'].index_oid, git(root, ['rev-parse', ':0:a.txt']));
    assert.equal(byPath['added.txt'].index_status, 'A');
    assert.equal(byPath['added.txt'].head_oid, null);
    assert.equal(byPath['added.txt'].index_oid, blob('added.txt'));
    assert.equal(byPath['b.txt'].worktree_kind, 'missing');
    assert.equal(byPath['b.txt'].worktree_oid, null);
    assert.equal(byPath['b.txt'].head_oid, git(root, ['rev-parse', 'HEAD:b.txt']));
    assert.equal(byPath['c2.txt'].orig_path, 'c.txt');
    assert.equal(byPath['c2.txt'].index_status, 'R');
    assert.equal(byPath['c2.txt'].head_oid, git(root, ['rev-parse', 'HEAD:c.txt']));
    assert.equal(byPath['u.txt'].index_status, '?');
    assert.equal(byPath['u.txt'].index_oid, null);
    assert.equal(byPath['u.txt'].worktree_oid, blob('u.txt'));
    assert.equal(byPath['bin.dat'].worktree_oid, blob('bin.dat'));
    assert.equal(byPath['bin.dat'].worktree_kind, 'file');

    assert.equal(binding.git.fingerprint, sha256Hex(canonicalJson({
      ref: binding.git.ref, head: binding.git.head, paths: binding.git.paths,
    })));
    assert.deepEqual(binding.command, null);
  });

  test('common fields come from the project authority and session owners', async () => {
    const root = createRepo();
    fs.writeFileSync(path.join(root, 'a.txt'), 'x\n');
    const { backend } = createBackend(root);
    const { binding } = await captureGit(backend, ['a.txt']);
    assert.equal(binding.source_project_id, 'proj_1');
    assert.equal(binding.workspace_id, 'root_abc');
    assert.deepEqual(binding.root_identity, { root_id: 'root_abc', device_id: 'dev_1', inode: 'ino_1' });
    assert.equal(binding.authority_revision, 3);
    assert.equal(binding.run_mode, 'agent');
    assert.deepEqual(binding.restrictions, { read_only: false, plan_mode: false });
    assert.equal(binding.model, 'model-x');
    assert.equal(binding.effort, 'high');
  });

  test('runs every git child through the service-owned exec and never reads bodies into JS', async () => {
    const root = createRepo();
    fs.writeFileSync(path.join(root, 'a.txt'), 'SECRET-BODY-TEXT\n');
    const { backend, state } = createBackend(root);
    state.calls.length = 0;
    assert.equal((await captureGit(backend, ['a.txt'])).ok, true);
    const verbs = state.calls.map((call) => call.args[0]);
    assert.ok(verbs.includes('hash-object') && verbs.includes('cat-file') && verbs.includes('status'));
    assert.ok(state.calls.some((call) => call.args.includes('--stdin-paths')));
    assert.equal(state.calls.some((call) => String(call.input || '').includes('SECRET-BODY-TEXT')), false);
  });

  test('records an unborn HEAD as null with the unborn branch ref', async () => {
    const root = createRepo({ commit: false });
    fs.writeFileSync(path.join(root, 'first.txt'), 'first\n');
    const { backend } = createBackend(root);
    const result = await captureGit(backend, ['first.txt']);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.binding.git.head, null);
    assert.equal(result.binding.git.ref, 'refs/heads/main');
    assert.equal(result.binding.git.paths[0].head_oid, null);
    assert.equal(result.binding.git.paths[0].worktree_oid, git(root, ['hash-object', 'first.txt']));
  });

  test('records a detached HEAD as a null ref with the full oid', async () => {
    const root = createRepo();
    const head = git(root, ['rev-parse', 'HEAD']);
    git(root, ['checkout', '--detach']);
    fs.writeFileSync(path.join(root, 'a.txt'), 'x\n');
    const { backend } = createBackend(root);
    const result = await captureGit(backend, ['a.txt']);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.binding.git.ref, null);
    assert.equal(result.binding.git.head, head);
  });

  test('refuses a path that is not a current change', async () => {
    const root = createRepo();
    fs.writeFileSync(path.join(root, 'a.txt'), 'x\n');
    const { backend } = createBackend(root);
    assert.deepEqual(await captureGit(backend, ['a.txt', 'README.md']),
      { ok: false, reason: 'invalid_request', cause_code: 'path_not_changed' });
  });

  test('refuses a directory and malformed path lists', async () => {
    const root = createRepo();
    fs.writeFileSync(path.join(root, 'src', 'deep.txt'), 'x\n');
    const { backend } = createBackend(root);
    assert.equal((await captureGit(backend, ['src'])).cause_code, 'path_not_file');
    for (const paths of [[], ['a.txt', 'a.txt'], ['../x'], ['/abs'], ['a/../b'], ['C:evil'], 'a.txt', ['a\nb']]) {
      assert.deepEqual(await captureGit(backend, paths),
        { ok: false, reason: 'invalid_request', cause_code: 'field_paths' }, JSON.stringify(paths));
    }
    const tooMany = Array.from({ length: 201 }, (_unused, index) => `f${index}.txt`);
    assert.equal((await captureGit(backend, tooMany)).cause_code, 'field_paths');
  });

  test('refuses a junction or symlinked directory that escapes the root', async () => {
    const root = createRepo();
    const outside = createTrackedTempDir('jenny-proposal-outside-');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n');
    fs.symlinkSync(outside, path.join(root, 'jx'), 'junction');
    const { backend } = createBackend(root);
    assert.deepEqual(await captureGit(backend, ['jx/secret.txt']),
      { ok: false, reason: 'invalid_request', cause_code: 'path_outside_workspace' });
  });

  test('hashes a leaf symlink by its target text without following it', async (t) => {
    const root = createRepo();
    try {
      fs.symlinkSync('README.md', path.join(root, 'ln'), 'file');
    } catch (error) {
      t.skip(`symlinks unavailable here (${error.code})`);
      return;
    }
    const { backend } = createBackend(root);
    const result = await captureGit(backend, ['ln']);
    if (result.ok === false && result.cause_code === 'path_not_changed') {
      t.skip('git does not list this platform symlink as a change');
      return;
    }
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.binding.git.paths[0].worktree_kind, 'symlink');
    assert.equal(result.binding.git.paths[0].worktree_oid, git(root, ['hash-object', '--stdin'], 'README.md'));
  });

  test('a leaf the filesystem reports as a link is hashed from its target text (fs seam)', async () => {
    const root = createRepo();
    fs.writeFileSync(path.join(root, 'ln'), 'README.md'); // what core.symlinks=false materializes
    const linkFs = {
      ...fs.promises,
      lstat: async (target) => {
        const stats = await fs.promises.lstat(target);
        return path.basename(target) === 'ln' ? { isSymbolicLink: () => true, isFile: () => false, size: stats.size } : stats;
      },
      readlink: async () => 'README.md',
    };
    const { backend } = createBackend(root);
    const result = await captureGit(backend, ['ln'], { fs: linkFs });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.binding.git.paths[0].worktree_kind, 'symlink');
    assert.equal(result.binding.git.paths[0].worktree_oid, git(root, ['hash-object', '--stdin'], 'README.md'));
  });

  test('fails visibly when the byte budget or the time budget is exceeded', async () => {
    const root = createRepo();
    fs.writeFileSync(path.join(root, 'a.txt'), '0123456789');
    fs.writeFileSync(path.join(root, 'b.txt'), '0123456789');
    const { backend } = createBackend(root);
    assert.deepEqual(await captureGit(backend, ['a.txt', 'b.txt'], { budget: { maxBytes: 15 } }),
      { ok: false, reason: 'capacity', cause_code: 'binding_budget' });
    assert.equal((await captureGit(backend, ['a.txt', 'b.txt'], { budget: { maxBytes: 20 } })).ok, true);
    let tick = 0;
    assert.deepEqual(await captureGit(backend, ['a.txt'], { budget: { timeoutMs: 50 }, now: () => (tick += 100) }),
      { ok: false, reason: 'capacity', cause_code: 'binding_budget' });
  });

  test('maps non-git, disabled, subdirectory, null-root and stale-authority cases', async () => {
    const plain = createTrackedTempDir('jenny-proposal-plain-');
    fs.writeFileSync(path.join(plain, 'a.txt'), 'x');
    assert.deepEqual(await captureGit(createBackend(plain).backend, ['a.txt']),
      { ok: false, reason: 'invalid_request', cause_code: 'not_git' });

    const root = createRepo();
    fs.writeFileSync(path.join(root, 'a.txt'), 'x\n');
    assert.equal((await captureGit(createBackend(root, { flag: false }).backend, ['a.txt'])).cause_code, 'git_disabled');

    const sub = createBackend(path.join(root, 'src'));
    assert.deepEqual(await captureGit(sub.backend, ['deep.txt']),
      { ok: false, reason: 'invalid_request', cause_code: 'not_repo_toplevel' });

    const nullRoot = createBackend(root);
    nullRoot.state.authority.root_path = null;
    nullRoot.state.authority.root_id = null;
    assert.deepEqual(await captureGit(nullRoot.backend, ['a.txt']),
      { ok: false, reason: 'invalid_request', cause_code: 'no_workspace' });

    const stale = createBackend(root);
    stale.state.captureError = Object.assign(new Error('stale'), { reason: 'project_authority_stale' });
    assert.deepEqual(await captureGit(stale.backend, ['a.txt']),
      { ok: false, reason: 'authority_changed', cause_code: 'authority_stale' });
  });

  test('an aborted capture is unavailable, not a binding', async () => {
    const root = createRepo();
    fs.writeFileSync(path.join(root, 'a.txt'), 'x\n');
    const { backend } = createBackend(root);
    const controller = new AbortController();
    controller.abort();
    const result = await captureGit(backend, ['a.txt'], { signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unavailable');
  });
});

describe('recheckGitBinding', () => {
  async function arranged() {
    const root = createRepo();
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
    const harness = createBackend(root);
    const captured = await captureGit(harness.backend, ['a.txt']);
    assert.equal(captured.ok, true);
    return { root, ...harness, record: recordFor(captured.binding) };
  }

  test('passes when nothing moved', async () => {
    const { backend, record } = await arranged();
    assert.deepEqual(await recheckGitBinding(record, { backendService: backend }), { ok: true });
  });

  test('reports root_changed when the root identity differs', async () => {
    const { backend, state, record } = await arranged();
    state.authority.root_id = 'root_other';
    assert.deepEqual(await recheckGitBinding(record, { backendService: backend }), { ok: false, cause_code: 'root_changed' });
    state.authority.root_id = 'root_abc';
    state.authority.inode = 'ino_2';
    assert.deepEqual(await recheckGitBinding(record, { backendService: backend }), { ok: false, cause_code: 'root_changed' });
  });

  test('reports authority_stale when the authority revision bumps', async () => {
    const { backend, state, record } = await arranged();
    state.authority.root_revision = 4;
    assert.deepEqual(await recheckGitBinding(record, { backendService: backend }), { ok: false, cause_code: 'authority_stale' });
  });

  test('reports ref_changed when the branch moves but HEAD does not', async () => {
    const { root, backend, record } = await arranged();
    git(root, ['checkout', '-b', 'other']);
    assert.deepEqual(await recheckGitBinding(record, { backendService: backend }), { ok: false, cause_code: 'ref_changed' });
  });

  test('reports head_changed when a new commit lands on the same branch', async () => {
    const { root, backend, record } = await arranged();
    fs.writeFileSync(path.join(root, 'b.txt'), 'other work\n');
    git(root, ['commit', '-m', 'unrelated', '--', 'b.txt']);
    assert.deepEqual(await recheckGitBinding(record, { backendService: backend }), { ok: false, cause_code: 'head_changed' });
  });

  test('reports paths_changed when a selected path is edited, staged, reverted or hit by a late write', async () => {
    const { root, backend, record } = await arranged();
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed again\n');
    assert.deepEqual(await recheckGitBinding(record, { backendService: backend }), { ok: false, cause_code: 'paths_changed' });
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
    assert.deepEqual(await recheckGitBinding(record, { backendService: backend }), { ok: true });
    git(root, ['add', 'a.txt']);
    assert.deepEqual(await recheckGitBinding(record, { backendService: backend }), { ok: false, cause_code: 'paths_changed' });
    git(root, ['reset', '--hard', 'HEAD']);
    assert.deepEqual(await recheckGitBinding(record, { backendService: backend }), { ok: false, cause_code: 'paths_changed' });
  });

  test('ignores unrelated edits outside the selected paths', async () => {
    const { root, backend, record } = await arranged();
    fs.writeFileSync(path.join(root, 'c.txt'), 'someone else\n');
    assert.deepEqual(await recheckGitBinding(record, { backendService: backend }), { ok: true });
  });

  test('rejects a record without a git binding', async () => {
    const { backend } = await arranged();
    assert.deepEqual(await recheckGitBinding({ source_session_id: SESSION, binding: { git: null } }, { backendService: backend }),
      { ok: false, cause_code: 'binding_missing' });
  });
});

describe('command binding capture', () => {
  async function commandBackend() {
    const root = createRepo();
    fs.mkdirSync(path.join(root, 'tools', 'nested'), { recursive: true });
    return { root, ...createBackend(root) };
  }
  const capture = (backend, cwd, command, extra = {}) => captureCommandProposalBinding({
    backendService: backend, sessionId: SESSION, trusted: null, cwd, command, ...extra,
  });

  test('captures the native backend, shell, cwd and the sha256 of the exact command bytes', async () => {
    const { backend } = await commandBackend();
    const command = 'echo "héllo"\r\nls  \n';
    const result = await capture(backend, 'tools/nested', command);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.binding.command, {
      backend: 'native',
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      cwd: 'tools/nested',
      command_sha256: sha256Hex(Buffer.from(command, 'utf8')),
    });
    assert.equal(result.binding.git, null);
    assert.notEqual(result.binding.command.command_sha256, sha256Hex(Buffer.from(command.trim(), 'utf8')));
  });

  test('uses the docker backend and /bin/sh when the desktop command sandbox is enabled', async () => {
    const { backend, state } = await commandBackend();
    state.sandbox = true;
    const result = await capture(backend, '.', 'make test', { platform: 'win32' });
    assert.equal(result.binding.command.backend, 'docker');
    assert.equal(result.binding.command.shell, '/bin/sh');
    assert.equal(result.binding.command.cwd, '.');
  });

  test('rejects a cwd that escapes, is missing or is not a directory', async () => {
    const { root, backend } = await commandBackend();
    const outside = createTrackedTempDir('jenny-proposal-cwd-outside-');
    fs.symlinkSync(outside, path.join(root, 'jx'), 'junction');
    for (const [cwd, cause] of [
      ['../x', 'field_cwd'], ['/abs', 'field_cwd'], ['C:evil', 'field_cwd'],
      ['missing', 'cwd_not_found'], ['README.md', 'cwd_not_directory'], ['jx', 'cwd_outside_workspace'],
    ]) {
      assert.deepEqual(await capture(backend, cwd, 'echo hi'), { ok: false, reason: 'invalid_request', cause_code: cause }, cwd);
    }
  });

  test('rejects a NUL byte or empty command', async () => {
    const { backend } = await commandBackend();
    assert.equal((await capture(backend, '.', 'a\0b')).cause_code, 'field_command');
    assert.equal((await capture(backend, '.', '')).cause_code, 'field_command');
  });

  test('fails closed when the authority is stale', async () => {
    const { backend, state } = await commandBackend();
    state.captureError = Object.assign(new Error('x'), { reason: 'project_authority_stale' });
    assert.deepEqual(await capture(backend, '.', 'echo'), { ok: false, reason: 'authority_changed', cause_code: 'authority_stale' });
  });
});

describe('recheckCommandBinding', () => {
  const COMMAND = 'echo "h\u00e9llo"\nls';
  async function arranged({ cwd = 'tools', command = COMMAND } = {}) {
    const root = createRepo();
    fs.mkdirSync(path.join(root, 'tools', 'nested'), { recursive: true });
    const harness = createBackend(root);
    const captured = await captureCommandProposalBinding({
      backendService: harness.backend, sessionId: SESSION, trusted: null, cwd, command,
    });
    assert.equal(captured.ok, true, JSON.stringify(captured));
    const record = {
      source_session_id: SESSION, binding: captured.binding, normalized_input: { command, cwd },
    };
    return { root, ...harness, record };
  }
  const recheck = (record, backend, extra = {}) => recheckCommandBinding(record, { backendService: backend, ...extra });

  test('passes when nothing moved', async () => {
    const { backend, record } = await arranged();
    assert.deepEqual(await recheck(record, backend), { ok: true });
  });

  test('reports root_changed and authority_stale like the Git recheck', async () => {
    const { backend, state, record } = await arranged();
    state.authority.root_id = 'root_other';
    assert.deepEqual(await recheck(record, backend), { ok: false, cause_code: 'root_changed' });
    state.authority.root_id = 'root_abc';
    state.authority.root_revision = 4;
    assert.deepEqual(await recheck(record, backend), { ok: false, cause_code: 'authority_stale' });
  });

  test('reports backend_changed when the command sandbox flips and shell_changed when only the shell moves', async () => {
    const { backend, state, record } = await arranged();
    state.sandbox = true;
    assert.deepEqual(await recheck(record, backend, { platform: 'linux' }), { ok: false, cause_code: 'backend_changed' });
    state.sandbox = false;
    const other = process.platform === 'win32' ? 'linux' : 'win32';
    assert.deepEqual(await recheck(record, backend, { platform: other }), { ok: false, cause_code: 'shell_changed' });
  });

  test('reports cwd_changed when the directory vanished or became a file, unavailable when unreadable', async () => {
    const { root, backend, record } = await arranged();
    fs.rmSync(path.join(root, 'tools'), { recursive: true, force: true });
    assert.deepEqual(await recheck(record, backend), { ok: false, cause_code: 'cwd_changed' });
    fs.writeFileSync(path.join(root, 'tools'), 'now a file');
    assert.deepEqual(await recheck(record, backend), { ok: false, cause_code: 'cwd_changed' });
    const failing = { ...fs.promises, realpath: async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } };
    assert.deepEqual(await recheck(record, backend, { fs: failing }), { ok: false, cause_code: 'unavailable' });
  });

  test('reports command_changed when the stored command no longer matches its hash', async () => {
    const { backend, record } = await arranged();
    const tampered = { ...record, normalized_input: { ...record.normalized_input, command: `${COMMAND} --extra` } };
    assert.deepEqual(await recheck(tampered, backend), { ok: false, cause_code: 'command_changed' });
  });

  test('a missing binding is binding_missing; a stale authority at recapture is authority_stale', async () => {
    const { backend, state, record } = await arranged();
    assert.deepEqual(await recheck({ ...record, binding: { ...record.binding, command: null } }, backend), { ok: false, cause_code: 'binding_missing' });
    state.captureError = Object.assign(new Error('x'), { reason: 'project_authority_stale' });
    assert.deepEqual(await recheck(record, backend), { ok: false, cause_code: 'authority_stale' });
  });
});

describe('common binding and helpers', () => {
  test('plan mode and read-only come from the trusted execution binding', () => {
    const root = createRepo();
    const { backend } = createBackend(root);
    const result = captureCommonBinding({
      backendService: backend, sessionId: SESSION, trusted: { mode: 'plan', readOnly: true, assertCurrent() {} },
    });
    assert.equal(result.ok, true);
    assert.equal(result.binding.run_mode, 'plan');
    assert.deepEqual(result.binding.restrictions, { read_only: true, plan_mode: true });
  });

  test('falls back to the session summary and nulls missing model fields', () => {
    const root = createRepo();
    const { backend, state } = createBackend(root);
    state.summary = { run_mode: 'plan', plan_mode: true };
    const result = captureCommonBinding({ backendService: backend, sessionId: SESSION });
    assert.equal(result.binding.run_mode, 'plan');
    assert.equal(result.binding.model, null);
    assert.equal(result.binding.effort, null);
    assert.equal(result.binding.restrictions.read_only, true);
  });

  test('a trusted binding that went stale maps to authority_changed', () => {
    const root = createRepo();
    const { backend } = createBackend(root);
    const trusted = { mode: 'agent', readOnly: false, assertCurrent() { throw Object.assign(new Error('mode flipped'), { code: 'run_mode_changed' }); } };
    assert.deepEqual(captureCommonBinding({ backendService: backend, sessionId: SESSION, trusted }),
      { ok: false, reason: 'authority_changed', cause_code: 'run_mode_changed' });
  });

  test('shellForBackend covers each backend and platform', () => {
    assert.equal(shellForBackend('native', 'win32'), 'cmd.exe');
    assert.equal(shellForBackend('native', 'linux'), '/bin/sh');
    assert.equal(shellForBackend('native', 'darwin'), '/bin/sh');
    assert.equal(shellForBackend('docker', 'win32'), '/bin/sh');
    assert.equal(shellForBackend('docker', 'linux'), '/bin/sh');
    assert.equal(shellForBackend('other', 'linux'), null);
  });

  test('canonicalJson sorts keys, keeps array order and drops whitespace', () => {
    assert.equal(canonicalJson({ b: [3, { z: 1, a: null }], a: 'x', c: undefined }), '{"a":"x","b":[3,{"a":null,"z":1}]}');
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
