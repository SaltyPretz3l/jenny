'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const editorPrefs = require('../renderer/features/renderer-ide-editor-prefs');
const { createIdeController } = require('../renderer/features/renderer-ide-controller');

// ---------------------------------------------------------------------------
// Part 1 - pure unit tests of the sibling module (no DOM, no Monaco).
// ---------------------------------------------------------------------------

test('applyEditorPrefs maps the IDE slice to editor-level options + chip seed defaults', () => {
  const calls = { setEditorOptions: [], seedDefaults: [] };
  const host = { setEditorOptions: (o) => calls.setEditorOptions.push(o) };
  const chip = { seedDefaults: (o) => calls.seedDefaults.push(o) };
  editorPrefs.applyEditorPrefs(
    { fontSize: 16, wordWrap: 'on', minimap: false, lineNumbers: 'off', renderWhitespace: 'all', tabSize: 4, eol: 'crlf' },
    host,
    chip
  );
  assert.deepEqual(calls.setEditorOptions, [{
    fontSize: 16,
    wordWrap: 'on',
    minimap: { enabled: false },
    lineNumbers: 'off',
    renderWhitespace: 'all',
    rulers: [],
  }]);
  assert.deepEqual(calls.seedDefaults, [{ tabSize: 4, eol: 'crlf' }]);
});

test('applyEditorPrefs falls back to safe defaults; unset per-model prefs seed null (follow file)', () => {
  const calls = { setEditorOptions: [], seedDefaults: [] };
  const host = { setEditorOptions: (o) => calls.setEditorOptions.push(o) };
  const chip = { seedDefaults: (o) => calls.seedDefaults.push(o) };
  editorPrefs.applyEditorPrefs({}, host, chip);
  assert.deepEqual(calls.setEditorOptions, [{
    fontSize: 13,
    wordWrap: 'off',
    minimap: { enabled: true },
    lineNumbers: 'on',
    renderWhitespace: 'selection',
    rulers: [],
  }]);
  // tabSize 0/undefined and eol '' mean "leave following the file".
  assert.deepEqual(calls.seedDefaults, [{ tabSize: null, eol: null }]);
});

test('applyEditorPrefs is null-safe and bails when the host cannot apply options', () => {
  assert.doesNotThrow(() => editorPrefs.applyEditorPrefs(null, null, null));
  // A host without setEditorOptions (fallback / not yet booted) is a quiet no-op.
  let seeded = 0;
  editorPrefs.applyEditorPrefs({ tabSize: 4 }, {}, { seedDefaults: () => { seeded += 1; } });
  assert.equal(seeded, 0);
});

test('applyEditorPrefs forwards column rulers (a copy) and clears them when empty', () => {
  const calls = { setEditorOptions: [] };
  const host = { setEditorOptions: (o) => calls.setEditorOptions.push(o) };
  const rulers = [80, 120];
  editorPrefs.applyEditorPrefs({ rulers }, host, { seedDefaults() {} });
  assert.deepEqual(calls.setEditorOptions[0].rulers, [80, 120]);
  // A copy is passed so Monaco can't retain (and later mutate) the live slice.
  assert.notEqual(calls.setEditorOptions[0].rulers, rulers);
  // Disabling rulers (-> []) must emit [] so the guides are cleared, not omitted.
  editorPrefs.applyEditorPrefs({ rulers: [] }, host, { seedDefaults() {} });
  assert.deepEqual(calls.setEditorOptions[1].rulers, []);
});

test('persistChipChange commits valid picks through the acknowledged preference seam', async () => {
  const ide = {};
  let persists = 0;
  const commit = async (key, value) => {
    persists += 1;
    ide[key] = value;
    return { updated: true, value };
  };
  await editorPrefs.persistChipChange(ide, { kind: 'tab-size', value: 8 }, commit);
  await editorPrefs.persistChipChange(ide, { kind: 'eol', value: 'crlf' }, commit);
  assert.equal(ide.tabSize, 8);
  assert.equal(ide.eol, 'crlf');
  assert.equal(persists, 2);
  // Invalid picks leave the slice untouched and do not persist.
  await editorPrefs.persistChipChange(ide, { kind: 'tab-size', value: 0 }, commit);
  await editorPrefs.persistChipChange(ide, { kind: 'eol', value: 'mac' }, commit);
  await editorPrefs.persistChipChange(ide, { kind: 'bogus', value: 1 }, commit);
  await editorPrefs.persistChipChange(null, { kind: 'tab-size', value: 4 }, commit);
  assert.equal(ide.tabSize, 8);
  assert.equal(ide.eol, 'crlf');
  assert.equal(persists, 2);
});

