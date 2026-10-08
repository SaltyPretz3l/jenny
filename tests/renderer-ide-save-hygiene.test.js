'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createIdeEditorHost } = require('../renderer/features/renderer-ide-editor-host');
const monacoUtils = require('../renderer/features/renderer-monaco-editor-utils');

const {
  computeTrimEdits,
  computeFinalNewlineEdit,
  createIdeSaveHygiene,
} = require('../renderer/features/renderer-ide-save-hygiene');

// Monaco represents a file ending in a newline as a trailing EMPTY last line,
// e.g. "abc\n" -> ['abc', '']. The fake mirrors that so the helpers see the same
// shape the real model would.
function fakeModel(lines, { eol = '\n' } = {}) {
  const batches = [];
  return {
    getLineCount: () => lines.length,
    getLineContent: (n) => lines[n - 1],
    getEOL: () => eol,
    pushEditOperations: (_selections, edits) => { batches.push(edits); },
    _batches: batches,
  };
}

function fakeHost(model, { activePath = 'a.js', large = false } = {}) {
  const calls = { formatPath: 0 };
  return {
    getModel: () => model,
    getActivePath: () => activePath,
    isLargeFile: () => large,
    showsPath: (path) => path === activePath,
    formatPath: () => { calls.formatPath += 1; return Promise.resolve({ supported: true, formatted: true }); },
    _calls: calls,
  };
}

test('group follow-up: save hygiene formats the path in its group editor', async (t) => {
  const dom = new JSDOM('<div id="primary"></div><div id="secondary"></div>');
  const editors = [];
  const formatted = [];
  const api = {
    KeyMod: { CtrlCmd: 2048 }, KeyCode: { KeyS: 49 }, Uri: { parse: (uri) => uri },
    editor: {
      create() {
        const editor = {
          model: null, setModel(model) { this.model = model; }, getModel() { return this.model; },
          addCommand() {}, onDidChangeModelContent() {}, saveViewState: () => null,
          getAction(id) {
            assert.equal(id, 'editor.action.formatDocument');
            return { run: async () => { formatted.push(editor.model); } };
          },
        };
        editors.push(editor);
        return editor;
      },
      createModel(text) { return { ...fakeModel([text]), getValue: () => text, getAlternativeVersionId: () => 1, dispose() {} }; },
    },
  };
  const host = createIdeEditorHost({
    getDom: () => ({ ideEditorHost: dom.window.document.getElementById('primary') }),
    monacoUtils: { ...monacoUtils, ensureMonacoEditorApi: async () => api },
  });
  t.after(() => { host.dispose(); dom.window.close(); });
  for (const path of ['primary.js', 'group.js', 'hidden.js']) await host.openDocument({ path, content: 'x  ' });
  host.activateDocument('primary.js');
  const group = host.createGroupEditor(dom.window.document.getElementById('secondary'));
  group.setModel(host.getModel('group.js'));
  const hygiene = createIdeSaveHygiene({
    editorHost: host, getIde: () => ({ formatOnSave: true, trimTrailingWhitespace: true }),
  });
  t.after(() => hygiene.dispose());
  assert.deepEqual(await hygiene.applySaveHygiene('group.js'), { formatStatus: 'formatted', formatReason: '' });
  assert.deepEqual(formatted, [host.getModel('group.js')]);
  assert.equal(host.getModel('group.js')._batches.length, 1);
  assert.equal(host.getActivePath(), 'primary.js');
  assert.equal(editors[0].getModel(), host.getModel('primary.js'));
  assert.deepEqual(await host.formatPath('primary.js'), { supported: true, formatted: true });
  assert.deepEqual(await host.formatActive(), { supported: true, formatted: true });
  assert.deepEqual(hygiene.applySaveHygiene('hidden.js'), { formatStatus: 'skipped', formatReason: 'inactive_file' });
  assert.equal(host.getModel('hidden.js')._batches.length, 1);
  assert.deepEqual(await host.formatPath('missing.js'), { supported: false, formatted: false });
  group.getAction = () => null;
  assert.deepEqual(await host.formatPath('group.js'), { supported: false, formatted: false });
  host.releaseGroupEditor(group);
  assert.deepEqual(await host.formatPath('group.js'), { supported: false, formatted: false });
});

