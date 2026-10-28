/* renderer/features/renderer-ide-output-links.js - clickable file:line references in the
 * Workspace IDE's run and test output (row 82 slice R1). The scanning lives in
 * renderer/shared/file-link-detect.js; this module turns its matches into inventory
 * action-buttons (plain: true) inside the output text and opens them through the
 * cancelable `ide:open-file-at-line` window event, the same seam the chat path links use.
 *
 * Invariant: the linked output is textContent-equivalent to the input text (a button's text
 * is exactly the link text), so selection/copy and the scrollback painter's character
 * accounting never see a difference. Lines over MAX_LINE_CHARS stay plain. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/file-link-detect.js'));
    return;
  }
  root.rendererIdeOutputLinks = factory(root.jennyFileLinkDetect);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (fileLinkDetect) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const MAX_LINE_CHARS = 4096;
  const LINK_ATTR = 'data-ide-output-link-path';
  // Cheap gate before the regex scan: every link shape carries ':' or '(' or "line N".
  const MAYBE_LINK = /[:(]|line \d/;

  function noop() {}

  // The text as ordered segments: { text } for plain runs (consecutive runs merged, newlines
  // included) and { text, link } for a detected reference.
  function segmentsOf(text, rootPath) {
    const source = String(text == null ? '' : text);
    const findLinks = fileLinkDetect && fileLinkDetect.findLinks;
    const segments = [];
    let plain = '';
    function flushPlain() {
      if (plain) segments.push({ text: plain });
      plain = '';
    }
    let offset = 0;
    while (offset <= source.length) {
      const newline = source.indexOf('\n', offset);
      const end = newline === -1 ? source.length : newline;
      const line = source.slice(offset, end);
      let cursor = 0;
      if (typeof findLinks === 'function' && line.length > 0 && line.length <= MAX_LINE_CHARS && MAYBE_LINK.test(line)) {
        for (const link of findLinks(line, { rootPath: String(rootPath || '') }) || []) {
          if (!link || link.start < cursor || link.end <= link.start || !link.path) continue;
          plain += line.slice(cursor, link.start);
          flushPlain();
          segments.push({ text: line.slice(link.start, link.end), link });
          cursor = link.end;
        }
      }
      plain += line.slice(cursor) + (newline === -1 ? '' : '\n');
      if (newline === -1) break;
      offset = newline + 1;
    }
    flushPlain();
    return segments;
  }

  function buttonHtml(segment, options) {
    const link = segment.link;
    return options.actionButton({
      plain: true,
      className: 'ide-output-link',
      title: jt('ide.output.openLink', 'Open {path} at line {line}', { path: link.path, line: link.line }),
      trustedHtml: options.escapeHtml(segment.text),
      dataset: {
        'ide-output-link-path': link.path,
        'ide-output-link-line': String(link.line),
        'ide-output-link-col': link.col ? String(link.col) : '',
      },
    });
  }

  function canLink(options) {
    return Boolean(options && typeof options.actionButton === 'function' && typeof options.escapeHtml === 'function');
  }

  function createLinkedFragment(doc, text, options) {
    const opts = options || {};
    const fragment = doc.createDocumentFragment();
    const segments = canLink(opts) ? segmentsOf(text, opts.rootPath) : [{ text: String(text == null ? '' : text) }];
    let template = null;
    for (const segment of segments) {
      if (segment.link) {
        template = template || doc.createElement('template');
        template.innerHTML = buttonHtml(segment, opts);
        const button = template.content.firstElementChild;
        if (button && button.textContent === segment.text) {
          fragment.appendChild(button);
          continue;
        }
      }
      fragment.appendChild(doc.createTextNode(segment.text));
    }
    return fragment;
  }

  function renderLinkedHtml(text, options) {
    const opts = options || {};
    const escapeHtml = typeof opts.escapeHtml === 'function' ? opts.escapeHtml : (value) => String(value);
    if (!canLink(opts)) return escapeHtml(String(text == null ? '' : text));
    return segmentsOf(text, opts.rootPath)
      .map((segment) => (segment.link ? buttonHtml(segment, opts) : escapeHtml(segment.text)))
      .join('');
  }

  // One delegated click listener: a plain click on a link button opens the file in the IDE.
  function bindOutputLinkClicks(hostEl, options) {
    const opts = options || {};
    if (!hostEl || typeof hostEl.addEventListener !== 'function') return noop;
    const appendClientLog = typeof opts.appendClientLog === 'function' ? opts.appendClientLog : noop;
    function onClick(event) {
      const target = event && event.target;
      const button = target && typeof target.closest === 'function' ? target.closest('[' + LINK_ATTR + ']') : null;
      if (!button) return;
      const win = opts.windowRef || globalThis.window || globalThis;
      const line = Number(button.getAttribute('data-ide-output-link-line'));
      const column = Number(button.getAttribute('data-ide-output-link-col'));
      const detail = { path: button.getAttribute(LINK_ATTR) || '', line, preferIde: true };
      if (column > 0) detail.column = column;
      if (!fileLinkDetect.dispatchOpenFileAtLine(win, detail)) appendClientLog('DEBUG', 'ide.output_link_unclaimed', {});
    }
    hostEl.addEventListener('click', onClick);
    return function unbind() { hostEl.removeEventListener('click', onClick); };
  }

  return { createLinkedFragment, renderLinkedHtml, bindOutputLinkClicks, segmentsOf, MAX_LINE_CHARS };
});
