const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { createOverlayManager } = require('../renderer/shell/renderer-overlay-manager.js');
const { createGlobalShortcutsController } = require('../renderer/shell/renderer-global-shortcuts.js');

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

function pressCtrl(window, key, extra = {}) {
  const event = new window.KeyboardEvent('keydown', {
    key,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...extra,
  });
  window.dispatchEvent(event);
  return event;
}

function loadShellBindingsRoot(overrides = {}) {
  const root = { ...overrides };
  const sourcePath = path.join(
    __dirname,
    '..',
    'renderer',
    'app',
    'renderer-app-shell-bindings-controllers.js'
  );
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), { window: root }, { filename: sourcePath });
  return root;
}

test('shell binding wires the delegated spellcheck menu to the live document, bridge, and feature flag', () => {
  const bindCalls = [];
  const cleanups = [];
  let disposeCalls = 0;
  const spellcheckBridge = { onContext() {}, replaceMisspelling() {}, addToDictionary() {} };
  const detachedRoot = { detached: true };
  const documentRef = {
    getElementById: () => null,
    createElement: () => detachedRoot,
  };
  const state = { features: { featureFlags: { text_spellcheck: true } } };
  const root = loadShellBindingsRoot({
    rendererChatEventInteractiveBindings: {
      bindTextFieldContextMenu(options) {
        bindCalls.push(options);
        return { dispose() { disposeCalls += 1; } };
      },
    },
  });

  root.rendererAppShellBindingsControllers.bindShellEventControllers({
    state,
    constants: { TOAST_SOURCE: 'test' },
    dom: {},
    controllers: {},
    callbacks: {
      appendClientLog() {},
      registerCleanup(cleanup) { cleanups.push(cleanup); },
      showSessionActionError() {},
    },
    windowRef: { jennyShell: { spellcheck: spellcheckBridge } },
    documentRef,
  });

  assert.equal(bindCalls.length, 1, 'the app shell must install the sole delegated-menu binder');
  assert.equal(bindCalls[0].delegateRoot, documentRef);
  assert.equal(bindCalls[0].spellcheckApi, spellcheckBridge);
  assert.equal(bindCalls[0].isEnabled(), true);
  delete state.features.featureFlags.text_spellcheck;
  assert.equal(bindCalls[0].isEnabled(), true, 'an absent flag preserves the default-on contract');
  state.features.featureFlags.text_spellcheck = false;
  assert.equal(bindCalls[0].isEnabled(), false);
  assert.equal(cleanups.length, 1);
  cleanups[0]();
  assert.equal(disposeCalls, 1);
});

test('Ctrl+1-5 switch views in rail order', async (t) => {
  const { window } = await loadRendererTestApp(t);
  await waitForUi(window, 60);

  const expectations = [
    ['1', 'home'],
    ['3', 'ide'],
    ['4', 'logs'],
    ['5', 'settings'],
    ['2', 'chat'],
  ];
  for (const [key, viewId] of expectations) {
    const event = pressCtrl(window, key);
    await waitForUi(window, 30);
    assert.equal(window.__rendererState.ui.activeView, viewId, `Ctrl+${key} lands on ${viewId}`);
    assert.equal(event.defaultPrevented, true, `Ctrl+${key} is consumed`);
  }
});

test('Ctrl+N starts a new chat', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  await waitForUi(window, 60);

  const counterBefore = shell.__state.sessionCounter;
  pressCtrl(window, 'n');
  await waitForUi(window, 60);

  assert.ok(shell.__state.sessionCounter > counterBefore, 'a session create reached the backend fake');
});

