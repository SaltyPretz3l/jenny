/* renderer/features/renderer-ide-suggestion-diff.js
 * Suggested changes in the Workspace editor (row 35 Plan Plus W2; UI spec §3.4).
 *
 * One diff tab per chat ("{file} · suggested change"): the left side is the
 * file on disk now, the right side is the file with the suggestion applied.
 * Nothing is written here; Accept goes through the shared suggestions client
 * to Electron, which applies through the sidecar's journaled write.
 *
 * The tab's context is {sessionId, id, revision}: switching the dock's chat
 * never retargets an open bar. The diff controller creates this module and
 * lets it render #ideDiffToolbar whenever the active tab is a suggestion tab.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeSuggestionDiff = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  function noop() {}

  function toLf(value) {
    return String(value == null ? '' : value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  /**
   * The suggested file text, mirroring the apply's single replacement (a
   * whole-line delete also takes its newline). null when the old text does not
   * occur exactly once, counted without overlap like the sidecar's match, so
   * the tab says the suggestion no longer matches.
   */
  function applySuggestion(diskLf, entry) {
    if (entry.kind === 'create') return toLf(entry.new_string);
    const old = toLf(entry.old_string);
    const next = toLf(entry.new_string);
    if (!old) return null;
    const start = diskLf.indexOf(old);
    if (start < 0 || diskLf.indexOf(old, start + old.length) >= 0) return null;
    let end = start + old.length;
    if (next === '' && !old.endsWith('\n') && (start === 0 || diskLf[start - 1] === '\n') && diskLf[end] === '\n') end += 1;
    return diskLf.slice(0, start) + next + diskLf.slice(end);
  }

  function createIdeSuggestionDiff(deps = {}) {
    const getIde = typeof deps.getIde === 'function' ? deps.getIde : () => ({});
    const getDom = typeof deps.getDom === 'function' ? deps.getDom : () => ({});
    const editorHost = deps.editorHost || null;
    const showDiffTab = deps.showDiffTab || ((id) => editorHost.activateDocument(id));
    const getFileOperations = typeof deps.getFileOperations === 'function' ? deps.getFileOperations : () => null;
    const getWorkspaceFsApi = typeof deps.getWorkspaceFsApi === 'function' ? deps.getWorkspaceFsApi : () => null;
    const ideStateUtils = deps.ideStateUtils || {};
    const renderTabs = typeof deps.renderTabs === 'function' ? deps.renderTabs : noop;
    const appendClientLog = typeof deps.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const getClient = typeof deps.getClient === 'function'
      ? deps.getClient
      : () => globalThis.rendererSuggestedChangesClient?.getSharedClient?.() || null;
    const createBar = typeof deps.createBarController === 'function'
      ? deps.createBarController
      : (options) => globalThis.rendererSuggestionBarController?.createSuggestionBarController?.(options) || null;

    const contexts = new Map(); // tab id -> { sessionId, id, revision, path, previewMissing }
    const opening = new Map(); // tab id -> revision being opened (no re-entrant reopen)
    let bar = null;
    let unsubscribe = null;
    const boundElements = new WeakSet();
    let epoch = 1;
    let disposed = false;

    const prefix = () => ideStateUtils.DIFF_TAB_PREFIX || 'diff://';
    const tabIdFor = (sessionId) => `${prefix()}suggestion/${sessionId}`;
    const fileNameOf = (path) => ideStateUtils.fileNameOf?.(path) || String(path || '').split('/').pop();

    function ensureBar() {
      if (bar || disposed) return bar;
      const client = getClient();
      if (!client) return null;
      bar = createBar({ client, onNavigate: (sessionId, id) => { openSuggestion(sessionId, id); } });
      unsubscribe = client.subscribe((sessionId) => onClientChange(sessionId));
      return bar;
    }

    function entryFor(sessionId, id) {
      const list = getClient()?.get(sessionId);
      return list && Array.isArray(list.entries) ? list.entries.find((entry) => entry.id === id) || null : null;
    }

    async function readDisk(path) {
      const api = getWorkspaceFsApi();
      const payload = getFileOperations()
        ? await getFileOperations().readForMutation(path)
        : await api.readFile({ path });
      return toLf(payload && payload.content);
    }

    /** Opens (or retargets) the chat's suggestion tab on one suggestion. */
    async function openSuggestion(sessionId, id) {
      const client = getClient();
      if (disposed || !editorHost || !client || !sessionId || !id) return false;
      ensureBar();
      let entry = entryFor(sessionId, id);
      if (!entry) {
        await client.refresh(sessionId);
        entry = entryFor(sessionId, id);
      }
      if (!entry) return false;
      const tabId = tabIdFor(sessionId);
      const revision = Number(entry.revision) || 1;
      opening.set(tabId, revision);
      client.setCurrent(sessionId, id);
      epoch += 1;
      const opened = epoch;
      let disk = '';
      let exists = true;
      try {
        disk = await readDisk(entry.path);
      } catch (error) {
        exists = false;
        if (entry.kind !== 'create') {
          appendClientLog('WARN', 'ide.suggestion_diff_read_failed', { code: String(error?.code || 'read_failed').slice(0, 64) });
        }
      }
      if (disposed || opened !== epoch) { if (opening.get(tabId) === revision) opening.delete(tabId); return false; }
      const suggested = exists || entry.kind === 'create' ? applySuggestion(exists ? disk : '', entry) : null;
      let placeholderText = '';
      if (entry.kind === 'create' && exists) {
        placeholderText = jt('ide.suggestion.fileExists', 'A file with this name already exists now, so this new file can’t be added as suggested.');
      } else if (suggested === null) {
        placeholderText = exists
          ? jt('ide.suggestion.noLongerMatches', 'This suggestion no longer matches the file on disk.')
          : jt('ide.suggestion.fileMissing', 'The file this suggestion changes is missing.');
      }
      const label = jt('ide.suggestion.tabLabel', '{file} · suggested change', { file: fileNameOf(entry.path) });
      await editorHost.openDiffDocument({
        id: tabId,
        label,
        languagePath: entry.path,
        original: entry.kind === 'create' && !exists ? '' : disk,
        modified: placeholderText ? disk : suggested,
        placeholderText,
        shouldApply: () => !disposed && opened === epoch,
      });
      if (opening.get(tabId) === revision) opening.delete(tabId);
      if (disposed || opened !== epoch) return false;
      contexts.set(tabId, { sessionId, id, revision, path: entry.path, previewMissing: Boolean(placeholderText) });
      ideStateUtils.openDiffTab?.(getIde(), { id: tabId, label });
      showDiffTab(tabId);
      renderTabs();
      return true;
    }

    // A new revision (or a refreshed list) re-reads the tab it shows.
    function onClientChange(sessionId) {
      if (disposed) return;
      for (const [tabId, ctx] of contexts) {
        if (ctx.sessionId !== sessionId) continue;
        const entry = entryFor(ctx.sessionId, ctx.id);
        const revision = entry ? Number(entry.revision) || 1 : 0;
        if (entry && revision !== ctx.revision && opening.get(tabId) !== revision) {
          openSuggestion(ctx.sessionId, ctx.id);
          return;
        }
      }
      if ([...contexts.values()].some((ctx) => ctx.sessionId === sessionId)) renderTabs();
    }

    function pruneClosed() {
      const open = new Set((getIde().openTabs || []).map((tab) => tab && tab.path));
      for (const key of Array.from(contexts.keys())) {
        if (!open.has(key)) contexts.delete(key);
      }
    }

    /** Renders the bar when the active tab is a suggestion tab; false otherwise. */
    function renderToolbar(el) {
      return renderToolbarFor(el, getIde().activeTabPath);
    }

    function renderToolbarFor(el, id) {
      if (disposed || !el) return false;
      pruneClosed();
      const ctx = contexts.get(id);
      if (!ctx || !ensureBar()) return false;
      bindEvents(el);
      el.setAttribute('data-ide-suggestion-id', id);
      // Another toolbar may have replaced our markup since the last render.
      if (!el.querySelector('.suggestion-bar')) el.__suggestionBarMarkup = '';
      const ok = bar.render(el, { sessionId: ctx.sessionId, id: ctx.id, revision: ctx.revision, previewMissing: ctx.previewMissing });
      // The diff controller's markup cache must not mistake our markup for its own.
      el.__diffToolbarMarkup = '';
      if (ok) el.classList.remove('hidden');
      return ok;
    }

    function eventBar(event, method) {
      const el = event.currentTarget;
      if (!disposed && contexts.has(el.getAttribute('data-ide-suggestion-id')) && el.querySelector('.suggestion-bar')) bar?.[method](event, el);
    }
    function onClick(event) { eventBar(event, 'handleClick'); }
    function onKeydown(event) { eventBar(event, 'handleKeydown'); }
    function onInput(event) { eventBar(event, 'handleInput'); }

    function bindEvents(el) {
      const target = el || getDom().ideDiffToolbar;
      if (!target || boundElements.has(target)) return;
      boundElements.add(target);
      target.addEventListener('click', onClick);
      target.addEventListener('keydown', onKeydown);
      target.addEventListener('input', onInput);
    }

    function unbind(el) {
      el.removeEventListener('click', onClick);
      el.removeEventListener('keydown', onKeydown);
      el.removeEventListener('input', onInput);
      boundElements.delete(el);
    }

    function resetForRoot() {
      epoch += 1;
      contexts.clear();
      opening.clear();
    }

    // Accept never writes over unsaved edits; the check is registered with the
    // editor, so the side panel's bar has it before any suggestion tab opened.
    const dirtyClient = editorHost ? getClient() : null;
    if (dirtyClient && typeof dirtyClient.setDirtyCheck === 'function') {
      dirtyClient.setDirtyCheck((path) => editorHost.isDirty?.(path) === true);
    }

    function dispose() {
      disposed = true;
      resetForRoot();
      const el = getDom().ideDiffToolbar;
      if (el) unbind(el);
      if (typeof unsubscribe === 'function') unsubscribe();
      unsubscribe = null;
      dirtyClient?.setDirtyCheck?.(null);
      bar = null;
    }

    return {
      dispose,
      isSuggestionTab: (id) => contexts.has(id),
      openSuggestion,
      tabIdFor,
      renderToolbar,
      renderToolbarFor,
      resetForRoot,
    };
  }

  return { applySuggestion, createIdeSuggestionDiff };
});
