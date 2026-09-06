'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeController } = require('../renderer/features/renderer-ide-controller');

function createFakeMonaco() {
  const editors = [];
  function createFakeModel(value, language, uri) {
    let current = String(value || '');
    let altVersion = 1;
    return {
      uri,
      language,
      getValue: () => current,
      setValue(next) {
        current = String(next || '');
        altVersion += 1;
      },
      getAlternativeVersionId: () => altVersion,
      __bumpForEdit(next) {
        current = String(next || '');
        altVersion += 1;
      },
      dispose() {},
    };
  }
  const themeCalls = { defineTheme: [], setTheme: [] };
  const eagerModelSyncCalls = [];
  const monaco = {
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
    Uri: { parse: (value) => ({ toString: () => String(value) }) },
    // W6 IntelliSense tuning: the editor host pins eager model sync off on
    // both TS-family language defaults the moment Monaco boots.
    languages: {
      typescript: {
        typescriptDefaults: {
          setEagerModelSync: (value) => eagerModelSyncCalls.push({ defaults: 'typescript', value }),
        },
        javascriptDefaults: {
          setEagerModelSync: (value) => eagerModelSyncCalls.push({ defaults: 'javascript', value }),
        },
      },
    },
    __themeCalls: themeCalls,
    __eagerModelSyncCalls: eagerModelSyncCalls,
    editor: {
      create(host) {
        const fake = {
          host,
          model: null,
          viewStates: [],
          contentListeners: [],
          commands: [],
          layoutCalls: 0,
          actionsRun: [],
          updateOptionsCalls: [],
          focusCalls: 0,
          addCommand(keybinding, handler) {
            fake.commands.push({ keybinding, handler });
          },
          getAction(id) {
            return { id, run() { fake.actionsRun.push(id); } };
          },
          updateOptions(options) {
            fake.updateOptionsCalls.push(options);
          },
          onDidChangeModelContent(listener) {
            fake.contentListeners.push(listener);
          },
          setModel(model) {
            fake.model = model;
          },
          saveViewState() {
            return { savedFor: fake.model?.uri?.toString() || '' };
          },
          restoreViewState(viewState) {
            fake.viewStates.push(viewState);
          },
          layout() {
            fake.layoutCalls += 1;
          },
          focus() { fake.focusCalls += 1; },
          dispose() {},
          __typeIntoModel(nextValue) {
            fake.model.__bumpForEdit(nextValue);
            for (const listener of fake.contentListeners) {
              listener();
            }
          },
        };
        editors.push(fake);
        return fake;
      },
      createModel: (value, language, uri) => createFakeModel(value, language, uri),
      getModel: () => null,
      defineTheme(name, data) {
        themeCalls.defineTheme.push({ name, data });
      },
      setTheme(name) {
        themeCalls.setTheme.push(name);
      },
    },
    __editors: editors,
  };
  return monaco;
}

function buildIdeDom() {
  const dom = new JSDOM(`
    <div id="ideView">
      <div id="ideShell" data-rail-side="right">
        <div id="ideTabStrip"></div>
        <div id="ideEditorHost"></div>
        <textarea id="ideEditorFallback" class="hidden"></textarea>
        <div id="ideEmptyState"><p id="ideEmptyStateCopy"></p></div>
        <div id="ideRailPanel"></div>
      </div>
    </div>
  `);
  const doc = dom.window.document;
  const byId = (id) => doc.getElementById(id);
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
      ideRailPanel: byId('ideRailPanel'),
    }),
  };
}

