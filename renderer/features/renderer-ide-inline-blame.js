/* renderer/features/renderer-ide-inline-blame.js - row 82 G2 inline blame
 * (docs/plans/IDE_VSCODE_PARITY_2026-10-26.md 6.2): the author, age and summary of
 * the commit that last touched the cursor line, painted after the line's text in the
 * muted text colour, as VS Code's git.blame.editorDecoration does.
 *
 * The gutter module owns the HEAD baseline and supplies headLineFor(path, line):
 * the line's number in HEAD, or null for a line changed since HEAD (a "dirty" line,
 * which shows no blame). After a 300 ms pause on a line the whole file is blamed ONCE
 * per (path, HEAD) through workspaceGit.blameFile (cleanup wave G2); every later
 * cursor move reads that answer through headLineFor, so edits never refetch. Asks for
 * one file share the in-flight request, a file switch aborts it, invalidate() (HEAD
 * moved) drops the cache, and a failed read is not cached. A stale answer (cursor
 * moved, file switched, model edited) never paints. The `inlineBlame` editor
 * preference (default on) gates it; refresh() re-evaluates after a toggle. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeInlineBlame = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  const DEBOUNCE_MS = 300;
  const MAX_SUMMARY_CHARS = 72;
  const MAX_AUTHOR_CHARS = 40;
  const MAX_CACHED_PATHS = 16;
  const DECORATION_CLASS = 'ide-inline-blame';

  function clip(text, max) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }

  function relativeTime(dateISO, nowMs) {
    const history = globalRef.rendererIdeCommitHistory
      || (typeof require === 'function' ? (() => { try { return require('./renderer-ide-commit-history'); } catch (_error) { return null; } })() : null);
    if (history && typeof history.formatRelativeTime === 'function') return history.formatRelativeTime(dateISO, nowMs);
    return String(dateISO || '').slice(0, 10);
  }

  // Pure: the decoration text for one blame line.
  function formatBlameText(entry, nowMs) {
    const author = clip(entry && entry.author, MAX_AUTHOR_CHARS) || jt('ide.inlineBlame.unknownAuthor', 'Unknown author');
    const when = relativeTime(entry && entry.dateISO, nowMs);
    const summary = clip(entry && entry.summary, MAX_SUMMARY_CHARS);
    return summary
      ? jt('ide.inlineBlame.text', '{author}, {when} • {summary}', { author, when, summary })
      : jt('ide.inlineBlame.textNoSummary', '{author}, {when}', { author, when });
  }

  function createIdeInlineBlame(deps) {
    const options = deps || {};
    const editorHost = options.editorHost || null;
    const gitClient = options.gitClient || null;
    const getIde = typeof options.getIde === 'function' ? options.getIde : () => ({});
    const headLineFor = typeof options.headLineFor === 'function' ? options.headLineFor : () => null;
    // The gutter's HEAD lines for a path (an array), so a git refresh that left this file's
    // HEAD text unchanged keeps its answered blame instead of refetching the whole file.
    const headFor = typeof options.headFor === 'function' ? options.headFor : () => null;
    const appendClientLog = typeof options.appendClientLog === 'function' ? options.appendClientLog : noop;
    const nowFn = typeof options.nowFn === 'function' ? options.nowFn : Date.now;
    const debounceMs = Number.isFinite(options.debounceMs) ? Number(options.debounceMs) : DEBOUNCE_MS;
    const setTimeoutFn = typeof options.setTimeoutFn === 'function' ? options.setTimeoutFn : (typeof setTimeout === 'function' ? setTimeout : null);
    const clearTimeoutFn = typeof options.clearTimeoutFn === 'function' ? options.clearTimeoutFn : (typeof clearTimeout === 'function' ? clearTimeout : noop);

    // path -> { controller, head, stale, promise }: the promise resolves to a Map(HEAD line ->
    // blame entry) or null; head is the HEAD text it was asked against; stale after a git refresh.
    const cache = new Map();
    let timer = null;
    let generation = 0;
    let last = null; // the last cursor { path, line }
    let painted = null; // { model, ids, path, line }
    let disposed = false;

    const enabled = () => getIde()?.inlineBlame !== false;
    const versionOf = (path) => (typeof editorHost?.getAltVersionId === 'function' ? editorHost.getAltVersionId(path) : 0);

    function clear() {
      if (!painted) return;
      try { painted.model.deltaDecorations(painted.ids, []); } catch (_error) { /* model disposed */ }
      painted = null;
    }

    function paint(path, line, entry) {
      const model = editorHost?.getModel?.(path) || null;
      if (!model || typeof model.deltaDecorations !== 'function') return;
      if (line < 1 || line > model.getLineCount()) return;
      const column = model.getLineMaxColumn(line);
      const decoration = {
        range: { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column },
        options: {
          description: 'jenny-inline-blame',
          showIfCollapsed: true,
          // The gap before the text is CSS (margin-inline-start in styles/ide-gutter.css).
          after: { content: formatBlameText(entry, nowFn()), inlineClassName: DECORATION_CLASS },
        },
      };
      const previous = painted && painted.model === model ? painted.ids : [];
      if (painted && painted.model !== model) clear();
      painted = { model, ids: model.deltaDecorations(previous, [decoration]), path, line };
    }

    function drop(path) {
      const entry = cache.get(path);
      if (!entry) return;
      cache.delete(path);
      entry.controller?.abort();
    }

    function sameLines(a, b) {
      if (a === b) return true;
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
      return true;
    }

    // The file's blame, fetched once and shared by every ask until HEAD moves for this file:
    // after invalidate() an answered entry is kept when its HEAD text is unchanged.
    function blameOf(path) {
      const cached = cache.get(path);
      if (cached && !cached.stale) return cached.promise;
      const head = headFor(path);
      if (cached && !cached.controller && sameLines(cached.head, head)) {
        cached.stale = false;
        cached.head = head;
        return cached.promise;
      }
      if (cached) drop(path);
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const entry = { controller, head, stale: false, promise: null };
      entry.promise = Promise.resolve(gitClient.blameFile({ path }, { signal: controller?.signal }))
        .catch((error) => {
          appendClientLog('WARN', 'ide.inline_blame_failed', { message: String(error?.message || error || '') });
          return null;
        })
        .then((res) => {
          entry.controller = null;
          if (!res || res.ok !== true) {
            if (cache.get(path) === entry) cache.delete(path);
            return null;
          }
          return new Map((res.found === true && Array.isArray(res.lines) ? res.lines : []).map((hit) => [hit.line, hit]));
        });
      cache.set(path, entry);
      if (cache.size > MAX_CACHED_PATHS) drop(cache.keys().next().value);
      return entry.promise;
    }

    // Leaving a file aborts its unanswered blame (an answered one stays cached).
    function abortOthers(path) {
      for (const [key, entry] of [...cache]) if (key !== path && entry.controller) drop(key);
    }

    function stillCurrent(token, path, line, version) {
      return !disposed && token === generation && last && last.path === path && last.line === line
        && editorHost?.getActivePath?.() === path && versionOf(path) === version && enabled();
    }

    async function update(path, line) {
      const token = generation;
      if (!enabled() || !editorHost || typeof gitClient?.blameFile !== 'function' || editorHost.getActivePath?.() !== path) { clear(); return; }
      if ((editorHost.getDocumentKind && editorHost.getDocumentKind(path) !== 'file') || editorHost.isLargeFile?.(path) === true) { clear(); return; }
      const headLine = headLineFor(path, line);
      if (!Number.isInteger(headLine) || headLine < 1) { clear(); return; }
      const version = versionOf(path);
      const byLine = await blameOf(path);
      if (!stillCurrent(token, path, line, version)) return;
      const hit = byLine ? byLine.get(headLine) || null : null;
      if (hit) paint(path, line, hit); else clear();
    }

    function schedule() {
      if (disposed || !setTimeoutFn || !last) return;
      if (timer) clearTimeoutFn(timer);
      generation += 1;
      const { path, line } = last;
      timer = setTimeoutFn(() => { timer = null; void update(path, line); }, debounceMs);
    }

    function handleCursor(path, line) {
      const norm = String(path || '');
      const lineNumber = Math.floor(Number(line));
      if (!norm || !Number.isInteger(lineNumber) || lineNumber < 1) return;
      if (painted && (painted.path !== norm || painted.line !== lineNumber)) clear();
      abortOthers(norm);
      last = { path: norm, line: lineNumber };
      if (!enabled()) { clear(); return; }
      schedule();
    }

    // Re-evaluate the last cursor now that the preference (or the baseline) changed.
    function refresh() {
      if (!enabled()) { generation += 1; clear(); return; }
      schedule();
    }

    // A git refresh (HEAD may have moved): an unanswered blame is dropped, an answered one
    // is re-validated against the file's HEAD text on its next ask.
    function invalidate() {
      for (const [key, entry] of [...cache]) {
        if (entry.controller) drop(key); else entry.stale = true;
      }
      refresh();
    }

    return {
      handleCursor,
      refresh,
      invalidate,
      clear,
      dispose() {
        disposed = true;
        generation += 1;
        if (timer) clearTimeoutFn(timer);
        timer = null;
        clear();
        for (const key of [...cache.keys()]) drop(key);
        last = null;
      },
    };
  }

  return { createIdeInlineBlame, formatBlameText, DECORATION_CLASS };
});
