'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createChangesWorkingTree, sanitizeFiles, MAX_PARALLEL_DIFFS } = require('../renderer/features/renderer-changes-working-tree');
const { createWorkingTreeRender } = require('../renderer/features/renderer-changes-working-tree-render');

const settle = () => new Promise((resolve) => setImmediate(resolve));
const flush = async () => { await settle(); await settle(); await settle(); };

const DIFF_A = [
  'diff --git a/sidecar/ai/trailing_row.py b/sidecar/ai/trailing_row.py',
  '--- a/sidecar/ai/trailing_row.py',
  '+++ b/sidecar/ai/trailing_row.py',
  '@@ -12,2 +12,3 @@',
  ' def row():',
  '-    return 1',
  '+    return 2',
  '+    # extra',
].join('\n');

function listing(files, extra = {}) {
  return {
    schema_version: 1, ok: true, state: 'available', reason: null, sampled_at: '2026-10-15T12:00:00Z',
    data: {
      workspace_id: 'ws1', scope: 'working_tree', ref: 'main', head: 'abc1234', branch: 'main', files,
      file_count: files.length, additions: 12, deletions: 3, truncated: false, ...extra,
    },
  };
}

const FILES = [
  { path: 'sidecar/ai/trailing_row.py', orig_path: null, change: 'modified', binary: false, additions: 2, deletions: 1 },
  { path: 'tests/test_row.py', orig_path: null, change: 'added', binary: false, additions: 8, deletions: 0 },
  { path: 'docs/plans/TUNING.md', orig_path: null, change: 'untracked', binary: false, additions: 72, deletions: 0 },
  { path: 'assets/curve.png', orig_path: null, change: 'modified', binary: true, additions: null, deletions: null },
];

function harness(options = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div><button id="outside">x</button></body>');
  const { document } = dom.window;
  const calls = { list: [], diff: [], workspace: [], git: 0, scope: [], logs: [] };
  const pendingDiffs = new Map();
  let changedCallback = null;
  let unsubscribed = 0;
  const timers = [];
  const bridge = {
    listChanges: async (request) => {
      calls.list.push(request);
      if (options.listChanges) return options.listChanges(request);
      return listing(FILES);
    },
    getChangeDiff: (request) => {
      calls.diff.push(request);
      if (options.holdDiffs) return new Promise((resolve) => { pendingDiffs.set(request.path, [...(pendingDiffs.get(request.path) || []), resolve]); });
      if (options.getChangeDiff) return options.getChangeDiff(request);
      return Promise.resolve({ schema_version: 1, ok: true, path: request.path, change: 'modified', binary: false, truncated: false, diff: DIFF_A });
    },
    onChanged: (callback) => { changedCallback = callback; return () => { unsubscribed += 1; }; },
  };
  const owner = { id: options.owner || 'sess_owner' };
  const page = createChangesWorkingTree({
    getBridge: () => bridge,
    getSessionId: () => owner.id,
    openInWorkspace: (path) => calls.workspace.push(path),
    openInGit: () => { calls.git += 1; },
    onScopeChange: (scope) => calls.scope.push(scope),
    log: (level, code) => calls.logs.push(code),
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
  });
  const root = document.getElementById('root');
  page.mount(root);
  return {
    dom, document, root, page, bridge, calls, owner, pendingDiffs, timers,
    emit: (event) => changedCallback(event),
    get unsubscribed() { return unsubscribed; },
    rows: () => Array.from(root.querySelectorAll('.file-diff')),
    row: (path) => Array.from(root.querySelectorAll('.file-diff')).find((el) => el.getAttribute('data-diff-id') === `wt:${path}`),
    click: (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })),
  };
}

