'use strict';

/* Editor-host secondary-group surface (W5): createGroupEditor / releaseGroupEditor /
 * noteModelEdited / isTextDocument, and the option fan-out to group editors.
 * Drives the host factory with a fake Monaco whose models are distinct per path
 * (mutable alternative-version ids) and whose editors record every call. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeEditorHost } = require('../renderer/features/renderer-ide-editor-host');
const monacoUtils = require('../renderer/features/renderer-monaco-editor-utils');

function makeFakeMonaco() {
  const editors = [];
  const models = new Map();
  const api = {
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
    Uri: { parse: (value) => ({ toString: () => String(value) }) },
    editor: {
      create(el, options) {
        const editor = {
          el, options, model: null, commands: [], updates: [], modelCalls: [], disposed: false, focusCb: null, contentCb: null,
          addCommand(keybinding, handler) { editor.commands.push({ keybinding, handler }); },
          onDidChangeModelContent(cb) { editor.contentCb = cb; return { dispose() {} }; },
          onDidFocusEditorWidget(cb) { editor.focusCb = cb; return { dispose() {} }; },
          onDidChangeCursorSelection(cb) { editor.cursorCb = cb; return { dispose() {} }; },
          onDidChangeModel(cb) { editor.modelCb = cb; return { dispose() {} }; },
          trigger(source, id) { editor.triggered = id; },
          focus() {},
          getPosition: () => editor.position || { lineNumber: 1, column: 1 },
          getSelection: () => editor.selection || { startLineNumber: 1, endLineNumber: 1, isEmpty: () => false },
          getModel: () => editor.model,
          setModel(model) { editor.model = model; editor.modelCalls.push(model); editor.modelCb?.(); },
          saveViewState: () => null,
          restoreViewState(state) { editor.restored = state; },
          updateOptions(next) { editor.updates.push(next); },
          dispose() { editor.disposed = true; },
        };
        editors.push(editor);
        return editor;
      },
      getModel: () => null,
      createModel(text, language, uri) {
        const model = {
          text, uri, altId: 1, setValue(next) { model.text = next; },
          getValue: () => model.text, getAlternativeVersionId: () => model.altId,
          getValueInRange: () => model.text,
          getLanguageId: () => language || 'plaintext', disposed: false,
          dispose() { model.disposed = true; for (const e of editors) if (e.model === model) throw new Error('disposed an attached model'); },
        };
        models.set(String(uri), model);
        return model;
      },
      onDidChangeMarkers: () => ({ dispose() {} }),
      getModelMarkers: () => [],
    },
  };
  return { api, editors, models };
}

function makeHost(overrides = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="ideEditorHost"></div><div id="groupEl"></div></body>');
  const fake = makeFakeMonaco();
  const events = { dirty: [], model: [], loads: 0, fontRegistered: [], fontReleased: [] };
  const host = createIdeEditorHost({
    getDom: () => ({ ideEditorHost: dom.window.document.getElementById('ideEditorHost') }),
    monacoUtils: {
      ...monacoUtils,
      ensureMonacoEditorApi: async () => { events.loads += 1; return fake.api; },
      normalizeEditorLanguage: () => 'javascript',
      registerMonacoFontConsumer: (editor) => { events.fontRegistered.push(editor); return () => events.fontReleased.push(editor); },
    },
    imageHostUtils: {},
    onDirtyChange: (path, dirty) => events.dirty.push([path, dirty]),
    onModelChange: (path) => events.model.push(path),
    ...overrides,
  });
  return { host, fake, dom, events, groupEl: dom.window.document.getElementById('groupEl') };
}

test('createGroupEditor is null before Monaco loads and never triggers a load', () => {
  const { host, groupEl, events } = makeHost();
  assert.equal(host.createGroupEditor(groupEl, {}), null);
  assert.equal(events.loads, 0);
  host.dispose();
});

test('createGroupEditor builds an editor with the primary options over the given element', async () => {
  const { host, fake, groupEl } = makeHost();
  await host.openDocument({ path: 'a.js', content: 'one' });
  const editor = host.createGroupEditor(groupEl, {});
  assert.equal(fake.editors.length, 2);
  assert.equal(fake.editors[1], editor);
  assert.equal(editor.el, groupEl);
  assert.deepEqual(editor.options, fake.editors[0].options, 'same creation options as the primary editor');
  assert.equal(editor.options.glyphMargin, true);
  assert.equal(editor.options.automaticLayout, true);
  host.dispose();
});

test('group editors follow the session wrap and minimap at creation', async () => {
  const { host, fake, groupEl } = makeHost();
  await host.openDocument({ path: 'a.js', content: 'one' });
  host.setWordWrap('on');
  host.setEditorOptions({ minimap: { enabled: false } });
  const editor = host.createGroupEditor(groupEl, {});
  assert.equal(editor.options.wordWrap, 'on');
  assert.deepEqual(editor.options.minimap, { enabled: false });
  assert.equal(fake.editors.length, 2);
  host.dispose();
});

test('a group editor created after the preferences start from them, not the shared code size (row 40 gate)', async () => {
  const { host, groupEl } = makeHost();
  await host.openDocument({ path: 'a.js', content: 'one' });
  host.setEditorOptions({ fontSize: 13, lineNumbers: 'off', minimap: { enabled: true } });
  const editor = host.createGroupEditor(groupEl, {});
  assert.deepEqual(editor.updates.at(-1), { fontSize: 13, lineNumbers: 'off' }, 'the applied level options, wrap and minimap kept as created');
  host.dispose();
});

test('Ctrl+S in a group editor calls onSave and widget focus calls onFocus', async () => {
  const { host, groupEl } = makeHost();
  await host.openDocument({ path: 'a.js', content: 'one' });
  const calls = [];
  const editor = host.createGroupEditor(groupEl, { onSave: () => calls.push('save'), onFocus: () => calls.push('focus') });
  assert.equal(editor.commands.length, 1);
  assert.equal(editor.commands[0].keybinding, 2048 | 49);
  editor.commands[0].handler();
  editor.focusCb();
  assert.deepEqual(calls, ['save', 'focus']);
  host.dispose();
});

test('setWordWrap and setEditorOptions reach every group editor', async () => {
  const { host, fake, groupEl } = makeHost();
  await host.openDocument({ path: 'a.js', content: 'one' });
  const first = host.createGroupEditor(groupEl, {});
  const second = host.createGroupEditor(groupEl, {});
  host.setWordWrap('on');
  assert.deepEqual(first.updates.at(-1), { wordWrap: 'on' });
  assert.deepEqual(second.updates.at(-1), { wordWrap: 'on' });
  host.setEditorOptions({ fontSize: 17, wordWrap: 'off', minimap: { enabled: false } });
  assert.deepEqual(first.updates.at(-1), { fontSize: 17, wordWrap: 'off', minimap: { enabled: false } });
  assert.deepEqual(second.updates.at(-1), { fontSize: 17, wordWrap: 'off', minimap: { enabled: false } });
  assert.equal(fake.editors[0].updates.at(-1).fontSize, 17, 'the primary still receives the same options');
  host.dispose();
});

test('a group editor does not inherit the primary active large-file minimap override', async () => {
  const { host, groupEl } = makeHost();
  await host.openDocument({ path: 'big.js', content: 'x'.repeat(300 * 1024) });
  host.activateDocument('big.js');
  const editor = host.createGroupEditor(groupEl, {});
  host.setEditorOptions({ minimap: { enabled: true } });
  assert.equal(editor.updates.at(-1).minimap.enabled, true);
  host.dispose();
});

test('noteModelEdited marks the document dirty and fires onModelChange', async () => {
  const { host, fake, events } = makeHost();
  await host.openDocument({ path: 'a.js', content: 'one' });
  const model = host.getModel('a.js');
  assert.equal(fake.models.size, 1);
  model.altId = 2;
  host.noteModelEdited('a.js');
  assert.deepEqual(events.dirty, [['a.js', true]]);
  assert.deepEqual(events.model, ['a.js']);
  assert.equal(host.isDirty('a.js'), true);
  host.noteModelEdited('missing.js');
  assert.deepEqual(events.model, ['a.js'], 'an unknown path is ignored');
  host.dispose();
});

test('noteModelEdited is ignored while the store applies a value', async () => {
  const { host, events } = makeHost();
  await host.openDocument({ path: 'a.js', content: 'one' });
  const model = host.getModel('a.js');
  const originalSetValue = model.setValue;
  model.setValue = (next) => { model.altId = 5; host.noteModelEdited('a.js'); originalSetValue(next); };
  await host.openDocument({ path: 'a.js', content: 'two' });
  assert.deepEqual(events.model, [], 'a programmatic setValue never counts as an edit');
  assert.equal(model.getValue(), 'two');
  host.dispose();
});

test('releaseGroupEditor detaches the model, disposes and unregisters the font consumer once', async () => {
  const { host, groupEl, events } = makeHost();
  await host.openDocument({ path: 'a.js', content: 'one' });
  const editor = host.createGroupEditor(groupEl, {});
  assert.deepEqual(events.fontRegistered, [editor], 'each group editor registers with the typography observer');
  host.releaseGroupEditor(editor);
  assert.equal(editor.modelCalls.at(-1), null);
  assert.equal(editor.disposed, true);
  assert.deepEqual(events.fontReleased, [editor]);
  host.releaseGroupEditor(editor);
  host.setWordWrap('on');
  assert.equal(editor.updates.length, 0, 'a released editor receives no more option updates');
  assert.deepEqual(events.fontReleased, [editor], 'second release is a no-op');
  host.dispose();
});

test('dispose releases every group editor and later creation returns null', async () => {
  const { host, fake, groupEl } = makeHost();
  await host.openDocument({ path: 'a.js', content: 'one' });
  const first = host.createGroupEditor(groupEl, {});
  const second = host.createGroupEditor(groupEl, {});
  host.dispose();
  assert.equal(first.disposed, true);
  assert.equal(second.disposed, true);
  assert.equal(first.modelCalls.at(-1), null, 'detached before the model sweep');
  assert.equal(fake.editors[0].disposed, true);
  assert.equal(host.createGroupEditor(groupEl, {}), null);
});

test('closeDocument detaches group editors from the model before disposing it', async () => {
  const { host, groupEl } = makeHost();
  await host.openDocument({ path: 'a.js', content: 'one' });
  await host.openDocument({ path: 'b.js', content: 'two' });
  const editor = host.createGroupEditor(groupEl, {});
  const other = host.createGroupEditor(groupEl, {});
  const modelA = host.getModel('a.js');
  const modelB = host.getModel('b.js');
  editor.setModel(modelA);
  other.setModel(modelB);
  host.closeDocument('a.js');
  assert.equal(editor.getModel(), null, 'the group editor showing the closed doc is detached');
  assert.equal(modelA.disposed, true);
  assert.equal(other.getModel(), modelB, 'a group editor on another doc is untouched');
  assert.equal(host.hasDocument('a.js'), false);
  host.dispose();
});

test('isTextDocument is true only for file documents with a model', async () => {
  const { host, groupEl } = makeHost();
  await host.openDocument({ path: 'a.js', content: 'one' });
  await host.openDocument({ path: 'big.js', content: 'x'.repeat(300 * 1024) });
  await host.openDiffDocument({ id: 'diff://a', original: 'a', modified: 'b' });
  assert.equal(host.isTextDocument('a.js'), true);
  assert.equal(host.isTextDocument('big.js'), true, 'no large-file restriction');
  assert.equal(host.isTextDocument('diff://a'), false);
  assert.equal(host.isTextDocument('nope.js'), false);
  assert.ok(groupEl);
  host.dispose();
});

test('the primary editor keeps its own creation, save command and dirty feed', async () => {
  const saves = [];
  const { host, fake, events } = makeHost({ onSaveRequest: () => { saves.push('save'); } });
  await host.openDocument({ path: 'a.js', content: 'one' });
  host.activateDocument('a.js');
  assert.equal(fake.editors.length, 1, 'no group editor is created implicitly');
  const primary = fake.editors[0];
  primary.commands[0].handler();
  assert.deepEqual(saves, ['save']);
  host.getModel('a.js').altId = 2;
  primary.contentCb();
  assert.deepEqual(events.dirty, [['a.js', true]]);
  assert.deepEqual(events.model, ['a.js']);
  assert.equal(host.isUsingMonaco(), true);
  host.dispose();
});

test('W7b focused reads follow group focus, primary focus and release without changing the primary path', async (t) => {
  const { host, fake, groupEl, dom } = makeHost();
  t.after(() => { host.dispose(); dom.window.close(); });
  await host.openDocument({ path: 'a.js', content: 'primary' });
  await host.openDocument({ path: 'b.js', content: 'group' });
  host.activateDocument('a.js');
  const primary = fake.editors[0];
  const editor = host.createGroupEditor(groupEl, { getPath: () => 'b.js', onFocus() {} });
  editor.setModel(host.getModel('b.js'));
  editor.position = { lineNumber: 7, column: 3 };
  editor.selection = { startLineNumber: 4, endLineNumber: 7, isEmpty: () => false };
  const checkPrimary = () => {
    assert.equal(host.getFocusedPath(), 'a.js');
    assert.equal(host.getActivePath(), 'a.js');
    assert.equal(host.getSelectedText(), 'primary');
    assert.deepEqual(host.getFocusedCursorInfo(), { lineNumber: 1, column: 1, selectedChars: 7 });
    assert.deepEqual(host.getCursorInfo(), { lineNumber: 1, column: 1, selectedChars: 7 });
  };
  checkPrimary();
  editor.focusCb();
  assert.equal(host.getFocusedPath(), 'b.js');
  assert.equal(host.getActivePath(), 'a.js');
  assert.equal(host.getSelectedText(), 'group');
  assert.deepEqual(host.getSelectionRange(), { startLine: 4, endLine: 7 });
  assert.deepEqual(host.getFocusedCursorInfo(), { lineNumber: 7, column: 3, selectedChars: 5 });
  assert.deepEqual(host.getCursorInfo(), { lineNumber: 1, column: 1, selectedChars: 7 }, 'primary readers keep the primary cursor');
  assert.equal(host.getActiveLanguageId(), host.getModel('a.js').getLanguageId());
  editor.setModel(null);
  checkPrimary();
  editor.setModel(host.getModel('b.js'));
  primary.focusCb();
  checkPrimary();
  editor.focusCb();
  host.releaseGroupEditor(editor);
  checkPrimary();
});

test('W7b cursor and active-file notifications follow focus changes exactly once', async (t) => {
  const cursors = [];
  const { host, fake, groupEl, dom } = makeHost({ onCursorActivity: (cursor) => cursors.push(cursor), getDocumentWorkspaceId: (path) => path });
  const previous = { dispatchEvent: globalThis.dispatchEvent, CustomEvent: globalThis.CustomEvent, reader: globalThis.rendererIdeActiveEditorReader };
  const seen = [];
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.dispatchEvent = (event) => {
    const reader = globalThis.rendererIdeActiveEditorReader;
    seen.push([event.type, event.detail.path, reader.getActivePath(), reader.getWorkspaceId(), reader.isLargeFile()]);
  };
  t.after(() => {
    host.dispose(); dom.window.close();
    globalThis.dispatchEvent = previous.dispatchEvent;
    globalThis.CustomEvent = previous.CustomEvent;
    globalThis.rendererIdeActiveEditorReader = previous.reader;
  });
  await host.openDocument({ path: 'a.js', content: 'primary' });
  await host.openDocument({ path: 'b.js', content: 'x'.repeat(300 * 1024) });
  host.activateDocument('a.js');
  const primary = fake.editors[0];
  const editor = host.createGroupEditor(groupEl, { getPath: () => 'b.js', onFocus() {} });
  editor.setModel(host.getModel('b.js'));
  seen.length = 0; cursors.length = 0;
  editor.cursorCb?.();
  assert.equal(cursors.length, 0);
  editor.focusCb(); editor.focusCb();
  assert.equal(cursors.length, 1);
  assert.deepEqual(seen, [['ide:active-file-changed', 'b.js', 'b.js', 'b.js', true]]);
  editor.cursorCb();
  assert.equal(cursors.length, 2);
  assert.equal(seen.length, 1);
  primary.focusCb(); primary.focusCb();
  editor.cursorCb();
  assert.equal(cursors.length, 3);
  editor.focusCb();
  host.releaseGroupEditor(editor); host.releaseGroupEditor(editor);
  assert.equal(cursors.length, 5);
  assert.deepEqual(seen.map((event) => event.slice(0, 3)), ['b.js', 'a.js', 'b.js', 'a.js'].map((path) => ['ide:active-file-changed', path, path]));
});

test('W7b keyboard selection intent sends the focused group path and selection', async (t) => {
  const { createIdeSelectionIntents } = require('../renderer/features/renderer-ide-selection-intents');
  const { host, groupEl, dom } = makeHost();
  t.after(() => { host.dispose(); dom.window.close(); });
  await host.openDocument({ path: 'a.js', content: 'primary' });
  await host.openDocument({ path: 'b.js', content: 'group' });
  host.activateDocument('a.js');
  const editor = host.createGroupEditor(groupEl, { getPath: () => 'b.js', onFocus() {} });
  editor.setModel(host.getModel('b.js'));
  editor.selection = { startLineNumber: 4, endLineNumber: 7, isEmpty: () => false };
  editor.focusCb();
  const sent = [];
  const intents = createIdeSelectionIntents({ editorHost: host, onSendToJenny: (payload) => sent.push(payload) });
  intents.sendSelection('current', 'explain');
  assert.equal(sent[0].path, 'b.js');
  assert.equal(sent[0].code, 'group');
  assert.equal(sent[0].startLine, 4);
  assert.equal(sent[0].endLine, 7);
  assert.equal(host.getActivePath(), 'a.js');
});

test('W7 review: a group tab switch announces the new file, go-to-line and a view state reach the group editor', async (t) => {
  const { host, fake, groupEl, dom } = makeHost();
  const previous = { dispatchEvent: globalThis.dispatchEvent, CustomEvent: globalThis.CustomEvent, reader: globalThis.rendererIdeActiveEditorReader };
  const seen = [];
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.dispatchEvent = (event) => { seen.push(event.detail.path); };
  t.after(() => {
    host.dispose(); dom.window.close();
    globalThis.dispatchEvent = previous.dispatchEvent;
    globalThis.CustomEvent = previous.CustomEvent;
    globalThis.rendererIdeActiveEditorReader = previous.reader;
  });
  for (const path of ['a.js', 'b.js', 'c.js']) await host.openDocument({ path, content: path });
  host.activateDocument('a.js');
  const primary = fake.editors[0];
  // The group view updates its own path only after setModel returns: getPath lags.
  let viewPath = 'b.js';
  const editor = host.createGroupEditor(groupEl, { getPath: () => viewPath, onFocus() {} });
  editor.setModel(host.getModel('b.js'));
  editor.focusCb();
  seen.length = 0;
  editor.setModel(host.getModel('c.js'));
  viewPath = 'c.js';
  assert.deepEqual(seen, ['c.js']);
  assert.equal(host.getFocusedPath(), 'c.js');

  assert.equal(host.triggerGoToLine(), true);
  assert.equal(editor.triggered, 'editor.action.gotoLine');
  assert.equal(primary.triggered, undefined);

  assert.equal(host.applyViewState('c.js', { cursor: 42 }), true);
  assert.deepEqual(editor.restored, { cursor: 42 }, 'a reopened group tab gets its cursor back');
  assert.equal(primary.restored, undefined);
});

test('the indentation read and pick act on the focused group editor\'s file, not the primary one', async () => {
  const { host, fake, groupEl } = makeHost();
  await host.openDocument({ path: 'a.js', content: 'one' });
  await host.openDocument({ path: 'b.js', content: 'two' });
  host.activateDocument('a.js');
  const sizes = new Map();
  [...fake.models.values()].forEach((model, i) => {
    sizes.set(model, i === 0 ? 2 : 4);
    model.getOptions = () => ({ tabSize: sizes.get(model) });
    model.updateOptions = (next) => sizes.set(model, next.tabSize);
  });
  const [modelA, modelB] = [...fake.models.values()];
  const editor = host.createGroupEditor(groupEl, {});
  editor.setModel(modelB);
  editor.focusCb(); // group 2 has focus
  assert.equal(host.getTabSize(), 4, 'the status strip reads the focused file');
  host.setTabSize(8);
  assert.equal(sizes.get(modelB), 8, 'the pick changes the focused file');
  assert.equal(sizes.get(modelA), 2, 'the primary file is untouched');
  assert.equal(host.getTabSize('a.js'), 2);
  host.setTabSize(3, 'a.js');
  assert.equal(sizes.get(modelA), 3, 'an explicit path wins (session defaults on open)');
  host.dispose();
});
