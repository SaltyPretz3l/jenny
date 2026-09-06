/* renderer/features/renderer-ide-quick-open.js - Ctrl+P fuzzy file picker for
 * the Workspace IDE. Overlay above the editor stage: an inventory text-field
 * filters the workspaceFs.listAllFiles cache through the command palette's
 * subsequence scorer; ArrowUp/Down + Enter open, Escape dismisses. The file
 * list is fetched once per workspace root, kept current by handleExternalChanges
 * (the controller forwards the same watcher change-batch the file tree
 * reconciles from - WIDE-026), and fully invalidated by the controller when the
 * root changes or a batch is truncated.
 *
 * The overlay chrome + keyboard nav live in the shared picker-overlay factory
 * (renderer-ide-picker-overlay); the shared workspace-inventory module owns the
 * listAllFiles cache, while this module supplies fuzzy scoring and row shape.
 *
 * Three extras ride the same chrome: a trailing ":N" / ":N:C" on the Quick Open
 * query reveals that line on accept (bare ":N" jumps within the open file); a
 * leading "@" switches the list to the active file's TS/JS symbols and jumps
 * to the selected symbol; and a sibling Ctrl+E "recently-edited"
 * picker lists the open files in runtime activation order (most-recent first)
 * via the getRecentFiles source.
 *
 * The @-mode reaches the already-landed symbol engine entirely through window
 * globals (the active-editor reader, window.monaco, and the pure helpers on
 * window.rendererIdeSymbolNav), so it needs no new constructor dependency and
 * makes ZERO controller edits - see fetchActiveSymbols / navigationTreeFor. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeQuickOpen = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  const MAX_RESULTS = 50;

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

  function createIdeQuickOpen(deps) {
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const escapeHtml = typeof deps?.escapeHtml === 'function'
      ? deps.escapeHtml
      : (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const callbacks = deps?.callbacks || {};
    const {
      getWorkspaceFsApi = () => null,
      onOpenFile = noop,
      // Reveal a 1-based line/column after opening. path === '' means "the file
      // already open" (a bare ":42" query), so the controller reveals in place.
      onOpenFileAtLine = noop,
      // Runtime MRU source for the Ctrl+E recently-edited jump list (most-recent
      // first); returns the currently-open file paths in activation order.
      getRecentFiles = () => [],
      onClosed = noop,
      appendClientLog = noop,
    } = callbacks;
    const monacoEditorUtils = resolveModule('rendererMonacoEditorUtils', './renderer-monaco-editor-utils');
    const paletteUtils = resolveModule('rendererCommandPaletteUtils', '../shell/renderer-command-palette');
    const pickerOverlayUtils = resolveModule('rendererIdePickerOverlay', './renderer-ide-picker-overlay');
    const workspaceInventoryUtils = resolveModule(
      'rendererIdeWorkspaceInventory',
      './renderer-ide-workspace-inventory'
    );
    // The landed symbol engine, reached as a window global (its pure helpers
    // flattenNavigationTree/rankSymbols are Monaco-free) - the @-mode source.
    const symbolNav = resolveModule('rendererIdeSymbolNav', './renderer-ide-symbol-nav');

    const now = typeof deps?.now === 'function' ? deps.now : () => Date.now();
    const workspaceInventory = deps?.workspaceInventory
      || workspaceInventoryUtils.createWorkspaceInventory({
        getWorkspaceFsApi,
        now,
        onListError: (error) => appendClientLog('WARN', 'ide.quick_open_list_failed', {
          message: String(error?.message || error || ''),
        }),
      });
    let workspaceResult = null;
    let workspaceEpoch = 1;
    // The trailing ":N" / ":N:C" parsed off the last query, consulted on submit.
    let lastParsed = { line: null, column: 1, pathPart: '' };

    // @-mode (active-file symbols) state, mirroring lastParsed for the :line mode.
    //   activeSymbols  null = not fetched for the current path; [] = fetched, none.
    //   symbolsForPath the active path activeSymbols was fetched for (the cache key).
    //   symbolsFetching a worker round-trip is in flight (drives the "Indexing…" status).
    // @-mode itself is derived from the query (isSymbolQuery) by computeMatches and
    // every status callback - no separate flag to keep in sync.
    let activeSymbols = null;
    let symbolsForPath = '';
    let symbolsFetching = false;

    // Split a trailing ":42" or ":42:5" off the query. pathPart is what the file
    // matcher sees; a missing colon-number leaves line null (plain path search).
    function parseLineSuffix(query) {
      const raw = String(query || '');
      const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(raw);
      if (!match) {
        return { line: null, column: 1, pathPart: raw.trim() };
      }
      return {
        line: Math.max(1, parseInt(match[2], 10) || 1),
        column: match[3] ? Math.max(1, parseInt(match[3], 10) || 1) : 1,
        pathPart: match[1].trim(),
      };
    }

    function resetWorkspaceView() {
      workspaceEpoch += 1;
      workspaceResult = null;
      activeSymbols = null;
      symbolsForPath = '';
      symbolsFetching = false;
    }

    function invalidate() {
      workspaceInventory.invalidate();
      resetWorkspaceView();
    }

    function handleExternalChanges(changes, { truncated = false } = {}) {
      workspaceInventory.handleExternalChanges(changes, { truncated });
      if (truncated) resetWorkspaceView();
    }

    async function ensureFiles() {
      const epoch = workspaceEpoch;
      // A listing that actually hits the bridge drops the rendered rows so the
      // overlay shows its loading state instead of a stale list.
      const startsListing = !workspaceInventory.isResolvedWithoutListing();
      const request = workspaceInventory.getFiles();
      if (startsListing) workspaceResult = null;
      const result = await request;
      if (epoch === workspaceEpoch) workspaceResult = result;
    }

    // True for a bare ":42" / ":42:5" query (a line jump with no path typed):
    // the target is the open file, not a file in the list.
    function isBareLineQuery() {
      return lastParsed.line != null && !lastParsed.pathPart;
    }

    // --- @-mode: active-file symbol list ---
    // Everything here is reached through window globals so the module stays
    // controller-free: the active-editor reader + window.monaco are read LAZILY
    // (monaco is null until Monaco loads), never cached at construct time.

    // The query is in @-mode (active-file symbols) when it leads with "@". One
    // predicate so computeMatches and every status callback agree on the mode.
    function isSymbolQuery(query) {
      return typeof query === 'string' && query.startsWith('@');
    }

    function activeEditorReader() {
      return globalRef.rendererIdeActiveEditorReader || null;
    }

    function activeEditorPath() {
      const reader = activeEditorReader();
      return reader && typeof reader.getActivePath === 'function'
        ? String(reader.getActivePath() || '')
        : '';
    }

    // NOTE: this duplicates ~12 lines from symbol-nav.js navTreeForModel
    // (renderer-ide-symbol-nav.js:271-291), and the offset->position enrich loop
    // in fetchActiveSymbols similarly mirrors symbolsForModel (:457-491). The live
    // symbolNav INSTANCE and those two methods are not exported, and calling the
    // instance would force a controller wire - so we reconstruct the worker call
    // inline to stay controller-free. A later refactor could promote both to
    // shared pure exports on window.rendererIdeSymbolNav (that change edits
    // symbol-nav, still NOT the controller).
    async function navigationTreeFor(monaco, model) {
      if (!monaco || !model || (model.isDisposed && model.isDisposed())) {
        return null;
      }
      const namespace = monaco.languages && monaco.languages.typescript;
      if (!namespace) {
        return null;
      }
      const lang = model.getLanguageId ? model.getLanguageId() : '';
      const getWorker = lang === 'javascript'
        ? (namespace.getJavaScriptWorker && await namespace.getJavaScriptWorker())
        : (namespace.getTypeScriptWorker && await namespace.getTypeScriptWorker());
      if (typeof getWorker !== 'function') {
        return null;
      }
      const client = await getWorker(model.uri);
      if (!client || typeof client.getNavigationTree !== 'function') {
        return null;
      }
      return client.getNavigationTree(model.uri.toString());
    }

    // Fetch the active file's symbols into activeSymbols. Mirrors symbol-nav's
    // TS/JS degradation: a non-TS/JS file, no active path, or Monaco-not-loaded
    // yields an empty list and a clear status - never a worker call, never a
    // stuck spinner. symbolsForPath is set in EVERY resolved branch so the path
    // gate (maybeKickSymbolFetch / isLoading) is satisfied and won't re-kick.
    async function fetchActiveSymbols() {
      const epoch = workspaceEpoch;
      symbolsFetching = true;
      try {
        const path = activeEditorPath();
        const reader = activeEditorReader();
        const lang = reader && typeof reader.getActiveLanguageId === 'function'
          ? String(reader.getActiveLanguageId() || '')
          : '';
        const monaco = globalRef.monaco || null;
        if (!path || (lang !== 'typescript' && lang !== 'javascript') || !monaco) {
          activeSymbols = [];
          symbolsForPath = path;
          return;
        }
        let model = null;
        try {
          model = monaco.editor.getModel(monaco.Uri.parse(monacoEditorUtils.workspacePathToMonacoUriString(path)));
        } catch (_error) {
          model = null;
        }
        if (!model) {
          activeSymbols = [];
          symbolsForPath = path;
          return;
        }
        let enriched = [];
        try {
          const tree = await navigationTreeFor(monaco, model);
          // Stale guard (mirror symbol-nav.js:396-401): if the active file
          // changed while the worker call was in flight, discard - don't
          // overwrite the new file's symbols. The next @-keystroke re-kicks
          // for the new path (symbolsForPath stays stale, so the gate re-opens).
          if (epoch !== workspaceEpoch || activeEditorPath() !== path) {
            return;
          }
          const flat = tree && typeof symbolNav.flattenNavigationTree === 'function'
            ? symbolNav.flattenNavigationTree(tree, true, '', [])
            : [];
          enriched = flat.map((sym) => {
            let position = { lineNumber: 1, column: 1 };
            try {
              position = model.getPositionAt(sym.offset) || position;
            } catch (_error) {
              /* keep the 1:1 fallback */
            }
            return {
              name: sym.name,
              kind: sym.kind,
              container: sym.container,
              path,
              lineNumber: position.lineNumber,
              column: position.column,
            };
          });
        } catch (error) {
          if (epoch !== workspaceEpoch) return;
          enriched = [];
          appendClientLog('WARN', 'ide.quick_open_symbols_failed', {
            message: String(error?.message || error || ''),
          });
        }
        if (epoch !== workspaceEpoch) return;
        activeSymbols = enriched;
        symbolsForPath = path;
      } finally {
        if (epoch === workspaceEpoch) symbolsFetching = false;
      }
    }

    // Kick a symbol fetch out-of-band the first time @-mode is entered for a path
    // we haven't indexed yet, then re-render via the overlay's public refresh()
    // when it resolves. computeMatches stays SYNCHRONOUS and only ranks the cache;
    // this never runs from loadItems (which fires on every Ctrl+P) so a plain file
    // search costs no worker round-trip.
    function maybeKickSymbolFetch() {
      if (symbolsFetching || symbolsForPath === activeEditorPath()) {
        return;
      }
      // Only re-render if the overlay is still open when the fetch resolves
      // (it may have closed mid-flight); refresh on a hidden overlay is a no-op
      // but the guard keeps intent explicit.
      const reRender = () => { if (picker?.isOpen()) { picker.refresh(); } };
      fetchActiveSymbols().then(reRender, reRender);
    }

    function computeMatches(query) {
      // @-mode runs BEFORE parseLineSuffix so "@foo" is a symbol search, not a
      // path search for "@foo". Simplest semantics for "@foo:42": the ":42" just
      // rides along in the symbol query (won't match) - we don't combine @ + :line.
      if (isSymbolQuery(query)) {
        // Clear the :line parse so a submit with no symbol match can't fall
        // through to a stale bare-":N" jump left over from a previous query.
        lastParsed = { line: null, column: 1, pathPart: '' };
        maybeKickSymbolFetch();
        return symbolNav.rankSymbols
          ? symbolNav.rankSymbols(activeSymbols || [], query.slice(1), paletteUtils.scoreMatch, MAX_RESULTS)
          : [];
      }
      lastParsed = parseLineSuffix(query);
      const pathQuery = lastParsed.pathPart;
      const files = workspaceResult?.files || [];
      if (!pathQuery) {
        // A bare ":N" targets the already-open file - show no rows so the
        // selected-row affordance can't suggest Enter opens some listed file.
        if (lastParsed.line != null) {
          return [];
        }
        return files.slice(0, MAX_RESULTS).map((path) => ({ path, ranges: [] }));
      }
      const scorer = paletteUtils.scoreMatch;
      if (typeof scorer !== 'function') {
        const needle = pathQuery.toLowerCase();
        return files
          .filter((path) => path.toLowerCase().includes(needle))
          .slice(0, MAX_RESULTS)
          .map((path) => ({ path, ranges: [] }));
      }
      const scored = [];
      for (const path of files) {
        const match = scorer(path, pathQuery);
        if (match) {
          scored.push({ path, score: match.score, ranges: match.ranges });
        }
      }
      scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      return scored.slice(0, MAX_RESULTS);
    }

    // The Ctrl+E recently-edited list: filter the runtime MRU by the query while
    // PRESERVING activation order (no score re-sort), so the most-recent file
    // stays on top. No ":line" parsing here - this picker just jumps to a file.
    function computeRecentMatches(query) {
      const files = getRecentFiles() || [];
      if (!query) {
        return files.slice(0, MAX_RESULTS).map((path) => ({ path, ranges: [] }));
      }
      const scorer = paletteUtils.scoreMatch;
      const out = [];
      for (const path of files) {
        if (typeof scorer === 'function') {
          const match = scorer(path, query);
          if (match) {
            out.push({ path, ranges: match.ranges });
          }
        } else if (path.toLowerCase().includes(query.toLowerCase())) {
          out.push({ path, ranges: [] });
        }
        if (out.length >= MAX_RESULTS) {
          break;
        }
      }
      return out;
    }

    function status(text) {
      return `<div class="ide-picker-status ide-quick-open-status">${text}</div>`;
    }

    function buildResultRowMarkup(match, index, selected) {
      const highlight = typeof paletteUtils.highlightRanges === 'function'
        ? paletteUtils.highlightRanges(match.path, match.ranges, escapeHtml)
        : escapeHtml(match.path);
      const name = match.path.split('/').pop() || match.path;
      return `<div class="ide-picker-row ide-quick-open-row${selected ? ' ide-picker-row--selected ide-quick-open-row--selected' : ''}"`
        + ` role="option" aria-selected="${selected ? 'true' : 'false'}"`
        + ` data-ide-quick-open-path="${escapeHtml(match.path)}" title="${escapeHtml(match.path)}">`
        + `<span class="ide-picker-name ide-quick-open-name">${escapeHtml(name)}</span>`
        + `<span class="ide-picker-path ide-quick-open-path">${highlight}</span>`
        + '</div>';
    }

    // A ranked symbol row (from rankSymbols) vs a file row (from the path
    // matcher): only the symbol row carries a name + 1-based line/column, so the
    // overlay's single buildRowMarkup hook can tell them apart and the same
    // click handler can read the line/col off the row dataset.
    function isSymbolRow(match) {
      return Boolean(match)
        && typeof match.lineNumber === 'number'
        && typeof match.name === 'string';
    }

    // One @-mode symbol row. Carries the SAME data-ide-quick-open-path the file
    // rows use (so the overlay's rowSelector still matches clicks) plus the
    // symbol's 1-based line/col on the dataset, mirroring symbol-nav's row shape.
    // The leading kind chip reuses the Ctrl+T `.ide-symbol-open-kind` style.
    function buildSymbolRowMarkup(row, index, selected) {
      const highlight = typeof paletteUtils.highlightRanges === 'function'
        ? paletteUtils.highlightRanges(row.name, row.ranges, escapeHtml)
        : escapeHtml(row.name);
      const detail = row.container ? `${row.container} · ${row.path}` : row.path;
      return `<div class="ide-picker-row ide-quick-open-row ide-quick-open-symbol-row${selected ? ' ide-picker-row--selected ide-quick-open-row--selected' : ''}"`
        + ` role="option" aria-selected="${selected ? 'true' : 'false'}"`
        + ` data-ide-quick-open-path="${escapeHtml(row.path)}"`
        + ` data-ide-quick-open-line="${escapeHtml(String(row.lineNumber))}"`
        + ` data-ide-quick-open-col="${escapeHtml(String(row.column))}"`
        + ` title="${escapeHtml(`${row.name} - ${row.path}:${row.lineNumber}`)}">`
        + `<span class="ide-symbol-open-kind">${escapeHtml(row.kindLabel || '')}</span>`
        + `<span class="ide-picker-name ide-quick-open-name">${highlight}</span>`
        + `<span class="ide-picker-path ide-quick-open-symbol-detail">${escapeHtml(detail)}</span>`
        + '</div>';
    }

    // The overlay's single row hook dispatches by row kind (file vs symbol).
    function buildRowMarkup(match, index, selected) {
      return isSymbolRow(match)
        ? buildSymbolRowMarkup(match, index, selected)
        : buildResultRowMarkup(match, index, selected);
    }

    function buildRecentRowMarkup(match, index, selected) {
      const highlight = typeof paletteUtils.highlightRanges === 'function'
        ? paletteUtils.highlightRanges(match.path, match.ranges, escapeHtml)
        : escapeHtml(match.path);
      const name = match.path.split('/').pop() || match.path;
      return `<div class="ide-picker-row ide-recent-files-row${selected ? ' ide-picker-row--selected ide-recent-files-row--selected' : ''}"`
        + ` role="option" aria-selected="${selected ? 'true' : 'false'}"`
        + ` data-ide-recent-files-path="${escapeHtml(match.path)}" title="${escapeHtml(match.path)}">`
        + `<span class="ide-picker-name ide-recent-files-name">${escapeHtml(name)}</span>`
        + `<span class="ide-picker-path ide-recent-files-path">${highlight}</span>`
        + '</div>';
    }

    // Resolve a submit/click into the right open path: ":N" with no path jumps
    // within the open file (path ''); "foo.js:N" opens foo.js then reveals; a
    // bare path opens with no reveal.
    function openMatchAtLine(path) {
      const { line, column } = lastParsed;
      if (line != null) {
        onOpenFileAtLine(String(path || ''), line, column);
      } else {
        onOpenFile(String(path || ''));
      }
    }

    const picker = pickerOverlayUtils.createIdePickerOverlay?.({
      getDom,
      overlayClass: 'ide-quick-open',
      panelClass: 'ide-quick-open-panel',
      fieldClass: 'ide-quick-open-field',
      resultsClass: 'ide-quick-open-results',
      placeholder: 'Go to file…',
      ariaLabel: 'Go to file',
      resultsAriaLabel: 'Matching files',
      inputDataset: { 'ide-quick-open-input': '1' },
      inputSelector: '[data-ide-quick-open-input]',
      rowSelector: '[data-ide-quick-open-path]',
      callbacks: {
        // Drop the symbol cache on each open so re-opening re-fetches fresh
        // symbols (file contents drift between opens); the file-list cache is
        // separate and stays warm across opens (invalidated by the controller).
        resetOnOpen: () => { activeSymbols = null; symbolsForPath = ''; },
        loadItems: ensureFiles,
        computeMatches,
        buildRowMarkup,
        isLoading: (query) => (isSymbolQuery(query)
          // @-mode: loading until the active path's symbols have resolved (the
          // path gate is satisfied) - so non-TS/JS files show their empty status
          // immediately instead of spinning forever.
          ? (symbolsFetching || symbolsForPath !== activeEditorPath())
          : workspaceResult === null),
        renderLoadingStatus: (query) => status(isSymbolQuery(query)
          ? 'Indexing symbols…'
          : 'Indexing workspace files…'),
        renderEmptyStatus: (query) => {
          if (isSymbolQuery(query)) {
            // A non-empty post-"@" query over a populated cache means "no match";
            // anything else (empty query, non-TS/JS, no symbols) is "no symbols".
            return status(query.slice(1) && activeSymbols && activeSymbols.length
              ? 'No matching symbols in this file.'
              : 'No symbols - open a TS/JS file.');
          }
          if (workspaceResult?.failed) {
            return status('Could not load workspace files - reopen Quick Open to retry.');
          }
          return isBareLineQuery()
            ? status(`Press Enter to go to line ${lastParsed.line} in the current file.`)
            : status('No matching files.');
        },
        renderTrailingStatus: (matches, query) => (workspaceResult?.truncated && !isSymbolQuery(query)
          ? status('File list truncated - narrow your search.')
          : ''),
        onSubmit: (match, { close }) => {
          // A symbol row (only produced in @-mode) jumps to its line/col. Keying
          // off the row kind - not a mode flag - means @-mode with no match just
          // closes: computeMatches cleared lastParsed, so no stale ":N" jump.
          if (isSymbolRow(match)) {
            onOpenFileAtLine(String(match.path || ''), match.lineNumber, match.column);
            close();
            return;
          }
          // A bare ":N" jumps within the open file (the list is empty here, so
          // there is no selected row to honor).
          if (isBareLineQuery()) {
            onOpenFileAtLine('', lastParsed.line, lastParsed.column);
          } else if (match) {
            openMatchAtLine(match.path);
          }
          close();
        },
        onRowClick: (row, { close }) => {
          // A symbol row carries its own line/col on the dataset; a file row does
          // not. Read the row directly so a click needs no @-mode signal.
          const line = row.dataset.ideQuickOpenLine;
          if (line != null && line !== '') {
            onOpenFileAtLine(
              row.dataset.ideQuickOpenPath || '',
              Number(line) || 1,
              Number(row.dataset.ideQuickOpenCol) || 1
            );
            close();
            return;
          }
          openMatchAtLine(row.dataset.ideQuickOpenPath || '');
          close();
        },
        onClosed,
      },
    }) || null;

    // Ctrl+E recently-edited jump list: the same picker chrome over the runtime
    // MRU. In-memory source, so no loadItems; just open-on-accept.
    const recentPicker = pickerOverlayUtils.createIdePickerOverlay?.({
      getDom,
      overlayClass: 'ide-recent-files',
      panelClass: 'ide-recent-files-panel',
      fieldClass: 'ide-recent-files-field',
      resultsClass: 'ide-recent-files-results',
      placeholder: 'Recently edited files…',
      ariaLabel: 'Recently edited files',
      resultsAriaLabel: 'Recently edited files',
      inputDataset: { 'ide-recent-files-input': '1' },
      inputSelector: '[data-ide-recent-files-input]',
      rowSelector: '[data-ide-recent-files-path]',
      callbacks: {
        computeMatches: computeRecentMatches,
        buildRowMarkup: buildRecentRowMarkup,
        isLoading: () => false,
        renderEmptyStatus: () => status('No recently-edited files.'),
        onSubmit: (match, { close }) => {
          if (match) {
            onOpenFile(match.path);
          }
          close();
        },
        onRowClick: (row, { close }) => {
          onOpenFile(row.dataset.ideRecentFilesPath || '');
          close();
        },
        onClosed,
      },
    }) || null;

    function toggle() {
      picker?.toggle();
    }

    function toggleRecent() {
      recentPicker?.toggle();
    }

    function dispose() {
      picker?.dispose();
      recentPicker?.dispose();
      workspaceInventory.dispose();
      resetWorkspaceView();
    }

    return {
      dispose,
      handleExternalChanges,
      invalidate,
      toggle,
      toggleRecent,
    };
  }

  return {
    createIdeQuickOpen,
  };
});