test('Ctrl+B toggles the active panel and is a no-op on panel-less views', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const workspace = doc.getElementById('workspace');
  await waitForUi(window, 60);

  pressCtrl(window, '2');
  await waitForUi(window, 30);
  assert.equal(window.__rendererState.ui.activeView, 'chat');

  const focusedTab = doc.getElementById('chatTopRailTab');
  focusedTab.focus();
  pressCtrl(window, 'b');
  await waitForUi(window, 30);
  assert.equal(workspace.classList.contains('panel-collapsed'), true, 'Ctrl+B collapses the chat panel');
  assert.equal(doc.activeElement, focusedTab, 'the keyboard path never steals focus (unlike the click path)');

  pressCtrl(window, 'b');
  await waitForUi(window, 30);
  assert.equal(workspace.classList.contains('panel-collapsed'), false, 'Ctrl+B expands it again');

  pressCtrl(window, '4');
  await waitForUi(window, 30);
  pressCtrl(window, 'b');
  await waitForUi(window, 30);
  assert.equal(workspace.classList.contains('panel-collapsed'), false, 'no panel to toggle on logs');
  const store = JSON.parse(window.localStorage.getItem('jenny.panels.v2'));
  assert.equal(store.byView.chat.collapsed, false, 'logs Ctrl+B never touched the chat panel state');
});

test('extra modifiers never consume the keys', async (t) => {
  const { window } = await loadRendererTestApp(t);
  await waitForUi(window, 60);
  const viewBefore = window.__rendererState.ui.activeView;

  const shifted = pressCtrl(window, '1', { shiftKey: true });
  await waitForUi(window, 30);
  assert.equal(window.__rendererState.ui.activeView, viewBefore, 'Ctrl+Shift+1 is ignored');
  assert.equal(shifted.defaultPrevented, false);
});

test('UIUX-020: Ctrl+1-5 moves focus to the destination toprail tab after switching', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  await waitForUi(window, 60);

  pressCtrl(window, '3');
  await waitForUi(window, 60);
  assert.equal(window.__rendererState.ui.activeView, 'ide');
  assert.equal(doc.activeElement && doc.activeElement.id, 'ideTopRailTab',
    'Ctrl+3 must land focus on the Workspace toprail tab, not leave it stranded');

  pressCtrl(window, '5');
  await waitForUi(window, 60);
  assert.equal(window.__rendererState.ui.activeView, 'settings');
  assert.equal(doc.activeElement && doc.activeElement.id, 'settingsTopRailTab',
    'Ctrl+5 must land focus on the Settings toprail tab');
});

test('UIUX-020: global shortcuts stand down while focus is in a text-editing surface', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await waitForUi(window, 60);

  const chatInput = doc.getElementById('chatInput');
  chatInput.focus();
  assert.equal(doc.activeElement, chatInput, 'precondition: composer holds focus');

  const viewBefore = window.__rendererState.ui.activeView;
  const digitEvent = pressCtrl(window, '3');
  await waitForUi(window, 30);
  assert.equal(window.__rendererState.ui.activeView, viewBefore, 'Ctrl+3 must not steal the view while composing');
  assert.equal(digitEvent.defaultPrevented, false, 'the keystroke is left for the composer');
  assert.equal(doc.activeElement, chatInput, 'focus must stay in the composer');

  const counterBefore = shell.__state.sessionCounter;
  const nEvent = pressCtrl(window, 'n');
  await waitForUi(window, 30);
  assert.equal(shell.__state.sessionCounter, counterBefore, 'Ctrl+N must not fire while composing');
  assert.equal(nEvent.defaultPrevented, false);

  const bEvent = pressCtrl(window, 'b');
  await waitForUi(window, 30);
  assert.equal(bEvent.defaultPrevented, false, 'Ctrl+B must not fire while composing');
});

test('UIUX-020: Ctrl+Shift+Space still fires from a text-editing surface (documented exemption)', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  await waitForUi(window, 60);

  const chatInput = doc.getElementById('chatInput');
  chatInput.focus();

  const event = pressCtrl(window, ' ', { shiftKey: true });
  await waitForUi(window, 30);

  assert.equal(event.defaultPrevented, true, 'the scratchpad chord is exempt from the text-input guard');
  const popover = doc.querySelector('.scratchpad-capture');
  assert.ok(popover, 'the capture popover still opens from inside the composer');
});

