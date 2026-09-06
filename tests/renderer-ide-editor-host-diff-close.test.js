'use strict';

/* Editor-host diff-model detach on close (CMP-RENDER-0001): Monaco 0.52
 * hard-asserts ("TextModel got disposed before DiffEditorWidget model got
 * reset") when a TextModel is disposed while still attached to the reused
 * DiffEditorWidget. Switching away from a diff tab only hides the pane and
 * leaves the models attached, so closeDocument (and dispose) must detach by
 * model identity before disposing. Driven with a minimal fake Monaco whose
 * models reproduce the 0.52 assert (mirrors
 * renderer-ide-editor-host-eol.test.js). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { createIdeEditorHost } = require('../renderer/features/renderer-ide-editor-host');

function makeFakeMonaco() {
  let diffEditorInstance = null;
  const models = [];
  function makeModel(text) {
    const model = {
      value: String(text ?? ''),
      disposed: false,
      getValue() { return this.value; },
      setValue(v) { this.value = v; },
      getAlternativeVersionId: () => 1,
      getLanguageId: () => 'javascript',
      dispose() {
        const attached = diffEditorInstance ? diffEditorInstance.model : null;
        if (attached && (attached.original === this || attached.modified === this)) {
          throw new Error('TextModel got disposed before DiffEditorWidget model got reset');
        }
        this.disposed = true;
      },
    };
    models.push(model);
    return model;
  }
  const api = {
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
    Uri: { parse: (value) => ({ toString: () => String(value) }) },
    editor: {
      create: () => ({
        addCommand() {},
        onDidChangeModelContent() {},
        setModel() {},
        saveViewState: () => null,
        restoreViewState() {},
        updateOptions() {},
        dispose() {},
      }),
      createDiffEditor: () => {
        diffEditorInstance = {
          model: null,
          setModel(next) { this.model = next; },
          getModel() { return this.model; },
          layout() {},
          dispose() { this.model = null; },
        };
        return diffEditorInstance;
      },
      getModel: () => null,
      createModel: (text) => makeModel(text),
      onDidChangeMarkers: () => ({ dispose() {} }),
    },
  };
  return { api, models, getDiffEditor: () => diffEditorInstance };
}

function makeHost() {
  const dom = new JSDOM('<!doctype html><body><div id="ideEditorHost"></div></body>');
  const fake = makeFakeMonaco();
  const host = createIdeEditorHost({
    getDom: () => ({ ideEditorHost: dom.window.document.getElementById('ideEditorHost') }),
    monacoUtils: {
      ...require('../renderer/features/renderer-monaco-editor-utils'),
      ensureMonacoEditorApi: async () => fake.api,
      normalizeEditorLanguage: () => 'javascript',
    },
    imageHostUtils: {},
    previewHostUtils: {},
  });
  return { host, fake, dom };
}

test('closing a non-active diff tab detaches its models before disposing (CMP-RENDER-0001)', async (t) => {
  const { host, fake } = makeHost();
  t.after(() => host.dispose());

  await host.openDiffDocument({ id: 'diff://notes.md', languagePath: 'notes.md', original: 'old', modified: 'new' });
  host.activateDocument('diff://notes.md');
  const diffEditor = fake.getDiffEditor();
  assert.ok(diffEditor?.model, 'diff models are attached after activation');

  // Switch to a regular file tab: the pane hides but the diff editor keeps
  // holding the diff doc's models (the CMP-RENDER-0001 setup).
  await host.openDocument({ path: 'notes.md', content: 'new' });
  host.activateDocument('notes.md');
  assert.ok(diffEditor.model, 'switching away leaves the models attached');

  // Closing the now-non-active diff tab must not throw the Monaco assert.
  host.closeDocument('diff://notes.md');
  assert.equal(diffEditor.model, null, 'close detaches the diff editor model');
  assert.ok(fake.models.some((m) => m.disposed), 'diff models were still disposed');
});

test('closing the active diff tab detaches and disposes cleanly', async (t) => {
  const { host, fake } = makeHost();
  t.after(() => host.dispose());

  await host.openDiffDocument({ id: 'diff://a.js', languagePath: 'a.js', original: 'x', modified: 'y' });
  host.activateDocument('diff://a.js');
  host.closeDocument('diff://a.js');
  assert.equal(fake.getDiffEditor().model, null);
  assert.ok(fake.models.every((m) => m.disposed), 'both diff models disposed');
});

test('closing one diff tab leaves another attached diff untouched', async (t) => {
  const { host, fake } = makeHost();
  t.after(() => host.dispose());

  await host.openDiffDocument({ id: 'diff://a.js', languagePath: 'a.js', original: 'a1', modified: 'a2' });
  host.activateDocument('diff://a.js');
  await host.openDiffDocument({ id: 'diff://b.js', languagePath: 'b.js', original: 'b1', modified: 'b2' });
  host.activateDocument('diff://b.js');

  const diffEditor = fake.getDiffEditor();
  const attachedBeforeClose = diffEditor.model;
  assert.ok(attachedBeforeClose, 'second diff attached');

  // Closing the first (detached) diff must not blank the second diff's view.
  host.closeDocument('diff://a.js');
  assert.equal(diffEditor.model, attachedBeforeClose, 'active diff stays attached');
});

test('host dispose with an attached diff doc does not hit the Monaco assert', async (t) => {
  const { host } = makeHost();
  let disposed = false;
  t.after(() => { if (!disposed) host.dispose(); });

  await host.openDiffDocument({ id: 'diff://c.js', languagePath: 'c.js', original: '1', modified: '2' });
  host.activateDocument('diff://c.js');
  host.dispose();
  disposed = true;
});

test('diff placeholder follows word wrap and remains selectable', async (t) => {
  const { host, dom } = makeHost();
  t.after(() => host.dispose());

  await host.openDiffDocument({ id: 'diff://missing.js', placeholderText: 'Original unavailable' });
  host.setWordWrap('off');
  host.activateDocument('diff://missing.js');
  const placeholder = dom.window.document.querySelector('.ide-diff-placeholder');
  assert.equal(placeholder.classList.contains('nowrap'), true, 'activation honors wrap off');
  host.setWordWrap('on');
  assert.equal(placeholder.classList.contains('nowrap'), false);
  host.setWordWrap('off');
  assert.equal(placeholder.classList.contains('nowrap'), true);
  host.setEditorOptions({ wordWrap: 'on' });
  assert.equal(placeholder.classList.contains('nowrap'), false, 'persisted preference apply updates placeholder');

  const css = fs.readFileSync(path.join(__dirname, '../styles/ide-view.css'), 'utf8');
  const rule = css.match(/\.ide-diff-placeholder\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(rule, /^\s*user-select:\s*text;/m);
});
