/* renderer/features/renderer-ide-save-hygiene.js - save-time text hygiene for
 * the Workspace IDE: format-on-save, trim-trailing-whitespace, and
 * insert-final-newline, each an independently-gated per-user preference. The
 * file lifecycle calls applySaveHygiene(path) at the top of saveFile (after the
 * `saving` guard is set, before the buffer snapshot) so the transforms land on
 * the live Monaco model and the subsequent getValue()/write sees the cleaned
 * text — keeping the saved file and the editor buffer in sync. Format only
 * applies to the active editor (the Monaco action targets the focused editor);
 * trim + final-newline are surgical model edits that work for any open doc and
 * are computed by the pure helpers below (exported for unit tests). On the
 * textarea fallback (no Monaco) the module is a safe no-op. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeSaveHygiene = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  function resolveAsyncFence() {
    if (globalRef.rendererAsyncFence) {
      return globalRef.rendererAsyncFence;
    }
    if (typeof require === 'function') {
      return require('../shared/async-fence');
    }
    return {};
  }

  function rangeOf(startLine, startCol, endLine, endCol) {
    return {
      startLineNumber: startLine,
      startColumn: startCol,
      endLineNumber: endLine,
      endColumn: endCol,
    };
  }

  // One zero-length-replacement edit per line that has trailing spaces/tabs,
  // deleting just the run of trailing whitespace. Empty when the model is clean.
  function computeTrimEdits(model) {
    const edits = [];
    const lineCount = model.getLineCount();
    for (let line = 1; line <= lineCount; line += 1) {
      const text = model.getLineContent(line);
      const trimmed = text.replace(/[ \t]+$/, '');
      if (trimmed.length !== text.length) {
        edits.push({ range: rangeOf(line, trimmed.length + 1, line, text.length + 1), text: '' });
      }
    }
    return edits;
  }

  // A single insert at the very end when the file does not already end with a
  // newline (a Monaco model with a trailing newline reports an empty last line).
  // Returns null when no edit is needed.
  function computeFinalNewlineEdit(model) {
    const lineCount = model.getLineCount();
    const lastLine = model.getLineContent(lineCount);
    if (lastLine.length === 0) {
      return null;
    }
    const eol = typeof model.getEOL === 'function' ? model.getEOL() : '\n';
    return { range: rangeOf(lineCount, lastLine.length + 1, lineCount, lastLine.length + 1), text: eol };
  }

  function createIdeSaveHygiene(deps) {
    const editorHost = deps?.editorHost || null;
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const appendClientLog = typeof deps?.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const fence = resolveAsyncFence().createDisposalFence();

    // The surgical trim + final-newline model edits (trim first, then final
    // newline off the trimmed model, so a last line with both trailing whitespace
    // and no newline can never produce overlapping edit ranges).
    function applyModelEdits(path, { trim, finalNewline, large }) {
      const model = editorHost?.getModel?.(path) || null;
      if (!model || typeof model.pushEditOperations !== 'function') {
        return; // textarea fallback (no Monaco): nothing to mutate
      }
      if (trim && !large) {
        const edits = computeTrimEdits(model);
        if (edits.length) {
          model.pushEditOperations([], edits, () => null);
        }
      }
      if (finalNewline) {
        const edit = computeFinalNewlineEdit(model);
        if (edit) {
          model.pushEditOperations([], [edit], () => null);
        }
      }
    }

    // Runs the enabled transforms against the doc's live model BEFORE the save
    // snapshots its value. CRITICAL: this stays SYNCHRONOUS (returns a result)
    // whenever format-on-save is not running, so the caller's content/version
    // snapshot is captured synchronously relative to subsequent edits — preserving
    // the "an edit that lands mid-write stays dirty" data-safety guarantee. Only
    // format-on-save is async (Monaco's formatter resolves later); when it runs we
    // return its promise (format first, then the model edits clean up the result)
    // and the caller awaits it.
    function applySaveHygiene(path) {
      const ide = getIde() || {};
      const format = ide.formatOnSave === true;
      const trim = ide.trimTrailingWhitespace === true;
      const finalNewline = ide.insertFinalNewline === true;
      if (!format && !trim && !finalNewline) {
        return { formatStatus: 'disabled', formatReason: '' };
      }
      const large = editorHost?.isLargeFile?.(path) === true;
      const opts = { trim, finalNewline, large };
      // Format-on-save: only the focused editor can be formatted, skipped on very
      // large files; a language with no registered formatter is a quiet no-op.
      if (format && !large && editorHost?.getActivePath?.() === path) {
        const model = editorHost?.getModel?.(path) || null;
        if (!model || typeof editorHost?.formatActive !== 'function') {
          applyModelEdits(path, opts);
          return { formatStatus: 'unavailable', formatReason: 'formatter_unavailable' };
        }
        return Promise.resolve()
          .then(() => editorHost.formatActive())
          .then((result) => ({
            formatStatus: result?.supported === false ? 'unavailable' : 'formatted',
            formatReason: result?.supported === false ? 'formatter_unavailable' : '',
          }))
          .catch((error) => {
            appendClientLog('WARN', 'ide.format_on_save_failed', {
              message: String(error?.message || error || ''),
            });
            return { formatStatus: 'failed', formatReason: 'formatter_failed' };
          })
          .then((outcome) => {
            if (!fence.isDisposed() && editorHost.getModel(path) === model) {
              applyModelEdits(path, opts);
            }
            return outcome;
          });
      }
      // No async format -> apply the model edits synchronously and return
      // undefined so the save path never yields before its snapshot.
      applyModelEdits(path, opts);
      return {
        formatStatus: format ? 'skipped' : 'disabled',
        formatReason: format ? (large ? 'large_file' : 'inactive_file') : '',
      };
    }

    return {
      applySaveHygiene,
      dispose: fence.dispose,
    };
  }

  return {
    computeTrimEdits,
    computeFinalNewlineEdit,
    createIdeSaveHygiene,
  };
});
