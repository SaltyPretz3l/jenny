/* renderer/shared/glob-match.js - bounded glob matcher shared by the renderer and the
 * main process (row 82, plan docs/plans/IDE_VSCODE_PARITY_2026-10-26.md section 5.5).
 *
 * Semantics (VS Code files.exclude / .editorconfig section rules, the subset both use):
 * - paths use '/' separators; callers normalize '\\' before matching;
 * - '*' matches within one segment, '**' across segments, '?' one character;
 * - '[abc]', '[a-z]', '[!x]' character classes; '{a,b}' alternation (one level);
 * - a leading '/' anchors the pattern at the root; a pattern without any '/' matches a
 *   basename anywhere; a trailing '/' matches directories only (callers pass isDir);
 * - every literal is regex-escaped, so a pattern can never inject regex syntax;
 * - patterns and paths are capped (PATTERN_MAX, PATH_MAX) and compile() never throws:
 *   a malformed pattern yields a matcher that matches nothing. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.jennyGlobMatch = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PATTERN_MAX = 512;
  const PATH_MAX = 4096;
  const SEGMENT = '[^/]*';
  // Each `*` compiles to a nested `[^/]*`; a segment with many of them backtracks as
  // n^k against a long name (`*a*a*a*a*b` on 100 chars: seconds). Patterns past these
  // limits compile to NEVER rather than freeze the renderer or the search worker.
  const MAX_STARS_PER_SEGMENT = 3;
  const MAX_WILDCARDS = 8;
  const NEVER = Object.freeze({ pattern: '', anchored: false, dirOnly: false, test: () => false });

  function escapeLiteral(ch) {
    return /[\\^$.*+?()[\]{}|/-]/.test(ch) ? '\\' + ch : ch;
  }

  function expandBraces(pattern) {
    const open = pattern.indexOf('{');
    if (open === -1) return [pattern];
    const close = pattern.indexOf('}', open);
    if (close === -1) return [pattern];
    const head = pattern.slice(0, open);
    const tail = pattern.slice(close + 1);
    const parts = pattern.slice(open + 1, close).split(',');
    const out = [];
    for (const part of parts) {
      for (const rest of expandBraces(tail)) out.push(head + part + rest);
    }
    return out;
  }

  /* One brace-free pattern body -> regex source (unanchored). */
  function bodyToRegex(body) {
    let src = '';
    let i = 0;
    while (i < body.length) {
      const ch = body[i];
      if (ch === '*') {
        if (body[i + 1] === '*') {
          let j = i + 2;
          if (body[j] === '/') {
            j += 1;
            src += '(?:.*/)?';
          } else if (i === 0 || body[i - 1] === '/') {
            src += '.*';
          } else {
            src += SEGMENT;
          }
          i = j;
          continue;
        }
        src += SEGMENT;
        i += 1;
        continue;
      }
      if (ch === '?') { src += '[^/]'; i += 1; continue; }
      if (ch === '[') {
        const end = body.indexOf(']', i + 2);
        if (end === -1) { src += '\\['; i += 1; continue; }
        let cls = body.slice(i + 1, end);
        let negate = false;
        if (cls[0] === '!' || cls[0] === '^') { negate = true; cls = cls.slice(1); }
        let inner = '';
        for (let k = 0; k < cls.length; k += 1) {
          const c = cls[k];
          if (c === '-' && k > 0 && k < cls.length - 1) inner += '-';
          else inner += /[\\\]^-]/.test(c) ? '\\' + c : c;
        }
        if (!inner) { src += '\\[' + (negate ? '!' : '') + '\\]'; i = end + 1; continue; }
        src += '[' + (negate ? '^' : '') + inner + ']';
        i = end + 1;
        continue;
      }
      src += escapeLiteral(ch);
      i += 1;
    }
    return src;
  }

  function boundedWildcards(raw) {
    let total = 0;
    for (const segment of raw.split('/')) {
      if (segment === '**') { total += 1; continue; }
      const stars = (segment.match(/\*/g) || []).length;
      if (stars > MAX_STARS_PER_SEGMENT) return false;
      total += stars;
    }
    return total <= MAX_WILDCARDS;
  }

  function compile(pattern) {
    let raw = String(pattern == null ? '' : pattern).trim();
    if (!raw || raw.length > PATTERN_MAX) return NEVER;
    raw = raw.replace(/\\/g, '/').replace(/\*{3,}/g, '**');
    if (!boundedWildcards(raw)) return NEVER;
    const dirOnly = raw.length > 1 && raw.endsWith('/');
    if (dirOnly) raw = raw.slice(0, -1);
    const anchored = raw.startsWith('/');
    if (anchored) raw = raw.slice(1);
    if (!raw) return NEVER;
    const basenameOnly = !anchored && raw.indexOf('/') === -1;
    let regex;
    try {
      const alternatives = expandBraces(raw).map(bodyToRegex);
      const core = alternatives.length === 1 ? alternatives[0] : '(?:' + alternatives.join('|') + ')';
      const prefix = basenameOnly ? '^(?:.*/)?' : (anchored ? '^' : '^(?:.*/)?');
      regex = new RegExp(prefix + core + '$');
    } catch (_err) {
      return NEVER;
    }
    function test(relPath, opts) {
      let p = String(relPath == null ? '' : relPath);
      if (!p || p.length > PATH_MAX) return false;
      p = p.replace(/\\/g, '/');
      while (p.startsWith('./')) p = p.slice(2);
      if (p.startsWith('/')) p = p.slice(1);
      if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
      if (dirOnly && !(opts && opts.isDir)) return false;
      return regex.test(p);
    }
    return Object.freeze({ pattern: String(pattern), anchored, dirOnly, test });
  }

  function compileAll(patterns) {
    const list = Array.isArray(patterns) ? patterns : (patterns == null ? [] : [patterns]);
    return list.map(compile).filter((m) => m !== NEVER);
  }

  function matchAny(patterns, relPath, opts) {
    const matchers = Array.isArray(patterns) && patterns.length && typeof patterns[0] === 'object' && patterns[0] && typeof patterns[0].test === 'function'
      ? patterns
      : compileAll(patterns);
    for (const m of matchers) {
      if (m.test(relPath, opts)) return true;
    }
    return false;
  }

  /* Comma- or newline-separated field text (the Search include/exclude boxes) -> patterns. */
  // Comma- or newline-separated patterns; a comma inside braces (`*.{js,ts}`) is part
  // of its pattern, not a separator.
  function parseList(text) {
    const out = [];
    let current = '';
    let depth = 0;
    for (const ch of String(text == null ? '' : text)) {
      if (ch === '{') depth += 1;
      else if (ch === '}' && depth > 0) depth -= 1;
      if (ch === '\n' || (ch === ',' && depth === 0)) {
        out.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    out.push(current);
    return out.map((s) => s.trim()).filter(Boolean).slice(0, 64);
  }

  return Object.freeze({ compile, compileAll, matchAny, parseList, PATTERN_MAX, PATH_MAX });
});
