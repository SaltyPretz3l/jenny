/* renderer/inventory/selection-handle.js
 *
 * Inventory primitive owning the raw <button> markup for the
 * multi-select checkbox affordance attached to each `.chat-entry` when
 * selection mode is active. Two render paths consume this:
 *   - renderer/chat/renderer-turn-row-render-utils.js (projector path)
 *   - renderer/chat/renderer-render-pipeline-article-markup.js (legacy path)
 *
 * Keeping the raw <button> inside renderer/inventory/ satisfies
 * check_no_raw_html_primitives.py without growing legacy allowlist counts.
 * Returns a markup string; click handling lives in the transcript-bindings
 * dispatcher keyed off data-select-message-id.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'));
    return;
  }
  root.inventorySelectionHandle = factory(root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils) {
  'use strict';

  var escapeHtml = stringUtils && stringUtils.escapeHtml;
  if (typeof escapeHtml !== 'function') {
    throw new Error('inventorySelectionHandle: renderer/shared/string-utils.js must load before this module');
  }

  /**
   * Build the markup for a selection-handle (role="checkbox") button.
   *
   * @param {object} input
   * @param {string} input.messageId  — value bound to data-select-message-id
   * @param {boolean} [input.selected] — initial aria-checked state
   * @param {string} [input.ariaLabel] — accessibility label (default "Select this message")
   * @returns {string} HTML markup string
   */
  function buildSelectionHandleMarkup(input) {
    var settings = input || {};
    var id = String(settings.messageId || '');
    var selected = settings.selected === true;
    var ariaLabel = String(settings.ariaLabel || 'Select this message');
    var dataSelected = selected ? 'true' : 'false';
    return [
      '<button type="button" class="chat-entry-select-handle"',
      ' role="checkbox"',
      ' aria-checked="', dataSelected, '"',
      ' data-select-message-id="', escapeHtml(id), '"',
      ' data-selected="', dataSelected, '"',
      ' title="', escapeHtml(ariaLabel), '"',
      ' aria-label="', escapeHtml(ariaLabel), '">',
      '<span class="chat-entry-select-handle-glyph" aria-hidden="true"></span>',
      '</button>',
    ].join('');
  }

  return {
    buildSelectionHandleMarkup: buildSelectionHandleMarkup,
  };
});
