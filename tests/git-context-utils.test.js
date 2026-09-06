'use strict';

// Coverage for services/backend/git-context-utils.js
//
// Uses real temporary git repositories (created via execFileSync) to exercise
// getGitContextForChat end-to-end — including the falsy-input guard, the fast
// .git-presence check, the clean-repo short-circuit, the working-tree counts,
// the diff-summary/diff sections, and the MAX_DIFF_CHARS truncation path.
//
// No electron mock needed: the module has no Electron dependency.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { getGitContextForChat } = require('../services/backend/git-context-utils');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `jenny-git-ctx-${label}-`));
}

function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

function gitInit(dir) {
  git(['init'], dir);
  git(['config', 'user.email', 'test@jenny.local'], dir);
  git(['config', 'user.name', 'Jenny Test'], dir);
}

function writeFile(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content);
}

// Records every fs.accessSync call made during `fn`, then restores the real
// implementation. The module calls `fs.accessSync(...)` as a property on the
// shared fs object, so this interception is visible to it. accessSync is
// synchronous and runs (or is skipped) before any await inside
// getGitContextForChat, so the recorded calls fully reflect whether the
// fast .git-presence check ran. The spy calls through, preserving real throw
// behavior for a missing .git.
async function withAccessSyncSpy(fn) {
  const calls = [];
  const real = fs.accessSync;
  fs.accessSync = (...args) => {
    calls.push(args.map(String));
    return real.apply(fs, args);
  };
  try {
    return await fn(calls);
  } finally {
    fs.accessSync = real;
  }
}

// ---------------------------------------------------------------------------
// Guard: falsy / non-string inputs
// ---------------------------------------------------------------------------

