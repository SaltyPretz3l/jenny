'use strict';

/**
 * Tells the user's hands from the model's on the browser page. Input the model
 * sends itself is announced first through noteOwnInput(); anything else that
 * reaches the page is the user. The service decides whether that takes the browser over.
 *
 * The page gets every key, like any browser tab, except two short lists: Jenny's
 * own window shortcuts, which are handed to the app, and the browser shortcuts
 * (address, find, reload, history, zoom), which the panel handles.
 */

const OWN_INPUT_GRACE_MS = 250;
const KEY_DOWN_TYPES = new Set(['keyDown', 'rawKeyDown']);
const MODIFIER_KEYS = new Set(['control', 'shift', 'alt', 'meta', 'altgraph']);
// Ctrl+K palette, Ctrl+N new chat, Ctrl+1..5 views, Ctrl+\ close the side panel.
const APP_PLAIN_KEYS = new Set(['k', 'n', '1', '2', '3', '4', '5', '\\']);
// Ctrl+Shift+Space capture, Ctrl+Shift+\ split view (the shifted key reads as |).
const APP_SHIFTED_KEYS = new Set([' ', '\\', '|']);
const BROWSER_PLAIN_KEYS = Object.freeze({
  l: 'address', f: 'find', r: 'reload', '=': 'zoom_in', '+': 'zoom_in', '-': 'zoom_out', 0: 'zoom_reset',
});

const primaryOnly = ({ control = false, meta = false }) => control !== meta;

function isAppChord(input) {
  const { alt = false, shift = false } = input;
  if (!primaryOnly(input) || alt) return false;
  const key = String(input.key ?? '').toLowerCase();
  return shift ? APP_SHIFTED_KEYS.has(key) : APP_PLAIN_KEYS.has(key);
}

/** The browser shortcut this key press means, or ''. */
function browserChordOf(input) {
  const { control = false, meta = false, alt = false, shift = false } = input;
  const key = String(input.key ?? '');
  if (key === 'F5' && !control && !meta && !alt && !shift) return 'reload';
  if (alt && !control && !meta && !shift) {
    if (key === 'ArrowLeft') return 'back';
    if (key === 'ArrowRight') return 'forward';
    return '';
  }
  if (!primaryOnly(input) || alt) return '';
  // Ctrl+Plus is Shift+= on most layouts, so Shift only counts for that key.
  if (shift && key !== '+') return '';
  const lower = key.toLowerCase();
  return Object.hasOwn(BROWSER_PLAIN_KEYS, lower) ? BROWSER_PLAIN_KEYS[lower] : '';
}

function chordModifiers(input) {
  return [['control', input.control], ['meta', input.meta], ['alt', input.alt], ['shift', input.shift]]
    .filter(([, held]) => held === true).map(([name]) => name);
}

/** Hands a window shortcut pressed inside the page to the app. */
function createChordForwarder(getMainWindow) {
  return (input) => {
    try {
      const contents = getMainWindow?.()?.webContents;
      if (!contents || contents.isDestroyed?.()) return;
      contents.focus?.();
      const modifiers = chordModifiers(input);
      contents.sendInputEvent({ type: 'keyDown', keyCode: input.key, modifiers });
      contents.sendInputEvent({ type: 'keyUp', keyCode: input.key, modifiers });
    } catch (_error) { /* a lost shortcut is not worth failing the page for */ }
  };
}

function createInputWatch({
  now = Date.now, onTakeOver, onActivity, forwardChord, onBrowserChord, onUserKey, ownInputGraceMs = OWN_INPUT_GRACE_MS,
} = {}) {
  let lastOwnAt = -Infinity;

  const isOwn = () => now() - lastOwnAt < ownInputGraceMs;

  function noteOwnInput() {
    lastOwnAt = now();
  }

  function onKey(event, input) {
    if (!input || isOwn()) return;
    onActivity?.();
    if (!KEY_DOWN_TYPES.has(input.type)) return;
    if (isAppChord(input)) {
      event?.preventDefault?.();
      forwardChord?.(input);
      return;
    }
    const chord = browserChordOf(input);
    if (chord) {
      event?.preventDefault?.();
      onBrowserChord?.(chord);
      return;
    }
    // Holding Ctrl on the way to a shortcut is not touching the page.
    if (MODIFIER_KEYS.has(String(input.key ?? '').toLowerCase())) return;
    onUserKey?.();
    onTakeOver?.('keyboard');
  }

  function onMouse(_event, mouse) {
    if (!mouse || isOwn()) return;
    onActivity?.();
    if (mouse.type === 'mouseDown') onTakeOver?.('mouse');
  }

  return { noteOwnInput, onKey, onMouse };
}

module.exports = { createChordForwarder, createInputWatch };
