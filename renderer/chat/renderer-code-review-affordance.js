/* renderer/chat/renderer-code-review-affordance.js
 * Shared Review changes markup used by tool-row status clusters and assistant-turn summaries;
 * both consumers must emit byte-identical dispatcher data attributes.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'), require('../inventory/action-button'));
    return;
  }
  root.rendererCodeReviewAffordance = factory(root.stringUtils || {}, root.inventoryActionButton);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, inventoryActionButton) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const normalizeId = typeof stringUtils.normalizeId === 'function'
    ? stringUtils.normalizeId
    : function fallbackNormalizeId(value) { return String(value || '').trim(); };
  const escapeHtml = typeof stringUtils.escapeHtml === 'function'
    ? stringUtils.escapeHtml
    : function fallbackEscape(value) { return String(value == null ? '' : value); };

  function renderReviewChangesAffordance(reviewableChange, options) {
    if (!reviewableChange || typeof reviewableChange !== 'object') return '';
    const changeId = normalizeId(reviewableChange.changeId);
    const turnId = normalizeId(reviewableChange.turnId);
    const fileKey = normalizeId(reviewableChange.fileKey);
    const scope = normalizeId(reviewableChange.scope) === 'turn' ? 'turn' : 'change';
    if (!turnId || (scope === 'change' && !changeId)) return '';
    const escape = typeof options?.escapeHtml === 'function' ? options.escapeHtml : escapeHtml;
    const label = jt('chat.codeReview.reviewChanges', 'Review changes');
    const dataset = {
      'jenny-code-review': '',
      scope,
      'turn-id': turnId,
    };
    if (scope === 'change') {
      dataset['change-id'] = changeId;
      dataset['file-key'] = fileKey;
    }
    return inventoryActionButton({
      plain: true,
      className: 'jenny-code-review-affordance',
      label,
      ariaLabel: label,
      title: jt('chat.codeReview.openDiffTitle', 'Review this change in the diff panel'),
      dataset,
      trustedHtml: escape(label),
    });
  }

  return { renderReviewChangesAffordance };
});
