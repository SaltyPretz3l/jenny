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
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  var escapeHtml = stringUtils && typeof stringUtils.escapeHtml === 'function'
    ? stringUtils.escapeHtml
    : (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

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
    var ariaLabel = String(settings.ariaLabel || jt('inventory.inlineTextEditor.ariaLabel', 'Edit your message'));
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
      ' dir="auto"',
      ' spellcheck="true"',
      ' maxlength="', String(maxLength), '"',
      ' rows="', String(rows), '"',
      ' aria-label="', escapeHtml(ariaLabel), '"',
      ' data-edit-target-message-id="', escapeHtml(id), '"',
      disabledAttr, '>',
      escapeHtml(draft),
      '</textarea>',
      affectedCount > 0
        ? '<p class="chat-bubble-editor-impact">' + escapeHtml(jtn('inventory.inlineTextEditor.affectedMessages', affectedCount, { count: affectedCount }, 'Affects {count} existing message: this message and all later history.', 'Affects {count} existing messages: this message and all later history.')) + '</p>'
        : '',
      '<div class="chat-bubble-editor-actions">',
      '<button type="button" class="chat-bubble-editor-cancel"',
      ' data-edit-action="cancel"',
      ' title="', escapeHtml(jt('inventory.inlineTextEditor.cancelTitle', 'Cancel edit (Esc)')), '"',
      ' data-message-id="', escapeHtml(id), '"',
      disabledAttr, '>', escapeHtml(cancelLabel), '</button>',
      '<button type="button" class="chat-bubble-editor-save"',
      ' data-edit-action="save"',
      ' title="', escapeHtml(jt('inventory.inlineTextEditor.saveTitle', 'Save and resend (Ctrl+Enter)')), '"',
      ' data-message-id="', escapeHtml(id), '"',
      disabledAttr, '>', escapeHtml(saveLabel), '</button>',
      '</div>',
      '</div>',
    ].join('');
  }

  /**
   * A bare note field (row 35: the comment / reject-reason box under the
   * suggested-change bar). The caller owns the buttons and the key handling.
   *
   * @param {object} input
   * @param {string} input.ariaLabel
   * @param {string} [input.draftText]
   * @param {string} [input.placeholder]
   * @param {number} [input.rows] default 2
   * @param {number} [input.maxLength] default 2000
   * @param {string} [input.className]
   * @param {Object<string,string>} [input.dataset] data-* attributes (keys without the prefix)
   * @param {boolean} [input.disabled]
   * @returns {string}
   */
  function buildInlineNoteFieldMarkup(input) {
    var settings = input || {};
    var dataset = settings.dataset && typeof settings.dataset === 'object' ? settings.dataset : {};
    var dataAttrs = Object.keys(dataset)
      .filter(function (key) { return /^[a-z][a-z0-9-]*$/.test(key); })
      .map(function (key) { return ' data-' + key + '="' + escapeHtml(dataset[key]) + '"'; })
      .join('');
    var className = String(settings.className || '').split(/\s+/).filter(function (token) {
      return /^[A-Za-z0-9_-]+$/.test(token);
    }).join(' ');
    return '<textarea class="inv-note-field' + (className ? ' ' + className : '') + '"'
      + ' data-inline-note dir="auto" spellcheck="true"'
      + ' rows="' + String(Number.isFinite(settings.rows) ? settings.rows : 2) + '"'
      + ' maxlength="' + String(Number.isFinite(settings.maxLength) ? settings.maxLength : 2000) + '"'
      + ' aria-label="' + escapeHtml(String(settings.ariaLabel || '')) + '"'
      + (settings.placeholder ? ' placeholder="' + escapeHtml(settings.placeholder) + '"' : '')
      + dataAttrs
      + (settings.disabled ? ' disabled' : '')
      + '>' + escapeHtml(String(settings.draftText == null ? '' : settings.draftText)) + '</textarea>';
  }

  return {
    buildInlineNoteFieldMarkup: buildInlineNoteFieldMarkup,
    buildInlineUserMessageEditorMarkup: buildInlineUserMessageEditorMarkup,
  };
});