test('checking, then the rows: first file open, the rest closed, with the scope row and summary', async () => {
  const h = harness();
  assert.match(h.root.querySelector('[data-changes-wt-body]').textContent, /Checking the working tree/);
  await flush();
  assert.equal(h.rows().length, 4);
  assert.equal(h.row('sidecar/ai/trailing_row.py').getAttribute('data-expanded'), 'true');
  for (const path of ['tests/test_row.py', 'docs/plans/TUNING.md', 'assets/curve.png']) {
    assert.equal(h.row(path).getAttribute('data-expanded'), 'false', `${path} starts closed`);
  }
  assert.match(h.root.querySelector('.changes-scope-branch').textContent, /main → working tree/);
  assert.match(h.root.querySelector('[data-changes-summary]').textContent, /4 files · \+12 −3 · includes changes this chat didn’t make/);
  // The switch names both pages and Working tree is the selected one.
  const checked = h.root.querySelector('.inv-segmented-option[aria-checked="true"]');
  assert.equal(checked.getAttribute('data-value'), 'working_tree');
});

test('rows stack the file name over its folder, with notes and colored counts, and only the open file loads a diff', async () => {
  const h = harness();
  await flush();
  const first = h.row('sidecar/ai/trailing_row.py');
  assert.ok(first.classList.contains('file-diff--stacked'));
  assert.equal(first.querySelector('.file-diff-basename').textContent, 'trailing_row.py');
  assert.equal(first.querySelector('.file-diff-directory').textContent, 'sidecar/ai', 'folder without a trailing slash');
  assert.equal(first.querySelector('.file-diff-count-add').textContent, '+2');
  assert.equal(h.row('tests/test_row.py').querySelector('.file-diff-note').textContent, 'new');
  assert.equal(h.row('docs/plans/TUNING.md').querySelector('.file-diff-note').textContent, 'new · untracked');
  assert.equal(h.row('assets/curve.png').querySelector('.file-diff-note').textContent, 'binary');
  assert.deepEqual(h.calls.diff.map((request) => request.path), ['sidecar/ai/trailing_row.py'], 'lazy: one diff for the one open file');
  assert.deepEqual(h.calls.diff[0], { schema_version: 1, session_id: 'sess_owner', path: 'sidecar/ai/trailing_row.py' });
  // Hunks render with old/new gutters inside the file's own scrolling block.
  const body = first.querySelector('.file-diff-body');
  assert.equal(body.querySelectorAll('.diff-line').length, 4);
  assert.equal(body.querySelector('.diff-line-add .diff-gutter').textContent, '13');
  assert.equal(body.querySelector('.diff-line-remove .diff-gutter').textContent, '13');
  // Every file row carries an Open in Workspace icon button.
  assert.equal(h.root.querySelectorAll('.file-diff-open[data-changes-wt-open]').length, 4);
});

test('expanding a closed file loads its diff once; a second click collapses without a new request', async () => {
  const h = harness();
  await flush();
  const toggle = () => h.row('tests/test_row.py').querySelector('[data-file-diff-toggle]');
  h.click(toggle());
  await flush();
  assert.equal(h.row('tests/test_row.py').getAttribute('data-expanded'), 'true');
  assert.equal(h.calls.diff.filter((request) => request.path === 'tests/test_row.py').length, 1);
  assert.ok(h.row('tests/test_row.py').querySelector('.diff-line'));
  h.click(toggle());
  assert.equal(h.row('tests/test_row.py').getAttribute('data-expanded'), 'false');
  h.click(toggle());
  await flush();
  assert.equal(h.calls.diff.filter((request) => request.path === 'tests/test_row.py').length, 1, 'the loaded diff is reused');
});

test('one request is in flight per file and a loading note shows until it lands', async () => {
  const h = harness({ holdDiffs: true });
  await flush();
  assert.match(h.row('sidecar/ai/trailing_row.py').querySelector('.file-diff-body').textContent, /Loading the diff/);
  h.click(h.row('tests/test_row.py').querySelector('[data-file-diff-toggle]'));
  h.click(h.row('tests/test_row.py').querySelector('[data-file-diff-toggle]')); // collapse
  h.click(h.row('tests/test_row.py').querySelector('[data-file-diff-toggle]')); // expand again while loading
  await flush();
  assert.equal(h.calls.diff.filter((request) => request.path === 'tests/test_row.py').length, 1);
  h.pendingDiffs.get('tests/test_row.py')[0]({ ok: true, binary: false, truncated: false, diff: DIFF_A });
  await flush();
  assert.ok(h.row('tests/test_row.py').querySelector('.diff-line'));
});

