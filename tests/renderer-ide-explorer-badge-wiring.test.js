'use strict';

// Row 82 cleanup (S4 wiring of T4-T6, T9): the explorer hands the tree the Problems
// panel's marker snapshot, the Run-output task problems, the git status subscription and
// the expanded-folder test, so the tree badges use them in the app (not only in tests).

const { test } = require('node:test');
const assert = require('node:assert/strict');

let captured = null;
globalThis.rendererIdeTree = { createIdeTree: (deps) => { captured = deps; return {}; } };
const { createIdeExplorerWiring } = require('../renderer/features/renderer-ide-explorer-wiring');

function wire(overrides = {}) {
  captured = null;
  const ide = { openTabs: [], expandedDirs: new Set(['src']) };
  createIdeExplorerWiring({
    getDom: () => ({}), getIde: () => ide, getWorkspaceFsApi: () => null, openFile() {},
    buildFileContextMenuItems: () => [], buildPathUtilityMenuItems: () => [], schedulePersist() {},
    getWorkspaceRootApi: () => null, showShellErrorToast() {}, appendClientLog() {}, panelDeps: () => ({}),
    getFileLifecycle: () => null, getSearchPanel: () => null, getCloseOrchestrator: () => null, getConfirmDialog: () => null,
    getGitFeature: () => null, getTerminalPanel: () => null, getBottomPanel: () => null,
    ...overrides,
  });
  return captured;
}

test('the tree receives the panel snapshot, task problems, git status and expanded folders', () => {
  const subscribers = [];
  const tasks = { getMarkers: () => [] };
  const deps = wire({
    getProblemsPanel: () => ({ getMarkerSnapshot: () => [{ path: 'a.js', severity: 'error' }] }),
    getRunScripts: () => ({ getTaskProblems: () => tasks }),
    getGitFeature: () => ({ getStore: () => ({ subscribe: (fn) => { subscribers.push(fn); return () => {}; } }) }),
  });
  assert.deepEqual(deps.getMarkers(), [{ path: 'a.js', severity: 'error' }]);
  assert.equal(deps.getTaskProblems(), tasks);
  const listener = () => {};
  assert.equal(typeof deps.subscribeGitStatus(listener), 'function');
  assert.deepEqual(subscribers, [listener]);
  assert.equal(deps.isDirectoryExpanded('src'), true);
  assert.equal(deps.isDirectoryExpanded('docs'), false);
});

test('without the Problems panel or git the badges read the editor host themselves and git is a no-op', () => {
  const host = { getMarkers: () => [{ path: 'b.js', severity: 'warning' }] };
  const deps = wire({ getEditorHost: () => host });
  assert.equal(deps.getMarkers(), null, 'no snapshot: the badges fall back to editor host + Tasks');
  assert.equal(deps.getEditorHost(), host);
  assert.equal(deps.getTaskProblems(), null);
  assert.equal(typeof deps.subscribeGitStatus(() => {}), 'function');
});
