'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createIdeEditorHost } = require('../renderer/features/renderer-ide-editor-host');
const { createIdeEditorGroupsWiring } = require('../renderer/features/renderer-ide-editor-groups-wiring');
const { createIdeDiffController } = require('../renderer/features/renderer-ide-diff-controller');
const { createIdeSuggestionDiff } = require('../renderer/features/renderer-ide-suggestion-diff');
const state = require('../renderer/features/renderer-ide-state');
const groups = require('../renderer/features/renderer-ide-editor-groups');
const monacoUtils = require('../renderer/features/renderer-monaco-editor-utils');

async function rig(t, opts = {}) {
  const window = new JSDOM('<div id="host"></div><div id="toolbar"></div><div id="workbench"></div>').window;
  const document = window.document;
  const editors = [], diffs = [], models = [], fonts = [], released = [];
  const side = () => ({ onDidFocusEditorWidget(cb) { this.focusCb = cb; return { dispose() {} }; }, revealPositionInCenter(p) { this.revealed = p; }, focus() { this.focusCb?.(); } });
  const api = {
    KeyMod: { CtrlCmd: 2048 }, KeyCode: { KeyS: 49 }, Uri: { parse: (s) => s },
    editor: {
      create() {
        const e = { model: null, setModel(m) { this.model = m; }, getModel() { return this.model; }, addCommand() {}, updateOptions() {}, onDidChangeModelContent() {}, saveViewState: () => null, dispose() {}, layout() {} };
        editors.push(e); return e;
      },
      createDiffEditor(el, options) {
        const original = side(), modified = side();
        const e = { el, options, model: null, updates: [], disposed: false,
          setModel(m) { this.model = m; }, getModel() { return this.model; },
          getOriginalEditor: () => original, getModifiedEditor: () => modified,
          updateOptions(o) { this.updates.push(o); }, layout() { this.layouts = (this.layouts || 0) + 1; },
          onDidUpdateDiff(cb) { this.updated = cb; return { dispose: () => { this.updated = null; } }; },
          getLineChanges: () => [{ modifiedStartLineNumber: 7, charChanges: [{ modifiedStartLineNumber: 7, modifiedStartColumn: 9 }] }],
          dispose() { this.disposed = true; },
        };
        diffs.push(e); return e;
      },
      getModel: () => null,
      createModel(text) {
        const m = { text, disposed: false, getValue() { return this.text; }, setValue(s) { this.text = s; }, getAlternativeVersionId: () => 1,
          dispose() { assert.ok(diffs.every((e) => !e.model || (e.model.original !== this && e.model.modified !== this)), 'detach before model disposal'); this.disposed = true; } };
        models.push(m); return m;
      },
      onDidChangeMarkers: () => ({ dispose() {} }),
    },
  };
  const host = createIdeEditorHost({
    getDom: () => ({ ideEditorHost: document.getElementById('host') }),
    monacoUtils: { ...monacoUtils, ensureMonacoEditorApi: async () => api,
      registerMonacoFontConsumer: (e) => { fonts.push(e); return () => released.push(e); } },
  });
  const ide = state.createIdeUiState();
  await host.openDocument({ path: 'primary.js', content: 'primary' });
  state.openTab(ide, 'primary.js'); host.activateDocument('primary.js');
  let wiring;
  const render = () => { wiring?.reconcile(); wiring?.renderViews(); };
  const showDiffTab = (id) => wiring.activateInGroup(id) || host.activateDocument(id);
  const deleted = [], writes = [], focused = [];
  const controller = createIdeDiffController({
    getIde: () => ide, getDom: () => ({ ideDiffToolbar: document.getElementById('toolbar') }), editorHost: host, showDiffTab,
    getWorkspaceFsApi: () => ({ readFile: async () => ({ content: 'new\n', mtimeMs: 1 }),
      readPreChange: async () => ({ found: true, content: 'old\n' }),
      delete: async ({ path }) => { deleted.push(path); }, writeFile: async (p) => { writes.push(p); return { ok: true }; } }),
    confirmDialog: { confirm: async () => true }, callbacks: { renderTabs: render },
  });
  wiring = createIdeEditorGroupsWiring({ getIde: () => ide, getDom: () => ({ ideWorkbench: document.getElementById('workbench') }),
    editorHost: host, requestRender: render, activatePrimary: (id) => host.activateDocument(id),
    renderReviewBar: (el, id) => controller.renderToolbarFor(el, id), onActivated: (id) => focused.push(id),
    loadDocument: () => { throw new Error('diff id must never load from disk'); },
    getBoundGroups: () => opts.bound || [], getBoundText: () => (opts.bound ? 'Files Jenny opens from Chat land here.' : ''),
  });
  t.after(() => { wiring.dispose(); controller.dispose(); host.dispose(); window.close(); });
  return { window, document, host, ide, wiring, controller, render, diffs, models, fonts, released, deleted, writes, focused };
}