test('expand all is bounded and parallelism is capped', async () => {
  const files = [];
  for (let i = 0; i < 60; i += 1) files.push({ path: `src/f${i}.js`, change: 'modified', binary: false, additions: 1, deletions: 1 });
  const h = harness({ listChanges: async () => listing(files), holdDiffs: true });
  await flush();
  h.click(h.root.querySelector('[data-changes-wt-expand-all]'));
  await flush();
  const expanded = h.rows().filter((row) => row.getAttribute('data-expanded') === 'true');
  assert.equal(expanded.length, 40, 'expand all opens at most 40 files');
  assert.ok(h.calls.diff.length <= MAX_PARALLEL_DIFFS, `at most ${MAX_PARALLEL_DIFFS} requests in flight, saw ${h.calls.diff.length}`);
  // Once the label flips, the same control collapses everything.
  assert.equal(h.root.querySelector('[data-changes-wt-expand-all]').getAttribute('aria-label'), 'Expand all', 'not every file is open yet');
});

test('binary files say so and never request a diff', async () => {
  const h = harness();
  await flush();
  const before = h.calls.diff.length;
  h.click(h.row('assets/curve.png').querySelector('[data-file-diff-toggle]'));
  await flush();
  assert.equal(h.calls.diff.length, before);
  assert.match(h.row('assets/curve.png').querySelector('.file-diff-body').textContent, /Binary file · not shown/);
});

test('a failed or truncated diff is said in words', async () => {
  const h = harness({
    getChangeDiff: async (request) => (request.path === 'tests/test_row.py'
      ? { ok: false, reason: 'git_failed' }
      : { ok: true, binary: false, truncated: true, diff: DIFF_A }),
  });
  await flush();
  assert.match(h.row('sidecar/ai/trailing_row.py').querySelector('.file-diff-body').textContent, /Only the start of this diff is shown/);
  h.click(h.row('tests/test_row.py').querySelector('[data-file-diff-toggle]'));
  await flush();
  assert.match(h.row('tests/test_row.py').querySelector('.file-diff-body').textContent, /couldn’t be read/);
});

test('empty, not-a-repository and unavailable states reuse the rail words and never show zero as a count', async () => {
  const clean = harness({ listChanges: async () => listing([]) });
  await flush();
  assert.match(clean.root.textContent, /No uncommitted changes/);
  assert.equal(clean.rows().length, 0);
  assert.equal(clean.root.querySelector('[data-changes-wt-filter-toggle]'), null, 'no filter tools without files');

  const nonGit = harness({ listChanges: async () => ({ schema_version: 1, ok: true, state: 'not_applicable', reason: 'not_a_git_repository', sampled_at: null, data: null }) });
  await flush();
  assert.match(nonGit.root.textContent, /Not a Git repository/);
  assert.equal(nonGit.root.querySelector('[data-changes-wt-open-git]'), null, 'no Git hand-off outside a repository');

  for (const response of [
    { schema_version: 1, ok: true, state: 'unavailable', reason: 'git_failed', data: null },
    { schema_version: 1, ok: false, error_code: 'CMP-CHATWS-0001', reason: 'unavailable' },
    null,
  ]) {
    const down = harness({ listChanges: async () => response });
    await flush();
    assert.match(down.root.textContent, /unavailable right now/);
    assert.doesNotMatch(down.root.textContent, /\b0 files\b/);
  }
  const thrown = harness({ listChanges: async () => { throw new Error('boom'); } });
  await flush();
  assert.match(thrown.root.textContent, /unavailable right now/);
  assert.ok(thrown.calls.logs.includes('changes_working_tree.list_failed'));
});

