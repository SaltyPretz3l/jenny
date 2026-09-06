/* Quick-capture scratchpad widget for the Home dashboard.
 *
 * Flag OFF (scratchpad_v2 default): a single multi-line note bound to the
 * active note — identical to the pre-v2 pad. Flag ON: a small set of named
 * notes (tabs), an "⋯" actions menu (send-to-chat / copy / open-loop /
 * calendar / save-as-file), inline rename, and quiet save trust signals.
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

    // Optimistic active note (lazily adopted from config), the last scratchpad
    // rendered (so delegated handlers can read note ids), the in-progress rename
    // target, a pending status-clear timer, and a one-shot "focus the textarea
    // after the next render" flag (used after add/switch so focus lands on the
    // freshly-built node, not a node about to be replaced by the echo repaint).
    let localActiveId = null;
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
    // Whether the scratchpad_pin feature is on (captured each render from ctx), so
    // the actions menu only offers Pin/Unpin when the overlay is enabled.
    let pinFeatureOn = false;
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
        return 'just now';
      }
      const min = Math.floor(deltaSec / 60);
      if (min < 60) {
        return `${min}m ago`;
      }
      const hr = Math.floor(min / 60);
      if (hr < 24) {
        return `${hr}h ago`;
      }
      return `${Math.floor(hr / 24)}d ago`;
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
        if (statusTimer && typeof statusTimer.unref === 'function') {
          statusTimer.unref();
        }
      }
    }

    function setSaving(body) {
      const meta = body.querySelector('[data-scratchpad-meta]');
      if (meta) {
        meta.textContent = 'Saving…';
      }
    }

    function syncMeta(body, activeNote, text) {
      const countEl = body.querySelector('[data-scratchpad-count]');
      if (countEl) {
        const len = String(text || '').length;
        if (len >= COUNT_VISIBLE_AT) {
          countEl.textContent = `${len}/${MAX_NOTE_CHARS}`;
          countEl.dataset.state = len >= MAX_NOTE_CHARS ? 'danger' : '';
        } else {
          countEl.textContent = '';
          countEl.dataset.state = '';
        }
      }
      const metaEl = body.querySelector('[data-scratchpad-meta]');
      if (metaEl) {
        const rel = relativeTime(activeNote?.updatedAt, nowProvider());
        metaEl.textContent = rel ? `Saved · ${rel}` : '';
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
      return String(note?.title || '').trim() || `Note ${index + 1}`;
    }

    function buildTabsHtml(notes, activeId) {
      const atFloor = notes.length <= 1;
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
          title: `${label} — double-click to rename`,
          dataset: { 'scratchpad-tab': note.id },
        });
        // The active tab gets a rename pencil; every tab past the one-note floor
        // gets a close ×. Both sit at tabIndex -1 (reached via hover / right-click
        // / Delete) so the roving-tabindex arrow nav still cycles only the tab
        // buttons, never these controls.
        const tabControl = (kind, glyph, ariaLabel, title) => actionButton({
          plain: true,
          className: `dashboard-scratchpad__tab-${kind}`,
          label: glyph,
          ariaLabel,
          tabIndex: -1,
          title,
          dataset: { [`scratchpad-${kind}`]: note.id },
        });
        const edit = selected ? tabControl('edit', '✎', 'Rename note', 'Rename note') : '';
        const close = atFloor ? '' : tabControl('close', '×', `Delete ${label}`, 'Delete note');
        const wrapClass = 'dashboard-scratchpad__tab-wrap'
          + (note.id === newNoteId ? ' dashboard-scratchpad__tab-wrap--new' : '');
        return `<div class="${wrapClass}">` + tab + edit + close + '</div>';
      }).join('');
      const atCap = notes.length >= MAX_NOTES;
      const add = actionButton({
        plain: true,
        className: 'dashboard-scratchpad__tab-add',
        label: '+',
        ariaLabel: 'New note',
        disabled: atCap,
        title: atCap ? `Up to ${MAX_NOTES} notes — delete one to add another` : 'New note',
        dataset: { 'scratchpad-add': '1' },
      });
      // The grow-in is one-shot: consuming newNoteId here means a later repaint
      // (idle tick / note switch) rebuilds the same tab without re-animating.
      newNoteId = null;
      return '<div class="dashboard-scratchpad__tabs" role="tablist" aria-label="Scratchpad notes">'
        + tabs + add + '</div>';
    }

    function buildFooterHtml(opts) {
      const markdownOn = opts && opts.markdownOn === true;
      const inPreview = opts && opts.previewMode === true;
      const previewToggle = markdownOn
        ? actionButton({
          plain: true,
          className: 'dashboard-scratchpad__preview-toggle',
          label: inPreview ? 'Edit' : 'Preview',
          ariaPressed: inPreview,
          title: inPreview ? 'Back to editing' : 'Preview markdown & checklists',
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
          ariaLabel: 'Note actions',
          title: 'Note actions',
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
          ? 'New note — jot, list, or “- [ ] task” for a checklist'
          : 'Jot something down…',
        ariaLabel: 'Quick scratchpad',
        spellcheck: true,
        className: 'dashboard-scratchpad__field',
      });
    }

    function renderPreviewInner(text) {
      if (String(text || '').trim() === '') {
        return '<div class="dashboard-scratchpad__preview-empty">Nothing to preview yet.</div>';
      }
      if (markdownModule && typeof markdownModule.renderPreviewHtml === 'function') {
        return markdownModule.renderPreviewHtml(String(text || ''), {
          actionButton,
          escapeHtml: typeof textField.escapeHtml === 'function' ? textField.escapeHtml : null,
        });
      }
      const esc = typeof textField.escapeHtml === 'function' ? textField.escapeHtml(String(text || '')) : '';
      return '<div class="dashboard-scratchpad__preview-line">' + esc + '</div>';
    }

    function buildPreviewHtml(text) {
      return '<div class="dashboard-scratchpad__preview" data-scratchpad-preview'
        + ' role="group" aria-label="Note preview">'
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

    function switchTo(body, noteId) {
      if (!noteId || !actions?.setActiveNote) {
        return;
      }
      if (resolveActiveId(lastScratchpad) === noteId) {
        focusTextarea(body);
        return;
      }
      localActiveId = noteId;
      previewMode = false;                     // a switch always lands on edit
      focusAfterRender = true;
      renderMulti(body, lastScratchpad);      // optimistic instant switch
      // setActiveNote flushes the outgoing note's pending save first (the queued
      // save is pinned to the OLD note id), then persists the pointer.
      void Promise.resolve(actions.setActiveNote(noteId)).then((result) => {
        if (result && result.error) {
          setNote(body, result.error, true);
        }
      });
    }

    function addNote(body) {
      if (!actions?.addNote) {
        return;
      }
      void Promise.resolve(actions.addNote()).then((result) => {
        if (result && result.error) {
          setNote(body, result.error, true);
          return;
        }
        if (result && result.activeNoteId) {
          localActiveId = result.activeNoteId;
          newNoteId = result.activeNoteId;     // play the grow-in once
          previewMode = false;
          focusAfterRender = true;
          // The config echo already repainted with the OLD active id; re-render
          // now so the new note is selected before any input can fire and the
          // focus flag is consumed immediately (mirrors switchTo()).
          renderMulti(body, lastScratchpad);
        }
      });
    }

    function deleteNote(body, noteId) {
      if (!actions?.deleteNote) {
        return;
      }
      void Promise.resolve(actions.deleteNote(noteId)).then((result) => {
        if (result && result.error) {
          setNote(body, result.error, true);
          return;
        }
        if (result && result.activeNoteId) {
          localActiveId = result.activeNoteId;
          previewMode = false;
          focusAfterRender = true;
          // Re-render now (the echo already repainted with the pre-delete active
          // id) so the surviving note is selected and focus is consumed.
          renderMulti(body, lastScratchpad);
        }
      });
    }

    // Quick-delete entry point for the per-tab × and the Delete key. A note with
    // content routes through a one-item confirm (reuse the context menu) so a
    // stray click can't drop written text; an empty note deletes immediately.
    function requestDelete(body, noteId, anchorX, anchorY) {
      const notes = getNotes(lastScratchpad);
      const note = notes.find((n) => n.id === noteId);
      if (!note) {
        return;
      }
      const hasText = String(note.text || '').trim() !== '';
      if (!hasText || !contextMenu?.show) {
        deleteNote(body, noteId);
        return;
      }
      const label = tabLabel(note, notes.indexOf(note));
      contextMenu.show({
        items: [
          { label: `Delete “${label}”`, action: () => deleteNote(body, noteId) },
        ],
        anchorX,
        anchorY,
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
        ariaLabel: 'Rename note',
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
        void Promise.resolve(actions.renameNote(noteId, value)).then((result) => {
          if (result && result.error) {
            setNote(body, result.error, true);
          }
        });
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
    // re-render. Optimistic: the in-memory note text is updated and the preview
    // repainted immediately, then the debounced writer is flushed so the change
    // lands without waiting on the echo (which reconciles afterward).
    function toggleCheck(body, lineIndex) {
      if (!markdownModule || typeof markdownModule.toggleChecklistLine !== 'function') {
        return;
      }
      // Settle any in-flight/pending pad save FIRST (e.g. edits made right before
      // entering preview, flushed on the textarea's focusout) so the toggle lands
      // on the latest reconciled text, never a stale pre-echo snapshot — then
      // read, toggle, persist.
      Promise.resolve(actions?.flushSave?.()).then(() => {
        const note = getActiveNote(lastScratchpad);
        if (!note) {
          return;
        }
        const current = String(note.text || '');
        const nextText = markdownModule.toggleChecklistLine(current, lineIndex);
        if (nextText === current) {
          return;
        }
        note.text = nextText;
        renderMulti(body, lastScratchpad);
        if (actions?.queueSave) {
          actions.queueSave(nextText, note.id);
          actions.flushSave?.();
        }
      });
    }

    function openActionsMenu(body, anchorX, anchorY) {
      if (!contextMenu?.show || !buildScratchpadMenu) {
        return;
      }
      const ta = body.querySelector('#homeScratchpadInput');
      const text = ta ? ta.value : '';
      const selection = ta && typeof ta.selectionStart === 'number'
        ? String(ta.value).slice(ta.selectionStart, ta.selectionEnd)
        : '';
      const active = getActiveNote(lastScratchpad);
      const documentRef = body.ownerDocument;
      // Pin state for the active note (only surfaced when the overlay flag is on).
      const pins = Array.isArray(lastScratchpad?.pins) ? lastScratchpad.pins : [];
      const pinOpts = pinFeatureOn && active
        ? { noteId: active.id, isPinned: pins.includes(active.id), pinsAtCap: pins.length >= MAX_PINS }
        : {};
      const present = (items) => contextMenu.show({
        items,
        anchorX,
        anchorY,
        rootEl: body,
        onActionError: (error) => setNote(body, String(error?.message || error || 'Action failed.'), true),
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

    function openTabMenu(body, noteId, anchorX, anchorY) {
      if (!contextMenu?.show) {
        return;
      }
      const isLast = getNotes(lastScratchpad).length <= 1;
      contextMenu.show({
        items: [
          { label: 'Rename', action: () => beginRename(body, noteId) },
          { separator: true },
          {
            label: 'Delete note',
            disabled: isLast,
            shortcutHint: isLast ? 'last note' : '',
            action: isLast ? undefined : () => deleteNote(body, noteId),
          },
        ],
        anchorX,
        anchorY,
        rootEl: body,
      });
    }

    function menuAnchor(event, fallbackEl) {
      const x = event && event.clientX ? event.clientX : 0;
      const y = event && event.clientY ? event.clientY : 0;
      if (x || y) {
        return { x, y };
      }
      const rect = fallbackEl && typeof fallbackEl.getBoundingClientRect === 'function'
        ? fallbackEl.getBoundingClientRect()
        : null;
      return { x: rect ? rect.left : 0, y: rect ? rect.bottom : 0 };
    }

    function bindBody(body) {
      if (body.dataset.scratchpadBound === '1' && BODY_TEARDOWNS.get(body) === bodyTeardown) {
        return;
      }
      BODY_TEARDOWNS.get(body)?.();
      bodyTeardown?.();
      body.dataset.scratchpadBound = '1';

      function handleInput(event) {
        const target = event.target;
        if (target?.id !== 'homeScratchpadInput') {
          return;
        }
        // Auto-grow first: it is presentation only, so it must not depend on a
        // save pipeline being wired.
        autosizeField(target);
        if (!actions) {
          return;
        }
        setNote(body, '', false);
        setSaving(body);
        const noteId = body.querySelector('.dashboard-scratchpad__tab[aria-selected="true"]')
          ?.dataset.scratchpadTab || '';
        actions.queueSave(target.value, noteId);
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
            setNote(body, result?.error || 'Saved to Open Loops.', Boolean(result?.error));
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
          const anchor = menuAnchor(event, closeBtn);
          requestDelete(body, closeBtn.dataset.scratchpadClose, anchor.x, anchor.y);
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
          const anchor = menuAnchor(event, menuBtn);
          openActionsMenu(body, anchor.x, anchor.y);
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
          const anchor = menuAnchor(event, tab);
          openTabMenu(body, tab.dataset.scratchpadTab, anchor.x, anchor.y);
        }
      }

      function handleKeydown(event) {
        const target = event.target;
        if (target?.dataset?.scratchpadRename != null) {
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
          const anchor = menuAnchor(null, tab);
          openTabMenu(body, tab.dataset.scratchpadTab, anchor.x, anchor.y);
        } else if (event.key === 'Delete') {
          event.preventDefault();
          if (getNotes(lastScratchpad).length > 1) {
            const anchor = menuAnchor(null, tab);
            requestDelete(body, tab.dataset.scratchpadTab, anchor.x, anchor.y);
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
        if (target?.id === 'homeScratchpadInput') {
          actions.flushSave?.();
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
        delete body.dataset.scratchpadBound;
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
            label: 'Turn into open loop',
            dataset: { 'scratchpad-to-loop': '1' },
          })
          + '</div>'
          + '</div>';
        bindBody(body);
        return;
      }
      const textarea = body.querySelector('#homeScratchpadInput');
      const documentRef = body.ownerDocument;
      if (textarea && documentRef?.activeElement !== textarea && textarea.value !== text) {
        textarea.value = text;
        autosizeField(textarea);
      }
    }

    function renderMulti(body, scratchpad) {
      const notes = getNotes(scratchpad);
      if (notes.length === 0) {
        return;
      }
      const activeId = resolveActiveId(scratchpad);
      const activeNote = notes.find((note) => note.id === activeId) || notes[0];
      const text = String(activeNote?.text ?? '');
      const key = tabsKeyFor(notes, activeId);
      const markdownOn = markdownEnabled(scratchpad);
      const showPreview = markdownOn && previewMode;
      const wantView = showPreview ? 'preview' : 'edit';

      const existing = body.querySelector('#homeScratchpadInput');
      // Rebuild on a mode change, a view flip (edit⇄preview), or a missing
      // textarea in edit mode. The view dataset is what lets the preview toggle
      // swap the field for the preview pane (the textarea still exists at that
      // moment, so the sync path alone would never switch views).
      // needsRebuild is provably false during an open rename (the textarea still
      // exists, mode/view are unchanged), so the rebuild path can't run then; the
      // strip-only sync path below is the single guard that protects the live
      // rename input (its `renamingNoteId == null` condition skips the rebuild).
      const needsRebuild = body.dataset.scratchpadMode !== 'multi'
        || body.dataset.scratchpadView !== wantView
        || (!showPreview && !existing);
      if (needsRebuild) {
        body.dataset.scratchpadMode = 'multi';
        body.dataset.scratchpadView = wantView;
        body.innerHTML = '<div class="dashboard-scratchpad" data-scratchpad-v2>'
          + buildTabsHtml(notes, activeId)
          + '<div class="dashboard-scratchpad__panel" id="homeScratchpadPanel"'
          + ' role="tabpanel" aria-label="Note content">'
          + (showPreview ? buildPreviewHtml(text) : buildFieldHtml(text, markdownOn))
          + '</div>'
          + buildFooterHtml({ markdownOn, previewMode })
          + '</div>';
        body.dataset.scratchpadTabsKey = key;
        lastPreviewText = showPreview ? text : null;
        bindBody(body);
        applyFieldSettings(body, scratchpad, true); // fresh DOM ⇒ always apply
        syncMeta(body, activeNote, text);
        scrollActiveTabIntoView(body, activeId);
        if (focusAfterRender && !showPreview) {
          focusAfterRender = false;
          focusTextarea(body);
        }
        return;
      }

      const documentRef = body.ownerDocument;
      if (showPreview) {
        // Only rebuild the preview when the text actually changed (see lastPreviewText).
        if (lastPreviewText !== text) {
          const previewEl = body.querySelector('[data-scratchpad-preview]');
          if (previewEl) {
            previewEl.innerHTML = renderPreviewInner(text);
          }
          lastPreviewText = text;
        }
      } else if (documentRef?.activeElement !== existing && existing.value !== text) {
        // Note switch / echoed save: the new text needs a fresh measurement.
        existing.value = text;
        autosizeField(existing);
      }
      if (renamingNoteId == null && body.dataset.scratchpadTabsKey !== key) {
        const strip = body.querySelector('.dashboard-scratchpad__tabs');
        if (strip) {
          strip.outerHTML = buildTabsHtml(notes, activeId);
          scrollActiveTabIntoView(body, activeId);
        }
        body.dataset.scratchpadTabsKey = key;
      }
      applyFieldSettings(body, scratchpad);
      syncMeta(body, activeNote, text);
      if (focusAfterRender && !showPreview) {
        focusAfterRender = false;
        focusTextarea(body);
      }
    }

    return {
      id: 'scratchpad',
      title: 'Scratchpad',
      render(body, ctx) {
        if (!body || !textField || !actionButton) {
          return;
        }
        bindBody(body);
        const scratchpad = ctx?.state?.homeConfig?.scratchpad;
        lastScratchpad = scratchpad;
        pinFeatureOn = ctx?.state?.features?.featureFlags?.scratchpad_pin === true;
        const flagOn = ctx?.state?.features?.featureFlags?.scratchpad_v2 === true;
        if (flagOn && getNotes(scratchpad).length > 0) {
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
