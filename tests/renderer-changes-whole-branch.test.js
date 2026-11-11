'use strict';

// Slice 6 of the chat session bar: the Changes page's Whole branch tab, the summary line under the scope row,
// and the Working tree line about files this chat did not change. The bridge fake answers in the real envelope
// ({ ok, state, reason, sampled_at, data }); a branch read is the one that carries `scope: 'branch'`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createChangesWorkingTree } = require('../renderer/features/renderer-changes-working-tree');

const settle = () => new Promise((resolve) => setImmediate(resolve));
const flush = async () => { for (let pass = 0; pass < 6; pass += 1) await settle(); };

const WT_DIFF = ['--- a/src/shared.js', '+++ b/src/shared.js', '@@ -1,1 +1,2 @@', ' keep', '+WORKING-TREE-LINE'].join('\n');
const BRANCH_DIFF = ['--- a/src/shared.js', '+++ b/src/shared.js', '@@ -1,1 +1,2 @@', ' keep', '+BRANCH-LINE'].join('\n');

const file = (path, extra = {}) => ({ path, orig_path: null, change: 'modified', binary: false, additions: 2, deletions: 1, ...extra });
const WT_FILES = [file('src/shared.js'), file('src/only-working.js')];
const BRANCH_FILES = [file('src/shared.js'), file('src/only-branch.js'), file('docs/plan.md')];

function envelope(state, reason, data) {
  return { schema_version: 1, ok: true, state, reason, sampled_at: '2026-11-09T12:00:00Z', data };
}

function workingListing(files, extra = {}) {
  return envelope('available', null, {
    workspace_id: 'ws1', scope: 'working_tree', ref: 'wt/feature', head: 'abc1234', branch: 'wt/feature', files,
    file_count: files.length, additions: 12, deletions: 3, truncated: false, ...extra,
  });
}

function branchListing(files, extra = {}) {
  return envelope('available', null, {
    workspace_id: 'ws1', scope: 'branch', ref: 'wt/feature', head: 'abc1234', branch: 'wt/feature', files,
    file_count: files.length, additions: 40, deletions: 7, truncated: false,
    base_ref: 'main', merge_base: 'def5678', commit_count: 3, ...extra,
  });
}

const notApplicable = (reason) => envelope('not_applicable', reason, null);

function harness(options = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>');
  const { document } = dom.window;
  const calls = { list: [], diff: [], workspace: [], scope: [] };
  const state = { branch: options.branch === undefined ? () => branchListing(BRANCH_FILES) : options.branch, chat: options.chat === undefined ? null : options.chat };
  let changed = null;
  const timers = [];
  const bridge = {
    listChanges: async (request) => {
      calls.list.push(request);
      return request.scope === 'branch' ? state.branch(request) : workingListing(options.workingFiles || WT_FILES);
    },
    getChangeDiff: async (request) => {
      calls.diff.push(request);
      return { schema_version: 1, ok: true, path: request.path, change: 'modified', binary: false, truncated: false, diff: request.scope === 'branch' ? BRANCH_DIFF : WT_DIFF };
    },
    onChanged: (callback) => { changed = callback; return () => {}; },
  };
  const page = createChangesWorkingTree({
    getBridge: () => bridge,
    getSessionId: () => 'sess_owner',
    openInWorkspace: (path) => calls.workspace.push(path),
    onScopeChange: (scope) => calls.scope.push(scope),
    getChatChangedPaths: () => (typeof state.chat === 'function' ? state.chat() : state.chat),
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
  });
  const root = document.getElementById('root');
  page.mount(root);
  const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return {
    dom, root, page, calls, state, timers,
    emit: () => changed({ schema_version: 1, session_id: 'sess_owner', revision: 9 }),
    tabs: () => Array.from(root.querySelectorAll('.inv-segmented-option')).map((el) => el.getAttribute('data-value')),
    pick: (value) => click(root.querySelector(`.inv-segmented-option[data-value="${value}"]`)),
    row: (path) => Array.from(root.querySelectorAll('.file-diff')).find((el) => el.getAttribute('data-diff-id') === `wt:${path}`),
    rows: () => Array.from(root.querySelectorAll('.file-diff')).map((el) => el.getAttribute('data-diff-id').slice(3)),
    summary: () => root.querySelector('.changes-wt-summary-text')?.textContent || '',
    counts: () => root.querySelector('.changes-wt-summary-counts')?.textContent || '',
    notFromChat: () => root.querySelector('[data-changes-wt-not-chat]')?.textContent || '',
    click,
  };
}

