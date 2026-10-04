'use strict';

/* Split view W2-2b -- per-pane attachments.
 *
 * Before W2-2b the attachment queue, tray and paste/drop/attach bindings were
 * pane 0's alone: an image pasted into pane 1's textarea attached nothing and
 * a file queued in pane 0 was sent by whichever pane sent next. Now the live
 * queue (state.attachments.queued) is pane 0's session's and pane 1's queue
 * is its session's composer record, read and written through the
 * session-keyed helpers in renderer-composer-session-state.js; pane 1 gets
 * its own tray, attach button and pane-scoped bindings.
 *
 * The real-shell tests move focus to pane 1 first (a pointerdown inside it),
 * as a user does: with two panes currentSessionId then names pane 1's session
 * while the live queue must stay pane 0's.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { createAttachmentEventBindings } = require('../renderer/features/renderer-attachment-event-utils');
const { createSidebarController } = require('../renderer/shell/renderer-sidebar-utils');

function buildSummary(id, title) {
  return {
    id,
    title,
    session_type: 'chat',
    conversation_mode: 'chat',
    preferred_model: 'gpt-test',
    reasoning_effort: 'default',
    plan_mode: false,
    pinned: false,
    archived_at: null,
    context_preferences: { history_scope: 'session', include_personality: true, include_memory: true },
    linked_session_ids: [],
    interactive_round_count: 0,
    interactive_sequence_state: 'idle',
    pending_question_batch: null,
    updated_at: new Date().toISOString(),
  };
}

function transcript(sessionId, text) {
  return [
    { id: `user_${sessionId}`, role: 'user', content: `Question for ${text}`, status: 'complete' },
    { id: `assistant_${sessionId}`, role: 'assistant', content: `Answer from ${text}.`, status: 'complete', finalizedAt: new Date().toISOString() },
  ];
}

async function openTwoPanes(t, extraShell = {}) {
  const app = await loadRendererApp({ shell: {
    sessions: [buildSummary('session-a', 'Alpha'), buildSummary('session-b', 'Beta'), buildSummary('session-c', 'Gamma')],
    workspaceState: { activeSessionId: 'session-a', openSessionIds: ['session-a', 'session-b', 'session-c'] },
    sessionMessagePayloads: {
      'session-a': { data: transcript('session-a', 'pane zero') },
      'session-b': { data: transcript('session-b', 'pane one') },
      'session-c': { data: transcript('session-c', 'third') },
    },
    ...extraShell,
  } });
  t.after(() => app.dispose());
  const { window } = app;
  const doc = window.document;
  await waitForUi(window, 150);
  const composition = window.rendererAppPaneComposition.getPaneComposition();
  assert.equal(composition.toggleSplit(), true, 'precondition: the chord opens a second pane');
  await waitForUi(window, 150);
  const pane1 = composition.getPane(1);
  assert.ok(pane1, 'pane 1 is mounted');
  const state = window.__rendererState;
  assert.equal(state.panes.panes[1].sessionId, 'session-b');
  return { app, window, doc, composition, pane1, state };
}

function paneTray(pane1) { return pane1.root.querySelector('[data-chat-node="attachmentTray"]'); }
function paneAttach(pane1) { return pane1.root.querySelector('[data-chat-node="composerAttachShortcut"]'); }

function focusIn(window, node) {
  node.dispatchEvent(new window.Event('pointerdown', { bubbles: true, cancelable: true }));
}

function pasteImage(window, input, name) {
  const blob = new window.Blob([Uint8Array.from([137, 80, 78, 71])], { type: 'image/png' });
  blob.name = name;
  const event = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { items: [{ type: 'image/png', getAsFile() { return blob; } }], types: ['Files'], files: [blob], getData: () => '' },
  });
  input.dispatchEvent(event);
  return event;
}

function dragEvent(window, type, files) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: files || [], types: ['Files'] } });
  return event;
}

// Arrays and objects built inside the app window come from another realm;
// copy them into this one before a deep comparison.
function plain(value) { return JSON.parse(JSON.stringify(value)); }

function queueOf(state, sessionId) {
  const store = state.composerSessionState; // a Map from the app window's realm
  const record = store && typeof store.get === 'function' ? store.get(sessionId) : null;
  return record && Array.isArray(record.attachments) ? record.attachments : [];
}

test('an image pasted into pane 1 lands in pane 1\'s queue and tray; pane 0\'s queue and tray are untouched', async (t) => {
  const { window, doc, pane1, state } = await openTwoPanes(t);
  const pane0Queue = state.attachments.queued;
  const pane0TrayHtml = doc.getElementById('attachmentTray').innerHTML;
  focusIn(window, pane1.dom.chatInput);
  assert.equal(state.currentSessionId, 'session-b', 'precondition: the pointerdown focused pane 1');

  const event = pasteImage(window, pane1.dom.chatInput, 'side.png');
  await waitForUi(window, 80);

  assert.equal(event.defaultPrevented, true, 'the image paste was claimed');
  assert.deepEqual(plain(queueOf(state, 'session-b').map((entry) => entry.displayName)), ['side.png']);
  assert.equal(state.attachments.queued, pane0Queue, 'pane 0\'s queue keeps its identity');
  assert.equal(pane0Queue.length, 0);
  assert.equal(doc.getElementById('attachmentTray').innerHTML, pane0TrayHtml, 'pane 0\'s tray is byte-identical');
  const tray = paneTray(pane1);
  assert.equal(tray.classList.contains('hidden'), false, 'pane 1\'s tray shows');
  assert.equal(tray.querySelectorAll('.attachment-chip-image').length, 1);
  assert.equal(pane1.dom.chatInput.value, '', 'precondition: the draft is empty');
  assert.equal(pane1.sendButton.disabled, false, 'a queued attachment alone enables pane 1\'s Send (pane 0\'s rule)');
});

test('pane 1\'s attach button opens the picker for pane 1\'s session and the files land in pane 1\'s queue', async (t) => {
  const picks = [];
  const { window, doc, pane1, state } = await openTwoPanes(t);
  window.jennyShell.attachments.pick = async (options) => {
    picks.push(options);
    return { accepted: [{ id: 'file-1', kind: 'file', displayName: 'notes.txt', path: 'C:/notes.txt', sizeBytes: 2048 }], rejected: [] };
  };
  const button = paneAttach(pane1);
  assert.ok(button && button !== doc.getElementById('composerAttachShortcut'), 'precondition: pane 1 carries its own attach button');
  assert.equal(button.getAttribute('aria-label'), 'Attach file');
  assert.equal(button.hasAttribute('aria-haspopup'), false);
  assert.equal(button.innerHTML.replace(/\s+/g, ''), doc.getElementById('composerAttachShortcut').innerHTML.replace(/\s+/g, ''), 'the same icon');
  focusIn(window, button);
  assert.equal(state.currentSessionId, 'session-b', 'precondition: the pointerdown focused pane 1');
  button.click();
  await waitForUi(window, 80);
  assert.deepEqual(plain(picks), [{ session_id: 'session-b' }]);
  assert.equal(state.ui.composerPopoverOpen, false);
  assert.equal(doc.getElementById('composerAttachMenu').classList.contains('hidden'), true);
  assert.equal(state.currentSessionId, 'session-b', 'the picker result does not move focus to pane 0 (its settings popover close)');
  assert.equal(doc.getElementById('composerAttachShortcut') === doc.activeElement, false);
  assert.deepEqual(plain(queueOf(state, 'session-b').map((entry) => entry.id)), ['file-1']);
  assert.equal(state.attachments.queued.length, 0);
  assert.equal(paneTray(pane1).querySelector('[data-attachment-id="file-1"] .attachment-chip-name').textContent, 'notes.txt');
});

test('a drop on pane 1 marks only pane 1 chat-drop-active and queues into pane 1', async (t) => {
  const prepared = [];
  const { window, doc, pane1, state } = await openTwoPanes(t);
  window.jennyShell.attachments.getPathForFile = (file) => file.__path || '';
  window.jennyShell.attachments.prepare = async (paths, options) => {
    prepared.push([paths, options]);
    return { accepted: [{ id: 'drop-1', kind: 'file', displayName: 'dropped.md', path: paths[0], sizeBytes: 10 }], rejected: [] };
  };
  const chatView = doc.getElementById('chatView');
  pane1.root.dispatchEvent(dragEvent(window, 'dragenter'));
  assert.equal(pane1.root.classList.contains('chat-drop-active'), true, 'pane 1 lights');
  assert.equal(chatView.classList.contains('chat-drop-active'), false, 'pane 0 (the view) does not');
  assert.equal(state.attachments.dragDepth, 0, 'pane 0\'s drag depth untouched');

  const drop = dragEvent(window, 'drop', [{ name: 'dropped.md', __path: 'C:/work/dropped.md' }]);
  pane1.dom.chatInput.dispatchEvent(drop);
  await waitForUi(window, 80);
  assert.equal(drop.defaultPrevented, true);
  assert.equal(pane1.root.classList.contains('chat-drop-active'), false);
  assert.deepEqual(plain(prepared), [[['C:/work/dropped.md'], { session_id: 'session-b' }]]);
  assert.deepEqual(plain(queueOf(state, 'session-b').map((entry) => entry.id)), ['drop-1']);
  assert.equal(state.attachments.queued.length, 0);
});

test('removing from pane 1\'s tray removes from pane 1\'s queue only', async (t) => {
  const { window, doc, pane1, state } = await openTwoPanes(t);
  pasteImage(window, doc.getElementById('chatInput'), 'zero.png');
  await waitForUi(window, 60);
  const pane0Queue = state.attachments.queued;
  assert.equal(pane0Queue.length, 1, 'precondition: pane 0 holds one');
  focusIn(window, pane1.dom.chatInput);
  pasteImage(window, pane1.dom.chatInput, 'one.png');
  await waitForUi(window, 60);
  const remove = paneTray(pane1).querySelector('[data-attachment-remove]');
  assert.ok(remove, 'precondition: pane 1\'s chip has a remove button');
  remove.click();
  await waitForUi(window, 40);
  assert.equal(queueOf(state, 'session-b').length, 0);
  assert.equal(paneTray(pane1).classList.contains('hidden'), true);
  assert.equal(state.attachments.queued, pane0Queue, 'pane 0\'s queue keeps its identity');
  assert.deepEqual(plain(pane0Queue.map((entry) => entry.displayName)), ['zero.png']);
});

test('a send from pane 1 carries pane 1\'s attachments and clears pane 1\'s queue only', async (t) => {
  const { window, doc, pane1, state } = await openTwoPanes(t);
  focusIn(window, doc.getElementById('chatInput'));
  pasteImage(window, doc.getElementById('chatInput'), 'zero.png');
  await waitForUi(window, 60);
  const pane0Queue = state.attachments.queued;
  const pane0TrayHtml = doc.getElementById('attachmentTray').innerHTML;
  focusIn(window, pane1.dom.chatInput);
  pasteImage(window, pane1.dom.chatInput, 'one.png');
  await waitForUi(window, 60);

  pane1.dom.chatInput.value = 'describe this';
  pane1.dom.chatInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  focusIn(window, pane1.sendButton);
  pane1.sendButton.click();
  await waitForUi(window, 80);

  const chatCalls = window.jennyShell.__state.chatCalls;
  assert.equal(chatCalls.length, 1);
  assert.equal(chatCalls[0].sessionId, 'session-b');
  assert.deepEqual(plain(chatCalls[0].attachments.map((entry) => entry.displayName)), ['one.png']);
  assert.equal(queueOf(state, 'session-b').length, 0, 'pane 1\'s queue cleared');
  assert.equal(paneTray(pane1).classList.contains('hidden'), true, 'pane 1\'s tray re-rendered empty');
  assert.equal(paneTray(pane1).querySelectorAll('.attachment-chip').length, 0);
  assert.equal(state.attachments.queued, pane0Queue, 'pane 0\'s queue keeps its identity');
  assert.deepEqual(plain(pane0Queue.map((entry) => entry.displayName)), ['zero.png']);
  assert.equal(doc.getElementById('attachmentTray').innerHTML, pane0TrayHtml, 'pane 0\'s tray is untouched');
});

test('a rail tab switch in pane 0 restores pane 0\'s record and leaves pane 1\'s queue alone', async (t) => {
  const { window, doc, pane1, state } = await openTwoPanes(t);
  pasteImage(window, doc.getElementById('chatInput'), 'zero.png');
  await waitForUi(window, 60);
  const pane0Queue = state.attachments.queued;
  focusIn(window, pane1.dom.chatInput);
  pasteImage(window, pane1.dom.chatInput, 'one.png');
  await waitForUi(window, 60);
  const pane1Queue = queueOf(state, 'session-b');
  assert.equal(pane1Queue.length, 1, 'precondition: pane 1 holds one');

  focusIn(window, doc.getElementById('chatInput'));
  assert.equal(state.currentSessionId, 'session-a', 'precondition: pane 0 focused');
  await state.harness.agentActions.openSession('session-c');
  await waitForUi(window, 100);
  assert.equal(state.panes.panes[0].sessionId, 'session-c', 'pane 0 switched');
  assert.equal(state.panes.panes[1].sessionId, 'session-b', 'pane 1 kept its session');
  assert.equal(state.attachments.queued.length, 0, 'pane 0 shows session-c\'s empty queue');
  assert.equal(queueOf(state, 'session-a'), pane0Queue, 'session-a\'s queue was captured by reference');
  assert.equal(queueOf(state, 'session-b'), pane1Queue, 'pane 1\'s queue is the same array');
  assert.equal(paneTray(pane1).querySelectorAll('.attachment-chip').length, 1);

  await state.harness.agentActions.openSession('session-a');
  await waitForUi(window, 100);
  assert.equal(state.attachments.queued, pane0Queue, 'returning restores pane 0\'s own array');
  assert.equal(queueOf(state, 'session-b'), pane1Queue);
});

test('a rail tab switch while pane 1 is focused lands in pane 1 and leaves pane 0\'s textarea and live queue alone', async (t) => {
  const { window, doc, pane1, state } = await openTwoPanes(t);
  const input0 = doc.getElementById('chatInput');
  input0.value = 'pane zero draft';
  pasteImage(window, input0, 'zero.png');
  await waitForUi(window, 60);
  const pane0Queue = state.attachments.queued;
  assert.equal(pane0Queue.length, 1, 'precondition: pane 0 holds one');

  focusIn(window, pane1.dom.chatInput);
  assert.equal(state.currentSessionId, 'session-b', 'precondition: pane 1 focused');
  await state.harness.agentActions.openSession('session-c');
  await waitForUi(window, 100);
  assert.equal(state.panes.panes[1].sessionId, 'session-c', 'the switch landed in pane 1');
  assert.equal(state.panes.panes[0].sessionId, 'session-a', 'pane 0 kept its session');
  assert.equal(state.attachments.queued, pane0Queue, 'the live queue is still pane 0\'s array');
  assert.equal(input0.value, 'pane zero draft', 'pane 0\'s textarea was not restored over');
  assert.equal(doc.getElementById('attachmentTray').querySelectorAll('.attachment-chip').length, 1, 'pane 0\'s tray still shows its file');
  assert.equal(paneTray(pane1).querySelectorAll('.attachment-chip').length, 0, 'pane 1 shows session-c\'s empty queue');
});

test('unmounting pane 1 removes its attachment listeners; pane 0\'s bindings and the drop suppression stay', async (t) => {
  const { window, doc, composition, pane1, state } = await openTwoPanes(t);
  const root = pane1.root;
  const input = pane1.dom.chatInput;
  doc.querySelector('.chat-pane[data-pane-id="1"] .chat-pane-close').click();
  await waitForUi(window, 80);
  assert.equal(composition.getPane(1), null, 'pane 1 is gone');

  // A detached pane-1 node no longer reaches the pane-1 bindings.
  const saves = window.jennyShell.__state.attachmentSaveCalls.length;
  pasteImage(window, input, 'late.png');
  root.dispatchEvent(dragEvent(window, 'dragenter'));
  await waitForUi(window, 40);
  assert.equal(window.jennyShell.__state.attachmentSaveCalls.length, saves, 'no save from the unmounted pane');
  assert.equal(root.classList.contains('chat-drop-active'), false);

  const windowDrop = dragEvent(window, 'drop');
  doc.body.dispatchEvent(windowDrop);
  assert.equal(windowDrop.defaultPrevented, true, 'the window-level drop suppression survives');
  pasteImage(window, doc.getElementById('chatInput'), 'zero.png');
  await waitForUi(window, 60);
  assert.deepEqual(plain(state.attachments.queued.map((entry) => entry.displayName)), ['zero.png'], 'pane 0 still attaches');
});

test('one pane: a paste keeps today\'s live queue (captured by reference, the helpers alias it, no pane tray)', async (t) => {
  const app = await loadRendererApp({ shell: {
    sessions: [buildSummary('session-a', 'Alpha')],
    workspaceState: { activeSessionId: 'session-a', openSessionIds: ['session-a'] },
    sessionMessagePayloads: { 'session-a': { data: transcript('session-a', 'only') } },
  } });
  t.after(() => app.dispose());
  const { window } = app;
  const doc = window.document;
  const state = window.__rendererState;
  await waitForUi(window, 150);
  assert.equal(doc.querySelectorAll('.attachment-tray').length, 1, 'one pane: one tray');
  const input = doc.getElementById('chatInput');
  pasteImage(window, input, 'solo.png');
  await waitForUi(window, 60);
  const live = state.attachments.queued;
  assert.deepEqual(plain(live.map((entry) => entry.displayName)), ['solo.png']);
  assert.equal(doc.getElementById('attachmentTray').querySelectorAll('.attachment-chip-image').length, 1);
  input.value = 'hello';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(queueOf(state, 'session-a'), live, 'the input capture moves the live array by reference');
  assert.equal(window.rendererComposerSessionState.getQueuedAttachments(state, 'session-a'), live, 'the helper aliases it');
  window.rendererAppPaneComposition.getPaneComposition().syncPaneLayout('all');
  await waitForUi(window, 40);
  assert.equal(state.attachments.queued, live, 'a full render keeps its identity');
});

/* ── unit: pane 0's listener set and order are today's; pane 1 binds only its own nodes ── */
function withDom(t) {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="view"><div id="tray"></div><textarea id="input"></textarea>'
    + '<button id="attach"></button><button id="attachFiles"></button><button id="capture"></button></div></body>');
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  t.after(() => { globalThis.window = previous.window; globalThis.document = previous.document; });
  const log = [];
  const proto = dom.window.EventTarget.prototype;
  const originalAdd = proto.addEventListener;
  proto.addEventListener = function add(type, handler, options) {
    const name = this === dom.window ? 'window' : this === dom.window.document ? 'document' : this.id;
    log.push(`${name}:${type}`);
    return originalAdd.call(this, type, handler, options);
  };
  t.after(() => { proto.addEventListener = originalAdd; });
  return { dom, doc: dom.window.document, log };
}

