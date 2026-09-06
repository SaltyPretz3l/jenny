'use strict';

// Spellcheck bridge (originally composer-only; now serves every eligible field).
//
// Chromium spellchecks text fields natively (webPreferences default), so the red
// squigglies render — but the renderer builds its own inventory menus, so
// `params.misspelledWord` / `params.dictionarySuggestions` never reach the
// user. Electron exposes those ONLY on the MAIN-process
// `webContents.on('context-menu')` event, so this module forwards exactly the
// spellcheck-relevant slice of that event to the renderer and registers the two
// natively-owned corrections (`replaceMisspelling`,
// `addWordToSpellCheckerDictionary`) as invoke channels.
//
// This listener is TARGET-AGNOSTIC: it fires for every right-click in the
// window, which is why extending suggestions from the composer to the ~21
// delegated prose fields (renderer/chat/renderer-chat-event-interactive-bindings.js,
// `bindTextFieldContextMenu`) needed no change here. Whether any suggestion
// exists at all is gated upstream by the session spellchecker, which the
// `text_spellcheck` flag drives via services/main/spellcheck-session-controller.js.
//
// LOAD-BEARING renderer constraint: the composer's `contextmenu` listener must
// NOT call `preventDefault()` while this bridge is present. Blink only reaches
// `ContextMenuController` (and therefore this event) through
// `Node::DefaultEventHandler`, which `DispatchEventPostProcess` skips for a
// cancelled event. Electron renders no default context menu, so leaving the
// event uncancelled costs nothing visually.
//
// Wire payload is snake_case per AGENTS.md ("Casing at boundaries"):
//   { misspelled_word, dictionary_suggestions, x, y }
// A *cleared* payload is pushed on every non-misspelled right-click too, so the
// renderer's bounded wait always resolves instead of timing out.

const {
  getBridgeChannel,
  registerIpcInvokeHandlers,
} = require('../ipc-contract');
const { createTrustedSenderAuthorizer } = require('./ipc-sender-authorization');
const { SPELLCHECK_ERROR_CODES } = require('../backend/error-codes');

// A word longer than this is not a dictionary word; refuse rather than hand an
// unbounded renderer-supplied string to a native Chromium call.
const MAX_WORD_LENGTH = 256;
const MAX_SUGGESTIONS = 5;

const SPELLCHECK_INVOKE_PATHS = Object.freeze([
  'spellcheck.replaceMisspelling',
  'spellcheck.addToDictionary',
]);

const CODE_INVALID_WORD = SPELLCHECK_ERROR_CODES.INVALID_WORD;
const CODE_UNAVAILABLE = SPELLCHECK_ERROR_CODES.UNAVAILABLE;
const CODE_NATIVE_FAILED = SPELLCHECK_ERROR_CODES.NATIVE_FAILED;

function boundedWord(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_WORD_LENGTH) return '';
  return trimmed;
}