test('createWordWrapController.toggle applies only after acknowledged persistence', async () => {
  const ide = { wordWrap: 'off' };
  const calls = { setWordWrap: [] };
  let persists = 0;
  let renders = 0;
  const host = { setWordWrap: (v) => calls.setWordWrap.push(v), addEditorAction() {} };
  const ctrl = editorPrefs.createWordWrapController({
    getIde: () => ide,
    editorHost: host,
    commitPreference: async (key, value) => {
      persists += 1; ide[key] = value; return { updated: true, value };
    },
    requestStatusRender: () => { renders += 1; },
  });
  await ctrl.toggle();
  assert.equal(ide.wordWrap, 'on');
  assert.deepEqual(calls.setWordWrap, ['on']);
  assert.equal(persists, 1);
  assert.equal(renders, 1);
  await ctrl.toggle();
  assert.equal(ide.wordWrap, 'off', 'second toggle flips back');
});

test('createWordWrapController.registerAction registers the Alt+Z acknowledged toggle', async () => {
  const ide = { wordWrap: 'off' };
  const actions = [];
  const host = { setWordWrap() {}, addEditorAction: (a) => actions.push(a) };
  const ctrl = editorPrefs.createWordWrapController({
    getIde: () => ide,
    editorHost: host,
    commitPreference: async (key, value) => { ide[key] = value; return { updated: true, value }; },
  });
  ctrl.registerAction({ KeyMod: { Alt: 512 }, KeyCode: { KeyZ: 56 } });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].id, 'jenny.toggle-word-wrap');
  assert.equal(actions[0].label, 'Toggle Word Wrap');
  assert.deepEqual(actions[0].keybindings, [512 | 56]);
  await actions[0].run();
  assert.equal(ide.wordWrap, 'on', 'the registered action toggles word wrap');
});

test('createWordWrapController is null-safe with no host or missing keybinding support', () => {
  const ctrl = editorPrefs.createWordWrapController({});
  assert.doesNotThrow(() => ctrl.registerAction(null));
  assert.doesNotThrow(() => ctrl.toggle());
  // A Monaco api without KeyMod/KeyCode registers the action with no keybinding.
  const actions = [];
  const ctrl2 = editorPrefs.createWordWrapController({
    getIde: () => ({ wordWrap: 'off' }),
    editorHost: { setWordWrap() {}, addEditorAction: (a) => actions.push(a) },
  });
  ctrl2.registerAction({});
  assert.equal(actions[0].keybindings, undefined);
});

// ---------------------------------------------------------------------------
// Part 2 - integration: persisted prefs -> activateIde -> live Monaco options.
// Fake Monaco records updateOptions on both the editor (editor-level prefs) and
// the model (per-model tabSize via the chip-picker seed).
// ---------------------------------------------------------------------------

function createFakeMonaco() {
  const editors = [];
  const modelUpdateOptionsCalls = [];
  function createFakeModel(value, language, uri) {
    let current = String(value || '');
    let eol = 'lf';
    return {
      uri,
      language,
      getValue: () => current,
      setValue(next) { current = String(next || ''); },
      getAlternativeVersionId: () => 1,
      getOptions: () => ({ tabSize: 2 }),
      updateOptions(options) { modelUpdateOptionsCalls.push(options); },
      setEOL(next) { eol = next === 1 ? 'crlf' : 'lf'; },
      pushEOL(next) { eol = next === 1 ? 'crlf' : 'lf'; },
      getEOL: () => (eol === 'crlf' ? '\r\n' : '\n'),
      dispose() {},
    };
  }
  return {
    __editors: editors,
    __modelUpdateOptionsCalls: modelUpdateOptionsCalls,
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
    EndOfLineSequence: { LF: 0, CRLF: 1 },
    Uri: { parse: (value) => ({ toString: () => String(value) }) },
    languages: {
      typescript: {
        typescriptDefaults: { setEagerModelSync() {} },
        javascriptDefaults: { setEagerModelSync() {} },
      },
    },
    editor: {
      create(host) {
        const fake = {
          host,
          model: null,
          updateOptionsCalls: [],
          contentListeners: [],
          addCommand() {},
          getAction(id) { return { id, run() {} }; },
          updateOptions(options) { fake.updateOptionsCalls.push(options); },
          onDidChangeModelContent(listener) { fake.contentListeners.push(listener); },
          onDidChangeCursorPosition() {},
          onDidChangeCursorSelection() {},
          setModel(model) { fake.model = model; },
          getModel() { return fake.model; },
          saveViewState() { return {}; },
          restoreViewState() {},
          layout() {},
          focus() {},
          dispose() {},
        };
        editors.push(fake);
        return fake;
      },
      createModel: (value, language, uri) => createFakeModel(value, language, uri),
      getModel: () => null,
      defineTheme() {},
      setTheme() {},
    },
  };
}