function bindingDeps(doc, calls, extra = {}) {
  const record = (name) => (...args) => { calls.push([name, ...args]); return name === 'beginAttachmentToken' ? { operationId: 'op' } : Promise.resolve(); };
  return {
    state: { ui: {}, attachments: { queued: [], dragDepth: 0 } },
    constants: { TOAST_SOURCE: {} },
    dom: {
      attachmentTray: doc.getElementById('tray'),
      composerAttachShortcut: doc.getElementById('attach'),
      chatInput: doc.getElementById('input'),
      chatView: doc.getElementById('view'),
      attachFilesButton: extra.pane ? null : doc.getElementById('attachFiles'),
      captureScreenButton: extra.pane ? null : doc.getElementById('capture'),
    },
    callbacks: {
      resetAttachmentQueue: record('resetAttachmentQueue'),
      removeQueuedAttachment: record('removeQueuedAttachment'),
      renderAttachmentTray: record('renderAttachmentTray'),
      suppressFileDropNavigation: (event) => event.preventDefault(),
      setDropActive: record('setDropActive'),
      prepareDroppedAttachments: record('prepareDroppedAttachments'),
      getDroppedFilePaths: () => [],
      beginAttachmentToken: record('beginAttachmentToken'),
      cancelAttachmentToken: () => false,
      handleAttachmentPicker: record('handleAttachmentPicker'),
      queueInlineImageAttachment: record('queueInlineImageAttachment'),
      renderComposerPopover() {}, renderCommandPopover() {}, updateComposerSafeOffset() {},
      closeComposerPopover() {}, closeCommandPopover() {}, showToastMessage() {}, toErrorMessage: (error) => String(error),
    },
    ...(extra.pane ? { sessionContext: { paneId: 1, getSessionId: () => 'session-b', setSessionId() {}, isCurrent: () => false } } : {}),
  };
}

