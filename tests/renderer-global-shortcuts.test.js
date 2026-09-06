const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

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