function buildDom() {
  const dom = new JSDOM(`
    <div id="ideView">
      <div id="ideShell" data-rail-side="right">
        <div id="ideTabStrip"></div>
        <div id="ideEditorHost"></div>
        <textarea id="ideEditorFallback" class="hidden"></textarea>
        <div id="ideEmptyState"><p id="ideEmptyStateCopy"></p></div>
        <div id="ideStatusBar" class="hidden"></div>
        <div id="ideRailPanel"></div>
      </div>
    </div>
  `);
  const byId = (id) => dom.window.document.getElementById(id);
  return {
    dom,
    getDom: () => ({
      ideView: byId('ideView'),
      ideShell: byId('ideShell'),
      ideTabStrip: byId('ideTabStrip'),
      ideEditorHost: byId('ideEditorHost'),
      ideEditorFallback: byId('ideEditorFallback'),
      ideEmptyState: byId('ideEmptyState'),
      ideEmptyStateCopy: byId('ideEmptyStateCopy'),
      ideStatusBar: byId('ideStatusBar'),
      ideRailPanel: byId('ideRailPanel'),
    }),
  };
}

const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

test('activateIde applies persisted editor prefs to the live Monaco editor + model', async () => {
  const { dom, getDom } = buildDom();
  const fakeMonaco = createFakeMonaco();
  const previousWindow = globalThis.window;
  const previousMonacoUtils = globalThis.rendererMonacoEditorUtils;
  globalThis.window = dom.window;
  dom.window.jennyShell = {
    workspaceFs: {
      async getRootState() {
        return { workspaceRoot: 'G:/fake-root', workspaceRootStatus: { state: 'ready', message: '' } };
      },
      async readFile() {
        return { path: 'src/app.js', content: 'hello', size: 5, mtimeMs: 1000, eol: 'lf' };
      },
      async readText() {
        return {
          ok: true, path: 'src/app.js', pathKey: process.platform === 'win32' ? 'src/app.js'.toLowerCase() : 'src/app.js',
          requestedPath: 'src/app.js', requestedPathKey: process.platform === 'win32' ? 'src/app.js'.toLowerCase() : 'src/app.js',
          content: 'hello', size: 5, mtimeMs: 1000, eol: 'lf', rootId: 'root_fake', generation: 1,
          fileVersion: 'vf2_open', encoding: 'utf-8', editable: true, truncated: false,
        };
      },
      async stat() { return { path: 'src/app.js', exists: true, kind: 'file', size: 5, mtimeMs: 1000 }; },
    },
    workspaceIde: {
      async getState() {
        return {
          ok: true,
          context: {
            rootPath: 'G:/fake-root', rootId: 'root_fake', generation: 1, phase: 'ready',
          },
          openTabs: [{ path: 'src/app.js' }],
          activeTabPath: 'src/app.js',
          expandedDirs: [],
          railPanel: 'explorer',
          railSide: 'right',
          railWidth: 300,
          wordWrap: 'on',
          fontSize: 16,
          tabSize: 4,
          minimap: false,
          lineNumbers: 'off',
          renderWhitespace: 'all',
          eol: 'crlf',
        };
      },
      async updateSettings(patch) { return patch; },
      async updateState() { return { updated: true }; },
    },
  };
  globalThis.rendererMonacoEditorUtils = {
    ...require('../renderer/features/renderer-monaco-editor-utils'),
    async ensureMonacoEditorApi() { return fakeMonaco; },
    normalizeEditorLanguage: (ext) => (ext === 'js' ? 'javascript' : 'plaintext'),
  };
  const cleanups = [];
  const controller = createIdeController({
    state: { ui: { activeView: 'ide', ide: null } },
    getDom,
    registerCleanup: (fn) => cleanups.push(fn),
    callbacks: {
      appendClientLog: () => {},
      showShellErrorToast: () => {},
      toErrorMessage: (error, fallback) => String(error?.message || fallback || ''),
    },
  });
  try {
    await controller.activateIde();
    await settle();
    const editor = fakeMonaco.__editors[0];
    assert.ok(editor, 'a Monaco editor was created');
    // Editor-level prefs reached updateOptions (from applyEditorPrefs via onMonacoReady).
    const applied = editor.updateOptionsCalls.find((opts) => opts && opts.fontSize === 16);
    assert.ok(applied, 'editor-level prefs were applied');
    assert.deepEqual(applied, {
      fontSize: 16,
      wordWrap: 'on',
      minimap: { enabled: false },
      lineNumbers: 'off',
      renderWhitespace: 'all',
      rulers: [],
    });
    // Per-model tabSize reached the model (chip-picker seedDefaults -> setTabSize).
    const tabUpdate = fakeMonaco.__modelUpdateOptionsCalls.find((opts) => opts && opts.tabSize === 4);
    assert.ok(tabUpdate, 'persisted tabSize was applied to the model');
  } finally {
    for (const cleanup of cleanups.splice(0)) {
      try { cleanup(); } catch (_error) { /* noop */ }
    }
    globalThis.window = previousWindow;
    globalThis.rendererMonacoEditorUtils = previousMonacoUtils;
  }
});
