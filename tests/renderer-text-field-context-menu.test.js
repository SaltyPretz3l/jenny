'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  SPELLCHECK_FIELD_SELECTOR,
  SPELLCHECK_WAIT_MS,
  bindTextFieldContextMenu,
  buildTextFieldClipboardItems,
  createSpellcheckContextTracker,
  resolveSpellcheckField,
} = require('../renderer/chat/renderer-chat-event-interactive-bindings');

const BASE_LABELS = ['Cut', 'Copy', 'Paste', '<separator>', 'Select All'];

function labelsOf(items) {
  return items.map((item) => (item.separator ? '<separator>' : item.label));
}

function makeDoc({ clipboardText = 'pasted', execError = null } = {}) {
  const calls = [];
  const listeners = new Map();
  return {
    calls,
    listeners,
    execCommand(command, showUi, value) {
      if (execError) throw execError;
      calls.push(['execCommand', command, showUi, value]);
      return true;
    },
    defaultView: {
      navigator: {
        clipboard: {
          readText() {
            calls.push(['readText']);
            return Promise.resolve(clipboardText);
          },
        },
      },
    },
    addEventListener(type, handler, options) {
      listeners.set(type, { handler, options });
    },
    removeEventListener(type, handler, options) {
      const registered = listeners.get(type);
      if (registered && registered.handler === handler && registered.options === options) {
        listeners.delete(type);
      }
    },
  };
}

function makeField(doc, options = {}) {
  const field = {
    tagName: String(options.tagName || 'textarea').toUpperCase(),
    ownerDocument: doc,
    selectionStart: options.selectionStart ?? 0,
    selectionEnd: options.selectionEnd ?? 0,
    disabled: options.disabled === true,
    readOnly: options.readOnly === true,
    isConnected: options.isConnected !== false,
    focused: 0,
    selected: 0,
    focus() { this.focused += 1; },
    select() { this.selected += 1; },
    closest(selector) {
      if (selector === SPELLCHECK_FIELD_SELECTOR) return options.eligible === false ? null : field;
      if (selector === '[data-ctx-menu-owner]') return options.owner || null;
      return null;
    },
  };
  return field;
}

function contextPayload(word = 'teh', suggestions = ['the']) {
  return { misspelled_word: word, dictionary_suggestions: suggestions };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('text-field clipboard items match composer labels, shortcuts, and selection state', () => {
  const doc = makeDoc();
  const empty = buildTextFieldClipboardItems({ field: makeField(doc), doc, view: doc.defaultView });
  const selected = buildTextFieldClipboardItems({
    field: makeField(doc, { selectionEnd: 3 }), doc, view: doc.defaultView,
  });

  assert.deepEqual(labelsOf(empty), BASE_LABELS);
  assert.deepEqual(empty.map((item) => item.shortcutHint), [
    'Ctrl+X', 'Ctrl+C', 'Ctrl+V', undefined, 'Ctrl+A',
  ]);
  assert.deepEqual(empty.slice(0, 2).map((item) => item.disabled), [true, true]);
  assert.deepEqual(selected.slice(0, 2).map((item) => item.disabled), [false, false]);
});

test('text-field Paste reads text before inserting it with execCommand', async () => {
  const doc = makeDoc({ clipboardText: 'from clipboard' });
  const field = makeField(doc);
  const items = buildTextFieldClipboardItems({ field, doc, view: doc.defaultView });

  await items[2].action();

  assert.deepEqual(doc.calls, [
    ['readText'],
    ['execCommand', 'insertText', false, 'from clipboard'],
  ]);
  assert.equal(field.focused, 1);
});

test('resolveSpellcheckField accepts opted-in textarea and input elements', () => {
  const doc = makeDoc();
  for (const tagName of ['textarea', 'input']) {
    const field = makeField(doc, { tagName });
    assert.equal(resolveSpellcheckField({ target: field }), field);
  }
});

function resolveRealContextMenuEvent(dom, target, { defaultPrevented = false } = {}) {
  const unset = Symbol('unset');
  let resolved = unset;
  target.addEventListener('contextmenu', (event) => {
    resolved = resolveSpellcheckField(event);
  }, { once: true });
  const event = new dom.window.MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
  });
  if (defaultPrevented) event.preventDefault();
  target.dispatchEvent(event);
  assert.notEqual(resolved, unset, 'the real DOM contextmenu listener must run');
  return resolved;
}

