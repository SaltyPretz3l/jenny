/* renderer/features/renderer-ide-replace-controller.js - orchestration, state,
 * and file-I/O layer for the Workspace IDE find-and-replace feature.
 *
 * This module owns NO DOM markup. It drives the regex find (across all
 * workspace files), computes preview "after" text, and performs the actual
 * replacements (single match / whole file / all results) with byte-exact,
 * EOL-preserving writes and a single-level undo. All pure text logic is
 * delegated to renderer-ide-replace-text-utils; all rendering is delegated to
 * injected callbacks (renderSearchPanel / renderTabs / requestFindRefresh).
 *
 * Find/replace state lives on the runtime ide.search slice (never persisted),
 * extending the { query, results, busy } shape the search panel renders with
 * replace-specific fields (replaceText, caseSensitive, useRegex, replacing,
 * replaceSummary, replaceError, lastReplace, canUndo).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeReplaceController = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) {
      return globalRef[globalName];
    }
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return {};
  }

  const textUtils = resolveModule('rendererIdeReplaceTextUtils', './renderer-ide-replace-text-utils');
  const journalUtils = resolveModule('rendererIdeReplaceJournal', './renderer-ide-replace-journal');
  let regexClientModulePromise = null;

  async function loadRegexClientModule() {
    const resolved = resolveModule(
      'rendererIdeRegexWorkerClient',
      './renderer-ide-regex-worker-client'
    );
    if (typeof resolved.createRegexWorkerEvaluator === 'function') return resolved;
    if (!regexClientModulePromise) {
      regexClientModulePromise = import('./renderer-ide-regex-worker-client.js').then(() => (
        globalRef.rendererIdeRegexWorkerClient || {}
      ));
    }
    return regexClientModulePromise;
  }

  // Cap regex find work so a runaway pattern over a large tree cannot stall the
  // renderer: at most this many match rows, and at most this many bytes read.
  const MAX_REGEX_RESULTS = 500;
  const MAX_REGEX_BYTES = 8 * 1024 * 1024;
  const MAX_REGEX_FILES = 2_000;
  const MAX_REGEX_DURATION_MS = 2_000;
  const REGEX_FIND_DEADLINE_MS = 750;
  const REGEX_REPLACE_DEADLINE_MS = 1_500;

  // Extensions we never attempt to scan/replace — treated as binary and
  // skipped (returns null content). Keeps the regex find off image/font/binary
  // blobs that would never contain meaningful text matches.
  const BINARY_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf', 'zip', 'gz', 'exe',
    'dll', 'wasm', 'woff', 'woff2', 'ttf', 'otf', 'mp4', 'mp3', 'wav',
  ]);

  function unique(arr) {
    return [...new Set(arr)];
  }

  const byteLengthOf = (text) => (typeof textUtils.byteLengthUtf8 === 'function' ? textUtils.byteLengthUtf8(text) : String(text || '').length); // JCA-010: MAX_REGEX_BYTES is declared in encoded bytes; canonical counter in text-utils

  function extensionOf(path) {
    const name = String(path || '');
    const dot = name.lastIndexOf('.');
    if (dot === -1 || dot === name.length - 1) {
      return '';
    }
    return name.slice(dot + 1).toLowerCase();
  }

  function createIdeReplaceController(deps) {
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const getWorkspaceFsApi = typeof deps?.getWorkspaceFsApi === 'function'
      ? deps.getWorkspaceFsApi
      : () => null;
    const editorHost = deps?.editorHost || null;
    const getFileOperations = typeof deps?.getFileOperations === 'function'
      ? deps.getFileOperations : () => null;
    const callbacks = deps?.callbacks || {};
    const appendClientLog = typeof callbacks.appendClientLog === 'function' ? callbacks.appendClientLog : noop;
    const renderSearchPanel = typeof callbacks.renderSearchPanel === 'function' ? callbacks.renderSearchPanel : noop;
    const requestFindRefresh = typeof callbacks.requestFindRefresh === 'function' ? callbacks.requestFindRefresh : noop;
    const renderTabs = typeof callbacks.renderTabs === 'function' ? callbacks.renderTabs : noop;
    const isSaving = typeof callbacks.isSaving === 'function' ? callbacks.isSaving : noop;
    const replaceJournal = journalUtils.createIdeReplaceJournal?.({
      getIde, schedulePersist: callbacks.schedulePersist, flushPersist: callbacks.flushPersist, appendClientLog,
      showToast: callbacks.showShellErrorToast,
    }) || { open: noop, markApplied: noop, close: noop, checkRecovery: noop };
    const now = typeof deps?.now === 'function' ? deps.now : () => Date.now();
    const loadRegexClient = typeof deps?.loadRegexClientModule === 'function'
      ? deps.loadRegexClientModule
      : loadRegexClientModule;
    let regexFindEvaluator = deps?.regexFindEvaluator || null;
    let regexReplaceEvaluator = deps?.regexReplaceEvaluator || null;

    async function getRegexEvaluator(kind) {
      if (disposed) {
        const error = new Error('Regex evaluation was cancelled.');
        error.code = 'REGEX_CANCELLED';
        throw error;
      }
      const current = kind === 'find' ? regexFindEvaluator : regexReplaceEvaluator;
      if (current && typeof current.evaluate === 'function') return current;
      const clientModule = await loadRegexClient();
      if (disposed) {
        const error = new Error('Regex evaluation was cancelled.');
        error.code = 'REGEX_CANCELLED';
        throw error;
      }
      const loadedWhileWaiting = kind === 'find' ? regexFindEvaluator : regexReplaceEvaluator;
      if (loadedWhileWaiting && typeof loadedWhileWaiting.evaluate === 'function') {
        return loadedWhileWaiting;
      }
      if (typeof clientModule.createRegexWorkerEvaluator !== 'function') {
        const error = new Error('Regex worker is unavailable.');
        error.code = 'REGEX_UNAVAILABLE';
        throw error;
      }
      const created = clientModule.createRegexWorkerEvaluator();
      if (kind === 'find') regexFindEvaluator = created;
      else regexReplaceEvaluator = created;
      return created;
    }

    // Monotonic find sequence: stale awaits compare seq !== findSeq and bail so
    // a slow listing/read from an old query never clobbers newer results.
    let findSeq = 0;
    // Module-local mirror of s.replacing so isReplacing() is a cheap field read
    // and re-entrant apply calls can be rejected without touching the slice.
    let replacingFlag = false;
    // Reusable root epoch for write-producing operations. Unlike `disposed`, a
    // root reset invalidates only work already in flight; the controller remains
    // usable for the newly committed root.
    let applyEpoch = 1;
    let findAbortController = null;
    let applyAbortController = null;
    // Set once the owning search panel is torn down: makes any in-flight
    // replace/undo loop stop writing further files at its next iteration.
    let disposed = false;
    let noBridgeToastShown = false;

    /* ------------------------------------------------------------------ */
    /* State helpers                                                         */
    /* ------------------------------------------------------------------ */

    function getReplaceState() {
      const ide = getIde();
      if (!ide.search || typeof ide.search !== 'object') {
        ide.search = { query: '', results: [], busy: false };
      }
      const s = ide.search;
      if (s.replaceText === undefined) s.replaceText = '';
      if (s.caseSensitive === undefined) s.caseSensitive = false;
      if (s.useRegex === undefined) s.useRegex = false;
      if (s.replacing === undefined) s.replacing = false;
      if (s.replaceSummary === undefined) s.replaceSummary = '';
      if (s.replaceError === undefined) s.replaceError = '';
      if (s.lastReplace === undefined) s.lastReplace = null;
      return s;
    }

    function isReplacing() {
      return replacingFlag;
    }

    function cancelFindEvaluation() {
      findAbortController?.abort();
      findAbortController = null;
      regexFindEvaluator?.cancel?.();
    }

    function cancelApplyEvaluation() {
      applyAbortController?.abort();
      applyAbortController = null;
      regexReplaceEvaluator?.cancel?.();
    }

    // Bumps the find sequence so any in-flight runRegexFind is invalidated
    // before it can write stale results back to the slice. The panel calls this
    // on EVERY new search (literal or regex) so a mode switch mid-find can't let
    // an old regex scan clobber newer results — runRegexFind guards on findSeq.
    function invalidateFind() {
      findSeq += 1;
      cancelFindEvaluation();
    }

    // Called by the owning search panel's dispose(): cancels any in-flight
    // replaceAll/undoLastReplace loop at its next iteration and invalidates any
    // in-flight regex find, so a torn-down panel can never write another file.
    function dispose() {
      disposed = true;
      findSeq += 1;
      applyEpoch += 1;
      cancelFindEvaluation();
      cancelApplyEvaluation();
      regexFindEvaluator?.dispose?.();
      regexReplaceEvaluator?.dispose?.();
      replacingFlag = false;
    }

    // Resolve the replace options from explicit opts, falling back to the slice
    // for any field the caller did not supply.
    function resolveOpts(opts) {
      const s = getReplaceState();
      const o = opts || {};
      return {
        query: o.query !== undefined ? String(o.query) : String(s.ranQuery ?? s.query ?? ''),
        replaceText: o.replaceText !== undefined ? String(o.replaceText) : String(s.replaceText ?? ''),
        useRegex: o.useRegex !== undefined ? !!o.useRegex : !!s.useRegex,
        caseSensitive: o.caseSensitive !== undefined ? !!o.caseSensitive : !!s.caseSensitive,
      };
    }

    /* ------------------------------------------------------------------ */
    /* Regex find                                                           */
    /* ------------------------------------------------------------------ */

    // Read a file's text for the find scan: prefer the live (possibly unsaved)
    // editor buffer when the file is open, else read from disk. Binary
    // extensions and read failures return null (caller skips them).
    async function getFileContentForScan(path, api) {
      if (BINARY_EXTENSIONS.has(extensionOf(path))) {
        return null;
      }
      if (editorHost?.hasDocument?.(path) && editorHost.getDocumentKind?.(path) === 'file') {
        return editorHost.getValue?.(path);
      }
      try {
        const operations = getFileOperations();
        return operations
          ? (await operations.readForMutation(path))?.content ?? null
          : (await api.readFile({ path }))?.content ?? null;
      } catch (_error) {
        return null;
      }
    }

    async function runRegexFind({ query, caseSensitive, scope } = {}) {
      const s = getReplaceState();
      const q = String(query || '');
      if (q === '') {
        s.results = []; s.error = ''; s.fileCount = 0; s.limitHit = false; s.ranQuery = ''; s.busy = false;
        renderSearchPanel();
        return { results: [], fileCount: 0, limitHit: false };
      }

      try {
        textUtils.buildFindRegex(q, { caseSensitive, multiline: true, global: true });
      } catch (_error) {
        s.results = [];
        s.busy = false;
        s.error = 'Invalid regular expression';
        renderSearchPanel();
        return { results: [], fileCount: 0, limitHit: false };
      }

      const api = getWorkspaceFsApi();
      if (!api?.listAllFiles || (!getFileOperations() && !api?.readFile)) {
        s.error = 'Workspace search is unavailable in this shell mode.';
        renderSearchPanel();
        return { results: [], fileCount: 0, limitHit: false };
      }

      cancelFindEvaluation();
      const seq = ++findSeq;
      const abortController = new AbortController();
      findAbortController = abortController;
      s.busy = true;
      s.error = '';
      renderSearchPanel();

      try {
        const listing = await api.listAllFiles();
        if (seq !== findSeq) return { results: [], fileCount: 0, limitHit: false };
        const allFiles = listing?.files || [];
        // Find-in-Folder scope: keep only paths under the scoped dir. listAllFiles
        // returns forward-slash, root-relative paths. Strip any trailing slash first
        // so a scope like 'src/' matches the backend's literal filter (searchWorkspaceFiles
        // strips identically); the exact-or-prefix compare then needs no other
        // normalization. Empty scope = whole workspace.
        const scopeDir = String(scope || '').replace(/\/+$/, '');
        const files = scopeDir ? allFiles.filter((f) => f === scopeDir || f.startsWith(`${scopeDir}/`)) : allFiles;
        const results = [];
        const matched = new Set();
        let bytes = 0;
        let limitHit = listing?.truncated === true;
        let filesEvaluated = 0;
        let partialReason = '';
        const startedAt = now();

        for (const file of files) {
          if (results.length >= MAX_REGEX_RESULTS || bytes >= MAX_REGEX_BYTES
            || filesEvaluated >= MAX_REGEX_FILES) {
            limitHit = true;
            partialReason = 'regex_budget';
            break;
          }
          if (now() - startedAt >= MAX_REGEX_DURATION_MS) {
            limitHit = true;
            partialReason = 'regex_budget';
            break;
          }
          const content = await getFileContentForScan(file, api);
          if (seq !== findSeq) return { results: [], fileCount: 0, limitHit: false };
          if (content === null) continue;
          // Refuse a file whose UTF-8 size would exceed the remaining budget before sending it to the regex worker.
          const contentBytes = byteLengthOf(content);
          if (bytes + contentBytes > MAX_REGEX_BYTES) { limitHit = true; partialReason = 'regex_budget'; break; }
          bytes += contentBytes;
          let evaluated;
          try {
            const evaluator = await getRegexEvaluator('find');
            evaluated = await evaluator.evaluate({
              op: 'find',
              path: file,
              text: content,
              query: q,
              caseSensitive: caseSensitive === true,
              maxResults: MAX_REGEX_RESULTS - results.length,
            }, {
              signal: abortController.signal,
              deadlineMs: REGEX_FIND_DEADLINE_MS,
            });
          } catch (error) {
            if (seq !== findSeq || error?.code === 'REGEX_CANCELLED') {
              return { results: [], fileCount: 0, limitHit: false };
            }
            partialReason = error?.code === 'REGEX_TIMEOUT'
              ? 'regex_timeout'
              : 'regex_unavailable';
            s.error = partialReason === 'regex_timeout'
              ? 'Regular expression timed out; partial results shown.'
              : 'Regex evaluation is unavailable.';
            limitHit = true;
            appendClientLog('WARN', 'ide.replace_regex_evaluation_failed', {
              reason: String(error?.code || 'REGEX_EVALUATION_FAILED').slice(0, 64),
            });
            break;
          }
          filesEvaluated += 1;
          const fileResults = Array.isArray(evaluated?.results) ? evaluated.results : [];
          results.push(...fileResults.slice(0, MAX_REGEX_RESULTS - results.length));
          if (evaluated?.matched === true || fileResults.length > 0) matched.add(file);
          if (evaluated?.limitHit === true || results.length >= MAX_REGEX_RESULTS) {
            limitHit = true;
            partialReason = 'regex_budget';
          }
        }

        if (seq !== findSeq) return { results: [], fileCount: 0, limitHit: false };
        s.results = results;
        s.fileCount = matched.size;
        s.limitHit = limitHit || results.length >= MAX_REGEX_RESULTS;
        s.ranQuery = q;
        if (!partialReason) s.error = '';
        return {
          results: s.results,
          fileCount: s.fileCount,
          limitHit: s.limitHit,
          partial: partialReason !== '',
          reason: partialReason || undefined,
        };
      } catch (err) {
        if (seq !== findSeq) return { results: [], fileCount: 0, limitHit: false };
        s.results = [];
        s.error = 'Search failed.';
        appendClientLog('WARN', 'ide.replace_find_failed', {
          message: String(err?.message || err || ''),
        });
        return { results: [], fileCount: 0, limitHit: false };
      } finally {
        if (findAbortController === abortController) findAbortController = null;
        if (seq === findSeq) {
          s.busy = false;
          renderSearchPanel();
        }
      }
    }

    /* ------------------------------------------------------------------ */
    /* Preview "after" text                                                 */
    /* ------------------------------------------------------------------ */

    function resetForRoot() {
      findSeq += 1;
      applyEpoch += 1;
      cancelFindEvaluation();
      cancelApplyEvaluation();
      replacingFlag = false;
      const s = getReplaceState();
      s.replacing = false;
      s.replaceSummary = '';
      s.replaceError = '';
      s.lastReplace = null;
      s.canUndo = false;
      s.results = [];
      s.busy = false;
      s.error = '';
    }

    // Compute the replacement text for a single match's preview window so the
    // panel can show a before/after diff. Literal mode returns replaceText
    // verbatim; regex mode honours native replacement patterns ($1, $&, ...).
    function computeReplacementForMatch(match, { query, replaceText, useRegex, caseSensitive } = {}) {
      if (!useRegex) return String(replaceText || '');
      return textUtils.computeRegexPreviewReplacement(match, {
        query,
        replaceText,
        caseSensitive,
      });
    }

    /* ------------------------------------------------------------------ */
    /* Read / write helpers                                                  */
    /* ------------------------------------------------------------------ */

    // Read the current raw bytes for a path plus its EOL style and mtime.
    // Prefers the live editor buffer when the file is open (so replaces apply
    // to unsaved edits); else reads from disk. May throw if the file vanished
    // — callers catch.
    async function readFileForReplace(path) {
      const operations = getFileOperations();
      if (editorHost?.hasDocument?.(path) && editorHost.getDocumentKind?.(path) === 'file') {
        const raw = editorHost.getValue?.(path);
        const snapshot = operations?.captureSave(path, {
          content: raw,
          savedVersionId: editorHost.getAltVersionId?.(path),
        });
        if (operations && !snapshot) throw new Error('The open document is no longer current.');
        return {
          raw,
          eol: textUtils.detectEol(raw),
          mtime: editorHost.getMtime?.(path),
          open: true,
          snapshot,
        };
      }
      const api = getWorkspaceFsApi();
      const p = operations ? await operations.readForMutation(path) : await api.readFile({ path });
      const raw = p?.content;
      return {
        // Sniff EOL from content, NOT the payload's eol field — the test
        // harness stub always reports 'lf' even for CRLF buffers.
        raw,
        eol: textUtils.detectEol(raw),
        mtime: p?.mtimeMs,
        open: false,
        snapshot: operations ? p : null,
      };
    }

    // Write new bytes back to disk with optimistic mtime concurrency. Maps the
    // shell's "changed on disk" / *0020 conflict signal to conflict:true so
    // callers can report skipped-on-conflict without clobbering.
    async function writeReplacedFile(path, newRaw, fileState) {
      const operations = getFileOperations();
      if (!operations) {
        if (!noBridgeToastShown) {
          noBridgeToastShown = true;
          callbacks.showShellErrorToast?.('Workspace file access is unavailable; the file was not saved.', { title: 'Save Failed', dedupeKey: 'ide:replace:no-bridge' });
        }
        appendClientLog('WARN', 'ide.replace_write_failed', { path, reason: 'no_bridge' });
        return { ok: false, conflict: false };
      }
      try {
        if (fileState.open) {
          const snapshot = operations.captureSave(path, {
            content: newRaw,
            savedVersionId: editorHost.getAltVersionId?.(path),
          });
          if (!snapshot
            || snapshot.documentId !== fileState.snapshot?.documentId
            || snapshot.editVersion !== fileState.snapshot?.editVersion) {
            return { ok: false, conflict: true };
          }
          const result = await operations.write(snapshot);
          const accepted = operations.acceptWrite(snapshot, result);
          return { ok: accepted.current, conflict: !accepted.current, mtimeMs: result.mtimeMs, result, snapshot, exactEdit: accepted.exactEdit };
        }
        const result = await operations.writeMutation(fileState.snapshot, newRaw);
        return { ok: true, mtimeMs: result.mtimeMs, result, snapshot: fileState.snapshot, exactEdit: true };
      } catch (err) {
        const msg = String(err?.message || '');
        const code = String(err?.code || '');
        const conflict = msg.includes('changed on disk') || code.endsWith('0020');
        appendClientLog('WARN', 'ide.replace_write_failed', { path, conflict, message: msg });
        return { ok: false, conflict, error: err };
      }
    }

    // After a successful write to an OPEN file, refresh the live editor buffer
    // so the in-memory document matches what was just written (mtime + eol).
    async function refreshOpenDocument(path, newRaw, write, eol) {
      if (editorHost?.openDocument) {
        const operations = getFileOperations();
        if (operations && !write.exactEdit) {
          const ide = getIde(); ide.staleByPath = ide.staleByPath || {}; ide.staleByPath[path] = true;
          renderTabs(); return false;
        }
        const applied = await editorHost.openDocument({
          path, content: newRaw, mtimeMs: write.mtimeMs, eol,
          shouldApply: operations ? () => operations.canApplyWrite(write.snapshot) : null,
          onApplied: operations ? () => operations.noteDirty(path, false) : null,
        });
        if (operations && !applied) {
          const ide = getIde(); ide.staleByPath = ide.staleByPath || {}; ide.staleByPath[path] = true;
          renderTabs(); return false;
        }
        renderTabs();
      }
      return true;
    }

    /* ------------------------------------------------------------------ */
    /* Undo bookkeeping                                                      */
    /* ------------------------------------------------------------------ */

    // Records hold RAW before/after bytes (incl. original EOL) so undo is
    // byte-exact. Single-level: a new replace overwrites the prior undo entry.
    function recordUndo(records) {
      const s = getReplaceState();
      s.lastReplace = { records };
      s.canUndo = true;
    }

    /* ------------------------------------------------------------------ */
    /* Summary string                                                       */
    /* ------------------------------------------------------------------ */

    function buildSummaryString({ filesChanged = 0, occurrences = 0, conflicts = 0, failures = [], limitHit = false } = {}) {
      let text = occurrences
        ? `Replaced ${occurrences} occurrence${occurrences === 1 ? '' : 's'} in ${filesChanged} file${filesChanged === 1 ? '' : 's'}`
        : 'No occurrences replaced.';
      if (conflicts) {
        text += '; ' + conflicts + ' skipped (changed on disk)';
      }
      if (failures.length) {
        text += '; ' + failures.length + ' skipped (unavailable)';
      }
      if (limitHit) {
        text += '; results were capped — re-run to cover all files';
      }
      return text;
    }

    /* ------------------------------------------------------------------ */
    /* Apply lifecycle guard                                                 */
    /* ------------------------------------------------------------------ */

    // Shared enter/exit for every apply entry point: rejects re-entry and
    // active saves, mirrors the replacing flag onto the slice, and renders the
    // panel on both transitions so the UI shows the busy state.
    function beginApply() {
      const epoch = applyEpoch;
      cancelApplyEvaluation();
      applyAbortController = new AbortController();
      noBridgeToastShown = false;
      replacingFlag = true;
      const s = getReplaceState();
      s.replacing = true;
      // Every apply starts from a clean error slate so a stale replaceError
      // (which the panel renders ahead of the summary) can't mask this outcome.
      s.replaceError = '';
      renderSearchPanel();
      return epoch;
    }

    function endApply(epoch) {
      if (epoch !== applyEpoch) return;
      applyAbortController = null;
      replacingFlag = false;
      const s = getReplaceState();
      s.replacing = false;
      renderSearchPanel();
    }

    /* ------------------------------------------------------------------ */
    /* Apply entry points                                                   */
    /* ------------------------------------------------------------------ */

    // Read -> transform -> write -> refresh ONE whole file. Returns a
    // disposition the caller aggregates: 'replaced' (with record + count),
    // 'none' (no occurrence / no-op), 'read_failed' (with the caught error to
    // log), 'conflict', or 'write_failed'. This is the single per-file pipeline
    // shared by replaceInFile and replaceAll so the two cannot drift.
    async function replaceWholeFile(path, resolved, epoch) {
      let f;
      try {
        f = await readFileForReplace(path);
      } catch (error) {
        return { outcome: 'read_failed', error };
      }
      if (disposed || epoch !== applyEpoch) return { outcome: 'cancelled' };
      let transformed;
      if (resolved.useRegex) {
        try {
          const evaluator = await getRegexEvaluator('replace');
          transformed = await evaluator.evaluate({
            op: 'replaceAll',
            rawText: f.raw,
            query: resolved.query,
            replaceText: resolved.replaceText,
            caseSensitive: resolved.caseSensitive,
            eol: f.eol,
          }, {
            signal: applyAbortController?.signal,
            deadlineMs: REGEX_REPLACE_DEADLINE_MS,
          });
        } catch (error) {
          if (error?.code === 'REGEX_CANCELLED') return { outcome: 'cancelled' };
          return {
            outcome: error?.code === 'REGEX_TIMEOUT' ? 'regex_timeout' : 'regex_unavailable',
          };
        }
      } else {
        transformed = textUtils.applyReplaceToText(f.raw, {
          query: resolved.query,
          replaceText: resolved.replaceText,
          useRegex: false,
          caseSensitive: resolved.caseSensitive,
          eol: f.eol,
        });
      }
      if (disposed || epoch !== applyEpoch) return { outcome: 'cancelled' };
      const { newRaw, count } = transformed || { newRaw: f.raw, count: 0 };
      if (count === 0 || newRaw === f.raw) {
        return { outcome: 'none' };
      }
      const record = {
        path,
        beforeContent: f.raw,
        afterContent: newRaw,
      };
      const w = await writeReplacedFile(path, newRaw, f);
      if (!w.ok) {
        return { outcome: w.conflict ? 'conflict' : 'write_failed' };
      }
      if (disposed || epoch !== applyEpoch) return { outcome: 'cancelled', committed: true, count, record };
      if (f.open) {
        await refreshOpenDocument(path, newRaw, w, f.eol);
        if (disposed || epoch !== applyEpoch) return { outcome: 'cancelled', committed: true, count, record };
      }
      return {
        outcome: 'replaced',
        count,
        record,
      };
    }

    async function replaceMatch(path, line, column, opts) {
      if (disposed || isReplacing() || isSaving()) {
        return { skipped: true };
      }
      const resolved = resolveOpts(opts);
      if (resolved.query === '') {
        getReplaceState().replaceError = 'Enter a search term';
        return { error: 'Enter a search term' };
      }
      const epoch = beginApply();
      try {
        const s = getReplaceState();
        let f;
        try {
          f = await readFileForReplace(path);
        } catch (err) {
          s.replaceSummary = 'Replace failed; file unavailable.';
          appendClientLog('WARN', 'ide.replace_read_failed', {
            path,
            message: String(err?.message || err || ''),
          });
          return { error: 'read_failed' };
        }
        if (disposed || epoch !== applyEpoch) return { cancelled: true };
        let transformed;
        if (resolved.useRegex) {
          try {
            const evaluator = await getRegexEvaluator('replace');
            transformed = await evaluator.evaluate({
              op: 'replaceAt',
              rawText: f.raw,
              line,
              column,
              query: resolved.query,
              replaceText: resolved.replaceText,
              caseSensitive: resolved.caseSensitive,
              eol: f.eol,
            }, {
              signal: applyAbortController?.signal,
              deadlineMs: REGEX_REPLACE_DEADLINE_MS,
            });
          } catch (error) {
            if (error?.code === 'REGEX_CANCELLED') return { cancelled: true };
            const reason = error?.code === 'REGEX_TIMEOUT' ? 'regex_timeout' : 'regex_unavailable';
            s.replaceError = reason === 'regex_timeout'
              ? 'Regular expression timed out.'
              : 'Regex evaluation is unavailable.';
            return { error: reason };
          }
        } else {
          transformed = textUtils.applyReplaceAtPosition(f.raw, {
            line,
            column,
            query: resolved.query,
            replaceText: resolved.replaceText,
            useRegex: false,
            caseSensitive: resolved.caseSensitive,
            eol: f.eol,
          });
        }
        if (disposed || epoch !== applyEpoch) return { cancelled: true };
        const { newRaw, ok } = transformed || { newRaw: f.raw, ok: false };
        if (!ok) {
          s.replaceSummary = 'Match position changed; not replaced.';
          return { occurrences: 0 };
        }
        const w = await writeReplacedFile(path, newRaw, f);
        if (disposed || epoch !== applyEpoch) return { cancelled: true };
        if (!w.ok) {
          s.replaceSummary = w.conflict
            ? 'Not replaced; file changed on disk.'
            : 'Replace failed.';
          return { error: w.conflict ? 'conflict' : 'write_failed', conflict: !!w.conflict };
        }
        if (f.open) {
          await refreshOpenDocument(path, newRaw, w, f.eol);
          if (disposed || epoch !== applyEpoch) return { cancelled: true };
        }
        recordUndo([{
          path,
          beforeContent: f.raw,
          afterContent: newRaw,
        }]);
        s.replaceSummary = buildSummaryString({ filesChanged: 1, occurrences: 1 });
        requestFindRefresh();
        return { filesChanged: 1, occurrences: 1 };
      } finally {
        endApply(epoch);
      }
    }

    async function replaceInFile(path, opts) {
      if (disposed || isReplacing() || isSaving()) {
        return { skipped: true };
      }
      const resolved = resolveOpts(opts);
      if (resolved.query === '') {
        getReplaceState().replaceError = 'Enter a search term';
        return { error: 'Enter a search term' };
      }
      const epoch = beginApply();
      try {
        const s = getReplaceState();
        const res = await replaceWholeFile(path, resolved, epoch);
        if (res.outcome === 'cancelled') return { cancelled: true };
        if (res.outcome === 'read_failed') {
          s.replaceSummary = 'Replace failed; file unavailable.';
          appendClientLog('WARN', 'ide.replace_read_failed', {
            path,
            message: String(res.error?.message || res.error || ''),
          });
          return { error: 'read_failed' };
        }
        if (res.outcome === 'regex_timeout' || res.outcome === 'regex_unavailable') {
          s.replaceError = res.outcome === 'regex_timeout'
            ? 'Regular expression timed out.'
            : 'Regex evaluation is unavailable.';
          s.replaceSummary = 'No files were changed.';
          appendClientLog('WARN', 'ide.replace_regex_evaluation_failed', { reason: res.outcome });
          return { error: res.outcome };
        }
        if (res.outcome === 'none') {
          s.replaceSummary = 'No occurrences replaced.';
          return { occurrences: 0 };
        }
        if (res.outcome === 'conflict' || res.outcome === 'write_failed') {
          s.replaceSummary = res.outcome === 'conflict'
            ? 'Not replaced; file changed on disk.'
            : 'Replace failed.';
          return { error: res.outcome, conflict: res.outcome === 'conflict' };
        }
        recordUndo([res.record]);
        s.replaceSummary = buildSummaryString({ filesChanged: 1, occurrences: res.count });
        requestFindRefresh();
        return { filesChanged: 1, occurrences: res.count };
      } finally {
        endApply(epoch);
      }
    }

    async function replaceAll(opts) {
      // A torn-down panel/controller must not start a new replace loop.
      if (disposed) {
        return { skipped: true };
      }
      if (isReplacing() || isSaving()) {
        return { skipped: true };
      }
      const resolved = resolveOpts(opts);
      const s = getReplaceState();
      if (resolved.query === '') {
        s.replaceError = 'Enter a search term';
        return { error: 'Enter a search term' };
      }
      const epoch = beginApply();
      let journalToken = null;
      try {
        const paths = unique(getReplaceState().results.map((r) => r.path));
        journalToken = await replaceJournal.open({ query: resolved.query, total: paths.length });
        const records = [];
        let filesChanged = 0;
        let occurrences = 0;
        let conflicts = 0;
        let regexFailure = '';
        const failures = [];

        for (const path of paths) {
          // Cancellation barrier: stop before touching the next file once
          // dispose() has fired mid-loop. Already-written files stay written
          // (a partial replace is a committed, coherent disk state) and the
          // post-loop recordUndo below still covers them.
          if (disposed || epoch !== applyEpoch) break;
          const res = await replaceWholeFile(path, resolved, epoch);
          if (res.outcome === 'replaced' || res.committed) await replaceJournal.markApplied(journalToken, path);
          if (res.outcome === 'cancelled') {
            if (res.committed) {
              records.push(res.record);
              filesChanged += 1;
              occurrences += res.count;
            }
            break;
          }
          if (res.outcome === 'read_failed' || res.outcome === 'write_failed') {
            failures.push(path);
            continue;
          }
          if (res.outcome === 'regex_timeout' || res.outcome === 'regex_unavailable') {
            regexFailure = res.outcome;
            break;
          }
          if (res.outcome === 'conflict') {
            conflicts++;
            continue;
          }
          if (res.outcome === 'none') {
            continue;
          }
          records.push(res.record);
          filesChanged++;
          occurrences += res.count;
        }

        if (records.length && (disposed || epoch === applyEpoch)) {
          recordUndo(records);
        }
        if (disposed || epoch !== applyEpoch) {
          appendClientLog('INFO', 'ide.replace_all_cancelled', { filesChanged, occurrences });
          return { filesChanged, occurrences, conflicts, failures, cancelled: true };
        }
        if (regexFailure) {
          s.replaceError = regexFailure === 'regex_timeout'
            ? 'Regular expression timed out.'
            : 'Regex evaluation is unavailable.';
          s.replaceSummary = records.length
            ? `Replace stopped after ${filesChanged} file(s); completed changes can be undone.`
            : 'No files were changed.';
          appendClientLog('WARN', 'ide.replace_regex_evaluation_failed', {
            reason: regexFailure,
            files_changed: filesChanged,
          });
          return {
            filesChanged,
            occurrences,
            conflicts,
            failures,
            error: regexFailure,
            partial: records.length > 0,
          };
        }
        s.replaceSummary = buildSummaryString({
          filesChanged,
          occurrences,
          conflicts,
          failures,
          limitHit: s.limitHit,
        });
        requestFindRefresh();
        return { filesChanged, occurrences, conflicts, failures };
      } finally {
        replaceJournal.close(journalToken);
        endApply(epoch);
      }
    }

    /* ------------------------------------------------------------------ */
    /* Undo                                                                  */
    /* ------------------------------------------------------------------ */

    async function undoLastReplace() {
      const s = getReplaceState();
      if (!s.lastReplace?.records?.length) {
        s.replaceSummary = 'Nothing to undo.';
        renderSearchPanel();
        return { note: 'nothing' };
      }
      // A torn-down panel/controller must not start a new undo loop.
      if (disposed) {
        return { skipped: true };
      }
      if (isReplacing() || isSaving()) {
        return { skipped: true };
      }
      const epoch = beginApply();
      try {
        let restored = 0;
        let conflicts = 0;
        const failures = [];
        for (const rec of s.lastReplace.records) {
          // Cancellation barrier: stop restoring further files once dispose()
          // has fired mid-loop, mirroring replaceAll's guard.
          if (disposed || epoch !== applyEpoch) break;
          let f;
          try {
            f = await readFileForReplace(rec.path);
          } catch (_error) {
            failures.push(rec.path);
            continue;
          }
          if (disposed || epoch !== applyEpoch) break;
          // Only undo if the file still holds exactly what our replace wrote;
          // if it changed since, don't clobber the newer edit.
          if (textUtils.toLf(f.raw) !== textUtils.toLf(rec.afterContent)) {
            conflicts++;
            continue;
          }
          const w = await writeReplacedFile(rec.path, rec.beforeContent, f);
          if (!w.ok) {
            conflicts++;
            continue;
          }
          restored++;
          if (disposed || epoch !== applyEpoch) break;
          if (editorHost?.hasDocument?.(rec.path)) {
            await refreshOpenDocument(rec.path, rec.beforeContent, w, textUtils.detectEol(rec.beforeContent));
            if (disposed || epoch !== applyEpoch) break;
          }
        }
        if (disposed || epoch !== applyEpoch) {
          // Torn down mid-undo: the 'restored' files are back to beforeContent, the
          // rest still hold afterContent. Keep s.lastReplace intact so a re-opened
          // panel can finish the undo — already-restored records fall through the
          // conflict check above and are skipped on the re-run. Mirrors replaceAll's
          // ide.replace_all_cancelled cancel path.
          appendClientLog('INFO', 'ide.undo_replace_cancelled', { restored, conflicts });
          return { restored, conflicts, failures, cancelled: true };
        }
        s.lastReplace = null;
        s.canUndo = false;
        s.replaceSummary = 'Undid replace in ' + restored + ' file(s)'
          + (conflicts ? '; ' + conflicts + ' skipped (changed since)' : '');
        requestFindRefresh();
        return { restored, conflicts, failures };
      } finally {
        endApply(epoch);
      }
    }

    return {
      getReplaceState,
      runRegexFind,
      computeReplacementForMatch,
      replaceMatch,
      replaceInFile,
      replaceAll,
      undoLastReplace,
      isReplacing,
      checkRecovery: replaceJournal.checkRecovery,
      invalidateFind,
      resetForRoot,
      dispose,
    };
  }

  return { createIdeReplaceController };
});
