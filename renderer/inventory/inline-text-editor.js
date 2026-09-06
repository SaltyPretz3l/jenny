/* renderer/inventory/inline-text-editor.js
 *
 * F2: inventory primitive owning the raw HTML markup for the user-message
 * inline edit affordance. Two render paths in the chat pipeline consume this:
 *   - renderer/chat/renderer-turn-row-render-utils.js (projector path)
 *   - renderer/chat/renderer-render-pipeline-article-markup.js (legacy path)
 *
 * Keeping the raw <textarea>/<button> elements inside renderer/inventory/
 * satisfies `check_no_raw_html_primitives.py` without growing legacy
 * allowlist counts. Returns a markup string — callers paste it into their
 * existing innerHTML pipelines; event wiring lives in the message-edit
 * controller (renderer/chat/renderer-chat-message-edit-utils.js) which
 * binds against data-edit-target-message-id / data-edit-action attributes.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'));
    return;
  }
  root.inventoryInlineTextEditor = factory(root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils) {
  'use strict';

  var escapeHtml = stringUtils && typeof stringUtils.escapeHtml === 'function'
    ? stringUtils.escapeHtml
    : function fallbackEscapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    };

  /**
   * Build the markup for an inline user-message editor.
   *
   * @param {object} input
   * @param {string} input.messageId  — value bound to data-message-id and data-edit-target-message-id
   * @param {string} [input.draftText] — initial textarea value (pre-escaped is fine; we escape)
   * @param {boolean} [input.committing] — when true, disables the controls + sets aria-busy
   * @param {string} [input.ariaLabel] — accessibility label for the textarea (default "Edit your message")
   * @param {number} [input.maxLength] — textarea maxlength (default 32000)
   * @param {number} [input.rows] — initial textarea row count (default 3)
   * @param {string} [input.cancelLabel] — Cancel button text (default "Cancel")
   * @param {string} [input.saveLabel] — Save button text (default "Save")
   * @returns {string} HTML markup string
   */
  function buildInlineUserMessageEditorMarkup(input) {
    var settings = input || {};
    var id = String(settings.messageId || '');
    var draft = String(settings.draftText == null ? '' : settings.draftText);
    var committing = settings.committing === true;
    var ariaLabel = String(settings.ariaLabel || 'Edit your message');
    var maxLength = Number.isFinite(settings.maxLength) ? settings.maxLength : 32000;
    var rows = Number.isFinite(settings.rows) ? settings.rows : 3;
    var cancelLabel = String(settings.cancelLabel || 'Cancel');
    var saveLabel = String(settings.saveLabel || 'Save');
    var affectedCount = Math.max(Math.floor(Number(settings.affectedCount) || 0), 0);
    var disabledAttr = committing ? ' disabled' : '';
    var ariaBusyAttr = committing ? ' aria-busy="true"' : '';
    return [
      '<div class="chat-bubble chat-bubble-editing"',
      ' data-message-id="', escapeHtml(id), '"',
      ' data-pin-fade-trigger="user"',
      ariaBusyAttr, '>',
      '<textarea class="chat-bubble-editor"',
      ' spellcheck="true"',
      ' maxlength="', String(maxLength), '"',
      ' rows="', String(rows), '"',
      ' aria-label="', escapeHtml(ariaLabel), '"',
      ' data-edit-target-message-id="', escapeHtml(id), '"',
      disabledAttr, '>',
      escapeHtml(draft),
      '</textarea>',
      affectedCount > 0
        ? '<p class="chat-bubble-editor-impact">Affects ' + affectedCount
          + (affectedCount === 1 ? ' existing message' : ' existing messages')
          + ': this message and all later history.</p>'
        : '',
      '<div class="chat-bubble-editor-actions">',
      '<button type="button" class="chat-bubble-editor-cancel"',
      ' data-edit-action="cancel"',
      ' title="Cancel edit (Esc)"',
      ' data-message-id="', escapeHtml(id), '"',
      disabledAttr, '>', escapeHtml(cancelLabel), '</button>',
      '<button type="button" class="chat-bubble-editor-save"',
      ' data-edit-action="save"',
      ' title="Save and resend (Ctrl+Enter)"',
      ' data-message-id="', escapeHtml(id), '"',
      disabledAttr, '>', escapeHtml(saveLabel), '</button>',
      '</div>',
      '</div>',
    ].join('');
  }

  return {
    buildInlineUserMessageEditorMarkup: buildInlineUserMessageEditorMarkup,
  };
});
