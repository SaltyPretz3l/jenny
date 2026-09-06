'use strict';

// Reverting a created file closes two documents: the file tab and the diff
// that was reviewing it. When the diff was the ACTIVE document, closeDocument
// blanks the editor, so the controller has to activate the tab the IDE state
// selected next — the same landing the file-tab close already performs — or
// the surviving tab is selected in state while the editor shows nothing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeDiffController } = require('../renderer/features/renderer-ide-diff-controller');
const ideState = require('../renderer/features/renderer-ide-state');

test('reverting a created file whose diff is active lands the editor on the surviving tab', async () => {
  const window = new JSDOM('<div id="toolbar"></div>').window;
  const ide = ideState.createIdeUiState();
  const opened = new Set(['README.md']);
  const activated = [];
  const controller = createIdeDiffController({
    getIde: () => ide,
    getDom: () => ({ ideDiffToolbar: window.document.getElementById('toolbar') }),
    getFileOperations: () => null,
    editorHost: {
      openDiffDocument: async ({ id }) => { opened.add(id); return true; },
      activateDocument: (id) => { activated.push(id); ide.activeTabPath = id; },
      closeDocument: (id) => { opened.delete(id); },
      hasDocument: (id) => opened.has(id),
      showEmpty: () => activated.push('<empty>'),
      isDirty: () => false,
    },
    getWorkspaceFsApi: () => ({
      readFile: async () => ({ content: 'created by jenny\n', mtimeMs: 1 }),
      delete: async () => ({ ok: true }),
    }),
    confirmDialog: { confirm: async () => true },
    callbacks: { appendClientLog: () => {}, showShellErrorToast: () => {}, renderTabs: () => {} },
  });
  ideState.openTab(ide, 'README.md');
  ideState.openTab(ide, 'notes.md');
  const change = { changeId: 'change-created', path: 'notes.md', beforeHash: null, status: 'created', additions: 1 };
  await controller.openChangeDiff(change);
  assert.equal(ide.openTabs.length, 3, 'README, the created file, and its diff are open');
  assert.notEqual(ide.activeTabPath, 'README.md', 'the diff is the active document before revert');

  const result = await controller.revertChange(change);

  assert.equal(result, true);
  assert.deepEqual(ide.openTabs.map((tab) => tab.path), ['README.md'], 'both the file tab and its diff are closed');
  assert.equal(ide.activeTabPath, 'README.md');
  assert.equal(activated.at(-1), 'README.md', 'the surviving tab is activated in the editor, not only selected in state');
  window.close();
});
