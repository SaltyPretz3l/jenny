'use strict';

/* renderer/app/renderer-app-pane-chrome.js on its own: the second pane's
 * composer sync, attachment tray + bindings, notice hosts, drafts and the
 * mount-time button/dom assembly, over a small jsdom fixture and fakes. The
 * composition-level behaviour stays covered by renderer-pane-composition*.test.js. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createPaneChrome } = require('../renderer/app/renderer-app-pane-chrome');

const FIXTURE = `<!doctype html><html><body>
  <div class="chat-pane" id="zero" data-pane-id="0">
    <div id="composerAttachmentPreviewPill" data-composer-v2="on"></div>
    <div id="composerV2FailedSendNotice" data-composer-v2="on"></div>
    <div data-chat-node="attachmentTray" data-composer-v2="on"></div>
  </div>
  <div class="chat-pane" id="one" data-pane-id="1">
    <div class="composer">
      <div class="composer-toolbar-left"></div>
      <div class="composer-toolbar-right"></div>
      <textarea id="input"></textarea>
      <div data-chat-node="attachmentTray"></div>
    </div>
    <div data-chat-node="composerAttachmentPreviewPill"></div>
    <div data-chat-node="composerStatusNotice"></div>
    <div data-chat-node="composerV2FailedSendNotice"></div>
    <div class="hero-stack"></div>
  </div>
</body></html>`;

function makeRig(t, overrides = {}) {
  const dom = new JSDOM(FIXTURE);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const calls = [];
  const sessions = { 1: 'b' };
  const state = { backend: { phase: 'ready' }, auth: { authenticated: true } };
  const callTable = Object.assign({
    isSessionStreaming: () => false,
    hasPendingToolApproval: () => false,
    getQueuedAttachments: () => [],
    countQueuedSends: () => 0,
    getSendLifecycle: () => 'idle',
  }, overrides.calls);
  const panes = new Map();
  const options = Object.assign({}, overrides.options);
  const chrome = createPaneChrome({
    state,
    layoutController: { createSessionContext: (paneId) => ({ paneId }) },
    options,
    root: overrides.root || {},
    doc,
    jt: (key, fallback, params) => (params ? String(fallback).replace('{count}', params.count) : fallback),
    actionButton: (opts) => `<button class="${opts.className}" aria-label="${opts.ariaLabel}"${opts.dataset ? ` data-chat-node="${opts.dataset['chat-node']}"` : ''}></button>`,
    call: (name, ...args) => {
      calls.push([name, ...args]);
      return typeof callTable[name] === 'function' ? callTable[name](...args) : undefined;
    },
    paneDrafts: overrides.paneDrafts || null,
    panes,
    paneSessionId: (paneId) => sessions[paneId] || '',
    pane0Root: () => doc.getElementById('zero'),
  });
  const rootEl = doc.getElementById('one');
  const pane = { paneId: 1, root: rootEl, composer: rootEl.querySelector('.composer') };
  return { chrome, doc, calls, state, panes, pane, rootEl, options };
}

function buildPane(rig) {
  const paneDom = {
    chatInput: rig.doc.getElementById('input'),
    attachmentTray: rig.rootEl.querySelector('[data-chat-node="attachmentTray"]'),
    composerWrap: rig.pane.composer,
  };
  const toolbarRight = rig.chrome.buildComposerNodes(rig.pane, paneDom);
  return { toolbarRight, paneDom };
}

test('buildComposerNodes inserts Stop/Send/Attach, the notice hosts, the queued span and the dom bag', (t) => {
  const rig = makeRig(t);
  const { toolbarRight, paneDom } = buildPane(rig);
  assert.equal(toolbarRight, rig.rootEl.querySelector('.composer-toolbar-right'));
  assert.deepEqual(Array.from(toolbarRight.children).map((el) => el.className), ['composer-stop-button hidden', 'composer-send']);
  assert.equal(rig.pane.stopButton, toolbarRight.children[0]);
  assert.equal(rig.pane.sendButton, toolbarRight.children[1]);
  assert.equal(rig.pane.attachButton.dataset.chatNode, 'composerAttachShortcut');
  assert.equal(rig.pane.queuedNotice.className, 'chat-pane-queued');
  assert.equal(rig.pane.queuedNotice.hidden, true);
  assert.equal(rig.pane.queuedNotice.parentElement, rig.rootEl.querySelector('.composer-toolbar-left'));
  assert.ok(rig.pane.notices.pill && rig.pane.notices.status && rig.pane.notices.failed);
  // The tray mirrors pane 0's composer-v2 flag.
  assert.equal(paneDom.attachmentTray.dataset.composerV2, 'on');
  assert.equal(rig.pane.dom.chatView, rig.rootEl);
  assert.equal(rig.pane.dom.sendButton, rig.pane.sendButton);
  assert.equal(rig.pane.dom.stopStreamButton, rig.pane.stopButton);
  assert.equal(rig.pane.dom.composerAttachShortcut, rig.pane.attachButton);
  assert.equal(rig.pane.dom.heroStack, rig.rootEl.querySelector('.hero-stack'));
  assert.equal(rig.pane.dom.jumpToBottomButton, null);
  assert.equal(rig.pane.dom.chatInput, paneDom.chatInput);
});

test('syncPaneComposer drives Send/Stop/queued copy from the pane session', (t) => {
  const rig = makeRig(t, { calls: { isSessionStreaming: () => true, countQueuedSends: () => 2, getSendLifecycle: () => 'sending' } });
  buildPane(rig);
  rig.pane.dom.chatInput.value = 'hello';
  rig.chrome.syncPaneComposer(rig.pane);
  assert.equal(rig.pane.sendButton.textContent, 'Queue');
  assert.equal(rig.pane.sendButton.disabled, false);
  assert.ok(rig.pane.sendButton.classList.contains('composer-send-queue'));
  assert.ok(!rig.pane.stopButton.classList.contains('hidden'));
  assert.equal(rig.pane.stopButton.disabled, false);
  assert.equal(rig.pane.queuedNotice.textContent, '2 queued');
  assert.equal(rig.pane.queuedNotice.hidden, false);
  assert.equal(rig.pane.composer.dataset.sendLifecycle, 'sending');
  assert.ok(rig.calls.some(([name, arg]) => name === 'renderComposerStatusNotice' && arg.sessionId === 'b' && arg.node === rig.pane.notices.status));
});

test('syncPaneComposer disables Send without a draft, enables it for a queued file, and honours offline/auth/approval', (t) => {
  const rig = makeRig(t);
  buildPane(rig);
  rig.chrome.syncPaneComposer(rig.pane);
  assert.equal(rig.pane.sendButton.disabled, true, 'empty draft, no files');
  assert.equal(rig.pane.sendButton.textContent, '↑');
  assert.ok(rig.pane.stopButton.classList.contains('hidden'));
  rig.state.backend.phase = 'ready';
  const filesRig = makeRig(t, { calls: { getQueuedAttachments: () => [{ id: 'f' }] } });
  buildPane(filesRig);
  filesRig.chrome.syncPaneComposer(filesRig.pane);
  assert.equal(filesRig.pane.sendButton.disabled, false, 'a queued file enables Send');

  rig.pane.dom.chatInput.value = 'x';
  rig.state.backend.phase = 'failed';
  rig.chrome.syncPaneComposer(rig.pane);
  assert.equal(rig.pane.dom.chatInput.disabled, true, 'offline disables the input');
  rig.state.backend.phase = 'starting';
  rig.chrome.syncPaneComposer(rig.pane);
  assert.equal(rig.pane.dom.chatInput.disabled, false, 'a preparing backend is not offline');
  assert.equal(rig.pane.sendButton.disabled, true, 'but Send waits for a usable backend');
  rig.state.backend.phase = 'ready';
  rig.state.auth.authenticated = false;
  rig.chrome.syncPaneComposer(rig.pane);
  assert.equal(rig.pane.dom.chatInput.disabled, true);
  rig.state.auth.authenticated = true;
  const approvalRig = makeRig(t, { calls: { hasPendingToolApproval: () => true } });
  buildPane(approvalRig);
  approvalRig.pane.dom.chatInput.value = 'x';
  approvalRig.chrome.syncPaneComposer(approvalRig.pane);
  assert.equal(approvalRig.pane.dom.chatInput.disabled, true);
  assert.equal(approvalRig.pane.sendButton.disabled, true);
});

test('syncPaneComposer ignores a missing pane or input and syncs the rail once when present', (t) => {
  const rig = makeRig(t);
  assert.doesNotThrow(() => rig.chrome.syncPaneComposer(null));
  buildPane(rig);
  const synced = [];
  rig.pane.rail = { sync: (arg) => synced.push(arg) };
  rig.chrome.syncPaneComposer(rig.pane);
  assert.deepEqual(synced, [{ offline: false, authenticated: true }]);
});

test('syncPaneAttachments renders the tray from the session queue and carries the drag depth', (t) => {
  const queue = [{ id: 'f1' }];
  const rig = makeRig(t, { calls: { getQueuedAttachments: () => queue } });
  buildPane(rig);
  rig.pane.dragDepth = 1;
  rig.chrome.syncPaneAttachments(rig.pane);
  const render = rig.calls.find(([name]) => name === 'renderAttachmentTray')[1];
  assert.equal(render.tray, rig.pane.dom.attachmentTray);
  assert.equal(render.notice, null);
  assert.equal(render.chatView, rig.rootEl);
  assert.equal(render.queued, queue);
  assert.equal(render.dragDepth, 1);
  assert.equal(render.sessionId, 'b');
  const noTray = { paneId: 1, dom: {}, root: rig.rootEl };
  const before = rig.calls.length;
  rig.chrome.syncPaneAttachments(noTray);
  assert.equal(rig.calls.length, before, 'no tray renders nothing');
});

test('createPaneAttachments binds through the injected utils with pane-scoped callbacks, else returns null', (t) => {
  const bound = [];
  let received = null;
  const utils = {
    createAttachmentEventBindings(config) {
      received = config;
      return { bind: () => bound.push('bind'), dispose() {} };
    },
  };
  const rig = makeRig(t, { options: { attachmentEventUtils: utils, attachmentCallbacks: { queueFiles() {} }, TOAST_SOURCE: { A: 1 } } });
  buildPane(rig);
  const bindings = rig.chrome.createPaneAttachments(rig.pane);
  assert.ok(bindings);
  assert.deepEqual(bound, ['bind']);
  assert.deepEqual(received.sessionContext, { paneId: 1 });
  assert.deepEqual(received.constants, { TOAST_SOURCE: { A: 1 } });
  assert.equal(received.dom.chatView, rig.rootEl);
  assert.equal(typeof received.callbacks.queueFiles, 'function', 'the injected queue callbacks pass through');
  received.callbacks.setDropActive(true);
  assert.equal(rig.pane.dragDepth, 1);
  received.callbacks.setDropActive(false);
  assert.equal(rig.pane.dragDepth, 0);
  assert.ok(rig.calls.filter(([name]) => name === 'renderAttachmentTray').length >= 2);
  received.callbacks.renderAttachmentTray();
  assert.ok(rig.calls.some(([name]) => name === 'renderComposerStatusNotice'), 'renderAttachmentTray re-syncs the whole composer');

  const bare = makeRig(t, { options: { attachmentEventUtils: utils } });
  buildPane(bare);
  assert.equal(bare.chrome.createPaneAttachments(bare.pane), null, 'no callbacks, no bindings');
});

test('mountPaneNotices mirrors pane 0 composer-v2: pill and failed-send notice only where pane 0 has them on', (t) => {
  const created = [];
  const render = { createComposerAttachmentTrayPreviewRenderer: (cfg) => { created.push(cfg); return { destroy() {} }; } };
  const rig = makeRig(t, {
    options: { composerV2Render: render },
    calls: { mountFailedSendNotice: (cfg) => ({ cfg, destroy() {} }) },
  });
  buildPane(rig);
  rig.pane.dom.chatTimeline = rig.doc.createElement('div');
  rig.pane.shell = { id: 'shell' };
  const getSessionId = () => 'b';
  rig.chrome.mountPaneNotices(rig.pane, getSessionId);
  assert.equal(rig.pane.notices.pill.dataset.composerV2, 'on');
  assert.equal(created.length, 1);
  assert.equal(created[0].tray, rig.pane.dom.attachmentTray);
  assert.equal(created[0].pill, rig.pane.notices.pill);
  const mounted = rig.calls.find(([name]) => name === 'mountFailedSendNotice')[1];
  assert.equal(mounted.noticeNode, rig.pane.notices.failed);
  assert.equal(mounted.chatThread, rig.pane.dom.chatTimeline);
  assert.equal(mounted.getSessionId, getSessionId);
  assert.equal(mounted.getShellController(), rig.pane.shell);
  assert.ok(rig.pane.failedSendNotice);

  const off = makeRig(t, { options: { composerV2Render: render } });
  buildPane(off);
  off.doc.getElementById('composerAttachmentPreviewPill').dataset.composerV2 = 'off';
  off.doc.getElementById('composerV2FailedSendNotice').dataset.composerV2 = 'off';
  off.pane.dom.chatTimeline = off.doc.createElement('div');
  off.chrome.mountPaneNotices(off.pane, () => 'b');
  assert.equal(off.pane.previewPill, undefined);
  assert.equal(off.pane.failedSendNotice, undefined);
  assert.equal(created.length, 1, 'pane 0 off: no second pill renderer');

  const throwing = makeRig(t, { options: { composerV2Render: { createComposerAttachmentTrayPreviewRenderer: () => { throw new Error('boom'); } } } });
  buildPane(throwing);
  throwing.chrome.mountPaneNotices(throwing.pane, () => 'b');
  assert.equal(throwing.pane.previewPill, null, 'a throwing renderer leaves no pill');
});

test('resolvePaneNotices finds the hosts inside the pane root only', (t) => {
  const rig = makeRig(t);
  const notices = rig.chrome.resolvePaneNotices(rig.rootEl);
  assert.equal(notices.pill, rig.rootEl.querySelector('[data-chat-node="composerAttachmentPreviewPill"]'));
  assert.equal(notices.status, rig.rootEl.querySelector('[data-chat-node="composerStatusNotice"]'));
  assert.equal(notices.failed, rig.rootEl.querySelector('[data-chat-node="composerV2FailedSendNotice"]'));
  const empty = rig.chrome.resolvePaneNotices(rig.doc.getElementById('zero'));
  assert.deepEqual(empty, { pill: null, status: null, failed: null });
});

function draftRig(t) {
  const store = new Map();
  const captured = [];
  const rebinds = [];
  const controller = {
    capturePaneDraft: (id, input) => { captured.push([id, input.value]); store.set(id, input.value); },
    restorePaneDraft: (id, input) => { input.value = store.get(id) || ''; },
  };
  const paneDrafts = { rebindLive: (ctl, prev, next) => rebinds.push([ctl === controller, prev, next]) };
  const rig = makeRig(t, { paneDrafts, options: { getComposerSessionState: () => controller } });
  buildPane(rig);
  return Object.assign(rig, { store, captured, rebinds, controller });
}

test('showPaneDraft restores the incoming session draft once, keeps text on a rekey, and autosizes', (t) => {
  const rig = draftRig(t);
  rig.store.set('b', 'draft B');
  rig.chrome.showPaneDraft(rig.pane, 'b');
  assert.equal(rig.pane.draftSessionId, 'b');
  assert.equal(rig.pane.dom.chatInput.value, 'draft B');
  assert.equal(rig.pane.dom.chatInput.style.height, 'auto', 'jsdom has no layout, so a zero scrollHeight leaves auto');
  rig.pane.dom.chatInput.value = 'edited';
  rig.chrome.showPaneDraft(rig.pane, 'b');
  assert.equal(rig.pane.dom.chatInput.value, 'edited', 'the same session does not restore again');
  rig.chrome.showPaneDraft(rig.pane, 'b2', 'rekey');
  assert.equal(rig.pane.draftSessionId, 'b2');
  assert.equal(rig.pane.dom.chatInput.value, 'edited', 'a rekey keeps the text');
  rig.chrome.showPaneDraft(null, 'x');
});

test('handOffDrafts captures pane 1 before pane 0 rebinds, and skips reset, rekey and a missing prev', (t) => {
  const rig = draftRig(t);
  rig.panes.set(1, rig.pane);
  rig.pane.draftSessionId = 'b';
  rig.pane.dom.chatInput.value = 'typed in B';
  const prev = { panes: [{ sessionId: 'a' }, { sessionId: 'b' }] };
  const next = { panes: [{ sessionId: 'b' }, { sessionId: 'a' }] };
  rig.chrome.handOffDrafts(prev, next, 'swap');
  assert.deepEqual(rig.captured, [['b', 'typed in B']]);
  assert.deepEqual(rig.rebinds, [[true, 'a', 'b']]);

  rig.chrome.handOffDrafts(prev, next, 'reset');
  rig.chrome.handOffDrafts(prev, next, 'rekey');
  rig.chrome.handOffDrafts(null, next, 'swap');
  assert.equal(rig.rebinds.length, 1);
  // Pane 1 keeping its session captures nothing.
  rig.chrome.handOffDrafts(prev, { panes: [{ sessionId: 'c' }, { sessionId: 'b' }] }, 'replace');
  assert.equal(rig.captured.length, 1);
  assert.deepEqual(rig.rebinds[1], [true, 'a', 'c']);
});

test('composerDrafts is null without the drafts module or a controller that can capture', (t) => {
  const none = makeRig(t, { options: { getComposerSessionState: () => ({}) }, paneDrafts: {} });
  assert.equal(none.chrome.composerDrafts(), null);
  const noModule = makeRig(t, { options: { getComposerSessionState: () => ({ capturePaneDraft() {} }) } });
  assert.equal(noModule.chrome.composerDrafts(), null);
  const globalController = { capturePaneDraft() {} };
  const viaRoot = makeRig(t, { paneDrafts: {}, root: { rendererComposerSessionStateController: globalController } });
  assert.equal(viaRoot.chrome.composerDrafts(), globalController);
});

test('autosizeInput sizes to scrollHeight and tolerates a missing input', (t) => {
  const rig = makeRig(t);
  const input = { style: { height: '12px' }, scrollHeight: 96 };
  rig.chrome.autosizeInput(input);
  assert.equal(input.style.height, '96px');
  const empty = { style: {}, scrollHeight: 0 };
  rig.chrome.autosizeInput(empty);
  assert.equal(empty.style.height, 'auto');
  assert.doesNotThrow(() => rig.chrome.autosizeInput(null));
  assert.doesNotThrow(() => rig.chrome.autosizeInput({}));
});

test('insertButton appends to the host and returns the new node, null without a host or a builder', (t) => {
  const rig = makeRig(t);
  const host = rig.rootEl.querySelector('.composer-toolbar-left');
  const button = rig.chrome.insertButton(host, { className: 'x', ariaLabel: 'X' });
  assert.equal(button, host.lastElementChild);
  assert.equal(button.className, 'x');
  assert.equal(rig.chrome.insertButton(null, { className: 'x' }), null);
});
