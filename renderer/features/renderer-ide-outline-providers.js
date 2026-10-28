/* renderer/features/renderer-ide-outline-providers.js - symbol sources for the Workspace
 * Outline view (row 82 O1; docs/plans/IDE_VSCODE_PARITY_2026-10-26.md 7.6).
 *
 * Pure functions, no Monaco and no DOM. TS/JS symbols come from the TypeScript worker's
 * navigation tree that renderer-ide-symbol-nav.js already requests and caches (this module
 * only converts it, with VS Code's inclusion rule); every other language is a small
 * line or character scanner: Markdown headings (ATX and setext, fences and front matter
 * skipped), Python `def` / `class` nested by indentation (strings, brackets and line
 * continuations respected), JSON keys to depth 3 (comments and trailing commas
 * tolerated), CSS / SCSS / Less selectors and at-rules, and YAML top-level keys.
 *
 * Every provider is bounded: it stops after MAX_SYMBOLS symbols, and reads at most
 * MAX_TEXT_CHARS of text (cut at a line break). `truncated` says which bound was hit
 * ('symbols' or 'size'), so the view can say so.
 *
 *   Symbol = { key, name, kind, line, column, startLine, endLine, children: Symbol[] }
 *
 * `line`/`column` (1-based) is where a click lands (the name); `startLine..endLine` is the
 * range the cursor-follow test uses. `key` is stable across edits that keep the symbol's
 * kind, name and ancestry, so collapse state survives typing. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeOutlineProviders = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_SYMBOLS = 2000;
  const MAX_TEXT_CHARS = 1024 * 1024;
  const JSON_MAX_DEPTH = 3;
  const MAX_NAME_CHARS = 240;
  // Bounds past which input only costs time (names clip far below): a CSS prelude and one
  // line for the ATX / YAML-key regexes (all three went quadratic on long input).
  const PRELUDE_MAX_CHARS = 2048;
  const scanHead = (raw) => (raw.length > 4096 ? raw.slice(0, 4096) : raw);

  const LANGUAGE_PROVIDERS = Object.freeze({
    typescript: 'navtree', javascript: 'navtree',
    markdown: 'markdown', python: 'python', json: 'json', jsonc: 'json',
    css: 'css', scss: 'css', less: 'css', yaml: 'yaml',
  });
  const EXTENSION_PROVIDERS = Object.freeze({
    ts: 'navtree', tsx: 'navtree', mts: 'navtree', cts: 'navtree', js: 'navtree', jsx: 'navtree', mjs: 'navtree', cjs: 'navtree',
    md: 'markdown', markdown: 'markdown', mdx: 'markdown', py: 'python', pyi: 'python', pyw: 'python',
    json: 'json', jsonc: 'json', css: 'css', scss: 'css', less: 'css', yml: 'yaml', yaml: 'yaml',
  });

  // The provider id for a document: its Monaco language first, the extension when the
  // language is unknown or plain text. null = no outline for this file type.
  function providerFor(languageId, path) {
    const lang = String(languageId || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(LANGUAGE_PROVIDERS, lang)) return LANGUAGE_PROVIDERS[lang];
    if (lang && lang !== 'plaintext') return null;
    const name = String(path || '').split('/').pop() || '';
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    return Object.prototype.hasOwnProperty.call(EXTENSION_PROVIDERS, ext) ? EXTENSION_PROVIDERS[ext] : null;
  }

  function cleanName(value) {
    const name = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return name.length > MAX_NAME_CHARS ? `${name.slice(0, MAX_NAME_CHARS - 1)}…` : name;
  }

  function mkSymbol(name, kind, line, column) {
    return { key: '', name, kind, line, column: column || 1, startLine: line, endLine: line, children: [] };
  }

  function closeAt(symbol, endLine) {
    symbol.endLine = Math.max(endLine, symbol.line);
  }

  // Counts symbols against the cap; add() returns null (and latches `full`) past it.
  function createBuilder(maxSymbols) {
    const cap = Number.isFinite(maxSymbols) && maxSymbols > 0 ? Math.floor(maxSymbols) : MAX_SYMBOLS;
    const roots = [];
    let count = 0;
    let full = false;
    function add(siblings, symbol) {
      full = full || count >= cap;
      if (full) return null;
      count += 1;
      (siblings || roots).push(symbol);
      return symbol;
    }
    return { roots, add, isFull: () => full };
  }

  function clipText(text, maxChars) {
    const value = String(text == null ? '' : text);
    const cap = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : MAX_TEXT_CHARS;
    if (value.length <= cap) return { text: value, clipped: false };
    const cut = value.lastIndexOf('\n', cap);
    return { text: value.slice(0, cut > 0 ? cut : cap), clipped: true };
  }

  function splitLines(text) {
    return text.split(/\r\n|\r|\n/);
  }

  // Stable keys: ancestry + kind + name, with a #n suffix for same-named siblings.
  function assignKeys(symbols, parentKey) {
    const seen = new Map();
    for (const symbol of symbols) {
      const base = `${parentKey}>${symbol.kind}:${symbol.name}`;
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      symbol.key = n === 1 ? base : `${base}#${n}`;
      assignKeys(symbol.children, symbol.key);
    }
    return symbols;
  }

  function result(builder, clipped) {
    return { symbols: assignKeys(builder.roots, ''), truncated: builder.isFull() ? 'symbols' : clipped ? 'size' : '' };
  }

  /* ------------------------------------------------------------------ Markdown */

  const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
  const ATX_RE = /^ {0,3}(#{1,6})(?=[ \t]|$)(.*)$/;
  const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
  const NOT_PARAGRAPH_RE = /^(?: {4,}|\t| {0,3}(?:[-*+][ \t]|\d{1,9}[.)][ \t]|>|#|`{3,}|~{3,}|<))/;

  function markdownOutline(text, opts) {
    const { text: body, clipped } = clipText(text, opts?.maxTextChars);
    const lines = splitLines(body);
    const builder = createBuilder(opts?.maxSymbols);
    const open = []; // [{ symbol, level }]
    let fence = null;
    let lastLine = 0;
    let previousIsParagraph = false;

    function heading(level, name, line) {
      while (open.length && open[open.length - 1].level >= level) closeAt(open.pop().symbol, line - 1);
      const parent = open.length ? open[open.length - 1].symbol.children : null;
      const symbol = builder.add(parent, mkSymbol(name, 'heading', line, 1));
      if (symbol) open.push({ symbol, level });
    }

    let index = 0;
    if (lines[0] === '---') {
      for (index = 1; index < lines.length && lines[index] !== '---' && lines[index] !== '...'; index += 1) { /* front matter */ }
      index += 1;
    }
    for (; index < lines.length && !builder.isFull(); index += 1) {
      const raw = lines[index];
      const line = index + 1;
      if (raw.trim()) lastLine = line;
      if (fence) {
        const close = FENCE_RE.exec(raw);
        if (close && close[1][0] === fence[0] && close[1].length >= fence.length && !raw.trim().slice(close[1].length).trim()) fence = null;
        previousIsParagraph = false;
        continue;
      }
      const opened = FENCE_RE.exec(raw);
      if (opened) {
        fence = opened[1];
        previousIsParagraph = false;
        continue;
      }
      const atx = ATX_RE.exec(raw);
      if (atx) {
        let name = scanHead(atx[2]).replace(/[ \t]+#+[ \t]*$/, '').trim();
        if (/^#+$/.test(name)) name = '';
        if (name) heading(atx[1].length, cleanName(name), line);
        previousIsParagraph = false;
        continue;
      }
      const setext = SETEXT_RE.exec(raw);
      if (setext && previousIsParagraph) {
        heading(setext[1][0] === '=' ? 1 : 2, cleanName(lines[index - 1]), line - 1);
        previousIsParagraph = false;
        continue;
      }
      previousIsParagraph = Boolean(raw.trim()) && !NOT_PARAGRAPH_RE.test(raw);
    }
    while (open.length) closeAt(open.pop().symbol, lastLine);
    return result(builder, clipped);
  }

  /* ------------------------------------------------------------------ Python */

  const PY_DEF_RE = /^[ \t]*(?:async[ \t]+)?(def|class)[ \t]+([\p{L}_][\p{L}\p{N}_]*)/u;

  function indentWidth(raw) {
    let width = 0;
    for (const ch of raw) {
      if (ch === ' ') width += 1;
      else if (ch === '\t') width = (Math.floor(width / 8) + 1) * 8;
      else break;
    }
    return width;
  }

  // One line's lexical effect: the triple-quote state after it, the bracket depth after
  // it, whether it ends with a continuation backslash, and whether it holds code.
  function scanPythonLine(raw, state) {
    let triple = state.triple;
    let depth = state.depth;
    let code = false;
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i];
      if (triple) {
        if (ch === '\\') { i += 2; continue; }
        if (raw.startsWith(triple, i)) { triple = null; i += 3; continue; }
        i += 1;
        continue;
      }
      if (ch === '#') break;
      if (ch === '"' || ch === "'") {
        code = true;
        if (raw.startsWith(ch.repeat(3), i)) { triple = ch.repeat(3); i += 3; continue; }
        i += 1;
        while (i < raw.length && raw[i] !== ch) i += raw[i] === '\\' ? 2 : 1;
        i += 1;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if ((ch === ')' || ch === ']' || ch === '}') && depth > 0) depth -= 1;
      if (ch !== ' ' && ch !== '\t') code = true;
      i += 1;
    }
    const continued = !triple && /\\$/.test(raw.replace(/#.*$/, ''));
    return { triple, depth, continued, code };
  }

  function pythonOutline(text, opts) {
    const { text: body, clipped } = clipText(text, opts?.maxTextChars);
    const lines = splitLines(body);
    const builder = createBuilder(opts?.maxSymbols);
    const open = []; // [{ symbol, indent }]
    let state = { triple: null, depth: 0, continued: false };
    let lastCode = 0;
    for (let index = 0; index < lines.length && !builder.isFull(); index += 1) {
      const raw = lines[index];
      const line = index + 1;
      // A line that starts inside a string, a bracket or after a backslash continues a statement.
      const continuation = Boolean(state.triple) || state.depth > 0 || state.continued;
      const next = scanPythonLine(raw, state);
      state = next;
      if (!next.code && !continuation) continue;
      if (!continuation) {
        const indent = indentWidth(raw);
        while (open.length && open[open.length - 1].indent >= indent) closeAt(open.pop().symbol, lastCode);
        const def = PY_DEF_RE.exec(raw);
        if (def) {
          const parent = open.length ? open[open.length - 1].symbol : null;
          const kind = def[1] === 'class' ? 'class' : parent && parent.kind === 'class' ? 'method' : 'function';
          const symbol = builder.add(parent ? parent.children : null, mkSymbol(def[2], kind, line, raw.indexOf(def[2]) + 1));
          if (symbol) open.push({ symbol, indent });
        }
      }
      lastCode = line;
    }
    while (open.length) closeAt(open.pop().symbol, lastCode);
    return result(builder, clipped);
  }

  /* ------------------------------------------------------------------ JSON */

  // Tokens: { t: '{' | '}' | '[' | ']' | ':' | ',' | 's' (string) | 'v' (other value), text, line, col }.
  function jsonTokens(text, onToken) {
    let line = 1;
    let lineStart = 0;
    let i = 0;
    const n = text.length;
    while (i < n) {
      const ch = text[i];
      if (ch === '\n') { line += 1; lineStart = i + 1; i += 1; continue; }
      if (ch === ' ' || ch === '\t' || ch === '\r') { i += 1; continue; }
      if (ch === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i += 1; continue; }
      if (ch === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        const stop = end < 0 ? n : end + 2;
        for (let k = i; k < stop; k += 1) if (text[k] === '\n') { line += 1; lineStart = k + 1; }
        i = stop;
        continue;
      }
      const col = i - lineStart + 1;
      if ('{}[]:,'.includes(ch)) {
        if (onToken({ t: ch, line, col }) === false) return;
        i += 1;
        continue;
      }
      if (ch === '"') {
        let k = i + 1;
        while (k < n && text[k] !== '"' && text[k] !== '\n') k += text[k] === '\\' ? 2 : 1;
        if (onToken({ t: 's', text: text.slice(i, Math.min(k + 1, n)), line, col }) === false) return;
        i = k + 1;
        continue;
      }
      let k = i;
      while (k < n && !' \t\r\n{}[]:,"/'.includes(text[k])) k += 1;
      if (k === i) k += 1;
      if (onToken({ t: 'v', line, col }) === false) return;
      i = k;
    }
  }

  function jsonKeyName(literal) {
    try { return cleanName(JSON.parse(literal)); } catch (_error) { return cleanName(literal.replace(/^"|"$/g, '')); }
  }

  function jsonOutline(text, opts) {
    const { text: body, clipped } = clipText(text, opts?.maxTextChars);
    const builder = createBuilder(opts?.maxSymbols);
    const maxDepth = Number.isFinite(opts?.maxDepth) ? opts.maxDepth : JSON_MAX_DEPTH;
    // Frame = { type: 'object' | 'array', owner: Symbol | null, depth: children's depth, key: pending key symbol, expectKey, index }
    const stack = [];
    let rootSeen = false;

    function attach(frame, symbol) {
      if (!frame || frame.depth > maxDepth) return null;
      return builder.add(frame.owner ? frame.owner.children : null, symbol);
    }

    function openContainer(token) {
      const frame = stack[stack.length - 1] || null;
      const type = token.t === '{' ? 'object' : 'array';
      let owner = null;
      if (!frame) {
        if (rootSeen) return false;
        rootSeen = true;
      } else if (frame.type === 'object') {
        owner = frame.key;
        frame.key = null;
      } else {
        owner = attach(frame, mkSymbol(String(frame.index), type, token.line, token.col));
      }
      stack.push({ type, owner, depth: frame ? frame.depth + 1 : 1, key: null, expectKey: type === 'object', index: 0 });
      return true;
    }

    jsonTokens(body, (token) => {
      if (builder.isFull()) return false;
      const frame = stack[stack.length - 1] || null;
      if (token.t === '{' || token.t === '[') return openContainer(token);
      if (token.t === '}' || token.t === ']') {
        if (!frame || frame.type !== (token.t === '}' ? 'object' : 'array')) return true;
        stack.pop();
        if (frame.key) frame.key.endLine = token.line;
        if (frame.owner) frame.owner.endLine = token.line;
        return stack.length > 0;
      }
      if (!frame) return true;
      if (token.t === ',') {
        if (frame.type === 'object') { frame.expectKey = true; frame.key = null; } else frame.index += 1;
        return true;
      }
      if (token.t === ':') {
        frame.expectKey = false;
        return true;
      }
      if (frame.type === 'object' && frame.expectKey && token.t === 's') {
        frame.key = attach(frame, mkSymbol(jsonKeyName(token.text), 'key', token.line, token.col + 1));
        frame.expectKey = false;
        return true;
      }
      if (frame.type === 'object' && frame.key) {
        frame.key.endLine = token.line;
        frame.key = null;
      }
      return true;
    });
    return result(builder, clipped);
  }

  /* ------------------------------------------------------------------ CSS / SCSS / Less */

  function cssOutline(text, opts) {
    const { text: body, clipped } = clipText(text, opts?.maxTextChars);
    const builder = createBuilder(opts?.maxSymbols);
    const lineComments = opts?.lineComments === true;
    // [{ symbol, parent }]: an anonymous block has no symbol; its rules attach to `parent`.
    const stack = [];
    let prelude = '';
    let preludeHasText = false;
    let preludeLine = 0;
    let preludeCol = 0;
    let interpolation = 0;
    let parens = 0;
    let line = 1;
    let lineStart = 0;
    const n = body.length;

    function take(ch, at) {
      if (!preludeHasText && ch.trim()) {
        preludeHasText = true;
        preludeLine = line;
        preludeCol = at - lineStart + 1;
      }
      if (prelude.length < PRELUDE_MAX_CHARS) prelude += ch.slice(0, PRELUDE_MAX_CHARS - prelude.length);
    }
    const resetPrelude = () => { prelude = ''; preludeHasText = false; };

    for (let i = 0; i < n && !builder.isFull(); i += 1) {
      const ch = body[i];
      if (ch === '\n') { line += 1; lineStart = i + 1; take(' ', i); continue; }
      if (ch === '/' && body[i + 1] === '*') {
        const end = body.indexOf('*/', i + 2);
        const stop = end < 0 ? n : end + 2;
        for (let k = i; k < stop; k += 1) if (body[k] === '\n') { line += 1; lineStart = k + 1; }
        i = stop - 1;
        take(' ', i);
        continue;
      }
      if (lineComments && parens === 0 && ch === '/' && body[i + 1] === '/') {
        while (i + 1 < n && body[i + 1] !== '\n') i += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        let k = i + 1;
        while (k < n && body[k] !== ch && body[k] !== '\n') k += body[k] === '\\' ? 2 : 1;
        take(body.slice(i, k + 1), i);
        i = k;
        continue;
      }
      if (ch === '(') parens += 1;
      else if (ch === ')' && parens > 0) parens -= 1;
      if (ch === '{' && body[i - 1] === '#') { interpolation += 1; take(ch, i); continue; }
      if (ch === '}' && interpolation > 0) { interpolation -= 1; take(ch, i); continue; }
      if (ch === '{') {
        const name = cleanName(prelude);
        const top = stack[stack.length - 1] || null;
        const parent = top ? top.symbol || top.parent : null;
        const symbol = name ? builder.add(parent ? parent.children : null, mkSymbol(name, name[0] === '@' ? 'at-rule' : 'selector', preludeLine, preludeCol)) : null;
        stack.push({ symbol, parent });
        resetPrelude();
        parens = 0;
        continue;
      }
      if (ch === '}') {
        const frame = stack.pop();
        if (frame && frame.symbol) closeAt(frame.symbol, line);
        resetPrelude();
        parens = 0;
        continue;
      }
      if (ch === ';' && parens === 0) {
        resetPrelude();
        continue;
      }
      take(ch, i);
    }
    return result(builder, clipped);
  }

  /* ------------------------------------------------------------------ YAML */

  const YAML_QUOTED_KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')[ \t]*:(?:[ \t]|$)/;
  const YAML_PLAIN_KEY_RE = /^([^\s#"'[\]{},&*!|>%@`?:-][^#]*?)[ \t]*:(?:[ \t]|$)/;

  function yamlOutline(text, opts) {
    const { text: body, clipped } = clipText(text, opts?.maxTextChars);
    const lines = splitLines(body);
    const builder = createBuilder(opts?.maxSymbols);
    let current = null;
    let lastLine = 0;
    for (let index = 0; index < lines.length && !builder.isFull(); index += 1) {
      const raw = lines[index];
      const line = index + 1;
      if (!raw.trim() || raw[0] === '#') continue;
      if (raw[0] !== ' ' && raw[0] !== '\t') {
        const head = scanHead(raw);
        const match = YAML_QUOTED_KEY_RE.exec(head) || YAML_PLAIN_KEY_RE.exec(head);
        if (match || /^(?:---|\.\.\.)(?:\s|$)/.test(raw)) {
          if (current) current.endLine = Math.max(lastLine, current.line);
          current = null;
        }
        if (match) {
          let name = match[1];
          if (name[0] === '"' || name[0] === "'") name = name.slice(1, -1);
          current = builder.add(null, mkSymbol(cleanName(name), 'key', line, 1));
        }
      }
      lastLine = line;
    }
    if (current) current.endLine = Math.max(lastLine, current.line);
    return result(builder, clipped);
  }

  /* ------------------------------------------------------------------ TS / JS navigation tree */

  // VS Code's TypeScript outline rule: no import aliases, no anonymous `<function>` /
  // `<class>` entries, unless one of them holds a named child.
  function isNamedNavItem(item) {
    const name = String(item?.text || '');
    return item?.kind !== 'alias' && Boolean(name) && name !== '<function>' && name !== '<class>';
  }

  function outlineFromNavigationTree(tree, positionAt, opts) {
    const builder = createBuilder(opts?.maxSymbols);
    const maxOffset = Number.isFinite(opts?.maxOffset) ? opts.maxOffset : MAX_TEXT_CHARS;
    const position = typeof positionAt === 'function' ? positionAt : () => null;
    let clipped = false;

    function spanBounds(item) {
      const spans = Array.isArray(item?.spans) ? item.spans.filter((s) => s && Number.isFinite(s.start)) : [];
      if (!spans.length) return null;
      const start = Math.min(...spans.map((s) => s.start));
      const end = Math.max(...spans.map((s) => s.start + (Number(s.length) || 0)));
      return { start, end };
    }

    // Returns the symbol built for `item` (null when excluded or out of bounds).
    function convert(item, siblings) {
      const bounds = spanBounds(item);
      if (!bounds || builder.isFull()) return null;
      if (bounds.start >= maxOffset) {
        clipped = true;
        return null;
      }
      const nameAt = Number.isFinite(item.nameSpan?.start) ? item.nameSpan.start : bounds.start;
      const at = position(nameAt) || position(bounds.start);
      if (!at) return null;
      const startAt = position(bounds.start) || at;
      const endAt = position(Math.min(bounds.end, maxOffset)) || at;
      const symbol = mkSymbol(cleanName(item.text) || '<anonymous>', String(item.kind || ''), at.lineNumber, at.column);
      symbol.startLine = Math.min(startAt.lineNumber, at.lineNumber);
      symbol.endLine = Math.max(endAt.lineNumber, at.lineNumber);
      const children = Array.isArray(item.childItems) ? item.childItems : [];
      const named = isNamedNavItem(item);
      // Reserve this symbol's slot before its children so the cap keeps parents first.
      if (named && !builder.add(siblings, symbol)) return null;
      for (const child of children) convert(child, named ? symbol.children : siblings);
      return named ? symbol : null;
    }

    const roots = Array.isArray(tree?.childItems) ? tree.childItems : [];
    for (const item of roots) convert(item, null);
    return result(builder, clipped);
  }

  /* ------------------------------------------------------------------ dispatch and helpers */

  const TEXT_PROVIDERS = Object.freeze({
    markdown: markdownOutline,
    python: pythonOutline,
    json: jsonOutline,
    css: cssOutline,
    yaml: yamlOutline,
  });

  // Text outline for a document; { symbols: [], truncated: '', supported: false } when the
  // file type has no text provider (TS/JS goes through outlineFromNavigationTree).
  function outlineFromText(languageId, text, opts) {
    const provider = providerFor(languageId, opts?.path);
    const scan = provider ? TEXT_PROVIDERS[provider] : null;
    if (!scan) return { symbols: [], truncated: '', supported: false };
    const lang = String(languageId || '').toLowerCase();
    const lineComments = lang === 'scss' || lang === 'less' || /\.(scss|less)$/i.test(String(opts?.path || ''));
    return { ...scan(text, { ...opts, lineComments }), supported: true };
  }

  // The chain of symbols (outermost first) whose range holds `line`; the innermost wins.
  function findActivePath(symbols, line) {
    const path = [];
    let level = Array.isArray(symbols) ? symbols : [];
    while (level.length) {
      let hit = null;
      for (const symbol of level) {
        if (symbol.startLine <= line && line <= symbol.endLine && (!hit || symbol.startLine >= hit.startLine)) hit = symbol;
      }
      if (!hit) break;
      path.push(hit);
      level = hit.children;
    }
    return path;
  }

  // A sorted copy: 'position' (document order) or 'name' (natural; collator built on first use, O4).
  let nameCollator = null;
  const collator = () => (nameCollator ||= new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }));
  function sortSymbols(symbols, mode) {
    const list = (Array.isArray(symbols) ? symbols : []).map((s) => ({ ...s, children: sortSymbols(s.children, mode) }));
    if (mode === 'name') list.sort((a, b) => collator().compare(a.name, b.name) || a.line - b.line);
    else list.sort((a, b) => a.line - b.line || a.column - b.column);
    return list;
  }

  return {
    MAX_SYMBOLS,
    MAX_TEXT_CHARS,
    JSON_MAX_DEPTH,
    providerFor,
    outlineFromText,
    outlineFromNavigationTree,
    markdownOutline,
    pythonOutline,
    jsonOutline,
    cssOutline,
    yamlOutline,
    findActivePath,
    sortSymbols,
  };
});