test('pane 0\'s attachment bindings register today\'s listener set in today\'s order', (t) => {
  const { doc, log } = withDom(t);
  const bindings = createAttachmentEventBindings(bindingDeps(doc, []));
  bindings.bind();
  assert.deepEqual(log, [
    'tray:click', 'tray:keydown', 'document:mousedown', 'document:keydown', 'window:resize',
    'window:dragenter', 'window:dragover', 'window:dragleave', 'window:drop',
    'view:dragenter', 'view:dragover', 'view:dragleave', 'view:drop',
    'input:paste', 'document:paste', 'attachFiles:click', 'attach:click', 'capture:click',
  ]);
  bindings.dispose();
});

test('a second pane\'s attachment bindings bind only its own nodes and key every queue call by its session', (t) => {
  const { doc, log } = withDom(t);
  const calls = [];
  const bindings = createAttachmentEventBindings(bindingDeps(doc, calls, { pane: true }));
  bindings.bind();
  assert.deepEqual(log, [
    'tray:click', 'tray:keydown', 'view:dragenter', 'view:dragover', 'view:dragleave', 'view:drop',
    'input:paste', 'attach:click',
  ], 'no document or window listener, no capture or files button');
  doc.getElementById('tray').innerHTML = '<button data-attachment-remove="img-1">x</button><button data-attachment-clear="true">all</button>';
  doc.querySelector('[data-attachment-remove]').click();
  doc.querySelector('[data-attachment-clear]').click();
  doc.getElementById('attach').click();
  assert.deepEqual(calls.filter((call) => call[0] !== 'renderAttachmentTray' && call[0] !== 'handleAttachmentPicker'), [
    ['removeQueuedAttachment', 'img-1', 'session-b'],
    ['resetAttachmentQueue', 'session-b'],
    ['beginAttachmentToken', 'session-b'],
  ]);
  bindings.dispose();
});