test('resolveSpellcheckField real selector matches only explicit textarea and text-input opt-ins', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const { document } = dom.window;
  const textarea = document.createElement('textarea');
  const nested = document.createElement('span');
  textarea.setAttribute('spellcheck', 'true');
  textarea.appendChild(nested);
  document.body.appendChild(textarea);

  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.setAttribute('spellcheck', 'true');
  document.body.appendChild(textInput);

  const optedOut = document.createElement('input');
  optedOut.setAttribute('spellcheck', 'false');
  document.body.appendChild(optedOut);
  const implicit = document.createElement('input');
  document.body.appendChild(implicit);

  assert.equal(
    resolveRealContextMenuEvent(dom, nested),
    textarea,
    'a nested event target must traverse to its opted-in textarea ancestor'
  );
  assert.equal(resolveRealContextMenuEvent(dom, textInput), textInput);
  assert.equal(resolveRealContextMenuEvent(dom, optedOut), null);
  assert.equal(resolveRealContextMenuEvent(dom, implicit), null);
  dom.window.close();
});

test('resolveSpellcheckField real selector preserves safety guards around explicit opt-ins', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const { document } = dom.window;
  const makeInput = () => {
    const input = document.createElement('input');
    input.setAttribute('spellcheck', 'true');
    document.body.appendChild(input);
    return input;
  };

  const password = makeInput();
  password.type = 'password';
  assert.equal(
    resolveRealContextMenuEvent(dom, password),
    password,
    'the selector honors an explicit password opt-in; the production inventory separately forbids one'
  );

  const owner = document.createElement('section');
  owner.dataset.ctxMenuOwner = 'existing';
  const owned = document.createElement('input');
  owned.setAttribute('spellcheck', 'true');
  owner.appendChild(owned);
  document.body.appendChild(owner);
  assert.equal(resolveRealContextMenuEvent(dom, owned), null);

  const disabled = makeInput();
  disabled.disabled = true;
  assert.equal(resolveRealContextMenuEvent(dom, disabled), null);
  const readOnly = makeInput();
  readOnly.readOnly = true;
  assert.equal(resolveRealContextMenuEvent(dom, readOnly), null);
  const prevented = makeInput();
  assert.equal(resolveRealContextMenuEvent(dom, prevented, { defaultPrevented: true }), null);
  dom.window.close();
});

test('resolveSpellcheckField rejects every ineligible or unsafe target without throwing', () => {
  const doc = makeDoc();
  const noMatch = makeField(doc, { eligible: false });
  const disabled = makeField(doc, { disabled: true });
  const readOnly = makeField(doc, { readOnly: true });
  const owned = makeField(doc, { owner: { dataset: { ctxMenuOwner: 'existing' } } });
  const throwing = { closest() { throw new Error('detached proxy'); } };
  const cases = [
    null,
    {},
    { target: {} },
    { target: makeField(doc), defaultPrevented: true },
    { target: noMatch },
    { target: disabled },
    { target: readOnly },
    { target: owned },
    { target: throwing },
  ];

  for (const event of cases) assert.equal(resolveSpellcheckField(event), null);
});

