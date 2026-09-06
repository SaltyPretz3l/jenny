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
    const label = 'Review changes';
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
      title: 'Review this change in the diff panel',
      dataset,
      trustedHtml: escape(label),
    });
  }

  return { renderReviewChangesAffordance };
});
