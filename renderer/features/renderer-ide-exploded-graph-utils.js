/* renderer/features/renderer-ide-exploded-graph-utils.js - pure helpers for the
 * Workspace IDE "Exploded View" (one source file's functions + data + wiring as
 * a node-graph). No DOM, no Monaco, no I/O - everything here is a deterministic
 * function of a TypeScript/JavaScript NavigationTree + the file's source text.
 *
 * Companion to renderer-ide-exploded-graph.js, which owns the async
 * orchestration (worker resolution, reference-query fan-out) and calls into
 * these pure functions for every non-async step of the pipeline:
 *
 *   1. buildSymbolNodes(tree, text)   - walk the nav tree, classify each
 *      symbol (function/method/data/import), scan imports + exports, merge
 *      overload/accessor duplicates, and emit full Node-shaped objects (minus
 *      the wiring-dependent fields, which start at their zero value).
 *   2. applySymbolCap(nodes, cap)     - exported-first/loc-desc/line-asc
 *      truncation so a huge file doesn't fan out thousands of reference
 *      queries.
 *   3. createContainerResolver(nodes) - offset -> innermost enclosing
 *      function/method, used by the caller to turn a reference site into a
 *      "who calls/reads this" edge endpoint.
 *   4. finalizeGraph(nodes, edges)    - prune leaf data/import nodes with no
 *      inbound edge and no export, then compute degrees/callDepth/importance/
 *      zone/rank and return both arrays in a deterministic sort order. Pixel
 *      layout (x/y) is the caller's concern - see renderer-ide-explode-layout.js.
 *
 * classifyInitializer, scanImports, scanExports and charAfterIsOpenParen are
 * exported individually too - they are the heuristic core of this module and
 * are covered by their own direct unit tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeExplodedGraphUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Left-to-right reading order: what a file imports, what data it holds,
  // its internal helpers, then the exported surface that ties it together.
  const ZONE_ORDER = ['imports', 'data', 'functions', 'entry'];

  const IMPORTANCE_PRECISION = 4;

  const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
  const PRIMITIVE_KEYWORDS = new Set(['true', 'false', 'null', 'undefined']);

  // ---------------------------------------------------------------------------
  // Language / URI helpers
  // ---------------------------------------------------------------------------

  function isSupportedLanguage(language) {
    return language === 'typescript' || language === 'javascript';
  }

  const EXT_LANGUAGE = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  };

  function inferLanguageFromUri(uri) {
    const match = /\.([A-Za-z0-9]+)(?:\?.*)?$/.exec(String(uri == null ? '' : uri));
    const ext = match ? match[1].toLowerCase() : '';
    return EXT_LANGUAGE[ext] || null;
  }

  // ---------------------------------------------------------------------------
  // Line index (offset -> 1-based line number)
  // ---------------------------------------------------------------------------

  function createLineIndex(text) {
    const src = String(text == null ? '' : text);
    const starts = [0];
    for (let i = 0; i < src.length; i += 1) {
      if (src[i] === '\n') starts.push(i + 1);
    }
    return {
      lineAt(offset) {
        const target = Math.max(0, Math.min(Number(offset) || 0, src.length));
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (starts[mid] <= target) lo = mid; else hi = mid - 1;
        }
        return lo + 1;
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Trivia (whitespace / comments) skipping
  // ---------------------------------------------------------------------------

  function skipTriviaForward(text, from) {
    let i = from;
    let changed = true;
    while (changed) {
      changed = false;
      while (i < text.length && /\s/.test(text[i])) { i += 1; changed = true; }
      if (text[i] === '/' && text[i + 1] === '/') {
        const nl = text.indexOf('\n', i);
        i = nl === -1 ? text.length : nl + 1;
        changed = true;
        continue;
      }
      if (text[i] === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        i = end === -1 ? text.length : end + 2;
        changed = true;
      }
    }
    return i;
  }

  // Backward trivia skip used only for the inline-export check. Whitespace and
  // block comments are handled; a `//` line comment directly between `export`
  // and the declaration is a rare-enough shape that it is a documented gap.
  function skipTriviaBackward(text, from) {
    let i = from;
    let changed = true;
    while (changed) {
      changed = false;
      while (i >= 0 && /\s/.test(text[i])) { i -= 1; changed = true; }
      if (i >= 1 && text[i - 1] === '*' && text[i] === '/') {
        const start = text.lastIndexOf('/*', i - 2);
        if (start !== -1) { i = start - 1; changed = true; }
      }
    }
    return i;
  }

  function wordEndingAt(text, end) {
    let start = end + 1;
    while (start > 0 && /[\w$]/.test(text[start - 1])) start -= 1;
    return { word: text.slice(start, end + 1), start };
  }

  function startsWithWord(text, idx, word) {
    if (text.slice(idx, idx + word.length) !== word) return false;
    const after = text[idx + word.length];
    return after === undefined || !/[\w$]/.test(after);
  }

  function charAfterIsOpenParen(text, offset) {
    const idx = skipTriviaForward(text, offset);
    return text[idx] === '(';
  }

  // ---------------------------------------------------------------------------
  // Step 3 - initializer classification heuristic
  // ---------------------------------------------------------------------------

  function findAssignmentEq(text, from, to) {
    for (let i = from; i < to; i += 1) {
      if (text[i] !== '=') continue;
      const prev = text[i - 1];
      const next = text[i + 1];
      if (next === '=' || next === '>') continue;
      if (prev === '=' || prev === '!' || prev === '<' || prev === '>') continue;
      return i;
    }
    return -1;
  }

  function captureCallStringArg(text, idx) {
    const window = text.slice(idx, idx + 300);
    const match = /^(?:require|import)\s*\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/.exec(window);
    return match ? match[2] : undefined;
  }

  // From an open '(' at openIdx, find the index of its balanced matching
  // ')' (nested parens included). No string/comment-aware handling - a
  // lightweight paren-depth count is enough for the arrow-param-list check
  // below. Returns -1 if the parens never balance within the text.
  function findMatchingParenEnd(text, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  // true when the '(' at openIdx is an arrow function's parameter list, i.e.
  // its balanced matching ')' is followed (over trivia) by '=>'. Used to
  // distinguish `(a, b) => ...` from a parenthesized expression like
  // `(a + b) / 2` or `(obj as Foo).bar`.
  function isArrowParamList(text, openIdx) {
    const closeIdx = findMatchingParenEnd(text, openIdx);
    if (closeIdx === -1) return false;
    const after = skipTriviaForward(text, closeIdx + 1);
    return text.slice(after, after + 2) === '=>';
  }

  /**
   * classifyInitializer(text, searchStart, rangeEnd) - from a decl, find the
   * first bare '=' at/after searchStart (typically the name span's end) within
   * [searchStart, rangeEnd), then classify what follows it. No '=' found means
   * an ambient/declare-only binding -> data/unknown.
   * @returns {{kind:'function'|'data'|'import', isAsync?:boolean, dataShape?:string, source?:string}}
   */
  function classifyInitializer(text, searchStart, rangeEnd) {
    const src = String(text == null ? '' : text);
    const bound = Math.max(searchStart, Math.min(rangeEnd, src.length));
    const eqIdx = findAssignmentEq(src, searchStart, bound);
    if (eqIdx === -1) {
      return { kind: 'data', dataShape: 'unknown', isAsync: false };
    }
    const idx = skipTriviaForward(src, eqIdx + 1);
    const ch = src[idx];

    if (startsWithWord(src, idx, 'async')) {
      return { kind: 'function', isAsync: true };
    }
    if (ch === '(') {
      if (isArrowParamList(src, idx)) {
        return { kind: 'function', isAsync: false };
      }
      return { kind: 'data', dataShape: 'expr', isAsync: false };
    }
    if (startsWithWord(src, idx, 'function')) {
      return { kind: 'function', isAsync: false };
    }
    if (/^(require|import)\s*\(/.test(src.slice(idx, idx + 40))) {
      return { kind: 'import', isAsync: false, source: captureCallStringArg(src, idx) };
    }
    if (startsWithWord(src, idx, 'new')) return { kind: 'data', dataShape: 'object', isAsync: false };
    const identMatch = /^[A-Za-z_$][\w$]*/.exec(src.slice(idx, idx + 100));
    if (identMatch) {
      const after = skipTriviaForward(src, idx + identMatch[0].length);
      if (src.slice(after, after + 2) === '=>') {
        return { kind: 'function', isAsync: false };
      }
      if (PRIMITIVE_KEYWORDS.has(identMatch[0])) {
        return { kind: 'data', dataShape: 'primitive', isAsync: false };
      }
      return { kind: 'data', dataShape: 'expr', isAsync: false };
    }
    if (ch === '[') return { kind: 'data', dataShape: 'array', isAsync: false };
    if (ch === '{') return { kind: 'data', dataShape: 'object', isAsync: false };
    if (ch === '"' || ch === '\'' || ch === '`') return { kind: 'data', dataShape: 'primitive', isAsync: false };
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(src[idx + 1]))) {
      return { kind: 'data', dataShape: 'primitive', isAsync: false };
    }
    return { kind: 'data', dataShape: 'expr', isAsync: false };
  }

  // ---------------------------------------------------------------------------
  // Step 4 - head-of-file import scan
  // ---------------------------------------------------------------------------

  const HEAD_MAX_LINES = 120;
  const IMPORT_LINE_RE = /^import\b/;
  const REQUIRE_LINE_RE = /^(?:export\s+)?(?:const|let|var)\s+.*=\s*require\(/;
  const CONST_OPEN_RE = /^(?:export\s+)?(?:const|let|var)\b/;

  function countChar(str, ch) {
    let n = 0;
    for (let i = 0; i < str.length; i += 1) if (str[i] === ch) n += 1;
    return n;
  }

  // Bounds the import scan to the head-of-file region: consecutive
  // import/require-const lines (and blank/`//`/`/* */` lines and their
  // continuations - including a multi-line block-comment banner, which
  // every module in this repo opens with), stopping at the first top-level
  // statement that is none of those, or after HEAD_MAX_LINES lines -
  // whichever comes first.
  function computeHeadEnd(text) {
    const lines = text.split('\n');
    const max = Math.min(lines.length, HEAD_MAX_LINES);
    let offset = 0;
    let depth = 0;
    let headEnd = 0;
    let inComment = false;
    for (let i = 0; i < max; i += 1) {
      let line = lines[i];
      const lineEnd = offset + line.length;

      // Carried over from a block comment left open by a previous line -
      // keep skipping whole lines until the one that closes it, then resume
      // evaluating whatever follows the `*/` on that same line.
      if (inComment) {
        const closeIdx = line.indexOf('*/');
        if (closeIdx === -1) {
          headEnd = lineEnd;
          offset = lineEnd + 1;
          continue;
        }
        inComment = false;
        line = line.slice(closeIdx + 2);
      }

      if (depth > 0) {
        depth += countChar(line, '{') - countChar(line, '}');
        headEnd = lineEnd;
        offset = lineEnd + 1;
        continue;
      }

      let trimmed = line.trim();
      // Strip any block comment span(s) that start (and possibly end) on
      // this line, e.g. a `/* banner */` line or `/* note */ import ...`.
      while (trimmed.startsWith('/*')) {
        const closeIdx = trimmed.indexOf('*/');
        if (closeIdx === -1) {
          inComment = true;
          trimmed = '';
          break;
        }
        trimmed = trimmed.slice(closeIdx + 2).trim();
      }
      if (inComment) {
        headEnd = lineEnd;
        offset = lineEnd + 1;
        continue;
      }

      if (trimmed === '' || trimmed.startsWith('//')) {
        headEnd = lineEnd;
        offset = lineEnd + 1;
        continue;
      }

      if (IMPORT_LINE_RE.test(trimmed) || REQUIRE_LINE_RE.test(trimmed)) {
        depth += countChar(trimmed, '{') - countChar(trimmed, '}');
        headEnd = lineEnd;
        offset = lineEnd + 1;
        continue;
      }

      // A top-level const/let/var whose brace count is unbalanced on this
      // line (e.g. `const {` opening a multi-line destructure) can't yet be
      // classified as import-or-not - keep scanning like the import
      // continuation above so REQUIRE_CONST_RE can later span the newline.
      if (CONST_OPEN_RE.test(trimmed)) {
        const braceDelta = countChar(trimmed, '{') - countChar(trimmed, '}');
        if (braceDelta > 0) {
          depth += braceDelta;
          headEnd = lineEnd;
          offset = lineEnd + 1;
          continue;
        }
      }

      break;
    }
    return headEnd;
  }

  // `a, b as c` (import) -> local binding names are a, c. Used for both the
  // named-import list and (indirectly) for export lists elsewhere.
  function parseAsBindings(body, bodyStart, source, out) {
    let cursor = 0;
    body.split(',').forEach((part) => {
      const partStart = bodyStart + cursor;
      cursor += part.length + 1;
      const trimmed = part.trim();
      if (!trimmed) return;
      const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(trimmed);
      const localName = asMatch ? asMatch[2] : trimmed;
      if (!IDENTIFIER_RE.test(localName)) return;
      const localOffset = part.lastIndexOf(localName);
      out.push({ name: localName, nameOffset: partStart + localOffset, source });
    });
  }

  // `a, b: c` (object destructure) -> local binding names are a, c.
  function parseColonBindings(body, bodyStart, source, out) {
    let cursor = 0;
    body.split(',').forEach((part) => {
      const partStart = bodyStart + cursor;
      cursor += part.length + 1;
      const trimmed = part.trim();
      if (!trimmed) return;
      const colonMatch = /^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/.exec(trimmed);
      const localName = colonMatch ? colonMatch[2] : trimmed;
      if (!IDENTIFIER_RE.test(localName)) return;
      const localOffset = part.lastIndexOf(localName);
      out.push({ name: localName, nameOffset: partStart + localOffset, source });
    });
  }

  function parseImportClause(clause, clauseStart, source, out) {
    const nsMatch = /(?:^|,\s*)\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    const braceIdx = clause.indexOf('{');
    const bindingIdx = nsMatch ? nsMatch.index : braceIdx;
    const defaultPart = (bindingIdx === -1 ? clause : clause.slice(0, bindingIdx)).replace(/,\s*$/, '').trim();
    if (defaultPart && IDENTIFIER_RE.test(defaultPart)) {
      const nameOffset = clauseStart + clause.indexOf(defaultPart);
      out.push({ name: defaultPart, nameOffset, source });
    }
    if (nsMatch) {
      const nameOffset = clauseStart + clause.indexOf(nsMatch[1], nsMatch.index);
      out.push({ name: nsMatch[1], nameOffset, source });
      return;
    }
    if (braceIdx !== -1) {
      const closeIdx = clause.indexOf('}', braceIdx);
      const body = clause.slice(braceIdx + 1, closeIdx === -1 ? undefined : closeIdx);
      parseAsBindings(body, clauseStart + braceIdx + 1, source, out);
    }
  }

  const IMPORT_FROM_RE = /import\s+([\s\S]*?)\s+from\s+(['"])((?:(?!\2)[^\\\n]|\\.)*)\2/g;
  const REQUIRE_CONST_RE = /(?:export\s+)?(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*(['"])((?:(?!\2)[^\\\n]|\\.)*)\2\s*\)/g;

  function maskComments(text) {
    const chars = String(text).split('');
    let quote = '';
    let escaped = false;
    for (let i = 0; i < chars.length; i += 1) {
      const char = chars[i];
      const next = chars[i + 1];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '\'' || char === '"' || char === '`') {
        quote = char;
        continue;
      }
      if (char === '/' && next === '/') {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 2;
        while (i < chars.length && chars[i] !== '\n' && chars[i] !== '\r') {
          chars[i] = ' ';
          i += 1;
        }
        i -= 1;
      } else if (char === '/' && next === '*') {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 2;
        while (i < chars.length && !(chars[i] === '*' && chars[i + 1] === '/')) {
          if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
          i += 1;
        }
        if (i < chars.length) {
          chars[i] = ' ';
          chars[i + 1] = ' ';
          i += 1;
        }
      }
    }
    return chars.join('');
  }

  /**
   * scanImports(text) - head-of-file scan for `import ... from`, `import * as
   * ns from`, `const x = require(...)`, and `const { a, b: c } = require(...)`.
   * Side-effect `import 'mod'` (no `from`) and dynamic `import(...)` are never
   * matched by IMPORT_FROM_RE; `export { a } from 'mod'` re-exports are a
   * scanExports concern, not this one.
   * @returns {Array<{name:string, nameOffset:number, source:string}>}
   */
  function scanImports(text) {
    const src = String(text == null ? '' : text);
    const headEnd = computeHeadEnd(src);
    const head = maskComments(src.slice(0, headEnd));
    const out = [];

    IMPORT_FROM_RE.lastIndex = 0;
    let m = IMPORT_FROM_RE.exec(head);
    while (m) {
      const clause = m[1];
      const source = m[3];
      const clauseStart = m.index + m[0].indexOf(clause);
      parseImportClause(clause, clauseStart, source, out);
      m = IMPORT_FROM_RE.exec(head);
    }

    REQUIRE_CONST_RE.lastIndex = 0;
    m = REQUIRE_CONST_RE.exec(head);
    while (m) {
      const pattern = m[1];
      const source = m[3];
      const patternStart = m.index + m[0].indexOf(pattern);
      if (pattern[0] === '{') {
        parseColonBindings(pattern.slice(1, -1), patternStart + 1, source, out);
      } else {
        out.push({ name: pattern, nameOffset: patternStart, source });
      }
      m = REQUIRE_CONST_RE.exec(head);
    }

    return out;
  }

  // ---------------------------------------------------------------------------
  // Step 5 - export scan
  // ---------------------------------------------------------------------------

  const EXPORT_LIST_RE = /^[ \t]*export\s*\{([^}]*)\}\s*(from\s+['"][^'"]*['"])?\s*;?[ \t]*$/gm;
  const EXPORT_DEFAULT_IDENT_RE = /^[ \t]*export\s+default\s+([A-Za-z_$][\w$]*)[ \t]*;?[ \t]*$/gm;

  /**
   * scanExports(text) - `export { a, b as c }` (local bindings a, c; skipped
   * entirely when it is a `from '...'` re-export) and bare `export default
   * identifier;`. Inline `export`/`export default` immediately before a
   * declaration is a separate check (isInlineExported) since it needs each
   * node's own range start.
   * @returns {{deferredNames:Set<string>, defaultName:?string}}
   */
  function scanExports(text) {
    const src = String(text == null ? '' : text);
    const deferredNames = new Set();
    EXPORT_LIST_RE.lastIndex = 0;
    let m = EXPORT_LIST_RE.exec(src);
    while (m) {
      if (!m[2]) {
        m[1].split(',').forEach((part) => {
          const trimmed = part.trim();
          if (!trimmed) return;
          const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+[A-Za-z_$][\w$]*$/.exec(trimmed);
          const local = asMatch ? asMatch[1] : trimmed;
          if (IDENTIFIER_RE.test(local)) deferredNames.add(local);
        });
      }
      m = EXPORT_LIST_RE.exec(src);
    }
    EXPORT_DEFAULT_IDENT_RE.lastIndex = 0;
    const dm = EXPORT_DEFAULT_IDENT_RE.exec(src);
    return { deferredNames, defaultName: dm ? dm[1] : null };
  }

  // export/export default keyword immediately preceding `start` (only
  // whitespace/block-comment trivia between).
  function isInlineExported(text, start) {
    let i = skipTriviaBackward(text, start - 1);
    let { word, start: wordStart } = wordEndingAt(text, i);
    if (word === 'default') {
      i = skipTriviaBackward(text, wordStart - 1);
      ({ word } = wordEndingAt(text, i));
    }
    return word === 'export';
  }

  // ---------------------------------------------------------------------------
  // Step 2 - nav tree walk + classification
  // ---------------------------------------------------------------------------

  function widestSpan(node) {
    const spans = Array.isArray(node.spans) ? node.spans : [];
    if (!spans.length) return null;
    let best = spans[0];
    for (const span of spans) {
      if (span && Number.isFinite(span.length) && span.length > (best.length || 0)) best = span;
    }
    return best;
  }

  // Raw TS ScriptElementKind -> how this walker treats the node.
  //  'function'   - emit a function node, recurse (nested local functions)
  //  'method'     - emit a method node, recurse
  //  'enum'       - emit a data node (dataShape 'enum'), do not recurse
  //  'initializer'- run classifyInitializer to decide function/data/import
  //  'container'  - no node of its own, but its name becomes the container
  //                 for its children (class, namespace/module)
  //  'drop'       - no node, no recursion (interface/type/type parameter and
  //                 anything unhandled, e.g. enum members)
  function classifyRawKind(rawKind) {
    switch (rawKind) {
      case 'function':
      case 'local function':
        return 'function';
      case 'method':
      case 'constructor':
      case 'getter':
      case 'setter':
        return 'method';
      case 'class':
      case 'module':
        return 'container';
      case 'interface':
      case 'type':
      case 'type parameter':
        return 'drop';
      case 'enum':
        return 'enum';
      case 'const':
      case 'let':
      case 'var':
      case 'property':
        return 'initializer';
      default:
        return 'drop';
    }
  }

  function walkNavTree(node, ctx, container, isRoot, out) {
    if (!node || typeof node !== 'object') return out;
    const children = Array.isArray(node.childItems) ? node.childItems : [];
    if (isRoot) {
      children.forEach((child) => walkNavTree(child, ctx, container, false, out));
      return out;
    }

    const category = classifyRawKind(String(node.kind || ''));
    if (category === 'drop') return out;

    const name = String(node.text || '');
    if (category === 'container') {
      const nextContainer = name || container;
      children.forEach((child) => walkNavTree(child, ctx, nextContainer, false, out));
      return out;
    }

    const nameSpan = node.nameSpan && Number.isFinite(node.nameSpan.start) ? node.nameSpan : null;
    const full = widestSpan(node);
    const rangeStart = full ? full.start : (nameSpan ? nameSpan.start : 0);
    const rangeLength = full ? full.length : (nameSpan ? nameSpan.length : 0);
    const rangeEnd = rangeStart + rangeLength;
    const nameOffset = nameSpan ? nameSpan.start : rangeStart;
    const nameEnd = nameSpan ? nameSpan.start + nameSpan.length : nameOffset;

    if (category === 'function' || category === 'method') {
      const isAsync = /\basync\b/.test(ctx.text.slice(rangeStart, nameOffset));
      out.push({ kind: category, name, container, nameOffset, rangeStart, rangeEnd, isAsync });
      children.forEach((child) => walkNavTree(child, ctx, name || container, false, out));
      return out;
    }

    if (category === 'enum') {
      out.push({
        kind: 'data', name, container, nameOffset, rangeStart, rangeEnd, isAsync: false, dataShape: 'enum',
      });
      return out;
    }

    // 'initializer': const/let/var/property. Destructuring-pattern names (e.g.
    // the nav node's text is "{ a, b }") are dropped from THIS path - scanImports
    // separately produces per-binding import nodes for `const {a} = require(...)`,
    // and non-require destructuring data is a documented v1 gap.
    if (!IDENTIFIER_RE.test(name)) return out;
    const info = classifyInitializer(ctx.text, nameEnd, rangeEnd);
    out.push({
      kind: info.kind,
      name,
      container,
      nameOffset,
      rangeStart,
      rangeEnd,
      isAsync: Boolean(info.isAsync),
      dataShape: info.kind === 'data' ? info.dataShape : undefined,
      source: info.kind === 'import' ? info.source : undefined,
    });
    return out;
  }

  // Merge overload/accessor-pair duplicates: same (kind, name, container) ->
  // one node with a unioned range and the first-encountered nameOffset.
  function mergeSymbolEntries(entries) {
    const order = [];
    const byKey = new Map();
    entries.forEach((entry) => {
      const key = `${entry.kind}|${entry.name}|${entry.container}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.rangeStart = Math.min(existing.rangeStart, entry.rangeStart);
        existing.rangeEnd = Math.max(existing.rangeEnd, entry.rangeEnd);
        return;
      }
      byKey.set(key, Object.assign({}, entry));
      order.push(key);
    });
    return order.map((key) => byKey.get(key));
  }

  /**
   * buildSymbolNodes(tree, text) - steps 2-6: walk + classify the nav tree,
   * merge overload duplicates, scan + dedupe imports, resolve exported flags,
   * and emit full Node-shaped objects. Wiring fields (degreeIn/degreeOut/
   * callDepth/importance/zone/rank) start at their zero value; the caller
   * fills them in via finalizeGraph() once edges exist.
   * @returns {Array<Object>} nodes sorted by nameOffset (document order)
   */
  function buildSymbolNodes(tree, text) {
    const src = String(text == null ? '' : text);
    const lineIndex = createLineIndex(src);

    const rawEntries = [];
    walkNavTree(tree, { text: src }, '', true, rawEntries);
    const merged = mergeSymbolEntries(rawEntries);

    const seenOffsets = new Set(merged.map((entry) => entry.nameOffset));
    scanImports(src).forEach((imp) => {
      if (seenOffsets.has(imp.nameOffset)) {
        const existing = merged.find((entry) => entry.nameOffset === imp.nameOffset);
        if (existing && existing.kind === 'import' && !existing.source) existing.source = imp.source;
        return;
      }
      seenOffsets.add(imp.nameOffset);
      merged.push({
        kind: 'import',
        name: imp.name,
        container: '',
        nameOffset: imp.nameOffset,
        rangeStart: imp.nameOffset,
        rangeEnd: imp.nameOffset + imp.name.length,
        isAsync: false,
        source: imp.source,
      });
    });

    const exportInfo = scanExports(src);
    merged.forEach((entry) => {
      const topLevel = entry.container === '';
      entry.isExported = (topLevel && exportInfo.deferredNames.has(entry.name))
        || (topLevel && exportInfo.defaultName === entry.name)
        || isInlineExported(src, entry.rangeStart);
    });

    merged.sort((a, b) => a.nameOffset - b.nameOffset);

    return merged.map((entry) => {
      const line = lineIndex.lineAt(entry.nameOffset);
      const startLine = lineIndex.lineAt(entry.rangeStart);
      const endLine = lineIndex.lineAt(Math.max(entry.rangeStart, entry.rangeEnd - 1));
      const node = {
        id: `${entry.kind}:${entry.name}@${entry.nameOffset}`,
        kind: entry.kind,
        name: entry.name,
        container: entry.container,
        nameOffset: entry.nameOffset,
        range: { start: entry.rangeStart, length: Math.max(0, entry.rangeEnd - entry.rangeStart) },
        line,
        isExported: Boolean(entry.isExported),
        isAsync: Boolean(entry.isAsync),
        loc: Math.max(1, endLine - startLine + 1),
        degreeIn: 0,
        degreeOut: 0,
        callDepth: null,
        importance: 0,
        zone: null,
        rank: 0,
      };
      if (entry.kind === 'data') node.dataShape = entry.dataShape || 'unknown';
      if (entry.kind === 'import') node.source = entry.source || '';
      return node;
    });
  }

  // ---------------------------------------------------------------------------
  // Step 6 - containment index
  // ---------------------------------------------------------------------------

  /**
   * createContainerResolver(nodes) -> resolveContainer(offset). Innermost
   * function/method whose range contains offset wins (smallest span length).
   * Data/import nodes are always leaves and never returned.
   */
  function createContainerResolver(nodes) {
    const containers = (Array.isArray(nodes) ? nodes : []).filter(
      (n) => n.kind === 'function' || n.kind === 'method'
    );
    return function resolveContainer(offset) {
      let best = null;
      for (const node of containers) {
        const start = node.range.start;
        const end = start + node.range.length;
        if (offset >= start && offset < end) {
          if (!best || node.range.length < best.range.length) best = node;
        }
      }
      return best;
    };
  }

  // ---------------------------------------------------------------------------
  // Step 7 - symbol cap
  // ---------------------------------------------------------------------------

  /**
   * applySymbolCap(nodes, cap) - keeps the first `cap` nodes ranked
   * exported-first, then loc desc, then line asc; returns survivors in their
   * original (nameOffset) order. truncated is false when nothing was dropped.
   */
  function applySymbolCap(nodes, cap) {
    const list = Array.isArray(nodes) ? nodes : [];
    const effectiveCap = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : list.length;
    if (list.length <= effectiveCap) {
      return { survivors: list.slice(), truncated: false };
    }
    const ranked = list.slice().sort((a, b) => {
      if (a.isExported !== b.isExported) return a.isExported ? -1 : 1;
      if (b.loc !== a.loc) return b.loc - a.loc;
      return a.line - b.line;
    });
    const keepIds = new Set(ranked.slice(0, effectiveCap).map((n) => n.id));
    return { survivors: list.filter((n) => keepIds.has(n.id)), truncated: true };
  }

  // ---------------------------------------------------------------------------
  // Step 9-10 - prune, degrees, callDepth, importance, zone/rank
  // ---------------------------------------------------------------------------

  function pruneGraph(nodes, edges) {
    const degreeInCount = new Map();
    edges.forEach((e) => degreeInCount.set(e.to, (degreeInCount.get(e.to) || 0) + 1));
    const kept = nodes.filter((n) => {
      if (n.kind === 'function' || n.kind === 'method') return true;
      const din = degreeInCount.get(n.id) || 0;
      return din >= 1 || n.isExported;
    });
    const keptIds = new Set(kept.map((n) => n.id));
    const keptEdges = edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to));
    return { nodes: kept, edges: keptEdges };
  }

  function computeDegrees(nodes, edges) {
    const inMap = new Map();
    const outMap = new Map();
    nodes.forEach((n) => { inMap.set(n.id, 0); outMap.set(n.id, 0); });
    edges.forEach((e) => {
      outMap.set(e.from, (outMap.get(e.from) || 0) + 1);
      inMap.set(e.to, (inMap.get(e.to) || 0) + 1);
    });
    nodes.forEach((n) => {
      n.degreeIn = inMap.get(n.id) || 0;
      n.degreeOut = outMap.get(n.id) || 0;
    });
  }

  // BFS over 'call' edges from exported function/method entries. First-writer-
  // wins depth (sorted-id root/neighbor iteration keeps it deterministic).
  // Unreachable nodes keep callDepth null.
  function computeCallDepth(nodes, edges) {
    const callForward = new Map();
    nodes.forEach((n) => callForward.set(n.id, []));
    edges.filter((e) => e.kind === 'call').forEach((e) => {
      if (callForward.has(e.from)) callForward.get(e.from).push(e.to);
    });
    const roots = nodes
      .filter((n) => (n.kind === 'function' || n.kind === 'method') && n.isExported)
      .map((n) => n.id)
      .sort();
    const depth = new Map();
    const queue = [];
    roots.forEach((id) => { if (!depth.has(id)) { depth.set(id, 0); queue.push(id); } });
    let head = 0;
    while (head < queue.length) {
      const id = queue[head];
      head += 1;
      const d = depth.get(id);
      const neighbors = (callForward.get(id) || []).slice().sort();
      neighbors.forEach((next) => {
        if (!depth.has(next)) { depth.set(next, d + 1); queue.push(next); }
      });
    }
    nodes.forEach((n) => { n.callDepth = depth.has(n.id) ? depth.get(n.id) : null; });
  }

  function computeImportanceScores(nodes) {
    if (nodes.length === 0) return;
    const values = nodes.map((n) => n.degreeIn);
    const max = Math.max(...values);
    const min = Math.min(...values);
    const span = max - min;
    const factor = 10 ** IMPORTANCE_PRECISION;
    nodes.forEach((n) => {
      const norm = span === 0 ? 0 : (n.degreeIn - min) / span;
      const rounded = Math.round(norm * factor) / factor;
      n.importance = rounded === 0 ? 0 : rounded;
    });
  }

  function assignZones(nodes) {
    nodes.forEach((n) => {
      if (n.kind === 'import') n.zone = 'imports';
      else if (n.kind === 'data') n.zone = 'data';
      else if (n.isExported) n.zone = 'entry';
      else n.zone = 'functions';
    });
  }

  // rank is zone-local (0-based index within its own zone's sort order).
  // Actual pixel layout is the caller's concern (renderer-ide-explode-layout.js
  // derives x/y from zone+rank) - this module only orders nodes within a zone.
  function assignRanks(nodes) {
    ZONE_ORDER.forEach((zone) => {
      const inZone = nodes.filter((n) => n.zone === zone);
      let sorted;
      if (zone === 'entry' || zone === 'functions') {
        sorted = inZone.slice().sort((a, b) => {
          const ad = a.callDepth === null ? Number.POSITIVE_INFINITY : a.callDepth;
          const bd = b.callDepth === null ? Number.POSITIVE_INFINITY : b.callDepth;
          if (ad !== bd) return ad - bd;
          if (b.loc !== a.loc) return b.loc - a.loc;
          return a.line - b.line;
        });
      } else if (zone === 'data') {
        sorted = inZone.slice().sort((a, b) => (b.degreeIn - a.degreeIn) || (a.line - b.line));
      } else {
        // imports: grouped by source, then by the import's own declaration
        // line (there is no per-edge line number to derive a true first-use
        // line from, so the declaration line - which always precedes any use
        // - stands in for it).
        sorted = inZone.slice().sort((a, b) => {
          const as = a.source || '';
          const bs = b.source || '';
          if (as !== bs) return as < bs ? -1 : 1;
          return a.line - b.line;
        });
      }
      sorted.forEach((n, idx) => { n.rank = idx; });
    });
  }

  function sortFinal(nodes, edges) {
    const zoneIndexOf = (z) => Math.max(0, ZONE_ORDER.indexOf(z));
    const sortedNodes = nodes.slice().sort((a, b) => {
      const za = zoneIndexOf(a.zone);
      const zb = zoneIndexOf(b.zone);
      if (za !== zb) return za - zb;
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const sortedEdges = edges.slice().sort((a, b) => {
      if (a.from !== b.from) return a.from < b.from ? -1 : 1;
      if (a.to !== b.to) return a.to < b.to ? -1 : 1;
      if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
      return 0;
    });
    return { nodes: sortedNodes, edges: sortedEdges };
  }

  /**
   * finalizeGraph(nodes, edges) - steps 9-10. Prunes leaf data/import nodes
   * with no inbound edge and no export, computes degreeIn/degreeOut/callDepth/
   * importance/zone/rank, and returns both arrays in the deterministic
   * (zone, rank, id) / (from, to, kind) sort order.
   */
  function finalizeGraph(nodes, edges) {
    const pruned = pruneGraph(Array.isArray(nodes) ? nodes : [], Array.isArray(edges) ? edges : []);
    computeDegrees(pruned.nodes, pruned.edges);
    computeCallDepth(pruned.nodes, pruned.edges);
    computeImportanceScores(pruned.nodes);
    assignZones(pruned.nodes);
    assignRanks(pruned.nodes);
    return sortFinal(pruned.nodes, pruned.edges);
  }

  return {
    ZONE_ORDER,
    isSupportedLanguage,
    inferLanguageFromUri,
    createLineIndex,
    charAfterIsOpenParen,
    classifyInitializer,
    scanImports,
    scanExports,
    isInlineExported,
    buildSymbolNodes,
    createContainerResolver,
    applySymbolCap,
    finalizeGraph,
  };
});
