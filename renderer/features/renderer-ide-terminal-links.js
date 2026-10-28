/* renderer/features/renderer-ide-terminal-links.js - clickable links in the Workspace PTY
 * terminal (row 82 T1): `file:line[:col]` output opens the IDE editor at that spot, and
 * http(s) URLs open in the system browser. Both need Ctrl (Cmd on macOS) held, VS Code's
 * terminal rule, so a plain click keeps selecting text.
 *
 * File links read the xterm buffer (a path broken by the terminal width is re-joined across
 * up to MAX_WRAPPED_ROWS wrapped rows), run jennyFileLinkDetect.findLinks against the
 * session cwd and activate through the cancelable `ide:open-file-at-line` seam that
 * renderer-chat-path-open.js claims. URLs open only through window.open for http(s), which
 * services/main-window-navigation-guard.js routes to the system browser. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTerminalLinks = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const MAX_WRAPPED_ROWS = 4;
  const HTTP_URL_RE = /^https?:\/\//i;

  function noop() {}

  function resolveDetect() {
    if (globalRef.jennyFileLinkDetect) {
      return globalRef.jennyFileLinkDetect;
    }
    // Node/test path only; a fixed in-repo module, so a failure is a real defect.
    return typeof require === 'function' ? require('../shared/file-link-detect') : null;
  }

  function isModifierHeld(event) {
    return Boolean(event && (event.ctrlKey || event.metaKey));
  }

  // Buffer text of the logical line covering row `y` (1-based): the wrapped rows
  // around it joined, each non-final row padded to `cols` so a text index maps to a
  // cell. Returns { startRow, text, cols } or null when the row has no buffer line.
  function readLogicalLine(term, y) {
    const buffer = term?.buffer?.active;
    if (!buffer || typeof buffer.getLine !== 'function') {
      return null;
    }
    let startRow = y;
    for (let back = 0; back < MAX_WRAPPED_ROWS - 1; back += 1) {
      const line = buffer.getLine(startRow - 1);
      if (!line || line.isWrapped !== true || startRow <= 1) {
        break;
      }
      startRow -= 1;
    }
    const first = buffer.getLine(startRow - 1);
    if (!first) {
      return null;
    }
    const cols = Number(term.cols) > 0 ? Math.floor(Number(term.cols)) : 0;
    const rows = [first];
    while (rows.length < MAX_WRAPPED_ROWS) {
      const next = buffer.getLine(startRow - 1 + rows.length);
      if (!next || next.isWrapped !== true) {
        break;
      }
      rows.push(next);
    }
    const text = rows.map((line, index) => {
      const last = index === rows.length - 1;
      // A row that wraps on is full width: keep its trailing blanks (they are cells).
      const raw = String(line.translateToString(last) || '');
      return last || !cols ? raw : raw.padEnd(cols, ' ').slice(0, cols);
    }).join('');
    return { startRow, text, cols };
  }

  function toRange(logical, start, end) {
    const { startRow, cols } = logical;
    const last = end - 1;
    if (!cols) {
      return { start: { x: start + 1, y: startRow }, end: { x: last + 1, y: startRow } };
    }
    return {
      start: { x: (start % cols) + 1, y: startRow + Math.floor(start / cols) },
      end: { x: (last % cols) + 1, y: startRow + Math.floor(last / cols) },
    };
  }

  function openFileAtLine(windowRef, detail, appendClientLog) {
    const detect = resolveDetect();
    const claimed = typeof detect?.dispatchOpenFileAtLine === 'function' && detect.dispatchOpenFileAtLine(windowRef, detail);
    if (!claimed) {
      appendClientLog('DEBUG', 'ide.terminal_link_unclaimed', {});
    }
    return claimed;
  }

  // ILinkProvider for file:line output. ctx: { term, getRootPath, windowRef,
  // appendClientLog, getHostEl?, detect? }
  function createTerminalLinkProvider(ctx) {
    const term = ctx.term;
    const windowRef = ctx.windowRef;
    const getRootPath = typeof ctx.getRootPath === 'function' ? ctx.getRootPath : () => '';
    const getCwdPath = typeof ctx.getCwdPath === 'function' ? ctx.getCwdPath : () => '';
    const appendClientLog = typeof ctx.appendClientLog === 'function' ? ctx.appendClientLog : noop;
    const getHostEl = typeof ctx.getHostEl === 'function' ? ctx.getHostEl : () => null;
    const detect = ctx.detect || resolveDetect();
    const hint = jt('ide.terminal.followLinkHint', 'Follow link (Ctrl+click)');

    function setHint(on) {
      const host = getHostEl();
      if (!host) {
        return;
      }
      if (on) {
        host.title = hint;
      } else if (host.title === hint) {
        host.removeAttribute?.('title');
      }
    }

    function provideLinks(y, callback) {
      let links;
      try {
        const logical = detect && typeof detect.findLinks === 'function' ? readLogicalLine(term, y) : null;
        if (logical && logical.text) {
          const found = detect.findLinks(logical.text, { rootPath: getRootPath(), cwdPath: getCwdPath() });
          links = [];
          for (const hit of found) {
            const range = toRange(logical, hit.start, hit.end);
            // The logical line is asked for once per row; each row answers only its own links.
            if (y < range.start.y || y > range.end.y) {
              continue;
            }
            const detail = { path: hit.path, line: hit.line, preferIde: true };
            if (hit.col) {
              detail.column = hit.col;
            }
            links.push({
              range,
              text: logical.text.slice(hit.start, hit.end),
              activate(event) {
                if (isModifierHeld(event)) {
                  openFileAtLine(windowRef, detail, appendClientLog);
                }
              },
              hover() { setHint(true); },
              leave() { setHint(false); },
            });
          }
        }
      } catch (_error) {
        links = undefined; // a malformed buffer row must never break terminal rendering
      }
      callback(links && links.length ? links : undefined);
    }

    return { provideLinks };
  }

  // WebLinksAddon activation handler: Ctrl/Cmd + http(s) only, opened via window.open.
  function createUrlLinkHandler(ctx) {
    const windowRef = ctx.windowRef;
    return function handleUrlLink(event, uri) {
      const target = String(uri || '');
      if (!isModifierHeld(event) || !HTTP_URL_RE.test(target)) {
        return;
      }
      if (typeof windowRef?.open === 'function') {
        windowRef.open(target, '_blank', 'noopener,noreferrer');
      }
    };
  }

  return {
    MAX_WRAPPED_ROWS,
    createTerminalLinkProvider,
    createUrlLinkHandler,
    isModifierHeld,
  };
});
