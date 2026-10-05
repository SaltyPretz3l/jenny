/** Raw HTML rendering policy for untrusted Markdown content. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.markdownRawHtmlPolicy = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Unanchored: a raw-text tag nested inside a block HTML token still swallows the document.
  const RAW_TEXT_TAG_RE = /<(?:script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|plaintext)(?=[\s/>])/i;

  function escapeHtmlText(text) {
    return String(text ?? '').replace(/[&<>"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    })[character]);
  }

  function hasUnclosedComment(text) {
    const openIndex = text.lastIndexOf('<!--');
    return openIndex >= 0 && text.indexOf('-->', openIndex + 4) < 0;
  }

  function escapedTokenHtml(token) {
    const escaped = escapeHtmlText(token?.text);
    return token?.block === true ? `<p>${escaped}</p>` : escaped;
  }

  function answerHtmlRenderer(token) {
    const text = String(token?.text ?? '');
    const trimmed = text.trim();
    if (RAW_TEXT_TAG_RE.test(trimmed) || hasUnclosedComment(trimmed)) return escapedTokenHtml(token);
    return text;
  }

  function plainHtmlRenderer(token) {
    return escapedTokenHtml(token);
  }

  function createPlainMarked(markedModule, sharedUseOptions) {
    if (typeof markedModule?.Marked !== 'function') return null;
    const markedPlain = new markedModule.Marked();
    markedPlain.setOptions({ gfm: true, breaks: false });
    markedPlain.use(sharedUseOptions);
    markedPlain.use({ renderer: { html: plainHtmlRenderer } });
    return markedPlain;
  }

  // User messages show what was typed. CommonMark reads a backslash before
  // ASCII punctuation as an escape, which ate the "\" of Windows paths such as
  // C:\repo\.venv in the user bubble (dogfood HB-041). This answer-policy
  // instance keeps an inline escape as its two typed characters at the
  // tokenizer, so code spans, fences, table pipes and HTML blocks still follow
  // the parser's own rules.
  const LITERAL_ESCAPE_RE = /^\\[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/;
  function createUserMarked(markedModule, sharedUseOptions) {
    if (typeof markedModule?.Marked !== 'function') return null;
    const markedUser = new markedModule.Marked();
    markedUser.setOptions({ gfm: true, breaks: false });
    markedUser.use(sharedUseOptions);
    markedUser.use({ renderer: { html: answerHtmlRenderer } });
    markedUser.use({ tokenizer: { escape(src) {
      const match = LITERAL_ESCAPE_RE.exec(src);
      return match ? { type: 'text', raw: match[0], text: match[0], escaped: false } : false;
    } } });
    return markedUser;
  }

  return { escapeHtmlText, RAW_TEXT_TAG_RE, answerHtmlRenderer, plainHtmlRenderer, createPlainMarked,
    createUserMarked };
});
