'use strict';

/* "Send to Jenny" (W1 of the IDE polish wave): prefill-text building, the
 * composer-prefill flow in renderer-ide-send-utils, the tab/tree context-menu
 * entries, and the editor host's fallback selection accessors. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  buildSendToJennyText,
  createIdeSendToJenny,
} = require('../renderer/features/renderer-ide-send-utils');
const { createIdeEditorHost } = require('../renderer/features/renderer-ide-editor-host');
const {
  createHarness,
  findMenuItem,
  openContextMenu,
  settle,
} = require('./helpers/renderer-ide-harness');

test('buildSendToJennyText formats code selections as fenced blocks', () => {
  const text = buildSendToJennyText({
    kind: 'code_selection',
    code: 'const a = 1;\nconst b = 2;',
    path: 'src/util.js',
    language: 'javascript',
    startLine: 4,
    endLine: 5,
  });
  assert.equal(text, '`src/util.js` (lines 4-5):\n```javascript\nconst a = 1;\nconst b = 2;\n```\n');
});

test('buildSendToJennyText single-line label, plaintext language, fence escalation', () => {
  const single = buildSendToJennyText({
    kind: 'code_selection', code: 'x', path: 'a.txt', language: 'plaintext', startLine: 7, endLine: 7,
  });
  assert.match(single, /\(line 7\):\n```\nx\n```\n/);
  // Embedded triple backticks must not terminate the fence early.
  const nested = buildSendToJennyText({
    kind: 'code_selection', code: '```js\nhi\n```', path: 'doc.md', language: 'markdown', startLine: 1, endLine: 3,
  });
  assert.match(nested, /^`doc\.md` \(lines 1-3\):\n````markdown\n/);
  assert.match(nested, /\n````\n$/);
});

test('buildSendToJennyText file_path form and empty-input guards', () => {
  assert.equal(buildSendToJennyText({ kind: 'file_path', path: 'renderer/app.js' }), '`renderer/app.js` ');
  assert.equal(buildSendToJennyText({ kind: 'code_selection', code: '   ', path: 'a.js' }), '');
  assert.equal(buildSendToJennyText({ kind: 'file_path', path: '' }), '');
  assert.equal(buildSendToJennyText(null), '');
});

test('buildSendToJennyText file_map_query prefills the question + fenced summary before the path guard', () => {
  const text = buildSendToJennyText({
    kind: 'file_map_query',
    question: 'What are the main entry points?',
    summary: 'Project: 3 files, 2 edges.',
  });
  assert.equal(
    text,
    'What are the main entry points?\n\nWorkspace file map summary:\n```\nProject: 3 files, 2 edges.\n```\n'
  );
  // No `path` field at all — the file_map_query branch must run BEFORE the
  // path guard, since a map query has no associated file path.
  assert.equal(typeof text, 'string');
});

test('buildSendToJennyText file_map_query with an empty question returns empty (prefill-only guard)', () => {
  assert.equal(
    buildSendToJennyText({ kind: 'file_map_query', question: '   ', summary: 'anything' }),
    ''
  );
  assert.equal(
    buildSendToJennyText({ kind: 'file_map_query', summary: 'anything' }),
    ''
  );
});

function createSendFixture({ currentSessionId = 'sess-1', createdSessionId = 'sess-new' } = {}) {
  const calls = [];
  const chatInput = {
    value: '',
    focus: () => calls.push('focus'),
  };
  const state = { currentSessionId };
  const sender = createIdeSendToJenny({
    state,
    dom: { chatInput },
    callbacks: {
      handleCreateSession: async () => {
        calls.push('createSession');
        if (createdSessionId) {
          state.currentSessionId = createdSessionId;
        }
        return createdSessionId;
      },
      setActiveView: (view) => calls.push(`setActiveView:${view}`),
      syncComposerInputHeight: () => calls.push('syncHeight'),
      renderComposerState: () => calls.push('renderComposer'),
      renderAll: () => calls.push('renderAll'),
      showShellErrorToast: (message) => calls.push(`error:${message}`),
      appendClientLog: () => {},
    },
  });
  return { sender, chatInput, state, calls };
}

test('handleSendToJenny target current reuses the session and prefills the composer', async () => {
  const { sender, chatInput, calls } = createSendFixture();
  const ok = await sender.handleSendToJenny({ kind: 'file_path', target: 'current', path: 'a/b.js' });
  assert.equal(ok, true);
  assert.equal(chatInput.value, '`a/b.js` ');
  assert.ok(!calls.includes('createSession'), 'current target must not create a session');
  assert.deepEqual(calls, [
    'setActiveView:chat', 'renderAll', 'syncHeight', 'renderComposer', 'focus',
  ]);
});

test('handleSendToJenny writes to and focuses the live composer after view relocation', async () => {
  const calls = [];
  const staleInput = { value: '', focus: () => calls.push('staleFocus') };
  const liveInput = { value: '', focus: () => calls.push('liveFocus') };
  let currentInput = staleInput;
  const sender = createIdeSendToJenny({
    state: { currentSessionId: 'sess-1' },
    getChatInput: () => currentInput,
    callbacks: {
      setActiveView: (view) => calls.push(`setActiveView:${view}`),
      renderAll: () => {
        calls.push('renderAll');
        currentInput = liveInput;
      },
      syncComposerInputHeight: () => calls.push('syncHeight'),
      renderComposerState: () => calls.push('renderComposer'),
    },
  });

  const ok = await sender.handleSendToJenny({
    kind: 'file_map_query',
    question: 'Where does startup begin?',
    summary: 'Project: 4 files, 2 edges.',
  });

  assert.equal(ok, true);
  assert.equal(staleInput.value, '');
  assert.match(liveInput.value, /^Where does startup begin\?/);
  assert.ok(calls.includes('liveFocus'));
  assert.ok(!calls.includes('staleFocus'));
});

test('handleSendToJenny target new creates a session first', async () => {
  const { sender, calls } = createSendFixture();
  await sender.handleSendToJenny({ kind: 'file_path', target: 'new', path: 'a/b.js' });
  assert.equal(calls[0], 'createSession');
  assert.ok(calls.includes('setActiveView:chat'));
});

test('handleSendToJenny creates a session when none is current', async () => {
  const { sender, calls } = createSendFixture({ currentSessionId: '' });
  const ok = await sender.handleSendToJenny({ kind: 'file_path', target: 'current', path: 'a.js' });
  assert.equal(ok, true);
  assert.equal(calls[0], 'createSession');
});

test('handleSendToJenny surfaces a toast when no session can be opened', async () => {
  const { sender, chatInput, calls } = createSendFixture({ currentSessionId: '', createdSessionId: '' });
  const ok = await sender.handleSendToJenny({ kind: 'file_path', target: 'current', path: 'a.js' });
  assert.equal(ok, false);
  assert.equal(chatInput.value, '');
  assert.ok(calls.some((entry) => entry.startsWith('error:')));
});

test('handleSendToJenny target new fails closed when session creation is blank or rejects', async () => {
  for (const failure of ['blank', 'reject']) {
    const { sender, chatInput, state, calls } = createSendFixture({
      currentSessionId: 'sess-old',
      createdSessionId: '',
    });
    if (failure === 'reject') {
      sender.handleSendToJenny = createIdeSendToJenny({
        state,
        dom: { chatInput },
        callbacks: {
          handleCreateSession: async () => { throw new Error('ipc down'); },
          showShellErrorToast: (message) => calls.push(`error:${message}`),
        },
      }).handleSendToJenny;
    }
    const ok = await sender.handleSendToJenny({ kind: 'file_path', target: 'new', path: 'a.js' });
    assert.equal(ok, false, `${failure} creation must fail closed`);
    assert.equal(state.currentSessionId, 'sess-old');
    assert.equal(chatInput.value, '', 'the current composer remains untouched');
    assert.ok(calls.some((entry) => entry.startsWith('error:')), 'the existing error toast is shown');
  }
});

test('handleSendToJenny appends below an existing composer draft', async () => {
  const { sender, chatInput } = createSendFixture();
  chatInput.value = 'What does this do?  ';
  await sender.handleSendToJenny({
    kind: 'code_selection', target: 'current', code: 'let x;', path: 'a.js', language: 'javascript', startLine: 1, endLine: 1,
  });
  assert.equal(chatInput.value, 'What does this do?\n\n`a.js` (line 1):\n```javascript\nlet x;\n```\n');
});

test('tab context menu offers both Send to Jenny targets', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'src/app.js': 'console.log(1);' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('src/app.js');
  await settle();
  const tab = harness.getDom().ideTabStrip.querySelector('[data-ide-tab-path]');
  openContextMenu(harness, tab);
  const doc = harness.dom.window.document;
  const currentItem = findMenuItem(doc, 'Send to Jenny — current chat');
  const newItem = findMenuItem(doc, 'Send to Jenny — new chat');
  assert.ok(currentItem, 'current-chat item present');
  assert.ok(newItem, 'new-chat item present');
  currentItem.click();
  await settle();
  assert.deepEqual(harness.sentToJenny, [
    { kind: 'file_path', target: 'current', path: 'src/app.js' },
  ]);
});

test('tree file rows offer Send to Jenny; directories do not', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'src/app.js': 'x', 'README.md': 'hello' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const doc = harness.dom.window.document;
  const fileRow = harness.getDom().ideRailPanel
    .querySelector('[data-ide-tree-path="README.md"]');
  openContextMenu(harness, fileRow);
  const sendItem = findMenuItem(doc, 'Send to Jenny — new chat');
  assert.ok(sendItem, 'file row exposes the send item');
  sendItem.click();
  await settle();
  assert.deepEqual(harness.sentToJenny, [
    { kind: 'file_path', target: 'new', path: 'README.md' },
  ]);
  const dirRow = harness.getDom().ideRailPanel
    .querySelector('[data-ide-tree-path="src"]');
  openContextMenu(harness, dirRow);
  assert.equal(findMenuItem(doc, 'Send to Jenny — current chat'), null, 'directories have no send item');
});

test('editor host fallback selection accessors report text and line ranges', async (t) => {
  const dom = new JSDOM(`
    <div id="ideEditorHost"></div>
    <textarea id="ideEditorFallback" class="hidden"></textarea>
  `);
  t.after(() => dom.window.close());
  const byId = (id) => dom.window.document.getElementById(id);
  const host = createIdeEditorHost({
    getDom: () => ({ ideEditorHost: byId('ideEditorHost'), ideEditorFallback: byId('ideEditorFallback') }),
    monacoUtils: {
      async ensureMonacoEditorApi() { return null; },
      normalizeEditorLanguage: () => 'plaintext',
      fallbackSelectionLines: require('../renderer/features/renderer-monaco-editor-utils').fallbackSelectionLines,
    },
  });
  await host.openDocument({ path: 'notes.txt', content: 'one\ntwo\nthree\n', mtimeMs: 1, eol: 'lf' });
  host.activateDocument('notes.txt');
  const textarea = byId('ideEditorFallback');
  textarea.selectionStart = 4; // start of "two"
  textarea.selectionEnd = 13; // end of "three"
  assert.equal(host.getSelectedText(), 'two\nthree');
  assert.deepEqual(host.getSelectionRange(), { startLine: 2, endLine: 3 });
  assert.equal(host.getActiveLanguageId(), 'plaintext');
  textarea.selectionEnd = 4; // collapsed selection
  assert.equal(host.getSelectedText(), '');
  assert.equal(host.getSelectionRange(), null);
  host.dispose();
});