test('unknown line counts are left out of the summary, not shown as zero', async () => {
  const h = harness({ listChanges: async () => listing(FILES.slice(0, 1), { additions: null, deletions: null }) });
  await flush();
  const summary = h.root.querySelector('[data-changes-summary]').textContent;
  assert.match(summary, /^1 file · includes changes/);
  assert.doesNotMatch(summary, /\+0/);
});

test('the page is read-only: no stage, commit or discard control anywhere; Open in Git only hands off', async () => {
  const h = harness();
  await flush();
  const labels = Array.from(h.root.querySelectorAll('button')).map((button) => `${button.textContent} ${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''}`);
  assert.ok(labels.length > 5);
  for (const label of labels) assert.doesNotMatch(label, /stage|commit|discard|revert|restore|undo/i);
  assert.match(h.root.querySelector('.changes-wt-foot').textContent, /Staging, commit and discard stay in the Workspace Git view\./);
  h.click(h.root.querySelector('[data-changes-wt-open-git]'));
  assert.equal(h.calls.git, 1);
  assert.equal(h.calls.workspace.length, 0);
});

test('Open in Workspace passes only a listed path', async () => {
  const h = harness();
  await flush();
  h.click(h.row('tests/test_row.py').querySelector('.file-diff-open'));
  assert.deepEqual(h.calls.workspace, ['tests/test_row.py']);
  const forged = h.row('tests/test_row.py').querySelector('.file-diff-open');
  forged.setAttribute('data-changes-wt-open', '../../etc/passwd');
  h.click(forged);
  assert.deepEqual(h.calls.workspace, ['tests/test_row.py'], 'a path that is not in the listing is ignored');
});

test('untrusted paths are escaped, never parsed as markup', async () => {
  const evil = '"><img src=x onerror=alert(1)>/<script>x.js';
  const h = harness({ listChanges: async () => listing([{ path: evil, change: 'modified', binary: false, additions: 1, deletions: 0 }], { branch: '<b>evil</b>' }) });
  await flush();
  assert.equal(h.root.querySelector('img'), null);
  assert.equal(h.root.querySelector('script'), null);
  assert.equal(h.root.querySelector('.changes-scope-branch b'), null);
  assert.match(h.root.querySelector('.changes-scope-branch').textContent, /<b>evil<\/b>/);
  assert.equal(h.root.querySelector('.file-diff-basename').textContent, '<script>x.js');
});

test('hostile diff text is escaped in the hunks', async () => {
  const h = harness({ getChangeDiff: async () => ({ ok: true, binary: false, diff: '@@ -1 +1 @@\n-<img src=x onerror=alert(1)>\n+<script>1</script>\n' }) });
  await flush();
  assert.equal(h.root.querySelector('.file-diff-body img'), null);
  assert.equal(h.root.querySelector('.file-diff-body script'), null);
  assert.match(h.root.querySelector('.diff-line-remove .diff-content').textContent, /<img src=x onerror=alert\(1\)>/);
});

test('the page follows its owner session, never another: a new owner clears the old rows first', async () => {
  const h = harness({ owner: 'sess_a', holdDiffs: false });
  await flush();
  assert.equal(h.calls.list[0].session_id, 'sess_a');
  h.owner.id = 'sess_b';
  h.page.refresh();
  assert.match(h.root.querySelector('[data-changes-wt-body]').textContent, /Checking the working tree/, 'no stale rows from the other chat');
  await flush();
  assert.equal(h.calls.list.at(-1).session_id, 'sess_b');
  assert.ok(h.calls.diff.every((request) => ['sess_a', 'sess_b'].includes(request.session_id)));
  assert.equal(h.calls.diff.at(-1).session_id, 'sess_b');
});

