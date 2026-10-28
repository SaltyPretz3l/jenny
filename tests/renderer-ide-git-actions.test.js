'use strict';
// Row 82 G1: the git feature's Source Control operations (renderer-ide-git-actions.js):
// Open Changes / Open Staged Changes / commit file diffs as Monaco diff tabs, Unstage All,
// Discard All (one discardFiles write, cleanup wave G3), the amend prefill.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeGitActions } = require('../renderer/features/renderer-ide-git-actions');
const { toLf } = require('../renderer/features/renderer-ide-replace-text-utils');

// The service's answer for a batch: every path restored or trashed by its class.
const discardAnswer = ({ paths }) => ({
  ok: true, op: 'discardFiles',
  tracked: paths.filter((path) => !path.endsWith('.txt')), untracked: paths.filter((path) => path.endsWith('.txt')), failed: [],
});

function harness({ files = [], client = {}, disk = {}, confirm = true, openDocs = [], lifecycle = null } = {}) {
  let epoch = 0;
  const calls = { tabs: [], toasts: [], reads: [], mutations: [], confirms: [], holds: 0, released: 0, lifecycle: [] };
  const store = {
    getSnapshot: () => ({ files }),
    getDecoration: (path) => files.find((file) => file.path === path)?.state || null,
    beginRefreshHold: () => { calls.holds += 1; return async () => { calls.released += 1; }; },
  };
  const gitClient = {};
  for (const [method, impl] of Object.entries(client)) {
    gitClient[method] = async (payload) => { calls.reads.push([method, payload]); return impl(payload); };
  }
  const actions = createIdeGitActions({
    client: gitClient,
    store,
    getRootEpoch: () => epoch,
    openDiffTabFor: async (tabEpoch, doc) => { calls.tabs.push({ epoch: tabEpoch, ...doc }); return true; },
    getWorkspaceFsApi: () => ({
      readFile: async ({ path }) => {
        if (!(path in disk)) throw new Error('ENOENT');
        return { content: disk[path] };
      },
    }),
    scmToast: (message) => calls.toasts.push(message),
    confirmDialog: { confirm: async (spec) => { calls.confirms.push(spec); return confirm; } },
    hasDocument: (path) => openDocs.includes(path),
    getFileLifecycle: () => lifecycle || {
      captureGitDiscard: (path) => { calls.lifecycle.push(['capture', path]); return { path }; },
      reloadAfterGitDiscard: async (snapshot) => { calls.lifecycle.push(['reload', snapshot.path]); return true; },
      releaseGitDiscard: (snapshot) => { calls.lifecycle.push(['release', snapshot.path]); },
      closeTab: (path) => { calls.lifecycle.push(['close', path]); },
    },
    mutateWithFeedback: async (action, paths) => { calls.mutations.push([action, paths]); return { ok: true }; },
    diffTabPrefix: 'diff://',
    toLf,
  });
  return { actions, calls, bumpEpoch: () => { epoch += 1; } };
}

const found = (content) => ({ ok: true, found: true, content });
const missing = (reason) => ({ ok: true, found: false, reason });

test('Open Changes diffs the index copy against the working tree (CRLF-normalized)', async () => {
  const { actions, calls } = harness({
    client: { getFileAtIndex: () => found('staged\r\n') },
    disk: { 'src/a.js': 'working\r\n' },
  });
  assert.equal(await actions.openChanges('src/a.js'), true);
  assert.deepEqual(calls.tabs, [{
    epoch: 0, id: 'diff://index/src/a.js', label: 'a.js (Working Tree)', languagePath: 'src/a.js',
    original: 'staged\n', modified: 'working\n',
  }]);
});

