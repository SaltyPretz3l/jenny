/* renderer/chat/renderer-turn-pause-interaction.js -- composer Pause control (UMD) */
/**
 * The composer Pause control: its markup, built at boot through the inventory
 * action-button primitive and placed beside Stop, and the click half. The click
 * owns exactly one decision: at most one pause in flight, for the session the
 * composer is actually looking at. Everything the person is told about the
 * pause -- that it was requested, that it settled, or that the runtime refused
 * it -- belongs to the durable-send controller, so nothing here may claim a
 * reply has paused.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTurnPauseInteraction = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  var PAUSE_BUTTON_CLASS = 'composer-pause-button';
  // Two bars, drawn to the same 16-unit box as the Stop glyph beside it.
  var PAUSE_GLYPH = '<svg viewBox="0 0 16 16" aria-hidden="true">'
    + '<rect x="4.4" y="3.5" width="2.6" height="9" rx="0.9"></rect>'
    + '<rect x="9" y="3.5" width="2.6" height="9" rx="0.9"></rect>'
    + '</svg>';

  function createNoopInteraction() {
    return { dispose: function dispose() {} };
  }

  /**
   * Builds the Pause control through the inventory button primitive and
   * places it directly before Stop, so index.html carries no markup for it.
   * The glyph rides in as static trustedHtml and the accessible name is the
   * aria-label; the static data-i18n markers mirror Stop's so the control is
   * re-translated exactly like its siblings. Idempotent: an existing control
   * beside the anchor is returned as is.
   *
   * @param {Object} deps
   * @param {HTMLElement} deps.anchor - The Stop button the control precedes
   * @param {Function} deps.actionButton - inventoryActionButton
   * @returns {HTMLElement|null}
   */
  function mountTurnPauseButton(deps) {
    deps = deps && typeof deps === 'object' ? deps : {};
    var anchor = deps.anchor;
    var actionButton = deps.actionButton;
    var parent = anchor && anchor.parentNode;
    if (!parent || typeof parent.querySelector !== 'function'
      || typeof anchor.insertAdjacentHTML !== 'function'
      || typeof actionButton !== 'function') {
      return null;
    }
    var existing = parent.querySelector('.' + PAUSE_BUTTON_CLASS);
    if (existing) return existing;
    var markup = actionButton({
      domId: 'pauseTurnButton',
      plain: true,
      className: PAUSE_BUTTON_CLASS + ' hidden',
      ariaLabel: jt('composer.pauseReply', 'Pause this reply'),
      title: jt('composer.pauseReplyTitle', 'Pause at the next approval'),
      dataset: { 'i18n-aria-label': 'composer.pauseReply', 'i18n-title': 'composer.pauseReplyTitle' },
      trustedHtml: PAUSE_GLYPH,
    });
    if (typeof markup !== 'string' || !markup) return null;
    anchor.insertAdjacentHTML('beforebegin', markup);
    return parent.querySelector('.' + PAUSE_BUTTON_CLASS);
  }

  /**
   * @param {Object} deps
   * @param {HTMLElement} deps.button - The composer Pause button
   * @param {Object} deps.state - Renderer state (owns runtimeSendController)
   * @param {Function} deps.getCurrentSessionId - Reads the visible session id
   * @param {Function} [deps.appendClientLog]
   * @returns {{dispose: Function}}
   */
  function createTurnPauseInteraction(deps) {
    deps = deps && typeof deps === 'object' ? deps : {};
    var button = deps.button;
    var state = deps.state;
    var getCurrentSessionId = deps.getCurrentSessionId;
    if (typeof button?.addEventListener !== 'function'
      || typeof button?.removeEventListener !== 'function'
      || !state || typeof state !== 'object'
      || typeof getCurrentSessionId !== 'function') {
      return createNoopInteraction();
    }

    var appendClientLog = typeof deps.appendClientLog === 'function' ? deps.appendClientLog : null;
    var claimed = false;
    var disposed = false;

    async function activate() {
      // The button is disabled while a pause is already requested; re-asking
      // would only persist the same intent again under a stale revision.
      if (disposed || claimed || button.disabled === true) return;
      var sessionId = String(getCurrentSessionId() || '').trim();
      var pauseSession = state.runtimeSendController?.pauseSession;
      if (!sessionId || typeof pauseSession !== 'function') return;
      claimed = true;
      try {
        await state.runtimeSendController.pauseSession(sessionId);
      } catch (error) {
        // The controller names every refusal it can see; a transport failure
        // it never reached is a log line, not a second, louder claim.
        appendClientLog?.('ERROR', 'chat.turn_pause_failed', {
          message: String(error?.message || error || ''),
        });
      } finally {
        claimed = false;
      }
    }

    function handleClick() {
      void activate();
    }

    button.addEventListener('click', handleClick);

    return {
      dispose: function dispose() {
        if (disposed) return;
        disposed = true;
        button.removeEventListener('click', handleClick);
      },
    };
  }

  return {
    createTurnPauseInteraction: createTurnPauseInteraction,
    mountTurnPauseButton: mountTurnPauseButton,
  };
});