test('a diff that lands after the owner changed is dropped', async () => {
  const h = harness({ owner: 'sess_a', holdDiffs: true });
  await flush();
  h.owner.id = 'sess_b';
  h.page.refresh();
  await flush();
  const [stale] = h.pendingDiffs.get('sidecar/ai/trailing_row.py');
  stale({ ok: true, binary: false, diff: '@@ -1 +1 @@\n-STALE\n+STALE\n' });
  await flush();
  assert.doesNotMatch(h.root.textContent, /STALE/);
});

test('onChanged for the owner refreshes the list once (debounced); other sessions are ignored', async () => {
  const h = harness();
  await flush();
  const listed = h.calls.list.length;
  h.emit({ schema_version: 1, session_id: 'someone_else', revision: 3 });
  assert.equal(h.timers.length, 0);
  h.emit({ schema_version: 1, session_id: 'sess_owner', revision: 4 });
  h.emit({ schema_version: 1, session_id: 'sess_owner', revision: 5 });
  assert.equal(h.timers.length, 1, 'coalesced into one pending refresh');
  h.timers[0]();
  await flush();
  assert.equal(h.calls.list.length, listed + 1);
  assert.equal(h.rows().length, 4);
});

test('a refresh keeps the open files and re-reads only the diffs whose file changed', async () => {
  let version = 0;
  const h = harness({ listChanges: async () => listing(version ? [{ ...FILES[0], additions: 5 }, ...FILES.slice(1)] : FILES) });
  await flush();
  h.click(h.row('tests/test_row.py').querySelector('[data-file-diff-toggle]'));
  await flush();
  const before = h.calls.diff.length;
  h.page.refresh();
  await flush();
  assert.equal(h.calls.diff.length, before, 'nothing changed: no new diff requests');
  version = 1;
  h.page.refresh();
  await flush();
  assert.equal(h.calls.diff.length, before + 1, 'only the file whose counts changed');
  assert.equal(h.calls.diff.at(-1).path, 'sidecar/ai/trailing_row.py');
  assert.equal(h.row('tests/test_row.py').getAttribute('data-expanded'), 'true', 'the open file stays open');
});

test('Filter files narrows the rows; Escape clears, then closes it and keeps the panel open', async () => {
  const h = harness();
  await flush();
  h.click(h.root.querySelector('[data-changes-wt-filter-toggle]'));
  const input = h.root.querySelector('[data-changes-wt-filter-input]');
  assert.ok(input);
  assert.equal(h.document.activeElement, input);
  input.value = 'TEST_';
  input.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  assert.deepEqual(h.rows().map((row) => row.getAttribute('data-diff-id')), ['wt:tests/test_row.py']);
  assert.equal(h.root.querySelector('[data-changes-wt-filter-input]'), input, 'typing never rebuilds the field');
  assert.equal(h.document.activeElement, input);
  input.value = 'zzz';
  input.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  assert.match(h.root.textContent, /No files match/);

  const escape = () => {
    const event = new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    h.document.activeElement.dispatchEvent(event);
    return event;
  };
  const first = escape();
  assert.equal(first.defaultPrevented, true);
  assert.equal(h.root.querySelector('[data-changes-wt-filter-input]').value, '');
  assert.equal(h.rows().length, 4, 'cleared');
  const second = escape();
  assert.equal(second.defaultPrevented, true);
  assert.equal(h.root.querySelector('[data-changes-wt-filter-input]'), null, 'closed');
  assert.equal(h.document.activeElement, h.root.querySelector('[data-changes-wt-filter-toggle]'));
  const third = new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  h.root.querySelector('[data-changes-wt-filter-toggle]').dispatchEvent(third);
  assert.equal(third.defaultPrevented, false, 'with the filter closed Escape belongs to the panel');
});

