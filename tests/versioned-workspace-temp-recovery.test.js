'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  recoverVersionedWorkspaceTemps,
  startVersionedWorkspaceTempRecovery,
} = require('../services/versioned-workspace-temp-recovery');

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-vfs-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeRootContext(root, isCurrent = () => true) {
  const context = {
    rootPath: root,
    rootId: 'root_recovery_test',
    generation: 7,
    phase: 'ready',
  };
  return {
    captureContext: () => context,
    isCurrent,
  };
}

test('temp recovery removes only regular temps whose owner is confirmed gone', async (t) => {
  const root = makeRoot(t);
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested);
  const deadTemp = path.join(nested, '.alpha.txt.jenny-vfs-1111-0123456789abcdef');
  const liveTemp = path.join(root, '.beta.txt.jenny-vfs-2222-fedcba9876543210');
  const tempDirectory = path.join(root, '.folder.jenny-vfs-1111-aaaaaaaaaaaaaaaa');
  const unrelated = path.join(root, '.alpha.txt.jenny-vfs-not-owned');
  fs.writeFileSync(deadTemp, 'dead');
  fs.writeFileSync(liveTemp, 'live');
  fs.mkdirSync(tempDirectory);
  fs.writeFileSync(unrelated, 'keep');

  const outcome = await recoverVersionedWorkspaceTemps({
    rootContext: makeRootContext(root),
    isProcessAlive: (pid) => pid === 2222,
  });

  assert.equal(outcome.status, 'complete');
  assert.equal(outcome.deleted, 1);
  assert.equal(outcome.live_or_unknown_owners, 1);
  assert.equal(fs.existsSync(deadTemp), false);
  assert.equal(fs.readFileSync(liveTemp, 'utf8'), 'live');
  assert.equal(fs.statSync(tempDirectory).isDirectory(), true);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
});

test('temp recovery stops before unlink when the root generation changes', async (t) => {
  const root = makeRoot(t);
  const temp = path.join(root, '.alpha.txt.jenny-vfs-1111-0123456789abcdef');
  fs.writeFileSync(temp, 'keep');
  let checks = 0;

  const outcome = await recoverVersionedWorkspaceTemps({
    rootContext: makeRootContext(root, () => {
      checks += 1;
      return checks < 4;
    }),
    isProcessAlive: () => false,
  });

  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.reason, 'root_changed');
  assert.equal(fs.readFileSync(temp, 'utf8'), 'keep');
});

test('temp recovery rechecks root ownership after an empty directory await', async () => {
  let checks = 0;
  const directoryStats = {
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
  const outcome = await recoverVersionedWorkspaceTemps({
    rootContext: makeRootContext('/workspace', () => {
      checks += 1;
      return checks < 3;
    }),
    fs: {
      realpath: async (value) => value,
      lstat: async () => directoryStats,
      opendir: async () => ({
        async *[Symbol.asyncIterator]() {},
      }),
    },
    path: path.posix,
  });

  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.reason, 'root_changed');
});

test('temp recovery preserves root-change cancellation after directory truncation', async () => {
  let checks = 0;
  const directoryStats = {
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
  const outcome = await recoverVersionedWorkspaceTemps({
    rootContext: makeRootContext('/workspace', () => {
      checks += 1;
      return checks < 4;
    }),
    fs: {
      realpath: async (value) => value,
      lstat: async () => directoryStats,
      opendir: async () => ({
        async *[Symbol.asyncIterator]() {
          yield {
            name: 'nested',
            isDirectory: () => true,
            isSymbolicLink: () => false,
          };
        },
      }),
    },
    path: path.posix,
    maxDirectories: 1,
  });

  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.reason, 'root_changed');
  assert.equal(outcome.truncated, false);
});

