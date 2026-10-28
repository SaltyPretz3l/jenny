'use strict';

// Explorer badges: problem counts from editor markers (rolled up to folders)
// and .gitignore dimming from workspaceGit.checkIgnored, batched per listing.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeTreeBadges } = require('../renderer/features/renderer-ide-tree-badges');
const { settle } = require('./helpers/ide-tree-harness');

function createMarkerHost(initial = []) {
  let markers = initial;
  const listeners = new Set();
  return {
    getMarkers: () => markers,
    onMarkersChanged(cb) {
      listeners.add(cb);
      return { dispose() { listeners.delete(cb); } };
    },
    set(next) {
      markers = next;
      for (const cb of listeners) cb();
    },
    listenerCount: () => listeners.size,
  };
}

function entries(...specs) {
  return specs.map(([relPath, kind]) => ({ relPath, kind, name: relPath.split('/').pop() }));
}

test('error and warning markers give a file its worst severity and count; folders roll up', async () => {
  const host = createMarkerHost([
    { path: 'src/app.js', severity: 'error' },
    { path: 'src/app.js', severity: 'warning' },
    { path: 'src/app.js', severity: 'info' },
    { path: 'lib/only-info.js', severity: 'hint' },
    { path: 'lib/warn.js', severity: 'warning' },
  ]);
  const badges = createIdeTreeBadges({ getEditorHost: () => host });
  badges.bind();
  await settle(150);

  assert.deepEqual(badges.getProblemDecoration('src/app.js', 'file'), { severity: 'error', count: 2 });
  assert.deepEqual(badges.getProblemDecoration('src', 'directory'), { severity: 'error' });
  assert.deepEqual(badges.getProblemDecoration('lib', 'directory'), { severity: 'warning' });
  assert.equal(badges.getProblemDecoration('lib/only-info.js', 'file'), null);
  assert.equal(badges.getProblemDecoration('README.md', 'file'), null);
  badges.dispose();
  assert.equal(host.listenerCount(), 0);
});

test('marker changes repaint once, coalesced, and only when the decorations changed', async () => {
  const host = createMarkerHost([{ path: 'a.js', severity: 'error' }]);
  let repaints = 0;
  const badges = createIdeTreeBadges({ getEditorHost: () => host, requestRepaint: () => { repaints += 1; } });
  badges.bind();
  await settle(150);
  const initial = repaints;

  host.set([{ path: 'a.js', severity: 'error' }]);
  host.set([{ path: 'a.js', severity: 'error' }]);
  await settle(150);
  assert.equal(repaints, initial, 'identical markers repaint nothing');

  host.set([{ path: 'a.js', severity: 'warning' }]);
  host.set([{ path: 'a.js', severity: 'warning' }, { path: 'b.js', severity: 'warning' }]);
  await settle(150);
  assert.equal(repaints, initial + 1, 'burst coalesces into one repaint');
  assert.deepEqual(badges.getProblemDecoration('b.js', 'file'), { severity: 'warning', count: 1 });
  badges.dispose();
});

test('listed directories are checked in one batch; ignored directories cover their children', async () => {
  const calls = [];
  let repaints = 0;
  const badges = createIdeTreeBadges({
    getRootEpoch: () => 1,
    requestRepaint: () => { repaints += 1; },
    checkIgnored: async (payload) => {
      calls.push(payload.paths.slice());
      return { ok: true, ignored: ['dist'] };
    },
  });
  badges.noteListedDirectory('', entries(['dist', 'directory'], ['src', 'directory'], ['a.js', 'file']));
  badges.noteListedDirectory('src', entries(['src/b.js', 'file']));
  await settle(120);

  assert.equal(calls.length, 1, 'one batched call for the whole tick');
  assert.deepEqual(calls[0].sort(), ['a.js', 'dist', 'src', 'src/b.js']);
  assert.equal(badges.isIgnored('dist'), true);
  assert.equal(badges.isIgnored('dist/x.js'), true, 'a child of an ignored directory is ignored');
  assert.equal(badges.isIgnored('src/b.js'), false);
  assert.equal(repaints, 1);

  badges.noteListedDirectory('dist', entries(['dist/x.js', 'file']));
  badges.noteListedDirectory('', entries(['dist', 'directory'], ['src', 'directory'], ['a.js', 'file']));
  await settle(120);
  assert.equal(calls.length, 1, 'known paths and children of ignored directories are not re-requested');
});

