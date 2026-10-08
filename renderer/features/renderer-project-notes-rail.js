/**
 * renderer/features/renderer-project-notes-rail.js
 *
 * The Project Notes rail: the `notes` mode of the artifact review panel. Lazily
 * loaded; the shell artifact bridge builds one controller, lets `renderSplitDetail`
 * PULL its markup through `renderRailContent`, and publishes
 * `windowRef.rendererProjectNotesHost`. IPC is `jennyShell.projectNotes` (Electron
 * owns the note). Per project, in memory:
 *   view   'preview' | 'editing' (a draft that failed to save resumes editing)
 *   lease  taken on entering edit; the 10 s heartbeat keeps it only while a change
 *          is unsaved or a keystroke is under 5 s old, releases it otherwise, and the
 *          next keystroke takes it back; released 5 s after editing ends
 *   save   debounced 600 ms, flushed on exit; `stale` keeps the draft (no autosave)
 *          and offers Save mine / Use Jenny's; other failures keep it with Retry
 *   strip  the latest Jenny write, its line diff measured against the text held
 *          before the change; Hide, a user edit or a project switch clear it
 * Note text is never logged.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-project-notes-rail-render'),
      require('./renderer-dashboard-scratchpad-markdown'),
      require('../inventory/action-button')
    );
    return;
  }
  root.rendererProjectNotesRail = factory(
    root.rendererProjectNotesRailRender,
    root.rendererDashboardScratchpadMarkdown,
    root.inventoryActionButton
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (renderModule, markdownModule, actionButtonModule) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const GENERAL_PROJECT_ID = 'project_general';
  const SAVE_DEBOUNCE_MS = 600;
  const HEARTBEAT_MS = 10000;
  const IDLE_RELEASE_MS = 5000;
  function noop() {}

  const fallbackEscapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  const newProjectState = () => ({
    note: null, loading: false, loaded: false, fetchSeq: 0, view: 'preview', draft: '', dirty: false, baseRevision: 0,
    leaseHeld: false, lastKeystrokeAt: 0, editStartedAt: 0, hiddenStripEntryId: '', userEditedAt: 0, error: null, theirs: null,
    diff: null, highlight: null, saving: false, savePromise: null, undoing: false, focusEditor: false, refetchOnExit: false, releaseDue: false,
    saveTimer: null, heartbeatTimer: null, releaseTimer: null,
  });

  function createProjectNotesRail(deps) {
    const d = deps || {};
    const state = d.state;
    if (!state || typeof state !== 'object') throw new Error('renderer-project-notes-rail: state dep is required');
    const windowRef = d.windowRef || globalRef.window || globalRef;
    const rr = renderModule || globalRef.rendererProjectNotesRailRender || {};
    const markdown = markdownModule || globalRef.rendererDashboardScratchpadMarkdown || {};
    const actionButton = actionButtonModule || globalRef.inventoryActionButton;
    const panelEl = d.dom?.artifactReviewPanel || windowRef?.document?.getElementById?.('artifactReviewPanel') || null;
    const escapeHtml = typeof d.escapeHtml === 'function' ? d.escapeHtml : fallbackEscapeHtml;
    const openArtifactRail = typeof d.openArtifactRail === 'function' ? d.openArtifactRail : noop;
    const renderArtifactReviewPanel = typeof d.renderArtifactReviewPanel === 'function' ? d.renderArtifactReviewPanel : noop;
    const toggleArtifactReview = typeof d.toggleArtifactReview === 'function' ? d.toggleArtifactReview : noop;
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : noop;
    const showToastMessage = typeof d.showToastMessage === 'function' ? d.showToastMessage : noop;
    const getEntry = typeof d.getEntry === 'function' ? d.getEntry : () => null;
    const setT = typeof d.setTimeoutImpl === 'function' ? d.setTimeoutImpl : (fn, ms) => windowRef.setTimeout(fn, ms);
    const clearTimer = typeof d.clearTimeoutImpl === 'function' ? d.clearTimeoutImpl : (id) => windowRef.clearTimeout(id);
    const clearT = (id) => { if (id) clearTimer(id); };
    const now = typeof d.now === 'function' ? d.now : () => Date.now();
    const listenerToken = `notes-rail-${Math.random().toString(36).slice(2)}`;
    const projects = new Map();
    let lastProjectId = '';
    let switcher = null;
    let switcherRequested = false;
    let unsubscribeChanged = null;
    let panelListenersBound = false;
    let painting = false;
    let disposed = false;

    function projectId() {
      const sessionId = String(state.currentSessionId || '').trim();
      if (!sessionId) return '';
      const session = (Array.isArray(state.sessions) ? state.sessions : [])
        .find((entry) => String(entry?.id || '').trim() === sessionId);
      return session ? String(session.project_id || '').trim() || GENERAL_PROJECT_ID : '';
    }

    const projectState = (pid) => projects.get(pid) || projects.set(pid, newProjectState()).get(pid);

    function projectName(pid) {
      if (!switcherRequested && typeof d.getProjectSwitcher === 'function') {
        switcherRequested = true;
        Promise.resolve(d.getProjectSwitcher())
          .then((found) => { switcher = found || null; return switcher?.refresh?.(); })
          .then(() => { if (!disposed) repaint(projectId()); })
          .catch(noop);
      }
      const named = switcher?.projectById?.(pid)?.name;
      if (named) return String(named);
      return pid === GENERAL_PROJECT_ID ? jt('projects.switcher.generalName', 'General') : pid;
    }

    const notesApi = () => windowRef?.jennyShell?.projectNotes || null;
    const isNotesMode = () => state.ui?.artifactReview?.mode === 'notes';

    function isOpen() {
      const prefs = state.ui?.artifactReview || {};
      return isNotesMode() && prefs.enabled === true && prefs.collapsed !== true && !panelEl?.classList?.contains('hidden');
    }

    const stripFor = (ps) => {
      const strip = ps.note ? rr.buildChangeStrip(ps.note, {
        now: now(), hiddenEntryId: ps.hiddenStripEntryId, userEditedAfter: ps.userEditedAt, diff: ps.diff,
      }) : null;
      // No Undo under an unsaved draft: it would rebase the draft on a note the user has not seen.
      return strip && ps.dirty ? { ...strip, undoable: false } : strip;
    };

    function buildModel(pid, ps) {
      return {
        projectId: pid, projectName: projectName(pid), note: ps.note, loading: ps.loading && !ps.note, editing: ps.view === 'editing',
        draft: ps.draft, error: ps.error ? { kind: ps.error.kind } : null, changeStrip: stripFor(ps), highlightLines: ps.highlight,
      };
    }

    const markdownHelpers = () => ({
      escapeHtml, actionButton, now: now(),
      // No actionButton: checklist rows stay inert so the preview is one edit target.
      renderMarkdown: (text) => (typeof markdown.renderPreviewHtml === 'function' ? markdown.renderPreviewHtml(text, { escapeHtml }) : escapeHtml(text)),
    });

    // The textarea survives a repaint (paintSurface restores caret, scroll and
    // focus); `painting` mutes the focusout the swap causes.
    function paint(host, pid, ps) {
      painting = true;
      try {
        const html = typeof rr.renderNotesRailSurface === 'function' ? rr.renderNotesRailSurface(buildModel(pid, ps), markdownHelpers()) : '';
        rr.paintSurface(host, html, { focusEditor: ps.focusEditor });
        ps.focusEditor = false;
      } finally {
        painting = false;
      }
    }

    // While the editor is live, a save or an error re-renders only the strip and
    // the error line: the textarea is never replaced (its undo history and an
    // IME composition survive). Falls back to a full repaint when there is no editor.
    function patchChrome(pid, ps) {
      const section = panelEl?.querySelector?.('.notes-rail');
      if (!section?.querySelector('[data-notes-editor]') || pid !== projectId()) return false;
      const model = buildModel(pid, ps);
      const helpers = markdownHelpers();
      rr.swapPart(section, '.notes-rail__strip', rr.renderStrip(model.changeStrip, helpers), section.querySelector('.notes-rail__header'), 'afterend');
      rr.swapPart(section, '.notes-rail__error', rr.renderError(model.error, helpers), section.querySelector('.notes-rail__footer'), 'beforebegin');
      return true;
    }

    const repaintOrPatch = (pid, ps) => { if (!(ps.view === 'editing' && patchChrome(pid, ps))) repaint(pid); };

    function renderRailContent(surface) {
      const host = rr.prepareSurface(surface);
      if (!host) return false;
      const pid = projectId();
      if (pid !== lastProjectId) handleProjectSwitch(pid);
      if (!pid) {
        host.innerHTML = '<div class="notes-rail notes-rail--empty"><div class="notes-rail__empty">'
          + escapeHtml(jt('projectNotes.noProject', 'Open a chat to see its project notes.')) + '</div></div>';
        return true;
      }
      const ps = projectState(pid);
      if (!ps.loaded && !ps.loading) void fetchNote(pid);
      // An unsaved draft (left mid-edit by a project switch) comes back as the editor.
      if (ps.dirty && ps.view === 'preview' && !ps.saving) { beginEditing(pid, ps); ps.focusEditor = true; }
      // The chat pipeline re-renders this panel on every timeline render: a live editor
      // for this project is patched around, never rebuilt (Use Jenny's may replace its text).
      const live = ps.view === 'editing' && !ps.focusEditor ? host.querySelector(`[data-notes-editor][data-notes-project="${pid}"]`) : null;
      if (live) {
        if (live.value !== ps.draft) live.value = ps.draft;
        if (patchChrome(pid, ps)) return true;
      }
      paint(host, pid, ps);
      return true;
    }

    function repaint(pid) {
      if (disposed || !pid || pid !== projectId() || !isOpen()) return;
      const current = panelEl?.querySelector?.('.notes-rail');
      if (current?.parentElement) renderRailContent(current.parentElement);
      else renderArtifactReviewPanel();
    }

    function ensureSubscribed() {
      if (unsubscribeChanged || disposed || typeof notesApi()?.onChanged !== 'function') return;
      try {
        const off = notesApi().onChanged(handleChanged);
        unsubscribeChanged = typeof off === 'function' ? off : noop;
      } catch (_error) { appendClientLog('WARN', 'project_notes.subscribe_failed', {}); }
    }

    function applyFetched(ps, note, options) {
      const prev = ps.note;
      ps.note = note;
      ps.loaded = true;
      if (ps.error && (ps.error.kind === 'load_failed' || ps.error.kind === 'unavailable')) ps.error = null;
      const changed = Boolean(prev) && prev.revision !== note.revision;
      const jennyWrote = changed && options?.fromChange && options.reason !== 'undo' && note.updatedBy === 'assistant';
      const measured = jennyWrote ? rr.measureChange(prev.text, note) : null;
      // Without a measured diff (a cold open, or a change that landed while another project was
      // showing) Jenny's latest write is tinted from the journal's recorded lines.
      const recorded = () => rr.recordedHighlight(note, { now: now(), hiddenEntryId: ps.hiddenStripEntryId });
      if (changed) { ps.diff = measured ? measured.diff : null; ps.highlight = measured ? measured.highlight : (!options?.fromChange && note.updatedBy === 'assistant' ? recorded() : null); }
      else if (!prev) ps.highlight = recorded();
      if (!ps.dirty) { ps.draft = note.text; ps.baseRevision = note.revision; } // never clobber an unsaved draft
    }

    async function fetchNote(pid, options) {
      const ps = projectState(pid);
      const api = notesApi();
      ensureSubscribed();
      if (typeof api?.get !== 'function') {
        ps.error = { kind: 'unavailable' };
        ps.loaded = true;
        return null;
      }
      ps.loading = true;
      ps.fetchSeq += 1;
      const seq = ps.fetchSeq;
      const result = await Promise.resolve().then(() => api.get(pid)).catch(() => null);
      if (disposed || seq !== ps.fetchSeq) return null;
      ps.loading = false;
      ps.loaded = true;
      if (result?.ok === true && result.note && typeof result.note === 'object') {
        applyFetched(ps, result.note, options);
        markSeen(pid, result.note.revision);
      } else {
        appendClientLog('WARN', 'project_notes.load_failed', { reason: String(result?.reason || 'exception').slice(0, 40) });
        if (!ps.note) ps.error = { kind: 'load_failed' };
      }
      repaint(pid);
      return ps.note;
    }

    function markSeen(pid, revision) {
      if (!isOpen() || pid !== projectId()) return;
      try { getEntry()?.markSeen?.(pid, revision); } catch (_error) { /* the dot is cosmetic */ }
    }

    function handleChanged(payload) {
      if (disposed) return;
      const pid = String(payload?.projectId || '');
      const ps = projects.get(pid);
      if (!ps) return;
      if (pid !== projectId()) { ps.loaded = false; return; }
      if (ps.note && Number(payload.revision) === ps.note.revision) return; // our own save, or already applied
      if (ps.view === 'editing') { ps.refetchOnExit = true; return; }
      void fetchNote(pid, { fromChange: true, reason: String(payload?.reason || '') });
    }

    function setLease(pid, ps, held) {
      ps.leaseHeld = held;
      // A failed lease only lets Jenny write sooner.
      try { Promise.resolve(notesApi()?.lease?.(pid, held)).catch(noop); } catch (_error) { /* see above */ }
    }

    const stopHeartbeat = (ps) => { clearT(ps.heartbeatTimer); ps.heartbeatTimer = null; };

    // The lease protects unsaved changes and the 5 s after a keystroke; an idle open editor does not block Jenny.
    const leaseWanted = (ps) => ps.dirty || ps.saving || Boolean(ps.saveTimer)
      || now() - Math.max(ps.lastKeystrokeAt, ps.editStartedAt) < IDLE_RELEASE_MS;

    function startHeartbeat(pid, ps) {
      stopHeartbeat(ps);
      ps.heartbeatTimer = setT(() => {
        ps.heartbeatTimer = null;
        if (disposed || ps.view !== 'editing') return;
        if (!isOpen() || pid !== projectId()) { leaveEditing(pid); return; }
        if (leaseWanted(ps)) setLease(pid, ps, true);
        else if (ps.leaseHeld) setLease(pid, ps, false);
        startHeartbeat(pid, ps);
      }, HEARTBEAT_MS);
    }

    function scheduleRelease(pid, ps) {
      clearT(ps.releaseTimer);
      const dueAt = Math.max(ps.lastKeystrokeAt, ps.editStartedAt) + IDLE_RELEASE_MS;
      ps.releaseTimer = setT(() => {
        ps.releaseTimer = null;
        ps.releaseDue = true;
        maybeRelease(pid, ps);
      }, Math.max(0, dueAt - now()));
    }

    // The lease outlives the editor only until the idle window passes and no save is pending.
    function maybeRelease(pid, ps) {
      if (!ps.releaseDue || ps.view === 'editing' || ps.saving || ps.saveTimer) return;
      ps.releaseDue = false;
      if (ps.leaseHeld) setLease(pid, ps, false);
    }

    function beginEditing(pid, ps) {
      ps.view = 'editing';
      ps.editStartedAt = now();
      clearT(ps.releaseTimer);
      ps.releaseTimer = null;
      ps.releaseDue = false;
      setLease(pid, ps, true);
      startHeartbeat(pid, ps);
    }

    function enterEdit(pid) {
      const ps = projectState(pid);
      if (ps.view === 'editing' || !ps.note) return;
      if (!ps.dirty) { ps.draft = ps.note.text; ps.baseRevision = ps.note.revision; ps.error = null; }
      ps.focusEditor = true;
      beginEditing(pid, ps);
      repaint(pid);
    }

    function scheduleSave(pid, ps) {
      clearT(ps.saveTimer);
      ps.saveTimer = setT(() => { ps.saveTimer = null; void saveDraft(pid); }, SAVE_DEBOUNCE_MS);
    }

    function applySaved(pid, ps, note, savedText) {
      ps.note = note;
      ps.baseRevision = note.revision;
      ps.userEditedAt = now();
      ps.highlight = null;
      ps.diff = null;
      ps.theirs = null;
      ps.error = null;
      ps.dirty = ps.draft !== savedText;
      if (ps.dirty) scheduleSave(pid, ps);
      markSeen(pid, note.revision);
    }

    async function saveDraft(pid) {
      const ps = projectState(pid);
      clearT(ps.saveTimer);
      ps.saveTimer = null;
      if (!ps.dirty) return true;
      if (ps.saving) { await ps.savePromise; return saveDraft(pid); } // an exit waits for the in-flight save, then saves what changed since
      const api = notesApi();
      if (typeof api?.save !== 'function') { ps.error = { kind: 'unavailable' }; repaint(pid); return false; }
      const text = ps.draft;
      ps.saving = true;
      ps.savePromise = Promise.resolve().then(() => api.save(pid, text, ps.baseRevision)).catch(() => null);
      const result = await ps.savePromise;
      ps.saving = false;
      ps.savePromise = null;
      if (disposed) return false;
      const saved = result?.ok === true && result.note && typeof result.note === 'object';
      if (saved) applySaved(pid, ps, result.note, text);
      else if (result?.reason === 'stale' && result.current) { ps.theirs = result.current; ps.error = { kind: 'stale' }; }
      else if (result?.reason === 'note_full') ps.error = { kind: 'note_full' };
      else {
        ps.error = { kind: 'save_failed' };
        appendClientLog('WARN', 'project_notes.save_failed', { reason: String(result?.reason || 'exception').slice(0, 40) });
      }
      repaintOrPatch(pid, ps);
      maybeRelease(pid, ps);
      return saved && !ps.dirty;
    }

    // Esc / click outside. A draft that could not be saved keeps the editor open.
    async function exitEdit(pid) {
      const ps = projectState(pid);
      if (ps.view !== 'editing') return;
      if (ps.dirty) {
        if (ps.error?.kind === 'stale') return;
        if (!await saveDraft(pid)) return;
      }
      if (ps.view !== 'editing') return;
      ps.view = 'preview';
      stopHeartbeat(ps);
      scheduleRelease(pid, ps);
      const refetch = ps.refetchOnExit;
      ps.refetchOnExit = false;
      if (refetch) await fetchNote(pid, { fromChange: true, reason: 'save' });
      else repaint(pid);
    }

    // Leaving the surface (project switch, Tasks, rail closed): flush without awaiting.
    function leaveEditing(pid) {
      const ps = projects.get(pid);
      if (!ps || ps.view !== 'editing') return;
      stopHeartbeat(ps);
      if (ps.dirty && ps.error?.kind !== 'stale') void saveDraft(pid);
      // A draft that fails to save comes back as the editor (see renderRailContent).
      ps.view = 'preview';
      if (ps.refetchOnExit) { ps.refetchOnExit = false; ps.loaded = false; } // a change seen mid-edit loads on the next paint
      scheduleRelease(pid, ps);
    }

    function handleProjectSwitch(pid) {
      const previous = lastProjectId;
      lastProjectId = pid;
      const ps = previous ? projects.get(previous) : null;
      if (ps) { ps.highlight = null; ps.diff = null; leaveEditing(previous); }
    }

    function onInput(pid, editor, composing) {
      const ps = projectState(pid);
      ps.draft = String(editor.value || '');
      ps.dirty = true;
      ps.lastKeystrokeAt = now();
      ps.highlight = null;
      ps.diff = null;
      if (!ps.leaseHeld && ps.view === 'editing') setLease(pid, ps, true);
      if (ps.error?.kind === 'stale') return; // the decision is Save mine / Use Jenny's
      const hadError = Boolean(ps.error);
      ps.error = null;
      if (composing) { clearT(ps.saveTimer); ps.saveTimer = null; } // the save waits for the IME composition to end
      else scheduleSave(pid, ps);
      if (hadError) repaintOrPatch(pid, ps);
    }

    function hideChanges(pid) {
      const ps = projectState(pid);
      ps.hiddenStripEntryId = stripFor(ps)?.entryId || ps.hiddenStripEntryId;
      ps.highlight = null;
      repaint(pid);
    }

    async function undoChange(pid, entryId) {
      const ps = projectState(pid);
      if (ps.undoing || ps.dirty) return;
      ps.undoing = true;
      const api = notesApi();
      const result = await Promise.resolve().then(() => api?.undo?.(pid, entryId)).catch(() => null);
      ps.undoing = false;
      if (disposed) return;
      if (result?.ok !== true || !result.note) {
        showToastMessage(jt('projectNotes.undoUnavailable', 'That change can no longer be undone.'));
        return;
      }
      applyFetched(ps, result.note, { fromChange: true, reason: 'undo' });
      repaint(pid);
    }

    // Save mine retries against Jenny's revision; Use Jenny's adopts her text and drops the draft.
    function resolveConflict(pid, keepMine) {
      const ps = projectState(pid);
      const theirs = ps.theirs || ps.note;
      if (keepMine && ps.theirs) ps.baseRevision = ps.theirs.revision;
      if (!keepMine && theirs) Object.assign(ps, { note: theirs, draft: theirs.text, baseRevision: theirs.revision, dirty: false, highlight: null });
      ps.error = null;
      ps.theirs = null;
      if (keepMine) void saveDraft(pid);
      repaint(pid);
      refocusRail(); // the decision buttons leave the DOM with the error line
    }
    // Focus that would fall to <body> returns to the rail: the open editor, else the note.
    function refocusRail() {
      const active = windowRef?.document?.activeElement;
      if (!active || active === windowRef.document.body || !active.isConnected) (panelEl?.querySelector?.('[data-notes-editor]') || panelEl?.querySelector?.('[data-action="notes-rail-edit"]'))?.focus?.();
    }

    function retry(pid) {
      const ps = projectState(pid);
      ps.error = null;
      if (!ps.note && !ps.dirty) { ps.loaded = false; void fetchNote(pid); } else void saveDraft(pid);
      repaint(pid);
    }

    const switchToTasks = () => { leaveEditing(projectId()); openArtifactRail('tasks'); renderArtifactReviewPanel(); };

    function handlePanelClick(event) {
      if (disposed || !isNotesMode()) return;
      const button = event.target?.closest?.('[data-action]');
      const action = String(button?.dataset?.action || '');
      if (!action.startsWith('notes-rail-')) return;
      const pid = projectId();
      if (action === 'notes-rail-switch-tasks') return switchToTasks();
      if (!pid) return;
      const handlers = {
        'notes-rail-edit': () => { if (!rr.previewClickIgnored(button, windowRef?.getSelection?.())) enterEdit(pid); },
        'notes-rail-hide-changes': () => hideChanges(pid),
        'notes-rail-undo': () => undoChange(pid, String(button.dataset.entryId || '')),
        'notes-rail-save-mine': () => resolveConflict(pid, true),
        'notes-rail-use-theirs': () => resolveConflict(pid, false),
        'notes-rail-retry': () => retry(pid),
      };
      handlers[action]?.();
    }

    function handlePanelKeydown(event) {
      if (disposed || !isNotesMode() || event.isComposing) return;
      const pid = projectId();
      const target = event.target;
      if (event.key === 'Escape' && target?.closest?.('[data-notes-editor]')) {
        event.preventDefault();
        event.stopPropagation();
        const found = editorFor(event);
        if (found) void exitEdit(found.pid).then(refocusRail); // the editor leaves the DOM
        return;
      }
      const isActivate = event.key === 'Enter' || event.key === ' ';
      if (isActivate && pid && target?.dataset?.action === 'notes-rail-edit') {
        event.preventDefault();
        enterEdit(pid);
      }
    }

    // The editor is stamped with the project it was painted for. Input that lands
    // after the chat moved to another project is dropped and the rail repaints.
    function editorFor(event) {
      const editor = event.target?.closest?.('[data-notes-editor]');
      const pid = String(editor?.dataset?.notesProject || '');
      if (!editor || !pid) return null;
      if (pid === projectId()) return { editor, pid };
      if (projectId()) repaint(projectId()); else renderArtifactReviewPanel();
      return null;
    }

    function handlePanelInput(event) {
      if (disposed || !isNotesMode()) return;
      const found = editorFor(event);
      if (found) onInput(found.pid, found.editor, event.isComposing === true);
    }

    function handleCompositionEnd(event) {
      if (disposed || !isNotesMode()) return;
      const found = editorFor(event);
      if (found) onInput(found.pid, found.editor, false);
    }

    function handlePanelFocusOut(event) {
      if (disposed || painting || !isNotesMode()) return;
      const found = editorFor(event);
      if (!found) return;
      const { editor, pid } = found;
      const next = event.relatedTarget;
      if (next && editor.closest('.notes-rail')?.contains(next)) return;
      // Alt-tabbing away keeps the editor focused in its document: not a click outside.
      if (!next && editor.ownerDocument?.activeElement === editor && editor.ownerDocument.hasFocus?.() === false) return;
      void exitEdit(pid);
    }

    // keydown binds in the capture phase: the panel's own Escape (collapse / un-maximize)
    // listens on the same element and must see the editor's preventDefault first.
    const panelListeners = () => [['click', handlePanelClick], ['keydown', handlePanelKeydown, true],
      ['input', handlePanelInput], ['compositionend', handleCompositionEnd], ['focusout', handlePanelFocusOut]];

    const refresh = () => (projectId() && !disposed ? fetchNote(projectId()) : Promise.resolve(null));

    function open() {
      if (disposed) return false;
      const ps = projects.get(projectId());
      if (ps && ps.view !== 'editing') ps.loaded = false; // revalidate on every open (not under a live editor); the cached note paints meanwhile
      openArtifactRail('notes');
      renderArtifactReviewPanel();
      return true;
    }

    const close = () => { if (!disposed && isOpen()) toggleArtifactReview(); };

    const toggle = () => (isOpen() ? close() : open());

    function bind() {
      if (disposed) return;
      ensureSubscribed();
      if (panelEl?.addEventListener && !panelEl.dataset.notesRailBound) {
        panelEl.dataset.notesRailBound = listenerToken;
        for (const [type, listener, capture] of panelListeners()) panelEl.addEventListener(type, listener, capture === true);
        panelListenersBound = true;
      }
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      for (const [pid, ps] of projects) {
        for (const timer of [ps.saveTimer, ps.heartbeatTimer, ps.releaseTimer]) clearT(timer);
        // A draft still inside the debounce is saved best-effort rather than dropped with the renderer.
        if (ps.dirty && !ps.saving && ps.error?.kind !== 'stale') {
          try { Promise.resolve(notesApi()?.save?.(pid, ps.draft, ps.baseRevision)).catch(noop); } catch (_error) { /* nothing left to do */ }
        }
        if (ps.leaseHeld) setLease(pid, ps, false);
      }
      if (typeof unsubscribeChanged === 'function') unsubscribeChanged();
      unsubscribeChanged = null;
      if (panelListenersBound) {
        for (const [type, listener, capture] of panelListeners()) panelEl.removeEventListener(type, listener, capture === true);
        if (panelEl.dataset.notesRailBound === listenerToken) delete panelEl.dataset.notesRailBound;
      }
    }

    const getModelForTests = () => (projectId() ? { ...buildModel(projectId(), projectState(projectId())), view: projectState(projectId()).view } : null);

    return {
      bind, dispose, open, close, toggle, isOpen, refresh, renderRailContent, switchToTasks, _getModelForTests: getModelForTests,
    };
  }

  return { createProjectNotesRail };
});