test('the Whole branch tab appears after the probe and reads the branch with scope "branch"', async () => {
  const h = harness();
  assert.deepEqual(h.tabs(), ['working_tree', 'this_chat'], 'no tab until a branch listing answered');
  await flush();
  assert.deepEqual(h.tabs(), ['working_tree', 'this_chat', 'branch']);
  const branchReads = h.calls.list.filter((request) => request.scope === 'branch');
  assert.equal(branchReads.length, 1, 'one probe when the page mounts');
  assert.deepEqual(branchReads[0], { schema_version: 1, session_id: 'sess_owner', scope: 'branch' });
  assert.ok(h.calls.list.some((request) => !('scope' in request)), 'the Working tree read still omits scope');
  h.pick('branch');
  assert.deepEqual(h.rows(), ['src/shared.js', 'src/only-branch.js', 'docs/plan.md']);
  await flush();
  assert.deepEqual(h.calls.diff.filter((request) => request.scope === 'branch').map((request) => request.path), ['src/shared.js']);
  assert.deepEqual(h.calls.diff.find((request) => request.scope === 'branch'), { schema_version: 1, session_id: 'sess_owner', scope: 'branch', path: 'src/shared.js' });
  assert.match(h.row('src/shared.js').textContent, /BRANCH-LINE/);
  assert.deepEqual(h.calls.scope, ['branch'], 'the host follows the page');
});

test('the tab stays out for each not_applicable reason, and a probed page loads no diffs', async () => {
  for (const reason of ['on_base_branch', 'no_base']) {
    const h = harness({ branch: () => notApplicable(reason) });
    await flush();
    assert.deepEqual(h.tabs(), ['working_tree', 'this_chat'], reason);
  }
  const probed = harness();
  await flush();
  assert.deepEqual(probed.calls.diff.filter((request) => request.scope === 'branch'), [], 'nothing asked for the page that is not shown');
});

test('a failed or odd branch answer shows no tab', async () => {
  const failed = harness({ branch: () => ({ schema_version: 1, ok: false, error: 'git_failed' }) });
  await flush();
  assert.deepEqual(failed.tabs(), ['working_tree', 'this_chat']);
  const empty = harness({ branch: () => { throw new Error('bridge down'); } });
  await flush();
  assert.deepEqual(empty.tabs(), ['working_tree', 'this_chat']);
});

test('the tab disappearing while selected falls back to Working tree and tells the host', async () => {
  const h = harness();
  await flush();
  h.pick('branch');
  await flush();
  assert.equal(h.page.getScope(), 'branch');
  h.state.branch = () => notApplicable('on_base_branch');
  h.emit();
  h.timers[0]();
  await flush();
  assert.equal(h.page.getScope(), 'working_tree');
  assert.deepEqual(h.calls.scope, ['branch', 'working_tree']);
  assert.deepEqual(h.tabs(), ['working_tree', 'this_chat']);
  assert.deepEqual(h.rows(), ['src/shared.js', 'src/only-working.js'], 'the Working tree list is showing');
});

test('onChanged probes the branch again once, even on This chat, and a refresh while it is out is single in flight', async () => {
  const h = harness();
  await flush();
  h.pick('this_chat');
  await flush();
  const before = h.calls.list.filter((request) => request.scope === 'branch').length;
  const held = [];
  h.state.branch = () => new Promise((resolve) => held.push(resolve));
  h.emit();
  h.emit();
  assert.equal(h.timers.length, 1, 'coalesced into one refresh');
  h.timers[0]();
  await settle();
  assert.equal(h.calls.list.filter((request) => request.scope === 'branch').length, before + 1);
  assert.equal(h.calls.list.filter((request) => !request.scope).length >= 1, true);
  held[0](notApplicable('no_base'));
  await flush();
  assert.deepEqual(h.tabs(), ['working_tree', 'this_chat'], 'the answer removed the tab');
});

