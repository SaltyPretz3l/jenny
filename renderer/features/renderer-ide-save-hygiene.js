/* renderer/features/renderer-ide-save-hygiene.js - optional format, trim and
 * final-newline transforms before saveFile snapshots the live model. Format
 * targets the editor showing the path; model edits work for any open document.
 * The textarea fallback (no Monaco) is a safe no-op. */
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

    // Stay synchronous without formatting so the save's content/version snapshot
    // precedes later edits: an edit during the write must stay dirty. Formatting
    // returns a promise, then model edits clean up its result before the snapshot.
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
      // Format the showing editor; large files and missing formatters skip it.
      const model = format && !large ? editorHost?.getModel?.(path) || null : null;
      if (format && !large && (!model || typeof editorHost?.formatPath !== 'function')) {
        applyModelEdits(path, opts);
        return { formatStatus: 'unavailable', formatReason: 'formatter_unavailable' };
      }
      if (model && editorHost.showsPath?.(path)) {
        return Promise.resolve()
          .then(() => editorHost.formatPath(path))
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
      // Model edits stay synchronous so the save never yields before its snapshot.
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
