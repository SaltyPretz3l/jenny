'use strict';

/* Workspace IDE palette rows (row 82 slice C): ids and labels, chords, `when` guards,
 * Save All across groups, the close rows, the editor toggles and dispose. Plain stubs
 * and the real registry. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeCommandRegistry } = require('../renderer/features/renderer-ide-command-registry');
const { registerIdePaletteCommands, joinRootPath } = require('../renderer/features/renderer-ide-palette-commands');
const { createIdeRunScripts } = require('../renderer/features/renderer-ide-run-scripts');

const EXPECTED_LABELS = {
  'ide:save-all': 'File: Save All',
  'ide:revert-file': 'File: Revert File',
  'ide:new-file': 'File: New File...',
  'ide:new-folder': 'File: New Folder...',
  'ide:open-folder': 'File: Open Folder...',
  'ide:reveal-active-file': 'File: Reveal Active File in Explorer View',
  'ide:copy-path': 'File: Copy Path of Active File',
  'ide:copy-relative-path': 'File: Copy Relative Path of Active File',
  'ide:close-all-editors': 'View: Close All Editors',
  'ide:close-other-editors': 'View: Close Other Editors',
  'ide:close-saved-editors': 'View: Close Saved Editors',
  'ide:toggle-word-wrap': 'View: Toggle Word Wrap',
  'ide:toggle-render-whitespace': 'View: Toggle Render Whitespace',
  'ide:toggle-sticky-scroll': 'View: Toggle Sticky Scroll',
  'ide:editor-zoom-in': 'View: Zoom In (Editor Font)',
  'ide:editor-zoom-out': 'View: Zoom Out (Editor Font)',
  'ide:editor-zoom-reset': 'View: Reset Zoom (Editor Font)',
  'ide:focus-terminal': 'Focus Terminal',
  'ide:focus-test-runner': 'Focus Test Runner',
  'ide:focus-chat': 'Focus Chat',
  'ide:next-problem': 'Go to Next Problem',
  'ide:previous-problem': 'Go to Previous Problem',
  'ide:run-build-task': 'Tasks: Run Build Task',
  'ide:run-active-file': 'Run Active File',
  'ide:run-npm-script': 'Run npm Script...',
  'ide:kill-terminal': 'Terminal: Kill the Active Terminal',
  'ide:terminal-find': 'Terminal: Find',
  'ide:terminal-clear': 'Terminal: Clear',
  'ide:terminal-new-with-profile': 'Terminal: Create New Terminal (With Profile)',
  'ide:terminal-select-default-profile': 'Terminal: Select Default Profile',
  'ide:terminal-rename': 'Terminal: Rename',
  'ide:open-editor-settings': 'Preferences: Open Editor Settings',
};

const CHORDS = {
  'ide:save-all': [['k', true], ['s', false]],
  'ide:open-folder': [['k', true], ['o', true]],
  'ide:close-all-editors': [['k', true], ['w', true]],
};

const FILE_CTX = { activeView: 'ide', hasActiveFile: true, activeKind: 'file', isRepo: false, groupCount: 1, focused: 'editor' };
const EMPTY_CTX = { activeView: 'ide', hasActiveFile: false, activeKind: '', isRepo: false, groupCount: 1, focused: 'other' };

function keyEvent(key, extra) {
  return Object.assign({ key, code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, extra);
}

function makeDeps(overrides) {
  const calls = { saved: [], closed: [], panels: [], clipboard: [], commits: [], applied: 0, logs: [], editorOptions: [], actions: [], clicked: [], reveal: [] };
  const ide = {
    openTabs: [
      { path: 'src/a.js', kind: 'file' },
      { path: 'src/b.js', kind: 'file' },
      { path: 'diff://change-1', kind: 'diff' },
      { path: 'src/c.js', kind: 'file', group: 'group-2' },
      { path: 'src/d.js', kind: 'file', group: 'group-2' },
    ],
    activeTabPath: 'src/a.js',
    dirtyByPath: { 'src/a.js': true, 'diff://change-1': true, 'src/c.js': true },
    fontSize: 0,
    renderWhitespace: 'selection',
  };
  const buttons = { new_file: { click: () => calls.clicked.push('new-file') }, new_folder: { click: () => calls.clicked.push('new-folder') } };
  const deps = {
    getIde: () => ide,
    appendClientLog: (level, event, detail) => calls.logs.push({ level, event, detail }),
    saveFile: async (path) => { calls.saved.push(path); return true; },
    editorHost: {
      getActivePath: () => ide.activeTabPath,
      isDirty: (path) => path === 'src/d.js',
      runAction: (id) => { calls.actions.push(id); return true; },
      setEditorOptions: (opts) => calls.editorOptions.push(opts),
    },
    document: {
      querySelector: (selector) => {
        if (selector === '[data-ide-tree-action="new-file"]') return buttons.new_file;
        if (selector === '[data-ide-tree-action="new-folder"]') return buttons.new_folder;
        return null;
      },
    },
    showPanel: (id, options) => { calls.panels.push([id, options]); return true; },
    chooseWorkspaceRoot: () => { calls.chose = true; },
    revealInExplorer: (path, options) => calls.reveal.push([path, options]),
    getWorkspaceRoot: () => ({ rootPath: 'C:\\ws\\proj' }),
    getClipboardApi: () => ({ writeText: async (text) => { calls.clipboard.push(text); } }),
    getCloseOrchestrator: () => ({
      requestCloseAll: async (group) => { calls.closed.push(['all', group]); return { committed: true }; },
      requestCloseOthers: async (path) => { calls.closed.push(['others', path]); return { committed: true }; },
      requestCloseSaved: async (group) => { calls.closed.push(['saved', group]); return { committed: true }; },
    }),
    commitEditorPreference: async (key, value) => { calls.commits.push([key, value]); ide[key] = value; return { updated: true, value }; },
    applyEditorPrefs: () => { calls.applied += 1; },
    problemsPanel: { nextProblem: () => calls.next = true, previousProblem: () => calls.prev = true },
    runScripts: {
      runBuildTask: () => { calls.build = true; },
      runActiveFile: () => { calls.runFile = true; },
      pickAndRunScript: () => { calls.pick = true; },
    },
    terminals: {
      closeTerminal: (id) => { calls.killed = id; return true; },
      panelFor: (id) => ({ openFind: () => { calls.find = id; }, clear: () => { calls.cleared = id; } }),
      profilesAvailable: () => true,
      canAdd: () => true,
      openProfileMenu: async (opts) => { calls.profileMenu = opts; return true; },
      openDefaultProfileMenu: async (opts) => { calls.defaultMenu = opts; return true; },
      renameTerminal: (id) => { calls.renamed = id; return true; },
    },
    getFileLifecycle: () => ({
      captureGitDiscard: (path) => { calls.captured = path; return { path }; },
      reloadAfterGitDiscard: async (snapshot) => { calls.reloaded = snapshot.path; return true; },
      releaseGitDiscard: (snapshot) => { calls.released = snapshot.path; },
    }),
    openEditorSettings: () => { calls.settings = true; },
    ...overrides,
  };
  return { deps, calls, ide };
}

function setup(overrides) {
  const registry = createIdeCommandRegistry();
  const made = makeDeps(overrides);
  const dispose = registerIdePaletteCommands(registry, made.deps);
  return { registry, dispose, ...made };
}

async function runRow(registry, id, ctx) {
  const ran = registry.run(id, ctx || FILE_CTX);
  await new Promise((resolve) => setImmediate(resolve));
  return ran;
}

test('every row registers with its exact label and group', () => {
  const { registry } = setup();
  for (const [id, label] of Object.entries(EXPECTED_LABELS)) {
    const entry = registry.get(id);
    assert.ok(entry, `${id} registered`);
    assert.equal(entry.label, label, `${id} label`);
    const navigate = ['ide:focus-terminal', 'ide:focus-test-runner', 'ide:focus-chat'].includes(id);
    assert.equal(entry.group, navigate ? 'Navigate' : 'Workspace', `${id} group`);
  }
});

test('keyed rows resolve through resolveChord', () => {
  const { registry } = setup();
  const single = {
    'ide:new-file': keyEvent('n', { ctrlKey: true }),
    'ide:next-problem': keyEvent('F8'),
    'ide:previous-problem': keyEvent('F8', { shiftKey: true }),
    'ide:run-build-task': keyEvent('B', { ctrlKey: true, shiftKey: true, code: 'KeyB' }),
    'ide:run-active-file': keyEvent('F5', { ctrlKey: true }),
  };
  for (const [id, event] of Object.entries(single)) {
    assert.deepEqual(registry.resolveChord(event, null, FILE_CTX), { id }, id);
  }
  for (const [id, steps] of Object.entries(CHORDS)) {
    const first = steps[0];
    const second = steps[1];
    const pending = registry.resolveChord(keyEvent(first[0], { ctrlKey: first[1] }), null, FILE_CTX);
    assert.deepEqual(pending, { pending: 'ctrl+k' }, `${id} opens the ctrl+k prefix`);
    assert.deepEqual(registry.resolveChord(keyEvent(second[0], { ctrlKey: second[1] }), 'ctrl+k', FILE_CTX), { id }, id);
  }
});

test('file rows hide from the palette without an active file; global rows stay', () => {
  const { registry } = setup();
  const ids = registry.list({ ctx: EMPTY_CTX }).map((row) => row.id);
  for (const hidden of ['ide:revert-file', 'ide:reveal-active-file', 'ide:copy-path', 'ide:copy-relative-path',
    'ide:close-other-editors', 'ide:run-active-file']) {
    assert.ok(!ids.includes(hidden), `${hidden} hidden`);
  }
  for (const shown of ['ide:save-all', 'ide:new-file', 'ide:open-folder', 'ide:close-all-editors', 'ide:run-build-task']) {
    assert.ok(ids.includes(shown), `${shown} shown`);
  }
  const withFile = registry.list({ ctx: FILE_CTX }).map((row) => row.id);
  assert.ok(withFile.includes('ide:copy-path') && withFile.includes('ide:run-active-file'));
  assert.deepEqual(registry.list({ ctx: { ...FILE_CTX, activeView: 'chat' } }), [], 'nothing off the Workspace view');
});

test('a missing dependency hides its row instead of throwing', () => {
  const { registry } = setup({ problemsPanel: null, runScripts: null, terminals: null, getFileLifecycle: undefined, getCloseOrchestrator: undefined, openEditorSettings: undefined });
  const ids = registry.list({ ctx: FILE_CTX }).map((row) => row.id);
  for (const hidden of ['ide:next-problem', 'ide:previous-problem', 'ide:run-build-task', 'ide:run-active-file', 'ide:run-npm-script',
    'ide:kill-terminal', 'ide:terminal-find', 'ide:terminal-clear', 'ide:terminal-new-with-profile', 'ide:terminal-select-default-profile', 'ide:terminal-rename', 'ide:revert-file', 'ide:close-all-editors', 'ide:close-saved-editors',
    'ide:open-editor-settings']) {
    assert.ok(!ids.includes(hidden), `${hidden} hidden`);
  }
  assert.equal(registry.run('ide:next-problem', FILE_CTX), false);
});

test('Save All saves dirty file tabs across groups and skips review tabs', async () => {
  const { registry, calls } = setup();
  await runRow(registry, 'ide:save-all');
  // a.js and c.js are dirty by state, d.js by the editor host; b.js is clean; the diff tab is never saved.
  assert.deepEqual(calls.saved, ['src/a.js', 'src/c.js', 'src/d.js']);
});

test('Save All logs a failing save and keeps going', async () => {
  let n = 0;
  const { registry, calls } = setup({ saveFile: async (path) => { n += 1; if (path === 'src/a.js') throw new Error('disk full'); calls.saved.push(path); return true; } });
  await runRow(registry, 'ide:save-all');
  assert.equal(n, 3);
  assert.deepEqual(calls.saved, ['src/c.js', 'src/d.js']);
  assert.equal(calls.logs[0].event, 'ide.command_ignored_error');
});

test('the close rows call the matching orchestrator method', async () => {
  const { registry, calls } = setup();
  await runRow(registry, 'ide:close-all-editors');
  assert.deepEqual(calls.closed.splice(0), [['all', ''], ['all', 'group-2']]);
  await runRow(registry, 'ide:close-saved-editors');
  assert.deepEqual(calls.closed.splice(0), [['saved', ''], ['saved', 'group-2']]);
  await runRow(registry, 'ide:close-other-editors');
  assert.deepEqual(calls.closed.splice(0), [['others', 'src/a.js']]);
});

test('Close All stops once a group refuses to close', async () => {
  const closed = [];
  const { registry } = setup({ getCloseOrchestrator: () => ({ requestCloseAll: async (group) => { closed.push(group); return { committed: false }; } }) });
  await runRow(registry, 'ide:close-all-editors');
  assert.deepEqual(closed, ['']);
});

test('file rows: new file/folder, open folder, reveal, copy paths and revert', async () => {
  const { registry, calls } = setup();
  await runRow(registry, 'ide:new-file');
  await runRow(registry, 'ide:new-folder');
  assert.deepEqual(calls.clicked, ['new-file', 'new-folder']);
  assert.deepEqual(calls.panels.map((p) => p[0]), ['explorer', 'explorer']);
  await runRow(registry, 'ide:open-folder');
  assert.equal(calls.chose, true);
  await runRow(registry, 'ide:reveal-active-file');
  assert.deepEqual(calls.reveal, [['src/a.js', { expandSelf: true }]]);
  await runRow(registry, 'ide:copy-path');
  await runRow(registry, 'ide:copy-relative-path');
  assert.deepEqual(calls.clipboard, ['C:\\ws\\proj\\src\\a.js', 'src/a.js']);
  await runRow(registry, 'ide:revert-file');
  assert.equal(calls.captured, 'src/a.js');
  assert.equal(calls.reloaded, 'src/a.js');
  assert.equal(calls.released, 'src/a.js', 'the capture is always released');
});

test('joinRootPath follows the root separator style', () => {
  assert.equal(joinRootPath('/home/me/ws/', 'src/a.js'), '/home/me/ws/src/a.js');
  assert.equal(joinRootPath('C:\\ws', 'src/a.js'), 'C:\\ws\\src\\a.js');
  assert.equal(joinRootPath('', 'src/a.js'), '');
});

test('a review tab is never treated as the active file', async () => {
  const { registry, calls, ide } = setup();
  ide.activeTabPath = 'diff://change-1';
  await runRow(registry, 'ide:copy-relative-path', { ...FILE_CTX, hasActiveFile: false, activeKind: 'diff' });
  assert.deepEqual(calls.clipboard, [], 'when() hides it; a forced run copies nothing');
  registry.get('ide:copy-relative-path').run(FILE_CTX);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.clipboard, []);
});

test('view toggles: word wrap action, whitespace, sticky scroll, editor zoom', async () => {
  const { registry, calls, ide } = setup();
  await runRow(registry, 'ide:toggle-word-wrap');
  assert.deepEqual(calls.actions, ['jenny.toggle-word-wrap']);

  await runRow(registry, 'ide:toggle-render-whitespace');
  assert.deepEqual(calls.commits.pop(), ['renderWhitespace', 'none']);
  await runRow(registry, 'ide:toggle-render-whitespace');
  assert.deepEqual(calls.commits.pop(), ['renderWhitespace', 'all']);

  // No persisted stickyScroll key yet: session-only through the editor host.
  await runRow(registry, 'ide:toggle-sticky-scroll');
  assert.deepEqual(calls.editorOptions.pop(), { stickyScroll: { enabled: false } });
  await runRow(registry, 'ide:toggle-sticky-scroll');
  assert.deepEqual(calls.editorOptions.pop(), { stickyScroll: { enabled: true } });
  ide.stickyScroll = true;
  await runRow(registry, 'ide:toggle-sticky-scroll');
  assert.deepEqual(calls.commits.pop(), ['stickyScroll', false]);

  calls.commits.length = 0;
  await runRow(registry, 'ide:editor-zoom-in');
  await runRow(registry, 'ide:editor-zoom-in');
  await runRow(registry, 'ide:editor-zoom-out');
  await runRow(registry, 'ide:editor-zoom-reset');
  assert.deepEqual(calls.commits, [['fontSize', 14], ['fontSize', 15], ['fontSize', 14], ['fontSize', 0]]);
  assert.ok(calls.applied >= 7, 'every committed pref is applied to the editor');
});

test('zoom steps skip the size the pref normalizer reads as "Match text size" and clamp', async () => {
  const { registry, calls, ide } = setup();
  ide.fontSize = 14;
  await runRow(registry, 'ide:editor-zoom-out');
  assert.deepEqual(calls.commits.pop(), ['fontSize', 12]);
  ide.fontSize = 8;
  await runRow(registry, 'ide:editor-zoom-out');
  assert.deepEqual(calls.commits.pop(), ['fontSize', 8]);
  ide.fontSize = 40;
  await runRow(registry, 'ide:editor-zoom-in');
  assert.deepEqual(calls.commits.pop(), ['fontSize', 40]);
});

test('focus, problem, run and terminal rows call their seams', async () => {
  const { registry, calls } = setup();
  await runRow(registry, 'ide:focus-terminal');
  await runRow(registry, 'ide:focus-test-runner');
  await runRow(registry, 'ide:focus-chat');
  assert.deepEqual(calls.panels, [['terminal', { focus: true }], ['test-runner', { focus: true }], ['chat', { focus: true }]]);
  await runRow(registry, 'ide:next-problem');
  await runRow(registry, 'ide:previous-problem');
  await runRow(registry, 'ide:run-build-task');
  await runRow(registry, 'ide:run-active-file');
  await runRow(registry, 'ide:run-npm-script');
  await runRow(registry, 'ide:kill-terminal');
  await runRow(registry, 'ide:terminal-find');
  await runRow(registry, 'ide:terminal-clear');
  await runRow(registry, 'ide:open-editor-settings');
  assert.equal(calls.next, true);
  assert.equal(calls.prev, true);
  assert.equal(calls.build, true);
  assert.equal(calls.runFile, true);
  assert.equal(calls.pick, true);
  assert.equal(calls.killed, 'terminal', 'defaults to the main terminal');
  assert.equal(calls.find, 'terminal', 'Terminal: Find opens the find bar of the active panel');
  assert.equal(calls.cleared, 'terminal', 'Terminal: Clear clears the active panel');
  assert.equal(calls.settings, true);
});

test('P6: the profile and rename rows call the terminal set and fail closed without the profile bridge', async () => {
  const { registry, calls } = setup({ getActiveTerminalViewId: () => 'terminal-2' });
  await runRow(registry, 'ide:terminal-new-with-profile');
  await runRow(registry, 'ide:terminal-select-default-profile');
  await runRow(registry, 'ide:terminal-rename');
  assert.deepEqual(calls.profileMenu, {});
  assert.deepEqual(calls.defaultMenu, {});
  assert.equal(calls.renamed, 'terminal-2');

  const hosted = setup();
  hosted.deps.terminals.profilesAvailable = () => false;
  const ids = hosted.registry.list({ ctx: FILE_CTX }).map((row) => row.id);
  assert.ok(!ids.includes('ide:terminal-new-with-profile'));
  assert.ok(!ids.includes('ide:terminal-select-default-profile'));
  assert.ok(ids.includes('ide:terminal-rename'), 'rename needs no bridge');
  hosted.deps.terminals.profilesAvailable = () => true;
  hosted.deps.terminals.canAdd = () => false;
  assert.ok(!hosted.registry.list({ ctx: FILE_CTX }).some((row) => row.id === 'ide:terminal-new-with-profile'), 'hidden at the four-terminal cap');
});

test('Kill Terminal targets the wired active terminal view', async () => {
  const { registry, calls } = setup({ getActiveTerminalViewId: () => 'terminal-3' });
  await runRow(registry, 'ide:kill-terminal');
  assert.equal(calls.killed, 'terminal-3');
});

test('a throwing or rejecting run is logged and never escapes', async () => {
  const { registry, calls } = setup({
    chooseWorkspaceRoot: () => { throw new Error('chooser exploded'); },
    runScripts: { runBuildTask: () => Promise.reject(new Error('build rejected')) },
  });
  assert.doesNotThrow(() => registry.run('ide:open-folder', FILE_CTX));
  assert.doesNotThrow(() => registry.run('ide:run-build-task', FILE_CTX));
  await new Promise((resolve) => setImmediate(resolve));
  const sites = calls.logs.map((entry) => entry.detail.site);
  assert.deepEqual(sites.sort(), ['ide:open-folder', 'ide:run-build-task']);
  assert.match(calls.logs.find((entry) => entry.detail.site === 'ide:open-folder').detail.error, /chooser exploded/);
});

test('dispose unregisters every row it registered', () => {
  const { registry, dispose } = setup();
  assert.ok(registry.get('ide:save-all'));
  dispose();
  for (const id of Object.keys(EXPECTED_LABELS)) assert.equal(registry.get(id), null, `${id} removed`);
  assert.deepEqual(registry.bindings(), []);
});

/* ---- runBuildTask (renderer-ide-run-scripts, exported for Tasks: Run Build Task) -------------- */
// renderer-ide-run-scripts.test.js sits at the file-size ceiling, so these live here.

