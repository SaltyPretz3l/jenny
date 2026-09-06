/* renderer/features/renderer-ide-replace-text-utils.js - pure-logic utilities for
 * the Workspace IDE find-and-replace feature. No DOM, no I/O, no side effects.
 * Responsibilities:
 *   - EOL normalisation (CRLF/CR -> LF) and round-trip restore
 *   - Regex construction for find queries (case / multiline / global flags)
 *   - Match location (line/column via binary-searched lineStarts table)
 *   - Preview window extraction for the search-results panel
 *   - Match counting with zero-width guard
 *   - Per-file match collection for searchInFiles results
 *   - Whole-buffer replace (all occurrences) with $ literal safety for non-regex
 *   - Single-occurrence replace at a specific line/column position
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeReplaceTextUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  /* ------------------------------------------------------------------ */
  /* EOL utilities                                                         */
  /* ------------------------------------------------------------------ */

  /** Normalise all line endings to LF. Handles CRLF then bare CR. */
  function toLf(raw) {
    return String(raw ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  /** Detect the dominant EOL style of a raw buffer: 'crlf', 'cr', or 'lf'.
   *  Bare-CR (classic Mac) is recognised so a replace never silently rewrites
   *  every line ending in such a file to LF. */
  function detectEol(raw) {
    const s = String(raw ?? '');
    if (/\r\n/.test(s)) return 'crlf';
    if (/\r/.test(s)) return 'cr';
    return 'lf';
  }

  /** Re-apply the original EOL style after working in LF-normalised space. */
  function restoreEol(lfText, eol) {
    const s = String(lfText);
    if (eol === 'crlf') return s.replace(/\n/g, '\r\n');
    if (eol === 'cr') return s.replace(/\n/g, '\r');
    return s;
  }

  function toLfWithRawOffsets(raw) {
    const source = String(raw ?? '');
    const chars = [];
    const rawOffsets = [0];
    let rawIndex = 0;
    while (rawIndex < source.length) {
      if (source[rawIndex] === '\r') {
        rawIndex += source[rawIndex + 1] === '\n' ? 2 : 1;
        chars.push('\n');
      } else {
        chars.push(source[rawIndex]);
        rawIndex += 1;
      }
      rawOffsets.push(rawIndex);
    }
    return { text: chars.join(''), rawOffsets, source };
  }

  /* ------------------------------------------------------------------ */
  /* Regex helpers                                                         */
  /* ------------------------------------------------------------------ */

  /** Escape every regex metacharacter so a literal string can be used as a
   *  pattern without unintended matching behaviour. */
  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
  }

  /**
   * Build a RegExp from a raw query string with the requested flags.
   * Deliberately omits the 's' (dotAll) flag so '.' does not cross lines in
   * multiline find results.
   * Throws SyntaxError for invalid patterns — callers are expected to catch.
   */
  function buildFindRegex(query, { caseSensitive = false, multiline = false, global = false } = {}) {
    const flags =
      (global ? 'g' : '') +
      (multiline ? 'm' : '') +
      (caseSensitive ? '' : 'i');
    return new RegExp(query, flags);
  }

  // Conservative preview-only guard. The real find/replace evaluation runs in
  // a deadline-bounded worker, but preview rendering is synchronous. Avoid
  // re-executing groups that combine inner repetition/alternation with an
  // outer quantifier (the common catastrophic-backtracking shapes).
  function isPotentiallyUnsafeRegexSource(source) {
    const input = String(source || '');
    if (input.length > 512) return true;
    const stack = [];
    let escaped = false;
    let inClass = false;
    for (let index = 0; index !== input.length; index += 1) {
      const char = input[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '[') inClass = true;
      if (char === ']' && inClass) inClass = false;
      if (inClass) continue;
      if (char === '(') {
        stack.push({ hasQuantifier: false, hasAlternation: false });
        continue;
      }
      if (char === '|') {
        if (stack.length) stack[stack.length - 1].hasAlternation = true;
        continue;
      }
      if (char === ')') {
        const group = stack.pop();
        if (!group) continue;
        const next = input[index + 1] || '';
        const outerQuantifier = next === '*' || next === '+' || next === '?' || next === '{';
        if (outerQuantifier && (group.hasQuantifier || group.hasAlternation)) return true;
        if (stack.length && group.hasQuantifier) stack[stack.length - 1].hasQuantifier = true;
        continue;
      }
      if (char === '*' || char === '+' || char === '{'
        || (char === '?' && input[index - 1] !== '(')) {
        if (stack.length) stack[stack.length - 1].hasQuantifier = true;
      }
    }
    return false;
  }

  let previewMatcher = null;
  let previewMatcherKey = '';

  function computeRegexPreviewReplacement(match, options) {
    const preview = match?.preview || {};
    const text = String(preview.text || '');
    const start = Math.max(0, Math.min(Number(preview.matchStart) || 0, text.length));
    const end = Math.max(start, Math.min(Number(preview.matchEnd) || 0, text.length));
    const query = String(options?.query || '');
    if (isPotentiallyUnsafeRegexSource(query)) return text.slice(start, end);
    try {
      const key = (options?.caseSensitive ? '1\n' : '0\n') + query;
      if (key !== previewMatcherKey) {
        previewMatcher = new RegExp(query, (options?.caseSensitive ? '' : 'i') + 'my');
        previewMatcherKey = key;
      }
      previewMatcher.lastIndex = start;
      const found = previewMatcher.exec(text);
      if (!found || found.index !== start) return text.slice(start, end);
      return expandReplacement(found, String(options?.replaceText || ''));
    } catch (_error) {
      return text.slice(start, end);
    }
  }

  /**
   * Expand a regex replacement template ($1-$99, $<name>, $&, $$, $`, $') against a
   * match array, mirroring String.prototype.replace semantics — but driven by
   * the match OBJECT, so the substitution is computed from the real match and
   * its groups (correct even for lookaround/zero-width context), never by
   * re-matching an isolated substring (which drops surrounding context).
   * `match.input` must be the full string the match came from.
   */
  function expandReplacement(match, template) {
    const tpl = String(template);
    const full = String(match.input != null ? match.input : '');
    let out = '';
    let i = 0;
    while (i < tpl.length) {
      const ch = tpl[i];
      if (ch !== '$' || i + 1 >= tpl.length) {
        out += ch;
        i += 1;
        continue;
      }
      const next = tpl[i + 1];
      if (next === '$') {
        out += '$';
        i += 2;
      } else if (next === '&') {
        out += match[0];
        i += 2;
      } else if (next === '`') {
        out += full.slice(0, match.index);
        i += 2;
      } else if (next === "'") {
        out += full.slice(match.index + match[0].length);
        i += 2;
      } else if (next === '<' && match.groups != null) {
        const close = tpl.indexOf('>', i + 2);
        if (close === -1) {
          out += '$';
          i += 1;
        } else {
          const capture = match.groups[tpl.slice(i + 2, close)];
          out += capture === undefined ? '' : String(capture);
          i = close + 1;
        }
      } else if (next >= '0' && next <= '9') {
        const two = (i + 2 < tpl.length && tpl[i + 2] >= '0' && tpl[i + 2] <= '9')
          ? next + tpl[i + 2]
          : '';
        let group = -1;
        let consumed = 0;
        if (two && Number(two) > 0 && Number(two) < match.length) {
          group = Number(two);
          consumed = 2;
        } else if (Number(next) > 0 && Number(next) < match.length) {
          group = Number(next);
          consumed = 1;
        }
        if (group >= 0) {
          out += match[group] === undefined ? '' : match[group];
          i += 1 + consumed;
        } else {
          out += '$';
          i += 1;
        }
      } else {
        out += '$';
        i += 1;
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Line-start table and location lookup                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Pre-compute an array of absolute offsets where each line begins.
   * lineStarts[0] === 0 always; lineStarts[n] === index of char after the
   * n-th '\n'.
   */
  function computeLineStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') {
        starts.push(i + 1);
      }
    }
    return starts;
  }

  /**
   * Binary-search lineStarts to find the 1-based line and 1-based column for
   * an absolute offset, plus the slice boundaries of the containing line.
   *
   * lineEnd is the index of the last character ON the line (i.e. the char
   * before the '\n', or text.length for the final line).
   */
  function locate(lineStarts, text, offset) {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    const li = lo;
    const lineStart = lineStarts[li];
    const lineEnd = (lineStarts[li + 1] !== undefined ? lineStarts[li + 1] : text.length + 1) - 1;
    return {
      line: li + 1,
      column: offset - lineStart + 1,
      lineStart,
      lineEnd,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Preview window                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Return a short excerpt of the line containing a match, together with
   * 0-based offsets INTO that excerpt marking where the match starts/ends.
   * Lines longer than 240 chars are windowed around the match with a 40-char
   * left pad, clamped to valid range.
   */
  function buildPreviewWindow(text, lineStart, lineEnd, absStart, absEnd) {
    const lineText = text.slice(lineStart, lineEnd);
    const mS = absStart - lineStart;
    const mE = Math.min(absEnd - lineStart, lineText.length);

    if (lineText.length <= 240) {
      return { text: lineText, matchStart: mS, matchEnd: mE };
    }

    // Window: try to keep 40 chars of context before the match.
    const windowStart = Math.max(0, Math.min(mS - 40, Math.max(0, lineText.length - 240)));
    const sliced = lineText.slice(windowStart, windowStart + 240);
    return {
      text: sliced,
      matchStart: Math.max(0, Math.min(mS - windowStart, 240)),
      matchEnd: Math.max(0, Math.min(mE - windowStart, 240)),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Per-file match collection                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Walk all global regex matches in lfText and push result objects into out[].
   * Each object: { path, line (1-based), column (1-based), preview }.
   * matched is a Set<string> of paths that have at least one hit.
   * atCap is an optional () => boolean; collection stops when it returns true.
   * Zero-width matches (m[0].length === 0) are skipped — advance lastIndex by 1
   * — so a pattern like `a*` or `\b` cannot loop forever or emit empty rows.
   */
  function collectRegexMatchesForFile(path, lfText, regex, out, matched, atCap) {
    const lineStarts = computeLineStarts(lfText);
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(lfText)) !== null) {
      if (m[0].length === 0) {
        regex.lastIndex = m.index + 1;
        if (regex.lastIndex > lfText.length) break;
        continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      const { line, column, lineStart, lineEnd } = locate(lineStarts, lfText, start);
      out.push({
        path,
        line,
        column,
        preview: buildPreviewWindow(lfText, lineStart, lineEnd, start, end),
      });
      matched.add(path);
      if (typeof atCap === 'function' && atCap()) break;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Whole-buffer replace                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Replace all occurrences of query in rawText and return the modified buffer
   * plus the number of replacements made.
   *
   * For literal (non-regex) mode, a function replacer is used so that any '$'
   * characters in replaceText are treated as literal dollars, not as special
   * replacement patterns ($&, $1, $$, etc.).
   *
   * For regex mode, the native string replacement patterns ($1, $&, $$) in
   * replaceText ARE honoured.
   *
   * A single manual exec loop drives BOTH the count and the transform so they
   * can never disagree. Zero-width matches (m[0].length === 0) are skipped — the
   * same guard the find/count use — so a pattern like `a*`, `.?`, `^`, or `\b`
   * replaces exactly the non-empty matches the panel highlighted, instead of
   * native String.replace inserting the replacement at every empty position
   * (which would silently corrupt the file with content the preview never
   * showed). For regex mode, $1/$&/$$/$`/$' are expanded from the real match;
   * for literal mode replaceText is used verbatim ($ is literal).
   *
   * EOL is preserved: the buffer is normalised to LF for processing, then
   * restored to its original style before returning.
   */
  function applyReplaceToText(rawText, { query, replaceText, useRegex = false, caseSensitive = false, eol } = {}) {
    if (query === '') return { newRaw: rawText, count: 0 };

    const normalized = toLfWithRawOffsets(rawText);
    const lf = normalized.text;
    const eolMode = eol || detectEol(rawText);

    let re;
    try {
      re = useRegex
        ? buildFindRegex(query, { caseSensitive, multiline: true, global: true })
        : new RegExp(escapeRegExp(query), caseSensitive ? 'gm' : 'gim');
    } catch (_error) {
      return { newRaw: rawText, count: 0 };
    }

    const literalReplacement = String(replaceText);
    let out = '';
    let lastRawIndex = 0;
    let count = 0;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(lf)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex = m.index + 1; // skip zero-width; do not emit a replacement
        if (re.lastIndex > lf.length) break;
        continue;
      }
      const expanded = useRegex ? expandReplacement(m, literalReplacement) : literalReplacement;
      const replacement = restoreEol(toLf(expanded), eolMode);
      const rawStart = normalized.rawOffsets[m.index];
      const rawEnd = normalized.rawOffsets[m.index + m[0].length];
      out += normalized.source.slice(lastRawIndex, rawStart) + replacement;
      lastRawIndex = rawEnd;
      count += 1;
    }
    out += normalized.source.slice(lastRawIndex);

    return { newRaw: out, count };
  }

  /* ------------------------------------------------------------------ */
  /* Single-position replace                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Replace a single occurrence of query at an exact line/column position.
   * Uses a sticky regex anchored to the absolute offset so the match must
   * start precisely where specified.
   *
   * For regex mode, replacement patterns ($1, $&, $$, $`, $') are expanded from
   * the FULL-context sticky match (so lookbehind/lookahead patterns substitute
   * correctly — never by re-matching the isolated substring, which would drop
   * the surrounding context and silently no-op). For literal mode, replaceText
   * is used as-is.
   *
   * Returns { newRaw, ok: true } on success, { newRaw: rawText, ok: false }
   * when there is no (non-empty) match at that position.
   */
  function applyReplaceAtPosition(rawText, { line, column, query, replaceText, useRegex = false, caseSensitive = false, eol } = {}) {
    if (query === '') return { newRaw: rawText, ok: false };

    const normalized = toLfWithRawOffsets(rawText);
    const lf = normalized.text;
    const eolMode = eol || detectEol(rawText);
    const lineStarts = computeLineStarts(lf);

    if (line < 1 || line > lineStarts.length) {
      return { newRaw: rawText, ok: false };
    }

    const absStart = lineStarts[line - 1] + (column - 1);
    let sticky;
    try {
      const src = useRegex ? query : escapeRegExp(query);
      sticky = new RegExp(src, (caseSensitive ? '' : 'i') + (useRegex ? 'm' : '') + 'y');
    } catch (_error) {
      return { newRaw: rawText, ok: false };
    }
    sticky.lastIndex = absStart;

    const m = sticky.exec(lf);
    if (!m || m.index !== absStart || m[0].length === 0) {
      return { newRaw: rawText, ok: false };
    }

    const expanded = useRegex ? expandReplacement(m, String(replaceText)) : String(replaceText);
    const replacement = restoreEol(toLf(expanded), eolMode);
    const rawStart = normalized.rawOffsets[absStart];
    const rawEnd = normalized.rawOffsets[absStart + m[0].length];
    return {
      newRaw: normalized.source.slice(0, rawStart) + replacement + normalized.source.slice(rawEnd),
      ok: true,
    };
  }

  // Encoded (UTF-8) byte length of scanned content — the unit the replace
  // controller's MAX_REGEX_BYTES budget is declared in (JCA-010). UTF-16
  // .length undercounts non-ASCII; TextEncoder exists in both the Electron
  // renderer and Node tests, so the code-unit fallback is a last resort only.
  const utf8Encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
  function byteLengthUtf8(text) {
    return utf8Encoder ? utf8Encoder.encode(text).length : String(text || '').length;
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                            */
  /* ------------------------------------------------------------------ */

  return {
    toLf,
    byteLengthUtf8,
    detectEol,
    restoreEol,
    escapeRegExp,
    buildFindRegex,
    isPotentiallyUnsafeRegexSource,
    computeRegexPreviewReplacement,
    expandReplacement,
    computeLineStarts,
    locate,
    buildPreviewWindow,
    collectRegexMatchesForFile,
    applyReplaceToText,
    applyReplaceAtPosition,
  };
});
