'use strict';

// Builds a starting git repository once per test file and hands each case its
// own directory copy. Process start is slow on Windows and a fixture repository
// costs about eight `git` child processes (init, config, add, commit ...), so a
// file with forty cases used to spend most of its time building the same
// repository forty times.
//
// A copy is a plain directory copy of the template, so a case may commit,
// stash, branch or edit freely without touching the template or any sibling.
// Only use a template for repositories whose `.git` holds no absolute path
// (no linked worktree, no alternates, no `gitdir` file): the copy has a new
// location. Cases that need such a state build it on top of a copy.
//
//   const templates = createGitTemplates();
//   after(() => templates.dispose());
//   const repo = await templates.copy('base', async (dir) => { await initStandardRepo(dir); ... }, 'jenny-example-');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { createTrackedTempDir } = require('./resource-cleanup');

const execFileAsync = promisify(execFile);

// Same environment the shared recovery harness uses, so a read-only `status`
// never races a later case for the index lock.
function runGit(cwd, args) {
  return execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

// `git init` with a deterministic branch name and identity; the committer is
// fixed and signing / autocrlf are off so a copy behaves the same on any host.
async function initStandardRepo(dir, { trunk = 'main' } = {}) {
  await runGit(dir, ['init']);
  await runGit(dir, ['symbolic-ref', 'HEAD', `refs/heads/${trunk}`]);
  await runGit(dir, ['config', 'user.email', 'jenny@example.invalid']);
  await runGit(dir, ['config', 'user.name', 'Jenny Tests']);
  await runGit(dir, ['config', 'commit.gpgsign', 'false']);
  await runGit(dir, ['config', 'core.autocrlf', 'false']);
}

// A standard repository with one commit holding `files` ({ relativePath: text }).
// `hostDefaults: true` skips the branch/signing/autocrlf pinning and sets only
// the committer identity, for suites that ran against the host's own defaults.
async function buildCommittedRepo(dir, files, { message = 'initial', hostDefaults = false, ...initOptions } = {}) {
  if (hostDefaults) {
    await runGit(dir, ['init']);
    await runGit(dir, ['config', 'user.email', 'jenny@example.invalid']);
    await runGit(dir, ['config', 'user.name', 'Jenny Tests']);
  } else {
    await initStandardRepo(dir, initOptions);
  }
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text, 'utf8');
  }
  await runGit(dir, ['add', '--', ...Object.keys(files)]);
  await runGit(dir, ['commit', '-m', message]);
}

function createGitTemplate(build) {
  let templatePromise = null;
  let templateDir = null;

  function ensureTemplate() {
    if (!templatePromise) {
      templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-git-template-'));
      templatePromise = Promise.resolve(build(templateDir)).then(() => templateDir);
    }
    return templatePromise;
  }

  return {
    // A fresh tracked temp directory (removed by cleanupTrackedResources) that
    // holds a copy of the template.
    async copy(prefix) {
      const source = await ensureTemplate();
      const destination = createTrackedTempDir(prefix);
      fs.cpSync(source, destination, { recursive: true });
      return destination;
    },
    // Call from an `after` hook: removes the template directory.
    async dispose() {
      const pending = templatePromise;
      const dir = templateDir;
      templatePromise = null;
      templateDir = null;
      if (pending) await pending.catch(() => null);
      if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

// Several named templates in one file: `copy(key, build, prefix)` builds the
// template for `key` on first use (with `build`) and copies it every time.
function createGitTemplates() {
  const byKey = new Map();
  return {
    copy(key, build, prefix) {
      if (!byKey.has(key)) byKey.set(key, createGitTemplate(build));
      return byKey.get(key).copy(prefix);
    },
    async dispose() {
      const all = [...byKey.values()];
      byKey.clear();
      await Promise.all(all.map((template) => template.dispose()));
    },
  };
}

module.exports = { buildCommittedRepo, createGitTemplates, initStandardRepo, runGit };
