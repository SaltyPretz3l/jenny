(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererApprovalText = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Shared text helpers of the approval card modules (renderer-approval-block.js and its siblings).

  function normalizeText(value) {
    return String(value == null ? '' : value).trim();
  }

  // Free text arriving from a payload: collapse, bound, never membership-test.
  // Format controls (bidi overrides, zero-width joiners) are stripped: a
  // model-authored purpose could otherwise reorder the headline the reader
  // is approving. A clip is marked so a cut sentence does not read as whole.
  function boundedText(value, maxChars) {
    if (typeof value !== 'string') return '';
    const characters = Array.from(
      value.replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').trim()
    );
    return characters.length > maxChars
      ? characters.slice(0, maxChars - 1).join('') + '\u2026'
      : characters.join('');
  }

  // Quoted arguments keep every character, but an invisible control shows as a visible marker
  // (⟨U+202E⟩) instead of being honored: a bidi override would reorder the command the reader
  // approves, a zero-width space would hide a split. Tabs, newlines and CRLF stay as they are.
  const INVISIBLE_CHARACTER_RE = /(?![\t\n]|\r\n)[\p{Cc}\p{Cf}]/gu;

  function quotedArgumentMarkup(text, escapeHtml) {
    let markup = '';
    let last = 0;
    for (const match of text.matchAll(INVISIBLE_CHARACTER_RE)) {
      const code = match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      markup += escapeHtml(text.slice(last, match.index))
        + `<span class="tool-approval-invisible">\u27E8U+${code}\u27E9</span>`;
      last = match.index + match[0].length;
    }
    return markup + escapeHtml(text.slice(last));
  }

  return { normalizeText, boundedText, quotedArgumentMarkup };
});
