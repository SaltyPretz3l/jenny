(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererProjectNotesEntry = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  // Always loaded: the Notes toggle, its accent dot, the chat result row and the
  // lazy loader of the notes rail. The rail itself (and the host it publishes as
  // windowRef.rendererProjectNotesHost) loads on first open.
  const NOTES_RAIL_SCRIPTS = Object.freeze([
    Object.freeze(['renderer/features/renderer-project-notes-rail-render.js', 'rendererProjectNotesRailRender']),
    Object.freeze(['renderer/features/renderer-project-notes-rail.js', 'rendererProjectNotesRail']),
  ]);
  const MAX_SUMMARY_CHARS = 140;
  const TOGGLE_ID = 'chatTimelineNotesToggle';
  const ASSISTANT_WRITER = 'assistant';
  const NOTES_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2h6l3 3v9H4z"/><path d="M10 2v3h3M6.5 8h5M6.5 11h5"/></svg>';
  const GENERAL_PROJECT_ID = 'project_general';
  const SEEN_STORAGE_KEY = 'jenny.projectNotes.seen';
  const MAX_SEEN_ENTRIES = 64;
  const MAX_ROW_HEADINGS = 3;
  // The bound entry: the chat row builder asks it whether an Undo is still live.
  let activeEntry = null;

  function fallbackEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }

  function resolveActionButton(explicit, windowRef) {
    if (typeof explicit === 'function') return explicit;
    const candidates = [windowRef?.inventoryActionButton, windowRef?.inventory?.actionButton,
      globalThis.inventoryActionButton, globalThis.inventory?.actionButton];
    return candidates.find((candidate) => typeof candidate === 'function') || null;
  }

  /**
   * Loads the notes rail modules in order. Resolves to the rail module, or null
   * when a script failed (the caller shows a toast instead of a blank rail).
   */
  async function loadProjectNotesRailModules({ ensureScript, windowRef, log } = {}) {
    const globalRef = windowRef || globalThis;
    for (const [src, globalName] of NOTES_RAIL_SCRIPTS) {
      const isReady = () => Boolean(globalRef[globalName]);
      if (isReady()) continue;
      const ok = typeof ensureScript === 'function' ? await ensureScript({ src, isReady, log }) : false;
      if (!ok) return null;
    }
    return globalRef.rendererProjectNotesRail || null;
  }

  function count(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  }

  function linesVerb(lines) {
    const added = count(lines?.added);
    const removed = count(lines?.removed);
    if (added > 0 && removed === 0) {
      return jtn('projectNotes.chat.addedLines', added, { count: added }, '+{count} line', '+{count} lines');
    }
    if (removed > 0 && added === 0) {
      return jtn('projectNotes.chat.removedLines', removed, { count: removed }, '−{count} line', '−{count} lines');
    }
    return jt('projectNotes.chat.edited', 'edited');
  }

  // The resting state of a retired Undo: the write was undone, or edited over since.
  function undoStateMarkup(kind, escapeHtml) {
    return kind === 'undone'
      ? `<span class="notes-chat__undone">${escapeHtml(jt('ide.changes.undone', 'Undone'))}</span>`
      : `<span class="notes-chat__stale">${escapeHtml(jt('projectNotes.chat.editedSince', 'Edited since'))}</span>`;
  }

  function boundedSummary(value) {
    const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…` : text;
  }

  /**
   * The chat row for a Jenny write to the project notes (append or replace). Reads
   * and failed calls render nothing, and the note text never enters the markup.
   */
  function buildProjectNotesResultBlockMarkup(metadata, deps) {
    const meta = metadata && typeof metadata === 'object' ? metadata : null;
    if (!meta || meta.result_kind !== 'project_notes' || meta.status !== 'ok') return '';
    if (meta.action !== 'append' && meta.action !== 'replace') return '';
    const options = deps || {};
    const escapeHtml = typeof options.escapeHtml === 'function' ? options.escapeHtml : fallbackEscapeHtml;
    const actionButton = resolveActionButton(options.actionButton, null);
    if (!actionButton) return '';
    const projectId = typeof meta.project_id === 'string' ? meta.project_id : '';
    const entryId = typeof meta.journal_entry_id === 'string' ? meta.journal_entry_id : '';
    const headings = (Array.isArray(meta.headings) ? meta.headings : [])
      .filter((heading) => typeof heading === 'string' && heading.trim()).slice(0, MAX_ROW_HEADINGS).join(', ');
    const metaText = [linesVerb(meta.lines), headings, boundedSummary(meta.summary)].filter(Boolean).join(' · ');
    const open = actionButton({
      variant: 'ghost', size: 'sm', className: 'notes-chat__open',
      label: jt('projectNotes.chat.open', 'Open'),
      ariaLabel: jt('projectNotes.chat.openAria', 'Open project notes'),
      title: jt('projectNotes.chat.openAria', 'Open project notes'),
      dataset: { 'notes-open': '1', 'notes-project': projectId },
    });
    // An entry the bound entry already knows is undone or overtaken renders at rest; an unknown
    // one keeps Undo and asks the entry to settle it against a fresh journal after this render.
    const known = entryId ? activeEntry?.entryState?.(projectId, entryId) : '';
    if (entryId && !known) activeEntry?.settleLater?.(projectId);
    const undo = !entryId ? '' : known === 'undone' || known === 'stale' ? undoStateMarkup(known, escapeHtml) : actionButton({
      variant: 'ghost', size: 'sm', className: 'notes-chat__undo',
      label: jt('dashboard.calendar.agenda.undo', 'Undo'),
      ariaLabel: jt('projectNotes.chat.undoAria', 'Undo the notes change'),
      title: jt('projectNotes.chat.undoAria', 'Undo the notes change'),
      dataset: { 'notes-undo': entryId, 'notes-project': projectId },
    });
    return `<div class="notes-chat__row" data-notes-project="${escapeHtml(projectId)}">`
      + `<span class="notes-chat__icon" aria-hidden="true">${NOTES_ICON}</span>`
      + `<span class="notes-chat__title">${escapeHtml(jt('projectNotes.chat.updated', 'Updated project notes'))}</span>`
      + `<span class="notes-chat__meta">${escapeHtml(metaText)}</span>${open}${undo}</div>`;
  }

  function createProjectNotesEntry(deps) {
    const d = deps || {};
    const state = d.state;
    if (!state || typeof state !== 'object') throw new Error('renderer-project-notes-entry: state dep is required');
    const windowRef = d.windowRef || globalThis.window || globalThis;
    const doc = windowRef.document;
    const dom = d.dom || {};
    const utilityCluster = dom.utilityCluster || doc?.getElementById?.('chatTimelineUtilityCluster') || null;
    const reviewPanel = dom.artifactReviewPanel || doc?.getElementById?.('artifactReviewPanel') || null;
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : () => {};
    const showToastMessage = typeof d.showToastMessage === 'function' ? d.showToastMessage : () => {};
    const getHost = typeof d.getHost === 'function' ? d.getHost : () => windowRef.rendererProjectNotesHost || null;
    const seenRevision = loadSeen();
    const latestRevision = {};
    const journalState = {}; // projectId -> { entryId: 'live' | 'undone' | 'stale' }; dropped on every change push
    const observers = [];
    let toggleEl = null;
    let dotEl = null;
    let bound = false;
    let disposed = false;
    let inflightOpen = null;
    let unsubscribe = null;
    let lastProjectId = '';
    let refreshToken = 0;
    const settleTimers = {};

    const notesApi = () => windowRef.jennyShell?.projectNotes || null;
    const isOpen = () => getHost()?.isOpen?.() === true;

    // A chat without a project belongs to General, as in the rails.
    function currentProjectId() {
      const sessions = Array.isArray(state.sessions) ? state.sessions : [];
      const session = sessions.find((entry) => entry?.id === state.currentSessionId);
      return session ? String(session.project_id || '') || GENERAL_PROJECT_ID : '';
    }

    // "Seen" survives a restart: the revision last looked at, per project, most recent last.
    function storage() { try { return windowRef.localStorage || null; } catch (_error) { return null; } }
    function loadSeen() {
      try {
        const parsed = JSON.parse(storage()?.getItem(SEEN_STORAGE_KEY) || '{}');
        return Object.fromEntries(Object.entries(parsed && typeof parsed === 'object' ? parsed : {})
          .filter(([, revision]) => Number.isFinite(revision)));
      } catch (_error) { return {}; }
    }
    function persistSeen() {
      const keys = Object.keys(seenRevision);
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SEEN_ENTRIES))) delete seenRevision[key];
      try { storage()?.setItem(SEEN_STORAGE_KEY, JSON.stringify(seenRevision)); } catch (_error) { /* the dot is cosmetic */ }
    }

    function setDot(visible) {
      if (dotEl && dotEl.hidden === visible) dotEl.hidden = !visible;
    }

    function markSeen(projectId, revision) {
      const id = String(projectId || '');
      if (!id) return;
      const known = Number.isFinite(revision) ? revision : latestRevision[id];
      if (known !== undefined) { delete seenRevision[id]; seenRevision[id] = known; persistSeen(); }
      if (id === currentProjectId()) setDot(false);
    }

    // One place decides the dot: an assistant write the user has not seen yet.
    function applyWrite(projectId, revision, updatedBy) {
      if (Number.isFinite(revision)) latestRevision[projectId] = revision;
      if (projectId !== currentProjectId()) return;
      if (isOpen()) {
        markSeen(projectId, revision);
        return;
      }
      setDot(updatedBy === ASSISTANT_WRITER && revision !== seenRevision[projectId]);
    }

    async function fetchNote(projectId) {
      const api = notesApi();
      if (!projectId || typeof api?.get !== 'function') return null;
      try {
        const result = await api.get(projectId);
        return result?.ok === true && result.note && typeof result.note === 'object' ? result.note : null;
      } catch (error) {
        appendClientLog('WARN', 'project_notes.entry_fetch_failed', { message: String(error?.message || error || '').slice(0, 200) });
        return null;
      }
    }

    async function refresh() {
      const id = currentProjectId();
      lastProjectId = id;
      const token = ++refreshToken;
      if (!id) {
        setDot(false);
        return;
      }
      const note = await fetchNote(id);
      if (disposed || token !== refreshToken) return;
      if (note) { rememberJournal(note); applyWrite(id, Number(note.revision), note.updatedBy); }
      else setDot(false);
      await syncUndoButtons(id);
    }

    function rememberJournal(note) {
      const id = String(note?.projectId || '');
      if (!id) return;
      const states = {};
      for (const entry of Array.isArray(note.journal) ? note.journal : []) {
        states[String(entry?.id)] = entry?.undone === true ? 'undone' : entry?.undoable === true ? 'live' : 'stale';
      }
      journalState[id] = states;
    }

    // 'live' | 'undone' | 'stale', or '' while nothing is known for that project (a row then keeps
    // its Undo and syncUndoButtons settles it after the fetch).
    function entryState(projectId, entryId) {
      const states = journalState[String(projectId || '')];
      return states ? states[String(entryId || '')] || '' : '';
    }

    function syncToggle() {
      if (!toggleEl) return;
      const split = utilityCluster?.querySelector?.('#artifactSplitViewToggle');
      const hidden = split?.hidden !== false;
      // Guarded writes: the cluster observer watches `hidden`, so an unchanged write would loop.
      if (toggleEl.hidden !== hidden) toggleEl.hidden = hidden;
      const open = isOpen();
      toggleEl.setAttribute('aria-pressed', open ? 'true' : 'false');
      toggleEl.classList.toggle('active', open);
      if (open) markSeen(currentProjectId());
    }

    function checkSession() {
      if (currentProjectId() !== lastProjectId) void refresh();
    }

    async function openAfterLoad() {
      let ok = false;
      let detail = '';
      try {
        await loadProjectNotesRailModules({ ensureScript: windowRef.scriptLoaderUtils?.ensureScript, windowRef, log: appendClientLog });
        ok = getHost()?.open?.() === true; // a rail that did not exist yet cannot have been open
      } catch (error) {
        detail = String(error?.message || error || '').slice(0, 200);
      }
      if (!ok) {
        appendClientLog('WARN', 'project_notes.rail_load_failed', { message: detail });
        showToastMessage(jt('projectNotes.unavailable', 'Notes are unavailable right now.'));
      }
      syncToggle();
      return ok;
    }

    // The toolbar button toggles; the chat row's Open only ever opens.
    function openRail(viaToggle) {
      const host = getHost();
      if (host) return Promise.resolve((viaToggle ? host.toggle?.() : host.open?.()) === true).then((result) => { syncToggle(); return result; });
      if (!inflightOpen) inflightOpen = openAfterLoad().finally(() => { inflightOpen = null; });
      return inflightOpen;
    }

    function createToggle() {
      if (toggleEl || !utilityCluster || !doc) return toggleEl;
      toggleEl = doc.getElementById(TOGGLE_ID);
      if (!toggleEl) {
        const actionButton = resolveActionButton(null, windowRef);
        if (!actionButton) return null;
        const mount = doc.createElement('div');
        mount.innerHTML = actionButton({
          id: TOGGLE_ID, domId: TOGGLE_ID, plain: true,
          className: 'chat-timeline-utility-button chat-timeline-notes-toggle',
          ariaLabel: jt('projectNotes.toggle', 'Notes'), title: jt('projectNotes.toggle', 'Notes'), ariaPressed: false,
          trustedHtml: `${NOTES_ICON}<span class="chat-timeline-notes-dot" hidden aria-hidden="true"></span>`,
        });
        toggleEl = mount.firstElementChild;
        const anchor = doc.getElementById('chatTimelineTasksToggle') || utilityCluster.querySelector('#artifactSplitViewToggle');
        const parent = anchor?.parentNode || utilityCluster;
        parent.insertBefore(toggleEl, anchor ? anchor.nextSibling : parent.firstChild);
      }
      dotEl = toggleEl.querySelector('.chat-timeline-notes-dot');
      return toggleEl;
    }

    function swapTrigger(trigger, kind, refocus) {
      const span = trigger.ownerDocument.createElement('span');
      span.className = kind === 'undone' ? 'notes-chat__undone' : 'notes-chat__stale';
      span.textContent = kind === 'undone'
        ? jt('ide.changes.undone', 'Undone')
        : jt('projectNotes.chat.editedSince', 'Edited since');
      trigger.replaceWith(span);
      // A keyboard Undo keeps its place: focus lands on the result, not on <body> (row 21 gate).
      if (refocus) {
        span.setAttribute('tabindex', '-1');
        span.focus?.();
      }
    }

    async function runUndo(trigger) {
      if (trigger.dataset.notesBusy === '1') return;
      const project = trigger.dataset.notesProject || trigger.closest('[data-notes-project]')?.dataset.notesProject || '';
      const entryId = trigger.dataset.notesUndo || '';
      const api = notesApi();
      if (!project || !entryId || typeof api?.undo !== 'function') return;
      const hadFocus = trigger.ownerDocument.activeElement === trigger; // disabling it below drops focus
      trigger.dataset.notesBusy = '1';
      trigger.disabled = true;
      let ok = false;
      try {
        const result = await api.undo(project, entryId);
        ok = result?.ok === true;
      } catch (error) {
        appendClientLog('WARN', 'project_notes.undo_failed', { message: String(error?.message || error || '').slice(0, 200) });
      }
      if (trigger.isConnected) swapTrigger(trigger, ok ? 'undone' : 'stale', hadFocus);
    }

    // Every Undo in the transcript for that project is settled against the journal:
    // undone entries say so, entries no longer undoable (or no longer held) read Edited since.
    // `refetch` ignores the cache (a row rendered before its change push arrived).
    async function syncUndoButtons(projectId, options) {
      const pending = () => [...(doc?.querySelectorAll?.('[data-notes-undo]') || [])]
        .filter((button) => button.dataset.notesProject === projectId && button.dataset.notesBusy !== '1');
      if (!projectId) return;
      if (options?.refetch === true || !journalState[projectId]) {
        const note = await fetchNote(projectId); // also warms the cache for the next render
        if (disposed || !note) return;
        rememberJournal(note);
      }
      for (const button of pending()) {
        const known = entryState(projectId, button.dataset.notesUndo) || 'stale';
        if (known !== 'live') swapTrigger(button, known);
      }
    }

    // Called from the row builder during a render: settle once that render is over.
    function settleLater(projectId) {
      const id = String(projectId || '');
      if (!id || disposed || settleTimers[id]) return;
      settleTimers[id] = windowRef.setTimeout(() => {
        delete settleTimers[id];
        if (!disposed) void syncUndoButtons(id, { refetch: true });
      }, 0);
    }

    function handleChanged(payload) {
      const id = String(payload?.projectId || '');
      if (disposed || !id) return;
      applyWrite(id, Number(payload.revision), payload.updatedBy);
      delete journalState[id];
      void syncUndoButtons(id);
    }

    function handleToggleClick() {
      void openRail(true);
    }

    function handleDocumentClick(event) {
      if (disposed) return;
      const target = event.target;
      const openTrigger = target?.closest?.('[data-notes-open]');
      if (openTrigger) {
        // The rail shows the current chat's project. A row from a chat that has since moved
        // names a different project: say so instead of opening the wrong note.
        const rowProject = String(openTrigger.dataset.notesProject || openTrigger.closest('[data-notes-project]')?.dataset.notesProject || '');
        if (rowProject && rowProject !== currentProjectId()) {
          showToastMessage(jt('projectNotes.chat.otherProject', 'These notes belong to another project. Open a chat in that project to see them.'));
          return;
        }
        void openRail(false);
        return;
      }
      const undoTrigger = target?.closest?.('[data-notes-undo]');
      if (undoTrigger) void runUndo(undoTrigger);
    }

    // The pane raises this on the window when the chat or its project moved.
    function handleFocusedChatChanged() {
      if (disposed) return;
      checkSession();
      void syncUndoButtons(currentProjectId());
    }

    function handleFocusIn(event) {
      if (!disposed && event.target?.id === 'chatInput') checkSession();
    }

    function onMutation() {
      if (disposed) return;
      syncToggle();
      checkSession();
    }

    function observe(target, attributeFilter, subtree) {
      if (!target || typeof windowRef.MutationObserver !== 'function') return;
      const observer = new windowRef.MutationObserver(onMutation);
      observer.observe(target, { attributes: true, attributeFilter, subtree });
      observers.push(observer);
    }

    function bind() {
      if (bound || disposed) return;
      bound = true;
      createToggle();
      toggleEl?.addEventListener('click', handleToggleClick);
      doc?.addEventListener('click', handleDocumentClick);
      doc?.addEventListener('focusin', handleFocusIn, true);
      windowRef.addEventListener?.('jenny:focused-chat-changed', handleFocusedChatChanged);
      observe(utilityCluster, ['hidden'], true);
      observe(reviewPanel, ['data-artifact-review-mode', 'hidden', 'class'], false);
      const subscribe = notesApi()?.onChanged;
      if (typeof subscribe === 'function') {
        const off = subscribe.call(notesApi(), handleChanged);
        unsubscribe = typeof off === 'function' ? off : null;
      }
      syncToggle();
      void refresh();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      observers.forEach((observer) => observer.disconnect());
      observers.length = 0;
      toggleEl?.removeEventListener?.('click', handleToggleClick);
      doc?.removeEventListener?.('click', handleDocumentClick);
      doc?.removeEventListener?.('focusin', handleFocusIn, true);
      windowRef.removeEventListener?.('jenny:focused-chat-changed', handleFocusedChatChanged);
      unsubscribe?.();
      unsubscribe = null;
      for (const id of Object.keys(settleTimers)) { windowRef.clearTimeout(settleTimers[id]); delete settleTimers[id]; }
      if (activeEntry === api) activeEntry = null;
    }

    const api = { bind, dispose, refresh, syncToggle, checkSession, currentProjectId, markSeen, entryState, settleLater };
    activeEntry = api;
    return api;
  }

  return { createProjectNotesEntry, buildProjectNotesResultBlockMarkup, loadProjectNotesRailModules, NOTES_RAIL_SCRIPTS };
});