test('each scope keeps its own expanded files and diffs; the same path never shows the other scope diff', async () => {
  const h = harness();
  await flush();
  assert.match(h.row('src/shared.js').textContent, /WORKING-TREE-LINE/);
  h.click(h.row('src/only-working.js').querySelector('[data-file-diff-toggle]'));
  await flush();
  assert.equal(h.row('src/only-working.js').getAttribute('data-expanded'), 'true');
  h.pick('branch');
  await flush();
  assert.equal(h.row('src/shared.js').getAttribute('data-expanded'), 'true');
  assert.doesNotMatch(h.row('src/shared.js').textContent, /WORKING-TREE-LINE/);
  assert.match(h.row('src/shared.js').textContent, /BRANCH-LINE/);
  assert.equal(h.row('src/only-branch.js').getAttribute('data-expanded'), 'false', 'the branch list starts with its own first file open');
  h.click(h.row('docs/plan.md').querySelector('[data-file-diff-toggle]'));
  await flush();
  h.pick('working_tree');
  assert.equal(h.row('src/only-working.js').getAttribute('data-expanded'), 'true', 'the Working tree kept what was open');
  assert.equal(h.row('docs/plan.md'), undefined);
  assert.match(h.row('src/shared.js').textContent, /WORKING-TREE-LINE/);
  assert.doesNotMatch(h.row('src/shared.js').textContent, /BRANCH-LINE/);
  // Diff reads: Working tree ones omit scope, branch ones carry it, each file asked once per scope.
  const working = h.calls.diff.filter((request) => !request.scope).map((request) => request.path).sort();
  const branch = h.calls.diff.filter((request) => request.scope === 'branch').map((request) => request.path).sort();
  assert.deepEqual(working, ['src/only-working.js', 'src/shared.js']);
  assert.deepEqual(branch, ['docs/plan.md', 'src/shared.js']);
});

test('switching tabs repaints in the same frame from what is loaded', async () => {
  const h = harness();
  await flush();
  h.pick('branch');
  await flush();
  h.pick('working_tree');
  assert.deepEqual(h.rows(), ['src/shared.js', 'src/only-working.js'], 'no wait for a reload');
  assert.equal(h.root.querySelector('.inv-segmented-option[aria-checked="true"]').getAttribute('data-value'), 'working_tree');
  h.pick('branch');
  assert.deepEqual(h.rows(), ['src/shared.js', 'src/only-branch.js', 'docs/plan.md']);
  assert.match(h.row('src/shared.js').textContent, /BRANCH-LINE/);
});

test('the Whole branch page is read-only and Open file still opens its files', async () => {
  const h = harness();
  await flush();
  h.pick('branch');
  await flush();
  assert.doesNotMatch(h.root.textContent, /\b(Stage|Commit|Discard)\b/, 'only the footer note names them, in lower case');
  const labels = Array.from(h.root.querySelectorAll('button')).map((button) => `${button.textContent} ${button.getAttribute('aria-label') || ''}`.toLowerCase());
  assert.equal(labels.some((label) => /stage|commit|discard/.test(label)), false);
  h.click(h.row('docs/plan.md').querySelector('[data-changes-wt-open]'));
  assert.deepEqual(h.calls.workspace, ['docs/plan.md']);
});

test('the summary line: Working tree, Whole branch with its plural-aware commits, and This chat', async () => {
  const h = harness();
  await flush();
  assert.equal(h.summary(), 'Uncommitted in this folder');
  assert.equal(h.counts(), '2 files +12 −3');
  assert.ok(h.root.querySelector('.changes-wt-scope .changes-wt-summary-row'), 'sits under the scope row');
  h.pick('branch');
  assert.equal(h.summary(), '3 commits since main, plus uncommitted work');
  assert.equal(h.counts(), '3 files +40 −7');
  assert.equal(h.root.querySelectorAll('.changes-scope-branch').length, 1, 'one branch display, the scope row\'s own');
  h.pick('this_chat');
  assert.equal(h.summary(), 'What this chat changed');
  assert.equal(h.counts(), '', 'no counts for the ledger page');
  const single = harness({ branch: () => branchListing(BRANCH_FILES.slice(0, 1), { commit_count: 1, base_ref: 'origin/develop', additions: 1, deletions: 0 }) });
  await flush();
  single.pick('branch');
  assert.equal(single.summary(), '1 commit since origin/develop, plus uncommitted work');
  assert.equal(single.counts(), '1 file +1 −0');
});