function createBridgeStub({ files = {}, failWriteWith = null } = {}) {
  const calls = { readFile: [], writeFile: [], getState: [], updateSettings: [], updateState: [] };
  let mtimeCounter = 1000;
  const mtimes = new Map(Object.keys(files).map((key) => [key, (mtimeCounter += 10)]));
  const versions = new Map(Object.keys(files).map((key) => [key, `vf2_${mtimes.get(key)}`]));
  return {
    calls,
    files,
    jennyShell: {
      workspaceFs: {
        async getRootState() {
          return { workspaceRoot: 'G:/fake-root', workspaceRootStatus: { state: 'ready', message: '' } };
        },
        async readFile(payload) {
          calls.readFile.push(payload);
          if (!(payload.path in files)) {
            const error = new Error('File not found in the workspace.');
            error.code = 'CMP-WORKSPACEFS-0004';
            throw error;
          }
          return {
            path: payload.path,
            content: files[payload.path],
            size: files[payload.path].length,
            mtimeMs: mtimes.get(payload.path),
            eol: 'lf',
          };
        },
        async readText(payload) {
          try {
            const result = await this.readFile(payload);
            return {
              ok: true, ...result, pathKey: process.platform === 'win32' ? result.path.toLowerCase() : result.path,
              requestedPath: payload.path, requestedPathKey: process.platform === 'win32' ? payload.path.toLowerCase() : payload.path,
              rootId: 'root_fake', generation: 1, fileVersion: versions.get(result.path),
              encoding: 'utf-8', editable: true, truncated: false,
            };
          } catch (error) {
            return { ok: false, code: error.code, message: error.message, details: {} };
          }
        },
        async stat(payload) {
          return { path: payload.path, exists: payload.path in files, kind: 'file', size: 0, mtimeMs: mtimes.get(payload.path) || 0 };
        },
        async writeFile(payload) {
          calls.writeFile.push(payload);
          if (failWriteWith) {
            throw failWriteWith;
          }
          files[payload.path] = payload.content;
          mtimes.set(payload.path, (mtimeCounter += 10));
          return { path: payload.path, size: payload.content.length, mtimeMs: mtimes.get(payload.path) };
        },
        async writeText(payload) {
          const result = await this.writeFile(payload);
          const fileVersion = `vf2_${result.mtimeMs}`;
          versions.set(payload.path, fileVersion);
          return {
            ok: true, ...result, pathKey: process.platform === 'win32' ? result.path.toLowerCase() : result.path,
            rootId: 'root_fake', generation: 1, fileVersion,
          };
        },
      },
      workspaceIde: {
        async getState() {
          calls.getState.push(true);
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
          };
        },
        async updateSettings(patch) {
          calls.updateSettings.push(patch);
          return { updated: true, ...patch };
        },
        async updateState(payload) {
          calls.updateState.push(payload);
          return {
            updated: true,
            context: {
              rootPath: 'G:/fake-root', rootId: 'root_fake', generation: 1, phase: 'ready',
            },
          };
        },
      },
    },
  };
}

async function settle(ms = 10) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createHarness({ withMonaco = true, bridgeOptions } = {}) {
  const { dom, getDom } = buildIdeDom();
  const bridge = createBridgeStub(bridgeOptions);
  const fakeMonaco = withMonaco ? createFakeMonaco() : null;
  const previousWindow = globalThis.window;
  const previousMonacoUtils = globalThis.rendererMonacoEditorUtils;
  globalThis.window = dom.window;
  dom.window.jennyShell = bridge.jennyShell;
  globalThis.rendererMonacoEditorUtils = {
    ...require('../renderer/features/renderer-monaco-editor-utils'),
    async ensureMonacoEditorApi() {
      return fakeMonaco;
    },
    normalizeEditorLanguage: (ext) => (ext === 'js' ? 'javascript' : 'plaintext'),
  };
  const cleanups = [];
  const toasts = [];
  const state = { ui: { activeView: 'ide', ide: null } };
  const controller = createIdeController({
    state,
    getDom,
    registerCleanup: (fn) => cleanups.push(fn),
    callbacks: {
      appendClientLog: () => {},
      showShellErrorToast: (message, meta) => toasts.push({ message, meta }),
      toErrorMessage: (error, fallback) => String(error?.message || fallback || ''),
    },
  });
  return {
    dom,
    getDom,
    bridge,
    fakeMonaco,
    controller,
    state,
    toasts,
    dispose() {
      for (const cleanup of cleanups.splice(0)) {
        try { cleanup(); } catch (_error) { /* noop */ }
      }
      globalThis.window = previousWindow;
      globalThis.rendererMonacoEditorUtils = previousMonacoUtils;
    },
  };
}