function buildHarness(packageJson, readThrows) {
  const toasts = [];
  const started = [];
  const engine = createIdeRunScripts({
    editorHost: { getActivePath: () => '', focus() {} },
    getWorkspaceFsApi: () => ({ readFile: async () => { if (readThrows) throw new Error('ENOENT'); return { content: JSON.stringify(packageJson) }; } }),
    getWorkspaceRunTaskApi: () => ({
      onData: () => () => {},
      onExit: () => () => {},
      start: async (payload) => { started.push(payload.command); return { ok: true, taskId: 'run-1', cwd: 'C:/ws' }; },
      kill: async () => ({ killed: true, terminationConfirmed: true }),
    }),
    showToastMessage: (message) => toasts.push(message),
    platform: 'linux',
  });
  return { engine, toasts, started };
}

test('runBuildTask runs the package.json build script when one exists', async () => {
  const h = buildHarness({ scripts: { lint: 'eslint .', build: 'tsc' } });
  await h.engine.runBuildTask();
  assert.deepEqual(h.started, ["npm run 'build'"]);
});

test('runBuildTask opens the script picker when there is no build script', async () => {
  const h = buildHarness({ scripts: { lint: 'eslint .' } });
  await h.engine.runBuildTask();
  assert.deepEqual(h.started, [], 'nothing runs without a build script');
  // No overlay host here, so the picker reports it is unavailable, which proves it was asked to open.
  assert.match(h.toasts.join(' | '), /script picker is unavailable/i);
});