/* ── unit: pane 0's tray markup is today's byte for byte; a pane target renders its own ── */
const TODAY_TRAY_HTML = '\n          <div class="attachment-chip attachment-chip-image" data-attachment-id="img-1">\n            <img class="attachment-chip-preview" src="file:///C:/attachments/shot.png" alt="Shot.png">\n            <span class="attachment-chip-copy">\n              <span class="attachment-chip-name" title="Shot.png">Shot.png</span>\n              <span class="attachment-chip-meta">paste - 320x200</span>\n            </span>\n            <button class="attachment-chip-remove" type="button" data-attachment-remove="img-1" aria-label="Remove Shot.png" title="Remove attachment">x</button>\n          </div>\n          <div class="attachment-chip" data-attachment-id="file-1">\n            \n            <span class="attachment-chip-copy">\n              <span class="attachment-chip-name" title="notes.txt">notes.txt</span>\n              <span class="attachment-chip-meta">2 KB</span>\n            </span>\n            <button class="attachment-chip-remove" type="button" data-attachment-remove="file-1" aria-label="Remove notes.txt" title="Remove attachment">x</button>\n          </div><button class="attachment-chip attachment-chip-clear" type="button" data-attachment-clear="true" title="Remove all attachments" aria-label="Clear all attachments">Clear all</button>';

