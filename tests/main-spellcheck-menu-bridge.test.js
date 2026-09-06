'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getBridgeChannel } = require('../services/ipc-contract');
const {
  CODE_INVALID_WORD,
  CODE_NATIVE_FAILED,
  CODE_UNAVAILABLE,
  MAX_WORD_LENGTH,
  attachSpellcheckMenuBridge,
  buildSpellcheckContextPayload,
  createSpellcheckInvokeHandlers,
} = require('../services/main/spellcheck-menu-bridge');

// Electron-free fakes: the bridge only needs webContents.on/send, a session with
// addWordToSpellCheckerDictionary, and an ipcMain-like handle/removeHandler.
function createFakeWindow(overrides = {}) {
  const sent = [];
  const listeners = new Map();
  const dictionary = [];
  const replaced = [];
  const webContents = {
    isDestroyed: () => false,
    on(event, fn) {
      listeners.set(event, fn);
    },
    send(channel, payload) {
      sent.push({ channel, payload });
    },
    replaceMisspelling(word) {
      replaced.push(word);
    },
    session: {
      addWordToSpellCheckerDictionary(word) {
        dictionary.push(word);
        return true;
      },
    },
    ...overrides,
  };
  return {
    isDestroyed: () => false,
    webContents,
    sent,
    listeners,
    dictionary,
    replaced,
  };
}