test('Ctrl+Shift+Space opens the scratchpad quick-capture popover from any view', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  await waitForUi(window, 60);

  // Start on a non-Home view to prove the chord works without opening Home.
  pressCtrl(window, '2');
  await waitForUi(window, 30);
  assert.equal(doc.querySelector('.scratchpad-capture'), null, 'no popover before the chord');

  const event = pressCtrl(window, ' ', { shiftKey: true });
  await waitForUi(window, 30);

  const popover = doc.querySelector('.scratchpad-capture');
  assert.ok(popover, 'the capture popover mounted');
  assert.equal(popover.hidden, false, 'and is visible');
  assert.equal(event.defaultPrevented, true, 'the chord is consumed');
  assert.ok(doc.querySelector('#scratchpadCaptureInput'), 'with a capture input field');
});

test('managed overlay open: every global chord stands down (unit)', (t) => {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="appShell"></div>'
    + '<div id="confirmDialog" role="dialog"><button id="confirmYes">Yes</button></div></body></html>');
  const { window } = dom;
  const doc = window.document;
  const calls = [];
  const manager = createOverlayManager({ documentRef: doc });
  const controller = createGlobalShortcutsController({
    windowRef: window,
    isOverlayOpen: () => manager.getDepth() > 0,
    callbacks: {
      setActiveView: (viewId) => calls.push(['setActiveView', viewId]),
      newChat: () => calls.push(['newChat']),
      togglePanel: () => { calls.push(['togglePanel']); return true; },
      openCapture: () => calls.push(['openCapture']),
    },
  });
  controller.bind();
  t.after(() => {
    controller.dispose();
    manager.dispose();
    window.close();
  });

  const opened = manager.open({
    id: 'confirm-dialog',
    root: doc.getElementById('confirmDialog'),
    onRequestClose() {},
    inertTargets: [doc.getElementById('appShell')],
  });
  assert.equal(opened, true, 'precondition: the managed overlay is on the stack');
  doc.getElementById('confirmYes').focus();

  const events = [
    pressCtrl(window, 'n'),
    pressCtrl(window, '1'),
    pressCtrl(window, 'b'),
    pressCtrl(window, ' ', { shiftKey: true }),
  ];

  assert.deepEqual(calls, [], 'no shortcut callback may run behind a managed overlay');
  events.forEach((event, index) => {
    assert.equal(event.defaultPrevented, false, `chord #${index} must be left for the overlay`);
  });
  assert.equal(manager.isOpen('confirm-dialog'), true, 'the overlay stays open');

  manager.close('confirm-dialog');
  pressCtrl(window, 'n');
  assert.deepEqual(calls, [['newChat']], 'Ctrl+N fires again once the overlay closes');
});

test('managed overlay open: global shortcuts stand down in the live shell', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await waitForUi(window, 60);

  const manager = window.rendererOverlayManagerController;
  assert.ok(manager, 'precondition: the shared overlay manager is mounted');

  const dialog = doc.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.innerHTML = '<button id="overlayFenceButton">Confirm</button>';
  doc.body.appendChild(dialog);
  const entry = { id: 'overlay-fence-dialog', root: dialog, onRequestClose() {} };
  const appShell = doc.getElementById('appShell');
  if (appShell) {
    entry.inertTargets = [appShell];
  }
  assert.equal(manager.open(entry), true, 'precondition: the overlay opened');
  doc.getElementById('overlayFenceButton').focus();

  const viewBefore = window.__rendererState.ui.activeView;
  const counterBefore = shell.__state.sessionCounter;

  const nEvent = pressCtrl(window, 'n');
  await waitForUi(window, 60);
  const digitEvent = pressCtrl(window, '3');
  await waitForUi(window, 60);

  assert.equal(shell.__state.sessionCounter, counterBefore, 'Ctrl+N must not create a chat behind a modal');
  assert.equal(window.__rendererState.ui.activeView, viewBefore, 'Ctrl+3 must not switch views behind a modal');
  assert.equal(nEvent.defaultPrevented, false, 'the keystroke is left for the overlay');
  assert.equal(digitEvent.defaultPrevented, false, 'the keystroke is left for the overlay');
  assert.equal(manager.isOpen('overlay-fence-dialog'), true, 'the overlay stays open');

  manager.close('overlay-fence-dialog');
  dialog.remove();
  pressCtrl(window, 'n');
  await waitForUi(window, 60);
  assert.ok(shell.__state.sessionCounter > counterBefore, 'Ctrl+N works again once the overlay closes');
});

