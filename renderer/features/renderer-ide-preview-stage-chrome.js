/* renderer/features/renderer-ide-preview-stage-chrome.js — the Preview stage's
 * bar (name, kind, note, Live cue, Reload) and state-card markup, plus the small
 * bar controller (Live cue + transient note timers) that draws it. Buttons come
 * from the inventory action-button primitive. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdePreviewStageChrome = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

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

  const RELOAD_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
    + '<path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.75"/><path d="M13.3 2.4v2.9h-2.9"/></svg>';

  function liveLabel(liveState) {
    return liveState === 'updating' ? jt('ide.previewStage.updating', 'Updating') : jt('ide.previewStage.live', 'Live');
  }

  function liveDotClass(liveState) {
    return `status-dot status-dot--${liveState === 'updating' ? 'active' : 'muted'}`;
  }

  function previewBarHtml(opts) {
    const o = opts || {};
    const esc = o.escapeHtml;
    const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');
    const title = o.path
      ? `<span class="ide-preview-stage-name" title="${esc(o.path)}">${esc(o.name)}</span>`
      : `<span class="ide-preview-stage-name ide-preview-stage-name--empty">${esc(jt('ide.previewStage.title', 'Preview'))}</span>`;
    const chip = o.kindLabel ? `<span class="ide-preview-stage-kind">${esc(o.kindLabel)}</span>` : '';
    const noteHtml = o.note
      ? `<span class="ide-preview-stage-note" data-preview-note${o.noteTitle ? ` title="${esc(o.noteTitle)}"` : ''}>${esc(o.note)}</span>`
      : '';
    let tools = '';
    if (o.showReload === true) {
      const live = o.liveVisible
        ? `<span class="ide-preview-stage-live" data-preview-live title="${esc(jt('ide.previewStage.liveHint', 'Updates by itself when the file changes'))}">`
          + `<span class="${liveDotClass(o.liveState)}"></span><span>${esc(liveLabel(o.liveState))}</span></span>`
        : '';
      const label = jt('ide.previewStage.reload', 'Reload preview');
      const button = actionButton({
        plain: true,
        className: 'ide-editor-action',
        ariaLabel: label,
        title: label,
        dataset: { 'preview-reload': 'true' },
        trustedHtml: RELOAD_ICON,
      });
      tools = `<div class="ide-editor-actions ide-preview-stage-tools">${live}${button}</div>`;
    }
    return title + chip + noteHtml + tools;
  }

  function previewStateHtml(opts) {
    const o = opts || {};
    const esc = o.escapeHtml;
    const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');
    const action = o.actionLabel
      ? `<div class="ide-preview-stage-state-actions">${actionButton({ label: o.actionLabel, size: 'sm', dataset: { 'preview-reload': 'true' } })}</div>`
      : '';
    return `<div class="ide-preview-stage-state" data-preview-state="${esc(o.stateKind)}">${esc(o.message)}${action}</div>`;
  }

  // Updates the cue in place so the Reload button keeps keyboard focus.
  function applyLiveState(barEl, liveState) {
    const live = barEl && barEl.querySelector ? barEl.querySelector('[data-preview-live]') : null;
    if (!live) {
      return;
    }
    const dot = live.querySelector('.status-dot');
    if (dot) {
      dot.className = liveDotClass(liveState);
    }
    const text = live.lastElementChild;
    if (text) {
      text.textContent = liveLabel(liveState);
    }
  }

  const LIVE_SETTLE_MS = 700;
  const NOTE_HOLD_MS = 4000;
  const AUTO_RETURN_WINDOW_MS = 5000;

  // Owns the bar's last inputs, the Live/Updating cue and the transient note.
  function createBarController(deps) {
    const { getBarEl, windowRef, ideStateUtils, escapeHtml, isWatchActive } = deps;
    let inputs = { path: '', kind: '', note: '', noteTitle: '', live: false };
    let liveState = 'live';
    let updatingSince = 0;
    let settleTimer = null;
    let transient = null;
    let noteTimer = null;
    let lastAutoReturn = { path: '', at: 0 };

    function clear(timer) {
      if (timer) windowRef.clearTimeout(timer);
      return null;
    }

    function draw() {
      const barEl = getBarEl();
      if (!barEl) {
        return;
      }
      const { path, kind } = inputs;
      const note = transient ?? inputs.note;
      const reload = barEl.querySelector('[data-preview-reload]');
      const hadFocus = !!reload && reload === barEl.ownerDocument.activeElement;
      barEl.innerHTML = previewBarHtml({
        path,
        name: path && typeof ideStateUtils.fileNameOf === 'function' ? ideStateUtils.fileNameOf(path) : path,
        kindLabel: kind ? (kind === 'html' ? jt('ide.previewStage.sandboxedHtml', 'Sandboxed HTML') : 'Markdown') : '',
        note,
        noteTitle: transient === null ? inputs.noteTitle : '',
        showReload: !!path,
        liveVisible: inputs.live && isWatchActive() === true,
        liveState,
        escapeHtml,
      });
      if (hadFocus) barEl.querySelector('[data-preview-reload]')?.focus();
    }

    // done = a terminal render (markdown or a state card): the cue settles now.
    // The cue survives a rebuild of the same path and kind; a state card clears it.
    function render(path, kind, note, done = false, noteTitle = '') {
      const sameTarget = path === inputs.path && kind === inputs.kind;
      if (path !== inputs.path) {
        transient = null;
        noteTimer = clear(noteTimer);
      }
      const live = kind !== '' && ((done && kind === 'markdown') || (sameTarget && inputs.live));
      const unchanged = sameTarget && note === inputs.note && noteTitle === inputs.noteTitle;
      inputs = { path, kind, note, noteTitle, live };
      if (unchanged) refresh();
      else draw();
      if (done) settle();
    }

    // Redraws only when the cue's visibility differs, so Reload keeps focus.
    function refresh() {
      const barEl = getBarEl();
      if (barEl && (inputs.live && isWatchActive() === true) !== !!barEl.querySelector('[data-preview-live]')) {
        draw();
      }
    }

    function markLive() {
      inputs.live = true;
      refresh();
      settle();
    }

    // True when this path may auto-return now; false when it just did (show the card).
    function claimAutoReturn(path) {
      const now = Date.now();
      if (lastAutoReturn.path === path && now - lastAutoReturn.at < AUTO_RETURN_WINDOW_MS) {
        return false;
      }
      lastAutoReturn = { path, at: now };
      return true;
    }

    function beginUpdating() {
      settleTimer = clear(settleTimer);
      liveState = 'updating';
      updatingSince = Date.now();
      applyLiveState(getBarEl(), liveState);
    }

    // Back to Live once the update has shown for at least LIVE_SETTLE_MS.
    function settle() {
      if (liveState !== 'updating') {
        return;
      }
      settleTimer = clear(settleTimer);
      settleTimer = windowRef.setTimeout(() => {
        settleTimer = null;
        liveState = 'live';
        applyLiveState(getBarEl(), liveState);
      }, Math.max(0, LIVE_SETTLE_MS - (Date.now() - updatingSince)));
    }

    function showNote(text) {
      transient = text;
      noteTimer = clear(noteTimer);
      noteTimer = windowRef.setTimeout(() => {
        noteTimer = null;
        transient = null;
        draw();
      }, NOTE_HOLD_MS);
      draw();
    }

    function dispose() {
      settleTimer = clear(settleTimer);
      noteTimer = clear(noteTimer);
    }

    return { beginUpdating, claimAutoReturn, dispose, markLive, refresh, render, settle, showNote };
  }

  return { applyLiveState, createBarController, previewBarHtml, previewStateHtml };
});
