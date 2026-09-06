/* renderer/shared/string-utils.js – shared string normalization helpers (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.stringUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Heading / bullet / ordered / quote markers that open a line. */
  var LEADING_BLOCK_MARKER_RE = /^[ \t]*(?:#{1,6}\s+|[-*+>]\s+|\d+\.\s+)/gmu;
  var WHOLE_LABEL_DUNDER_RE = /^__([^_](?:.*[^_])?)__$/u;
  /* Single-marker emphasis unwraps ONLY when it spans the whole label
   * (mirrors the dunder rule): interior single markers are
   * identifier-shaped (snake_case, *args) and must survive. */
  var WHOLE_LABEL_EMPHASIS_RE = /^(?:\*([^*](?:.*[^*])?)\*|_([^_](?:.*[^_])?)_)$/u;
  /* Link destinations may carry ONE level of balanced parentheses
   * (wiki URLs like /Array_(data_structure)). */
  var LINK_RE = /\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g;

  /**
   * Coerce any value to a trimmed string.
   * Null / undefined → '', numbers → their string form, etc.
   */
  function normalizeString(value) {
    return String(value || '').trim();
  }

  /**
   * Semantic alias for normalizing identifier fields (session IDs, call IDs, etc.).
   */
  function normalizeId(value) {
    return String(value || '').trim();
  }

  /**
   * Escape the five XML special characters so a string can be safely
   * interpolated into HTML markup. Use this anywhere user-provided or
   * model-provided text is concatenated into an innerHTML payload.
   */
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Escape regex metacharacters so a runtime string can be embedded as
   * a literal in `new RegExp(...)`.
   */
  function escapeRegExp(value) {
    return String(value || '').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }

  /**
   * Coerce a value to a [A-Za-z0-9_-] token, falling back to the
   * provided default if the input contains anything else. Use for
   * identifiers that flow into DOM ids / class names where a malformed
   * input could break selectors.
   */
  function sanitizeToken(value, fallback) {
    var normalized = String(value || '').trim();
    return /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : fallback;
  }

  /**
   * Flatten markdown decoration out of a one-line label — a reasoning row
   * header, a home-panel loop title — without mangling literal identifiers.
   * Deliberately conservative: only paired `**…**` / backtick spans and a
   * whole-label `__…__` wrap are unwrapped, so snake_case, `__init__.py`,
   * `**kwargs` and other unpaired markers pass through untouched. Link
   * syntax collapses to its text, a leading block marker is dropped from
   * each line, and whitespace runs collapse so the result is one display
   * line. (A label that IS a bare dunder, e.g. exactly `__init__`, does
   * unwrap — an accepted non-case for titles.)
   */
  function stripInlineMarkdownLabel(value) {
    var label = String(value == null ? '' : value).trim();
    if (!label) {
      return '';
    }
    label = label.replace(LINK_RE, '$1');
    label = label.replace(LEADING_BLOCK_MARKER_RE, '');
    var previous;
    do {
      previous = label;
      label = label
        .replace(/\*\*([^*\n]+)\*\*/gu, '$1')
        .replace(/`([^`\n]+)`/gu, '$1');
    } while (label !== previous);
    var wholeDunder = label.match(WHOLE_LABEL_DUNDER_RE);
    if (wholeDunder) {
      label = wholeDunder[1];
    }
    var wholeEmphasis = label.match(WHOLE_LABEL_EMPHASIS_RE);
    if (wholeEmphasis) {
      label = wholeEmphasis[1] != null ? wholeEmphasis[1] : wholeEmphasis[2];
    }
    return label.replace(/\s+/gu, ' ').trim();
  }

  return {
    normalizeString,
    normalizeId,
    escapeHtml,
    escapeRegExp,
    sanitizeToken,
    stripInlineMarkdownLabel,
  };
});
