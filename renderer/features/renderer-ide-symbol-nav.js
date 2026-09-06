/* renderer/features/renderer-ide-symbol-nav.js - TS/JS symbol navigation for the
 * Workspace IDE. Two deterministic surfaces (no model calls), both backed by
 * Monaco's built-in TypeScript language worker:
 *
 *   1. Symbol breadcrumb - the active file's symbol path at the caret
 *      (e.g. "Greeter > greet"), appended after the file-path crumbs the
 *      statusbar renders. Clicking a segment reveals that symbol. Refreshes on
 *      cursor activity and on ide:active-file-changed (self-subscribed, like the
 *      gutter module - no controller wire for file switches).
 *   2. Ctrl+T "Go to Symbol in Workspace" - a Quick-pick cloned from
 *      renderer-ide-quick-open that searches symbols across the currently-OPEN
 *      TS/JS models and jumps to the selected one. (Scope note: only loaded
 *      models have a live worker tree; a full lazy index over unopened files is a
 *      deliberate follow-up - searching open files keeps it instant on a modest
 *      machine. The in-file outline already ships via editor.action.quickOutline
 *      on Ctrl+Shift+O.)
 *
 * The pure tree -> breadcrumb-segments / nav-item -> pick-row helpers never touch
 * Monaco and are exported for unit tests; the live worker calls are covered by a
 * real-app CDP smoke (jsdom has no TS worker). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeSymbolNav = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RENDER_DEBOUNCE_MS = 90;
  const MAX_SYMBOL_RESULTS = 200;
  const MAX_NAV_TREE_CACHE_ENTRIES = 64;
  const MODEL_SCHEME = 'jenny-workspace';

  // Breadcrumbs show names only; picker rows include the kind so ambiguous names
  // remain distinguishable. Unmapped kinds pass through verbatim.
  const KIND_LABEL = {
    class: 'class', interface: 'interface', enum: 'enum', 'enum member': 'enum member',
    function: 'function', method: 'method', 'local function': 'function', constructor: 'constructor',
    property: 'property', getter: 'property', setter: 'property', accessor: 'property',
    var: 'variable', let: 'variable', const: 'const', alias: 'alias', module: 'module',
    type: 'type', 'type parameter': 'type', 'index signature': 'index',
  };

  function symbolKindLabel(kind) {
    const key = String(kind == null ? '' : kind).trim();
    return KIND_LABEL[key] || key || 'symbol';
  }

  function nodeSpans(node) {
    return node && Array.isArray(node.spans) ? node.spans : [];
  }

  // Caret containment across ALL spans: an overloaded function/class can have
  // several disjoint spans, so spans[0] alone would miss the cursor.
  function offsetInNode(node, offset) {
    return nodeSpans(node).some((span) => span
      && Number.isFinite(span.start)
      && offset >= span.start
      && offset < span.start + span.length);
  }

  // Where "go to this symbol" lands: the name token when known (jumps to the
  // identifier, not the leading decorator/keyword), else the node's first span.
  function nodeOffset(node) {
    const nameSpan = node && node.nameSpan;
    if (nameSpan && Number.isFinite(nameSpan.start)) {
      return nameSpan.start;
    }
    const first = nodeSpans(node)[0];
    return first && Number.isFinite(first.start) ? first.start : 0;
  }

  // NavigationTree + caret offset -> ordered breadcrumb segments (outermost
  // first), skipping the synthetic root "module" node. Returns [] when the caret
  // is in the file but inside no named symbol (e.g. the import block).
  function findBreadcrumbPath(tree, offset, isRoot, acc) {
    const path = acc || [];
    if (!tree || typeof tree !== 'object' || !offsetInNode(tree, offset)) {
      return isRoot ? [] : null;
    }
    const next = isRoot === false
      ? path.concat([{ label: String(tree.text || ''), kind: String(tree.kind || ''), offset: nodeOffset(tree) }])
      : path;
    const children = Array.isArray(tree.childItems) ? tree.childItems : [];
    for (let index = 0; index < children.length; index += 1) {
      const childPath = findBreadcrumbPath(children[index], offset, false, next);
      if (childPath) {
        return childPath;
      }
    }
    return next;
  }

  // NavigationTree -> flat symbol list for the workspace picker. Skips the root
  // module node; threads each node's container path (e.g. "Greeter") for the
  // picker's secondary detail line.
  function flattenNavigationTree(tree, isRoot, container, acc) {
    const out = acc || [];
    if (!tree || typeof tree !== 'object') {
      return out;
    }
    const name = String(tree.text || '');
    if (isRoot === false && name) {
      out.push({ name, kind: String(tree.kind || ''), container: container || '', offset: nodeOffset(tree) });
    }
    const childContainer = isRoot === false && name
      ? (container ? `${container} › ${name}` : name)
      : '';
    const children = Array.isArray(tree.childItems) ? tree.childItems : [];
    for (let index = 0; index < children.length; index += 1) {
      flattenNavigationTree(children[index], false, childContainer, out);
    }
    return out;
  }

  // Enriched symbol (name/kind/container/path/line/col) + query -> a scored
  // pick-row view-model, or null when a non-empty query doesn't match the NAME
  // (path/container never gate the match - symbol search is name-first).
  function symbolRowModel(item, query, scorer) {
    const name = String(item && item.name ? item.name : '');
    if (!name) {
      return null;
    }
    let ranges = [];
    let score = 0;
    const trimmed = String(query || '');
    if (trimmed) {
      if (typeof scorer === 'function') {
        const match = scorer(name, trimmed);
        if (!match) {
          return null;
        }
        score = Number(match.score) || 0;
        ranges = Array.isArray(match.ranges) ? match.ranges : [];
      } else {
        const at = name.toLowerCase().indexOf(trimmed.toLowerCase());
        if (at < 0) {
          return null;
        }
        score = 1000 - at;
        ranges = [[at, at + trimmed.length]];
      }
    }
    return {
      name,
      ranges,
      score,
      kind: String(item.kind || ''),
      kindLabel: symbolKindLabel(item.kind),
      container: String(item.container || ''),
      path: String(item.path || ''),
      lineNumber: Number(item.lineNumber) || 1,
      column: Number(item.column) || 1,
    };
  }

  // Rank enriched symbols against a query. Empty query -> stable file/line order;
  // otherwise best score first (name tie-break, then path) for deterministic rows.
  function rankSymbols(symbols, query, scorer, limit) {
    const rows = [];
    const list = Array.isArray(symbols) ? symbols : [];
    for (let index = 0; index < list.length; index += 1) {
      const row = symbolRowModel(list[index], query, scorer);
      if (row) {
        rows.push(row);
      }
    }
    if (String(query || '')) {
      rows.sort((a, b) => b.score - a.score
        || a.name.localeCompare(b.name)
        || a.path.localeCompare(b.path)
        || a.lineNumber - b.lineNumber);
    } else {
      rows.sort((a, b) => a.path.localeCompare(b.path) || a.lineNumber - b.lineNumber);
    }
    const cap = Number.isFinite(limit) ? limit : MAX_SYMBOL_RESULTS;
    return rows.slice(0, cap);
  }

  function resolveModule(globalRef, globalName, requirePath) {
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

  function createIdeSymbolNav(deps) {
    const options = deps || {};
    const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
    const editorHost = options.editorHost || null;
    const getDom = typeof options.getDom === 'function' ? options.getDom : () => ({});
    const windowRef = options.windowRef || globalRef.window || globalRef;
    const onOpenFile = typeof options.onOpenFile === 'function' ? options.onOpenFile : () => Promise.resolve(false);
    const appendClientLog = typeof options.appendClientLog === 'function' ? options.appendClientLog : function noop() {};
    const escapeHtml = typeof options.escapeHtml === 'function'
      ? options.escapeHtml
      : (value) => String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const setTimeoutFn = typeof options.setTimeoutFn === 'function'
      ? options.setTimeoutFn
      : (typeof setTimeout === 'function' ? setTimeout : null);
    const clearTimeoutFn = typeof options.clearTimeoutFn === 'function'
      ? options.clearTimeoutFn
      : (typeof clearTimeout === 'function' ? clearTimeout : null);
    const actionButton = resolveModule(globalRef, 'inventoryActionButton', '../inventory/action-button');
    const paletteUtils = resolveModule(globalRef, 'rendererCommandPaletteUtils', '../shell/renderer-command-palette');
    const pickerOverlayUtils = resolveModule(globalRef, 'rendererIdePickerOverlay', './renderer-ide-picker-overlay');
    const asyncFence = resolveModule(globalRef, 'rendererAsyncFence', '../shared/async-fence');
    const monacoUtils = resolveModule(globalRef, 'rendererMonacoEditorUtils', './renderer-monaco-editor-utils');
    const indexGate = asyncFence.createGenerationGate();

    let monacoApi = null;
    let disposed = false;

    // --- Breadcrumb state ---
    let crumbEl = null;
    let boundCrumbHost = null;
    let renderTimer = null;
    let renderToken = 0;

    // --- Picker state (the overlay chrome + keyboard nav live in the shared
    // picker-overlay factory; this module owns only the symbol index) ---
    let symbols = null; // null = not indexed this open
    let indexing = false;
    const navTreeCache = new Map();
    let navTreeCacheHits = 0;
    let navTreeCacheMisses = 0;

    function handleMonacoReady(api) {
      monacoApi = api || null;
    }

    function isMonacoLive() {
      return Boolean(monacoApi) && editorHost && editorHost.isUsingMonaco
        && editorHost.isUsingMonaco() === true;
    }

    function modelForPath(path) {
      if (!monacoApi || !path) {
        return null;
      }
      try {
        const uri = monacoApi.Uri.parse(monacoUtils.workspacePathToMonacoUriString(String(path)));
        return monacoApi.editor.getModel(uri) || null;
      } catch (_error) {
        return null;
      }
    }

    function pathFromModel(model) {
      const uri = model && model.uri;
      if (!uri) {
        return '';
      }
      // Monaco stores a decoded path; the host keys models via the shared
      // lossless workspacePathToMonacoUriString helper, so dropping the
      // leading slash recovers the complete workspace-relative path (URI
      // delimiters like '#' included).
      return String(uri.path || '').replace(/^\//, '');
    }

    // Resolve and query the TS/JS language worker for one model. setEagerModelSync
    // is OFF in this app, so getWorker(model.uri) is what forces the model to sync
    // before we read its navigation tree.
    async function navTreeForModel(model) {
      if (!monacoApi || !model || (model.isDisposed && model.isDisposed())) {
        return null;
      }
      const namespace = monacoApi.languages && monacoApi.languages.typescript;
      if (!namespace) {
        return null;
      }
      const uri = model.uri.toString();
      const versionId = model.getVersionId ? model.getVersionId() : null;
      const cached = versionId !== null ? navTreeCache.get(uri) : null;
      if (cached && cached.versionId === versionId) {
        navTreeCacheHits += 1;
        return cached.tree;
      }
      navTreeCacheMisses += 1;
      const lang = model.getLanguageId ? model.getLanguageId() : '';
      const getWorker = lang === 'javascript'
        ? (namespace.getJavaScriptWorker && await namespace.getJavaScriptWorker())
        : (namespace.getTypeScriptWorker && await namespace.getTypeScriptWorker());
      if (model.isDisposed && model.isDisposed()) {
        navTreeCache.delete(uri);
        return null;
      }
      if (typeof getWorker !== 'function') {
        return null;
      }
      const client = await getWorker(model.uri);
      if (model.isDisposed && model.isDisposed()) {
        navTreeCache.delete(uri);
        return null;
      }
      if (!client || typeof client.getNavigationTree !== 'function') {
        return null;
      }
      const tree = await client.getNavigationTree(uri);
      if (model.isDisposed && model.isDisposed()) {
        navTreeCache.delete(uri);
        return null;
      }
      if (versionId !== null && tree != null) {
        navTreeCache.delete(uri);
        navTreeCache.set(uri, { versionId, tree });
        while (navTreeCache.size > MAX_NAV_TREE_CACHE_ENTRIES) {
          navTreeCache.delete(navTreeCache.keys().next().value);
        }
      }
      return tree;
    }

    function isTsJsLanguage(lang) {
      return lang === 'typescript' || lang === 'javascript';
    }

    // === Breadcrumb ===

    function ensureCrumbContainer(host) {
      if (crumbEl && crumbEl.parentNode === host) {
        return crumbEl;
      }
      const documentRef = host.ownerDocument || null;
      if (!documentRef) {
        return null;
      }
      crumbEl = documentRef.createElement('span');
      crumbEl.className = 'ide-crumb-symbols';
      host.appendChild(crumbEl);
      return crumbEl;
    }

    function clearCrumb() {
      if (crumbEl && crumbEl.parentNode) {
        crumbEl.parentNode.removeChild(crumbEl);
      }
      crumbEl = null;
    }

    function applyCrumb(host, segments) {
      if (!segments || !segments.length || typeof actionButton !== 'function') {
        clearCrumb();
        return;
      }
      const el = ensureCrumbContainer(host);
      if (!el) {
        return;
      }
      const parts = [];
      for (let index = 0; index < segments.length; index += 1) {
        const seg = segments[index];
        const label = String(seg.label || '');
        if (!label) {
          continue;
        }
        parts.push('<span class="ide-crumb-sep ide-crumb-sep--symbol" aria-hidden="true">›</span>');
        parts.push(actionButton({
          plain: true,
          className: 'ide-crumb ide-crumb-action ide-crumb-symbol',
          title: `Go to ${label}`,
          ariaLabel: `Go to ${label}`,
          trustedHtml: escapeHtml(label),
          dataset: { 'ide-symbol-crumb': String(seg.offset) },
        }));
      }
      el.innerHTML = parts.join('');
    }

    async function renderNow() {
      const dom = getDom();
      const host = dom && dom.ideBreadcrumbs;
      if (!host) {
        return;
      }
      const token = renderToken + 1;
      renderToken = token;
      if (!isMonacoLive()) {
        clearCrumb();
        return;
      }
      const path = (editorHost.getActivePath && editorHost.getActivePath()) || '';
      const lang = (editorHost.getActiveLanguageId && editorHost.getActiveLanguageId()) || '';
      if (!path || !isTsJsLanguage(lang)) {
        clearCrumb();
        return;
      }
      if (editorHost.getDocumentKind && editorHost.getDocumentKind(path) !== 'file') {
        clearCrumb();
        return;
      }
      const reader = windowRef && windowRef.rendererIdeActiveEditorReader;
      if (reader && typeof reader.isLargeFile === 'function' && reader.isLargeFile() === true) {
        clearCrumb();
        return;
      }
      const cursor = editorHost.getCursorInfo && editorHost.getCursorInfo();
      const model = modelForPath(path);
      if (!cursor || !model) {
        clearCrumb();
        return;
      }
      let offset;
      try {
        offset = model.getOffsetAt({ lineNumber: cursor.lineNumber, column: cursor.column });
      } catch (_error) {
        clearCrumb();
        return;
      }
      let tree;
      try {
        tree = await navTreeForModel(model);
      } catch (error) {
        appendClientLog('WARN', 'ide.symbol_breadcrumb_failed', { message: String((error && error.message) || error || '') });
        tree = null;
      }
      // Stale guard: bail if another render started or the active file changed
      // while the worker call was in flight.
      if (disposed || token !== renderToken
        || ((editorHost.getActivePath && editorHost.getActivePath()) || '') !== path) {
        return;
      }
      applyCrumb(host, tree ? findBreadcrumbPath(tree, offset, true, []) : []);
    }

    function scheduleRender() {
      if (disposed || !setTimeoutFn) {
        return;
      }
      if (renderTimer && clearTimeoutFn) {
        clearTimeoutFn(renderTimer);
      }
      renderTimer = setTimeoutFn(() => {
        renderTimer = null;
        renderNow();
      }, RENDER_DEBOUNCE_MS);
    }

    function handleActiveFileChanged() {
      // Drop the previous file's crumb buttons synchronously so a click during
      // the render debounce can't jump to a stale offset clamped into the new
      // file; renderNow re-appends the new file's path after the worker call.
      clearCrumb();
      scheduleRender();
    }

    function handleCrumbClick(event) {
      const target = event.target && event.target.closest && event.target.closest('[data-ide-symbol-crumb]');
      if (!target) {
        return;
      }
      const offset = Number(target.dataset.ideSymbolCrumb);
      if (!Number.isFinite(offset)) {
        return;
      }
      const path = (editorHost.getActivePath && editorHost.getActivePath()) || '';
      const model = modelForPath(path);
      if (!model) {
        return;
      }
      let position;
      try {
        position = model.getPositionAt(offset);
      } catch (_error) {
        return;
      }
      if (position && editorHost.revealPosition) {
        editorHost.revealPosition(path, position.lineNumber, position.column);
      }
    }

    // === Ctrl+T workspace symbol picker ===

    // One model -> its flat symbol list. Offsets are converted to 1-based
    // line/col with the live model so the jump needs no re-conversion. Errors
    // (worker hiccup, disposed mid-flight) degrade to an empty list so one bad
    // model can't fail the whole index.
    async function symbolsForModel(model) {
      let tree;
      try {
        tree = await navTreeForModel(model);
      } catch (_error) {
        tree = null;
      }
      if (!tree) {
        return [];
      }
      const path = pathFromModel(model);
      const out = [];
      const flat = flattenNavigationTree(tree, true, '', []);
      for (let s = 0; s < flat.length; s += 1) {
        const sym = flat[s];
        let position;
        try {
          position = model.getPositionAt(sym.offset);
        } catch (_error) {
          position = null;
        }
        if (!position) {
          continue;
        }
        out.push({
          name: sym.name,
          kind: sym.kind,
          container: sym.container,
          path,
          lineNumber: position.lineNumber,
          column: position.column,
        });
      }
      return out;
    }

    // Index symbols across the currently-open TS/JS models. The per-model worker
    // round-trips are independent, so they run concurrently - picker latency is
    // the slowest single file, not the sum over open tabs.
    async function ensureSymbols() {
      if (symbols || indexing) {
        return;
      }
      if (!isMonacoLive()) {
        symbols = [];
        return;
      }
      indexing = true;
      const token = indexGate.capture();
      try {
        const models = (monacoApi.editor.getModels && monacoApi.editor.getModels()) || [];
        const eligible = models.filter((model) => model
          && !(model.isDisposed && model.isDisposed())
          && model.uri
          && model.uri.scheme === MODEL_SCHEME
          && isTsJsLanguage(model.getLanguageId ? model.getLanguageId() : ''));
        const perModel = await Promise.all(eligible.map((model) => symbolsForModel(model)));
        if (disposed || !indexGate.isCurrent(token)) {
          return;
        }
        symbols = perModel.flat();
      } finally {
        if (indexGate.isCurrent(token)) {
          indexing = false;
        }
      }
    }

    function status(text) {
      return `<div class="ide-picker-status ide-symbol-open-status">${text}</div>`;
    }

    function buildResultRow(row, index, selected) {
      const highlight = typeof paletteUtils.highlightRanges === 'function'
        ? paletteUtils.highlightRanges(row.name, row.ranges, escapeHtml)
        : escapeHtml(row.name);
      const detail = row.container ? `${row.container} · ${row.path}` : row.path;
      return `<div class="ide-picker-row ide-symbol-open-row${selected ? ' ide-picker-row--selected ide-symbol-open-row--selected' : ''}"`
        + ` role="option" aria-selected="${selected ? 'true' : 'false'}"`
        + ` data-ide-symbol-path="${escapeHtml(row.path)}"`
        + ` data-ide-symbol-line="${escapeHtml(String(row.lineNumber))}"`
        + ` data-ide-symbol-col="${escapeHtml(String(row.column))}"`
        + ` title="${escapeHtml(`${row.path}:${row.lineNumber}`)}">`
        + `<span class="ide-symbol-open-kind">${escapeHtml(row.kindLabel)}</span>`
        + `<span class="ide-picker-name ide-symbol-open-name">${highlight}</span>`
        + `<span class="ide-picker-path ide-symbol-open-detail">${escapeHtml(detail)}</span>`
        + '</div>';
    }

    async function jumpTo(path, lineNumber, column) {
      if (!path) {
        return;
      }
      try {
        await onOpenFile(path);
      } catch (_error) {
        /* best-effort: revealPosition no-ops if the file isn't active */
      }
      if (editorHost.revealPosition) {
        editorHost.revealPosition(path, lineNumber, column);
      }
    }

    // The Ctrl+T overlay: chrome + keyboard nav come from the shared factory;
    // this module supplies the open-model symbol index and the row shape.
    const picker = pickerOverlayUtils.createIdePickerOverlay?.({
      getDom,
      overlayClass: 'ide-symbol-open',
      panelClass: 'ide-symbol-open-panel',
      fieldClass: 'ide-symbol-open-field',
      resultsClass: 'ide-symbol-open-results',
      inputId: 'ideSymbolOpenInput',
      placeholder: 'Go to symbol in workspace…',
      ariaLabel: 'Go to symbol in workspace',
      resultsAriaLabel: 'Matching symbols',
      inputDataset: { 'ide-symbol-open-input': '1' },
      inputSelector: '[data-ide-symbol-open-input]',
      rowSelector: '[data-ide-symbol-path]',
      callbacks: {
        // Re-index every open: the set of open models and their contents drift
        // as the user edits, and open-file scope keeps this cheap.
        resetOnOpen: () => { symbols = null; },
        loadItems: ensureSymbols,
        computeMatches: (query) => rankSymbols(symbols || [], query, paletteUtils.scoreMatch, MAX_SYMBOL_RESULTS),
        buildRowMarkup: buildResultRow,
        isLoading: () => symbols === null || indexing,
        renderLoadingStatus: () => status('Indexing open files…'),
        renderEmptyStatus: (query) => status(query
          ? 'No matching symbols in open files.'
          : 'No symbols in open TS/JS files. Open a file to search it.'),
        onSubmit: (row, { close }) => {
          close();
          if (row) {
            jumpTo(row.path, row.lineNumber, row.column);
          }
        },
        onRowClick: (row, { close }) => {
          close();
          jumpTo(
            row.dataset.ideSymbolPath || '',
            Number(row.dataset.ideSymbolLine) || 1,
            Number(row.dataset.ideSymbolCol) || 1
          );
        },
        onClosed: () => {
          if (editorHost && editorHost.focus) {
            editorHost.focus();
          }
        },
      },
    }) || null;

    function openPicker() {
      return picker ? picker.open() : false;
    }

    function handleWorkspaceRootCommitted() {
      indexGate.bump();
      symbols = null;
      navTreeCache.clear();
      indexing = false;
      renderToken += 1;
      clearCrumb();
      picker?.close();
    }

    function bindEvents() {
      const dom = getDom();
      if (dom && dom.ideBreadcrumbs && !boundCrumbHost) {
        boundCrumbHost = dom.ideBreadcrumbs;
        boundCrumbHost.addEventListener('click', handleCrumbClick);
      }
    }

    if (windowRef && typeof windowRef.addEventListener === 'function') {
      windowRef.addEventListener('ide:active-file-changed', handleActiveFileChanged);
      windowRef.addEventListener('ide:workspace-root-committed', handleWorkspaceRootCommitted);
    }

    function dispose() {
      disposed = true;
      indexGate.bump();
      if (renderTimer && clearTimeoutFn) {
        clearTimeoutFn(renderTimer);
      }
      renderTimer = null;
      if (windowRef && typeof windowRef.removeEventListener === 'function') {
        windowRef.removeEventListener('ide:active-file-changed', handleActiveFileChanged);
        windowRef.removeEventListener('ide:workspace-root-committed', handleWorkspaceRootCommitted);
      }
      if (boundCrumbHost) {
        boundCrumbHost.removeEventListener('click', handleCrumbClick);
        boundCrumbHost = null;
      }
      clearCrumb();
      picker?.dispose();
      symbols = null;
      navTreeCache.clear();
      navTreeCacheHits = 0;
      navTreeCacheMisses = 0;
    }

    return {
      handleMonacoReady,
      render: scheduleRender,
      openPicker,
      bindEvents,
      dispose,
      stats: () => ({
        navTreeCacheHits,
        navTreeCacheMisses,
        navTreeCacheSize: navTreeCache.size,
      }),
    };
  }

  return {
    createIdeSymbolNav,
    // Pure helpers exported for unit tests (no Monaco dependency).
    findBreadcrumbPath,
    flattenNavigationTree,
    symbolRowModel,
    rankSymbols,
    symbolKindLabel,
  };
});