function boundedSuggestions(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const suggestion = boundedWord(entry);
    if (suggestion) out.push(suggestion);
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

function boundedCoordinate(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

// Exported for tests: the pure params -> wire-payload projection. Never carries
// selection text, frame urls, link targets, or any other context-menu field.
function buildSpellcheckContextPayload(params) {
  const misspelledWord = boundedWord(params && params.misspelledWord);
  return {
    misspelled_word: misspelledWord,
    dictionary_suggestions: misspelledWord
      ? boundedSuggestions(params && params.dictionarySuggestions)
      : [],
    x: boundedCoordinate(params && params.x),
    y: boundedCoordinate(params && params.y),
  };
}

function liveWebContents(windowRef) {
  if (!windowRef || windowRef.isDestroyed?.() === true) return null;
  const contents = windowRef.webContents;
  if (!contents || contents.isDestroyed?.() === true) return null;
  return contents;
}

function createSpellcheckInvokeHandlers(windowRef, log) {
  const failure = (code, event, detail) => {
    try {
      log('WARN', event, { code, ...(detail || {}) });
    } catch (_error) {
      /* logging is best-effort; never fail the seam on it */
    }
    return { ok: false, code };
  };
  return {
    'spellcheck.replaceMisspelling': (_event, suggestion) => {
      const word = boundedWord(suggestion);
      if (!word) return failure(CODE_INVALID_WORD, 'spellcheck.replace_rejected');
      const contents = liveWebContents(windowRef);
      if (!contents || typeof contents.replaceMisspelling !== 'function') {
        return failure(CODE_UNAVAILABLE, 'spellcheck.replace_unavailable');
      }
      try {
        contents.replaceMisspelling(word);
      } catch (error) {
        return failure(CODE_NATIVE_FAILED, 'spellcheck.replace_failed', {
          message: String(error?.message || error).slice(0, 200),
        });
      }
      return { ok: true };
    },
    'spellcheck.addToDictionary': (_event, requestedWord) => {
      const word = boundedWord(requestedWord);
      if (!word) return failure(CODE_INVALID_WORD, 'spellcheck.add_word_rejected');
      const contents = liveWebContents(windowRef);
      const session = contents ? contents.session : null;
      if (!session || typeof session.addWordToSpellCheckerDictionary !== 'function') {
        return failure(CODE_UNAVAILABLE, 'spellcheck.add_word_unavailable');
      }
      try {
        // Chromium returns false when the word is already present or the
        // custom dictionary is unavailable; neither is an error worth
        // surfacing to the composer.
        session.addWordToSpellCheckerDictionary(word);
      } catch (error) {
        return failure(CODE_NATIVE_FAILED, 'spellcheck.add_word_failed', {
          message: String(error?.message || error).slice(0, 200),
        });
      }
      return { ok: true };
    },
  };
}

/**
 * Wire the spellcheck bridge onto one BrowserWindow.
 *
 * Fail-soft by contract: a missing window, missing ipcMain, or a webContents
 * that refuses listeners degrades every spellcheck-eligible field (composer and
 * delegated alike) to a clipboard-only menu with no suggestions, rather than
 * blocking window creation.
 *
 * @returns {{ contextChannel: string, invokeChannels: string[] }|null}
 */
function attachSpellcheckMenuBridge({
  windowRef,
  ipcMainRef = null,
  getMainWindow = null,
  log = () => {},
} = {}) {
  const contents = liveWebContents(windowRef);
  if (!contents || typeof contents.on !== 'function') return null;

  let contextChannel = '';
  try {
    contextChannel = getBridgeChannel('spellcheck.onContext', 'subscribe');
    contents.on('context-menu', (_event, params) => {
      const target = liveWebContents(windowRef);
      if (!target || typeof target.send !== 'function') return;
      try {
        target.send(contextChannel, buildSpellcheckContextPayload(params));
      } catch (_error) {
        /* a destroyed/navigating renderer simply gets no payload */
      }
    });
  } catch (error) {
    try {
      log('WARN', 'spellcheck.context_listener_failed', {
        message: String(error?.message || error).slice(0, 200),
      });
    } catch (_logError) {
      /* best-effort */
    }
    return null;
  }

  let invokeChannels = [];
  if (ipcMainRef && typeof ipcMainRef.handle === 'function') {
    // Window creation can repeat (re-open after close); ipcMain.handle throws on
    // a second registration, so drop any previous handler first.
    for (const methodPath of SPELLCHECK_INVOKE_PATHS) {
      try {
        ipcMainRef.removeHandler?.(getBridgeChannel(methodPath, 'invoke'));
      } catch (_error) {
        /* no previous handler */
      }
    }
    try {
      invokeChannels = registerIpcInvokeHandlers(
        ipcMainRef,
        createSpellcheckInvokeHandlers(windowRef, log),
        {
          authorize: createTrustedSenderAuthorizer({
            getMainWindow: typeof getMainWindow === 'function'
              ? getMainWindow
              : () => windowRef,
            log,
          }),
          unauthorizedResult: () => ({ ok: false, code: CODE_UNAVAILABLE }),
        }
      );
    } catch (error) {
      try {
        log('WARN', 'spellcheck.handler_registration_failed', {
          message: String(error?.message || error).slice(0, 200),
        });
      } catch (_logError) {
        /* best-effort */
      }
      invokeChannels = [];
    }
  }

  return { contextChannel, invokeChannels };
}

module.exports = {
  CODE_INVALID_WORD,
  CODE_NATIVE_FAILED,
  CODE_UNAVAILABLE,
  MAX_SUGGESTIONS,
  MAX_WORD_LENGTH,
  SPELLCHECK_INVOKE_PATHS,
  attachSpellcheckMenuBridge,
  buildSpellcheckContextPayload,
  createSpellcheckInvokeHandlers,
};
