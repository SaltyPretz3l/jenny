'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createOverlayManager } = require('../renderer/shell/renderer-overlay-manager.js');
const { createCommandPaletteController } = require('../renderer/shell/renderer-command-palette.js');
const { createHelpOverlay } = require('../renderer/inventory/help-overlay.js');

function buildDom(bodyHtml) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${bodyHtml}</body></html>`);
  const doc = dom.window.document;
  // jsdom has no layout engine, so offsetParent is always null; the manager
  // (like help-overlay.js) uses offsetParent !== null as its visibility
  // filter, so every focusable fixture element needs it stubbed truthy.
  for (const el of doc.querySelectorAll('button, input, a, select, textarea, [tabindex]')) {
    Object.defineProperty(el, 'offsetParent', { value: {}, configurable: true });
  }
  return { dom, doc };
}

function dispatchKey(doc, key, opts) {
  const event = new doc.defaultView.KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...opts,
  });
  doc.dispatchEvent(event);
  return event;
}

// ── open/close lifecycle ────────────────────────────────────────────────

test('open/close lifecycle: open pushes an entry, close removes it', () => {
  const { doc } = buildDom('<div id="root"><button>x</button></div>');
  const manager = createOverlayManager({ documentRef: doc });
  const root = doc.getElementById('root');

  const opened = manager.open({ id: 'a', root, onRequestClose: () => {} });
  assert.equal(opened, true);
  assert.equal(manager.isOpen('a'), true);
  assert.equal(manager.isOpen(), true);
  assert.equal(manager.getDepth(), 1);

  const closed = manager.close('a');
  assert.equal(closed, true);
  assert.equal(manager.isOpen('a'), false);
  assert.equal(manager.isOpen(), false);
  assert.equal(manager.getDepth(), 0);

  // Closing an id that isn't on the stack is a no-op.
  assert.equal(manager.close('a'), false);
});

test('reopening the same id is a no-op that returns false', () => {
  const { doc } = buildDom('<div id="root"><button>x</button></div>');
  const manager = createOverlayManager({ documentRef: doc });
  const root = doc.getElementById('root');

  assert.equal(manager.open({ id: 'dup', root, onRequestClose: () => {} }), true);
  assert.equal(manager.open({ id: 'dup', root, onRequestClose: () => {} }), false);
  assert.equal(manager.getDepth(), 1);
});

test('inert targets are reference-counted and prior state is restored', () => {
  const { doc } = buildDom('<main id="app"></main><div id="a"></div><div id="b"></div>');
  const manager = createOverlayManager({ documentRef: doc });
  const app = doc.getElementById('app');
  const rootA = doc.getElementById('a');
  const rootB = doc.getElementById('b');

  app.setAttribute('inert', '');
  manager.open({ id: 'a', root: rootA, inertTargets: [app], onRequestClose: () => {} });
  manager.open({ id: 'b', root: rootB, inertTargets: [app], onRequestClose: () => {} });
  assert.equal(app.hasAttribute('inert'), true);

  manager.close('b');
  assert.equal(app.hasAttribute('inert'), true, 'inner close must not release the outer overlay lock');
  manager.close('a');
  assert.equal(app.hasAttribute('inert'), true, 'pre-existing inert state is restored');
});

test('dispose releases inert targets, clears the stack, and refuses later opens', () => {
  const { doc } = buildDom('<main id="app"></main><div id="root"></div>');
  const manager = createOverlayManager({ documentRef: doc });
  const app = doc.getElementById('app');
  const root = doc.getElementById('root');
  let closeRequests = 0;

  manager.open({ id: 'a', root, inertTargets: app, onRequestClose: () => { closeRequests += 1; } });
  assert.equal(app.hasAttribute('inert'), true);
  manager.dispose();
  manager.dispose();

  assert.equal(app.hasAttribute('inert'), false);
  assert.equal(manager.getDepth(), 0);
  dispatchKey(doc, 'Escape');
  assert.equal(closeRequests, 0, 'the capture listener is removed');
  assert.equal(manager.open({ id: 'later', root, onRequestClose: () => {} }), false);
});

test('open rejects entries missing required fields', () => {
  const { doc } = buildDom('<div id="root"></div>');
  const manager = createOverlayManager({ documentRef: doc });
  const root = doc.getElementById('root');

  assert.equal(manager.open({ root, onRequestClose: () => {} }), false); // no id
  assert.equal(manager.open({ id: 'x', onRequestClose: () => {} }), false); // no root
  assert.equal(manager.open({ id: 'x', root }), false); // no onRequestClose
  assert.equal(manager.getDepth(), 0);
});

// ── Escape: one layer at a time, innermost first ────────────────────────

test('Escape calls only the TOP entry\'s onRequestClose, one layer per keypress', () => {
  const { doc } = buildDom('<div id="rootA"><button>a</button></div><div id="rootB"><button>b</button></div>');
  const manager = createOverlayManager({ documentRef: doc });
  const rootA = doc.getElementById('rootA');
  const rootB = doc.getElementById('rootB');

  const closeOrder = [];
  manager.open({ id: 'a', root: rootA, onRequestClose: () => closeOrder.push('a') });
  manager.open({ id: 'b', root: rootB, onRequestClose: () => closeOrder.push('b') });

  // First Escape: only the top (b) is asked to close. The owner performs the
  // close by calling manager.close(id) itself, mirroring real usage.
  dispatchKey(doc, 'Escape');
  assert.deepEqual(closeOrder, ['b']);
  manager.close('b');
  assert.equal(manager.getDepth(), 1);

  // Second Escape: now a is top and gets asked.
  dispatchKey(doc, 'Escape');
  assert.deepEqual(closeOrder, ['b', 'a']);
  manager.close('a');
  assert.equal(manager.getDepth(), 0);
});

test('Escape is ignored when the event is already defaultPrevented', () => {
  const { doc } = buildDom('<div id="root"><button>x</button></div>');
  const manager = createOverlayManager({ documentRef: doc });
  const root = doc.getElementById('root');
  let calls = 0;
  manager.open({ id: 'a', root, onRequestClose: () => { calls += 1; } });

  const event = new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  event.preventDefault(); // simulates an earlier-registered capture listener preempting
  doc.dispatchEvent(event);

  assert.equal(calls, 0);
  assert.equal(manager.getDepth(), 1);
});

test('Escape is ignored during IME composition (isComposing)', () => {
  const { doc } = buildDom('<div id="root"><button>x</button></div>');
  const manager = createOverlayManager({ documentRef: doc });
  const root = doc.getElementById('root');
  let calls = 0;
  manager.open({ id: 'a', root, onRequestClose: () => { calls += 1; } });

  dispatchKey(doc, 'Escape', { isComposing: true });

  assert.equal(calls, 0);
  assert.equal(manager.getDepth(), 1);
});

// ── listener lifecycle ──────────────────────────────────────────────────

test('the capture-phase keydown listener is installed only while the stack is non-empty', () => {
  const { doc } = buildDom('<div id="root"><button>x</button></div>');
  const root = doc.getElementById('root');

  let addCalls = 0;
  let removeCalls = 0;
  const originalAdd = doc.addEventListener.bind(doc);
  const originalRemove = doc.removeEventListener.bind(doc);
  doc.addEventListener = (type, ...rest) => {
    if (type === 'keydown') addCalls += 1;
    return originalAdd(type, ...rest);
  };
  doc.removeEventListener = (type, ...rest) => {
    if (type === 'keydown') removeCalls += 1;
    return originalRemove(type, ...rest);
  };

  const manager = createOverlayManager({ documentRef: doc });
  assert.equal(addCalls, 0, 'no listener before any open()');

  manager.open({ id: 'a', root, onRequestClose: () => {} });
  assert.equal(addCalls, 1, 'listener installed on 0 -> 1 transition');

  manager.open({ id: 'b', root, onRequestClose: () => {} });
  assert.equal(addCalls, 1, 'no duplicate listener on a second concurrent open');

  manager.close('a');
  assert.equal(removeCalls, 0, 'listener stays while depth is still > 0');

  manager.close('b');
  assert.equal(removeCalls, 1, 'listener removed on 1 -> 0 transition');

  // Dispatching Escape once the stack (and listener) are gone must not
  // reach any callback and must not leak another listener registration.
  let calls = 0;
  dispatchKey(doc, 'Escape');
  assert.equal(calls, 0);
  assert.equal(addCalls, 1, 'no listener leaked back in from a stray dispatch');
});

// ── focus restore ────────────────────────────────────────────────────────

test('close() restores focus to restoreFocusTo', () => {
  const { doc } = buildDom('<button id="trigger">Open</button><div id="root"><button id="inner">x</button></div>');
  const manager = createOverlayManager({ documentRef: doc });
  const root = doc.getElementById('root');
  const trigger = doc.getElementById('trigger');
  const inner = doc.getElementById('inner');

  trigger.focus();
  assert.equal(doc.activeElement, trigger);

  manager.open({ id: 'a', root, onRequestClose: () => {} });
  inner.focus();
  assert.equal(doc.activeElement, inner);

  manager.close('a');
  assert.equal(doc.activeElement, trigger, 'focus should return to the captured restoreFocusTo');
});

test('close() restores focus to an explicit restoreFocusTo override', () => {
  const { doc } = buildDom('<button id="trigger">Open</button><button id="explicit">Explicit</button><div id="root"><button>x</button></div>');
  const manager = createOverlayManager({ documentRef: doc });
  const root = doc.getElementById('root');
  const trigger = doc.getElementById('trigger');
  const explicitTarget = doc.getElementById('explicit');

  trigger.focus();
  manager.open({ id: 'a', root, onRequestClose: () => {}, restoreFocusTo: explicitTarget });
  manager.close('a');
  assert.equal(doc.activeElement, explicitTarget);
});

// ── focus trap ───────────────────────────────────────────────────────────

test('Tab cycles focus within the TOP entry\'s root only', () => {
  const { doc } = buildDom(`
    <button id="outside">Outside</button>
    <div id="rootA"><button id="aFirst">aFirst</button><button id="aLast">aLast</button></div>
    <div id="rootB"><button id="bFirst">bFirst</button><button id="bMid">bMid</button><button id="bLast">bLast</button></div>
  `);
  const manager = createOverlayManager({ documentRef: doc });
  const rootA = doc.getElementById('rootA');
  const rootB = doc.getElementById('rootB');
  const bFirst = doc.getElementById('bFirst');
  const bLast = doc.getElementById('bLast');

  manager.open({ id: 'a', root: rootA, onRequestClose: () => {} });
  manager.open({ id: 'b', root: rootB, onRequestClose: () => {} });

  bLast.focus();
  dispatchKey(doc, 'Tab');
  assert.equal(doc.activeElement, bFirst, 'Tab at the last focusable wraps to the first, within the top root');

  bFirst.focus();
  dispatchKey(doc, 'Tab', { shiftKey: true });
  assert.equal(doc.activeElement, bLast, 'Shift+Tab at the first focusable wraps to the last, within the top root');
});

test('close(id) of a non-top entry leaves the top entry\'s trap undisturbed', () => {
  const { doc } = buildDom(`
    <div id="rootA"><button id="aFirst">aFirst</button></div>
    <div id="rootB"><button id="bFirst">bFirst</button><button id="bLast">bLast</button></div>
  `);
  const manager = createOverlayManager({ documentRef: doc });
  const rootA = doc.getElementById('rootA');
  const rootB = doc.getElementById('rootB');
  const bFirst = doc.getElementById('bFirst');
  const bLast = doc.getElementById('bLast');

  manager.open({ id: 'a', root: rootA, onRequestClose: () => {} });
  manager.open({ id: 'b', root: rootB, onRequestClose: () => {} });

  // Close the non-top entry (a). b must remain top and still trap, and the
  // non-top close must NOT restore focus (that would yank it out of b).
  bFirst.focus();
  assert.equal(manager.close('a'), true);
  assert.equal(manager.getDepth(), 1);
  assert.equal(manager.isOpen('b'), true);
  assert.equal(doc.activeElement, bFirst, 'non-top close leaves focus inside the top overlay');

  bLast.focus();
  dispatchKey(doc, 'Tab');
  assert.equal(doc.activeElement, bFirst, 'b is still top and still traps after a non-top close');
});

test('an entry with trapFocus: false does not trap Tab', () => {
  const { doc } = buildDom('<button id="outside">Outside</button><div id="root"><button id="inner">inner</button></div>');
  const manager = createOverlayManager({ documentRef: doc });
  const root = doc.getElementById('root');
  const outside = doc.getElementById('outside');
  const inner = doc.getElementById('inner');

  manager.open({ id: 'a', root, onRequestClose: () => {}, trapFocus: false });
  inner.focus();
  dispatchKey(doc, 'Tab');
  // No trap installed: the manager doesn't touch focus, so it stays put
  // (jsdom doesn't run real Tab-order focus movement without a trap).
  assert.equal(doc.activeElement, inner);
  outside.focus();
  assert.equal(doc.activeElement, outside);
});

// ── command palette cross-overlay coherence ─────────────────────────────

function buildPaletteDom() {
  const { dom, doc } = buildDom(`
    <div id="commandPaletteOverlay" class="hidden"></div>
    <input id="commandPaletteInput" />
    <div id="commandPaletteList"></div>
  `);
  return {
    dom,
    doc,
    commandPaletteOverlay: doc.getElementById('commandPaletteOverlay'),
    commandPaletteInput: doc.getElementById('commandPaletteInput'),
    commandPaletteList: doc.getElementById('commandPaletteList'),
  };
}

test('palette isAnotherOverlayOpen consults an injected overlay manager and blocks open()', () => {
  const { commandPaletteOverlay, commandPaletteInput, commandPaletteList } = buildPaletteDom();
  const state = { ui: {}, auth: { authenticated: true }, sessions: [] };

  const fakeManagerOpen = { isOpen: () => true };
  const blockedController = createCommandPaletteController({
    state,
    dom: { commandPaletteOverlay, commandPaletteInput, commandPaletteList },
    overlayManager: fakeManagerOpen,
  });
  blockedController.open();
  assert.equal(blockedController.isActive(), false, 'open() should bail when the injected manager reports an overlay open');

  const fakeManagerClosed = { isOpen: () => false };
  const allowedController = createCommandPaletteController({
    state,
    dom: { commandPaletteOverlay, commandPaletteInput, commandPaletteList },
    overlayManager: fakeManagerClosed,
  });
  allowedController.open();
  assert.equal(allowedController.isActive(), true, 'open() should proceed when the injected manager reports nothing open');
});

test('palette works with no overlayManager injected (optional dep, absent-safe)', () => {
  const { commandPaletteOverlay, commandPaletteInput, commandPaletteList } = buildPaletteDom();
  const state = { ui: {}, auth: { authenticated: true }, sessions: [] };

  const controller = createCommandPaletteController({
    state,
    dom: { commandPaletteOverlay, commandPaletteInput, commandPaletteList },
  });
  controller.open();
  assert.equal(controller.isActive(), true);
});

// ── UIUX-018/019: full palette + help-overlay migration onto the stack ──
// (JENNY_UIUX_OVERHAUL_PLAN.md; UI_UX_COMPREHENSIVE_AUDIT_2026-07-12.md
// UIUX-018/019). Before this migration the palette only *consulted* the
// manager (tests above) but never registered itself, and
// renderer/inventory/help-overlay.js had zero manager awareness -- each kept
// its own permanent document-level Escape listener, so "one Escape closes
// exactly one layer, topmost first" did not hold once more than one overlay
// was open (the audit's literal "Opening Help then Ctrl+K ... one Escape can
// reach multiple handlers" scenario).

test('command palette registers itself with the overlay manager on open() and unregisters on close()', () => {
  const { commandPaletteOverlay, commandPaletteInput, commandPaletteList } = buildPaletteDom();
  const doc = commandPaletteOverlay.ownerDocument;
  const state = { ui: {}, auth: { authenticated: true }, sessions: [] };
  const manager = createOverlayManager({ documentRef: doc });

  const controller = createCommandPaletteController({
    state,
    dom: { commandPaletteOverlay, commandPaletteInput, commandPaletteList },
    overlayManager: manager,
  });

  controller.open();
  assert.equal(manager.isOpen('command-palette'), true, 'open() must register an entry with the shared overlay manager');

  controller.close();
  assert.equal(manager.isOpen('command-palette'), false, 'close() must unregister from the shared overlay manager');
});

test('when another overlay is stacked on top, Escape does not also close the command palette (single-owner Escape)', () => {
  const { commandPaletteOverlay, commandPaletteInput, commandPaletteList } = buildPaletteDom();
  const doc = commandPaletteOverlay.ownerDocument;
  // features.featureFlags.command_palette must be true or bind() no-ops
  // (isCommandPaletteEnabled) and never attaches a listener at all.
  const state = { ui: {}, auth: { authenticated: true }, sessions: [], features: { featureFlags: { command_palette: true } } };
  const manager = createOverlayManager({ documentRef: doc });

  // renderer-command-palette.js resolves `documentRef` off the ambient
  // global (`typeof document !== 'undefined' ? document : null`), not an
  // injected dep -- true in the real renderer, but bind()'s document-level
  // listener is a no-op in a bare Node test unless the ambient global points
  // at the SAME document the manager was built against.
  const previousDocument = global.document;
  global.document = doc;
  try {
    const controller = createCommandPaletteController({
      state,
      dom: { commandPaletteOverlay, commandPaletteInput, commandPaletteList },
      overlayManager: manager,
    });
    // bind() is what installs the palette's own permanent document-level
    // Escape listener in production (renderer-app-shell-bindings.js calls it
    // right after construction) -- exercise the same wiring here or this
    // test would vacuously pass with no listener installed at all.
    controller.bind();
    controller.open();
    assert.equal(controller.isActive(), true);

    // A second overlay opens on top of the palette (e.g. Help) and registers
    // with the same shared manager.
    const otherRoot = doc.createElement('div');
    doc.body.appendChild(otherRoot);
    let otherClosed = false;
    manager.open({
      id: 'other',
      root: otherRoot,
      onRequestClose: () => { otherClosed = true; manager.close('other'); },
    });

    dispatchKey(doc, 'Escape');

    assert.equal(otherClosed, true, 'the topmost overlay must receive the Escape');
    assert.equal(controller.isActive(), true, 'the palette must stay open -- only the top layer is Escape-eligible');
  } finally {
    global.document = previousDocument;
  }
});

test('help overlay registers with an injected overlay manager and defers Escape to it', () => {
  const { doc } = buildDom('<button id="trigger">Open</button>');
  const manager = createOverlayManager({ documentRef: doc });
  const trigger = doc.getElementById('trigger');
  trigger.focus();

  const overlay = createHelpOverlay({ document: doc, hostId: 'test-help-managed', overlayManager: manager });
  overlay.open({ title: 'Help', bodyHtml: '<p>body</p>' });

  assert.equal(manager.isOpen('test-help-managed'), true, 'help overlay must register with the injected manager');

  dispatchKey(doc, 'Escape');
  assert.equal(overlay.isOpen(), false, 'Escape routed through the manager must close the overlay');
  assert.equal(manager.isOpen('test-help-managed'), false);
  assert.equal(doc.activeElement, trigger, 'focus restored to the invoking trigger via the manager');
});

test('help overlay still falls back to local Escape/focus-restore when no overlay manager is injected', () => {
  const { doc } = buildDom('<button id="trigger">Open</button>');
  const trigger = doc.getElementById('trigger');
  trigger.focus();

  const overlay = createHelpOverlay({ document: doc, hostId: 'test-help-unmanaged' });
  overlay.open({ title: 'Help', bodyHtml: '<p>body</p>' });

  dispatchKey(doc, 'Escape');
  assert.equal(overlay.isOpen(), false);
  assert.equal(doc.activeElement, trigger);
});

test('help overlay falls back to local focus restore when overlayManager.open() returns false (duplicate id / missing root)', () => {
  const { doc } = buildDom('<button id="trigger">Open</button>');
  const trigger = doc.getElementById('trigger');
  trigger.focus();

  let closeCalls = 0;
  const stubManager = {
    open: () => false, // e.g. duplicate id, or missing root
    close: () => { closeCalls += 1; },
  };

  const overlay = createHelpOverlay({ document: doc, hostId: 'test-help-open-false', overlayManager: stubManager });
  overlay.open({ title: 'Help', bodyHtml: '<p>body</p>' });
  assert.equal(overlay.isOpen(), true);

  overlay.close();
  assert.equal(overlay.isOpen(), false);
  assert.equal(closeCalls, 0, 'manager.close must not be called when open() reported no stack entry');
  assert.equal(doc.activeElement, trigger, 'focus restored locally when the manager did not take ownership');
});

test('opening Help while the command palette is open stacks correctly: one Escape per layer, topmost first', () => {
  const { commandPaletteOverlay, commandPaletteInput, commandPaletteList } = buildPaletteDom();
  const doc = commandPaletteOverlay.ownerDocument;
  const state = { ui: {}, auth: { authenticated: true }, sessions: [], features: { featureFlags: { command_palette: true } } };
  const manager = createOverlayManager({ documentRef: doc });

  const previousDocument = global.document;
  global.document = doc;
  try {
    const palette = createCommandPaletteController({
      state,
      dom: { commandPaletteOverlay, commandPaletteInput, commandPaletteList },
      overlayManager: manager,
    });
    palette.bind();
    palette.open();
    assert.equal(palette.isActive(), true);

    const help = createHelpOverlay({ document: doc, hostId: 'help-over-palette', overlayManager: manager });
    help.open({ title: 'Help', bodyHtml: '<p>body</p>' });
    assert.equal(manager.getDepth(), 2, 'both the palette and Help must be on the shared stack');

    dispatchKey(doc, 'Escape');
    assert.equal(help.isOpen(), false, 'first Escape closes only the topmost (Help)');
    assert.equal(palette.isActive(), true, 'palette remains open after the first Escape');

    dispatchKey(doc, 'Escape');
    assert.equal(palette.isActive(), false, 'second Escape closes the palette, now topmost');
  } finally {
    global.document = previousDocument;
  }
});

// ── UIUX-018: focus-restore fallback when the invoking element is gone ──

test('close() falls back to the fallbackFocusTo target when restoreFocusTo has been removed from the document', () => {
  const { doc } = buildDom('<button id="trigger">Open</button><button id="safe-fallback">Fallback</button><div id="root"><button id="inner">x</button></div>');
  const manager = createOverlayManager({ documentRef: doc });
  const root = doc.getElementById('root');
  const trigger = doc.getElementById('trigger');
  const fallback = doc.getElementById('safe-fallback');

  trigger.focus();
  manager.open({ id: 'a', root, onRequestClose: () => {}, fallbackFocusTo: fallback });
  // Invoker vanishes while the overlay is open (e.g. the row it lived on was
  // deleted/re-rendered) -- the captured restoreFocusTo reference is now a
  // detached node.
  trigger.remove();

  manager.close('a');
  assert.equal(doc.activeElement, fallback, 'close() must land focus on the documented fallback, not silently drop it');
});

test('close() re-resolves a detached restore target by id (chrome re-rendered mid-overlay)', () => {
  // GUI finding 2026-07-20: renderers rebuild chrome (sidebar strips, status
  // rows) while an overlay is open; the saved node detaches and the restore
  // silently dropped, stranding focus on the document root.
  const { doc } = buildDom('<div id="chrome"><button id="trigger">Open</button></div><div id="root"><button id="inner">x</button></div>');
  const manager = createOverlayManager({ documentRef: doc });
  const root = doc.getElementById('root');
  const chrome = doc.getElementById('chrome');

  doc.getElementById('trigger').focus();
  manager.open({ id: 'a', root, onRequestClose: () => {} });
  doc.getElementById('inner').focus();

  // Simulate a chrome re-render: the trigger is replaced by a NEW node with
  // the same id while the overlay is open.
  chrome.innerHTML = '<button id="trigger">Open</button>';

  manager.close('a');
  assert.equal(doc.activeElement, doc.getElementById('trigger'),
    'focus should land on the re-rendered control with the same id');
});
