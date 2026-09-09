(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'), require('../inventory/action-button'));
    return;
  }
  root.rendererResumeTurnAffordance = factory(root.stringUtils, root.inventoryActionButton);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, actionButton) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const RESUMABLE_STOP_KINDS = Object.freeze([
    'tool_cap',
    'max_iterations',
    'diminishing_returns',
    'context_budget',
  ]);

  function buildResumeAffordanceMarkup({ kind, messageId, sessionId, disabled } = {}) {
    const normalizedMessageId = stringUtils.normalizeId(messageId);
    if (!RESUMABLE_STOP_KINDS.includes(kind) || !normalizedMessageId) {
      return '';
    }
    const normalizedSessionId = stringUtils.normalizeId(sessionId);
    const buttonMarkup = actionButton({
      id: 'resume-turn',
      label: jt('chat.resumeTurn.resume', 'Resume'),
      variant: 'secondary',
      size: 'sm',
      className: 'resume-turn-action',
      ariaLabel: jt('chat.resumeTurn.ariaLabel', 'Resume this turn'),
      title: jt('chat.resumeTurn.title', 'Resume this turn (Enter from an empty composer)'),
      disabled,
      dataset: {
        'resume-message-id': normalizedMessageId,
        'resume-session-id': normalizedSessionId,
      },
    });
    return '<div class="resume-turn-affordance"'
      + ` data-resume-turn="${stringUtils.escapeHtml(normalizedMessageId)}"`
      + ` data-resume-kind="${stringUtils.escapeHtml(kind)}"`
      + ' role="group" aria-label="' + stringUtils.escapeHtml(jt('chat.resumeTurn.ariaLabel', 'Resume this turn')) + '">'
      + buttonMarkup
      + '<span class="resume-turn-hint" aria-hidden="true">&#9166;</span>'
      + '</div>';
  }

  return { RESUMABLE_STOP_KINDS, buildResumeAffordanceMarkup };
});
