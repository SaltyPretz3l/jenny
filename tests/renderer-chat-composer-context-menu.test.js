'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SPELLCHECK_WAIT_MS,
  bindComposerContextMenu,
  buildComposerClipboardItems,
  buildComposerContextMenuItems,
  createSpellcheckContextTracker,
  normalizeSpellcheckContext,
} = require('../renderer/chat/renderer-chat-event-interactive-bindings');

// Pure-function harness: the composer context menu only reads chatInput
// selection state, ownerDocument.execCommand, and the injected contextMenu host,
// so no jsdom (and therefore no t.after/app.dispose) is needed here.
const BASE_LABELS = ['Cut', 'Copy', 'Paste', '<separator>', 'Select All'];

function labelsOf(items) {
  return items.map((item) => (item.separator ? '<separator>' : item.label));
}

function makeDoc() {
  const execCalls = [];
  return {
    execCalls,
    execCommand(command, _showUi, value) {
      execCalls.push([command, value]);
      return true;
    },
    defaultView: {
      navigator: { clipboard: { readText: () => Promise.resolve('pasted') } },
    },
  };
}

function makeInput(doc, { selectionStart = 0, selectionEnd = 0 } = {}) {
  const focused = [];
  const attributes = new Map();
  return {
    focused,
    selectionStart,
    selectionEnd,
    ownerDocument: doc,
    focus() { focused.push('focus'); },
    select() { focused.push('select'); },
    getAttribute(name) { return attributes.get(name) || null; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
  };
}

function baseItems() {
  const doc = makeDoc();
  return buildComposerClipboardItems({
    chatInput: makeInput(doc),
    doc,
    view: doc.defaultView,
    handleComposerPaste: () => null,
  });
}

function contextPayload(word, suggestions) {
  return { misspelled_word: word, dictionary_suggestions: suggestions, x: 10, y: 20 };
}

test('composer clipboard items are unchanged: Cut/Copy/Paste, separator, Select All', () => {
  assert.deepEqual(labelsOf(baseItems()), BASE_LABELS);
  const doc = makeDoc();
  const withSelection = buildComposerClipboardItems({
    chatInput: makeInput(doc, { selectionStart: 0, selectionEnd: 4 }),
    doc,
    view: doc.defaultView,
    handleComposerPaste: () => null,
  });
  assert.deepEqual(withSelection.slice(0, 2).map((item) => item.disabled), [false, false]);
  assert.deepEqual(baseItems().slice(0, 2).map((item) => item.disabled), [true, true], 'no selection disables Cut/Copy');
});

test('menu merge: a misspelling puts up to 5 suggestions + Add to dictionary + separator above the clipboard items', () => {
  const replaced = [];
  const added = [];
  const items = buildComposerContextMenuItems({
    spellcheck: { word: 'teh', suggestions: ['the', 'ten', 'tea', 'tech', 'teth'] },
    baseItems: baseItems(),
    onReplace: (value) => replaced.push(value),
    onAddToDictionary: (value) => added.push(value),
  });

  assert.deepEqual(labelsOf(items), [
    'the', 'ten', 'tea', 'tech', 'teth', 'Add to dictionary', '<separator>', ...BASE_LABELS,
  ]);
  items[0].action();
  items[5].action();
  assert.deepEqual(replaced, ['the'], 'clicking a suggestion replaces with that suggestion');
  assert.deepEqual(added, ['teh'], 'Add to dictionary carries the misspelled word, not a suggestion');
});

test('menu merge: more than five suggestions truncate to the first five', () => {
  const items = buildComposerContextMenuItems({
    spellcheck: { word: 'teh', suggestions: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
    baseItems: baseItems(),
  });
  assert.deepEqual(labelsOf(items).slice(0, 6), ['a', 'b', 'c', 'd', 'e', 'Add to dictionary']);
});

test('menu merge: a misspelling with no suggestions still offers Add to dictionary + separator', () => {
  const items = buildComposerContextMenuItems({
    spellcheck: { word: 'teh', suggestions: [] },
    baseItems: baseItems(),
  });
  assert.deepEqual(labelsOf(items), ['Add to dictionary', '<separator>', ...BASE_LABELS]);
});

test('menu merge: no payload, no misspelling, or malformed payload leaves the base menu untouched', () => {
  for (const spellcheck of [
    null,
    undefined,
    { word: '', suggestions: ['the'] },
    { word: '   ', suggestions: ['the'] },
    { word: 42, suggestions: ['the'] },
    {},
  ]) {
    assert.deepEqual(labelsOf(buildComposerContextMenuItems({ spellcheck, baseItems: baseItems() })), BASE_LABELS);
  }
  assert.deepEqual(buildComposerContextMenuItems(), []);
  assert.deepEqual(buildComposerContextMenuItems({ baseItems: 'not-an-array' }), []);
});

test('spellcheck payload normalization reads snake_case wire keys and drops blank suggestions', () => {
  const normalized = normalizeSpellcheckContext(contextPayload(' teh ', ['the', '', '  ', ' ten ', 3, 'tea', 'tech', 'teth', 'tehr']), 111);
  assert.equal(normalized.word, 'teh');
  assert.deepEqual(normalized.suggestions, ['the', 'ten', 'tea', 'tech', 'teth']);
  assert.equal(normalized.at, 111);
  assert.deepEqual(normalizeSpellcheckContext(null, 5), { word: '', suggestions: [], at: 5 });
  assert.deepEqual(normalizeSpellcheckContext({ misspelled_word: '', dictionary_suggestions: ['the'] }, 5).suggestions, []);
});

test('spellcheck tracker: a payload received BEFORE the right-click is stale and never reused', async () => {
  let clock = 100;
  let push = null;
  const tracker = createSpellcheckContextTracker({
    subscribe: (listener) => { push = listener; return () => { push = null; }; },
    waitMs: 5,
    now: () => clock,
  });

  push(contextPayload('teh', ['the']));           // stamped at t=100
  clock = 200;
  const stale = await tracker.wait(150);            // right-click happened at t=150
  assert.equal(stale, null, 'a payload older than the click is ignored');

  const fresh = tracker.wait(150);
  push(contextPayload('recieve', ['receive']));     // stamped at t=200
  assert.equal((await fresh).word, 'recieve');

  tracker.dispose();
});

test('spellcheck tracker: no bridge resolves immediately, and a silent bridge resolves null within the wait budget', async () => {
  const absent = createSpellcheckContextTracker({ subscribe: null });
  assert.equal(await absent.wait(Date.now()), null);

  const silent = createSpellcheckContextTracker({ subscribe: () => () => {}, waitMs: 5 });
  const started = Date.now();
  assert.equal(await silent.wait(Date.now()), null);
  assert.ok(Date.now() - started < 1000, 'the wait is bounded, not open-ended');
  silent.dispose();

  // A subscribe that throws (older preload) must not break construction.
  const broken = createSpellcheckContextTracker({ subscribe: () => { throw new Error('no such method'); } });
  assert.equal(await broken.wait(Date.now()), null);
  assert.doesNotThrow(() => broken.dispose());
});

test('spellcheck tracker removes repeated silent waiters when their timeouts settle', async (t) => {
  let emit = null;
  const tracker = createSpellcheckContextTracker({
    subscribe(listener) {
      emit = listener;
      return () => {};
    },
    waitMs: 1,
  });
  t.after(() => tracker.dispose());

  const results = await Promise.all(Array.from({ length: 8 }, () => tracker.wait(Date.now())));
  assert.deepEqual(results, Array(8).fill(null));

  const originalForEach = Array.prototype.forEach;
  let retainedWaiterCount = 0;
  Array.prototype.forEach = function recordWaiterFlush(callback, thisArg) {
    if (this.length && this.every((entry) => typeof entry === 'function')) {
      retainedWaiterCount = this.length;
    }
    return originalForEach.call(this, callback, thisArg);
  };
  try {
    emit({ misspelled_word: 'recieve', dictionary_suggestions: ['receive'] });
  } finally {
    Array.prototype.forEach = originalForEach;
  }

  assert.equal(retainedWaiterCount, 0, 'a later push must not traverse timed-out waiter closures');
});

function bindHarness({ spellcheckApi = null, handleComposerPaste = () => null } = {}) {
  const doc = makeDoc();
  const chatInput = makeInput(doc);
  const shown = [];
  const logs = [];
  const registered = [];
  const cleanups = [];
  const tracker = bindComposerContextMenu({
    chatInput,
    registerListener: (el, type, handler, opts) => registered.push({ el, type, handler, opts }),
    listenerOptions: { passive: false },
    addCleanup: (fn) => cleanups.push(fn),
    handleComposerPaste,
    appendClientLog: (...args) => logs.push(args),
    showComposerActionError: () => {},
    spellcheckApi,
    contextMenuHost: { contextMenu: { show: (opts) => shown.push(opts) } },
  });
  const entry = registered.find((r) => r.type === 'contextmenu');
  const prevented = [];
  const rightClick = () => entry.handler({
    clientX: 42,
    clientY: 84,
    preventDefault: () => prevented.push(true),
  });
  return { chatInput, doc, shown, logs, cleanups, tracker, rightClick, prevented, entry };
}

test('bindComposerContextMenu owns the composer until cleanup', () => {
  const h = bindHarness();
  assert.equal(h.chatInput.getAttribute('data-ctx-menu-owner'), 'composer');
  h.cleanups.forEach((fn) => fn());
  assert.equal(h.chatInput.getAttribute('data-ctx-menu-owner'), null);
});

test('bindComposerContextMenu without the preload bridge shows exactly today menu at the click anchor', async () => {
  const h = bindHarness();
  h.rightClick();
  await new Promise((resolve) => setTimeout(resolve, SPELLCHECK_WAIT_MS + 20));

  assert.equal(h.prevented.length, 1, 'without the bridge the pre-existing preventDefault is kept');
  assert.equal(h.shown.length, 1);
  assert.deepEqual(labelsOf(h.shown[0].items), BASE_LABELS);
  assert.deepEqual([h.shown[0].anchorX, h.shown[0].anchorY], [42, 84], 'anchor is pinned to the original click');
});

test('bindComposerContextMenu merges a fresh misspelling and routes the actions through the preload bridge', async () => {
  let push = null;
  const calls = [];
  const h = bindHarness({
    spellcheckApi: {
      onContext: (listener) => { push = listener; return () => { push = null; }; },
      replaceMisspelling: (word) => { calls.push(['replace', word]); return Promise.resolve({ ok: true }); },
      addToDictionary: (word) => { calls.push(['add', word]); return Promise.resolve({ ok: true }); },
    },
  });

  h.rightClick();
  push(contextPayload('teh', ['the', 'ten']));
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(h.shown.length, 1);
  // Blink only routes the context menu to the main process (where the
  // misspelled word lives) when the DOM event is left uncancelled.
  assert.deepEqual(h.prevented, [], 'the bridge path must NOT preventDefault');
  assert.deepEqual(labelsOf(h.shown[0].items), ['the', 'ten', 'Add to dictionary', '<separator>', ...BASE_LABELS]);
  await h.shown[0].items[0].action();
  await h.shown[0].items[2].action();
  assert.deepEqual(calls, [['replace', 'the'], ['add', 'teh']]);
  assert.deepEqual(h.logs, [], 'a successful correction logs nothing');
  h.cleanups.forEach((fn) => fn());
});

test('bindComposerContextMenu never throws across the seam: rejected or { ok:false } corrections log one bounded WARN', async () => {
  let push = null;
  const h = bindHarness({
    spellcheckApi: {
      onContext: (listener) => { push = listener; return () => { push = null; }; },
      replaceMisspelling: () => Promise.reject(new Error('bridge gone')),
      addToDictionary: () => Promise.resolve({ ok: false, code: 'CMP-SPELL-0002' }),
    },
  });

  h.rightClick();
  push(contextPayload('teh', ['the']));
  await new Promise((resolve) => setTimeout(resolve, 5));

  const items = h.shown[0].items;
  await assert.doesNotReject(() => items[0].action());
  await assert.doesNotReject(() => items[1].action());
  assert.equal(h.logs.length, 2);
  assert.deepEqual(h.logs.map((entry) => [entry[0], entry[1]]), [
    ['WARN', 'composer.spellcheck_action_failed'],
    ['WARN', 'composer.spellcheck_action_failed'],
  ]);
  assert.equal(h.logs[1][2].code, 'CMP-SPELL-0002');

  // A partial bridge (onContext only, no correction methods) is inert, not fatal.
  const partial = bindHarness({ spellcheckApi: { onContext: (listener) => { push = listener; return () => {}; } } });
  partial.rightClick();
  push(contextPayload('teh', ['the']));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.doesNotReject(() => partial.shown[0].items[0].action());
  assert.deepEqual(partial.logs, []);
});

test('bindComposerContextMenu ignores a stale payload from a previous right-click', async () => {
  let push = null;
  const h = bindHarness({
    spellcheckApi: {
      onContext: (listener) => { push = listener; return () => { push = null; }; },
      replaceMisspelling: () => Promise.resolve({ ok: true }),
      addToDictionary: () => Promise.resolve({ ok: true }),
    },
  });

  // First right-click resolves with a real misspelling.
  h.rightClick();
  push(contextPayload('teh', ['the']));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(labelsOf(h.shown[0].items)[0], 'the');

  // Second right-click with no new push: the previous payload must not leak in.
  h.rightClick();
  await new Promise((resolve) => setTimeout(resolve, SPELLCHECK_WAIT_MS + 20));
  assert.equal(h.shown.length, 2);
  assert.deepEqual(labelsOf(h.shown[1].items), BASE_LABELS);
});

test('bindComposerContextMenu degrades safely without a chatInput or a context-menu host', async () => {
  assert.equal(bindComposerContextMenu(), null);
  assert.equal(bindComposerContextMenu({ chatInput: {} }), null);

  const doc = makeDoc();
  const registered = [];
  bindComposerContextMenu({
    chatInput: makeInput(doc),
    registerListener: (el, type, handler) => registered.push({ type, handler }),
    listenerOptions: {},
    contextMenuHost: {},
  });
  const prevented = [];
  assert.doesNotThrow(() => registered[0].handler({
    clientX: 1, clientY: 2, preventDefault: () => prevented.push(true),
  }));
  assert.equal(prevented.length, 1, 'the bridge-less path still suppresses the default even when no menu can be shown');
});
