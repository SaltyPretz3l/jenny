/* renderer/features/renderer-ide-search-panel.js - Workspace IDE find-AND-
 * replace panel. Renders the query + replace fields (inventory text-field
 * primitives), the literal/regex/case toggle chips, per-match/per-file/Replace
 * All actions, and the grouped match list with an inline before/after preview
 * into the rail panel. Literal find debounces workspaceFs.searchInFiles; regex
 * find + every replace/undo is delegated to the panel-owned replace controller
 * (renderer-ide-replace-controller). Search + replace state lives on the
 * runtime ide.search slice and never persists. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeSearchPanel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  const SEARCH_DEBOUNCE_MS = 300;
  const MIN_QUERY_LENGTH = 2;

  function resolveTextField() {
    if (typeof globalRef.inventoryTextField === 'function') {
      return globalRef.inventoryTextField;
    }
    if (typeof require === 'function') {
      try {
        return require('../inventory/text-field');
      } catch (_error) {
        /* unavailable */
      }
    }
    return null;
  }

  function resolveActionButton() {
    if (typeof globalRef.inventoryActionButton === 'function') {
      return globalRef.inventoryActionButton;
    }
    if (typeof require === 'function') {
      try {
        return require('../inventory/action-button');
      } catch (_error) {
        /* unavailable */
      }
    }
    return null;
  }

  function resolveReplaceController() {
    if (globalRef.rendererIdeReplaceController) {
      return globalRef.rendererIdeReplaceController;
    }
    if (typeof require === 'function') {
      try {
        return require('./renderer-ide-replace-controller');
      } catch (_error) {
        /* unavailable */
      }
    }
    return null;
  }

  function fileNameOf(path) {
    const normalized = String(path || '');
    return normalized.split('/').pop() || normalized;
  }

  function parentDirOf(path) {
    const index = String(path || '').lastIndexOf('/');
    return index === -1 ? '' : String(path).slice(0, index);
  }

  function createIdeSearchPanel(deps) {
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const getApi = typeof deps?.getWorkspaceFsApi === 'function' ? deps.getWorkspaceFsApi : () => null;
    // Host + active-gate are injectable so the single search instance can render
    // into the secondary sidebar when moved there (the "Move View" model); both
    // default to the primary rail for standalone use.
    const getMountEl = typeof deps?.getMountEl === 'function' ? deps.getMountEl : () => getDom().ideRailPanel;
    const isActivePanel = typeof deps?.isActivePanel === 'function'
      ? deps.isActivePanel
      : () => getIde().railPanel === 'search';
    const escapeHtml = typeof deps?.escapeHtml === 'function'
      ? deps.escapeHtml
      : (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const onOpenResult = typeof deps?.onOpenResult === 'function' ? deps.onOpenResult : noop;
    const appendClientLog = typeof deps?.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const editorHost = deps?.editorHost || null;
    const renderTabs = typeof deps?.renderTabs === 'function' ? deps.renderTabs : noop;
    const isSavingDep = typeof deps?.isSaving === 'function' ? deps.isSaving : () => false;
    // Find-in-Folder activates the search rail via the controller (which owns rail
    // state + renderIde); noop in standalone use where the panel is already shown.
    const onActivateSearch = typeof deps?.onActivateSearch === 'function' ? deps.onActivateSearch : noop;
    const textField = resolveTextField();
    const actionButton = resolveActionButton();

    // The panel owns its replace controller (keeps the IDE controller under the
    // line cap). renderSearchPanel/runSearch are hoisted declarations, so the
    // callback arrows below resolve fine even though they are referenced here
    // before those functions appear textually.
    const replaceControllerUtils = resolveReplaceController();
    const replaceController = replaceControllerUtils?.createIdeReplaceController?.({
      getIde: () => getIde(),
      getWorkspaceFsApi: () => getApi(),
      getFileOperations: () => deps?.getFileOperations?.(),
      editorHost,
      callbacks: {
        appendClientLog,
        renderSearchPanel: () => renderSearchPanel(),
        requestFindRefresh: () => runSearch(),
        renderTabs,
        isSaving: isSavingDep,
        schedulePersist: () => deps?.schedulePersist?.(),
        flushPersist: () => deps?.flushPersist?.(),
        showShellErrorToast: (...args) => deps?.showShellErrorToast?.(...args),
      },
    }) || null;

    let boundHosts = [];
    let debounceTimer = null;
    let searchSeq = 0;
    // Set once dispose() runs: makes the "don't act after teardown" intent
    // explicit at the top of the async/render entry points, on top of the
    // searchSeq bump (which already invalidates any in-flight literal search).
    let disposed = false;
    const collapsedFiles = new Set();
    // The query/replace input with an open IME composition (null otherwise):
    // its input events defer to compositionend and a re-render never writes it.
    let composingEl = null;
    // What this instance last painted in full: { root, scope, toolbar, tail }.
    let painted = null;

    // Runtime-only fields beyond the seeded { query, results, busy } slice. The
    // replace controller seeds the remaining replace fields (replacing,
    // replaceSummary, replaceError, lastReplace, canUndo) on first use.
    function getSearchState() {
      const ide = getIde();
      if (!ide.search || typeof ide.search !== 'object') {
        ide.search = { query: '', results: [], busy: false };
      }
      const search = ide.search;
      if (typeof search.replaceText !== 'string') search.replaceText = '';
      if (typeof search.caseSensitive !== 'boolean') search.caseSensitive = false;
      if (typeof search.useRegex !== 'boolean') search.useRegex = false;
      // Find-in-Folder scope: a workspace-root-relative folder path that narrows
      // the search; '' = whole workspace. Runtime-only (never persisted).
      if (typeof search.scope !== 'string') search.scope = '';
      return search;
    }

    function currentReplaceOpts() {
      const search = getSearchState();
      return {
        query: search.ranQuery || search.query,
        replaceText: search.replaceText,
        useRegex: search.useRegex,
        caseSensitive: search.caseSensitive,
      };
    }

    function buildPreviewMarkup(preview) {
      const text = String(preview?.text ?? '');
      const start = Math.max(0, Math.min(text.length, Number(preview?.matchStart) || 0));
      const end = Math.max(start, Math.min(text.length, Number(preview?.matchEnd) || 0));
      return escapeHtml(text.slice(0, start))
        + `<span class="ide-search-hit">${escapeHtml(text.slice(start, end))}</span>`
        + escapeHtml(text.slice(end));
    }

    // Before/after preview: struck old hit + green replacement, computed through
    // the replace controller. Falls back to the plain hit when the controller
    // cannot compute (e.g. mid-edit invalid regex).
    function buildReplacePreviewMarkup(match, search) {
      const preview = match.preview || {};
      const text = String(preview.text ?? '');
      const start = Math.max(0, Math.min(text.length, Number(preview.matchStart) || 0));
      const end = Math.max(start, Math.min(text.length, Number(preview.matchEnd) || 0));
      let replacement;
      try {
        replacement = String(replaceController?.computeReplacementForMatch?.(match, {
          query: search.ranQuery || search.query,
          replaceText: search.replaceText,
          useRegex: search.useRegex,
          caseSensitive: search.caseSensitive,
        }) ?? '');
      } catch (_error) {
        return buildPreviewMarkup(preview);
      }
      return escapeHtml(text.slice(0, start))
        + `<span class="ide-search-hit ide-search-replace-before">${escapeHtml(text.slice(start, end))}</span>`
        + `<span class="ide-search-replace-after">${escapeHtml(replacement)}</span>`
        + escapeHtml(text.slice(end));
    }

    function buildStatusMarkup(search) {
      let text;
      let cls = 'ide-search-status';
      if (search.replaceError) {
        text = search.replaceError;
        cls += ' ide-search-status--error';
      } else if (search.replacing) {
        text = 'Replacing…';
      } else if (search.replaceSummary) {
        text = search.replaceSummary;
        cls += ' ide-search-status--ok';
      } else if (search.busy) {
        text = 'Searching…';
      } else if (search.error) {
        text = search.error;
        cls += ' ide-search-status--error';
      } else if (search.ranQuery) {
        const count = search.results.length;
        text = count
          ? jtn('ide.search.matchCountInFiles', count, { count, files: jtn('ide.search.fileCount', search.fileCount, { count: search.fileCount }, '{count} file', '{count} files'), capped: search.limitHit ? jt('ide.search.cappedSuffix', ' (capped)') : '' }, '{count} match in {files}{capped}', '{count} matches in {files}{capped}')
          : jt('ide.search.noMatches', 'No matches.');
      } else {
        text = jt('ide.search.prompt', 'Search across workspace files.');
      }
      return `<div class="${cls}">${escapeHtml(text)}</div>`;
    }

    // Toggle chips (case / regex) + Replace All + Undo. Toggles clone the rail
    // activity-button pattern (plain button + aria-pressed). Action buttons
    // carry data-ide-replace-action for click delegation.
    function buildReplaceToolbarMarkup(search) {
      if (typeof actionButton !== 'function') {
        return '';
      }
      const hasResults = search.results.length > 0;
      const hasFind = String(search.query || '').trim().length >= MIN_QUERY_LENGTH;
      // Also disabled while a find is in flight (search.busy): the visible
      // results are stale mid-find, so acting on them could replace text the
      // panel isn't currently showing.
      const replaceDisabled = !hasResults || !hasFind || search.replacing === true || search.busy === true;
      const caseChip = actionButton({
        plain: true,
        className: `ide-search-toggle${search.caseSensitive ? ' ide-search-toggle--active' : ''}`,
        ariaPressed: search.caseSensitive === true,
        label: jt('ide.search.matchCaseGlyph', 'Aa'),
        title: jt('ide.search.matchCase', 'Match case'),
        dataset: { 'ide-replace-action': 'toggle-case' },
      });
      const regexChip = actionButton({
        plain: true,
        className: `ide-search-toggle${search.useRegex ? ' ide-search-toggle--active' : ''}`,
        ariaPressed: search.useRegex === true,
        label: '.*',
        title: jt('ide.search.useRegularExpression', 'Use regular expression'),
        dataset: { 'ide-replace-action': 'toggle-regex' },
      });
      const replaceAll = actionButton({
        label: jt('ide.search.replaceAll', 'Replace All'),
        variant: 'primary',
        size: 'sm',
        disabled: replaceDisabled,
        dataset: { 'ide-replace-action': 'replace-all' },
      });
      const undo = search.canUndo === true
        ? actionButton({
          label: jt('ide.search.undoReplace', 'Undo replace'),
          size: 'sm',
          dataset: { 'ide-replace-action': 'undo' },
        })
        : '';
      return '<div class="ide-search-toolbar">'
        + `<span class="ide-search-toggles">${caseChip}${regexChip}</span>`
        + `<span class="ide-search-actions">${replaceAll}${undo}</span>`
        + '</div>';
    }

    function buildResultsMarkup(search) {
      if (!search.results.length) {
        return '';
      }
      const hasReplace = typeof actionButton === 'function';
      const byFile = new Map();
      for (const result of search.results) {
        if (!byFile.has(result.path)) {
          byFile.set(result.path, []);
        }
        byFile.get(result.path).push(result);
      }
      let markup = '';
      for (const [path, matches] of byFile) {
        const collapsed = collapsedFiles.has(path);
        const dirHint = parentDirOf(path);
        // UIUX-037: the row-activation control (toggle collapse) and the
        // per-file replace action are semantic SIBLINGS, not nested
        // interactives -- role="button" lives on the activation span only,
        // the replace action stays a real button element. Enter/Space on the
        // activation span is wired by hand in handleKeydown below (a plain
        // span has no native key activation, so there's no double-fire risk
        // with the replace button's native button semantics).
        markup += `<div class="ide-search-file${collapsed ? ' ide-search-file--collapsed' : ''}">`
          + `<span class="ide-search-file-activate" role="button" tabindex="0"`
          + ` data-ide-search-file="${escapeHtml(path)}" title="${escapeHtml(path)}"`
          + ` aria-expanded="${collapsed ? 'false' : 'true'}">`
          + `<span class="ide-search-file-twisty" aria-hidden="true">${collapsed ? '▸' : '▾'}</span>`
          + `<span class="ide-search-file-name">${escapeHtml(fileNameOf(path))}</span>`
          + (dirHint ? `<span class="ide-search-file-dir">${escapeHtml(dirHint)}</span>` : '')
          + `<span class="ide-search-file-count">${matches.length}</span>`
          + '</span>'
          + (hasReplace ? actionButton({
            plain: true,
            className: 'ide-search-file-replace',
            title: jt('ide.search.replaceAllInFile', 'Replace all in this file'),
            ariaLabel: jt('ide.search.replaceAllInNamedFile', 'Replace all in {name}', { name: fileNameOf(path) }),
            trustedHtml: '<span aria-hidden="true">&#8618;</span>',
            dataset: { 'ide-replace-file': path },
          }) : '')
          + '</div>';
        if (collapsed) {
          continue;
        }
        for (const match of matches) {
          markup += '<div class="ide-search-match">'
            + `<span class="ide-search-match-activate" role="button" tabindex="0"`
            + ` data-ide-search-path="${escapeHtml(match.path)}"`
            + ` data-ide-search-line="${Number(match.line) || 1}"`
            + ` data-ide-search-column="${Number(match.column) || 1}">`
            + `<span class="ide-search-match-line">${Number(match.line) || 1}</span>`
            + `<span class="ide-search-match-preview">${hasReplace ? buildReplacePreviewMarkup(match, search) : buildPreviewMarkup(match.preview)}</span>`
            + '</span>'
            + (hasReplace ? actionButton({
              plain: true,
              className: 'ide-search-match-replace',
              title: jt('ide.search.replaceOccurrence', 'Replace this occurrence'),
              ariaLabel: jt('ide.search.replaceOccurrence', 'Replace this occurrence'),
              trustedHtml: '<span aria-hidden="true">&#8618;</span>',
              dataset: {
                'ide-replace-match': '1',
                'ide-replace-path': match.path,
                'ide-replace-line': String(Number(match.line) || 1),
                'ide-replace-column': String(Number(match.column) || 1),
              },
            }) : '')
            + '</div>';
        }
      }
      return `<div class="ide-search-results">${markup}</div>`;
    }

    // The panel split into regions so a re-render can patch the stable parts
    // (query/replace inputs, option toggles) in place and swap only the scope
    // chip or the status + results tail when they change.
    function buildPanelParts() {
      const search = getSearchState();
      const placeholder = search.scope ? jt('ide.search.searchInScope', 'Search in {scope}', { scope: search.scope }) : jt('ide.search.searchInWorkspace', 'Search in workspace');
      const field = typeof textField === 'function'
        ? textField({
          className: 'ide-search-field',
          value: search.query,
          placeholder,
          ariaLabel: jt('ide.search.searchInWorkspace', 'Search in workspace'),
          maxLength: 256,
          dataset: { 'ide-search-input': '1' },
        })
        : '';
      // Find-in-Folder scope pill: the whole chip is the clear control (clicking
      // it drops back to a whole-workspace search). actionButton escapes the label.
      const scopeChip = search.scope && typeof actionButton === 'function'
        ? actionButton({
          plain: true,
          className: 'ide-search-scope-chip',
          label: search.scope,
          title: jt('ide.search.scopeClearTitle', 'Search scope: {scope} — click to clear', { scope: search.scope }),
          ariaLabel: jt('ide.search.clearScopeLabel', 'Clear search scope {scope}', { scope: search.scope }),
          dataset: { 'ide-search-clear-scope': '1' },
        })
        : '';
      const replaceField = typeof textField === 'function'
        ? textField({
          className: 'ide-search-replace-field',
          value: search.replaceText,
          placeholder: jt('ide.search.replace', 'Replace'),
          ariaLabel: jt('ide.search.replaceInWorkspace', 'Replace in workspace'),
          maxLength: 256,
          dataset: { 'ide-replace-input': '1' },
        })
        : '';
      return {
        search,
        placeholder,
        field,
        scopeChip,
        replaceField,
        toolbar: buildReplaceToolbarMarkup(search),
        tail: buildStatusMarkup(search) + buildResultsMarkup(search),
      };
    }

    function panelMarkupOf(parts) {
      return `<div class="ide-search">${parts.field}${parts.scopeChip}${parts.replaceField}`
        + `${parts.toolbar}${parts.tail}</div>`;
    }

    // Attribute/text morph for the small toolbar: the toggle chips and Replace
    // All keep their identity (and focus); an appearing/disappearing Undo is
    // appended/removed.
    function morphElement(oldEl, newEl) {
      if (oldEl.tagName !== newEl.tagName) {
        oldEl.replaceWith(newEl);
        return;
      }
      for (const attr of Array.from(oldEl.attributes)) if (!newEl.hasAttribute(attr.name)) oldEl.removeAttribute(attr.name);
      for (const attr of Array.from(newEl.attributes)) if (oldEl.getAttribute(attr.name) !== attr.value) oldEl.setAttribute(attr.name, attr.value);
      const oldKids = Array.from(oldEl.children);
      const newKids = Array.from(newEl.children);
      if (oldEl.childNodes.length !== oldKids.length || newEl.childNodes.length !== newKids.length || !newKids.length) {
        if (oldEl.innerHTML !== newEl.innerHTML) oldEl.innerHTML = newEl.innerHTML;
        return;
      }
      newKids.forEach((newKid, index) => {
        if (oldKids[index]) morphElement(oldKids[index], newKid);
        else oldEl.appendChild(newKid);
      });
      oldKids.slice(newKids.length).forEach((kid) => kid.remove());
    }

    // Still our panel in this host: the query/replace inputs stay the same
    // nodes (value written only on a programmatic change, e.g. Escape or a root
    // reset, and never mid-composition, so focus/caret/IME survive), the
    // toolbar is morphed, and the scope chip / status + results swap alone.
    function patchPainted(panel, parts) {
      const root = painted?.root?.parentNode === panel && panel.childElementCount === 1 ? painted.root : null;
      const queryEl = root?.querySelector(':scope > label > [data-ide-search-input]');
      const replaceEl = root?.querySelector(':scope > label > [data-ide-replace-input]');
      const toolbarEl = root?.querySelector(':scope > .ide-search-toolbar');
      if (!queryEl || !replaceEl || !toolbarEl) return false;
      [[queryEl, parts.search.query], [replaceEl, parts.search.replaceText]].forEach(([input, value]) => {
        if (input !== composingEl && input.value !== value) input.value = value;
      });
      if (queryEl.getAttribute('placeholder') !== parts.placeholder) queryEl.setAttribute('placeholder', parts.placeholder);
      if (painted.scope !== parts.scopeChip) {
        root.querySelector(':scope > .ide-search-scope-chip')?.remove();
        if (parts.scopeChip) queryEl.closest('label').insertAdjacentHTML('afterend', parts.scopeChip);
      }
      if (painted.toolbar !== parts.toolbar) {
        const probe = panel.ownerDocument.createElement('template');
        probe.innerHTML = parts.toolbar;
        if (probe.content.firstElementChild) morphElement(toolbarEl, probe.content.firstElementChild);
      }
      if (painted.tail !== parts.tail) {
        while (toolbarEl.nextSibling) toolbarEl.nextSibling.remove();
        toolbarEl.insertAdjacentHTML('afterend', parts.tail);
      }
      return true;
    }

    function renderSearchPanel() {
      // Exported/called by the controller (not just internally) — a disposed
      // guard here is cheap insurance against a post-teardown render.
      if (disposed) return;
      const panel = getMountEl() || null;
      if (!panel || !isActivePanel()) {
        return;
      }
      if (replaceController?.isReplacing?.() !== true) replaceController?.checkRecovery?.();
      const parts = buildPanelParts();
      const markup = panelMarkupOf(parts);
      if (panel.__jennyIdeRailMarkup === markup) {
        return;
      }
      if (!patchPainted(panel, parts)) {
        // Full paint (first paint, or another panel painted this host). A focused
        // query/replace input (the panel moved hosts) takes focus + selection back.
        const activeEl = panel.ownerDocument?.activeElement || null;
        const activeKey = ['[data-ide-replace-input]', '[data-ide-search-input]'].find((sel) => activeEl?.closest?.(sel)) || null;
        const selection = activeKey ? [activeEl.selectionStart, activeEl.selectionEnd] : null;
        panel.innerHTML = markup;
        painted = { root: panel.firstElementChild };
        // The composing input (if any) was just replaced; its compositionend never
        // arrives, so the flag must not keep blocking Enter/Escape and input events.
        composingEl = null;
        const input = activeKey ? panel.querySelector(activeKey) : null;
        if (input) {
          input.focus();
          try {
            input.setSelectionRange(selection[0], selection[1]);
          } catch (_error) {
            /* selection restore is best-effort */
          }
        }
      }
      Object.assign(painted, { scope: parts.scopeChip, toolbar: parts.toolbar, tail: parts.tail });
      panel.__jennyIdeRailMarkup = markup;
    }

    async function runSearch() {
      // Belt-and-suspenders: the searchSeq bump on dispose already invalidates
      // any in-flight await (see the seq !== searchSeq checks below), but a
      // fresh call after teardown should never even start a new request.
      if (disposed) return;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      // Invalidate any in-flight regex find (either mode) so a mode switch
      // mid-find can't let a stale scan write old results back to the slice.
      replaceController?.invalidateFind?.();
      const search = getSearchState();
      const query = String(search.query || '');
      if (query.trim().length < MIN_QUERY_LENGTH) {
        searchSeq += 1;
        search.results = [];
        search.busy = false;
        search.ranQuery = '';
        search.error = '';
        search.fileCount = 0;
        search.limitHit = false;
        collapsedFiles.clear();
        renderSearchPanel();
        return;
      }
      // Regex mode: the replace controller scans files client-side and fills the
      // same { results, fileCount, limitHit } shape. Literal mode keeps the
      // native, debounced searchInFiles (now case-aware via the toggle).
      if (search.useRegex && replaceController?.runRegexFind) {
        searchSeq += 1; // invalidate any in-flight literal search
        collapsedFiles.clear();
        // Regex scan is client-side, so scope is a path-prefix filter the controller applies.
        await replaceController.runRegexFind({ query, caseSensitive: search.caseSensitive, scope: search.scope || '' });
        return;
      }
      const api = getApi();
      if (typeof api?.searchInFiles !== 'function') {
        search.busy = false;
      search.error = jt('ide.replace.searchUnavailable', 'Workspace search is unavailable in this shell mode.');
        renderSearchPanel();
        return;
      }
      searchSeq += 1;
      const seq = searchSeq;
      search.busy = true;
      search.error = '';
      renderSearchPanel();
      try {
        // Only thread caseSensitive / scope when set so the default payload stays
        // exactly { query } (case-insensitive, whole-workspace backend default) —
        // keeps callers/tests stable. Scope is added only for a Find-in-Folder.
        const payload = search.caseSensitive ? { query, caseSensitive: true } : { query };
        if (search.scope) payload.scope = search.scope;
        const result = await api.searchInFiles(payload);
        if (seq !== searchSeq) {
          return; // a newer query superseded this one
        }
        search.results = Array.isArray(result?.results) ? result.results : [];
        search.fileCount = Number(result?.fileCount) || 0;
        search.limitHit = result?.limitHit === true;
        search.ranQuery = query;
        collapsedFiles.clear();
      } catch (error) {
        if (seq !== searchSeq) {
          return;
        }
        search.results = [];
      search.error = jt('ide.replace.searchFailed', 'Search failed.');
        appendClientLog('WARN', 'ide.search_failed', {
          message: String(error?.message || error || ''),
        });
      } finally {
        if (seq === searchSeq) {
          search.busy = false;
          renderSearchPanel();
        }
      }
    }

    function scheduleSearch() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        runSearch();
      }, SEARCH_DEBOUNCE_MS);
    }

    // Never act on results while a find is in flight (they are stale until the
    // find resolves) — the controller separately guards against re-entrant
    // replaces and concurrent saves.
    function replaceBlocked() {
      const search = getSearchState();
      return search.busy === true || String(search.ranQuery || '') !== String(search.query || '');
    }

    function requestReplaceAll() {
      if (replaceBlocked()) return undefined;
      return replaceController?.replaceAll?.(currentReplaceOpts());
    }

    function requestReplaceFile(path) {
      if (replaceBlocked()) return undefined;
      return replaceController?.replaceInFile?.(path, currentReplaceOpts());
    }

    function requestReplaceMatch(path, line, column) {
      if (replaceBlocked()) return undefined;
      return replaceController?.replaceMatch?.(path, line, column, currentReplaceOpts());
    }

    function requestUndo() {
      return replaceController?.undoLastReplace?.();
    }

    function handleInput(event) {
      // Mid-composition keystrokes wait for compositionend (no preview rebuild
      // or search per partial IME character).
      if (event.isComposing === true || (composingEl && event.target === composingEl)) {
        return;
      }
      const replaceInput = event.target?.closest?.('[data-ide-replace-input]');
      if (replaceInput) {
        getSearchState().replaceText = String(replaceInput.value || '');
        renderSearchPanel(); // refresh before/after previews; no new search
        return;
      }
      const input = event.target?.closest?.('[data-ide-search-input]');
      if (!input) {
        return;
      }
      const search = getSearchState();
      search.query = String(input.value || '');
      search.replaceSummary = ''; // a stale replace summary clears on a new query
      search.replaceError = '';
      search.busy = true;
      scheduleSearch();
    }

    function isPanelInput(target) {
      return Boolean(target?.closest?.('[data-ide-replace-input], [data-ide-search-input]'));
    }

    function handleCompositionStart(event) {
      if (isPanelInput(event.target)) composingEl = event.target;
    }

    function handleCompositionEnd(event) {
      if (!isPanelInput(event.target)) return;
      composingEl = null;
      handleInput({ target: event.target });
    }

    function handleKeydown(event) {
      // An IME confirms its composition with Enter (and cancels with Escape):
      // those keys belong to the IME, never to Replace All / search / clear.
      if (isPanelInput(event.target) && (event.isComposing || event.keyCode === 229 || composingEl)) {
        return;
      }
      const replaceInput = event.target?.closest?.('[data-ide-replace-input]');
      if (replaceInput) {
        if (event.key === 'Enter') {
          event.preventDefault();
          requestReplaceAll();
        }
        return;
      }
      const input = event.target?.closest?.('[data-ide-search-input]');
      if (input) {
        if (event.key === 'Enter') {
          event.preventDefault();
          runSearch();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          const search = getSearchState();
          search.query = '';
          search.replaceSummary = '';
          search.replaceError = '';
          runSearch();
        }
        return;
      }
      // UIUX-037: file-group toggle and match-open are custom role="button"
      // spans (see buildResultsMarkup) so Enter/Space activation isn't native
      // -- re-dispatch through the same click delegation handleClick already
      // owns, rather than duplicating the open/toggle logic here. The
      // per-row replace button element is a sibling, not an ancestor of
      // these spans, so it never matches this closest() and keeps its own
      // native Enter/Space (a real button) with no double-fire.
      if (event.key === 'Enter' || event.key === ' ') {
        const activateEl = event.target?.closest?.('[data-ide-search-file], [data-ide-search-path]');
        if (activateEl) {
          event.preventDefault();
          activateEl.click();
        }
      }
    }

    // Delegation order is load-bearing: the per-match and per-file replace
    // button elements render as SIBLINGS of the clickable open/toggle activation
    // spans (not nested inside them, per UIUX-037), so their checks must
    // precede the row checks (each with an early return) -- a click landing
    // on a replace button must never also open the file / collapse the group.
    function handleClick(event) {
      // Scope chip (not nested in any result row): clicking it clears the
      // Find-in-Folder scope and re-runs the query against the whole workspace.
      const scopeClearBtn = event.target?.closest?.('[data-ide-search-clear-scope]');
      if (scopeClearBtn) {
        getSearchState().scope = '';
        runSearch();
        return;
      }
      const toolbarBtn = event.target?.closest?.('[data-ide-replace-action]');
      if (toolbarBtn) {
        const kind = toolbarBtn.dataset.ideReplaceAction;
        const search = getSearchState();
        if (kind === 'toggle-case') {
          search.caseSensitive = !search.caseSensitive;
          search.replaceSummary = '';
          search.replaceError = '';
          runSearch();
        } else if (kind === 'toggle-regex') {
          search.useRegex = !search.useRegex;
          search.replaceSummary = '';
          search.replaceError = '';
          runSearch();
        } else if (kind === 'replace-all') {
          requestReplaceAll();
        } else if (kind === 'undo') {
          requestUndo();
        }
        return;
      }
      const matchReplaceBtn = event.target?.closest?.('[data-ide-replace-match]');
      if (matchReplaceBtn) {
        requestReplaceMatch(
          matchReplaceBtn.dataset.ideReplacePath,
          Number(matchReplaceBtn.dataset.ideReplaceLine) || 1,
          Number(matchReplaceBtn.dataset.ideReplaceColumn) || 1
        );
        return;
      }
      const fileReplaceBtn = event.target?.closest?.('[data-ide-replace-file]');
      if (fileReplaceBtn) {
        requestReplaceFile(fileReplaceBtn.dataset.ideReplaceFile);
        return;
      }
      const fileRow = event.target?.closest?.('[data-ide-search-file]');
      if (fileRow) {
        const path = fileRow.dataset.ideSearchFile;
        if (collapsedFiles.has(path)) {
          collapsedFiles.delete(path);
        } else {
          collapsedFiles.add(path);
        }
        renderSearchPanel();
        return;
      }
      const matchRow = event.target?.closest?.('[data-ide-search-path]');
      if (matchRow) {
        onOpenResult(
          matchRow.dataset.ideSearchPath,
          Number(matchRow.dataset.ideSearchLine) || 1,
          Number(matchRow.dataset.ideSearchColumn) || 1
        );
      }
    }

    // Bind BOTH possible hosts (rail + secondary) once: the panel can be moved
    // between them at runtime; delegation survives innerHTML swaps and the
    // handlers self-filter (closest), so a moved panel stays live with no rebind.
    function bindEvents() {
      const dom = getDom();
      const hosts = [dom.ideRailPanel, dom.ideSecondarySidebarPanel].filter(Boolean);
      if (!hosts.length || boundHosts.length) {
        return;
      }
      boundHosts = hosts;
      for (const host of hosts) {
        host.addEventListener('input', handleInput);
        host.addEventListener('keydown', handleKeydown);
        host.addEventListener('click', handleClick);
        host.addEventListener('compositionstart', handleCompositionStart);
        host.addEventListener('compositionend', handleCompositionEnd);
      }
    }

    function resetForRoot() {
      searchSeq += 1;
      replaceController?.resetForRoot?.();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      collapsedFiles.clear();
      const search = getSearchState();
      search.query = '';
      search.ranQuery = '';
      search.scope = '';
      search.results = [];
      search.busy = false;
    }

    function dispose() {
      disposed = true;
      // Bump searchSeq so any in-flight literal search's post-await checks
      // (seq !== searchSeq) bail instead of writing stale results back.
      searchSeq += 1;
      // Invalidate any in-flight regex find the replace controller is running.
      replaceController?.invalidateFind?.();
      // Cancel any in-flight replace/undo loop so it stops writing further
      // files once this panel (and the controller that owns it) is torn down.
      replaceController?.dispose?.();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      for (const host of boundHosts) {
        host.removeEventListener('input', handleInput);
        host.removeEventListener('keydown', handleKeydown);
        host.removeEventListener('click', handleClick);
        host.removeEventListener('compositionstart', handleCompositionStart);
        host.removeEventListener('compositionend', handleCompositionEnd);
      }
      boundHosts = [];
    }

    // Find-in-Folder entry point (called from the file-tree directory context
    // menu via the controller): scope the search to a folder, activate the search
    // rail, and re-run the current query within it. An empty query just shows the
    // scope chip and waits for the user to type, so focus lands in the query
    // input (like Ctrl+Shift+F): when Explorer and Search share a host, the
    // focused tree row was just replaced and focus would otherwise drop to body.
    function beginScopedSearch(folderPath) {
      const search = getSearchState();
      search.scope = String(folderPath || '');
      // Drop the previous (unscoped or other-folder) results so the transition
      // never flashes stale matches under the new scope chip; runSearch (or its
      // empty-query short-circuit) repaints with the scoped state. onActivateSearch
      // already triggers a renderIde, so no explicit render is needed here.
      search.results = [];
      search.ranQuery = '';
      search.busy = false;
      onActivateSearch();
      runSearch();
      getMountEl()?.querySelector?.('[data-ide-search-input]')?.focus?.();
    }

    return {
      bindEvents,
      dispose,
      resetForRoot,
      renderSearchPanel,
      runSearch,
      beginScopedSearch,
      isReplacing: () => replaceController?.isReplacing?.() === true,
    };
  }

  return {
    MIN_QUERY_LENGTH,
    SEARCH_DEBOUNCE_MS,
    createIdeSearchPanel,
  };
});