function trayEntries() {
  return [
    { id: 'img-1', kind: 'image', displayName: 'Shot.png', assetPath: 'C:/attachments/shot.png', sourceKind: 'clipboard', width: 320, height: 200 },
    { id: 'file-1', kind: 'file', displayName: 'notes.txt', sizeBytes: 2048 },
  ];
}

test('pane 0\'s tray render is today\'s markup; a pane target renders its own queue and skips an unchanged rebuild', () => {
  const dom = new JSDOM('<div id="v"><div id="t" class="attachment-tray hidden"></div><div id="n"></div></div>'
    + '<div id="p1" class="chat-pane"><div id="t1" class="attachment-tray hidden"></div></div>');
  const d = dom.window.document;
  const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const live = trayEntries();
  const state = { attachments: { queued: live, dragDepth: 0 } };
  const controller = createSidebarController({ state, dom: { chatView: d.getElementById('v'), attachmentTray: d.getElementById('t'), attachmentNotice: d.getElementById('n') }, callbacks: { escapeHtml: esc } });
  controller.renderAttachmentTray();
  assert.equal(d.getElementById('t').innerHTML, TODAY_TRAY_HTML);
  assert.equal(d.getElementById('t').className, 'attachment-tray');

  const paneQueue = [trayEntries()[1]];
  const target = { tray: d.getElementById('t1'), notice: null, chatView: d.getElementById('p1'), queued: paneQueue, dragDepth: 1 };
  controller.renderAttachmentTray(target);
  const tray1 = d.getElementById('t1');
  assert.equal(tray1.className, 'attachment-tray');
  assert.deepEqual([...tray1.querySelectorAll('[data-attachment-id]')].map((node) => node.dataset.attachmentId), ['file-1']);
  assert.equal(d.getElementById('p1').classList.contains('chat-drop-active'), true);
  assert.equal(d.getElementById('v').classList.contains('chat-drop-active'), false, 'pane 0\'s view untouched');
  assert.equal(d.getElementById('t').innerHTML, TODAY_TRAY_HTML, 'pane 0\'s tray untouched');
  const chip = tray1.firstElementChild;
  controller.renderAttachmentTray({ ...target, queued: paneQueue.slice() });
  assert.equal(tray1.firstElementChild, chip, 'the same ids and drag depth keep the tray nodes');
  controller.renderAttachmentTray({ ...target, queued: [], dragDepth: 0 });
  assert.equal(tray1.innerHTML, '');
  assert.equal(tray1.classList.contains('hidden'), true);
  assert.equal(d.getElementById('p1').classList.contains('chat-drop-active'), false);
});