test('temp recovery refuses an identity swap immediately before unlink', async () => {
  const tempName = '.alpha.txt.jenny-vfs-1111-0123456789abcdef';
  const directoryStats = {
    dev: 1,
    ino: 1,
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
  };
  const firstFileStats = {
    dev: 1,
    ino: 2,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  const replacedFileStats = { ...firstFileStats, ino: 3 };
  let candidateStatsCalls = 0;
  let unlinkCalls = 0;

  const outcome = await recoverVersionedWorkspaceTemps({
    rootContext: makeRootContext('/workspace'),
    fs: {
      realpath: async (value) => value,
      lstat: async (value) => {
        if (value === '/workspace') return directoryStats;
        candidateStatsCalls += 1;
        return candidateStatsCalls === 1 ? firstFileStats : replacedFileStats;
      },
      opendir: async () => ({
        async *[Symbol.asyncIterator]() {
          yield {
            name: tempName,
            isDirectory: () => false,
            isSymbolicLink: () => false,
          };
        },
      }),
      unlink: async () => { unlinkCalls += 1; },
    },
    path: path.posix,
    isProcessAlive: () => false,
  });

  assert.equal(outcome.status, 'complete');
  assert.equal(outcome.deleted, 0);
  assert.equal(unlinkCalls, 0);
});

test('temp recovery refuses root or parent replacement before unlink', async () => {
  const tempName = '.alpha.txt.jenny-vfs-1111-0123456789abcdef';
  const directoryStats = {
    dev: 1,
    ino: 1,
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
  };
  const replacedDirectoryStats = { ...directoryStats, ino: 9 };
  const fileStats = {
    dev: 1,
    ino: 2,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  };

  for (const replacedPath of ['/workspace', '/workspace/nested']) {
    let unlinkCalls = 0;
    const lstatCounts = new Map();
    const outcome = await recoverVersionedWorkspaceTemps({
      rootContext: makeRootContext('/workspace'),
      fs: {
        realpath: async (value) => value,
        lstat: async (value) => {
          const count = (lstatCounts.get(value) || 0) + 1;
          lstatCounts.set(value, count);
          if (value.endsWith(tempName)) return fileStats;
          if (value === replacedPath && count > 1) return replacedDirectoryStats;
          return directoryStats;
        },
        opendir: async (value) => ({
          async *[Symbol.asyncIterator]() {
            if (value === '/workspace') {
              yield {
                name: 'nested',
                isDirectory: () => true,
                isSymbolicLink: () => false,
              };
            } else {
              yield {
                name: tempName,
                isDirectory: () => false,
                isSymbolicLink: () => false,
              };
            }
          },
        }),
        unlink: async () => { unlinkCalls += 1; },
      },
      path: path.posix,
      isProcessAlive: () => false,
    });

    assert.equal(outcome.status, 'complete');
    assert.equal(outcome.deleted, 0);
    assert.equal(unlinkCalls, 0);
  }
});

test('temp recovery retains a candidate when its owner PID becomes live before unlink', async (t) => {
  const root = makeRoot(t);
  const temp = path.join(root, '.alpha.txt.jenny-vfs-1111-0123456789abcdef');
  fs.writeFileSync(temp, 'keep');
  let livenessChecks = 0;

  const outcome = await recoverVersionedWorkspaceTemps({
    rootContext: makeRootContext(root),
    isProcessAlive: () => {
      livenessChecks += 1;
      return livenessChecks > 1;
    },
  });

  assert.equal(outcome.deleted, 0);
  assert.equal(outcome.live_or_unknown_owners, 1);
  assert.equal(fs.readFileSync(temp, 'utf8'), 'keep');
});

test('temp recovery treats a throwing current-context check as cancellation', async () => {
  const outcome = await recoverVersionedWorkspaceTemps({
    rootContext: makeRootContext('/workspace', () => { throw new Error('unavailable'); }),
    fs: {
      realpath: async (value) => value,
      lstat: async () => ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
      }),
    },
    path: path.posix,
  });

  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.reason, 'root_changed');
});

test('temp recovery enforces entry and deletion budgets with truthful metadata', async (t) => {
  const root = makeRoot(t);
  for (let index = 0; index < 8; index += 1) {
    fs.writeFileSync(
      path.join(root, `.file-${index}.jenny-vfs-1111-${String(index).padStart(16, '0')}`),
      'orphan'
    );
  }

  const entryLimited = await recoverVersionedWorkspaceTemps({
    rootContext: makeRootContext(root),
    isProcessAlive: () => false,
    maxEntries: 2,
  });
  assert.equal(entryLimited.status, 'partial');
  assert.equal(entryLimited.reason, 'entry_limit');
  assert.equal(entryLimited.truncated, true);
  assert.equal(entryLimited.entries_scanned, 2);

  const deleteLimited = await recoverVersionedWorkspaceTemps({
    rootContext: makeRootContext(root),
    isProcessAlive: () => false,
    maxDeletions: 1,
  });
  assert.equal(deleteLimited.status, 'partial');
  assert.equal(deleteLimited.reason, 'delete_limit');
  assert.equal(deleteLimited.deleted, 1);
});

test('unknown process liveness fails closed and recovery diagnostics stay redacted', async (t) => {
  const root = makeRoot(t);
  const temp = path.join(root, '.alpha.txt.jenny-vfs-1111-0123456789abcdef');
  fs.writeFileSync(temp, 'keep');
  const events = [];

  const outcome = await startVersionedWorkspaceTempRecovery({
    rootContext: makeRootContext(root),
    isProcessAlive: () => { throw new Error(`secret path ${root}`); },
    logger: (...args) => events.push(args),
  });

  assert.equal(outcome.deleted, 0);
  assert.equal(outcome.live_or_unknown_owners, 1);
  assert.equal(outcome.errors, 1);
  assert.equal(fs.readFileSync(temp, 'utf8'), 'keep');
  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'WARN');
  assert.equal(events[0][1], 'workspace_file.temp_recovery');
  assert.equal(JSON.stringify(events[0]).includes(root), false);
});

test('temp recovery skips missing roots without throwing', async () => {
  const root = path.join(os.tmpdir(), `jenny-missing-${Date.now()}`);
  const outcome = await recoverVersionedWorkspaceTemps({
    rootContext: makeRootContext(root),
    fs: fsPromises,
  });

  assert.deepEqual(outcome, {
    status: 'skipped',
    reason: 'root_unavailable',
    directories_scanned: 0,
    entries_scanned: 0,
    deleted: 0,
    live_or_unknown_owners: 0,
    errors: 0,
    truncated: false,
  });
});
