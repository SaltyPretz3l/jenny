'use strict';

/* UIUX-031 CBV evidence: services/workspace-ide-enumerator.js walkWorkspaceFiles
 * already implements a cursor-based (non-shift) BFS queue plus directory/entry/
 * time caps, AbortSignal cancellation, and partial-result metadata (landed at
 * ff34bff6 "fix(workspace): bound IDE enumeration work", ancestor of HEAD).
 * These tests pin that contract with an in-memory synthetic tree and an
 * injected clock — no wall-clock assertions, no real filesystem. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  walkWorkspaceFiles,
} = require('../services/workspace-ide-enumerator');

function makeDirent(name, kind) {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
  };
}

// Builds a synthetic tree: `dir -> [ [name, 'dir'|'file'|'symlink'], ... ]`.
// resolveDirectory below maps relPath '' (root) to the '<root>' sentinel so
// it stays truthy — walkWorkspaceFiles treats a falsy resolveDirectory
// result as "directory vanished, skip", exactly like the real service does
// for a realpath.
function makeFakeFs(tree) {
  return {
    async opendir(directoryPath) {
      const entries = tree[directoryPath] || [];
      let index = 0;
      const iterator = {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          if (index >= entries.length) return { done: true, value: undefined };
          const [name, kind] = entries[index];
          index += 1;
          return { done: false, value: makeDirent(name, kind) };
        },
        async close() {},
      };
      return iterator;
    },
  };
}

function makeClock(startMs, stepMs = 1) {
  let current = startMs;
  return () => {
    const value = current;
    current += stepMs;
    return value;
  };
}

test('walkWorkspaceFiles never calls Array.prototype.shift (cursor index, not O(n^2) dequeue)', async () => {
  // Wide, flat tree: 500 subdirectories directly under root, each with 1 file.
  // A shift-based queue would still "work" here, so this test asserts on the
  // *mechanism* directly rather than inferring it from wall-clock timing.
  const tree = { '<root>': [] };
  for (let i = 0; i < 500; i += 1) {
    const dirName = `d${i}`;
    tree['<root>'].push([dirName, 'dir']);
    tree[dirName] = [['file.txt', 'file']];
  }
  const fakeFs = makeFakeFs(tree);

  const originalShift = Array.prototype.shift;
  let shiftCalls = 0;
  Array.prototype.shift = function trackedShift(...args) {
    shiftCalls += 1;
    return originalShift.apply(this, args);
  };
  let metadata;
  try {
    metadata = await walkWorkspaceFiles({
      fs: fakeFs,
      resolveDirectory: async (relPath) => relPath || '<root>',
      onFile: async () => true,
      maxDurationMs: 10_000,
      maxDirectories: 10_000,
      maxEntries: 100_000,
      maxFiles: 100_000,
      now: makeClock(0),
    });
  } finally {
    Array.prototype.shift = originalShift;
  }

  assert.equal(shiftCalls, 0, 'walkWorkspaceFiles must dequeue via a cursor index, not Array#shift');
  assert.equal(metadata.truncated, false);
  assert.equal(metadata.directoriesScanned, 501); // root + 500 subdirs
  assert.equal(metadata.filesScanned, 500);
});

test('walkWorkspaceFiles enforces maxDirectories and reports partial-result metadata', async () => {
  const tree = { '<root>': [] };
  for (let i = 0; i < 50; i += 1) {
    const dirName = `d${i}`;
    tree['<root>'].push([dirName, 'dir']);
    tree[dirName] = [['file.txt', 'file']];
  }
  const fakeFs = makeFakeFs(tree);

  const metadata = await walkWorkspaceFiles({
    fs: fakeFs,
    resolveDirectory: async (relPath) => relPath || '<root>',
    onFile: async () => true,
    maxDirectories: 5,
    maxDurationMs: 10_000,
    maxEntries: 100_000,
    maxFiles: 100_000,
    now: makeClock(0),
  });

  assert.equal(metadata.truncated, true);
  assert.equal(metadata.truncationReason, 'directory_limit');
  assert.equal(metadata.totalsKnown, false);
  // Root queued eagerly; the cap is checked against directories QUEUED for
  // walking, so scanned count sits at the cap boundary, not the full 51.
  assert.ok(metadata.directoriesScanned <= 5, `expected <=5 directories scanned, got ${metadata.directoriesScanned}`);
});

test('walkWorkspaceFiles enforces a caller-injected time budget via the injected clock (no wall clock)', async () => {
  const tree = { '<root>': [] };
  for (let i = 0; i < 20; i += 1) {
    const dirName = `d${i}`;
    tree['<root>'].push([dirName, 'dir']);
    tree[dirName] = [['file.txt', 'file']];
  }
  const fakeFs = makeFakeFs(tree);

  // Clock jumps straight past the budget on the second read so the time
  // check trips deterministically without any real elapsed time.
  let calls = 0;
  const clock = () => {
    calls += 1;
    return calls <= 1 ? 0 : 10_000;
  };

  const metadata = await walkWorkspaceFiles({
    fs: fakeFs,
    resolveDirectory: async (relPath) => relPath || '<root>',
    onFile: async () => true,
    maxDurationMs: 5,
    maxDirectories: 10_000,
    maxEntries: 100_000,
    maxFiles: 100_000,
    now: clock,
  });

  assert.equal(metadata.truncated, true);
  assert.equal(metadata.truncationReason, 'time_limit');
  assert.equal(metadata.totalsKnown, false);
});

test('walkWorkspaceFiles honors AbortSignal cancellation mid-walk with partial metadata', async () => {
  const tree = { '<root>': [] };
  for (let i = 0; i < 20; i += 1) {
    const dirName = `d${i}`;
    tree['<root>'].push([dirName, 'dir']);
    tree[dirName] = [['file.txt', 'file']];
  }
  const fakeFs = makeFakeFs(tree);
  const controller = new AbortController();
  let onFileCalls = 0;

  const metadata = await walkWorkspaceFiles({
    fs: fakeFs,
    resolveDirectory: async (relPath) => relPath || '<root>',
    onFile: async () => {
      onFileCalls += 1;
      if (onFileCalls === 3) controller.abort();
      return true;
    },
    maxDurationMs: 10_000,
    maxDirectories: 10_000,
    maxEntries: 100_000,
    maxFiles: 100_000,
    signal: controller.signal,
    now: makeClock(0),
  });

  assert.equal(metadata.truncated, true);
  assert.equal(metadata.truncationReason, 'cancelled');
  assert.equal(metadata.totalsKnown, false);
  assert.ok(onFileCalls < 20, 'walk must stop early after abort, not process every directory');
});

test('walkWorkspaceFiles enforces maxEntries and maxFiles caps independently of directory count', async () => {
  const fakeFs = makeFakeFs({
    '<root>': [
      ['a.txt', 'file'],
      ['b.txt', 'file'],
      ['c.txt', 'file'],
      ['d.txt', 'file'],
    ],
  });

  const entryCapped = await walkWorkspaceFiles({
    fs: fakeFs,
    resolveDirectory: async (relPath) => relPath || '<root>',
    onFile: async () => true,
    maxEntries: 2,
    maxDurationMs: 10_000,
    maxDirectories: 10_000,
    maxFiles: 100_000,
    now: makeClock(0),
  });
  assert.equal(entryCapped.truncated, true);
  assert.equal(entryCapped.truncationReason, 'entry_limit');

  const fileCapped = await walkWorkspaceFiles({
    fs: fakeFs,
    resolveDirectory: async (relPath) => relPath || '<root>',
    onFile: async () => true,
    maxFiles: 2,
    maxDurationMs: 10_000,
    maxDirectories: 10_000,
    maxEntries: 100_000,
    now: makeClock(0),
  });
  assert.equal(fileCapped.truncated, true);
  assert.equal(fileCapped.truncationReason, 'file_limit');
});