test('an untracked file opens as all additions; a deleted one as a deletion', async () => {
  const { actions, calls } = harness({
    files: [{ path: 'gone.txt', state: 'deleted' }],
    client: { getFileAtIndex: ({ path }) => (path === 'new.txt' ? missing('not_in_index') : found('was here\n')) },
    disk: { 'new.txt': 'fresh\n' },
  });
  await actions.openChanges('new.txt');
  await actions.openChanges('gone.txt');
  assert.deepEqual(calls.tabs.map((tab) => [tab.original, tab.modified]), [['', 'fresh\n'], ['was here\n', '']]);
});

test('Open Staged Changes diffs HEAD (at a rename’s original path) against the index', async () => {
  const { actions, calls } = harness({
    files: [{ path: 'src/new.js', origPath: 'src/old.js', state: 'renamed', staged: true }],
    client: {
      getFileAtHead: () => found('head\n'),
      getFileAtIndex: () => found('index\n'),
    },
  });
  assert.equal(await actions.openForRow('src/new.js', { staged: true }), true);
  assert.deepEqual(calls.reads, [['getFileAtHead', { path: 'src/old.js' }], ['getFileAtIndex', { path: 'src/new.js' }]]);
  assert.deepEqual([calls.tabs[0].id, calls.tabs[0].label, calls.tabs[0].original, calls.tabs[0].modified],
    ['diff://staged/src/new.js', 'new.js (Index)', 'head\n', 'index\n']);
});

test('a failed read toasts and opens nothing (never a fabricated side)', async () => {
  const { actions, calls } = harness({
    client: { getFileAtHead: () => ({ ok: false, reason: 'git_failed' }), getFileAtIndex: () => found('x\n') },
  });
  assert.equal(await actions.openStagedChanges('a.txt'), false);
  assert.equal(calls.tabs.length, 0);
  assert.equal(calls.toasts.length, 1);
  assert.equal(await actions.openChanges('a.txt'), false, 'disk read failed for a non-deleted file');
  assert.equal(calls.tabs.length, 0);
});

test('a result that lands after a root switch is dropped', async () => {
  let release;
  const h = harness({ client: { getFileAtIndex: () => new Promise((resolve) => { release = resolve; }) }, disk: { 'a.txt': 'x\n' } });
  const pending = h.actions.openChanges('a.txt');
  h.bumpEpoch();
  release(found('y\n'));
  assert.equal(await pending, false);
  assert.equal(h.calls.tabs.length, 0);
  assert.equal(h.calls.toasts.length, 0);
});

test('a commit file diff reads the parent and the commit; added and root files have an empty parent', async () => {
  const { actions, calls } = harness({
    client: {
      getFileAtCommit: ({ path, parent }) => (parent ? (path === 'old.js' ? found('before\n') : missing('no_parent')) : found('after\n')),
    },
  });
  await actions.openCommitFileDiff({ hash: 'abcdef1234', path: 'new.js', origPath: 'old.js', status: 'R' });
  await actions.openCommitFileDiff({ hash: 'abcdef1234', path: 'first.js', status: 'A' });
  assert.deepEqual(calls.reads.slice(0, 2), [
    ['getFileAtCommit', { hash: 'abcdef1234', path: 'old.js', parent: true }],
    ['getFileAtCommit', { hash: 'abcdef1234', path: 'new.js' }],
  ]);
  assert.deepEqual(calls.tabs.map((tab) => [tab.id, tab.label, tab.original, tab.modified]), [
    ['diff://commit-file/abcdef1234/new.js', 'new.js (abcdef1)', 'before\n', 'after\n'],
    ['diff://commit-file/abcdef1234/first.js', 'first.js (abcdef1)', '', 'after\n'],
  ]);
});

const FILES = [
  { path: 'a.js', state: 'modified', staged: false, worktree: 'M' },
  { path: 'b.js', state: 'modified', staged: true, worktree: 'M' },
  { path: 'c.js', state: 'added', staged: true, worktree: ' ' },
  { path: 'n.txt', state: 'untracked', staged: false, worktree: '?' },
  { path: 'x.js', state: 'conflicted', staged: true, worktree: 'U' },
];

