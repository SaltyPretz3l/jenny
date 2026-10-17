/**
 * renderer/inventory/empty-note.js
 *
 * The one empty-state style (UMD): a single sentence in muted body type, with an optional second
 * sentence that says what to do next. No box, no icon, no heading: an empty list or section says so
 * once, in plain words, where its content would be.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryEmptyNote = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  /**
   * @param {Object} opts
   * @param {string} opts.text - what is (not) there
   * @param {string} [opts.hint] - what to do next
   * @param {string} [opts.role] - 'status' when the note replaces content live
   * @returns {string} HTML string ('' when there is no text)
   */
  function emptyNote(opts) {
    var o = opts || {};
    var text = String(o.text || '').trim();
    if (!text) return '';
    var hint = String(o.hint || '').trim();
    return '<p class="inv-empty-note"' + (o.role === 'status' ? ' role="status"' : '') + '>'
      + escapeHtml(text) + (hint ? ' <span class="inv-empty-note-hint">' + escapeHtml(hint) + '</span>' : '') + '</p>';
  }

  return emptyNote;
});
