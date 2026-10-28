'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createIdeEditorGroupView } = require('../renderer/features/renderer-ide-editor-group-view');

function rig() {
  const window = new JSDOM('<div></div>').window;
  const original = { id: 'o' };
  const modified = { id: 'm' };
  let surface = { original, modified, placeholderText: '', inlineDiff: false };
  const calls = { updateOptions: 0, setModel: 0, subscribe: 0, layout: 0 };
  const diffEditor = {
    model: null,
    updateOptions() { calls.updateOptions += 1; },
    setModel(m) { calls.setModel += 1; this.model = m; },
    getModel() { return this.model; },
    onDidUpdateDiff() { calls.subscribe += 1; return { dispose() {} }; },
    layout() { calls.layout += 1; },
    getModifiedEditor: () => ({}),
  };
  const view = createIdeEditorGroupView({
    groupId: 'editor-2', groupNumber: 2, document: window.document,
    escapeHtml: (s) => String(s),
    editorHost: {
      getDocumentKind: (p) => (p.startsWith('diff://') ? 'diff' : 'file'),
      getDiffSurface: () => ({ ...surface }), // a fresh object per call, as the host returns
      createGroupDiffEditor: () => diffEditor,
      releaseGroupDiffEditor() {},
      getModel: () => null,
    },
    getTabs: () => [{ path: 'diff://change/a' }],
    getActive: () => 'diff://change/a',
  });
  return { window, view, calls, setSurface: (next) => { surface = { ...surface, ...next }; } };
}

test('re-rendering a group whose active tab is the same diff does not re-apply options or models', (t) => {
  const r = rig();
  t.after(() => { r.view.dispose(); r.window.close(); });
  r.view.render();
  assert.deepEqual(r.calls, { updateOptions: 1, setModel: 1, subscribe: 1, layout: 1 });
  r.view.render();
  r.view.render();
  assert.deepEqual(r.calls, { updateOptions: 1, setModel: 1, subscribe: 1, layout: 1 }, 'same diff -> early return');
  r.setSurface({ inlineDiff: true });
  r.view.render();
  assert.equal(r.calls.updateOptions, 2, 'an inline/side-by-side flip still applies');
  assert.equal(r.calls.setModel, 1, 'same models are not re-attached');
});
