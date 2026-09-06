/* renderer/chat/renderer-enter-keydown-utils.js
 * Leaf module (no dependencies) for the shared Enter-to-submit keydown guard,
 * so the composer (renderer-chat-event-utils) and the ask_user question card
 * (renderer-user-questions-actions) apply one IME-safety contract instead of
 * drifting copies. Keep this file dependency-free: renderer-user-questions-actions
 * loads before renderer-chat-event-utils, and requiring either from here would
 * recreate the cycle this module exists to break.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererEnterKeydownUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // IME composition guard for Enter-to-send. When composing with an IME
  // (Chinese/Japanese/Korean, Vietnamese Telex, dead-key accents, …) the
  // Enter keystroke that commits or selects a candidate fires a keydown
  // with `key === 'Enter'`. Without this guard the composer would
  // preventDefault + send the half-composed text and tear down the
  // composition — making text entry effectively unusable for every IME
  // user. `event.keyCode === 229` is the legacy signal some engines still
  // emit for the commit keystroke when `isComposing` has already flipped
  // back to false, so we check both.
  function shouldSendOnEnterKeydown(event) {
    if (!event || event.key !== 'Enter' || event.shiftKey) {
      return false;
    }
    if (event.isComposing === true || event.keyCode === 229) {
      return false;
    }
    return true;
  }

  return { shouldSendOnEnterKeydown };
});
