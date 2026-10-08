'use strict';

/**
 * tests/renderer-ide-editor-host-diff-reveal.test.js
 *
 * Owner dev-profile report (2026-10-05): a suggested change deep inside a
 * minified line sat off-screen to the right of the diff tab, and the IDE's
 * word-wrap toggle never reached the diff editor. The diff tab now scrolls its
 * first changed character into view once Monaco has computed the diff, and
 * wrap reaches the diff editor at creation and live.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeEditorHost } = require('../renderer/features/renderer-ide-editor-host');

function makeFakeMonaco() {
  const calls = { reveal: [], diffOptions: [], created: [] };
  let diffListener = null;
  const diffEditor = {
    model: null,
    lineChanges: null,
    setModel(next) { this.model = next; },
    getModel() { return this.model; },
    onDidUpdateDiff(listener) {
      diffListener = listener;
      return { dispose() { if (diffListener === listener) diffListener = null; } };
    },
    getLineChanges() { return this.lineChanges; },
    getModifiedEditor: () => ({ revealPositionInCenter: (position) => calls.reveal.push(position), updateOptions() {} }),
    getOriginalEditor: () => ({ updateOptions() {} }),
    updateOptions(options) { calls.diffOptions.push(options); },
    layout() {},
    dispose() { this.model = null; },
  };
  const api = {
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
    Uri: { parse: (value) => ({ toString: () => String(value) }) },
    editor: {
      create: () => ({
        addCommand() {}, onDidChangeModelContent() {}, setModel() {}, saveViewState: () => null,
        restoreViewState() {}, updateOptions() {}, dispose() {},
      }),
      createDiffEditor: (_el, options) => { calls.created.push(options); return diffEditor; },
      getModel: () => null,
      createModel: (text) => ({
        value: String(text ?? ''), getValue() { return this.value; }, setValue(v) { this.value = v; },
        getAlternativeVersionId: () => 1, getLanguageId: () => 'javascript', dispose() {},
      }),
      onDidChangeMarkers: () => ({ dispose() {} }),
    },
  };
  return { api, calls, diffEditor, fireDiffUpdated: () => diffListener?.(), hasListener: () => diffListener !== null };
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
  });
  return { host, fake, dom };
}

test('the diff tab scrolls its first changed character into view once the diff is computed', async (t) => {
  const { host, fake } = makeHost();
  t.after(() => host.dispose());

  await host.openDiffDocument({ id: 'diff://suggestion/s1', languagePath: 'game.html',
    original: `${'a'.repeat(5000)}x`, modified: `${'a'.repeat(5000)}y` });
  host.activateDocument('diff://suggestion/s1');

  assert.ok(fake.hasListener(), 'the reveal waits for Monaco to compute the diff');
  assert.deepEqual(fake.calls.reveal, [], 'nothing is revealed before the diff exists');
  fake.diffEditor.lineChanges = [{ originalStartLineNumber: 1, modifiedStartLineNumber: 1,
    charChanges: [{ originalStartLineNumber: 1, originalStartColumn: 5001, modifiedStartLineNumber: 1, modifiedStartColumn: 5001 }] }];
  fake.fireDiffUpdated();
  assert.deepEqual(fake.calls.reveal, [{ lineNumber: 1, column: 5001 }]);
  assert.equal(fake.hasListener(), false, 'one reveal per activation');
  fake.fireDiffUpdated();
  assert.equal(fake.calls.reveal.length, 1, 'a later recompute never yanks the view back');
});

test('a line change without character detail reveals its first line, and an identical pair reveals nothing', async (t) => {
  const { host, fake } = makeHost();
  t.after(() => host.dispose());

  await host.openDiffDocument({ id: 'diff://a.js', languagePath: 'a.js', original: 'x\ny\nz', modified: 'x\nq\nz' });
  host.activateDocument('diff://a.js');
  fake.diffEditor.lineChanges = [{ originalStartLineNumber: 3, modifiedStartLineNumber: 2 }];
  fake.fireDiffUpdated();
  assert.deepEqual(fake.calls.reveal, [{ lineNumber: 2, column: 1 }]);

  await host.openDiffDocument({ id: 'diff://b.js', languagePath: 'b.js', original: 'same', modified: 'same' });
  host.activateDocument('diff://b.js');
  fake.diffEditor.lineChanges = [];
  fake.fireDiffUpdated();
  assert.equal(fake.calls.reveal.length, 1, 'no change, no reveal');
});

// Live recheck 2026-10-06: on a one-line 71 KB file the original pane wrapped
// taller than the modified pane, and the shared scroll height left it showing
// another part of the line. Monaco syncs the panes, so no reveal can align
// them; a minified side renders inline instead.
test('a minified side renders the diff inline; an ordinary diff stays side by side', async (t) => {
  const { host, fake } = makeHost();
  t.after(() => host.dispose());

  const minified = `<html>${'<div class="x"></div>'.repeat(3000)}</html>`;
  await host.openDiffDocument({ id: 'diff://suggestion/min', languagePath: 'min.html',
    original: minified, modified: minified.replace('</html>', '<footer></footer></html>') });
  host.activateDocument('diff://suggestion/min');
  assert.deepEqual(fake.calls.diffOptions.at(-1), { renderSideBySide: false });

  await host.openDiffDocument({ id: 'diff://a.js', languagePath: 'a.js', original: 'x\ny\nz', modified: 'x\nq\nz' });
  host.activateDocument('diff://a.js');
  assert.deepEqual(fake.calls.diffOptions.at(-1), { renderSideBySide: true });
  // Re-activating the minified document switches back to inline.
  host.activateDocument('diff://suggestion/min');
  assert.deepEqual(fake.calls.diffOptions.at(-1), { renderSideBySide: false });
});

test('the word-wrap toggle reaches the diff editor at creation and live', async (t) => {
  const { host, fake } = makeHost();
  t.after(() => host.dispose());

  host.setWordWrap('on');
  await host.openDiffDocument({ id: 'diff://a.js', languagePath: 'a.js', original: 'x', modified: 'y' });
  host.activateDocument('diff://a.js');
  assert.equal(fake.calls.created[0].wordWrap, 'on', 'a diff editor created under wrap starts wrapped');

  host.setWordWrap('off');
  assert.deepEqual(fake.calls.diffOptions.at(-1), { wordWrap: 'off' });
  host.setEditorOptions({ wordWrap: 'on' });
  assert.deepEqual(fake.calls.diffOptions.at(-1), { wordWrap: 'on' });
});
