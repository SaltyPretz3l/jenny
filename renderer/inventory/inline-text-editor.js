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
  var escapeHtml = stringUtils && typeof stringUtils.escapeHtml === 'function'
    ? stringUtils.escapeHtml
    : (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  // Resend is disabled while the draft equals the original exactly (commitEdit's
  // check) or is blank with no image to replay; shared with the controller.
  function resolveInlineEditorSaveState(input) {
    var settings = input || {};
    var draft = String(settings.draftText == null ? '' : settings.draftText);
    var original = settings.originalText == null ? draft : String(settings.originalText);
    var resendTitle = jt('inventory.inlineTextEditor.resendTitle', 'Resend (Ctrl+Enter)');
    if (settings.committing === true) {
      return { disabled: true, title: resendTitle, label: jt('inventory.inlineTextEditor.resending', 'Resending\u2026') };
    }
    var disabled = draft === original || (draft.trim() === '' && settings.hasReplayImages !== true);
    return {
      disabled: disabled,
      title: disabled ? jt('inventory.inlineTextEditor.unchangedTitle', 'Change the message to resend it') : resendTitle,
      label: jt('inventory.inlineTextEditor.resend', 'Resend'),
    };
  }

  // The footer's line: text files that cannot be resent, else what resending replaces, else the keys.
  function resolveImpactText(settings, names) {
    if (names.length === 1) return jt('inventory.inlineTextEditor.textFileNotResent', '{name} can\u2019t be resent. Attach it again in the composer if Jenny still needs it.', { name: String(names[0]) });
    if (names.length > 1) return jt('inventory.inlineTextEditor.textFilesNotResent', '{count} text files can\u2019t be resent. Attach them again in the composer if Jenny still needs them.', { count: names.length });
    return Number(settings.affectedCount) > 1
      ? jt('inventory.inlineTextEditor.replacesLater', 'Replaces everything after this message.')
      : jt('inventory.inlineTextEditor.keysHint', 'Ctrl+Enter resends \u00b7 Esc cancels');
  }

  // The edited bubble, then the footer that takes the hover row's place.
  function buildInlineUserMessageEditorMarkup(input) {
    var settings = input || {};
    var id = String(settings.messageId || '');
    var draft = String(settings.draftText == null ? '' : settings.draftText);
    var committing = settings.committing === true;
    var ariaLabel = String(settings.ariaLabel || jt('inventory.inlineTextEditor.ariaLabel', 'Edit your message'));
    var maxLength = Number.isFinite(settings.maxLength) ? settings.maxLength : 32000;
    var rows = Number.isFinite(settings.rows) ? settings.rows : 1;
    var saveState = resolveInlineEditorSaveState({
      draftText: draft,
      originalText: settings.originalText,
      hasReplayImages: settings.hasReplayImages === true,
      committing: committing,
    });
    var names = !committing && Array.isArray(settings.textAttachmentNames) ? settings.textAttachmentNames : [];
    // While resending the button says so; the line stays empty.
    var impact = { text: committing ? '' : resolveImpactText(settings, names), warning: names.length > 0 };
    var busyAttr = committing ? ' aria-busy="true"' : '';
    var escapedId = escapeHtml(id);
    return [
      '<div class="chat-bubble chat-bubble-editing"',
      ' data-message-id="', escapedId, '"',
      ' data-pin-fade-trigger="user" dir="auto"',
      busyAttr, '>',
      '<textarea class="chat-bubble-editor"',
      ' dir="auto"',
      ' spellcheck="true"',
      ' maxlength="', String(maxLength), '"',
      ' rows="', String(rows), '"',
      ' aria-label="', escapeHtml(ariaLabel), '"',
      ' data-edit-target-message-id="', escapedId, '"',
      committing ? ' readonly' : '', busyAttr, '>',
      escapeHtml(draft),
      '</textarea>',
      '</div>',
      '<div class="chat-bubble-editor-foot" data-edit-foot-message-id="', escapedId, '">',
      '<span class="chat-bubble-editor-impact', impact.warning ? ' is-warning' : '', '">', escapeHtml(impact.text), '</span>',
      '<span class="chat-bubble-editor-actions">',
      '<button type="button" class="btn btn--ghost btn--sm chat-bubble-editor-cancel"',
      ' data-edit-action="cancel"',
      ' title="', escapeHtml(jt('inventory.inlineTextEditor.cancelTitle', 'Cancel edit (Esc)')), '"',
      ' data-message-id="', escapedId, '"',
      committing ? ' disabled' : '', '>', escapeHtml(jt('inventory.inlineTextEditor.cancel', 'Cancel')), '</button>',
      '<button type="button" class="btn btn--primary btn--sm chat-bubble-editor-save"',
      ' data-edit-action="save"',
      ' title="', escapeHtml(saveState.title), '"',
      ' data-message-id="', escapedId, '"',
      saveState.disabled ? ' disabled' : '', busyAttr, '>', escapeHtml(saveState.label), '</button>',
      '</span>',
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
    resolveInlineEditorSaveState: resolveInlineEditorSaveState,
  };
});