test('computeTrimEdits emits one edit per line with trailing whitespace, none when clean', () => {
  assert.deepEqual(computeTrimEdits(fakeModel(['clean', 'a', ''])), []);
  const edits = computeTrimEdits(fakeModel(['trail   ', 'tab\t', 'ok']));
  assert.equal(edits.length, 2);
  // 'trail   ' -> delete columns 6..9 (the three trailing spaces).
  assert.deepEqual(edits[0].range, { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 9 });
  assert.equal(edits[0].text, '');
});

test('computeFinalNewlineEdit appends EOL only when the file lacks a trailing newline', () => {
  // 'abc\n' -> ['abc',''] -> already ends with a newline -> no edit.
  assert.equal(computeFinalNewlineEdit(fakeModel(['abc', ''])), null);
  // 'abc' (no trailing newline) -> append one EOL after column 4 of line 1.
  const edit = computeFinalNewlineEdit(fakeModel(['abc'], { eol: '\r\n' }));
  assert.deepEqual(edit.range, { startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 4 });
  assert.equal(edit.text, '\r\n');
});

test('applySaveHygiene is a no-op when every flag is off (never touches the model)', async () => {
  let getModelCalls = 0;
  const host = { getModel: () => { getModelCalls += 1; return fakeModel(['x  ']); } };
  const hygiene = createIdeSaveHygiene({ editorHost: host, getIde: () => ({}) });
  await hygiene.applySaveHygiene('a.js');
  assert.equal(getModelCalls, 0);
});

test('applySaveHygiene applies trim then final-newline as two separate edit batches', async () => {
  const model = fakeModel(['line  ']); // trailing spaces + no final newline
  const host = fakeHost(model);
  const hygiene = createIdeSaveHygiene({
    editorHost: host,
    getIde: () => ({ trimTrailingWhitespace: true, insertFinalNewline: true }),
  });
  await hygiene.applySaveHygiene('a.js');
  assert.equal(model._batches.length, 2, 'trim and final-newline are pushed as distinct batches');
  assert.equal(host._calls.formatPath, 0, 'format not run unless enabled');
});

test('applySaveHygiene formats only a path an editor shows', async () => {
  const activeHost = fakeHost(fakeModel(['x']), { activePath: 'a.js' });
  await createIdeSaveHygiene({ editorHost: activeHost, getIde: () => ({ formatOnSave: true }) })
    .applySaveHygiene('a.js');
  assert.equal(activeHost._calls.formatPath, 1, 'format runs when path is active');

  const inactiveHost = fakeHost(fakeModel(['x']), { activePath: 'other.js' });
  const outcome = createIdeSaveHygiene({ editorHost: inactiveHost, getIde: () => ({ formatOnSave: true }) })
    .applySaveHygiene('a.js');
  assert.deepEqual(outcome, { formatStatus: 'skipped', formatReason: 'inactive_file' }, 'an unshown save stays synchronous');
  assert.equal(inactiveHost._calls.formatPath, 0, 'format skipped for an unshown save');
});

test('applySaveHygiene skips format + trim on large files but still adds the final newline', async () => {
  const model = fakeModel(['big  ']); // trailing ws + no newline
  const host = fakeHost(model, { large: true });
  await createIdeSaveHygiene({
    editorHost: host,
    getIde: () => ({ formatOnSave: true, trimTrailingWhitespace: true, insertFinalNewline: true }),
  }).applySaveHygiene('a.js');
  assert.equal(host._calls.formatPath, 0, 'format skipped on large files');
  assert.equal(model._batches.length, 1, 'only the cheap final-newline edit runs');
});