test('a late checkIgnored result after a root change is dropped', async () => {
  let epoch = 1;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let repaints = 0;
  const badges = createIdeTreeBadges({
    getRootEpoch: () => epoch,
    requestRepaint: () => { repaints += 1; },
    checkIgnored: async () => { await gate; return { ok: true, ignored: ['dist'] }; },
  });
  badges.noteListedDirectory('', entries(['dist', 'directory']));
  await settle(120);
  epoch = 2;
  badges.reset();
  release();
  await settle(30);

  assert.equal(badges.isIgnored('dist'), false);
  assert.equal(repaints, 0);
});

test('unavailable git is silent and never retried in a loop', async () => {
  let calls = 0;
  const badges = createIdeTreeBadges({
    getRootEpoch: () => 1,
    checkIgnored: async () => { calls += 1; return { ok: false, reason: 'bridge_unavailable' }; },
  });
  badges.noteListedDirectory('', entries(['a.js', 'file']));
  await settle(120);
  badges.noteListedDirectory('', entries(['a.js', 'file'], ['b.js', 'file']));
  await settle(120);
  assert.equal(calls, 1);
  assert.equal(badges.isIgnored('a.js'), false);

  const missing = createIdeTreeBadges({ getRootEpoch: () => 1 });
  missing.noteListedDirectory('', entries(['a.js', 'file']));
  await settle(120);
  assert.equal(missing.isIgnored('a.js'), false);
});

test('a .gitignore change invalidates the cache and re-checks the known paths', async () => {
  let ignored = ['dist'];
  const calls = [];
  const badges = createIdeTreeBadges({
    getRootEpoch: () => 1,
    checkIgnored: async (payload) => { calls.push(payload.paths.slice()); return { ok: true, ignored }; },
  });
  badges.noteListedDirectory('', entries(['dist', 'directory'], ['build', 'directory']));
  await settle(120);
  assert.equal(badges.isIgnored('dist'), true);

  badges.noteExternalChanges([{ relPath: 'src/util.js', kind: 'modified' }]);
  await settle(120);
  assert.equal(calls.length, 1, 'ordinary changes leave the cache alone');

  ignored = ['build'];
  badges.noteExternalChanges([{ relPath: '.gitignore', kind: 'modified' }]);
  await settle(120);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].sort(), ['build', 'dist']);
  assert.equal(badges.isIgnored('dist'), false);
  assert.equal(badges.isIgnored('build'), true);
});

test('batches never exceed 2000 paths per call', async () => {
  const sizes = [];
  const badges = createIdeTreeBadges({
    getRootEpoch: () => 1,
    checkIgnored: async (payload) => { sizes.push(payload.paths.length); return { ok: true, ignored: [] }; },
  });
  const many = Array.from({ length: 4500 }, (_, index) => [`f${index}.js`, 'file']);
  badges.noteListedDirectory('', entries(...many));
  await settle(150);
  assert.deepEqual(sizes, [2000, 2000, 500]);
});