test('ide controller hydrates persisted tabs, edits, and saves with mtime concurrency', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'src/app.js': 'const a = 1;\n' } },
  });
  t.after(() => harness.dispose());

  await harness.controller.activateIde();
  await settle();

  // Persisted tab reopened lazily through workspaceFs.
  assert.equal(harness.bridge.calls.getState.length, 1);
  assert.deepEqual(harness.bridge.calls.readFile.map((call) => call.path), ['src/app.js']);
  const strip = harness.getDom().ideTabStrip;
  assert.match(strip.innerHTML, /app\.js/);
  assert.ok(strip.querySelector('[data-ide-tab-path="src/app.js"]'));
  assert.equal(harness.getDom().ideEmptyState.classList.contains('hidden'), true);

  // Simulate typing in Monaco -> dirty dot appears.
  const editor = harness.fakeMonaco.__editors[0];
  editor.__typeIntoModel('const a = 2;\n');
  assert.ok(strip.querySelector('.ide-tab--dirty'));

  // Ctrl+S routes through the registered Monaco command.
  assert.equal(editor.commands.length, 1);
  await editor.commands[0].handler();
  await settle();
  assert.equal(harness.bridge.calls.writeFile.length, 1);
  const write = harness.bridge.calls.writeFile[0];
  assert.equal(write.path, 'src/app.js');
  assert.equal(write.content, 'const a = 2;\n');
  assert.equal(write.expectedGeneration, 1);
  assert.match(write.expectedFileVersion, /^vf2_/);
  assert.equal(strip.querySelector('.ide-tab--dirty'), null);
  assert.equal(harness.toasts.length, 0);
});

test('ide controller opens a second file, switches tabs, and closes back', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'src/app.js': 'a', 'README.md': 'readme' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  await harness.controller.openFile('README.md');
  const strip = harness.getDom().ideTabStrip;
  assert.equal(strip.querySelectorAll('[data-ide-tab]').length, 2);
  assert.equal(
    strip.querySelector('[data-ide-tab-path="README.md"]').getAttribute('aria-selected'),
    'true'
  );

  // Close the active tab; the neighbor becomes active.
  strip.querySelector('[data-ide-tab-close="README.md"]').click();
  await settle();
  assert.equal(strip.querySelectorAll('[data-ide-tab]').length, 1);
  assert.equal(
    strip.querySelector('[data-ide-tab-path="src/app.js"]').getAttribute('aria-selected'),
    'true'
  );
  assert.equal(harness.state.ui.ide.activeTabPath, 'src/app.js');

  // Persisted-state writes carry a root/generation token through updateState.
  await settle(600);
  assert.ok(harness.bridge.calls.updateState.length >= 1);
  const lastPersist = harness.bridge.calls.updateState.at(-1);
  assert.equal(lastPersist.expectedRootId, 'root_fake');
  assert.equal(lastPersist.expectedGeneration, 1);
  assert.deepEqual(lastPersist.rootState.openTabs, [{ path: 'src/app.js' }]);
});

