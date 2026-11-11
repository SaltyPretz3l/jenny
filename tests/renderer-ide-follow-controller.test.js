'use strict';

// Follow Jenny in the Workspace editor: the draft tab of a file Jenny is writing, the line
// above the editor, and the switch. Driven by the real follow store and draft model.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeFollowController, DRAFT_PREFIX } = require('../renderer/features/renderer-ide-follow-controller');
const { createFollowStore } = require('../renderer/chat/renderer-follow-store');
const ideStateUtils = require('../renderer/features/renderer-ide-state');
const actionButton = require('../renderer/inventory/action-button');

const ROOT = 'C:/work/app';
const draftId = (callId) => `${DRAFT_PREFIX}${encodeURIComponent(callId)}`;
const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

function makeHarness(overrides = {}) {
  const dom = new JSDOM('<div id="main"><div id="ideEditorStage"></div></div>');
  const stage = dom.window.document.getElementById('ideEditorStage');
  const ide = { openTabs: [], activeTabPath: '', dirtyByPath: {}, staleByPath: {}, followJenny: true, activeStageSurface: 'editor', ...(overrides.ide || {}) };
  const env = { flag: true, view: 'ide', safe: true, files: { ...(overrides.files || {}) } };
  const calls = { opened: [], taken: 0, activated: [], closedDocs: [], persisted: 0, stops: [], reveals: [], logs: [], renders: 0 };
  const docs = new Map();
  const listeners = new Map();

  const store = createFollowStore({
    isEnabled: () => env.flag && ide.followJenny !== false,
    getActiveSessionId: () => 's1',
  });
  const hub = { store, stop: (sessionId) => calls.stops.push(sessionId) };

  const editorHost = {
    async openDraftDocument({ id, languagePath, text, lineNumbers }) {
      if (overrides.openDraftFails) return null;
      const open = docs.get(id);
      if (open) { // like the real host: the document and its text stay, the language follows the path
        open.languagePath = languagePath;
        return open;
      }
      const doc = { id, languagePath, text, lineNumbers, writes: [], decorations: [] };
      docs.set(id, doc);
      return doc;
    },
    writeDraftDocument(id, text, splice) {
      const doc = docs.get(id);
      if (!doc) return;
      if (splice) assert.equal(doc.text.slice(0, splice.start) + splice.text + doc.text.slice(splice.end), text, 'the splice rebuilds the text');
      doc.writes.push(splice ? 'splice' : 'whole');
      doc.text = text;
    },
    setFollowDecorations(id, decorations) { const doc = docs.get(id); if (doc) doc.decorations = decorations; },
    closeDocument(id) { calls.closedDocs.push(id); docs.delete(id); },
    editorFor(id) {
      if (!docs.has(id) || ide.activeTabPath !== id) return null;
      return {
        getVisibleRanges: () => [{ startLineNumber: 1, endLineNumber: env.visibleTo || 40 }],
        getDomNode: () => ({ addEventListener: (type, fn) => { env.userInput = { ...env.userInput, [type]: fn }; } }),
        revealLine: (line, ...scroll) => calls.reveals.push(['line', line, ...scroll]),
        revealLineInCenterIfOutsideViewport: (line) => calls.reveals.push(['center', line]),
      };
    },
  };

  let controller = null;
  const renderTabs = () => { calls.renders += 1; controller?.sync(); };
  const closeTab = (id) => {
    ideStateUtils.closeTab(ide, id);
    editorHost.closeDocument(id);
    renderTabs();
  };
  const activateTab = (id) => {
    ide.activeTabPath = id;
    calls.activated.push(id);
    listeners.get('ide:active-file-changed')?.({ detail: { path: id } });
    renderTabs();
  };
  const openFile = async (path, options) => {
    calls.opened.push([path, options]);
    ideStateUtils.openTab(ide, path, { transientPreview: options?.preview === true });
    renderTabs();
    return true;
  };

  controller = createIdeFollowController({
    getIde: () => ide,
    ideStateUtils,
    editorHost,
    getDom: () => ({ ideEditorStage: stage }),
    windowRef: {
      addEventListener: (type, fn) => listeners.set(type, fn),
      removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
    },
    getHub: () => (overrides.noHub ? null : hub),
    actionButton,
    getActiveView: () => env.view,
    getFeatureFlags: () => ({ follow_jenny: env.flag }),
    getWorkspaceRootContext: () => ({ path: ROOT }),
    getFileOperations: () => ({
      async readForMutation(path) {
        if (!(path in env.files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return { path, content: env.files[path] };
      },
    }),
    getPresentation: () => ({ canTakeEditor: () => env.safe, noteTaken: () => { calls.taken += 1; } }),
    activateTab, closeTab, openFile, renderTabs,
    schedulePersist: () => { calls.persisted += 1; },
    appendClientLog: (...args) => calls.logs.push(args),
  });

  const strip = () => dom.window.document.querySelector('.ide-follow-strip');
  const stripText = () => strip()?.querySelector('.ide-follow-strip-text')?.textContent || '';
  const stripShown = () => Boolean(strip()) && !strip().classList.contains('hidden');
  const click = (action) => strip().querySelector(`[data-ide-follow-action="${action}"]`).dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  return { ide, env, calls, docs, store, hub, controller, strip, stripText, stripShown, click, listeners, dom };
}

let bytes = 0;
function delta(callId, text, toolName = 'write_file') {
  bytes += Buffer.byteLength(text);
  return { type: 'tool_input_delta', sessionId: 's1', streamId: 'st1', toolCallId: callId, toolName, argumentsDelta: text, argumentsBytes: bytes, sequence: 1 };
}
const result = (callId, extra = {}) => ({ type: 'tool_result', streamId: 'st1', toolName: 'write_file', callId, isError: false, ...extra });

test('a streamed new file opens a read-only draft tab, takes the editor when safe and grows in place', async () => {
  const h = makeHarness();
  h.store.noteStreamEvent(delta('c1', '{"path":"src/a'));
  await flush();
  assert.equal(h.ide.openTabs.length, 0, 'no draft until the path is whole');

  h.store.noteStreamEvent(delta('c1', '.js","content":"one\\ntw'));
  await flush();
  const id = draftId('c1');
  const tab = ideStateUtils.getTab(h.ide, id);
  assert.deepEqual({ kind: tab.kind, label: tab.label, draft: tab.draft, filePath: tab.filePath, live: tab.live },
    { kind: 'diff', label: 'a.js', draft: true, filePath: 'src/a.js', live: true });
  assert.equal(h.ide.activeTabPath, id);
  assert.equal(h.calls.taken, 1, 'an automatic take counts against the switching guard');
  assert.equal(h.docs.get(id).languagePath, 'src/a.js');
  assert.equal(h.docs.get(id).lineNumbers, null);
  assert.equal(h.docs.get(id).text, 'one\ntw');
  assert.equal(h.stripShown(), true);
  assert.equal(h.stripText(), 'Jenny is writing this file');
  assert.equal(h.strip().querySelector('.status-dot--active') !== null, true);
  assert.equal(h.strip().querySelector('.ide-follow-strip-meta').textContent, '6 B · not saved');
  assert.deepEqual(h.calls.reveals[0], ['center', 2]);

  const stop = h.strip().querySelector('[data-ide-follow-action="stop"]');
  h.store.noteStreamEvent(delta('c1', 'o\\nthree'));
  await flush();
  assert.equal(h.docs.get(id).text, 'one\ntwo\nthree');
  assert.deepEqual(h.docs.get(id).writes, ['splice']);
  assert.equal(h.strip().querySelector('[data-ide-follow-action="stop"]'), stop, 'the Stop button is not rebuilt while text arrives');
  assert.equal(h.strip().querySelector('.ide-follow-strip-meta').textContent, '13 B · not saved');
  assert.deepEqual(h.calls.reveals.at(-1), ['line', 3],
    'the arrival line stays in view, with no scroll type so the editor glides to it');
  const caret = h.docs.get(id).decorations.at(-1);
  assert.equal(caret.options.afterContentClassName, 'ide-follow-caret');
  assert.deepEqual(caret.range, { startLineNumber: 3, startColumn: 6, endLineNumber: 3, endColumn: 6 });

  h.click('stop');
  assert.deepEqual(h.calls.stops, ['s1']);
});

test('the arrival line is not chased once the user has scrolled away from it', async () => {
  const h = makeHarness();
  h.store.noteStreamEvent(delta('c1', '{"path":"a.txt","content":"1\\n2\\n3'));
  await flush();
  h.env.visibleTo = 1; // line 3 is no longer on screen
  h.store.noteStreamEvent(delta('c1', '\\n4'));
  await flush();
  assert.deepEqual(h.calls.reveals.at(-1), ['line', 4], 'a glide that has not caught up yet does not end the follow');
  h.env.userInput.wheel(); // the reader scrolls
  const before = h.calls.reveals.length;
  h.store.noteStreamEvent(delta('c1', '\\n5'));
  await flush();
  assert.equal(h.calls.reveals.length, before);
});

test('when taking the editor is not safe the draft opens in the background and never jumps in later', async () => {
  const h = makeHarness();
  ideStateUtils.openTab(h.ide, 'notes.md');
  h.env.safe = false;
  h.store.noteStreamEvent(delta('c1', '{"path":"a.txt","content":"x'));
  await flush();
  assert.equal(h.ide.openTabs.length, 2);
  assert.equal(h.ide.activeTabPath, 'notes.md');
  assert.equal(h.stripShown(), false);

  h.env.safe = true;
  h.store.noteStreamEvent(delta('c1', 'yz'));
  await flush();
  assert.equal(h.ide.activeTabPath, 'notes.md');
  assert.equal(h.docs.get(draftId('c1')).text, 'xyz', 'a background draft still fills');
  assert.equal(h.calls.taken, 0);

  h.store.requestReveal('c1'); // the chat's Watch link
  await flush();
  assert.equal(h.ide.activeTabPath, draftId('c1'));
  assert.equal(h.calls.taken, 0, 'a take the user asked for is not counted');
  assert.equal(h.stripShown(), true);
});

test('another view or stage surface is never interrupted', async () => {
  const h = makeHarness();
  ideStateUtils.openTab(h.ide, 'notes.md');
  h.env.view = 'chat';
  h.store.noteStreamEvent(delta('c1', '{"path":"a.txt","content":"x'));
  await flush();
  assert.equal(h.ide.activeTabPath, 'notes.md');

  h.env.view = 'ide';
  h.ide.activeStageSurface = 'preview';
  h.store.noteStreamEvent(delta('c2', '{"path":"b.txt","content":"x'));
  await flush();
  assert.equal(h.ide.activeTabPath, 'notes.md');
  assert.equal(h.ide.openTabs.length, 3);
});

test('with no tab open the draft shows in the editor, but another stage surface is still not interrupted', async () => {
  const h = makeHarness();
  h.env.view = 'chat';
  h.env.safe = false;
  h.store.noteStreamEvent(delta('c1', '{"path":"a.txt","content":"x'));
  await flush();
  assert.equal(h.ide.activeTabPath, draftId('c1'), 'there was no tab to take the editor from');

  const other = makeHarness({ ide: { activeStageSurface: 'preview' } });
  other.store.noteStreamEvent(delta('c2', '{"path":"b.txt","content":"x'));
  await flush();
  assert.equal(other.ide.openTabs.length, 1);
  assert.equal(other.ide.activeTabPath, '', 'the Preview stage keeps the window');
  assert.deepEqual(other.calls.activated, []);
});

test('a draft asked for before it opened takes the editor when it opens', async () => {
  const h = makeHarness();
  ideStateUtils.openTab(h.ide, 'notes.md');
  h.env.safe = false;
  h.store.noteStreamEvent(delta('c1', '{"path":"a.txt","content":"x'));
  h.store.requestReveal('c1');
  await flush();
  assert.equal(h.ide.activeTabPath, draftId('c1'));
});

test('written: the showing draft gives way to the real file, a background draft just closes', async () => {
  const h = makeHarness();
  h.store.noteStreamEvent(delta('c1', '{"path":"src/a.js","content":"x"}'));
  await flush();
  assert.equal(h.ide.activeTabPath, draftId('c1'));
  h.store.noteStreamEvent(result('c1'));
  await flush();
  assert.deepEqual(h.calls.opened, [['src/a.js', { preview: true }]]);
  assert.equal(ideStateUtils.getTab(h.ide, draftId('c1')), null);
  assert.equal(h.ide.activeTabPath, 'src/a.js');
  assert.deepEqual(h.calls.closedDocs, [draftId('c1')]);
  assert.equal(h.stripShown(), false);

  h.env.safe = false;
  h.store.noteStreamEvent(delta('c2', '{"path":"b.txt","content":"x"}'));
  await flush();
  assert.equal(h.ide.activeTabPath, 'src/a.js');
  h.store.noteStreamEvent(result('c2'));
  await flush();
  assert.equal(ideStateUtils.getTab(h.ide, draftId('c2')), null);
  assert.equal(h.calls.opened.length, 1, 'nothing opens for a draft that was not showing');
});

test('a waiting draft says it is not saved yet; denied, failed and stopped drafts stay with Close draft', async () => {
  const h = makeHarness();
  h.store.noteStreamEvent(delta('c1', '{"path":"a.txt","content":"x"}'));
  h.store.noteStreamEvent({ type: 'tool_approval_needed', sessionId: 's1', streamId: 'st1', toolName: 'write_file', callId: 'c1', input: { path: 'a.txt', content: 'x' } });
  await flush();
  const id = draftId('c1');
  assert.equal(h.stripText(), 'Draft finished. It is saved only if you allow it in the chat.');
  assert.equal(h.strip().querySelector('.status-dot--pending') !== null, true);
  assert.equal(h.strip().querySelector('[data-ide-follow-action]'), null);
  assert.equal(ideStateUtils.getTab(h.ide, id).live, false);
  assert.equal(h.docs.get(id).decorations.length, 0, 'no caret once the text is whole');

  h.store.noteStreamEvent(result('c1', { approvalState: 'denied', isError: true }));
  await flush();
  assert.equal(h.stripText(), 'Denied. Nothing was saved.');
  assert.equal(h.strip().querySelector('.ide-follow-strip-meta').textContent, '');
  h.click('close');
  assert.equal(ideStateUtils.getTab(h.ide, id), null);
  assert.equal(h.stripShown(), false);

  h.store.noteStreamEvent(delta('c2', '{"path":"b.txt","content":"x"}'));
  await flush();
  h.store.noteStreamEvent(result('c2', { isError: true }));
  await flush();
  assert.equal(h.stripText(), 'This change did not apply. Nothing was saved.');

  h.store.noteStreamEvent(delta('c3', '{"path":"c.txt","content":"x'));
  await flush();
  h.store.noteStreamEvent({ type: 'error', streamId: 'st1' });
  await flush();
  assert.equal(h.ide.activeTabPath, draftId('c3'));
  assert.equal(h.stripText(), 'Stopped. Nothing was saved.');
});

test('at most two ended drafts stay open', async () => {
  const h = makeHarness();
  for (const callId of ['c1', 'c2', 'c3']) {
    h.store.noteStreamEvent(delta(callId, `{"path":"${callId}.txt","content":"x"}`));
    await flush();
    h.store.noteStreamEvent(result(callId, { isError: true }));
    await flush();
  }
  const drafts = h.ide.openTabs.filter((tab) => tab.draft === true).map((tab) => tab.path);
  assert.deepEqual(drafts, [draftId('c2'), draftId('c3')]);
});

test('a change to an existing file shows in place: replaced lines kept, new lines beneath, old line numbers', async () => {
  const h = makeHarness({ files: { 'src/a.js': 'one\ntwo\nthree\n' } });
  h.store.noteStreamEvent(delta('e1', '{"path":"src/a.js","old_string":"two","new_string":"TW', 'edit_file'));
  await flush();
  const doc = h.docs.get(draftId('e1'));
  assert.equal(doc.text, 'one\ntwo\nTW\nthree\n');
  assert.equal(h.stripText(), 'Jenny is changing this file');
  assert.equal(h.strip().querySelector('.ide-follow-strip-meta').textContent, 'not saved');
  const classes = doc.decorations.map((d) => [d.options.className || d.options.afterContentClassName, d.range.startLineNumber, d.range.endLineNumber]);
  assert.deepEqual(classes, [['ide-follow-line--removed', 2, 2], ['ide-follow-line--added', 3, 3], ['ide-follow-caret', 3, 3]]);
  assert.equal(doc.decorations[0].options.linesDecorationsClassName, 'ide-follow-sign--removed');
  assert.equal(doc.decorations[1].options.linesDecorationsClassName, 'ide-follow-sign--added');
  assert.deepEqual([1, 2, 3, 4].map((line) => doc.lineNumbers(line)), ['1', '2', '2', '3']);

  h.store.noteStreamEvent(delta('e1', 'O"}', 'edit_file'));
  await flush();
  assert.equal(doc.text, 'one\ntwo\nTWO\nthree\n');
});

test('a change to a file that is not there shows its new text only', async () => {
  const h = makeHarness();
  h.store.noteStreamEvent(delta('e1', '{"path":"new.js","old_string":"a","new_string":"b"}', 'edit_file'));
  await flush();
  assert.equal(h.docs.get(draftId('e1')).text, '\nb');
});

test('a path outside the open folder, a folder path, or no open folder gets no draft', async () => {
  const h = makeHarness();
  h.store.noteStreamEvent(delta('c1', '{"path":"D:/elsewhere/a.txt","content":"x'));
  h.store.noteStreamEvent(delta('c2', '{"path":"../up.txt","content":"x'));
  await flush();
  h.store.requestReveal('c1');
  await flush();
  assert.equal(h.ide.openTabs.length, 0);
  assert.equal(h.strip(), null);
});

test('an absolute path inside the open folder opens by its relative path', async () => {
  const h = makeHarness();
  h.store.noteStreamEvent(delta('c1', '{"path":"C:\\\\work\\\\app\\\\src\\\\a.js","content":"x'));
  await flush();
  assert.equal(ideStateUtils.getTab(h.ide, draftId('c1')).filePath, 'src/a.js');
});

test('a draft tab the user closed stays closed until they ask for it again', async () => {
  const h = makeHarness();
  h.store.noteStreamEvent(delta('c1', '{"path":"a.txt","content":"x'));
  await flush();
  const id = draftId('c1');
  ideStateUtils.closeTab(h.ide, id); // the tab strip's close: the tab and its document
  h.docs.delete(id);
  h.controller.sync();
  assert.equal(h.stripShown(), false);
  h.store.noteStreamEvent(delta('c1', 'y'));
  await flush();
  assert.equal(ideStateUtils.getTab(h.ide, id), null);

  h.store.requestReveal('c1');
  await flush();
  assert.equal(h.ide.activeTabPath, id);
  assert.equal(h.docs.get(id).text, 'xy');
});

test('an engine with no argument stream: the draft appears whole when approval is asked', async () => {
  const h = makeHarness();
  h.store.noteStreamEvent({ type: 'tool_use', sessionId: 's1', streamId: 'st1', toolName: 'write_file', callId: 'w1', input: { path: 'a.txt', content: 'all of it' }, status: 'requested' });
  await flush();
  assert.equal(h.ide.openTabs.length, 0);
  h.store.noteStreamEvent({
    type: 'tool_approval_needed', sessionId: 's1', streamId: 'st1', toolName: 'write_file', callId: 'w1',
    input: { path: 'a.txt', content: 'all of it' }, exact_approval: { schema_version: 1, fields: [], bytes: 9, sha256: 'f'.repeat(64) },
  });
  await flush();
  assert.equal(h.docs.get(draftId('w1')).text, 'all of it');
  assert.equal(h.stripText(), 'Draft finished. It is saved only if you allow it in the chat.');

  // An approval too large to be shown exactly carries a cut input: no draft is made of it.
  h.store.noteStreamEvent({
    type: 'tool_approval_needed', sessionId: 's1', streamId: 'st1', toolName: 'write_file', callId: 'w2',
    input: { path: 'big.txt', content: `${'x'.repeat(512)}...` }, exact_approval: { schema_version: 1, too_large: true, bytes: 40000, limit_bytes: 32768 },
  });
  await flush();
  assert.equal(h.docs.has(draftId('w2')), false);
  assert.equal(ideStateUtils.getTab(h.ide, draftId('w2')), null);
});

test('an engine with no argument stream, no approval: the written file opens when that is safe', async () => {
  const h = makeHarness();
  const use = (callId, path) => ({ type: 'tool_use', sessionId: 's1', streamId: 'st1', toolName: 'write_file', callId, input: { path, content: 'x' }, status: 'requested' });
  h.store.noteStreamEvent(use('w1', 'a.txt'));
  h.store.noteStreamEvent(result('w1'));
  await flush();
  assert.deepEqual(h.calls.opened, [['a.txt', { preview: true }]]);
  assert.equal(h.calls.taken, 1);
  assert.equal(h.ide.openTabs.some((tab) => tab.draft === true), false);

  h.env.safe = false;
  h.store.noteStreamEvent(use('w2', 'b.txt'));
  h.store.noteStreamEvent(result('w2'));
  await flush();
  assert.equal(h.calls.opened.length, 1);
});

test('a file too large to show says so and keeps Stop', async () => {
  const h = makeHarness();
  h.store.noteStreamEvent(delta('c1', '{"path":"big.txt","content":"x'));
  await flush();
  const call = h.store.getCall('c1');
  call.tooLarge = true;
  call.bytes = 3 * 1024 * 1024;
  h.store.requestReveal('c1');
  await flush();
  assert.equal(h.stripText(), 'This file is too large to show while it is written.');
  assert.equal(h.strip().querySelector('.ide-follow-strip-meta').textContent, '3.0 MB so far');
  assert.notEqual(h.strip().querySelector('[data-ide-follow-action="stop"]'), null);
});

test('the switch: hidden with the feature off, toggling persists and releases every draft', async () => {
  const h = makeHarness();
  assert.equal(h.controller.getSwitch(), true);
  h.store.noteStreamEvent(delta('c1', '{"path":"a.txt","content":"x'));
  await flush();
  assert.equal(h.ide.openTabs.length, 1);

  assert.equal(h.controller.toggleSwitch(), false);
  assert.equal(h.ide.followJenny, false);
  assert.equal(h.calls.persisted, 1);
  assert.equal(h.ide.openTabs.length, 0, 'switching off closes the drafts');
  assert.equal(h.stripShown(), false);
  h.store.noteStreamEvent(delta('c2', '{"path":"b.txt","content":"x'));
  await flush();
  assert.equal(h.ide.openTabs.length, 0);

  assert.equal(h.controller.toggleSwitch(), true);
  h.store.noteStreamEvent(delta('c3', '{"path":"c.txt","content":"x'));
  await flush();
  assert.equal(h.ide.openTabs.length, 1);

  h.env.flag = false;
  assert.equal(h.controller.getSwitch(), null);
  assert.equal(h.controller.toggleSwitch(), false);
  assert.equal(h.calls.persisted, 2);
});

test('the palette entry toggles the switch and shows only in the Workspace with the feature on', () => {
  const h = makeHarness();
  const rows = [];
  h.controller.registerCommands({ register: (row) => { rows.push(row); return () => {}; } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'ide:toggle-follow-jenny');
  assert.equal(rows[0].label, 'Toggle Follow Jenny');
  assert.equal(rows[0].when({ activeView: 'ide' }), true);
  assert.equal(rows[0].when({ activeView: 'chat' }), false);
  rows[0].run();
  assert.equal(h.ide.followJenny, false);
  h.env.flag = false;
  assert.equal(rows[0].when({ activeView: 'ide' }), false);
});

test('a released call, a folder switch and dispose close the drafts', async () => {
  const h = makeHarness();
  h.store.noteStreamEvent(delta('c1', '{"path":"a.txt","content":"x'));
  await flush();
  h.store.noteStreamEvent({ type: 'stream_reset', streamId: 'st1' });
  await flush();
  assert.equal(h.ide.openTabs.length, 0);

  h.store.noteStreamEvent(delta('c2', '{"path":"b.txt","content":"x'));
  await flush();
  h.controller.closeAll();
  assert.equal(h.ide.openTabs.length, 0);
  assert.equal(h.stripShown(), false);

  h.store.noteStreamEvent(delta('c3', '{"path":"c.txt","content":"x'));
  await flush();
  assert.equal(h.ide.openTabs.length, 1);
  h.controller.dispose();
  assert.equal(h.ide.openTabs.length, 0);
  assert.equal(h.strip(), null);
  assert.equal(h.listeners.size, 0);
  h.store.noteStreamEvent(delta('c4', '{"path":"d.txt","content":"x'));
  await flush();
  assert.equal(h.ide.openTabs.length, 0, 'a disposed controller no longer listens');
});

test('calls already live when the controller is built are picked up, and no hub is harmless', async () => {
  const late = makeHarness({ noHub: true });
  late.controller.sync();
  assert.equal(late.strip(), null);

  const h = makeHarness();
  h.controller.dispose();
  h.store.noteStreamEvent(delta('c1', '{"path":"a.txt","content":"x'));
  h.store.requestReveal('c1');
  const second = createIdeFollowController({
    getIde: () => h.ide, ideStateUtils, getDom: () => ({}), getHub: () => h.hub, actionButton,
    editorHost: { openDraftDocument: async ({ id, text }) => ({ id, text }), writeDraftDocument() {}, closeDocument() {} },
    getFeatureFlags: () => ({ follow_jenny: true }),
    getWorkspaceRootContext: () => ({ path: ROOT }),
    activateTab: (id) => { h.ide.activeTabPath = id; },
  });
  await flush();
  assert.equal(h.ide.activeTabPath, draftId('c1'), 'the pending Watch request is honoured');
  second.dispose();
});

test('the tab limit and a failed open leave nothing behind', async () => {
  const h = makeHarness();
  for (let i = 0; i < 64; i += 1) ideStateUtils.openTab(h.ide, `f${i}.txt`);
  h.store.noteStreamEvent(delta('c1', '{"path":"a.txt","content":"x'));
  await flush();
  assert.equal(h.ide.openTabs.length, 64);
  assert.deepEqual(h.calls.closedDocs, [draftId('c1')]);
  assert.equal(h.ide.activeTabPath, 'f63.txt');

  const failing = makeHarness({ openDraftFails: true });
  failing.store.noteStreamEvent(delta('c1', '{"path":"a.txt","content":"x'));
  await flush();
  assert.equal(failing.ide.openTabs.length, 0);
});

// llama-server orders a call's arguments by name, so a new file's text comes before its path.
test('text that arrives before the path opens an unnamed draft, which takes its name when the path arrives', async () => {
  const h = makeHarness();
  const id = draftId('c1');
  h.store.noteStreamEvent(delta('c1', '{"content":"one\ntw'));
  await flush();
  assert.equal(h.ide.activeTabPath, id, 'the draft shows while the path is still unknown');
  assert.equal(ideStateUtils.getTab(h.ide, id).label, 'New File');
  assert.equal(h.docs.get(id).text, 'one\ntw');
  assert.equal(h.stripText(), 'Jenny is writing this file');

  h.store.noteStreamEvent(delta('c1', 'o\nthree'));
  await flush();
  assert.equal(h.docs.get(id).text, 'one\ntwo\nthree');
  assert.deepEqual(h.docs.get(id).writes, ['splice']);

  h.store.noteStreamEvent(delta('c1', '","path":"src/a.js"}'));
  await flush();
  const tab = ideStateUtils.getTab(h.ide, id);
  assert.equal(tab.label, 'a.js');
  assert.equal(tab.filePath, 'src/a.js');
  assert.equal(h.docs.get(id).languagePath, 'src/a.js', 'the editor is told the language');
  assert.equal(h.docs.get(id).text, 'one\ntwo\nthree', 'naming the draft keeps its text');
  assert.equal(h.ide.activeTabPath, id);

  h.store.noteStreamEvent(result('c1'));
  await flush();
  assert.deepEqual(h.calls.opened, [['src/a.js', { preview: true }]], 'the written file takes the draft\'s place');
  assert.equal(ideStateUtils.getTab(h.ide, id), null);
});

test('the Watch link shows an unnamed draft, and a path outside the open folder closes it', async () => {
  const h = makeHarness();
  ideStateUtils.openTab(h.ide, 'notes.md');
  h.env.view = 'chat';
  h.env.safe = false;
  h.store.noteStreamEvent(delta('c1', '{"content":"x'));
  h.store.requestReveal('c1'); // asked for before any path is known
  await flush();
  assert.equal(h.ide.activeTabPath, draftId('c1'));
  assert.equal(h.docs.get(draftId('c1')).text, 'x');

  h.store.noteStreamEvent(delta('c1', '","path":"C:/elsewhere/a.js"}'));
  await flush();
  assert.equal(ideStateUtils.getTab(h.ide, draftId('c1')), null, 'a file outside the folder gets no draft');
  assert.deepEqual(h.calls.closedDocs, [draftId('c1')]);
  assert.equal(h.stripShown(), false);

  h.store.noteStreamEvent(delta('c1', ' '));
  h.store.noteStreamEvent(result('c1'));
  await flush();
  assert.deepEqual(h.calls.opened, [], 'nothing follows a closed draft');
});

test('an edit whose path is still unknown waits for it', async () => {
  const h = makeHarness({ files: { 'a.txt': 'old\n' } });
  h.store.noteStreamEvent(delta('c1', '{"new_string":"new","old_string":"old', 'edit_file'));
  await flush();
  assert.equal(h.ide.openTabs.length, 0);
  h.store.noteStreamEvent(delta('c1', '","file_path":"a.txt"}', 'edit_file'));
  await flush();
  assert.equal(h.ide.openTabs.length, 1);
});