test('tree rows carry problem badges, folder roll-up dots and the ignored class', async () => {
  const { createIdeTree } = require('../renderer/features/renderer-ide-tree');
  const ideStateUtils = require('../renderer/features/renderer-ide-state');
  const { buildIdeDom, createBridgeStub } = require('./helpers/ide-tree-harness');
  const domHarness = buildIdeDom();
  const bridge = createBridgeStub({ files: { 'src/app.js': 'a', 'dist/x.js': 'x', 'README.md': 'r' } });
  const ide = ideStateUtils.createIdeUiState();
  ide.expandedDirs = new Set(['src']);
  const host = createMarkerHost(Array.from({ length: 12 }, () => ({ path: 'src/app.js', severity: 'error' })));
  const tree = createIdeTree({
    getDom: domHarness.getDom,
    getIde: () => ide,
    getMountEl: () => domHarness.getDom().ideRailPanel,
    isActivePanel: () => true,
    getWorkspaceFsApi: () => bridge.jennyShell.workspaceFs,
    getEditorHost: () => host,
    checkIgnored: async () => ({ ok: true, ignored: ['dist'] }),
  });
  tree.bindEvents();
  tree.refreshRoot();
  await settle(150);
  const panel = domHarness.getDom().ideRailPanel;
  const row = (path) => panel.querySelector(`[data-ide-tree-path="${path}"]`);

  assert.ok(row('src/app.js').classList.contains('ide-tree-row--problem-error'));
  const badge = row('src/app.js').querySelector('.ide-tree-problem-badge');
  assert.equal(badge.textContent, '9+');
  assert.equal(badge.dataset.severity, 'error');
  assert.equal(badge.getAttribute('aria-label'), '12 problems');
  assert.ok(row('src').classList.contains('ide-tree-row--problem-rollup-error'));
  assert.ok(row('src').querySelector('.ide-tree-problem-dot'));
  assert.ok(row('dist').classList.contains('ide-tree-row--ignored'));
  assert.equal(row('README.md').classList.contains('ide-tree-row--ignored'), false);
  tree.dispose();
  domHarness.dom.window.close();
});

/* ---- Cleanup wave (row 82 deferred T4, T5, T6, T9) --------------------------- */

test('T5: Refresh over 25 known paths in 5 directories issues at most 5 checkIgnored calls, skipping collapsed ones', async () => {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const expanded = new Set(['d1', 'd2', 'd3', 'd4']);
  const badges = createIdeTreeBadges({
    getRootEpoch: () => 1,
    isDirectoryExpanded: (dir) => expanded.has(dir),
    checkIgnored: async (payload) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      calls.push(payload.paths.slice());
      await settle(1);
      inFlight -= 1;
      return { ok: true, ignored: [] };
    },
  });
  const dirs = ['d1', 'd2', 'd3', 'd4', 'd5'];
  badges.noteListedDirectory('', entries(...dirs.map((dir) => [dir, 'directory'])));
  for (const dir of dirs) {
    badges.noteListedDirectory(dir, entries(...[1, 2, 3, 4, 5].map((n) => [`${dir}/f${n}.js`, 'file'])));
  }
  await settle(120);
  calls.length = 0;
  badges.invalidateIgnored(); // the Explorer's Refresh; d5 has been collapsed since it listed
  await settle(120);
  const sent = calls.flat().sort();
  assert.ok(calls.length <= 5, `at most 5 calls (got ${calls.length})`);
  assert.ok(maxInFlight <= 4, 'at most 4 in flight');
  assert.equal(sent.length, 25, 'the root listing and the four expanded folders: 25 paths');
  assert.deepEqual(sent.filter((path) => path.startsWith('d5/')), [], 'a collapsed folder is not re-checked');
});