test('the Working tree / This chat switch reports the scope and hides the page body', async () => {
  const h = harness();
  await flush();
  const thisChat = h.root.querySelector('.inv-segmented-option[data-value="this_chat"]');
  thisChat.focus();
  h.click(thisChat);
  assert.deepEqual(h.calls.scope, ['this_chat']);
  assert.equal(h.page.getScope(), 'this_chat');
  assert.equal(h.root.querySelector('.changes-wt-scroll').hidden, true);
  assert.equal(h.root.querySelector('.changes-scope-branch'), null, 'the branch line belongs to the working tree');
  assert.equal(h.document.activeElement.getAttribute('data-value'), 'this_chat', 'focus stays on the switch');
  const listed = h.calls.list.length;
  h.click(h.root.querySelector('.inv-segmented-option[data-value="working_tree"]'));
  await flush();
  assert.deepEqual(h.calls.scope, ['this_chat', 'working_tree']);
  assert.equal(h.root.querySelector('.changes-wt-scroll').hidden, false);
  assert.ok(h.calls.list.length >= listed, 'returning to the page may refresh');
});

test('focus survives a re-render on the same file toggle', async () => {
  const h = harness();
  await flush();
  const toggle = h.row('tests/test_row.py').querySelector('[data-file-diff-toggle]');
  toggle.focus();
  h.click(toggle);
  await flush();
  const active = h.document.activeElement;
  assert.equal(active.getAttribute('data-diff-id'), 'wt:tests/test_row.py');
  assert.notEqual(active, toggle, 'the row was rebuilt');
});

test('a render pass never reloads; only a new mount, scope change or owner does', async () => {
  const h = harness();
  await flush();
  const listed = h.calls.list.length;
  for (let i = 0; i < 5; i += 1) { h.page.mount(h.root); h.page.setScope('working_tree'); }
  await flush();
  assert.equal(h.calls.list.length, listed);
});

test('dispose unsubscribes, clears the root and ignores late responses', async () => {
  const h = harness({ holdDiffs: true });
  await flush();
  h.page.dispose();
  assert.equal(h.unsubscribed, 1);
  assert.equal(h.root.children.length, 0);
  h.pendingDiffs.get('sidecar/ai/trailing_row.py')[0]({ ok: true, binary: false, diff: DIFF_A });
  await flush();
  assert.equal(h.root.children.length, 0);
});

test('sanitizeFiles drops malformed entries, duplicates and enforces closed enums', () => {
  const files = sanitizeFiles([
    { path: 'a.js', change: 'weird', binary: 'yes', additions: -1, deletions: 2.5 },
    { path: 'a.js', change: 'modified' },
    { path: '', change: 'modified' },
    { path: 'x'.repeat(5000), change: 'modified' },
    null,
    { path: 'b.js', change: 'renamed', binary: true, additions: 3, deletions: 0 },
  ]);
  assert.deepEqual(files, [
    { path: 'a.js', change: 'modified', binary: false, additions: null, deletions: null },
    { path: 'b.js', change: 'renamed', binary: true, additions: 3, deletions: 0 },
  ]);
  assert.deepEqual(sanitizeFiles('nope'), []);
  const many = Array.from({ length: 800 }, (_, i) => ({ path: `f${i}`, change: 'modified' }));
  assert.equal(sanitizeFiles(many).length, 500);
});

test('the render module words every change kind and keeps the end-edge tools out of other states', () => {
  const render = createWorkingTreeRender({});
  assert.deepEqual(render.noteWords({ change: 'deleted', binary: false }), ['deleted']);
  assert.deepEqual(render.noteWords({ change: 'conflicted', binary: true }), ['conflict', 'binary']);
  assert.deepEqual(render.noteWords({ change: 'modified', binary: false }), []);
  const checking = render.buildScopeRowHtml({ scope: 'working_tree', status: 'checking', branch: '' });
  assert.doesNotMatch(checking, /changes-wt-filter-toggle/);
  assert.match(checking, /Working tree/);
  const thisChat = render.buildScopeRowHtml({ scope: 'this_chat', status: 'ready', branch: 'main' });
  assert.doesNotMatch(thisChat, /changes-scope-branch/);
});