function createFakeIpcMain() {
  const handlers = new Map();
  const removed = [];
  return {
    handlers,
    removed,
    handle(channel, handler) {
      if (handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`);
      }
      handlers.set(channel, handler);
    },
    removeHandler(channel) {
      if (handlers.delete(channel)) removed.push(channel);
    },
  };
}

test('buildSpellcheckContextPayload emits snake_case wire keys and bounds the suggestion list', () => {
  const payload = buildSpellcheckContextPayload({
    misspelledWord: '  teh  ',
    dictionarySuggestions: ['the', 'ten', 'tea', 'tech', 'teth', 'tehr', 'sixth'],
    x: 120.7,
    y: 44,
    selectionText: 'should never be forwarded',
    linkURL: 'https://example.invalid',
  });

  assert.deepEqual(Object.keys(payload).sort(), [
    'dictionary_suggestions', 'misspelled_word', 'x', 'y',
  ]);
  assert.equal(payload.misspelled_word, 'teh');
  assert.equal(payload.dictionary_suggestions.length, 5, 'suggestions truncate at 5');
  assert.deepEqual(payload.dictionary_suggestions, ['the', 'ten', 'tea', 'tech', 'teth']);
  assert.equal(payload.x, 120, 'coordinates are truncated integers');
  assert.equal(payload.y, 44);
});

test('buildSpellcheckContextPayload clears suggestions when there is no misspelling and refuses unbounded words', () => {
  const cleared = buildSpellcheckContextPayload({ dictionarySuggestions: ['the'], x: 'nope', y: null });
  assert.equal(cleared.misspelled_word, '');
  assert.deepEqual(cleared.dictionary_suggestions, [], 'no word => no suggestions');
  assert.equal(cleared.x, 0, 'non-numeric coordinates fall back to 0');

  const oversize = buildSpellcheckContextPayload({
    misspelledWord: 'a'.repeat(MAX_WORD_LENGTH + 1),
    dictionarySuggestions: ['a'],
  });
  assert.equal(oversize.misspelled_word, '', 'an over-long word is refused, not truncated');
  assert.deepEqual(oversize.dictionary_suggestions, []);

  // Malformed / missing params must never throw across the seam.
  assert.equal(buildSpellcheckContextPayload(null).misspelled_word, '');
  assert.equal(buildSpellcheckContextPayload({ misspelledWord: 42 }).misspelled_word, '');
  assert.deepEqual(buildSpellcheckContextPayload({ dictionarySuggestions: 'the' }).dictionary_suggestions, []);
});

test('attachSpellcheckMenuBridge pushes every right-click (including a cleared payload) and registers both invoke channels', () => {
  const windowRef = createFakeWindow();
  const ipcMainRef = createFakeIpcMain();

  const result = attachSpellcheckMenuBridge({ windowRef, ipcMainRef, getMainWindow: () => windowRef });

  assert.equal(result.contextChannel, getBridgeChannel('spellcheck.onContext', 'subscribe'));
  assert.deepEqual(result.invokeChannels, [
    getBridgeChannel('spellcheck.replaceMisspelling', 'invoke'),
    getBridgeChannel('spellcheck.addToDictionary', 'invoke'),
  ]);
  assert.deepEqual([...ipcMainRef.handlers.keys()], result.invokeChannels);

  const onContextMenu = windowRef.listeners.get('context-menu');
  assert.equal(typeof onContextMenu, 'function', 'context-menu listener registered on webContents');

  onContextMenu({}, { misspelledWord: 'teh', dictionarySuggestions: ['the'], x: 5, y: 6 });
  onContextMenu({}, { misspelledWord: '', dictionarySuggestions: [], x: 7, y: 8 });

  assert.equal(windowRef.sent.length, 2, 'a non-misspelled right-click still pushes so the renderer wait resolves');
  assert.equal(windowRef.sent[0].channel, 'spellcheck:context');
  assert.equal(windowRef.sent[0].payload.misspelled_word, 'teh');
  assert.equal(windowRef.sent[1].payload.misspelled_word, '');
});

test('attachSpellcheckMenuBridge is re-entrant: a second window creation replaces the handlers instead of throwing', () => {
  const ipcMainRef = createFakeIpcMain();
  const first = createFakeWindow();
  attachSpellcheckMenuBridge({ windowRef: first, ipcMainRef, getMainWindow: () => first });

  const second = createFakeWindow();
  assert.doesNotThrow(() => {
    attachSpellcheckMenuBridge({ windowRef: second, ipcMainRef, getMainWindow: () => second });
  });
  assert.equal(ipcMainRef.removed.length, 2, 'both channels were dropped before re-registering');
  assert.equal(ipcMainRef.handlers.size, 2);
});

test('attachSpellcheckMenuBridge degrades to null when the window/webContents is gone or ipcMain is absent', () => {
  assert.equal(attachSpellcheckMenuBridge({}), null);
  assert.equal(attachSpellcheckMenuBridge({ windowRef: { isDestroyed: () => true } }), null);
  assert.equal(attachSpellcheckMenuBridge({ windowRef: { webContents: null } }), null);

  // No ipcMain: the push still works, there are just no correction channels.
  const windowRef = createFakeWindow();
  const pushOnly = attachSpellcheckMenuBridge({ windowRef, ipcMainRef: null, getMainWindow: () => windowRef });
  assert.deepEqual(pushOnly.invokeChannels, []);
  windowRef.listeners.get('context-menu')({}, { misspelledWord: 'teh' });
  assert.equal(windowRef.sent.length, 1);
});

test('spellcheck invoke handlers validate their word and fail closed with structured CMP codes', () => {
  const windowRef = createFakeWindow();
  const warnings = [];
  const handlers = createSpellcheckInvokeHandlers(windowRef, (level, event, detail) => {
    warnings.push({ level, event, detail });
  });
  const replace = handlers['spellcheck.replaceMisspelling'];
  const addWord = handlers['spellcheck.addToDictionary'];

  assert.deepEqual(replace({}, 'the'), { ok: true });
  assert.deepEqual(windowRef.replaced, ['the']);
  assert.deepEqual(addWord({}, '  jenny  '), { ok: true });
  assert.deepEqual(windowRef.dictionary, ['jenny'], 'the word is trimmed before the native call');

  for (const bad of [undefined, null, 42, '', '   ', 'x'.repeat(MAX_WORD_LENGTH + 1)]) {
    assert.deepEqual(replace({}, bad), { ok: false, code: CODE_INVALID_WORD }, `replace refused ${String(bad).slice(0, 12)}`);
    assert.deepEqual(addWord({}, bad), { ok: false, code: CODE_INVALID_WORD });
  }
  assert.deepEqual(windowRef.replaced, ['the'], 'no invalid word ever reached the native call');
  assert.ok(warnings.length >= 12 && warnings.every((entry) => entry.level === 'WARN'));
});

test('spellcheck invoke handlers report unavailability and native failures without throwing', () => {
  const destroyed = { isDestroyed: () => true, webContents: null };
  const gone = createSpellcheckInvokeHandlers(destroyed, () => {});
  assert.deepEqual(gone['spellcheck.replaceMisspelling']({}, 'the'), { ok: false, code: CODE_UNAVAILABLE });
  assert.deepEqual(gone['spellcheck.addToDictionary']({}, 'the'), { ok: false, code: CODE_UNAVAILABLE });

  const noSession = createFakeWindow();
  noSession.webContents.session = null;
  const sessionless = createSpellcheckInvokeHandlers(noSession, () => {});
  assert.deepEqual(sessionless['spellcheck.addToDictionary']({}, 'the'), { ok: false, code: CODE_UNAVAILABLE });

  const throwing = createFakeWindow({
    replaceMisspelling() { throw new Error('native boom'); },
    session: {
      addWordToSpellCheckerDictionary() { throw new Error('dictionary boom'); },
    },
  });
  const failing = createSpellcheckInvokeHandlers(throwing, () => {});
  assert.deepEqual(failing['spellcheck.replaceMisspelling']({}, 'the'), { ok: false, code: CODE_NATIVE_FAILED });
  assert.deepEqual(failing['spellcheck.addToDictionary']({}, 'the'), { ok: false, code: CODE_NATIVE_FAILED });

  // A broken logger must not turn a handled failure into a thrown one.
  const noisy = createSpellcheckInvokeHandlers(destroyed, () => { throw new Error('log boom'); });
  assert.deepEqual(noisy['spellcheck.replaceMisspelling']({}, 'the'), { ok: false, code: CODE_UNAVAILABLE });
});

test('registered spellcheck handlers refuse an untrusted sender instead of touching the native APIs', () => {
  const windowRef = createFakeWindow();
  const ipcMainRef = createFakeIpcMain();
  attachSpellcheckMenuBridge({ windowRef, ipcMainRef, getMainWindow: () => null });

  const replaceChannel = getBridgeChannel('spellcheck.replaceMisspelling', 'invoke');
  const result = ipcMainRef.handlers.get(replaceChannel)({ sender: {} }, 'the');
  assert.deepEqual(result, { ok: false, code: CODE_UNAVAILABLE });
  assert.deepEqual(windowRef.replaced, [], 'an unauthorized sender never reaches replaceMisspelling');
});
