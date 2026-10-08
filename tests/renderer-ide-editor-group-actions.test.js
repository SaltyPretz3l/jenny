'use strict';

/* Jenny's editor actions in secondary editor groups (W5 follow-up): every
 * descriptor contributed through editorHost.addEditorAction also lands on each
 * group editor (existing or created later), and a run from a group editor reads
 * THAT editor's path, selection and cursor through the host's active-editor
 * readers. Drives the real host, group view and selection intents over a fake
 * Monaco whose editors record addAction per instance. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeEditorHost } = require('../renderer/features/renderer-ide-editor-host');
const { createIdeEditorGroupView } = require('../renderer/features/renderer-ide-editor-group-view');
const { createIdeSelectionIntents } = require('../renderer/features/renderer-ide-selection-intents');
const monacoUtils = require('../renderer/features/renderer-monaco-editor-utils');
const { escapeHtml } = require('../renderer/shared/string-utils');

function selection(startLineNumber, endLineNumber) {
  return { startLineNumber, endLineNumber, isEmpty: () => false };
}

function makeFakeMonaco() {
  const editors = [];
  const api = {
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
    Uri: { parse: (value) => ({ toString: () => String(value) }) },
    editor: {
      create(el) {
        const editor = {
          el, model: null, actions: [], selection: null, position: { lineNumber: 1, column: 1 }, disposed: false,
          addCommand() {},
          addAction(descriptor) {
            const registration = { descriptor, disposed: false, dispose() { registration.disposed = true; } };
            editor.actions.push(registration);
            return registration;
          },
          liveActionIds: () => editor.actions.filter((r) => !r.disposed).map((r) => r.descriptor.id),
          runAction(id) { return [...editor.actions].reverse().find((r) => !r.disposed && r.descriptor.id === id).descriptor.run(editor); },
          onDidChangeModelContent: () => ({ dispose() {} }),
          onDidFocusEditorWidget: () => ({ dispose() {} }),
          onDidChangeCursorSelection: () => ({ dispose() {} }),
          onMouseDown: () => ({ dispose() {} }),
          getModel: () => editor.model,
          setModel(model) { editor.model = model; },
          getSelection: () => editor.selection,
          getPosition: () => editor.position,
          saveViewState: () => null,
          restoreViewState() {},
          updateOptions() {},
          layout() {},
          focus() {},
          dispose() { editor.disposed = true; },
        };
        editors.push(editor);
        return editor;
      },
      getModel: () => null,
      createModel(text, language) {
        const model = {
          text, language, altId: 1,
          setValue(next) { model.text = next; },
          getValue: () => model.text,
          getAlternativeVersionId: () => model.altId,
          getLanguageId: () => model.language,
          getValueInRange: (range) => model.text.split('\n').slice(range.startLineNumber - 1, range.endLineNumber).join('\n'),
          dispose() {},
        };
        return model;
      },
      onDidChangeMarkers: () => ({ dispose() {} }),
      getModelMarkers: () => [],
    },
  };
  return { api, editors };
}

const A_TEXT = 'a1\na2\na3\na4';
const B_TEXT = 'b1\nb2\nb3\nb4\nb5\nb6';

async function makeRig({ gitClient = null } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="ideEditorHost"></div><div id="root"></div></body>');
  const document = dom.window.document;
  const fake = makeFakeMonaco();
  const sent = [];
  let intents = null;
  const host = createIdeEditorHost({
    getDom: () => ({ ideEditorHost: document.getElementById('ideEditorHost') }),
    monacoUtils: {
      ...monacoUtils,
      ensureMonacoEditorApi: async () => fake.api,
      registerMonacoFontConsumer: () => () => {},
    },
    imageHostUtils: {},
    onMonacoReady: () => intents.registerActions(),
  });
  intents = createIdeSelectionIntents({ editorHost: host, onSendToJenny: (payload) => sent.push(payload), gitClient });
  await host.openDocument({ path: 'a.js', content: A_TEXT });
  await host.openDocument({ path: 'b.py', content: B_TEXT });
  host.activateDocument('a.js');
  const primary = fake.editors[0];
  primary.selection = selection(1, 2);
  const groupState = { tabs: [{ path: 'b.py', kind: 'file' }], active: 'b.py' };
  const makeGroup = () => {
    const view = createIdeEditorGroupView({
      groupId: 'editor-2', groupNumber: 2, document, editorHost: host, escapeHtml,
      getTabs: () => groupState.tabs, getActive: () => groupState.active,
    });
    document.getElementById('root').appendChild(view.el);
    view.render();
    return { view, editor: fake.editors.at(-1) };
  };
  return { host, fake, primary, sent, intents, makeGroup };
}

test('actions registered on the host appear on a group editor created after registration', async () => {
  const { host, primary, makeGroup } = await makeRig();
  const { view, editor } = makeGroup();
  assert.notEqual(editor, primary);
  assert.ok(primary.liveActionIds().includes('jenny.send-selection.current'));
  assert.deepEqual(editor.liveActionIds(), primary.liveActionIds(), 'the group editor carries every Jenny action');
  view.dispose();
  host.dispose();
});

test('an action registered after a group exists reaches the group editor and the primary', async () => {
  const { host, primary, makeGroup } = await makeRig();
  const { view, editor } = makeGroup();
  host.addEditorAction({ id: 'test.late', label: 'Late', run: () => host.getActivePath() });
  assert.ok(editor.liveActionIds().includes('test.late'));
  assert.ok(primary.liveActionIds().includes('test.late'));
  assert.equal(editor.runAction('test.late'), 'b.py', 'a group run reads the group path');
  assert.equal(primary.runAction('test.late'), 'a.js', 'a primary run reads the primary path');
  view.dispose();
  host.dispose();
});

test('Send to Jenny from a group editor sends that editor path and selection; the primary keeps its own', async () => {
  const { host, primary, sent, makeGroup } = await makeRig();
  const { view, editor } = makeGroup();
  editor.selection = selection(4, 6);
  editor.runAction('jenny.send-selection.current');
  assert.deepEqual(sent.at(-1), {
    kind: 'code_selection', target: 'current', code: 'b4\nb5\nb6', path: 'b.py', language: 'python', startLine: 4, endLine: 6,
  });
  assert.equal(host.getActivePath(), 'a.js', 'the action context is restored after the run');
  assert.equal(host.getSelectedText(), 'a1\na2');
  primary.runAction('jenny.send-selection.new');
  assert.deepEqual(sent.at(-1), {
    kind: 'code_selection', target: 'new', code: 'a1\na2', path: 'a.js', language: 'javascript', startLine: 1, endLine: 2,
  });
  view.dispose();
  host.dispose();
});

test('the action context is restored when a group run throws', async () => {
  const { host, makeGroup } = await makeRig();
  const { view, editor } = makeGroup();
  host.addEditorAction({ id: 'test.throws', label: 'Throws', run: () => { throw new Error('boom'); } });
  assert.throws(() => editor.runAction('test.throws'), /boom/);
  assert.equal(host.getActivePath(), 'a.js');
  view.dispose();
  host.dispose();
});

test('squiggle-fix from a group editor reads that editor cursor', async () => {
  const { host, primary, sent, makeGroup } = await makeRig();
  const { view, editor } = makeGroup();
  host.getMarkers = () => [
    { path: 'a.js', severity: 'error', message: 'primary problem', line: 1, column: 1, source: 'ts', code: '' },
    { path: 'b.py', severity: 'error', message: 'group problem', line: 5, column: 1, source: 'ts', code: '' },
  ];
  primary.position = { lineNumber: 1, column: 1 };
  editor.position = { lineNumber: 5, column: 2 };
  editor.runAction('jenny.selection.fix-squiggle');
  assert.equal(sent.at(-1).path, 'b.py');
  assert.match(sent.at(-1).intent, /group problem/);
  assert.equal(host.getCursorInfo().lineNumber, 1, 'outside the run the cursor is the primary one');
  view.dispose();
  host.dispose();
});

test('Who changed this from a group editor keeps the group language across the blame await', async () => {
  let release;
  const gitClient = { blameRange: (args) => new Promise((resolve) => { release = () => resolve({ ok: true, found: true, args, lines: [{ line: 2, sha: 'a'.repeat(40), shortSha: 'aaaaaaa', author: 'Jane', dateISO: '2026-06-10T12:00:00.000Z', summary: 'Add b' }] }); }) };
  const { host, sent, makeGroup } = await makeRig({ gitClient });
  const { view, editor } = makeGroup();
  editor.selection = selection(2, 3);
  const pending = editor.runAction('jenny.selection.blame');
  release();
  assert.equal(await pending, true);
  assert.equal(sent.at(-1).path, 'b.py');
  assert.equal(sent.at(-1).code, 'b2\nb3');
  assert.equal(sent.at(-1).language, 'python', 'read before the await, not from the primary afterwards');
  view.dispose();
  host.dispose();
});

test('disposing the group view disposes its action registrations', async () => {
  const { host, primary, makeGroup } = await makeRig();
  const { view, editor } = makeGroup();
  const registrations = [...editor.actions];
  assert.ok(registrations.length > 0);
  view.dispose();
  assert.equal(editor.disposed, true);
  assert.ok(registrations.every((r) => r.disposed), 'every group registration is disposed');
  host.addEditorAction({ id: 'test.after', label: 'After', run() {} });
  assert.equal(editor.actions.length, registrations.length, 'a released editor gets no new actions');
  assert.ok(primary.liveActionIds().includes('test.after'));
  host.dispose();
});