test('ide controller surfaces save conflicts as error toasts', async (t) => {
  const conflict = new Error('File changed on disk since it was last loaded.');
  conflict.code = 'CMP-WORKSPACEFS-0020';
  const harness = createHarness({
    bridgeOptions: { files: { 'src/app.js': 'a' }, failWriteWith: conflict },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  harness.fakeMonaco.__editors[0].__typeIntoModel('b');
  const saved = await harness.controller.saveActiveFile();
  assert.equal(saved, false);
  assert.equal(harness.toasts.length, 1);
  assert.equal(harness.toasts[0].meta.title, 'Save Conflict');
  // Buffer stays dirty so the user can retry.
  assert.ok(harness.getDom().ideTabStrip.querySelector('.ide-tab--dirty'));
});

test('an edit that lands mid-write stays dirty (not silently marked saved)', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'src/app.js': 'a' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  const editor = harness.fakeMonaco.__editors[0];
  editor.__typeIntoModel('b'); // dirty
  // saveFile snapshots the content + dirty-version synchronously, then suspends
  // on the async writeFile; type again BEFORE that write resolves.
  const savePromise = harness.controller.saveActiveFile();
  editor.__typeIntoModel('bc'); // edit during the in-flight write
  const saved = await savePromise;

  assert.equal(saved, true);
  // Only the pre-write snapshot ('b') was written...
  assert.equal(harness.bridge.calls.writeFile.at(-1).content, 'b');
  // ...and the mid-write 'bc' edit is NOT marked saved — the tab stays dirty so a
  // later edit / auto-save flushes it instead of silently losing it to disk.
  assert.ok(
    harness.getDom().ideTabStrip.querySelector('.ide-tab--dirty'),
    'a mid-write edit remains dirty'
  );
});

test('an unattended auto-save surfaces transient failures and conflicts', async (t) => {
  // A background save failure is visible while the dirty indicator remains.
  const genericFail = new Error('disk full');
  const quiet = createHarness({
    bridgeOptions: { files: { 'src/app.js': 'a' }, failWriteWith: genericFail },
  });
  t.after(() => quiet.dispose());
  await quiet.controller.activateIde();
  await settle();
  quiet.fakeMonaco.__editors[0].__typeIntoModel('b');
  const saved = await quiet.controller.saveActiveFile({ unattended: true });
  assert.equal(saved, false);
  assert.equal(quiet.toasts.length, 1, 'unattended non-conflict failure is visible');
  assert.ok(quiet.getDom().ideTabStrip.querySelector('.ide-tab--dirty'), 'the tab stays dirty as the signal');

  // A genuine on-disk conflict is surfaced even when unattended — silently
  // diverging from disk is worse than an unsolicited notification.
  const conflict = new Error('File changed on disk since it was last loaded.');
  conflict.code = 'CMP-WORKSPACEFS-0020';
  const loud = createHarness({
    bridgeOptions: { files: { 'src/app.js': 'a' }, failWriteWith: conflict },
  });
  t.after(() => loud.dispose());
  await loud.controller.activateIde();
  await settle();
  loud.fakeMonaco.__editors[0].__typeIntoModel('b');
  await loud.controller.saveActiveFile({ unattended: true });
  assert.equal(loud.toasts.length, 1, 'a conflict is surfaced even on an unattended save');
  assert.equal(loud.toasts[0].meta.title, 'Save Conflict');
});

test('ide controller falls back to the textarea when Monaco is unavailable', async (t) => {
  const harness = createHarness({
    withMonaco: false,
    bridgeOptions: { files: { 'notes.txt': 'hello' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  // The persisted tab (src/app.js) does not exist in this workspace; it drops
  // silently and the explicitly opened file takes over.
  await harness.controller.openFile('notes.txt');

  const textarea = harness.getDom().ideEditorFallback;
  assert.equal(textarea.classList.contains('hidden'), false);
  assert.equal(textarea.value, 'hello');

  textarea.value = 'hello world';
  textarea.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
  assert.ok(harness.getDom().ideTabStrip.querySelector('.ide-tab--dirty'));

  const saved = await harness.controller.saveActiveFile();
  assert.equal(saved, true);
  assert.equal(harness.bridge.calls.writeFile[0].content, 'hello world');
  assert.equal(harness.getDom().ideTabStrip.querySelector('.ide-tab--dirty'), null);
});

test('ide controller applies the jenny theme and disables eager model sync when Monaco boots', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'src/app.js': 'const a = 1;\n' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  // The theme bridge ran off onMonacoReady: 'jenny' defined from the live
  // palette vars (jsdom resolves none, so colors inherit) and activated.
  const themeCalls = harness.fakeMonaco.__themeCalls;
  assert.equal(themeCalls.defineTheme.length, 1);
  assert.equal(themeCalls.defineTheme[0].name, 'jenny');
  assert.equal(themeCalls.defineTheme[0].data.inherit, true);
  assert.ok(Array.isArray(themeCalls.defineTheme[0].data.rules));
  assert.deepEqual(themeCalls.setTheme, ['jenny']);

  // IntelliSense worker tuning is pinned once on both TS-family defaults.
  assert.deepEqual(harness.fakeMonaco.__eagerModelSyncCalls, [
    { defaults: 'typescript', value: false },
    { defaults: 'javascript', value: false },
  ]);

  // A second activation re-renders without re-running the one-time boot work.
  await harness.controller.activateIde();
  await settle();
  assert.equal(themeCalls.defineTheme.length, 1);
  assert.equal(harness.fakeMonaco.__eagerModelSyncCalls.length, 2);
});

test('reopen-closed-tab restores the captured Monaco view state', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'src/app.js': 'a', 'src/b.js': 'bee' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  await harness.controller.openFile('src/b.js');
  await settle();
  assert.equal(harness.state.ui.ide.activeTabPath, 'src/b.js');

  const editor = harness.fakeMonaco.__editors[0];
  // Close the active tab (Ctrl+F4): the controller captures the live view state
  // before the model is disposed.
  harness.getDom().ideView.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
    key: 'F4', ctrlKey: true, bubbles: true, cancelable: true,
  }));
  await settle();
  assert.equal(harness.state.ui.ide.activeTabPath, 'src/app.js');

  const restoresBefore = editor.viewStates.length;
  // Ctrl+Shift+T reopens b.js and restores its captured view state.
  harness.getDom().ideView.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
    key: 't', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
  }));
  await settle();

  assert.equal(harness.state.ui.ide.activeTabPath, 'src/b.js');
  assert.ok(editor.viewStates.length > restoresBefore, 'a view state was restored on reopen');
  assert.match(String(editor.viewStates.at(-1).savedFor || ''), /b\.js$/);
});