test('runBuildTask with no package.json toasts instead of running', async () => {
  const h = buildHarness(null, true);
  await h.engine.runBuildTask();
  assert.deepEqual(h.started, []);
  assert.match(h.toasts.join(' | '), /no package\.json/i);
});

// Row 82 P4 (G1): the Git rows list only in a repo and run the git feature's actions.
test('P4 git rows: labels, the repo gate and their actions', async () => {
  const ran = [];
  const actions = {
    stageAll: () => ran.push('stageAll'), unstageAll: () => ran.push('unstageAll'), discardAll: () => ran.push('discardAll'),
    getLastCommitMessage: async () => '', openChanges: (path) => ran.push(['openChanges', path]),
    openStagedChanges: (path) => ran.push(['openStaged', path]),
    quickpicks: { openDeleteBranchPicker: () => ran.push('deleteBranch'), openStashPicker: (mode) => ran.push(['stash', mode]) },
  };
  const { registry, calls } = setup({
    gitFeature: { getActions: () => actions, commitFromPalette: (opts) => ran.push(['commit', opts.amend]) },
  });
  const labels = {
    'ide:git-stage-all': 'Git: Stage All Changes', 'ide:git-unstage-all': 'Git: Unstage All Changes',
    'ide:git-discard-all': 'Git: Discard All Changes', 'ide:git-commit': 'Git: Commit', 'ide:git-commit-amend': 'Git: Commit (Amend)',
    'ide:git-open-changes': 'Git: Open Changes', 'ide:git-open-staged-changes': 'Git: Open Staged Changes',
    'ide:git-delete-branch': 'Git: Delete Branch...', 'ide:git-apply-stash': 'Git: Apply Stash...',
    'ide:git-pop-stash': 'Git: Pop Stash...', 'ide:git-drop-stash': 'Git: Drop Stash...',
  };
  const repoCtx = { ...FILE_CTX, isRepo: true };
  const listed = new Map(registry.list({ ctx: repoCtx }).map((row) => [row.id, row.label]));
  for (const [id, label] of Object.entries(labels)) assert.equal(listed.get(id), label, id);
  const outside = new Set(registry.list({ ctx: FILE_CTX }).map((row) => row.id));
  for (const id of Object.keys(labels)) assert.equal(outside.has(id), false, `${id} hidden outside a repo`);
  for (const id of Object.keys(labels)) await runRow(registry, id, repoCtx);
  assert.deepEqual(ran, ['stageAll', 'unstageAll', 'discardAll', ['commit', false], ['commit', true],
    ['openChanges', 'src/a.js'], ['openStaged', 'src/a.js'], 'deleteBranch', ['stash', 'apply'], ['stash', 'pop'], ['stash', 'drop']]);
  assert.deepEqual(calls.panels.slice(-2), [['source-control', undefined], ['source-control', undefined]]);
});