describe('getGitContextForChat — input guards', () => {
  test('returns null for null', async () => {
    const result = await getGitContextForChat(null);
    assert.equal(result, null);
  });

  test('returns null for undefined', async () => {
    const result = await getGitContextForChat(undefined);
    assert.equal(result, null);
  });

  test('returns null for empty string without consulting the filesystem', async () => {
    // The `!workspaceRoot` clause must short-circuit before fs.accessSync.
    // (Removing it would let '' fall through to fs.accessSync('.git') resolved
    // against process.cwd(), which in a real repo would NOT return null — so
    // the zero-accessSync-calls assertion pins that clause specifically.)
    await withAccessSyncSpy(async (calls) => {
      const result = await getGitContextForChat('');
      assert.equal(result, null);
      assert.equal(calls.length, 0, 'fs.accessSync must not run for an empty-string root');
    });
  });

  test('returns null for a truthy non-string input (typeof guard branch)', async () => {
    // 42 is truthy, so it exercises the `typeof workspaceRoot !== 'string'`
    // branch of the guard rather than the falsy branch above.
    const result = await getGitContextForChat(42);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Guard: non-git directory (existing directory, no .git)
// ---------------------------------------------------------------------------

describe('getGitContextForChat — non-git directory', () => {
  let tempDir;

  before(() => {
    tempDir = makeTempDir('nongit');
    // No git init — just a plain directory.
  });

  after(() => {
    removeTempDir(tempDir);
  });

  test('returns null via the fast .git-presence check (no git subprocess)', async () => {
    // The fast path is `fs.accessSync(path.join(root, '.git'))` inside a
    // try/catch. For a non-git dir it throws -> caught -> returns null BEFORE
    // any git subprocess runs. Asserting accessSync was called exactly once
    // with `<dir>/.git` pins the fast-path block: deleting it makes accessSync
    // run zero times (the function would instead spawn four git processes).
    await withAccessSyncSpy(async (calls) => {
      const result = await getGitContextForChat(tempDir);
      assert.equal(result, null);
      assert.equal(calls.length, 1, 'fast path must consult fs.accessSync exactly once');
      assert.deepEqual(calls[0], [path.join(tempDir, '.git')]);
    });
  });
});

// ---------------------------------------------------------------------------
// Clean repo: no changes => null
// ---------------------------------------------------------------------------

describe('getGitContextForChat — clean repo', () => {
  let tempDir;

  before(() => {
    tempDir = makeTempDir('clean');
    gitInit(tempDir);
    // Commit one file so HEAD exists and the repo is pristine.
    writeFile(tempDir, 'readme.txt', 'hello\n');
    git(['add', 'readme.txt'], tempDir);
    git(['commit', '-m', 'initial'], tempDir);
  });

  after(() => {
    removeTempDir(tempDir);
  });

  test('returns null when there are no changes', async () => {
    const result = await getGitContextForChat(tempDir);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Repo WITH changes: staged, unstaged, untracked
// ---------------------------------------------------------------------------

describe('getGitContextForChat — repo with changes', () => {
  let tempDir;
  let result;

  before(async () => {
    tempDir = makeTempDir('dirty');
    gitInit(tempDir);

    // Initial commit.
    writeFile(tempDir, 'file-a.txt', 'line1\nline2\n');
    writeFile(tempDir, 'file-b.txt', 'alpha\nbeta\n');
    git(['add', '.'], tempDir);
    git(['commit', '-m', 'initial'], tempDir);

    // 1 staged change: modify file-a and stage it.
    writeFile(tempDir, 'file-a.txt', 'line1\nline2\nline3\n');
    git(['add', 'file-a.txt'], tempDir);

    // 1 unstaged change: modify file-b but do NOT stage.
    writeFile(tempDir, 'file-b.txt', 'alpha\nbeta\ngamma\n');

    // 1 untracked file.
    writeFile(tempDir, 'new-file.txt', 'untracked content\n');

    result = await getGitContextForChat(tempDir);
  });

  after(() => {
    removeTempDir(tempDir);
  });

  test('returns a string (not null)', () => {
    assert.equal(typeof result, 'string');
    assert.notEqual(result, null);
  });

  test('contains [Git workspace context] header', () => {
    assert.ok(
      result.includes('[Git workspace context]'),
      `Expected "[Git workspace context]" in result:\n${result}`
    );
  });

  test('contains Branch: line', () => {
    assert.ok(
      /Branch:\s+\S+/.test(result),
      `Expected "Branch: <name>" in result:\n${result}`
    );
  });

  test('Working tree line shows 1 staged, 1 unstaged, 1 untracked', () => {
    // Must match the exact counts produced by the 3 changes we made above.
    assert.ok(
      result.includes('1 staged'),
      `Expected "1 staged" in result:\n${result}`
    );
    assert.ok(
      result.includes('1 unstaged'),
      `Expected "1 unstaged" in result:\n${result}`
    );
    assert.ok(
      result.includes('1 untracked'),
      `Expected "1 untracked" in result:\n${result}`
    );
    assert.ok(
      /Working tree:/.test(result),
      `Expected "Working tree:" in result:\n${result}`
    );
  });

  test('contains Diff summary: section', () => {
    assert.ok(
      result.includes('Diff summary:'),
      `Expected "Diff summary:" in result:\n${result}`
    );
  });

  test('contains Diff: section', () => {
    assert.ok(
      result.includes('Diff:'),
      `Expected "Diff:" in result:\n${result}`
    );
  });
});

// ---------------------------------------------------------------------------
// MAX_DIFF_CHARS truncation (4000 chars)
// ---------------------------------------------------------------------------

describe('getGitContextForChat — diff truncation', () => {
  let tempDir;
  let result;

  before(async () => {
    tempDir = makeTempDir('trunc');
    gitInit(tempDir);

    // Write a large file and commit it.
    const baseContent = Array.from({ length: 200 }, (_, i) => `base line ${i}\n`).join('');
    writeFile(tempDir, 'big.txt', baseContent);
    git(['add', 'big.txt'], tempDir);
    git(['commit', '-m', 'initial big'], tempDir);

    // Replace every line to force a large diff.
    const changedContent = Array.from({ length: 200 }, (_, i) => `changed line ${i} ${'x'.repeat(40)}\n`).join('');
    writeFile(tempDir, 'big.txt', changedContent);
    git(['add', 'big.txt'], tempDir);

    result = await getGitContextForChat(tempDir);
  });

  after(() => {
    removeTempDir(tempDir);
  });

  test('result is a non-null string', () => {
    assert.equal(typeof result, 'string');
    assert.notEqual(result, null);
  });

  test('truncation notice appears when diff exceeds MAX_DIFF_CHARS (4000)', () => {
    assert.ok(
      result.includes('(diff truncated at 4000 chars)'),
      `Expected truncation notice in result. Got:\n${result.slice(-300)}`
    );
  });

  test('truncated diff does not exceed MAX_DIFF_CHARS + noise budget', () => {
    // The Diff: section content should be capped near 4000 chars.
    const diffIdx = result.indexOf('\nDiff:\n');
    assert.ok(diffIdx !== -1, 'Expected Diff: section');
    const diffSection = result.slice(diffIdx);
    // The diff content itself is sliced to 4000; the header + truncation suffix
    // add a small constant overhead. A generous budget of 4300 guards the
    // truncation is actually applied.
    assert.ok(
      diffSection.length < 4300,
      `Diff section length ${diffSection.length} exceeds truncation budget`
    );
  });
});

// ---------------------------------------------------------------------------
// Only untracked files (no diff against HEAD)
// ---------------------------------------------------------------------------

describe('getGitContextForChat — untracked-only repo', () => {
  let tempDir;
  let result;

  before(async () => {
    tempDir = makeTempDir('untracked');
    gitInit(tempDir);

    // Commit one file so HEAD is valid.
    writeFile(tempDir, 'base.txt', 'existing\n');
    git(['add', 'base.txt'], tempDir);
    git(['commit', '-m', 'initial'], tempDir);

    // Only an untracked file — no diff against HEAD.
    writeFile(tempDir, 'untracked.txt', 'brand new\n');

    result = await getGitContextForChat(tempDir);
  });

  after(() => {
    removeTempDir(tempDir);
  });

  test('returns a string (not null) when untracked file exists', () => {
    // statusLines is non-empty so the function should return a context string.
    assert.equal(typeof result, 'string');
    assert.notEqual(result, null);
  });

  test('Working tree shows 1 untracked', () => {
    assert.ok(
      result.includes('1 untracked'),
      `Expected "1 untracked" in result:\n${result}`
    );
  });

  test('does NOT include Diff: section when no diff against HEAD', () => {
    // Untracked files do not appear in `git diff HEAD`, so there should be no
    // Diff: section (diffContent will be empty).
    assert.ok(
      !result.includes('\nDiff:\n'),
      `Did not expect Diff: section in result:\n${result}`
    );
  });
});

// ---------------------------------------------------------------------------
// Multiple staged files: Working tree counts are exact
// ---------------------------------------------------------------------------

describe('getGitContextForChat — multiple staged files', () => {
  let tempDir;
  let result;

  before(async () => {
    tempDir = makeTempDir('multi');
    gitInit(tempDir);

    // Commit base files.
    for (let i = 0; i < 3; i++) {
      writeFile(tempDir, `file-${i}.txt`, `content ${i}\n`);
    }
    git(['add', '.'], tempDir);
    git(['commit', '-m', 'initial'], tempDir);

    // Stage 2 modifications.
    writeFile(tempDir, 'file-0.txt', 'modified 0\n');
    writeFile(tempDir, 'file-1.txt', 'modified 1\n');
    git(['add', 'file-0.txt', 'file-1.txt'], tempDir);

    // Leave file-2.txt clean; add 2 untracked files.
    writeFile(tempDir, 'new-a.txt', 'new a\n');
    writeFile(tempDir, 'new-b.txt', 'new b\n');

    result = await getGitContextForChat(tempDir);
  });

  after(() => {
    removeTempDir(tempDir);
  });

  test('Working tree shows 2 staged and 2 untracked', () => {
    assert.ok(
      result.includes('2 staged'),
      `Expected "2 staged" in result:\n${result}`
    );
    assert.ok(
      result.includes('2 untracked'),
      `Expected "2 untracked" in result:\n${result}`
    );
  });

  test('does NOT mention unstaged when there are none', () => {
    assert.ok(
      !result.includes('unstaged'),
      `Did not expect "unstaged" when no unstaged changes:\n${result}`
    );
  });
});