const change = { changeId: 'one', path: 'changed.js', beforeHash: 'before', status: 'modified', reviewState: 'full',
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }] };

test('moving a diff into a group shows shared models, review bar, focus and move back', async (t) => {
  const r = await rig(t);
  await r.controller.openChangeDiff(change);
  const id = r.ide.activeTabPath, pair = r.diffs[0].model;
  assert.equal(r.wiring.moveToGroup(id, 'editor-2'), true);
  const el = r.wiring.getElement('editor-2'), diff = r.diffs[1];
  assert.deepEqual(diff.model, pair);
  assert.equal(r.models.length, 3, 'one file model plus the shared pair');
  assert.equal(el.querySelector('.ide-group-editor').hidden, true);
  assert.equal(el.querySelector('.ide-group-diff').hidden, false);
  assert.ok(el.querySelector('[data-ide-diff-revert]'));
  diff.updated(); assert.deepEqual(diff.getModifiedEditor().revealed, { lineNumber: 7, column: 9 });
  diff.getOriginalEditor().focus(); assert.equal(r.focused.at(-1), id);
  r.host.setWordWrap('on'); assert.deepEqual(diff.updates.at(-1), { wordWrap: 'on' });
  r.host.setEditorOptions({ fontSize: 18 }); assert.equal(diff.updates.at(-1).fontSize, 18);
  assert.equal(r.wiring.moveToGroup(id, ''), true);
  assert.equal(diff.disposed, true); assert.deepEqual(r.diffs[0].model, pair);
});

test('closing the last diff of a bound group shows its empty state, not a blank diff', async (t) => {
  const r = await rig(t, { bound: ['editor-2'] });
  await r.controller.openChangeDiff(change);
  const id = r.ide.activeTabPath;
  assert.equal(r.wiring.moveToGroup(id, 'editor-2'), true);
  r.ide.openTabs = r.ide.openTabs.filter((tab) => tab.path !== id); // the close orchestrator's state change
  delete r.ide.groupActive['editor-2'];
  r.host.closeDocument(id);
  r.render();
  const el = r.wiring.getElement('editor-2');
  assert.ok(el, 'a bound group outlives its last tab');
  assert.equal(el.querySelector('.ide-group-diff').hidden, true);
  const empty = el.querySelector('.ide-group-empty');
  assert.equal(empty.hidden, false);
  assert.match(empty.textContent, /Files Jenny opens from Chat land here\./);
  assert.ok(empty.querySelector('[data-ide-group-close]'));
});

test('reopening a grouped diff selects it in its group and leaves the primary active', async (t) => {
  const r = await rig(t);
  await r.controller.openChangeDiff(change);
  const id = r.ide.activeTabPath;
  state.getTab(r.ide, id).group = 'editor-2'; r.ide.groupActive = { 'editor-2': id };
  r.ide.activeTabPath = 'primary.js'; r.host.activateDocument('primary.js');
  await r.controller.openChangeDiff(change);
  assert.equal(r.ide.activeTabPath, 'primary.js');
  assert.equal(r.ide.groupActive['editor-2'], id);
  assert.equal(r.host.getActivePath(), 'primary.js');
});