test('Unstage All and Stage All take every staged / changed file, never a conflict', async () => {
  const { actions, calls } = harness({ files: FILES });
  await actions.unstageAll();
  await actions.stageAll();
  assert.deepEqual(calls.mutations, [['unstage', ['b.js', 'c.js']], ['stage-all', ['a.js', 'b.js', 'n.txt']]]);
});

test('Discard All confirms once with the counts, then discards every Changed file in ONE write under one hold', async () => {
  const { actions, calls } = harness({ files: FILES, client: { discardFiles: discardAnswer } });
  assert.deepEqual(await actions.discardAll(), { discarded: 3 });
  assert.equal(calls.confirms.length, 1);
  assert.equal(calls.confirms[0].variant, 'danger');
  assert.match(calls.confirms[0].title, /3 files/);
  assert.match(calls.confirms[0].message, /1 new file moves to the recycle bin/);
  assert.deepEqual(calls.reads, [['discardFiles', { paths: ['a.js', 'b.js', 'n.txt'] }]]);
  assert.deepEqual([calls.holds, calls.released], [1, 1]);
  assert.equal(calls.toasts.length, 0);
});

test('Discard All reconciles open editors: a restored file reloads, a trashed one closes, an unprepared one is left out', async () => {
  const { actions, calls } = harness({ files: FILES, openDocs: ['a.js', 'n.txt'], client: { discardFiles: discardAnswer } });
  await actions.discardAll();
  assert.deepEqual(calls.lifecycle, [
    ['capture', 'a.js'], ['capture', 'n.txt'], ['reload', 'a.js'], ['close', 'n.txt'], ['release', 'a.js'], ['release', 'n.txt'],
  ]);
  const unprepared = harness({ files: FILES, openDocs: ['b.js'], lifecycle: { captureGitDiscard: () => null }, client: { discardFiles: discardAnswer } });
  assert.deepEqual(await unprepared.actions.discardAll(), { discarded: 2 });
  assert.deepEqual(unprepared.calls.reads, [['discardFiles', { paths: ['a.js', 'n.txt'] }]]);
  assert.match(unprepared.calls.toasts[0], /Could not safely prepare the open editor for "b\.js"/);
});

test('Discard All does nothing when declined; a refused file or a failed write toasts and the hold is released', async () => {
  const declined = harness({ files: FILES, confirm: false, client: { discardFiles: discardAnswer } });
  assert.deepEqual(await declined.actions.discardAll(), { discarded: 0 });
  assert.equal(declined.calls.reads.length, 0);
  const partial = harness({ files: FILES, client: { discardFiles: () => ({ ok: true, tracked: ['a.js', 'b.js'], untracked: [], failed: [{ path: 'n.txt', reason: 'trash_unavailable', message: 'No recycle bin.' }] }) } });
  assert.deepEqual(await partial.actions.discardAll(), { discarded: 2 });
  assert.deepEqual(partial.calls.toasts, ['No recycle bin.']);
  const failing = harness({ files: FILES, client: { discardFiles: () => ({ ok: false, reason: 'git_failed', message: '' }) } });
  assert.deepEqual(await failing.actions.discardAll(), { discarded: 0 });
  assert.match(failing.calls.toasts[0], /Could not discard the selected files/);
  assert.equal(failing.calls.released, 1, 'the hold is released after a failure');
});

test('the amend prefill reads the last commit message; a failed read yields an empty prefill', async () => {
  assert.equal(await harness({ client: { getLastCommitMessage: () => ({ ok: true, found: true, message: 'subject\n\nbody' }) } }).actions.getLastCommitMessage(), 'subject\n\nbody');
  assert.equal(await harness({ client: { getLastCommitMessage: () => ({ ok: false }) } }).actions.getLastCommitMessage(), '');
  assert.equal(await harness().actions.getLastCommitMessage(), '', 'no bridge method');
});
