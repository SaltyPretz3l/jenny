/* renderer/features/renderer-scratchpad-pin.js — UMD
 *
 * Pinnable "sticky note" tabs for the Home scratchpad. A small set of notes
 * (scratchpad.pins) renders as compact pills in a tab strip docked in the
 * titlebar (#pinnedNoteTabs), just right of the "Jenny" brand and flowing toward
 * the command-palette pill. Clicking a tab drops an editable mini-panel down
 * directly beneath it as a popover (#pinnedNoteLayer), mounted to <body> so the
 * dropdown is never clipped by the titlebar's overflow. Edits route through the
 * injected scratchpad-actions object (the same whole-object write path the Home
 * pad uses), so the pin editor and the Home pad stay last-write-wins consistent.
 *
 * The controller is pure UI driven by getState() (reads homeConfig.scratchpad +
 * the scratchpad_pin flag). render() is idempotent — it skips when nothing it
 * shows changed, and NEVER rebuilds while its editor is focused (so an incoming
 * config echo can't clobber mid-typing). It owns two DOM nodes (#pinnedNoteTabs
 * for the strip, #pinnedNoteLayer for the editor popover) and its delegated
 * listeners (click on both, input/focusout/keydown on the popover, plus a
 * document pointerdown for click-away collapse and a view resize for
 * repositioning) — all released on dispose().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererScratchpadPin = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const MAX_NOTE_CHARS = 4000; // mirrors MAX_HOME_SCRATCHPAD_CHARS
  const PREVIEW_CHARS = 80;
  const EDITOR_ID = 'scratchpadPinEditor';
  const POPOVER_GAP = 6; // px below the active tab

  function noop() {}

  // First non-empty line of the note, trimmed + ellipsized — the glanceable
  // preview (shown as the tab tooltip; the title carries the name).
  function previewOf(text) {
    const lines = String(text || '').split('\n');
    let line = '';
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].trim()) {
        line = lines[i].trim();
        break;
      }
    }
    if (!line) {
      return '';
    }
    return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : line;
  }

  function createScratchpadPinController(deps = {}) {
    const documentRef = deps.documentRef || (typeof document !== 'undefined' ? document : null);
    const layerEl = deps.layerEl
      || (documentRef ? documentRef.getElementById('pinnedNoteLayer') : null);
    const tabsEl = deps.tabsEl
      || (documentRef ? documentRef.getElementById('pinnedNoteTabs') : null);
    // The view that actually owns the layout (jsdom in tests, window in app) —
    // resize listeners must bind here, NOT to the module-load global.
    const viewRef = (documentRef && documentRef.defaultView) || windowRef;
    const actionButton = typeof deps.actionButton === 'function'
      ? deps.actionButton
      : (typeof windowRef.inventoryActionButton === 'function' ? windowRef.inventoryActionButton : null);
    const textField = typeof deps.textField === 'function'
      ? deps.textField
      : (typeof windowRef.inventoryTextField === 'function' ? windowRef.inventoryTextField : null);
    const getState = typeof deps.getState === 'function' ? deps.getState : () => null;
    const actions = deps.actions || null;
    const onOpenInHome = typeof deps.onOpenInHome === 'function' ? deps.onOpenInHome : noop;
    const showToastMessage = typeof deps.showToastMessage === 'function' ? deps.showToastMessage : noop;
    const appendClientLog = typeof deps.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const escapeHtml = (actionButton && actionButton.escapeHtml)
      || (textField && textField.escapeHtml)
      || ((value) => String(value == null ? '' : value));

    // Session-only view state: which pin is expanded (one at a time), a one-shot
    // "focus the editor after the next build" flag (set on a user expand so a
    // later config-echo rebuild never steals focus back), the last render
    // signature (skip identical repaints), and the disposed/bound guards.
    let expandedId = null;
    let focusEditorNext = false;
    let lastSig = null;
    let bound = false;
    let disposed = false;

    function resolvePinned(scratchpad) {
      const notes = Array.isArray(scratchpad && scratchpad.notes) ? scratchpad.notes : [];
      const byId = new Map();
      for (const note of notes) {
        if (note && typeof note === 'object') {
          byId.set(note.id, note);
        }
      }
      const pins = Array.isArray(scratchpad && scratchpad.pins) ? scratchpad.pins : [];
      const out = [];
      for (const id of pins) {
        const note = byId.get(id);
        if (note) {
          out.push(note);
        }
      }
      return out;
    }

    function flagOn(state) {
      const flags = state && state.features && state.features.featureFlags;
      return Boolean(flags && flags.scratchpad_pin === true);
    }

    function editorEl() {
      return layerEl ? layerEl.querySelector(`#${EDITOR_ID}`) : null;
    }

    function editorIsFocused() {
      if (!layerEl || !documentRef) {
        return false;
      }
      const active = documentRef.activeElement;
      return Boolean(active && active.id === EDITOR_ID && layerEl.contains(active));
    }

    // Collapsed pin = a compact titlebar pill (title only; the body preview rides
    // along as the hover tooltip). The active pin's tab is marked aria-selected.
    function buildTab(note) {
      const title = String(note.title || '').trim() || 'Untitled note';
      const preview = previewOf(note.text);
      const isActive = note.id === expandedId;
      const inner = '<span class="pin-tab__icon" aria-hidden="true">📌</span>'
        + `<span class="pin-tab__title">${escapeHtml(title)}</span>`;
      return actionButton({
        plain: true,
        // Reuse the shared titlebar pill base (.palette-pill); .pin-tab carries
        // only the compact-tab deltas. Keeps the pins visually consistent with
        // the "Go anywhere" pill they sit beside.
        className: `palette-pill pin-tab${isActive ? ' pin-tab--active' : ''}`,
        trustedHtml: inner,
        role: 'tab',
        ariaSelected: isActive,
        ariaLabel: `Pinned note ${title}`,
        title: preview ? `${title} — ${preview}` : title,
        dataset: { 'pin-expand': note.id },
      });
    }

    function buildPanel(note) {
      const title = String(note.title || '').trim() || 'Untitled note';
      const headerBtn = (kind, glyph, label) => actionButton({
        plain: true,
        className: 'scratchpad-pin__hbtn',
        label: glyph,
        ariaLabel: label,
        title: label,
        dataset: { [`pin-${kind}`]: note.id },
      });
      const editor = textField({
        id: EDITOR_ID,
        multiline: true,
        value: String(note.text || ''),
        maxLength: MAX_NOTE_CHARS,
        ariaLabel: `Edit ${title}`,
        spellcheck: true,
        className: 'scratchpad-pin__editor',
      });
      return `<div class="scratchpad-pin scratchpad-pin--expanded" data-pin-id="${escapeHtml(note.id)}">`
        + '<div class="scratchpad-pin__header">'
        + `<span class="scratchpad-pin__title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>`
        + '<span class="scratchpad-pin__header-actions">'
        + headerBtn('open', '⤤', 'Open in Home')
        + headerBtn('unpin', '✕', 'Unpin note')
        + headerBtn('collapse', '▾', 'Collapse')
        + '</span>'
        + '</div>'
        + `<div class="scratchpad-pin__editor-wrap">${editor}</div>`
        + '<div class="scratchpad-pin__footer">'
        + '<span class="scratchpad-pin__saved" data-pin-saved aria-live="polite"></span>'
        + '</div>'
        + '</div>';
    }

    function focusEditor() {
      const ed = editorEl();
      if (!ed || typeof ed.focus !== 'function') {
        return;
      }
      try {
        ed.focus();
        const len = ed.value.length;
        if (typeof ed.setSelectionRange === 'function') {
          ed.setSelectionRange(len, len);
        }
      } catch (_error) {
        // focus is best-effort (jsdom / detached nodes).
      }
    }

    // Anchor the editor popover directly beneath the active tab, clamped so the
    // panel never spills past the viewport's right edge. No-ops cleanly in jsdom
    // (zeroed rects) — tests assert structure, not pixels.
    function activeTabEl() {
      if (!tabsEl || !expandedId) {
        return null;
      }
      const tabs = tabsEl.querySelectorAll('[data-pin-expand]');
      for (let i = 0; i < tabs.length; i += 1) {
        if (tabs[i].getAttribute('data-pin-expand') === expandedId) {
          return tabs[i];
        }
      }
      return null;
    }

    function positionPopover() {
      if (!layerEl || layerEl.hidden) {
        return;
      }
      const tab = activeTabEl();
      if (!tab || typeof tab.getBoundingClientRect !== 'function') {
        return;
      }
      const rect = tab.getBoundingClientRect();
      const margin = 8;
      const vw = viewRef.innerWidth
        || (documentRef && documentRef.documentElement ? documentRef.documentElement.clientWidth : 0)
        || 0;
      const panelW = layerEl.offsetWidth || 320;
      let left = rect.left;
      if (vw && left + panelW + margin > vw) {
        left = vw - panelW - margin;
      }
      left = Math.max(margin, left);
      layerEl.style.left = `${Math.round(left)}px`;
      layerEl.style.top = `${Math.round(rect.bottom + POPOVER_GAP)}px`;
    }

    function render() {
      if (disposed || !tabsEl || !layerEl || !actionButton || !textField) {
        return;
      }
      const state = getState();
      const on = flagOn(state);
      const scratchpad = state && state.homeConfig ? state.homeConfig.scratchpad : null;
      const pinned = on ? resolvePinned(scratchpad) : [];
      // Drop an expanded pin that was unpinned/deleted out from under us.
      if (expandedId && !pinned.some((note) => note.id === expandedId)) {
        expandedId = null;
      }
      const sig = JSON.stringify([on, expandedId, pinned.map((note) => [note.id, note.title, note.text])]);
      if (sig === lastSig) {
        return;
      }
      // Skip ONLY while the user is actively in an expanded editor — this protects
      // typing from an incoming echo clobber (it reconciles on blur: flushSave ->
      // onHomeConfig -> render with the editor no longer focused). A collapse /
      // unpin clears expandedId FIRST, so those user actions still rebuild even
      // though the torn-down editor briefly retains focus. lastSig stays stale so
      // the eventual reconciling render is never skipped.
      if (editorIsFocused() && expandedId) {
        return;
      }
      lastSig = sig;
      if (!on || pinned.length === 0) {
        tabsEl.innerHTML = '';
        tabsEl.hidden = true;
        layerEl.innerHTML = '';
        layerEl.hidden = true;
        return;
      }
      // Bind only once we actually have pins to show — so a flag-OFF / zero-pin
      // session never attaches the global document/view listeners.
      bind();
      // Tab strip — one pill per pin, in pin order (the strip is the index).
      tabsEl.innerHTML = pinned.map((note) => buildTab(note)).join('');
      tabsEl.hidden = false;
      // Editor popover — only the single expanded note, dropped below its tab.
      const active = expandedId ? pinned.find((note) => note.id === expandedId) : null;
      if (active) {
        layerEl.innerHTML = buildPanel(active);
        layerEl.hidden = false;
        positionPopover();
        if (focusEditorNext) {
          focusEditorNext = false;
          focusEditor();
        }
      } else {
        layerEl.innerHTML = '';
        layerEl.hidden = true;
      }
    }

    function expandPin(noteId) {
      if (!noteId) {
        return;
      }
      expandedId = noteId;
      focusEditorNext = true;
      lastSig = null; // force a rebuild even if the note set is unchanged
      render();
    }

    function collapseNow() {
      expandedId = null;
      focusEditorNext = false;
      lastSig = null;
      render();
    }

    // Flush the editor's pending save BEFORE collapsing so the last <600ms of
    // typing is never dropped when the panel folds away.
    function flushThenCollapse() {
      if (actions && typeof actions.flushSave === 'function') {
        Promise.resolve(actions.flushSave()).then(collapseNow, collapseNow);
      } else {
        collapseNow();
      }
    }

    function unpin(noteId) {
      if (!actions || typeof actions.unpinNote !== 'function') {
        return;
      }
      if (expandedId === noteId) {
        expandedId = null;
      }
      Promise.resolve(actions.unpinNote(noteId)).then(
        (result) => {
          if (result && result.error) {
            showToastMessage(String(result.error), { title: 'Scratchpad', tone: 'danger' });
          }
          // The config echo re-renders; force it in case the write was a no-op.
          lastSig = null;
          render();
        },
        (error) => {
          appendClientLog('WARN', 'scratchpad.unpin_failed', {
            message: String((error && error.message) || error),
          });
        }
      );
    }

    function onClick(event) {
      const target = event.target;
      if (!target || !target.closest) {
        return;
      }
      const expand = target.closest('[data-pin-expand]');
      if (expand) {
        const noteId = expand.getAttribute('data-pin-expand');
        // Clicking the already-open tab toggles its popover closed.
        if (noteId && noteId === expandedId) {
          flushThenCollapse();
        } else {
          expandPin(noteId);
        }
        return;
      }
      const open = target.closest('[data-pin-open]');
      if (open) {
        const noteId = open.getAttribute('data-pin-open');
        flushThenCollapse();
        onOpenInHome(noteId);
        return;
      }
      const unpinBtn = target.closest('[data-pin-unpin]');
      if (unpinBtn) {
        unpin(unpinBtn.getAttribute('data-pin-unpin'));
        return;
      }
      if (target.closest('[data-pin-collapse]')) {
        flushThenCollapse();
      }
    }

    function onInput(event) {
      const target = event.target;
      if (!target || target.id !== EDITOR_ID || !expandedId || !actions) {
        return;
      }
      const saved = layerEl.querySelector('[data-pin-saved]');
      if (saved) {
        saved.textContent = 'Saving…';
      }
      if (typeof actions.queueSave === 'function') {
        actions.queueSave(target.value, expandedId);
      }
    }

    function onFocusOut(event) {
      const target = event.target;
      // Persist the moment the editor loses focus so the last keystrokes survive a
      // click-away and a Home-pad / capture write can never race this debounce.
      if (target && target.id === EDITOR_ID && actions && typeof actions.flushSave === 'function') {
        actions.flushSave();
      }
    }

    function onKeydown(event) {
      if (event.key === 'Escape' && editorIsFocused()) {
        event.preventDefault();
        flushThenCollapse();
      }
    }

    // Click-away: a pointerdown anywhere outside the tab strip AND the popover
    // folds the open editor (flushing first). No-op when nothing is expanded.
    function onPointerDownDoc(event) {
      if (!expandedId) {
        return;
      }
      const target = event.target;
      const inContextMenu = target && typeof target.closest === 'function'
        && target.closest('.inv-context-menu');
      // The shared body-level menu is part of the active editor interaction.
      if (target && ((layerEl && layerEl.contains(target)) || (tabsEl && tabsEl.contains(target)) || inContextMenu)) {
        return;
      }
      flushThenCollapse();
    }

    function onViewResize() {
      if (expandedId) {
        positionPopover();
      }
    }

    function bind() {
      if (bound) {
        return;
      }
      bound = true;
      if (tabsEl) {
        tabsEl.addEventListener('click', onClick);
      }
      if (layerEl) {
        layerEl.addEventListener('click', onClick);
        layerEl.addEventListener('input', onInput);
        layerEl.addEventListener('focusout', onFocusOut);
        layerEl.addEventListener('keydown', onKeydown);
      }
      if (documentRef && typeof documentRef.addEventListener === 'function') {
        documentRef.addEventListener('pointerdown', onPointerDownDoc, true);
      }
      if (viewRef && typeof viewRef.addEventListener === 'function') {
        viewRef.addEventListener('resize', onViewResize);
      }
    }

    function dispose() {
      disposed = true;
      if (bound) {
        if (tabsEl) {
          tabsEl.removeEventListener('click', onClick);
        }
        if (layerEl) {
          layerEl.removeEventListener('click', onClick);
          layerEl.removeEventListener('input', onInput);
          layerEl.removeEventListener('focusout', onFocusOut);
          layerEl.removeEventListener('keydown', onKeydown);
        }
        if (documentRef && typeof documentRef.removeEventListener === 'function') {
          documentRef.removeEventListener('pointerdown', onPointerDownDoc, true);
        }
        if (viewRef && typeof viewRef.removeEventListener === 'function') {
          viewRef.removeEventListener('resize', onViewResize);
        }
      }
      if (tabsEl) {
        tabsEl.innerHTML = '';
        tabsEl.hidden = true;
      }
      if (layerEl) {
        layerEl.innerHTML = '';
        layerEl.hidden = true;
      }
      bound = false;
      expandedId = null;
    }

    return { render, dispose };
  }

  return { createScratchpadPinController };
});
