/* renderer/features/renderer-ide-search-filters.js - pure helpers for the Workspace IDE
 * search options added in row 82 slice X2 (plan docs/plans/IDE_VSCODE_PARITY_2026-10-26.md
 * section 5.6): the include/exclude glob filter, whole-word query wrapping and the
 * Search query history. No DOM, no I/O. Loaded by the renderer (global
 * rendererIdeSearchFilters) AND required by the main-process search service, so the
 * literal (main) and regex (renderer) paths filter files identically. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeSearchFilters = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globMatch = (typeof module === 'object' && module.exports)
    ? require('../shared/glob-match')
    : globalThis.jennyGlobMatch;
  // The one escapeRegExp (renderer/shared/string-utils.js, an eager script).
  const { escapeRegExp } = (typeof module === 'object' && module.exports)
    ? require('../shared/string-utils')
    : globalThis.stringUtils;

  const GLOB_FIELD_MAX_ENTRIES = 32;
  const GLOB_ENTRY_MAX_CHARS = 256;
  const HISTORY_MAX = 20;
  const HISTORY_MIN_QUERY = 2;
  const DIR_CACHE_MAX = 4000;
  const WORD_CHAR = /[A-Za-z0-9_]/;
  const WORD_CLASS = '[A-Za-z0-9_]';

  /* ------------------------------------------------------------------ */
  /* Glob fields                                                         */
  /* ------------------------------------------------------------------ */

  /** Field text (comma/newline separated) -> normalized pattern list: '\' -> '/', a leading
   *  './' becomes a root anchor '/', at most 32 entries, entries over 256 chars dropped. */
  function parseGlobField(text) {
    if (!globMatch) return [];
    const out = [];
    for (const raw of globMatch.parseList(text)) {
      let entry = raw.replace(/\\/g, '/');
      if (entry.startsWith('./')) entry = '/' + entry.slice(2);
      if (!entry || entry === '/' || entry.length > GLOB_ENTRY_MAX_CHARS) continue;
      out.push(entry);
      if (out.length >= GLOB_FIELD_MAX_ENTRIES) break;
    }
    return out;
  }

  /** Payload-side validation of an include/exclude list (the main service uses it too):
   *  non-array -> []; entries coerced to strings, '\' -> '/', capped like parseGlobField. */
  function sanitizeGlobList(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const item of value) {
      if (typeof item !== 'string' && typeof item !== 'number') continue;
      const entry = String(item).trim().replace(/\\/g, '/');
      if (!entry || entry.length > GLOB_ENTRY_MAX_CHARS) continue;
      out.push(entry);
      if (out.length >= GLOB_FIELD_MAX_ENTRIES) break;
    }
    return out;
  }

  function parentOf(relPath) {
    const index = relPath.lastIndexOf('/');
    return index === -1 ? '' : relPath.slice(0, index);
  }

  function normalizeRel(relPath) {
    let p = String(relPath == null ? '' : relPath).replace(/\\/g, '/');
    while (p.startsWith('./')) p = p.slice(2);
    while (p.startsWith('/')) p = p.slice(1);
    while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p;
  }

  /* Matcher set with a memoized "this directory or any ancestor matches" lookup, so a file
   * costs one test of itself plus one cached lookup of its parent directory. A folder-like
   * entry (`src`, `node_modules`) therefore also covers everything below it (VS Code). */
  function createMatcherSet(patterns) {
    const matchers = globMatch ? globMatch.compileAll(patterns) : [];
    const dirCache = new Map();
    const testOne = (relPath, isDir) => {
      for (const matcher of matchers) {
        if (matcher.test(relPath, { isDir })) return true;
      }
      return false;
    };
    function dirOrAncestorMatches(dir) {
      if (!dir) return false;
      if (dirCache.has(dir)) return dirCache.get(dir);
      const result = testOne(dir, true) || dirOrAncestorMatches(parentOf(dir));
      if (dirCache.size >= DIR_CACHE_MAX) dirCache.clear();
      dirCache.set(dir, result);
      return result;
    }
    return {
      size: matchers.length,
      prefixes: anchoredPrefixes(matchers),
      directory: (dir) => dirOrAncestorMatches(normalizeRel(dir)),
      file: (file) => {
        const rel = normalizeRel(file);
        return testOne(rel, false) || dirOrAncestorMatches(parentOf(rel));
      },
    };
  }

  // The literal leading segments of each pattern (until the first glob character), or null
  // when any pattern is unanchored: only a leading '/' anchors (glob-match), so an
  // unanchored pattern can match below any directory and nothing may be pruned.
  function anchoredPrefixes(matchers) {
    if (!matchers.length || matchers.some((matcher) => !matcher.anchored)) return null;
    return matchers.map((matcher) => {
      const segments = [];
      for (const segment of normalizeRel(matcher.pattern).split('/')) {
        if (/[*?[\]{}]/.test(segment)) break;
        segments.push(segment);
      }
      return segments;
    });
  }

  // A directory can hold a match of an anchored pattern only when it and the pattern's
  // literal prefix agree on every segment they both have.
  function prefixReaches(prefix, dir) {
    const parts = dir.split('/');
    const shared = Math.min(parts.length, prefix.length);
    for (let i = 0; i < shared; i += 1) {
      if (parts[i] !== prefix[i]) return false;
    }
    return true;
  }

  /** Compiled once per search. Paths are workspace-root-relative, '/'-separated. */
  function createSearchPathFilter({ include = [], exclude = [] } = {}) {
    const includeSet = createMatcherSet(include);
    const excludeSet = createMatcherSet(exclude);
    const includesFile = (relPath) => includeSet.size === 0 || includeSet.file(relPath);
    const excludesFile = (relPath) => excludeSet.size > 0 && excludeSet.file(relPath);
    const excludesDirectory = (relPath) => excludeSet.size > 0 && excludeSet.directory(relPath);
    // A walk may skip a directory that is excluded, or that no anchored include can reach
    // (row 82 X1). Never true for a directory that could hold an accepted file.
    const skipsDirectory = (relPath) => {
      if (excludesDirectory(relPath)) return true;
      const prefixes = includeSet.prefixes;
      if (!prefixes) return false;
      const dir = normalizeRel(relPath);
      return Boolean(dir) && !prefixes.some((prefix) => prefixReaches(prefix, dir));
    };
    return {
      active: includeSet.size > 0 || excludeSet.size > 0,
      includesFile,
      excludesDirectory,
      skipsDirectory,
      excludesFile,
      acceptsFile: (relPath) => includesFile(relPath) && !excludesFile(relPath),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Whole word                                                          */
  /* ------------------------------------------------------------------ */

  // `literal` (the unescaped query, when known) decides each side: a boundary is only
  // required next to a word character, so `foo(` still matches `foo(x` (VS Code).
  function wholeWordSource(source, literal) {
    const left = literal == null || WORD_CHAR.test(literal[0] || '') ? `(?<!${WORD_CLASS})` : '';
    const right = literal == null || WORD_CHAR.test(literal[literal.length - 1] || '') ? `(?!${WORD_CLASS})` : '';
    return `${left}(?:${source})${right}`;
  }

  /** Folds "match whole word" into a regex query so find, preview and replace share one
   *  evaluation path. A literal query is escaped and its replacement text has every `$`
   *  doubled so regex replacement inserts it literally. */
  function resolveEffectiveFind({ query, replaceText, useRegex, wholeWord } = {}) {
    const q = String(query ?? '');
    const r = String(replaceText ?? '');
    if (wholeWord !== true) return { query: q, replaceText: r, useRegex: useRegex === true };
    return {
      query: useRegex === true ? wholeWordSource(q) : wholeWordSource(escapeRegExp(q), q),
      replaceText: useRegex === true ? r : r.replace(/\$/g, '$$$$'),
      useRegex: true,
    };
  }

  /** Options sent with a find on either path, set-only: { wholeWord?, include?, exclude? }.
   *  `search` is the panel's ide.search slice (wholeWord, includeText, excludeText). */
  function buildSearchOptions(search) {
    const out = {};
    if (search && search.wholeWord === true) out.wholeWord = true;
    const include = parseGlobField(search && search.includeText);
    const exclude = parseGlobField(search && search.excludeText);
    if (include.length) out.include = include;
    if (exclude.length) out.exclude = exclude;
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* History                                                             */
  /* ------------------------------------------------------------------ */

  /** Newest LAST, trimmed, de-duplicated (a repeat moves to the end); queries under two
   *  characters are ignored. Always returns a new array. */
  function pushSearchHistory(list, query, max = HISTORY_MAX) {
    const base = Array.isArray(list) ? list.filter((entry) => typeof entry === 'string') : [];
    const entry = String(query ?? '').trim();
    if (entry.length < HISTORY_MIN_QUERY) return base.slice(-max);
    return base.filter((item) => item !== entry).concat(entry).slice(-max);
  }

  /** ArrowUp ('up') goes to an older entry, ArrowDown ('down') to a newer one. `cursor` is
   *  an index into `list`, or -1 while the user is on their own draft. Stepping past the
   *  newest entry returns to `draft`. Returns { cursor, value } or null when there is
   *  nothing to step to (empty history, already at the oldest/draft). */
  function stepSearchHistory(list, cursor, direction, draft = '') {
    const entries = Array.isArray(list) ? list : [];
    if (!entries.length) return null;
    const at = Number.isInteger(cursor) && cursor >= 0 && cursor < entries.length ? cursor : -1;
    if (direction === 'up') {
      const next = at === -1 ? entries.length - 1 : Math.max(0, at - 1);
      return { cursor: next, value: entries[next] };
    }
    if (direction === 'down') {
      if (at === -1) return null;
      if (at + 1 >= entries.length) return { cursor: -1, value: String(draft ?? '') };
      return { cursor: at + 1, value: entries[at + 1] };
    }
    return null;
  }

  return Object.freeze({
    WORD_CHAR,
    HISTORY_MAX,
    parseGlobField,
    sanitizeGlobList,
    createSearchPathFilter,
    wholeWordSource,
    resolveEffectiveFind,
    buildSearchOptions,
    pushSearchHistory,
    stepSearchHistory,
  });
});