test('applySaveHygiene is a safe synchronous no-op on the textarea fallback (no model)', () => {
  const host = { getModel: () => null, getActivePath: () => 'a.js', isLargeFile: () => false };
  const hygiene = createIdeSaveHygiene({ editorHost: host, getIde: () => ({ trimTrailingWhitespace: true, insertFinalNewline: true }) });
  // No format -> fully synchronous (so the save path never yields before its
  // snapshot) and never throws.
  let result;
  assert.doesNotThrow(() => { result = hygiene.applySaveHygiene('a.js'); });
  assert.deepEqual(result, { formatStatus: 'disabled', formatReason: '' });
});

test('format-on-save reports unavailable when the host has no model or formatter', () => {
  const host = { getModel: () => null, getActivePath: () => 'a.js', isLargeFile: () => false };
  const hygiene = createIdeSaveHygiene({
    editorHost: host,
    getIde: () => ({ formatOnSave: true, trimTrailingWhitespace: true }),
  });

  const result = hygiene.applySaveHygiene('a.js');

  assert.deepEqual(result, { formatStatus: 'unavailable', formatReason: 'formatter_unavailable' });
  assert.equal(result instanceof Promise, false, 'the unsupported fallback does not enter the async format branch');
});

test('applySaveHygiene stays synchronous when format-on-save is off', () => {
  const model = fakeModel(['x  ']);
  const host = fakeHost(model);
  const hygiene = createIdeSaveHygiene({ editorHost: host, getIde: () => ({ trimTrailingWhitespace: true }) });
  // The sync return is load-bearing: it keeps saveFile's content snapshot
  // synchronous relative to live edits (the mid-write-stays-dirty guarantee).
  assert.deepEqual(hygiene.applySaveHygiene('a.js'), { formatStatus: 'disabled', formatReason: '' });
  assert.equal(model._batches.length, 1, 'trim still applied synchronously');
});

test('applySaveHygiene reports formatter failure without rejecting the safe-save path', async () => {
  const model = fakeModel(['const x=1']);
  const host = fakeHost(model);
  host.formatPath = async () => { throw new Error('formatter unavailable'); };
  const logs = [];
  const outcome = await createIdeSaveHygiene({
    editorHost: host,
    getIde: () => ({ formatOnSave: true }),
    appendClientLog: (level, event) => logs.push({ level, event }),
  }).applySaveHygiene('a.js');
  assert.deepEqual(outcome, { formatStatus: 'failed', formatReason: 'formatter_failed' });
  assert.equal(logs.at(-1).event, 'ide.format_on_save_failed');
});

test('a delayed formatter cannot edit a replacement model or continue after dispose', async () => {
  async function runScenario({ dispose }) {
    const original = fakeModel(['old  ']);
    const replacement = fakeModel(['new  ']);
    let current = original;
    let resolveFormat;
    const host = {
      getModel: () => current,
      getActivePath: () => 'same.js',
      showsPath: () => true,
      isLargeFile: () => false,
      formatPath: () => new Promise((resolve) => { resolveFormat = resolve; }),
    };
    const hygiene = createIdeSaveHygiene({
      editorHost: host,
      getIde: () => ({ formatOnSave: true, trimTrailingWhitespace: true }),
    });
    const pending = hygiene.applySaveHygiene('same.js');
    await Promise.resolve();
    current = replacement;
    if (dispose) hygiene.dispose();
    resolveFormat({ supported: true });
    await pending;
    return { original, replacement };
  }

  const swapped = await runScenario({ dispose: false });
  assert.equal(swapped.replacement._batches.length, 0, 'model identity change invalidates the continuation');
  const disposed = await runScenario({ dispose: true });
  assert.equal(disposed.replacement._batches.length, 0, 'dispose invalidates the continuation');
});
