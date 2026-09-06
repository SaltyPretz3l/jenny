/* renderer/shared/markdown-inline-paths.js
 * Sibling of markdown-utils.js (that file sits at the file-size cap): path-
 * shaped inline code spans in rendered markdown become first-class path
 * chips — focusable role=link plus the data-chat-path* contract — so the
 * chat timeline's shared chip handlers (renderer-chat-path-open.js: click,
 * Enter/Space, contextmenu) drive them with full keyboard parity.
 *
 * Runs post-sanitize inside decorateCodeBlocks; adds only inert data/ARIA
 * attributes. The chip handler re-validates the path before navigating, so
 * this is affordance, not authority.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.markdownInlinePaths = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Parity with renderer-chat-path-open.js: workspace-relative shape, word-ish
  // segments, at least one separator, no absolute/parent escapes, optional
  // trailing :line[:column]. NB [\w.-]+ matches '..', so parent escapes must
  // be rejected explicitly after the match.
  const INLINE_PATH_TARGET_RE = /^(?:\.\/)?[\w.-]+(?:\/[\w.-]+)+(?::(\d+)(?::(\d+))?)?$/;

  function parseInlineCodePathTarget(rawText) {
    const text = String(rawText || '').trim().replace(/\\/g, '/');
    if (!text || text.length > 512) {
      return null;
    }
    const match = INLINE_PATH_TARGET_RE.exec(text);
    if (!match) {
      return null;
    }
    const path = text.replace(/:\d+(?::\d+)?$/, '');
    if (path.split('/').some((segment) => segment === '..')) {
      return null;
    }
    const line = match[1] ? parseInt(match[1], 10) : 0;
    const column = match[2] ? parseInt(match[2], 10) : 0;
    return {
      path,
      line: line >= 1 ? line : null,
      column: column >= 1 ? column : null,
    };
  }

  // contentRoot: the decorate template's DocumentFragment (or any container).
  // Fenced blocks (code inside <pre>) are never decorated.
  function decorateInlinePathChips(contentRoot) {
    if (!contentRoot || typeof contentRoot.querySelectorAll !== 'function') {
      return;
    }
    contentRoot.querySelectorAll('code').forEach((codeNode) => {
      if (codeNode.closest('pre') || codeNode.hasAttribute('data-chat-path-open')) {
        return;
      }
      const pathTarget = parseInlineCodePathTarget(codeNode.textContent);
      if (!pathTarget) {
        return;
      }
      codeNode.classList.add('chat-inline-path');
      codeNode.setAttribute('role', 'link');
      codeNode.setAttribute('tabindex', '0');
      codeNode.setAttribute('data-chat-path-open', pathTarget.path);
      codeNode.setAttribute('data-chat-path', pathTarget.path);
      if (pathTarget.line) {
        codeNode.setAttribute('data-chat-path-line', String(pathTarget.line));
      }
      if (pathTarget.column) {
        codeNode.setAttribute('data-chat-path-column', String(pathTarget.column));
      }
    });
  }

  return {
    parseInlineCodePathTarget,
    decorateInlinePathChips,
  };
});