function bindHarness({
  withBridge = false,
  spellcheckApi: spellcheckApiOverride = null,
  isEnabled = null,
  execError = null,
} = {}) {
  const doc = makeDoc({ execError });
  const shown = [];
  const logs = [];
  const actionErrors = [];
  const cleanups = [];
  let push = null;
  const spellcheckApi = spellcheckApiOverride || (withBridge ? {
    onContext(listener) { push = listener; return () => { push = null; }; },
    replaceMisspelling: () => Promise.resolve({ ok: true }),
    addToDictionary: () => Promise.resolve({ ok: true }),
  } : null);
  if (spellcheckApi && typeof spellcheckApi.onContext === 'function') {
    const subscribe = spellcheckApi.onContext.bind(spellcheckApi);
    spellcheckApi.onContext = (listener) => {
      push = listener;
      const unsubscribe = subscribe(listener);
      return () => {
        push = null;
        if (typeof unsubscribe === 'function') unsubscribe();
      };
    };
  }
  const controller = bindTextFieldContextMenu({
    delegateRoot: doc,
    addCleanup: (cleanup) => cleanups.push(cleanup),
    spellcheckApi,
    contextMenuHost: { contextMenu: { show: (options) => shown.push(options) } },
    appendClientLog: (...args) => logs.push(args),
    showActionError: (...args) => actionErrors.push(args),
    isEnabled,
  });
  const rightClick = (field, { clientX = 17, clientY = 29 } = {}) => {
    let preventDefaultCalls = 0;
    doc.listeners.get('contextmenu').handler({
      target: field,
      clientX,
      clientY,
      defaultPrevented: false,
      preventDefault() { preventDefaultCalls += 1; },
    });
    return () => preventDefaultCalls;
  };
  return {
    actionErrors,
    controller,
    cleanups,
    doc,
    emit(payload) { if (push) push(payload); },
    logs,
    rightClick,
    shown,
  };
}

test('keyboard context menu anchors to the field box while pointer input keeps its coordinates', async () => {
  const h = bindHarness();
  const field = makeField(h.doc);
  field.getBoundingClientRect = () => ({ left: 40, bottom: 90 });

  h.rightClick(field, { clientX: 0, clientY: 0 });
  await tick();
  assert.deepEqual(
    { anchorX: h.shown[0].anchorX, anchorY: h.shown[0].anchorY },
    { anchorX: 64, anchorY: 90 }
  );

  h.rightClick(field, { clientX: 17, clientY: 29 });
  await tick();
  assert.deepEqual(
    { anchorX: h.shown[1].anchorX, anchorY: h.shown[1].anchorY },
    { anchorX: 17, anchorY: 29 }
  );
  h.controller.dispose();
});

test('one delegated right-click opens exactly one base menu and never prevents default', async () => {
  const h = bindHarness({ withBridge: true });
  const prevented = h.rightClick(makeField(h.doc));
  await new Promise((resolve) => setTimeout(resolve, SPELLCHECK_WAIT_MS + 20));

  assert.equal(h.shown.length, 1);
  assert.deepEqual(labelsOf(h.shown[0].items), BASE_LABELS);
  assert.equal(prevented(), 0);
  assert.equal('onHide' in h.shown[0], false);
  h.controller.dispose();
});

test('fresh payload adds five suggestions and dictionary action above clipboard items', async () => {
  const h = bindHarness({ withBridge: true });
  h.rightClick(makeField(h.doc));
  h.emit(contextPayload('teh', ['the', 'ten', 'tea', 'tech', 'teth', 'then']));
  await tick();

  assert.equal(h.shown.length, 1);
  assert.deepEqual(labelsOf(h.shown[0].items), [
    'the', 'ten', 'tea', 'tech', 'teth', 'Add to dictionary', '<separator>', ...BASE_LABELS,
  ]);
  h.controller.dispose();
});

test('delegated suggestions replace the focused field and dictionary actions add the misspelled word', async () => {
  const bridgeCalls = [];
  const h = bindHarness({
    spellcheckApi: {
      onContext(listener) { this.push = listener; return () => { this.push = null; }; },
      replaceMisspelling(word) { bridgeCalls.push(['replace', word]); return { ok: true }; },
      addToDictionary(word) { bridgeCalls.push(['add', word]); return { ok: true }; },
    },
  });
  const field = makeField(h.doc);
  h.rightClick(field);
  h.emit(contextPayload('teh', ['the']));
  await tick();

  const [suggestion, addToDictionary] = h.shown[0].items;
  await suggestion.action();
  assert.equal(field.focused, 1, 'the field must be focused before Chromium replaces its misspelling');
  await addToDictionary.action();
  assert.deepEqual(bridgeCalls, [['replace', 'the'], ['add', 'teh']]);
  h.controller.dispose();
});

test('delegated Cut, Copy, and Select All actions invoke their matching field commands', async () => {
  const h = bindHarness();
  const field = makeField(h.doc, { selectionEnd: 3 });
  h.rightClick(field);
  await tick();

  const itemsByLabel = new Map(h.shown[0].items.filter((item) => item.label)
    .map((item) => [item.label, item]));
  itemsByLabel.get('Cut').action();
  itemsByLabel.get('Copy').action();
  itemsByLabel.get('Select All').action();

  assert.deepEqual(h.doc.calls, [
    ['execCommand', 'cut', false, undefined],
    ['execCommand', 'copy', false, undefined],
  ]);
  assert.equal(field.selected, 1);
  assert.equal(field.focused, 3);
  h.controller.dispose();
});

