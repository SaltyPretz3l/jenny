'use strict';

/* Split view W2-3 -- the chat event bindings of a pane that is not pane 0.
 *
 * createChatEventBindings registers ONE listener set per call. Pane 0 keeps
 * today's full set in today's order (pinned below, byte-for-byte). A second
 * pane (sessionContext.paneId !== 0) registers only the pane-scoped listeners
 * -- its composer, its thread scroll, its root wheel, its timeline delegation --
 * and never the document-level ones (auth/backend/log IPC, home, window
 * controls, New chat, jump buttons, the command popover, window keydown, the
 * settings chrome, the keyboard help and search overlays). Pane 1's shell dom
 * is `{ ...pane 0's surface dom, ...pane 1's nodes }`, so pane 0's
 * document-level nodes ARE in its bag: the guards, not a null node, keep them
 * pane 0's. The harness below builds exactly that shape.
 *
 * The sibling factories are recording stubs (their own suites cover their
 * internals); the real registerListener, dispose and guards run in a vm.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const asyncFence = require('../renderer/shared/async-fence');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'renderer/chat/renderer-chat-event-utils.js'), 'utf8');

const DOCUMENT_NODES = [
  'homeNavButton', 'newChatButton', 'jumpToTopButton', 'jumpToLastPromptButton', 'jumpToBottomButton',
  'composerCommandPopover', 'toastViewport', 'composerModelSelect', 'composerEffortSelect',
  'artifactReviewPanel',
];

function buildHarness(t, { paneId, coordinator = false, rail = false } = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    ${DOCUMENT_NODES.map((id) => `<div id="${id}"></div>`).join('')}
    <div id="chatView">
      <div id="chatThreadScroll"><div id="chatTimeline"></div></div>
      <div id="chatSelectionOverlayHost" hidden></div>
      <div id="composerWrap"><textarea id="chatInput"></textarea><button id="sendButton"></button><button id="stopStreamButton"></button>
        ${rail ? '<div id="paneRunModeSlot"></div><select id="paneModelSelect"></select><select id="paneEffortSelect"></select>' : ''}</div>
    </div></body>`);
  const { window } = dom;
  const doc = window.document;
  t.after(() => window.close());
  const log = [];
  const live = [];
  const wireCalls = [];
  const nameOf = (target) => (target === window ? 'window' : target === doc ? 'document' : target.id || target.nodeName);
  const proto = window.EventTarget.prototype;
  const originalAdd = proto.addEventListener;
  const originalRemove = proto.removeEventListener;
  proto.addEventListener = function add(type, handler, options) {
    const entry = { name: `${nameOf(this)}:${type}`, target: this, type, handler, signal: options && options.signal, removed: false };
    log.push(entry.name);
    live.push(entry);
    return originalAdd.call(this, type, handler, options);
  };
  proto.removeEventListener = function remove(type, handler, options) {
    live.filter((entry) => entry.target === this && entry.type === type && entry.handler === handler)
      .forEach((entry) => { entry.removed = true; });
    return originalRemove.call(this, type, handler, options);
  };
  t.after(() => { proto.addEventListener = originalAdd; proto.removeEventListener = originalRemove; });

  const subscribe = (name) => () => { log.push(`shell.${name}`); return () => log.push(`shell.${name}.off`); };
  window.jennyShell = {
    system: { onStats: subscribe('system.onStats') },
    diagnostics: { logs: { onEntry: subscribe('logs.onEntry') } },
    backend: { onStatus: subscribe('backend.onStatus') },
    lifecycle: { onProgress: subscribe('lifecycle.onProgress') },
    auth: { getState: async () => ({ authenticated: true }), onState: subscribe('auth.onState') },
  };
  window.rendererPlanUsageMeter = {
    install: () => { log.push('planUsage.install'); return () => {}; },
    dispose: () => log.push('planUsage.dispose'),
  };
  const noop = () => {};
  const context = {
    console,
    AbortController: window.AbortController,
    document: doc,
    window,
    requestAnimationFrame: (cb) => window.setTimeout(cb, 0),
    cancelAnimationFrame: (id) => window.clearTimeout(id),
    rendererAsyncFence: asyncFence,
    rendererChatEventTranscriptBindings: {
      createTranscriptEventBindings: (deps) => ({
        bindTranscriptEvents(register, options) {
          log.push('transcript.bind');
          register(deps.chatTimeline, 'click', noop, options);
        },
        dispose() { log.push('transcript.dispose'); },
      }),
    },
    rendererChatEventSettingsBindings: {
      createSettingsEventBindings: (deps) => Object.assign({
        bindSettingsEvents(register, options) {
          log.push('settings.bind');
          register(deps.toastViewport, 'click', noop, options);
        },
      }, rail ? {
        // W2-2a: the rail listeners a pane binds on its own nodes.
        bindComposerRailEvents({ registerListener, listenerOptions, dom, getSessionId }) {
          log.push(`settings.rail:${getSessionId()}`);
          registerListener(dom.composerModelSelect, 'change', noop, listenerOptions);
          registerListener(dom.composerEffortSelect, 'change', noop, listenerOptions);
          registerListener(dom.composerRunModeSlot, 'click', noop, listenerOptions);
        },
      } : {}),
    },
    rendererChatEventInteractiveBindings: {
      bindComposerContextMenu({ chatInput, registerListener, listenerOptions }) {
        registerListener(chatInput, 'contextmenu', noop, listenerOptions);
      },
      bindInteractiveComposerEvents({ interactiveDelegateRoot, registerListener, listenerOptions }) {
        registerListener(interactiveDelegateRoot, 'input', noop, listenerOptions);
      },
    },
    rendererChatBackendRecoveryUtils: { recoverInflightSendsForUnusableBackend() {} },
    rendererRenderPipelineThreadStateUtils: { clearThreadBranchCollapseState() {} },
    rendererEnterKeydownUtils: require('../renderer/chat/renderer-enter-keydown-utils'),
    rendererChatCtrlWheelGate: require('../renderer/chat/renderer-chat-ctrl-wheel-gate'),
    rendererContextMeterDetails: { dispose: () => log.push('contextMeter.dispose') },
    rendererComposerSessionStateController: {
      captureActive: (sessionId, reason) => log.push(`captureActive:${sessionId}:${reason}`),
      capturePaneDraft: (sessionId, input) => log.push(`capturePaneDraft:${sessionId}:${input.id}`),
    },
    rendererChatAccessibilityWiring: {
      wireChatAccessibility(options) {
        wireCalls.push(options);
        log.push(`accessibility:${options.documentLevel === false ? 'pane' : 'document'}:${options.selectionOverlayHost ? options.selectionOverlayHost.id : 'none'}`);
        options.registerListener(options.chatTimeline, 'keydown', noop, options.listenerOptions);
        return { helpOverlay: { open: () => log.push('helpOverlay.open') } };
      },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(SOURCE, context, { filename: 'renderer-chat-event-utils.js' });

  const byId = (id) => doc.getElementById(id);
  const domBag = {};
  [...DOCUMENT_NODES, 'chatView', 'chatThreadScroll', 'chatTimeline', 'composerWrap', 'chatInput', 'sendButton', 'stopStreamButton']
    .forEach((id) => { domBag[id] = byId(id); });
  if (paneId !== 0) domBag.chatSelectionOverlayHost = byId('chatSelectionOverlayHost');
  if (rail === 'own-nodes') Object.assign(domBag, { composerModelSelect: byId('paneModelSelect'), composerEffortSelect: byId('paneEffortSelect'), composerRunModeSlot: byId('paneRunModeSlot') });
  const callbacks = new Proxy({
    setActivityChangeListener: (fn) => log.push(fn ? 'activity.set' : 'activity.clear'),
    handleSend: async () => { log.push('handleSend'); },
  }, { get: (target, key) => (key in target ? target[key] : () => undefined) });
  const bindings = context.rendererChatEventUtils.createChatEventBindings({
    state: { ui: { activeView: 'chat' }, currentSessionId: 'session-a' },
    sessionContext: { paneId, getSessionId: () => (paneId === 0 ? 'session-a' : 'session-b'), setSessionId() {}, isCurrent: () => false },
    constants: { TOAST_SOURCE: { memory: 'memory', chatStream: 'chat' }, ACTIVITY_SCOPE: {} },
    dom: domBag,
    callbacks,
    controllers: {
      thinkingController: { prune() {}, resumeAutoScroll() {} },
      toastActionHandlers: new Map(),
      chatScrollCoordinator: coordinator
        ? { attach({ registerListener, listenerOptions }) { log.push('scroll.attach'); registerListener(byId('chatThreadScroll'), 'scroll', noop, listenerOptions); return () => {}; } }
        : null,
    },
  });
  return { window, doc, log, live, bindings, byId, wireCalls };
}

// Today's pane-0 set, in today's order (2026-09-25, base 615977570; the window
// cluster left it 2026-09-29: the shell binds it at load).
const PANE_ZERO_SET = [
  'activity.set',
  'planUsage.install',
  'document:visibilitychange',
  'shell.logs.onEntry',
  'shell.backend.onStatus',
  'shell.lifecycle.onProgress',
  'shell.auth.onState',
  'homeNavButton:click',
  'newChatButton:click',
  'sendButton:click',
  'stopStreamButton:click',
  'jumpToTopButton:click',
  'jumpToLastPromptButton:click',
  'jumpToBottomButton:click',
  'chatInput:keydown',
  'chatInput:input',
  'chatInput:paste',
  'chatInput:contextmenu',
  'composerCommandPopover:click',
  'chatThreadScroll:scroll',
  // timeline-perf 2026-09-30: the Ctrl-held tracker replaces the always-on
  // non-passive chatView wheel listener (attached only while Ctrl is down).
  'window:keydown',
  'window:keyup',
  'window:blur',
  'window:pointermove',
  'window:wheel',
  'window:keydown',
  'composerWrap:click',
  'chatTimeline:input',
  'transcript.bind',
  'chatTimeline:click',
  'settings.bind',
  'toastViewport:click',
  'accessibility:document:none',
  'chatTimeline:keydown',
];

// The pane set: its composer, its scroll, its root wheel, its timeline.
const PANE_ONE_SET = [
  'sendButton:click',
  'stopStreamButton:click',
  'chatInput:keydown',
  'chatInput:input',
  'chatInput:paste',
  'chatInput:contextmenu',
  'chatThreadScroll:scroll',
  'chatView:wheel',
  'composerWrap:click',
  'chatTimeline:input',
  'transcript.bind',
  'chatTimeline:click',
  'accessibility:pane:chatSelectionOverlayHost',
  'chatTimeline:keydown',
];

test('paneId 0 registers today\'s full listener set in today\'s order', (t) => {
  const { log, bindings } = buildHarness(t, { paneId: 0 });
  bindings.bind();
  assert.deepEqual(log, PANE_ZERO_SET);
});

test('paneId 1 registers the pane set only: no IPC, no home/new-chat/jump/popover/window listeners, no settings chrome', (t) => {
  const { log, bindings } = buildHarness(t, { paneId: 1 });
  bindings.bind();
  assert.deepEqual(log, PANE_ONE_SET);
});

// CTR-005: the search overlay resolves the session of the pane it searches.
test('each pane hands the accessibility wiring its own session id and the per-session message reader', (t) => {
  for (const [paneId, sessionId] of [[0, 'session-a'], [1, 'session-b']]) {
    const { bindings, wireCalls } = buildHarness(t, { paneId });
    bindings.bind();
    assert.equal(wireCalls.length, 1);
    assert.equal(wireCalls[0].getSessionId(), sessionId);
    assert.equal(typeof wireCalls[0].getSessionMessages, 'function');
  }
});

test('paneId 1 attaches its own scroll coordinator (the pane thread scroll), like pane 0', (t) => {
  const { log, bindings } = buildHarness(t, { paneId: 1, coordinator: true });
  bindings.bind();
  assert.deepEqual(log.slice(0, 2), ['scroll.attach', 'chatThreadScroll:scroll']);
  assert.equal(log.filter((entry) => entry === 'chatThreadScroll:scroll').length, 1, 'the coordinator replaces the legacy scroll listener');
});

test('paneId 1 dispose removes every listener it registered and never clears pane 0\'s document-level singletons', (t) => {
  const { log, live, bindings } = buildHarness(t, { paneId: 1 });
  bindings.bind();
  assert.ok(live.length > 0);
  log.length = 0;
  bindings.dispose();
  const leaked = live.filter((entry) => !entry.removed && !(entry.signal && entry.signal.aborted)).map((entry) => entry.name);
  assert.deepEqual(leaked, [], 'every pane-1 listener is gone after dispose');
  assert.deepEqual(log, ['transcript.dispose'], 'no activity-listener clear, no context-meter or plan-usage dispose');
});

test('paneId 0 dispose keeps today\'s teardown (activity listener cleared, meters disposed)', (t) => {
  const { log, bindings } = buildHarness(t, { paneId: 0 });
  bindings.bind();
  log.length = 0;
  bindings.dispose();
  assert.deepEqual(log.filter((entry) => !entry.startsWith('shell.')), ['contextMeter.dispose', 'planUsage.dispose', 'transcript.dispose', 'activity.clear']);
});

test('typing captures each pane through its own draft path', (t) => {
  const zero = buildHarness(t, { paneId: 0 });
  zero.bindings.bind();
  zero.byId('chatInput').dispatchEvent(new zero.window.Event('input'));
  assert.deepEqual(zero.log.filter((entry) => entry.startsWith('captureActive')), ['captureActive:session-a:input']);

  const one = buildHarness(t, { paneId: 1 });
  one.bindings.bind();
  one.byId('chatInput').dispatchEvent(new one.window.Event('input'));
  assert.deepEqual(one.log.filter((entry) => entry.startsWith('captureActive')), []);
  assert.deepEqual(one.log.filter((entry) => entry.startsWith('capturePaneDraft')), ['capturePaneDraft:session-b:chatInput']);
});

test('Enter in pane 1\'s composer sends through its own handleSend', (t) => {
  const { log, bindings, byId, window } = buildHarness(t, { paneId: 1 });
  bindings.bind();
  byId('chatInput').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(log.filter((entry) => entry === 'handleSend').length, 1);
});

// Split view W2-2a: pane 1 binds the three rail listeners (model change, effort
// change, run-mode chip click) on ITS rail nodes, at the settings point, with
// its own session; pane 0's pinned set above is unchanged.
test('paneId 1 binds the three rail listeners on its own rail nodes with its own session', (t) => {
  const { log, bindings } = buildHarness(t, { paneId: 1, rail: 'own-nodes' });
  bindings.bind();
  const at = PANE_ONE_SET.indexOf('chatTimeline:click') + 1;
  assert.deepEqual(log, [
    ...PANE_ONE_SET.slice(0, at),
    'settings.rail:session-b',
    'paneModelSelect:change',
    'paneEffortSelect:change',
    'paneRunModeSlot:click',
    ...PANE_ONE_SET.slice(at),
  ]);
});

test('paneId 1 without rail nodes of its own registers no rail listener on pane 0 selects', (t) => {
  // Pane 1's shell dom falls back to pane 0's document-level selects when its
  // rail was not built; the pane-scoped register must drop them.
  const { log, bindings } = buildHarness(t, { paneId: 1, rail: true });
  bindings.bind();
  const at = PANE_ONE_SET.indexOf('chatTimeline:click') + 1;
  assert.deepEqual(log, [...PANE_ONE_SET.slice(0, at), 'settings.rail:session-b', ...PANE_ONE_SET.slice(at)]);
});

test('paneId 0 with a rail-capable settings sibling keeps the pinned set (the rail binds inside bindSettingsEvents)', (t) => {
  const { log, bindings } = buildHarness(t, { paneId: 0, rail: true });
  bindings.bind();
  assert.deepEqual(log, PANE_ZERO_SET);
});

// timeline-perf 2026-09-30: the non-passive Ctrl+wheel zoom listener blocks
// compositor scrolling whenever it is attached, so it exists only while Ctrl
// is held. Pane 0 owns the window-level tracker; a pane bound standalone
// (no tracker) keeps the always-on listener, which the pane-1 set above pins.
test('paneId 0 attaches the non-passive wheel listener only while Ctrl is held', (t) => {
  const { window, log, live, bindings, byId } = buildHarness(t, { paneId: 0 });
  bindings.bind();
  assert.equal(log.includes('chatView:wheel'), false, 'no wheel listener before Ctrl');
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }));
  assert.equal(log.filter((name) => name === 'chatView:wheel').length, 1, 'Ctrl down attaches it');
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }));
  assert.equal(log.filter((name) => name === 'chatView:wheel').length, 1, 'a repeat keydown does not attach twice');
  let wheelEntry = live.find((entry) => entry.name === 'chatView:wheel');
  assert.equal(wheelEntry.removed, false);
  window.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Control', ctrlKey: false }));
  assert.equal(wheelEntry.removed, true, 'Ctrl up detaches it');
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }));
  window.dispatchEvent(new window.Event('blur'));
  wheelEntry = live.filter((entry) => entry.name === 'chatView:wheel').pop();
  assert.equal(wheelEntry.removed, true, 'a window blur while Ctrl is down releases it');
  // Ctrl held before the window had focus: the modifier on a pointer or wheel event re-syncs.
  window.dispatchEvent(new window.MouseEvent('pointermove', { ctrlKey: true, bubbles: true }));
  wheelEntry = live.filter((entry) => entry.name === 'chatView:wheel').pop();
  assert.equal(wheelEntry.removed, false, 'a Ctrl pointer move attaches it');
  window.dispatchEvent(new window.MouseEvent('pointermove', { ctrlKey: false, bubbles: true }));
  assert.equal(wheelEntry.removed, true, 'a pointer move without Ctrl releases it');
  window.dispatchEvent(new window.WheelEvent('wheel', { ctrlKey: true, deltaY: 10, bubbles: true }));
  wheelEntry = live.filter((entry) => entry.name === 'chatView:wheel').pop();
  assert.equal(wheelEntry.removed, false, 'a Ctrl wheel observed while detached attaches it for the next tick');
  window.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Control', ctrlKey: false }));
  // Bound again mid-hold, the listener is attached; dispose detaches it.
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }));
  wheelEntry = live.filter((entry) => entry.name === 'chatView:wheel').pop();
  assert.equal(wheelEntry.removed, false);
  bindings.dispose();
  assert.equal(wheelEntry.removed, true, 'dispose detaches the wheel listener');
  assert.ok(byId('chatView'));
});