test('T6: a git status change re-checks the affected directory', async () => {
  let listener = null;
  const calls = [];
  let ignoredNow = ['src/gen.js'];
  const badges = createIdeTreeBadges({
    getRootEpoch: () => 1,
    subscribeGitStatus: (fn) => { listener = fn; return () => { listener = null; }; },
    checkIgnored: async (payload) => {
      calls.push(payload.paths.slice());
      return { ok: true, ignored: ignoredNow.filter((path) => payload.paths.includes(path)) };
    },
  });
  badges.bind();
  badges.noteListedDirectory('', entries(['src', 'directory'], ['lib', 'directory']));
  badges.noteListedDirectory('src', entries(['src/a.js', 'file'], ['src/gen.js', 'file']));
  badges.noteListedDirectory('lib', entries(['lib/x.js', 'file']));
  await settle(120);
  assert.equal(badges.isIgnored('src/gen.js'), true);
  assert.equal(typeof listener, 'function', 'the badges listen to the git status store');

  calls.length = 0;
  ignoredNow = []; // `git add -f src/gen.js`: tracked now, no longer ignored
  listener({ byPath: new Map([['src/gen.js', 'added']]) });
  await settle(120);
  assert.deepEqual(calls.flat().sort(), ['src/a.js', 'src/gen.js'], 'only the changed file\'s directory');
  assert.equal(badges.isIgnored('src/gen.js'), false);

  calls.length = 0;
  listener({ byPath: new Map([['src/gen.js', 'added']]) });
  await settle(120);
  assert.equal(calls.length, 0, 'an unchanged status re-checks nothing');
  badges.dispose();
  assert.equal(listener, null, 'dispose unsubscribes');
});

// Cleanup review (perf R2): a Refresh keeps the last status snapshot, so the next snapshot
// with the same entries re-checks nothing; a burst never queues a path twice.
test('a Refresh then an unchanged status snapshot checks each listed path once', async () => {
  let listener = null;
  const calls = [];
  const badges = createIdeTreeBadges({
    getRootEpoch: () => 1,
    subscribeGitStatus: (fn) => { listener = fn; return () => {}; },
    checkIgnored: async (payload) => { calls.push(payload.paths.slice()); return { ok: true, ignored: [] }; },
  });
  badges.bind();
  badges.noteListedDirectory('', entries(['a.js', 'file'], ['b.js', 'file']));
  listener({ byPath: new Map([['a.js', 'modified']]) });
  await settle(120);
  calls.length = 0;
  badges.invalidateIgnored();
  listener({ byPath: new Map([['a.js', 'modified']]) });
  await settle(120);
  assert.deepEqual(calls.flat().sort(), ['a.js', 'b.js']);
  badges.dispose();
});

test('T9: a task problem in a closed file badges the file and its folders; a task change repaints', async () => {
  const host = createMarkerHost([]);
  const task = { markers: [{ path: 'tests/test_a.py', severity: 'error' }], cb: null };
  const taskProblems = {
    getMarkers: () => task.markers,
    onChange: (cb) => { task.cb = cb; return { dispose() { task.cb = null; } }; },
  };
  let repaints = 0;
  const badges = createIdeTreeBadges({ getEditorHost: () => host, getTaskProblems: () => taskProblems, requestRepaint: () => { repaints += 1; } });
  badges.bind();
  await settle(150);
  assert.deepEqual(badges.getProblemDecoration('tests/test_a.py', 'file'), { severity: 'error', count: 1 });
  assert.deepEqual(badges.getProblemDecoration('tests', 'directory'), { severity: 'error' });
  const before = repaints;
  task.markers = [];
  task.cb();
  await settle(150);
  assert.equal(badges.getProblemDecoration('tests/test_a.py', 'file'), null);
  assert.equal(repaints, before + 1);
  badges.dispose();
  assert.equal(task.cb, null, 'dispose unsubscribes from the task source');
});

test('T4: a shared marker snapshot replaces the badges\' own editor-host scan', async () => {
  let hostScans = 0;
  const host = createMarkerHost([{ path: 'a.js', severity: 'error' }]);
  const scanningHost = { ...host, getMarkers: () => { hostScans += 1; return host.getMarkers(); } };
  const snapshot = [{ path: 'a.js', severity: 'warning' }];
  const badges = createIdeTreeBadges({ getEditorHost: () => scanningHost, getMarkers: () => snapshot });
  badges.bind();
  await settle(150);
  assert.deepEqual(badges.getProblemDecoration('a.js', 'file'), { severity: 'warning', count: 1 });
  assert.equal(hostScans, 0, 'no second scan of the editor markers');
  badges.dispose();
});