test('the drop treatment keys off a pane root only; nothing keys off the whole view (W3-1)', () => {
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'styles', 'chat-composer.css'), 'utf8');
  const start = css.indexOf('.chat-pane.chat-drop-active .composer::after');
  assert.notEqual(start, -1, 'precondition: the pane drop treatment exists');
  const selector = css.slice(css.lastIndexOf('}', start) + 1, css.indexOf('{', start)).split(',').map((part) => part.trim());
  assert.deepEqual(selector, ['.chat-pane.chat-drop-active .composer::after'], 'one selector: #chatPane0 and pane 1 each light their own composer');
  assert.equal(css.includes('.chat-view.chat-drop-active'), false, 'a view-level highlight would light both panes');
});

test('the vision gate counts the queue it is handed (the sending pane\'s), defaulting to the live queue', () => {
  const { evaluateComposerVisionGate } = require('../renderer/chat/renderer-composer-vision-gate');
  const images = (count) => Array.from({ length: count }, (_, index) => ({ id: `img-${index}`, kind: 'image' }));
  const state = { attachments: { queued: images(0) } };
  assert.equal(evaluateComposerVisionGate({ state, runtimePreferences: {}, queued: images(2) }).imageCount, 2);
  assert.equal(evaluateComposerVisionGate({ state: { attachments: { queued: images(3) } }, runtimePreferences: {} }).imageCount, 3);
});

test('a second pane showing no session never opens an op on the live queue', (t) => {
  const { doc } = withDom(t);
  const calls = [];
  const deps = bindingDeps(doc, calls, { pane: true });
  deps.sessionContext = { ...deps.sessionContext, getSessionId: () => '' };
  const bindings = createAttachmentEventBindings(deps);
  bindings.bind();
  doc.getElementById('attach').click();
  assert.equal(calls.some((call) => call[0] === 'beginAttachmentToken'), false, 'no token for a blank pane');
  assert.deepEqual(calls.filter((call) => call[0] === 'handleAttachmentPicker').map((call) => call[1]), [null], 'the picker op carries no session');
  bindings.dispose();
});
