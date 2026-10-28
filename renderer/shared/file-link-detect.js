/* renderer/shared/file-link-detect.js - file:line link detection shared by the Workspace
 * terminal, the run and test output views and the task problem matchers (row 82, plan
 * docs/plans/IDE_VSCODE_PARITY_2026-10-26.md section 5.7).
 *
 * findLinks(text, { rootPath, cwdPath? }) -> [{ start, end, path, line, col? }]
 * - shapes: `path:line`, `path:line:col`, `path(line)`, `path(line,col)`,
 *   `File "path", line N` (Python tracebacks) and `at fn (path:line:col)` (node stacks,
 *   also behind a `file:///` prefix);
 * - Windows (`C:\x\y.js`, `C:/x/y.js`) and POSIX (`/x/y.js`) absolute paths link only when
 *   they sit under rootPath; relative paths link when they stay inside the root after
 *   `.`/`..` folding;
 * - `path` is root-relative with '/' separators, ready for the `ide:open-file-at-line` seam;
 * - a relative candidate needs a separator or a file extension, so `localhost:8080`,
 *   `12:30` and version strings never link; matches inside an http(s) URL are skipped;
 * - `start`/`end` index the link text in the input (end exclusive); input and result
 *   counts are capped and findLinks never throws. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.jennyFileLinkDetect = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TEXT_MAX = 64 * 1024;
  const LINKS_MAX = 200;
  const PATH_MAX = 1024;
  const LINE_MAX = 100000000;

  const PATH_CHAR = '[^\\s"\'<>|*?:;,()\\[\\]{}]';
  const WIN_ABS = '[A-Za-z]:[\\\\/]' + PATH_CHAR + '+';
  const OTHER = PATH_CHAR + '+';
  const LINE_SPEC = '(?::(\\d+)(?::(\\d+))?|\\((\\d+)(?:,\\s?(\\d+))?\\))';
  // The lookbehind pins each attempt to a token start (or the segment after a slash,
  // for `file:///G:/...` frames): without it a long run of path characters (a 4000-char
  // line, a base64 blob) is rescanned from every position.
  const TOKEN_START = '(?<![^\\s"\'<>|*?:;,()\\[\\]{}/])';
  const PATH_LINE_RE = new RegExp(TOKEN_START + '(' + WIN_ABS + '|' + OTHER + ')' + LINE_SPEC, 'g');
  const PYTHON_RE = /File "([^"\r\n]{1,1024})", line (\d+)/g;
  const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;
  const EXTENSION_RE = /\.[A-Za-z][A-Za-z0-9_+-]{0,15}$/;
  const DRIVE_RE = /^[A-Za-z]:\//;

  function toInt(value) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= LINE_MAX ? n : 0;
  }

  // Folds '.' and '..' segments; null when '..' climbs above the start.
  function foldSegments(rel) {
    const out = [];
    for (const segment of rel.split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') {
        if (out.length === 0) return null;
        out.pop();
        continue;
      }
      out.push(segment);
    }
    return out.length ? out.join('/') : null;
  }

  function normalizeRoot(rootPath) {
    const root = String(rootPath || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
    return root;
  }

  // A detected path -> its root-relative form, or null when it is outside the root.
  // cwdRel: the root-relative folder a relative path is printed from ('' = the root).
  function resolveInRoot(rawPath, root, cwdRel) {
    let p = String(rawPath || '').replace(/\\/g, '/');
    if (!p || p.length > PATH_MAX) return null;
    const absolute = DRIVE_RE.test(p) || p.startsWith('/');
    if (!absolute) {
      return foldSegments(cwdRel ? cwdRel + '/' + p : p);
    }
    if (!root) return null;
    const winRoot = DRIVE_RE.test(root + '/');
    const prefix = root + '/';
    const head = p.slice(0, prefix.length);
    const inside = winRoot ? head.toLowerCase() === prefix.toLowerCase() : head === prefix;
    if (!inside) return null;
    p = p.slice(prefix.length);
    return foldSegments(p);
  }

  function looksLikeFile(rawPath) {
    const p = String(rawPath || '');
    if (/^[\d.]+$/.test(p)) return false;
    return /[\\/]/.test(p) || EXTENSION_RE.test(p);
  }

  function urlSpans(text) {
    const spans = [];
    URL_RE.lastIndex = 0;
    let m;
    while ((m = URL_RE.exec(text)) && spans.length < LINKS_MAX) {
      spans.push([m.index, m.index + m[0].length]);
    }
    return spans;
  }

  function overlaps(spans, start, end) {
    return spans.some(([s, e]) => start < e && end > s);
  }

  function findLinks(text, options) {
    try {
      const input = String(text == null ? '' : text).slice(0, TEXT_MAX);
      if (!input) return [];
      const root = normalizeRoot(options && options.rootPath);
      const cwd = normalizeRoot(options && options.cwdPath);
      // A terminal started in a sub-folder prints paths relative to it.
      const cwdRel = cwd && root && cwd !== root ? (resolveInRoot(cwd, root, '') || '') : '';
      const taken = urlSpans(input);
      const links = [];
      const push = (start, end, rawPath, line, col) => {
        if (links.length >= LINKS_MAX || overlaps(taken, start, end)) return;
        const lineNo = toInt(line);
        const path = lineNo ? resolveInRoot(rawPath, root, cwdRel) : null;
        if (!path) return;
        const link = { start, end, path, line: lineNo };
        const colNo = toInt(col);
        if (colNo) link.col = colNo;
        links.push(link);
        taken.push([start, end]);
      };
      PYTHON_RE.lastIndex = 0;
      let m;
      while ((m = PYTHON_RE.exec(input)) && links.length < LINKS_MAX) {
        const start = m.index + 'File "'.length;
        push(start, m.index + m[0].length, m[1], m[2]);
      }
      PATH_LINE_RE.lastIndex = 0;
      while ((m = PATH_LINE_RE.exec(input)) && links.length < LINKS_MAX) {
        const rawPath = m[1];
        if (!DRIVE_RE.test(rawPath.replace(/\\/g, '/')) && !looksLikeFile(rawPath)) continue;
        push(m.index, m.index + m[0].length, rawPath, m[2] || m[4], m[3] || m[5]);
      }
      return links.sort((a, b) => a.start - b.start);
    } catch (_error) {
      return [];
    }
  }

  // The containment rule findLinks applies, for a caller that already isolated a path (the
  // task matchers' eslint file header): root-relative with '/' separators, or null.
  function resolvePathInRoot(rawPath, options) {
    try {
      return resolveInRoot(rawPath, normalizeRoot(options && options.rootPath), '');
    } catch (_error) {
      return null;
    }
  }

  // The event every renderer file link raises; the shell's listener opens the editor
  // at detail.path / detail.line (optional detail.column) and claims it with
  // preventDefault. Returns true when a listener claimed it.
  const OPEN_FILE_EVENT = 'ide:open-file-at-line';
  function dispatchOpenFileAtLine(windowRef, detail) {
    try {
      const Ctor = (windowRef && windowRef.CustomEvent) || (typeof CustomEvent === 'function' ? CustomEvent : null);
      if (typeof Ctor !== 'function' || !windowRef || typeof windowRef.dispatchEvent !== 'function') return false;
      return windowRef.dispatchEvent(new Ctor(OPEN_FILE_EVENT, { detail, bubbles: true, cancelable: true })) === false;
    } catch (_error) {
      return false;
    }
  }

  return Object.freeze({ findLinks, resolvePathInRoot, dispatchOpenFileAtLine, OPEN_FILE_EVENT, LINKS_MAX, TEXT_MAX });
});