test('closing a diff detaches all group diff editors before shared models dispose', async (t) => {
  const r = await rig(t);
  await r.host.openDiffDocument({ id: 'diff://change/close', original: 'a', modified: 'b' });
  const a = r.host.createGroupDiffEditor(r.document.createElement('div'));
  const b = r.host.createGroupDiffEditor(r.document.createElement('div'));
  const surface = r.host.getDiffSurface('diff://change/close');
  a.setModel({ original: surface.original, modified: surface.modified }); b.setModel(a.getModel());
  r.host.closeDocument('diff://change/close');
  assert.equal(a.getModel(), null); assert.equal(b.getModel(), null);
  assert.equal(surface.original.disposed, true); assert.equal(surface.modified.disposed, true);
  r.host.releaseGroupDiffEditor(a); r.host.releaseGroupDiffEditor(b);
  assert.equal(a.disposed, true); assert.equal(r.released.length, 4);
});

test('group revert bar acts on its own id and created-file revert shows its neighbour', async (t) => {
  const r = await rig(t);
  await r.controller.openChangeDiff({ ...change, changeId: 'created', beforeHash: null, status: 'created' });
  const id = r.ide.activeTabPath;
  state.getTab(r.ide, id).group = 'editor-2';
  await r.host.openDocument({ path: 'neighbour.js', content: 'next' });
  r.ide.openTabs.push({ path: 'neighbour.js', kind: 'file', group: 'editor-2' });
  r.ide.groupActive = { 'editor-2': id }; r.ide.activeTabPath = 'primary.js'; r.host.activateDocument('primary.js');
  r.render();
  const el = r.wiring.getElement('editor-2');
  el.querySelector('[data-ide-diff-revert]').click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(r.deleted, ['changed.js']);
  assert.equal(r.ide.groupActive['editor-2'], 'neighbour.js');
  assert.equal(r.ide.activeTabPath, 'primary.js'); assert.equal(r.host.getActivePath(), 'primary.js');
  assert.equal(el.querySelector('.ide-group-editor').hidden, false);
  assert.equal(el.querySelector('.ide-group-diff').hidden, true);
});

test('missing grouped diff returns to primary without a disk load', async (t) => {
  const r = await rig(t);
  const id = 'diff://change/gone';
  r.ide.openTabs.push({ path: id, kind: 'diff', group: 'editor-2' }); r.ide.groupActive = { 'editor-2': id };
  r.render(); await Promise.resolve();
  assert.equal(groups.groupOf(r.ide, id), '');
});

test('suggestion bars keep both group targets bound while the primary file is active', async (t) => {
  const r = await rig(t), targets = [], clicked = [];
  const entries = new Map([['chat-a', { id: 'a', path: 'a.js', old_string: 'new', new_string: 'A', revision: 1 }], ['chat-b', { id: 'b', path: 'b.js', old_string: 'new', new_string: 'B', revision: 1 }]]);
  const suggestion = createIdeSuggestionDiff({ getIde: () => r.ide, editorHost: r.host, ideStateUtils: state,
    getWorkspaceFsApi: () => ({ readFile: async () => ({ content: 'new' }) }),
    getClient: () => ({ get: (session) => ({ entries: [entries.get(session)] }), setCurrent() {}, subscribe: () => () => {} }),
    createBarController: () => ({ render(el, target) { targets.push(target); el.innerHTML = '<div class="suggestion-bar"></div>'; el.target = target; return true; }, handleClick(event, el) { clicked.push(el.target.id); } }),
  });
  t.after(() => suggestion.dispose());
  await suggestion.openSuggestion('chat-a', 'a'); await suggestion.openSuggestion('chat-b', 'b');
  r.ide.activeTabPath = 'primary.js';
  const a = r.document.createElement('div'), b = r.document.createElement('div');
  assert.equal(suggestion.renderToolbarFor(a, 'diff://suggestion/chat-a'), true);
  assert.equal(suggestion.renderToolbarFor(b, 'diff://suggestion/chat-b'), true);
  a.dispatchEvent(new r.window.Event('click', { bubbles: true })); b.dispatchEvent(new r.window.Event('click', { bubbles: true }));
  assert.deepEqual(clicked, ['a', 'b']); assert.deepEqual(targets.map((c) => c.id), ['a', 'b']);
});
