/* renderer/features/renderer-ide-bookmarks.js
 *
 * Runtime line bookmarks for the Workspace IDE. Toggle a bookmark on a line,
 * jump next/previous within the active file, or list all bookmarks. State is
 * session-only and pruned when a file is closed or renamed.
 *
 * State is a Map<path, Set<lineNumber>>; the glyph is a Monaco model decoration
 * applied through the editor host on a SEPARATE decoration-id array from the git
 * change-bars (doc.bookmarkDecorationIds vs doc.gutterDecorationIds) so the two
 * gutter lanes never clobber each other. The pure state/row helpers never touch
 * Monaco and are exercised by unit tests; the Quick-pick chrome comes from the
 * shared renderer-ide-picker-overlay (this only supplies the data + row shape).
 *
 * Re-applies decorations on file switch by self-subscribing to
 * ide:active-file-changed (the gutter / symbol-nav pattern - no controller wire
 * for activation); the controller only creates the instance, feeds pruneClosed
 * from renderTabs, and routes the keybindings/palette/glyph-click toggles. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeBookmarks = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  // The glyph-margin class (styles/ide-gutter.css). Palette-driven, CSP-safe
  // (clip-path shape, no data URI / font), and its own decoration-id array.
  const BOOKMARK_GLYPH_CLASS = 'ide-bookmark-glyph';
  // Snippet shown in the Quick-pick row, trimmed + bounded so a long line never
  // blows out the picker width.
  const MAX_SNIPPET = 120;
  // Bookmarks are deliberate user-authored markers (unlike nav-history's
  // incidental breadcrumbs), so at the cap we REJECT the new mark and log
  // rather than silently evicting one of the user's existing markers.
  const MAX_MARKS_PER_FILE = 200;
  const MAX_MARKS_TOTAL = 1000;

  function basenameOf(path) {
    const norm = String(path || '').replace(/\\/g, '/');
    const tail = norm.split('/').pop();
    return tail || norm;
  }

  function createIdeBookmarks(deps) {
    const options = deps || {};
    const editorHost = options.editorHost || null;
    const getDom = typeof options.getDom === 'function' ? options.getDom : () => ({});
    const windowRef = options.windowRef || globalRef.window || globalRef;
    const openFile = typeof options.openFile === 'function'
      ? options.openFile
      : () => Promise.resolve(false);
    const escapeHtml = typeof options.escapeHtml === 'function'
      ? options.escapeHtml
      : (value) => String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const appendClientLog = typeof options.appendClientLog === 'function'
      ? options.appendClientLog
      : function noop() {};
    const pickerOverlayUtils = options.pickerOverlayUtils
      || globalRef.rendererIdePickerOverlay
      || (typeof require === 'function' ? (() => {
        try { return require('./renderer-ide-picker-overlay'); } catch (_error) { return {}; }
      })() : {});

    // path -> Set<lineNumber>. Empty sets are dropped so listRows / pruning stay
    // tidy and applyDecorations clears the gutter when the last mark is removed.
    const marks = new Map();
    // O(1) mirror of the total mark count across all files, so the total-cap
    // check in toggle() never has to sum every file's Set size.
    let totalMarks = 0;
    let disposed = false;

    function activePath() {
      return editorHost && typeof editorHost.getActivePath === 'function'
        ? String(editorHost.getActivePath() || '')
        : '';
    }

    function activeLine() {
      const info = editorHost && typeof editorHost.getCursorInfo === 'function'
        ? editorHost.getCursorInfo()
        : null;
      return info && Number(info.lineNumber) >= 1 ? Number(info.lineNumber) : 0;
    }

    function sortedLines(path) {
      const set = marks.get(String(path || ''));
      return set ? [...set].sort((a, b) => a - b) : [];
    }

    // State -> the active file's model decorations (glyph-margin lane), applied
    // through the host's bookmark-only delta path. No-op without the host method.
    function applyDecorations(path) {
      const norm = String(path || '');
      if (!norm || !editorHost || typeof editorHost.setBookmarkDecorations !== 'function') {
        return;
      }
      const decorations = sortedLines(norm).map((line) => ({
        range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
        options: {
          isWholeLine: false,
          glyphMarginClassName: BOOKMARK_GLYPH_CLASS,
          description: 'jenny-bookmark',
        },
      }));
      editorHost.setBookmarkDecorations(norm, decorations);
    }

    // Add/remove a bookmark on (path, line); returns true when it was ADDED,
    // false when it was removed (or rejected for a bad line). Re-paints the
    // file's glyph gutter from the resulting state.
    function toggle(path, line) {
      const norm = String(path || '');
      const lineNumber = Number(line);
      if (!norm || !(lineNumber >= 1)) {
        return false;
      }
      const target = Math.floor(lineNumber);
      let set = marks.get(norm);
      let added;
      if (set && set.has(target)) {
        set.delete(target);
        added = false;
        totalMarks -= 1;
        if (!set.size) {
          marks.delete(norm);
        }
      } else {
        // Reject-at-cap, never evict: bookmarks are deliberate user markers,
        // so a full file/total just refuses the new one (see MAX_MARKS_* above).
        const perFileCount = set ? set.size : 0;
        if (perFileCount >= MAX_MARKS_PER_FILE || totalMarks >= MAX_MARKS_TOTAL) {
          appendClientLog('WARN', 'ide.bookmark_limit_reached', {
            path: norm,
            line: target,
            perFileCount,
            totalCount: totalMarks,
            cap: perFileCount >= MAX_MARKS_PER_FILE ? 'per_file' : 'total',
          });
          return false;
        }
        if (!set) {
          set = new Set();
          marks.set(norm, set);
        }
        set.add(target);
        totalMarks += 1;
        added = true;
      }
      applyDecorations(norm);
      return added;
    }

    // Walk the active file's bookmarks relative to the caret (wrap-around). next
    // = first mark strictly after the caret (else the first); prev = last mark
    // strictly before (else the last). Reveal stays in-file (already active).
    function jumpInActive(direction) {
      const path = activePath();
      const lines = sortedLines(path);
      if (!path || !lines.length) {
        return false;
      }
      const cursor = activeLine();
      // lines is ascending-sorted: next = first mark after the caret (wrap to the
      // first); prev = last mark before it (wrap to the last).
      const target = direction > 0
        ? (lines.find((line) => line > cursor) ?? lines[0])
        : (lines.filter((line) => line < cursor).pop() ?? lines[lines.length - 1]);
      if (editorHost && typeof editorHost.revealPosition === 'function') {
        editorHost.revealPosition(path, target, 1);
      }
      return true;
    }

    function next() {
      return jumpInActive(1);
    }

    function prev() {
      return jumpInActive(-1);
    }

    // Every bookmark across all files as Quick-pick rows: file basename + line +
    // a trimmed snippet of the line text (read live from the open model). Sorted
    // by basename then line so the picker order is stable.
    function listRows() {
      const rows = [];
      for (const path of marks.keys()) {
        const value = editorHost && typeof editorHost.getValue === 'function'
          ? editorHost.getValue(path)
          : '';
        const textLines = String(value == null ? '' : value).split('\n');
        sortedLines(path).forEach((line) => {
          const snippet = (textLines[line - 1] || '').trim().slice(0, MAX_SNIPPET);
          rows.push({ path, line, basename: basenameOf(path), snippet });
        });
      }
      rows.sort((a, b) => a.basename.localeCompare(b.basename) || a.line - b.line);
      return rows;
    }

    function matchRows(query) {
      const rows = listRows();
      const needle = String(query || '').trim().toLowerCase();
      if (!needle) {
        return rows;
      }
      return rows.filter((row) => `${row.basename}:${row.line} ${row.snippet}`
        .toLowerCase().includes(needle));
    }

    async function jumpTo(path, line) {
      const norm = String(path || '');
      if (!norm) {
        return;
      }
      try {
        await openFile(norm);
      } catch (error) {
        appendClientLog('WARN', 'ide.bookmark_open_failed', { message: String((error && error.message) || error || '') });
      }
      if (editorHost && typeof editorHost.revealPosition === 'function') {
        editorHost.revealPosition(norm, Math.max(1, Number(line) || 1), 1);
      }
    }

    function buildRowMarkup(row, index, selected) {
      const label = `${row.basename}:${row.line}`;
      const detail = row.snippet || '(empty line)';
      return `<div class="ide-picker-row ide-bookmark-row${selected ? ' ide-picker-row--selected ide-bookmark-row--selected' : ''}"`
        + ` role="option" aria-selected="${selected ? 'true' : 'false'}"`
        + ` data-ide-bookmark-path="${escapeHtml(row.path)}"`
        + ` data-ide-bookmark-line="${escapeHtml(String(row.line))}"`
        + ` title="${escapeHtml(`${row.path}:${row.line}`)}">`
        + `<span class="ide-picker-name ide-bookmark-name">${escapeHtml(label)}</span>`
        + `<span class="ide-picker-path ide-bookmark-detail">${escapeHtml(detail)}</span>`
        + '</div>';
    }

    function status(text) {
      return `<div class="ide-picker-status ide-bookmark-status">${escapeHtml(text)}</div>`;
    }

    // The "List all bookmarks" overlay: chrome + keyboard nav come from the
    // shared picker factory; this supplies only the in-memory rows + row shape.
    const picker = pickerOverlayUtils.createIdePickerOverlay
      ? pickerOverlayUtils.createIdePickerOverlay({
        getDom,
        overlayClass: 'ide-bookmark-open',
        panelClass: 'ide-bookmark-open-panel',
        fieldClass: 'ide-bookmark-open-field',
        resultsClass: 'ide-bookmark-open-results',
        inputId: 'ideBookmarkOpenInput',
        placeholder: 'Go to bookmark…',
        ariaLabel: 'Go to bookmark',
        resultsAriaLabel: 'Bookmarks',
        inputDataset: { 'ide-bookmark-open-input': '1' },
        inputSelector: '[data-ide-bookmark-open-input]',
        rowSelector: '[data-ide-bookmark-path]',
        callbacks: {
          computeMatches: (query) => matchRows(query),
          buildRowMarkup,
          isLoading: () => false,
          renderEmptyStatus: (query) => status(query
            ? 'No bookmarks match.'
            : 'No bookmarks yet. Press Ctrl+Alt+K on a line to add one.'),
          onSubmit: (row, { close }) => {
            close();
            if (row) {
              jumpTo(row.path, row.line);
            }
          },
          onRowClick: (rowEl, { close }) => {
            close();
            jumpTo(
              rowEl.dataset.ideBookmarkPath || '',
              Number(rowEl.dataset.ideBookmarkLine) || 1
            );
          },
          onClosed: () => {
            if (editorHost && typeof editorHost.focus === 'function') {
              editorHost.focus();
            }
          },
        },
      })
      : null;

    function openList() {
      return picker ? picker.open() : false;
    }

    // Drop bookmarks for files no longer open (close / rename) so the gutter and
    // the picker never reference a dead path. Fed from renderTabs on tab close.
    function pruneClosed(openPaths) {
      if (!marks.size) {
        return;
      }
      const open = openPaths instanceof Set
        ? openPaths
        : new Set((openPaths || []).map((value) => String(value || '')));
      for (const path of [...marks.keys()]) {
        if (!open.has(path)) {
          totalMarks -= marks.get(path).size;
          marks.delete(path);
        }
      }
    }

    // Re-paint the now-active file's glyphs on every file switch (the decoration
    // lives on the model and survives backgrounding, but re-applying keeps state
    // the single source of truth and is robust to model recreation).
    function handleActiveFileChanged(event) {
      if (disposed) {
        return;
      }
      const detailPath = event && event.detail && event.detail.path;
      applyDecorations(detailPath || activePath());
    }

    if (windowRef && typeof windowRef.addEventListener === 'function') {
      windowRef.addEventListener('ide:active-file-changed', handleActiveFileChanged);
    }

    function dispose() {
      disposed = true;
      if (windowRef && typeof windowRef.removeEventListener === 'function') {
        windowRef.removeEventListener('ide:active-file-changed', handleActiveFileChanged);
      }
      picker?.dispose();
      marks.clear();
      totalMarks = 0;
    }

    return {
      toggle,
      next,
      prev,
      openList,
      listRows,
      applyDecorations,
      pruneClosed,
      dispose,
    };
  }

  return {
    createIdeBookmarks,
    basenameOf,
    BOOKMARK_GLYPH_CLASS,
    MAX_MARKS_PER_FILE,
    MAX_MARKS_TOTAL,
  };
});