// Row 82 P4 (G2): Toggle Inline Blame flips the persisted pref and re-evaluates; the
// change rows walk the gutter's change blocks.
test('P4 G2 rows: Toggle Inline Blame and Go to Next / Previous Change', async () => {
  const moves = [];
  let refreshed = 0;
  const gutterDecorations = { inlineBlame: { refresh: () => { refreshed += 1; } }, goToChange: (direction) => moves.push(direction) };
  const { registry, calls, ide } = setup({ gutterDecorations });
  const repoCtx = { ...FILE_CTX, isRepo: true };
  const listed = new Map(registry.list({ ctx: repoCtx }).map((row) => [row.id, row.label]));
  assert.equal(listed.get('ide:git-toggle-inline-blame'), 'Git: Toggle Inline Blame');
  assert.equal(listed.get('ide:git-next-change'), 'Go to Next Change');
  assert.equal(listed.get('ide:git-previous-change'), 'Go to Previous Change');
  assert.equal(new Set(registry.list({ ctx: FILE_CTX }).map((row) => row.id)).has('ide:git-next-change'), false);
  await runRow(registry, 'ide:git-toggle-inline-blame', repoCtx);
  assert.deepEqual(calls.commits.at(-1), ['inlineBlame', false], 'default on, so the first toggle turns it off');
  await runRow(registry, 'ide:git-toggle-inline-blame', repoCtx);
  assert.deepEqual(calls.commits.at(-1), ['inlineBlame', true]);
  assert.equal(ide.inlineBlame, true);
  assert.equal(refreshed, 2);
  await runRow(registry, 'ide:git-next-change', repoCtx);
  await runRow(registry, 'ide:git-previous-change', repoCtx);
  assert.deepEqual(moves, [1, -1]);
});