test('delegated bridge failures and thrown item actions emit their bounded WARN events', async () => {
  const bridge = bindHarness({
    spellcheckApi: {
      onContext(listener) { this.push = listener; return () => { this.push = null; }; },
      replaceMisspelling: () => Promise.reject(new Error('bridge gone')),
      addToDictionary: () => Promise.resolve({ ok: true }),
    },
  });
  bridge.rightClick(makeField(bridge.doc));
  bridge.emit(contextPayload());
  await tick();
  await assert.doesNotReject(() => bridge.shown[0].items[0].action());
  assert.deepEqual(bridge.logs.map((entry) => entry.slice(0, 2)), [
    ['WARN', 'textfield.spellcheck_action_failed'],
  ]);
  assert.equal(bridge.logs[0][2].method, 'replaceMisspelling');
  bridge.controller.dispose();

  const itemFailure = bindHarness({ execError: new Error('command failed') });
  itemFailure.rightClick(makeField(itemFailure.doc, { selectionEnd: 2 }));
  await tick();
  const cut = itemFailure.shown[0].items.find((item) => item.label === 'Cut');
  let thrown = null;
  try {
    cut.action();
  } catch (error) {
    thrown = error;
    itemFailure.shown[0].onActionError(error, cut);
  }
  assert.equal(thrown?.message, 'command failed', 'the harness must exercise a genuinely thrown action');
  assert.deepEqual(itemFailure.logs.map((entry) => entry.slice(0, 2)), [
    ['WARN', 'textfield.context_menu_failed'],
  ]);
  assert.equal(itemFailure.actionErrors.length, 1);
  assert.equal(itemFailure.actionErrors[0][1], 'Text Field Menu Failed');
  itemFailure.controller.dispose();
});

test('dispose removes the delegated document contextmenu listener', () => {
  const h = bindHarness({ withBridge: true });
  assert.equal(h.doc.listeners.has('contextmenu'), true);
  h.controller.dispose();
  assert.equal(h.doc.listeners.has('contextmenu'), false);
});

test('cleanup during the tracker wait prevents a late menu', async () => {
  const h = bindHarness({ withBridge: true });
  h.rightClick(makeField(h.doc));
  h.cleanups.forEach((cleanup) => cleanup());
  await tick();

  assert.equal(h.shown.length, 0);
});

test('tracker disposal promptly settles a pending wait before the torn guard suppresses opening', async () => {
  const tracker = createSpellcheckContextTracker({ subscribe: () => () => {} });
  let settled = false;
  const pending = tracker.wait(Date.now()).then((value) => {
    settled = true;
    return value;
  });
  tracker.dispose();

  const outcome = await Promise.race([
    pending.then((value) => ({ state: 'settled', value })),
    new Promise((resolve) => setImmediate(() => resolve({ state: 'pending' }))),
  ]);
  assert.deepEqual(outcome, { state: 'settled', value: null });
  assert.equal(settled, true, 'dispose must flush the waiter; a later timeout is not sufficient');
});

test('a field detached during the tracker wait never opens a menu', async () => {
  const h = bindHarness({ withBridge: true });
  const field = makeField(h.doc);
  h.rightClick(field);
  field.isConnected = false;
  h.emit(contextPayload());
  await tick();

  assert.equal(h.shown.length, 0);
  h.controller.dispose();
});

test('the live feature gate and element owner marker suppress delegated menus', async () => {
  const disabled = bindHarness({ isEnabled: () => false });
  disabled.rightClick(makeField(disabled.doc));
  await tick();
  assert.equal(disabled.shown.length, 0);
  disabled.controller.dispose();

  const owned = bindHarness();
  owned.rightClick(makeField(owned.doc, { owner: { dataset: { ctxMenuOwner: 'composer' } } }));
  await tick();
  assert.equal(owned.shown.length, 0);
  owned.controller.dispose();
});