test('the capture chord dismisses the command palette and fires; other chords still stand down (unit)', (t) => {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="appShell"><button id="trigger">k</button></div>'
    + '<div id="palette"><input id="paletteInput"></div></body></html>');
  const { window } = dom;
  const doc = window.document;
  const calls = [];
  const closeReasons = [];
  const manager = createOverlayManager({ documentRef: doc });
  const controller = createGlobalShortcutsController({
    windowRef: window,
    isOverlayOpen: () => manager.getDepth() > 0,
    overlayManager: manager,
    captureYieldingOverlayIds: ['command-palette'],
    callbacks: {
      newChat: () => calls.push(['newChat']),
      openCapture: () => calls.push(['openCapture']),
    },
  });
  controller.bind();
  t.after(() => {
    controller.dispose();
    manager.dispose();
    window.close();
  });
  const openPalette = () => manager.open({
    id: 'command-palette',
    root: doc.getElementById('palette'),
    trapFocus: false,
    onRequestClose(reason) { closeReasons.push(reason); manager.close('command-palette'); },
  });

  assert.equal(openPalette(), true);
  pressCtrl(window, 'n');
  assert.deepEqual(calls, [], 'Ctrl+N still stands down behind the palette');
  const event = pressCtrl(window, ' ', { shiftKey: true });
  assert.equal(event.defaultPrevented, true, 'the capture chord is consumed');
  assert.deepEqual(calls, [['openCapture']], 'and the capture opens');
  assert.deepEqual(closeReasons, ['capture_chord'], 'after the palette was asked to close through its own path');
  assert.equal(manager.isOpen('command-palette'), false);

  // A modal stacked on the palette keeps every chord down, the capture chord too.
  assert.equal(openPalette(), true);
  manager.open({ id: 'confirm', root: doc.getElementById('appShell'), onRequestClose() {} });
  pressCtrl(window, ' ', { shiftKey: true });
  assert.deepEqual(calls, [['openCapture']]);
  assert.equal(manager.getDepth(), 2);
});

test('a leaked overlay entry (root removed without close) no longer blocks the chords (unit)', (t) => {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="appShell"></div>'
    + '<div id="confirmDialog" role="dialog"><button id="confirmYes">Yes</button></div></body></html>');
  const { window } = dom;
  const doc = window.document;
  const calls = [];
  const manager = createOverlayManager({ documentRef: doc });
  const controller = createGlobalShortcutsController({
    windowRef: window,
    isOverlayOpen: () => manager.getDepth() > 0,
    callbacks: { newChat: () => calls.push(['newChat']) },
  });
  controller.bind();
  t.after(() => {
    controller.dispose();
    manager.dispose();
    window.close();
  });
  const dialog = doc.getElementById('confirmDialog');
  manager.open({ id: 'leaked', root: dialog, onRequestClose() {}, inertTargets: [doc.getElementById('appShell')] });
  pressCtrl(window, 'n');
  assert.deepEqual(calls, [], 'precondition: the live overlay blocks the chord');

  dialog.remove(); // re-rendered chrome dropped the overlay; nobody called close()
  pressCtrl(window, 'n');
  assert.deepEqual(calls, [['newChat']], 'the stale entry no longer blocks the chord');
});
