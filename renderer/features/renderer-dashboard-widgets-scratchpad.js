/* Quick-capture scratchpad widget for the Home dashboard.
 *
 * A small set of named notes (tabs), an "⋯" actions menu (send-to-chat /
 * copy / open-loop / calendar / save-as-file), inline rename, and quiet save
 * trust signals. A scratchpad with no notes yet renders the single-textarea
 * pad.
 *
 * The DOM builds once per card body; repaints only sync the textarea value
 * when it is NOT focused (a paint mid-typing never clobbers input) and rebuild
 * the tab strip only when its structure changes (render-key skip). Persistence
 * and routing live in the scratchpad-actions module (injected by the manager).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDashboardWidgetsScratchpad = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const MAX_NOTES = 8;            // mirrors MAX_HOME_SCRATCHPAD_NOTES
  const MAX_PINS = 4;            // mirrors MAX_HOME_SCRATCHPAD_PINS
  const MAX_NOTE_CHARS = 4000;    // mirrors MAX_HOME_SCRATCHPAD_CHARS
  const COUNT_VISIBLE_AT = 3600;  // show the n/4000 counter only near the cap
  const STATUS_CLEAR_MS = 4000;
  const MIN_ROWS = 3;             // mirrors HOME_SCRATCHPAD_ROWS_MIN
  const MAX_ROWS = 30;            // mirrors HOME_SCRATCHPAD_ROWS_MAX
  const DEFAULT_ROWS = 6;        // mirrors HOME_SCRATCHPAD_ROWS_DEFAULT
  const BODY_TEARDOWNS = new WeakMap();

  function defer(fn) {
    Promise.resolve().then(fn);
  }

  function createScratchpadWidget(deps = {}) {
    const textField = typeof deps.textField === 'function'
      ? deps.textField
      : (typeof windowRef.inventoryTextField === 'function' ? windowRef.inventoryTextField : null);
    const actionButton = typeof deps.actionButton === 'function'
      ? deps.actionButton
      : (typeof windowRef.inventoryActionButton === 'function' ? windowRef.inventoryActionButton : null);
    const actions = deps.actions || null;
    const contextMenu = deps.contextMenu
      || (windowRef.inventoryContextMenu && typeof windowRef.inventoryContextMenu.show === 'function'
        ? windowRef.inventoryContextMenu : null);
    const buildScratchpadMenu = (deps.menuModule && deps.menuModule.buildScratchpadMenu)
      || (windowRef.rendererDashboardScratchpadMenu && windowRef.rendererDashboardScratchpadMenu.buildScratchpadMenu)
      || null;
    // Opt-in markdown/checklist preview (scratchpad.settings.markdown). Absent
    // module ⇒ the preview toggle never renders, so the plain-text path is
    // completely untouched.
    const markdownModule = deps.markdownModule || windowRef.rendererDashboardScratchpadMarkdown || null;
    const nowProvider = typeof deps.nowProvider === 'function' ? deps.nowProvider : () => new Date();
    const escapeHtml = typeof textField?.escapeHtml === 'function' ? textField.escapeHtml : (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
    // Optimistic active note (lazily adopted from config), the last scratchpad
    // rendered (so delegated handlers can read note ids), the in-progress rename
    // target, a pending status-clear timer, and a one-shot "focus the textarea
    // after the next render" flag (used after add/switch so focus lands on the
    // freshly-built node, not a node about to be replaced by the echo repaint).
    let localActiveId = null;
    let lastConfigActiveId = null;
    let lastScratchpad = null;
    let renamingNoteId = null;
    let statusTimer = null;
    let bodyTeardown = null;
    let focusAfterRender = false;
    // Transient view state for the markdown preview (never persisted). Reset to
    // edit on any note switch/add/delete so a tab change always lands on the
    // editable textarea, not a stale preview of the previous note.
    let previewMode = false;
    // The note text last rendered into the preview pane, so a repaint (30s tick /
    // stats update) skips reparsing identical HTML — which would otherwise drop
    // keyboard focus from a focused checklist row and waste work.
    let lastPreviewText = null;
    // Last font/height applied to the field, so an idle repaint skips redundant
    // writes when presentation changes from the widget menu.
    let appliedFont = null;
    let appliedRows = null;
    // One-shot: id of a just-added note so its tab plays the grow-in animation
    // exactly once (cleared the moment the strip is built).
    let newNoteId = null;

    function getNotes(scratchpad) {
      return Array.isArray(scratchpad?.notes) ? scratchpad.notes : [];
    }

    function resolveActiveId(scratchpad) {
      const notes = getNotes(scratchpad);
      if (localActiveId && notes.some((note) => note.id === localActiveId)) {
        return localActiveId;
      }
      const configActive = scratchpad?.activeNoteId;
      if (notes.some((note) => note.id === configActive)) {
        return configActive;
      }
      return notes[0]?.id || '';
    }

    function getActiveNote(scratchpad) {
      const notes = getNotes(scratchpad);
      if (notes.length === 0) {
        return null;
      }
      const id = resolveActiveId(scratchpad);
      return notes.find((note) => note.id === id) || notes[0];
    }

    function relativeTime(iso, now) {
      if (!iso) {
        return '';
      }
      const then = Date.parse(iso);
      if (!Number.isFinite(then)) {
        return '';
      }
      const deltaSec = Math.floor((now.getTime() - then) / 1000);
      if (deltaSec < 45) {
        return jt('dashboard.widgets.scratchpad.justNow', 'just now');
      }
      const min = Math.floor(deltaSec / 60);
      if (min < 60) {
        return jtn('dashboard.widgets.scratchpad.minutesAgo', min, { count: min }, '{count}m ago', '{count}m ago');
      }
      const hr = Math.floor(min / 60);
      if (hr < 24) {
        return jtn('dashboard.widgets.scratchpad.hoursAgo', hr, { count: hr }, '{count}h ago', '{count}h ago');
      }
      return jtn('dashboard.widgets.scratchpad.daysAgo', Math.floor(hr / 24), { count: Math.floor(hr / 24) }, '{count}d ago', '{count}d ago');
    }

    function setNote(body, message, isError) {
      const note = body.querySelector('[data-scratchpad-note]');
      if (!note) {
        return;
      }
      note.textContent = message || '';
      note.dataset.state = isError ? 'error' : '';
      if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = null;
      }
      if (message) {
        statusTimer = setTimeout(() => {
          statusTimer = null;
          if (note.isConnected !== false) {
            note.textContent = '';
            note.dataset.state = '';
          }
        }, STATUS_CLEAR_MS);
        // Never hold a Node test process (or the app) open on this cosmetic timer.
        statusTimer.unref?.();
      }
    }

    function setMeta(body, text) {
      const meta = body.querySelector('[data-scratchpad-meta]');
      if (meta && meta.textContent !== text) {
        meta.textContent = text;
      }
    }

    function syncSavedAt(body, activeNote) {
      const rel = relativeTime(activeNote?.updatedAt, nowProvider());
      setMeta(body, rel ? jt('dashboard.widgets.scratchpad.savedAt', 'Saved · {time}', { time: rel }) : '');
    }

    // A pad write settled. Failure replaces "Saving…" with the error (the draft
    // stays pending and retries on the next edit, blur or note action); success
    // refreshes "Saved · …" unless a newer draft is already queued, which also
    // clears a "Saving…" whose write needed no echo (a draft for a deleted note).
    function settleSave(body, saved) {
      if (saved === false) {
        setMeta(body, '');
        setNote(body, jt('dashboard.scratchpad.actions.saveNoteFailed', 'Could not save the note.'), true);
        return;
      }
      const active = getActiveNote(lastScratchpad);
      if (saved === true && active && actions?.pendingDraftFor?.(active.id) == null) {
        syncSavedAt(body, active);
      }
    }

    function syncCount(body, text) {
      const countEl = body.querySelector('[data-scratchpad-count]');
      if (!countEl) {
        return;
      }
      const len = String(text || '').length;
      const visible = len >= COUNT_VISIBLE_AT;
      const label = visible ? `${len}/${MAX_NOTE_CHARS}` : '';
      const state = visible && len >= MAX_NOTE_CHARS ? 'danger' : '';
      if (countEl.textContent !== label) countEl.textContent = label;
      if (countEl.dataset.state !== state) countEl.dataset.state = state;
    }

    // `hasDraft`: unsaved text is on screen, so leave the meta alone ("Saving…"
    // while queued, blank after a failed write) rather than claim "Saved".
    function syncMeta(body, activeNote, text, hasDraft) {
      syncCount(body, text);
      if (!hasDraft) {
        syncSavedAt(body, activeNote);
      }
    }

    function copyToClipboard(text, documentRef) {
      const nav = (documentRef?.defaultView || windowRef)?.navigator;
      if (nav?.clipboard?.writeText) {
        return nav.clipboard.writeText(String(text)).then(() => true, () => false);
      }
      let area = null;
      try {
        area = documentRef.createElement('textarea');
        area.value = String(text);
        area.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
        documentRef.body.appendChild(area);
        area.select();
        const ok = typeof documentRef.execCommand === 'function' && documentRef.execCommand('copy');
        return Boolean(ok);
      } catch (_error) {
        return false;
      } finally {
        area?.remove();
      }
    }

    // ---- multi-note markup -------------------------------------------------

    function tabLabel(note, index) {
      const title = String(note?.title || '').trim();
      const generated = /^Note (\d+)$/.exec(title);
      if (title && !generated) {
        return title;
      }
      return jt('dashboard.widgets.scratchpad.noteNumber', 'Note {number}', { number: generated ? generated[1] : index + 1 });
    }

    // The active tab gets a rename pencil; every tab past the one-note floor
    // gets a close ×. Both sit at tabIndex -1 (reached via hover / right-click
    // / Delete) so the roving-tabindex arrow nav still cycles only the tab
    // buttons, never these controls.
    function tabControl(noteId, kind, glyph, ariaLabel, title) {
      return actionButton({
        plain: true,
        className: `dashboard-scratchpad__tab-${kind}`,
        label: glyph,
        ariaLabel,
        tabIndex: -1,
        title,
        dataset: { [`scratchpad-${kind}`]: noteId },
      });
    }

    function buildTabsHtml(notes, activeId) {
      const atFloor = notes.length <= 1;
      const renameLabel = jt('dashboard.widgets.scratchpad.renameNote', 'Rename note');
      const tabs = notes.map((note, index) => {
        const label = tabLabel(note, index);
        const selected = note.id === activeId;
        const tab = actionButton({
          plain: true,
          className: 'dashboard-scratchpad__tab',
          label,
          role: 'tab',
          ariaSelected: selected,
          ariaControls: 'homeScratchpadPanel',
          tabIndex: selected ? 0 : -1,
          title: jt('dashboard.widgets.scratchpad.doubleClickRename', '{label} — double-click to rename', { label }),
          dataset: { 'scratchpad-tab': note.id },
        });
        const edit = selected ? tabControl(note.id, 'edit', '✎', renameLabel, renameLabel) : '';
        const close = atFloor ? '' : tabControl(note.id, 'close', '×', jt('dashboard.widgets.scratchpad.deleteNamedNote', 'Delete {label}', { label }), jt('dashboard.widgets.scratchpad.deleteNote', 'Delete note'));
        const wrapClass = 'dashboard-scratchpad__tab-wrap'
          + (note.id === newNoteId ? ' dashboard-scratchpad__tab-wrap--new' : '');
        return `<div class="${wrapClass}">` + tab + edit + close + '</div>';
      }).join('');
      const atCap = notes.length >= MAX_NOTES;
      const add = actionButton({
        plain: true,
        className: 'dashboard-scratchpad__tab-add',
        label: '+',
        ariaLabel: jt('dashboard.widgets.scratchpad.newNote', 'New note'),
        disabled: atCap,
        title: atCap ? jt('dashboard.widgets.scratchpad.noteLimit', 'Up to {count} notes — delete one to add another', { count: MAX_NOTES }) : jt('dashboard.widgets.scratchpad.newNote', 'New note'),
        dataset: { 'scratchpad-add': '1' },
      });
      // The grow-in is one-shot: consuming newNoteId here means a later repaint
      // (idle tick / note switch) rebuilds the same tab without re-animating.
      newNoteId = null;
      return '<div class="dashboard-scratchpad__tabs" role="tablist" aria-label="' + escapeHtml(jt('dashboard.widgets.scratchpad.notesLabel', 'Scratchpad notes')) + '">'
        + tabs + add + '</div>';
    }

    function buildFooterHtml(markdownOn, inPreview) {
      const previewToggle = markdownOn
        ? actionButton({
          plain: true,
          className: 'dashboard-scratchpad__preview-toggle',
          label: inPreview ? jt('common.edit', 'Edit') : jt('dashboard.widgets.scratchpad.preview', 'Preview'),
          ariaPressed: inPreview,
          title: inPreview ? jt('dashboard.widgets.scratchpad.backToEditing', 'Back to editing') : jt('dashboard.widgets.scratchpad.previewMarkdown', 'Preview markdown & checklists'),
          dataset: { 'scratchpad-preview-toggle': '1' },
        })
        : '';
      return '<div class="dashboard-scratchpad__footer">'
        + '<span class="dashboard-scratchpad__note" data-scratchpad-note aria-live="polite"></span>'
        + '<div class="dashboard-scratchpad__actions">'
        + '<span class="dashboard-scratchpad__count" data-scratchpad-count></span>'
        + '<span class="dashboard-scratchpad__saved" data-scratchpad-meta></span>'
        + previewToggle
        + actionButton({
          plain: true,
          className: 'dashboard-scratchpad__menu-btn',
          label: '⋯',
          ariaLabel: jt('dashboard.widgets.scratchpad.noteActions', 'Note actions'),
          title: jt('dashboard.widgets.scratchpad.noteActions', 'Note actions'),
          ariaHaspopup: 'menu',
          dataset: { 'scratchpad-actions': '1' },
        })
        + '</div>'
        + '</div>';
    }

    function buildFieldHtml(text, markdownOn) {
      return textField({
        id: 'homeScratchpadInput',
        multiline: true,
        value: text,
        maxLength: MAX_NOTE_CHARS,
        placeholder: markdownOn
          ? jt('dashboard.widgets.scratchpad.markdownPlaceholder', 'New note — jot, list, or “- [ ] task” for a checklist')
          : jt('dashboard.widgets.scratchpad.placeholder', 'Jot something down…'),
        ariaLabel: jt('dashboard.widgets.scratchpad.quickLabel', 'Quick scratchpad'),
        spellcheck: true,
        className: 'dashboard-scratchpad__field',
      });
    }

    function renderPreviewInner(text) {
      if (String(text || '').trim() === '') {
        return '<div class="dashboard-scratchpad__preview-empty">' + escapeHtml(jt('dashboard.widgets.scratchpad.nothingToPreview', 'Nothing to preview yet.')) + '</div>';
      }
      if (markdownModule && typeof markdownModule.renderPreviewHtml === 'function') {
        return markdownModule.renderPreviewHtml(String(text || ''), { actionButton, escapeHtml });
      }
      return '<div class="dashboard-scratchpad__preview-line">' + escapeHtml(String(text || '')) + '</div>';
    }

    function buildPreviewHtml(text) {
      return '<div class="dashboard-scratchpad__preview" data-scratchpad-preview'
        + ' role="group" aria-label="' + escapeHtml(jt('dashboard.widgets.scratchpad.previewLabel', 'Note preview')) + '">'
        + renderPreviewInner(text)
        + '</div>';
    }

    // Markdown preview is available only when the opt-in setting is on AND the
    // preview module loaded; otherwise the plain textarea path is unchanged.
    function markdownEnabled(scratchpad) {
      return Boolean(markdownModule) && scratchpad?.settings?.markdown === true;
    }

    // Reflect the persisted font/height settings on the live field without a
    // rebuild, so a Settings change shows on the next Home repaint. rows is
    // re-clamped defensively (the schema is the real enforcer).
    function applyFieldSettings(body, scratchpad, force) {
      const settings = scratchpad?.settings || null;
      const font = settings && settings.font === 'mono' ? 'mono' : 'prose';
      const raw = settings && Number.isFinite(Number(settings.rows)) ? Math.trunc(Number(settings.rows)) : DEFAULT_ROWS;
      const rows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, raw));
      // Idle repaints (the 30s tick) skip the DOM writes when nothing changed; a
      // rebuild passes force=true because its textarea is fresh (rows reset to 3).
      if (!force && font === appliedFont && rows === appliedRows) {
        return;
      }
      const rootEl = body.querySelector('.dashboard-scratchpad');
      if (rootEl) {
        rootEl.dataset.font = font;
      }
      const ta = body.querySelector('#homeScratchpadInput');
      if (ta) {
        ta.rows = rows;
        // A new floor (grip drag / Settings change) re-measures against it.
        autosizeField(ta);
      }
      appliedFont = font;
      appliedRows = rows;
    }

    // Auto-grow the field to its content: reset the height so the box collapses
    // to the rows-derived floor, then take the measured scrollHeight. `rows`
    // therefore stays the MINIMUM (a shorter note can never shrink past it) and
    // the stylesheet's max-height is the ceiling, past which the field scrolls
    // internally again. Purely visual — this NEVER writes config; only the
    // corner grip persists rows.
    function autosizeField(textarea) {
      if (!textarea || !textarea.style) {
        return;
      }
      textarea.style.height = 'auto';
      const measured = Number(textarea.scrollHeight);
      if (Number.isFinite(measured) && measured > 0) {
        textarea.style.height = `${measured}px`;
      }
    }

    function tabsKeyFor(notes, activeId) {
      return JSON.stringify([notes.map((n) => n.id), notes.map((n) => String(n.title || '')), activeId]);
    }

    function tabElements(body) {
      return Array.prototype.slice.call(body.querySelectorAll('[data-scratchpad-tab]'));
    }

    function findTab(body, noteId) {
      return tabElements(body).find((el) => el.dataset.scratchpadTab === noteId) || null;
    }

    function focusTextarea(body) {
      const ta = body.querySelector('#homeScratchpadInput');
      if (ta) {
        defer(() => { try { ta.focus(); } catch (_error) { /* focus is best-effort */ } });
      }
    }

    // Keep the active tab visible when the strip overflows (many notes). Minimal
    // scroll (nearest) so it never tugs the page vertically; best-effort across
    // environments that lack scrollIntoView options.
    function scrollActiveTabIntoView(body, activeId) {
      const tab = findTab(body, activeId);
      if (tab && typeof tab.scrollIntoView === 'function') {
        try {
          tab.scrollIntoView({ inline: 'nearest', block: 'nearest' });
        } catch (_error) {
          /* options-form unsupported ⇒ leave scroll position as-is */
        }
      }
    }

    // ---- interactions ------------------------------------------------------

    // Settle a note action: show its { error } in the footer, else hand the
    // result to `onOk` (optional).
    function runNoteAction(body, pending, onOk) {
      void Promise.resolve(pending).then((result) => {
        if (result && result.error) {
          setNote(body, result.error, true);
          return;
        }
        onOk?.(result);
      });
    }

    function switchTo(body, noteId) {
      if (!noteId || !actions?.setActiveNote) {
        return;
      }
      if (resolveActiveId(lastScratchpad) === noteId) {
        focusTextarea(body);
        return;
      }
      // setActiveNote flushes the outgoing note's pending save first (the queued
      // save is pinned to the OLD note id), then persists the pointer.
      runNoteAction(body, actions.setActiveNote(noteId), (result) => {
        if (result?.ok === true) adoptActive(body, noteId);
      });
    }

    // Select `noteId` after a switch/add/delete settled: back to the editable
    // textarea, focus it, and re-render now — the config echo already repainted
    // with the OLD active id, so this makes the right note selected before any
    // input can fire and consumes the focus flag immediately.
    function adoptActive(body, noteId) {
      localActiveId = noteId;
      previewMode = false;
      focusAfterRender = renamingNoteId == null;
      renderMulti(body, lastScratchpad);
    }

    function addNote(body) {
      if (!actions?.addNote) {
        return;
      }
      runNoteAction(body, actions.addNote(), (result) => {
        if (result && result.activeNoteId) {
          // Play the grow-in once. The write's echo already rebuilt the strip
          // (before this id was known), so force one more strip build to show it.
          newNoteId = result.activeNoteId;
          body.dataset.scratchpadTabsKey = '';
          adoptActive(body, result.activeNoteId);
        }
      });
    }

    function deleteNote(body, noteId) {
      if (!actions?.deleteNote) {
        return;
      }
      const activeBefore = resolveActiveId(lastScratchpad);
      runNoteAction(body, actions.deleteNote(noteId), (result) => {
        // Deleting a background tab keeps the active note, its view and focus.
        if (result && result.activeNoteId && result.activeNoteId !== activeBefore) {
          adoptActive(body, result.activeNoteId);
        }
      });
    }

    // Quick-delete entry point for the per-tab × and the Delete key. A note with
    // content routes through a one-item confirm (reuse the context menu) so a
    // stray click can't drop written text; an empty note deletes immediately.
    function requestDelete(body, noteId, anchor) {
      const notes = getNotes(lastScratchpad);
      const note = notes.find((n) => n.id === noteId);
      if (!note) {
        return;
      }
      // The active note's live field may hold text its save hasn't persisted yet.
      const live = noteId === resolveActiveId(lastScratchpad)
        ? body.querySelector('#homeScratchpadInput')?.value
        : undefined;
      const hasText = String(live ?? note.text ?? '').trim() !== '';
      if (!hasText || !contextMenu?.show) {
        deleteNote(body, noteId);
        return;
      }
      const label = tabLabel(note, notes.indexOf(note));
      contextMenu.show({
        items: [
          { label: jt('dashboard.widgets.scratchpad.deleteNamedNoteQuoted', 'Delete “{label}”', { label }), action: () => deleteNote(body, noteId) },
        ],
        anchorX: anchor.x,
        anchorY: anchor.y,
        rootEl: body,
      });
    }

    function beginRename(body, noteId) {
      const tab = findTab(body, noteId);
      // Every v2 tab is wrapped (buildTabsHtml); the legacy path has no tabs, so
      // beginRename is unreachable there. Bail if either is somehow missing.
      const wrap = tab?.closest?.('.dashboard-scratchpad__tab-wrap');
      if (!wrap || !textField) {
        return;
      }
      renamingNoteId = noteId;
      const note = getNotes(lastScratchpad).find((n) => n.id === noteId);
      // Replace the WHOLE tab wrapper, not just the label button — otherwise the
      // sibling hover controls (× / pencil) linger over the rename input.
      // endRename rebuilds the strip, restoring everything.
      wrap.innerHTML = textField({
        id: 'homeScratchpadRename',
        value: String(note?.title || ''),
        maxLength: 60,
        ariaLabel: jt('dashboard.widgets.scratchpad.renameNote', 'Rename note'),
        spellcheck: true,
        className: 'dashboard-scratchpad__rename',
        dataset: { 'scratchpad-rename': noteId },
      });
      defer(() => {
        const input = body.querySelector('#homeScratchpadRename');
        if (input) {
          input.focus();
          if (typeof input.select === 'function') {
            input.select();
          }
        }
      });
    }

    function endRename(body, commit, input) {
      if (renamingNoteId == null) {
        return;
      }
      const noteId = renamingNoteId;
      const value = input ? input.value : '';
      renamingNoteId = null;
      if (commit && actions?.renameNote) {
        runNoteAction(body, actions.renameNote(noteId, value));
      }
      // Force a strip rebuild so the inline input is replaced even when the title
      // is unchanged (an unchanged title leaves the render-key untouched, so the
      // echo repaint alone would leave the input in place).
      body.dataset.scratchpadTabsKey = '';
      if (lastScratchpad) {
        renderMulti(body, lastScratchpad);
      }
    }

    // Toggle a `- [ ]`/`- [x]` checklist line from the preview, persist, and
    // re-render. Optimistic: the preview repaints from a local copy of the note
    // immediately (shared app state only changes through the echo), then the
    // debounced writer is flushed so the change lands without waiting.
    function toggleCheck(body, lineIndex) {
      if (!markdownModule || typeof markdownModule.toggleChecklistLine !== 'function') {
        return;
      }
      // Settle any in-flight/pending pad save FIRST (e.g. edits made right before
      // entering preview, flushed on the textarea's focusout) so the toggle lands
      // on the latest reconciled text, never a stale pre-echo snapshot — then
      // read, toggle, persist. A failed settle leaves an unsaved draft the toggle
      // would overwrite, so stop and say so instead.
      Promise.resolve(actions?.flushSave?.()).then((saved) => {
        if (saved === false) {
          settleSave(body, false);
          return;
        }
        const note = getActiveNote(lastScratchpad);
        if (!note) {
          return;
        }
        const current = String(note.text || '');
        const nextText = markdownModule.toggleChecklistLine(current, lineIndex);
        if (nextText === current) {
          return;
        }
        lastScratchpad = {
          ...lastScratchpad,
          notes: getNotes(lastScratchpad).map((n) => (n === note ? { ...n, text: nextText } : n)),
        };
        renderMulti(body, lastScratchpad);
        if (actions?.queueSave) {
          actions.queueSave(nextText, note.id);
          void Promise.resolve(actions.flushSave?.()).then((ok) => settleSave(body, ok));
        }
      });
    }

    function openActionsMenu(body, anchor) {
      if (!contextMenu?.show || !buildScratchpadMenu) {
        return;
      }
      const ta = body.querySelector('#homeScratchpadInput');
      const active = getActiveNote(lastScratchpad);
      // In markdown preview the textarea is gone; act on the note's saved text.
      const text = ta ? ta.value : String(active?.text || '');
      const selection = ta && typeof ta.selectionStart === 'number'
        ? String(ta.value).slice(ta.selectionStart, ta.selectionEnd)
        : '';
      const documentRef = body.ownerDocument;
      // Pin state for the active note.
      const pins = Array.isArray(lastScratchpad?.pins) ? lastScratchpad.pins : [];
      const pinOpts = active
        ? { noteId: active.id, isPinned: pins.includes(active.id), pinsAtCap: pins.length >= MAX_PINS }
        : {};
      const present = (items) => contextMenu.show({
        items,
        anchorX: anchor.x,
        anchorY: anchor.y,
        rootEl: body,
        onActionError: (error) => setNote(body, String(error?.message || error || jt('dashboard.widgets.scratchpad.actionFailed', 'Action failed.')), true),
      });
      const finish = (canSaveFile) => present(buildScratchpadMenu({
        actions,
        text,
        selection,
        title: String(active?.title || ''),
        canSaveFile,
        settings: lastScratchpad?.settings || {},
        copyText: (value) => copyToClipboard(value, documentRef),
        onResult: (message, isError) => setNote(body, message, isError),
        ...pinOpts,
      }));
      if (actions?.canSaveFile) {
        Promise.resolve(actions.canSaveFile()).then(finish, () => finish(false));
      } else {
        finish(false);
      }
    }

    function openTabMenu(body, noteId, anchor) {
      if (!contextMenu?.show) {
        return;
      }
      const isLast = getNotes(lastScratchpad).length <= 1;
      contextMenu.show({
        items: [
          { label: jt('common.rename', 'Rename'), action: () => beginRename(body, noteId) },
          { separator: true },
          {
            label: jt('dashboard.widgets.scratchpad.deleteNote', 'Delete note'),
            disabled: isLast,
            shortcutHint: isLast ? jt('dashboard.widgets.scratchpad.lastNoteHint', 'last note') : '',
            action: isLast ? undefined : () => deleteNote(body, noteId),
          },
        ],
        anchorX: anchor.x,
        anchorY: anchor.y,
        rootEl: body,
      });
    }

    // Pointer position when the event has one, else just below `fallbackEl`
    // (keyboard paths pass a null event).
    function menuAnchor(event, fallbackEl) {
      if (event?.clientX || event?.clientY) {
        return { x: event.clientX || 0, y: event.clientY || 0 };
      }
      const rect = fallbackEl?.getBoundingClientRect?.();
      return { x: rect ? rect.left : 0, y: rect ? rect.bottom : 0 };
    }

    // Delegated listeners are bound once per body (render() calls this first);
    // the WeakMap entry identifies this widget's live binding.
    function bindBody(body) {
      if (bodyTeardown && BODY_TEARDOWNS.get(body) === bodyTeardown) {
        return;
      }
      BODY_TEARDOWNS.get(body)?.();
      bodyTeardown?.();

      function handleInput(event) {
        const target = event.target;
        if (target?.id !== 'homeScratchpadInput') {
          return;
        }
        // Auto-grow first: it is presentation only, so it must not depend on a
        // save pipeline being wired.
        autosizeField(target);
        syncCount(body, target.value);
        if (!actions) {
          return;
        }
        // Per keystroke: touch the status line only when it actually changes.
        if (body.querySelector('[data-scratchpad-note]')?.textContent) {
          setNote(body, '', false);
        }
        setMeta(body, jt('common.saving', 'Saving…'));
        const noteId = body.querySelector('.dashboard-scratchpad__tab[aria-selected="true"]')
          ?.dataset.scratchpadTab || '';
        actions.queueSave(target.value, noteId, (saved) => settleSave(body, saved));
      }

      function handleClick(event) {
        const target = event.target;
        if (!actions || !target?.closest) {
          return;
        }
        // Legacy single-note "Turn into open loop" button.
        if (target.closest('[data-scratchpad-to-loop]')) {
          const textarea = body.querySelector('#homeScratchpadInput');
          void actions.promoteToLoop(textarea ? textarea.value : '').then((result) => {
            setNote(body, result?.error || jt('dashboard.widgets.scratchpad.savedToOpenLoops', 'Saved to Open Loops.'), Boolean(result?.error));
          });
          return;
        }
        const editBtn = target.closest('[data-scratchpad-edit]');
        if (editBtn) {
          beginRename(body, editBtn.dataset.scratchpadEdit);
          return;
        }
        const closeBtn = target.closest('[data-scratchpad-close]');
        if (closeBtn) {
          requestDelete(body, closeBtn.dataset.scratchpadClose, menuAnchor(event, closeBtn));
          return;
        }
        const tab = target.closest('[data-scratchpad-tab]');
        if (tab) {
          switchTo(body, tab.dataset.scratchpadTab);
          return;
        }
        if (target.closest('[data-scratchpad-add]')) {
          addNote(body);
          return;
        }
        if (target.closest('[data-scratchpad-preview-toggle]')) {
          previewMode = !previewMode;
          renderMulti(body, lastScratchpad);
          return;
        }
        const checkRow = target.closest('[data-scratchpad-check]');
        if (checkRow) {
          toggleCheck(body, Number(checkRow.dataset.scratchpadCheck));
          return;
        }
        const menuBtn = target.closest('[data-scratchpad-actions]');
        if (menuBtn) {
          openActionsMenu(body, menuAnchor(event, menuBtn));
        }
      }

      function handleDoubleClick(event) {
        const tab = event.target?.closest?.('[data-scratchpad-tab]');
        if (tab) {
          beginRename(body, tab.dataset.scratchpadTab);
        }
      }

      function handleContextMenu(event) {
        const tab = event.target?.closest?.('[data-scratchpad-tab]');
        if (tab) {
          event.preventDefault();
          openTabMenu(body, tab.dataset.scratchpadTab, menuAnchor(event, tab));
        }
      }

      function handleKeydown(event) {
        const target = event.target;
        if (target?.dataset?.scratchpadRename != null) {
          if (event.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            endRename(body, true, target);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            endRename(body, false, target);
          }
          return;
        }
        const tab = target?.closest?.('[data-scratchpad-tab]');
        if (!tab) {
          return;
        }
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          const tabs = tabElements(body);
          const index = tabs.indexOf(tab);
          const next = event.key === 'ArrowRight' ? tabs[index + 1] : tabs[index - 1];
          if (next) {
            next.focus();
          }
        } else if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
          event.preventDefault();
          openTabMenu(body, tab.dataset.scratchpadTab, menuAnchor(null, tab));
        } else if (event.key === 'Delete') {
          event.preventDefault();
          if (getNotes(lastScratchpad).length > 1) {
            requestDelete(body, tab.dataset.scratchpadTab, menuAnchor(null, tab));
          }
        } else if (event.key === 'F2') {
          event.preventDefault();
          beginRename(body, tab.dataset.scratchpadTab);
        }
      }

      function handleFocusOut(event) {
        const target = event.target;
        if (target?.dataset?.scratchpadRename != null && renamingNoteId != null) {
          const relatedTarget = event.relatedTarget;
          const movedIntoContextMenu = relatedTarget
            && typeof relatedTarget.closest === 'function'
            && relatedTarget.closest('.inv-context-menu');
          // Opening the body-level menu is not leaving the field: it synchronously takes focus.
          if (!movedIntoContextMenu) endRename(body, true, target);
        }
        // Persist the pad the moment the textarea loses focus, so the last
        // <600ms of typing survives a click-away AND a capture-from-anywhere
        // write (which reads shared state) can never race this debounce.
        if (target?.id === 'homeScratchpadInput' && actions?.flushSave) {
          void Promise.resolve(actions.flushSave()).then((saved) => settleSave(body, saved));
        }
      }

      body.addEventListener('input', handleInput);
      body.addEventListener('click', handleClick);
      body.addEventListener('dblclick', handleDoubleClick);
      body.addEventListener('contextmenu', handleContextMenu);
      body.addEventListener('keydown', handleKeydown);
      body.addEventListener('focusout', handleFocusOut);
      const teardown = () => {
        body.removeEventListener('input', handleInput);
        body.removeEventListener('click', handleClick);
        body.removeEventListener('dblclick', handleDoubleClick);
        body.removeEventListener('contextmenu', handleContextMenu);
        body.removeEventListener('keydown', handleKeydown);
        body.removeEventListener('focusout', handleFocusOut);
        if (statusTimer) {
          clearTimeout(statusTimer);
          statusTimer = null;
        }
        if (BODY_TEARDOWNS.get(body) === teardown) BODY_TEARDOWNS.delete(body);
        if (bodyTeardown === teardown) bodyTeardown = null;
      };
      bodyTeardown = teardown;
      BODY_TEARDOWNS.set(body, teardown);
    }

    // ---- render ------------------------------------------------------------

    function renderLegacy(body, scratchpad) {
      const text = String(getActiveNote(scratchpad)?.text ?? '');
      if (!body.querySelector('#homeScratchpadInput')) {
        body.innerHTML = '<div class="dashboard-scratchpad">'
          + buildFieldHtml(text)
          + '<div class="dashboard-scratchpad__footer">'
          + '<span class="dashboard-scratchpad__note" data-scratchpad-note aria-live="polite"></span>'
          + actionButton({
            variant: 'ghost',
            size: 'sm',
            label: jt('dashboard.widgets.scratchpad.turnIntoOpenLoop', 'Turn into open loop'),
            dataset: { 'scratchpad-to-loop': '1' },
          })
          + '</div>'
          + '</div>';
        return;
      }
      const textarea = body.querySelector('#homeScratchpadInput');
      if (textarea && body.ownerDocument.activeElement !== textarea && textarea.value !== text) {
        textarea.value = text;
        autosizeField(textarea);
      }
    }

    function renderMulti(body, scratchpad) {
      const activeNote = getActiveNote(scratchpad);
      if (!activeNote) {
        return;
      }
      const notes = getNotes(scratchpad);
      const activeId = activeNote.id;
      // A queued or failed-save draft is newer than the persisted text: show it,
      // never repaint the older text over it (the next keystroke would save that).
      const draft = actions?.pendingDraftFor?.(activeId) ?? null;
      const text = draft ?? String(activeNote.text ?? '');
      const key = tabsKeyFor(notes, activeId);
      const markdownOn = markdownEnabled(scratchpad);
      if (!markdownOn) {
        previewMode = false;
      }
      const showPreview = markdownOn && previewMode;
      // markdownOn is part of the view: it decides the footer's Preview toggle
      // and the field placeholder, which only a rebuild writes.
      const wantView = showPreview ? 'preview' : (markdownOn ? 'edit-md' : 'edit');

      const existing = body.querySelector('#homeScratchpadInput');
      // Rebuild on a mode change, a view flip (edit⇄preview, markdown on/off), or
      // when the view's own node is missing (e.g. after the registry replaced a
      // body whose render threw). The view dataset is what lets the preview
      // toggle swap the field for the preview pane (the textarea still exists at
      // that moment, so the sync path alone would never switch views).
      const needsRebuild = body.dataset.scratchpadMode !== 'multi'
        || body.dataset.scratchpadView !== wantView
        || !(showPreview ? body.querySelector('[data-scratchpad-preview]') : existing);
      if (needsRebuild) {
        body.dataset.scratchpadMode = 'multi';
        body.dataset.scratchpadView = wantView;
        body.innerHTML = '<div class="dashboard-scratchpad" data-scratchpad-v2>'
          + buildTabsHtml(notes, activeId)
          + '<div class="dashboard-scratchpad__panel" id="homeScratchpadPanel"'
          + ' role="tabpanel" aria-label="' + escapeHtml(jt('dashboard.widgets.scratchpad.noteContent', 'Note content')) + '">'
          + (showPreview ? buildPreviewHtml(text) : buildFieldHtml(text, markdownOn))
          + '</div>'
          + buildFooterHtml(markdownOn, previewMode)
          + '</div>';
        body.dataset.scratchpadTabsKey = key;
        lastPreviewText = showPreview ? text : null;
        // The fresh DOM has no rename input, so no rename is open any more.
        renamingNoteId = null;
        scrollActiveTabIntoView(body, activeId);
      } else if (showPreview) {
        // Only rebuild the preview when the text actually changed (see lastPreviewText).
        if (lastPreviewText !== text) {
          body.querySelector('[data-scratchpad-preview]').innerHTML = renderPreviewInner(text);
          lastPreviewText = text;
        }
      } else if (body.ownerDocument.activeElement !== existing && existing.value !== text) {
        // Note switch / echoed save: the new text needs a fresh measurement.
        existing.value = text;
        autosizeField(existing);
      }
      // The strip-only sync is the single guard that protects a live rename
      // input (its `renamingNoteId == null` condition skips the rebuild).
      if (!needsRebuild && renamingNoteId == null && body.dataset.scratchpadTabsKey !== key) {
        const strip = body.querySelector('.dashboard-scratchpad__tabs');
        if (strip) {
          strip.outerHTML = buildTabsHtml(notes, activeId);
          scrollActiveTabIntoView(body, activeId);
        }
        body.dataset.scratchpadTabsKey = key;
      }
      applyFieldSettings(body, scratchpad, needsRebuild); // fresh DOM ⇒ always apply
      syncMeta(body, activeNote, text, draft !== null);
      if (focusAfterRender && !showPreview) {
        focusAfterRender = false;
        focusTextarea(body);
      }
    }

    return {
      id: 'scratchpad',
      title: jt('dashboard.widgets.scratchpad.title', 'Scratchpad'),
      render(body, ctx) {
        if (!body || !textField || !actionButton) {
          return;
        }
        bindBody(body);
        const scratchpad = ctx?.state?.homeConfig?.scratchpad;
        lastScratchpad = scratchpad;
        // Another writer (the pin popover's Open in Home) moved the persisted
        // active note: adopt it over this widget's last local pick.
        if (scratchpad?.activeNoteId !== lastConfigActiveId) {
          lastConfigActiveId = scratchpad?.activeNoteId;
          localActiveId = null;
        }
        if (getNotes(scratchpad).length > 0) {
          renderMulti(body, scratchpad);
        } else {
          renderLegacy(body, scratchpad);
        }
      },
      dispose() {
        bodyTeardown?.();
      },
    };
  }

  return { createScratchpadWidget };
});