test('an empty listing leaves the counts out', async () => {
  const h = harness({ workingFiles: [], branch: () => branchListing([], { commit_count: 2 }) });
  await flush();
  assert.equal(h.counts(), '');
  assert.match(h.root.textContent, /No uncommitted changes/);
  h.pick('branch');
  assert.equal(h.counts(), '');
  assert.match(h.root.textContent, /No changes since main/);
});

test('Working tree notes files this chat did not change, singular and plural; never on Whole branch', async () => {
  const h = harness({ chat: new Set(['src/shared.js']) });
  await flush();
  assert.equal(h.notFromChat(), '1 of these files was not changed by this chat. Another chat or editor may have touched it.');
  h.state.chat = new Set();
  h.emit();
  h.timers[0]();
  await flush();
  assert.equal(h.notFromChat(), '2 of these files were not changed by this chat. Another chat or editor may have touched them.');
  h.pick('branch');
  assert.equal(h.notFromChat(), '', 'only the Working tree says it');
});

test('no note when every listed file is this chat\'s, or when the chat list is unknown', async () => {
  const all = harness({ chat: new Set(['src/shared.js', 'src/only-working.js', 'other.js']) });
  await flush();
  assert.equal(all.notFromChat(), '');
  const unknown = harness({ chat: null });
  await flush();
  assert.equal(unknown.notFromChat(), '', 'ledger unavailable: never a guess');
  assert.equal(unknown.rows().length, 2, 'the list is not held back');
  const throwing = harness({ chat: () => { throw new Error('ledger broke'); } });
  await flush();
  assert.equal(throwing.notFromChat(), '');
  assert.equal(throwing.rows().length, 2);
});

test('the chat list arriving later shows the note without a reload', async () => {
  let notify = null;
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>');
  let paths = null;
  const page = createChangesWorkingTree({
    getBridge: () => ({
      listChanges: async (request) => (request.scope === 'branch' ? notApplicable('no_base') : workingListing(WT_FILES)),
      getChangeDiff: async () => ({ ok: true, binary: false, diff: WT_DIFF }),
      onChanged: () => () => {},
    }),
    getSessionId: () => 'sess_owner',
    getChatChangedPaths: () => paths,
    subscribeChatChanges: (callback) => { notify = callback; return () => {}; },
  });
  const root = dom.window.document.getElementById('root');
  page.mount(root);
  await flush();
  assert.equal(root.querySelector('[data-changes-wt-not-chat]'), null);
  paths = new Set(['src/shared.js']);
  notify();
  assert.match(root.querySelector('[data-changes-wt-not-chat]').textContent, /^1 of these files was not changed by this chat/);
});

// Row 122: the empty slot the before and after pictures fill. It sits outside the list so a list
// refresh never redraws the pictures, and each new listing renames it so they are asked for again.
test('the Working tree page keeps one pictures slot outside the list and renames it per listing', async () => {
  const h = harness();
  await flush();
  const slot = () => h.root.querySelector('.cp-slot[data-cp-working-tree]');
  const first = slot();
  assert.ok(first, 'a listed Working tree page has the slot');
  assert.equal(first.parentElement.getAttribute('data-changes-wt-region'), 'pictures');
  assert.equal(h.root.querySelector('[data-changes-wt-region="content"] .cp-slot'), null);
  const name = first.getAttribute('data-cp-working-tree');
  h.emit();
  h.timers.splice(0).forEach((fn) => fn());
  await flush();
  assert.equal(slot(), first, 'a refresh keeps the element');
  assert.notEqual(first.getAttribute('data-cp-working-tree'), name, 'a new listing renames it');
  h.pick('branch');
  assert.equal(slot(), null, 'Whole branch shows no pictures');
  h.pick('working_tree');
  assert.ok(slot());
  h.pick('this_chat');
  assert.equal(slot(), null);
});

test('a clean working tree has no pictures slot', async () => {
  const h = harness({ workingFiles: [] });
  await flush();
  assert.equal(h.root.querySelector('.cp-slot'), null);
});