test('IDE palette commands run the right Monaco actions and toggle the minimap', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.js': 'x' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('a.js');
  await settle();

  const editor = harness.fakeMonaco.__editors[0];
  const items = Object.fromEntries(
    harness.controller.getIdeCommandItems().map((item) => [item.id, item])
  );

  items['ide:format-document'].run();
  items['ide:go-to-symbol'].run();
  items['ide:find-references'].run();
  assert.deepEqual(editor.actionsRun, [
    'editor.action.formatDocument',
    'editor.action.quickOutline',
    'editor.action.referenceSearch.trigger',
  ]);
  assert.ok(editor.focusCalls > 0, 'runAction returns focus to the editor');

  // Minimap defaults on; the command persists and applies the synchronized preference.
  items['ide:toggle-minimap'].run();
  await settle();
  assert.deepEqual(editor.updateOptionsCalls.at(-1), { minimap: { enabled: false } });
  assert.equal(harness.bridge.calls.updateSettings.at(-1).minimap, false);
});

// Owner log CMP-RENDER-0001 (2026-07-10): the breadcrumb symbol picker ran
// editor.action.quickOutline while the editor was unfocused; Monaco's quick
// input service threw an uncaught "needs a focused editor to work". runAction
// must focus BEFORE running the action and contain a throwing action.
test('runAction focuses the editor before the action and contains its throw', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.js': 'x' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('a.js');
  await settle();

  const editor = harness.fakeMonaco.__editors[0];
  const focusCallsBefore = editor.focusCalls;
  let focusCallsAtRun = -1;
  editor.getAction = (id) => ({
    id,
    run() {
      focusCallsAtRun = editor.focusCalls;
      throw new Error('Quick input service needs a focused editor to work.');
    },
  });

  const items = Object.fromEntries(
    harness.controller.getIdeCommandItems().map((item) => [item.id, item])
  );
  assert.doesNotThrow(() => items['ide:go-to-symbol'].run());
  assert.ok(
    focusCallsAtRun > focusCallsBefore,
    'the editor was focused before the action ran'
  );
});
