/* renderer/features/renderer-suggestion-bar-controller.js
 * Events for the suggested-change decision bar (row 35 Plan Plus W2; UI spec
 * §3.4). Both hosts (the editor's diff toolbar and the side panel detail page)
 * render through render(el, target) and forward their click, keydown and
 * input events here. A target is {sessionId, id, revision}: the bar acts on the
 * suggestion it was rendered for, never on whatever the dock shows now.
 *
 * Shortcuts never fire while the person is typing, except the note field's
 * own Enter / Shift+Enter / Esc.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-suggested-changes-model'),
      require('./renderer-suggestion-bar-render')
    );
    return;
  }
  root.rendererSuggestionBarController = factory(root.rendererSuggestedChangesModel, root.rendererSuggestionBarRender);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model, barRender) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const TYPING_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
  const HIDE_EXPLANATIONS_KEY = 'jenny.changes.hideExplanations';
  const MAX_UI_STATES = 64;

  function noop() {}

  function isTyping(target) {
    return Boolean(target && typeof target.closest === 'function' && target.closest(TYPING_SELECTOR));
  }

  function readHideExplanations(storage) {
    try { return storage && storage.getItem(HIDE_EXPLANATIONS_KEY) === '1'; } catch (_error) { return false; }
  }

  function writeHideExplanations(storage, hidden) {
    try { if (storage) storage.setItem(HIDE_EXPLANATIONS_KEY, hidden ? '1' : '0'); } catch (_error) { /* per-viewer convenience only */ }
  }

  // "Apply anyway" asks first, with the app's confirm dialog when it is loaded.
  function defaultConfirm() {
    let dialog = null;
    const confirm = (options) => {
      const factory = globalThis.rendererIdeConfirmDialog && globalThis.rendererIdeConfirmDialog.createIdeConfirmDialog;
      const overlay = globalThis.inventoryHelpOverlay && globalThis.inventoryHelpOverlay.createHelpOverlay;
      if (!dialog && typeof factory === 'function' && typeof overlay === 'function' && typeof document !== 'undefined') {
        dialog = factory({ document, actionButton: globalThis.inventoryActionButton, helpOverlayFactory: overlay, hostId: 'suggestionApplyAnywayOverlay' });
      }
      return dialog ? Promise.resolve(dialog.confirm(options)) : Promise.resolve(false);
    };
    confirm.dispose = () => { if (dialog && typeof dialog.dispose === 'function') dialog.dispose(); dialog = null; };
    return confirm;
  }

  /**
   * @param {object} deps
   * @param {object} deps.client rendererSuggestedChangesClient instance
   * @param {(sessionId: string, id: string) => void} [deps.onNavigate] show another suggestion
   * @param {Storage} [deps.storage] for the "hide explanations" preference
   * @param {(options: object) => Promise<boolean>} [deps.confirm] the "Apply anyway" question
   */
  function createSuggestionBarController(deps = {}) {
    const client = deps.client;
    const onNavigate = typeof deps.onNavigate === 'function' ? deps.onNavigate : noop;
    const storage = deps.storage || (typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null);
    const confirm = typeof deps.confirm === 'function' ? deps.confirm : defaultConfirm();
    const uiStates = new Map(); // `${sessionId}\u0000${id}` -> { note, error }
    let hideExplanation = readHideExplanations(storage);
    const rendered = new WeakMap(); // el -> target
    const pendingFocus = new WeakMap(); // el -> data-suggestion-action that held focus

    function keyOf(target) {
      return `${target.sessionId}\u0000${target.id}`;
    }

    function uiOf(target) {
      const key = keyOf(target);
      if (!uiStates.has(key)) {
        uiStates.set(key, { note: null, error: '' });
        while (uiStates.size > MAX_UI_STATES) uiStates.delete(uiStates.keys().next().value);
      }
      return uiStates.get(key);
    }

    // `target.revision` is the revision the host displays; Accept acts on it only.
    function barModel(target) {
      const list = client.get(target.sessionId);
      return model.buildBarModel(list, target.id, {
        generating: client.isGenerating(target.sessionId),
        replying: typeof client.isReplying === 'function' ? client.isReplying(target.sessionId) : client.isGenerating(target.sessionId),
        busy: client.isBusy(target.sessionId, target.id),
        revision: target.revision,
        unsaved: typeof client.isDirty === 'function' && client.isDirty(target.sessionId, target.id),
        previewMissing: target.previewMissing === true,
      });
    }

    // Re-rendering keeps an open note field's text, focus and caret.
    function render(el, target) {
      if (!el || !target || !target.sessionId || !target.id) return false;
      const bar = barModel(target);
      if (!bar) return false;
      // The panel's overflow menu may have changed the preference.
      hideExplanation = readHideExplanations(storage);
      const ui = uiOf(target);
      const html = barRender.buildBarHtml(bar, { ...ui, hideExplanation, sessionId: target.sessionId });
      rendered.set(el, { ...target });
      if (el.__suggestionBarMarkup === html) return true;
      const doc = el.ownerDocument;
      const field = doc && el.contains(doc.activeElement) && doc.activeElement.matches && doc.activeElement.matches('[data-suggestion-note]')
        ? doc.activeElement
        : null;
      const caret = field ? [field.selectionStart, field.selectionEnd] : null;
      const focusedAction = doc && el.contains(doc.activeElement) && doc.activeElement.getAttribute
        ? doc.activeElement.getAttribute('data-suggestion-action')
        : null;
      if (focusedAction) pendingFocus.set(el, focusedAction);
      el.innerHTML = html;
      el.__suggestionBarMarkup = html;
      if (field) {
        const next = el.querySelector('[data-suggestion-note]');
        if (next) {
          next.focus();
          try { next.setSelectionRange(caret[0], caret[1]); } catch (_error) { /* unsupported */ }
        }
      } else {
        restoreActionFocus(el, doc);
      }
      return true;
    }

    // Accept disables its own button while busy, then the bar moves to the next change: the
    // focused action survives those redraws instead of dropping to <body>, unless focus moved on.
    function restoreActionFocus(el, doc) {
      const wanted = pendingFocus.get(el);
      if (!wanted || !doc) return;
      const active = doc.activeElement;
      if (active && active !== doc.body && active.isConnected && !el.contains(active)) {
        pendingFocus.delete(el);
        return;
      }
      const button = el.querySelector(`[data-suggestion-action="${wanted}"]:not(:disabled)`)
        || el.querySelector('[data-suggestion-action]:not(:disabled)');
      if (button) {
        button.focus();
        pendingFocus.delete(el);
        return;
      }
      // A decided last change has no action left: the bar itself (its status line) holds focus.
      const surface = el.querySelector('.suggestion-bar');
      if (!surface || el.getAttribute('aria-busy') === 'true' || surface.getAttribute('aria-busy') === 'true') return;
      surface.setAttribute('tabindex', '-1');
      surface.focus();
    }

    function targetOf(el) {
      return el ? rendered.get(el) || null : null;
    }

    function refresh(el) {
      const target = targetOf(el);
      if (target) render(el, target);
    }

    function focusNote(el) {
      const field = el && el.querySelector('[data-suggestion-note]');
      if (field && typeof field.focus === 'function') field.focus();
    }

    function openNote(el, target, kind) {
      const ui = uiOf(target);
      ui.note = { kind, draft: ui.note && ui.note.kind === kind ? ui.note.draft : '' };
      ui.error = '';
      render(el, target);
      focusNote(el);
    }

    function closeNote(el, target) {
      const ui = uiOf(target);
      ui.note = null;
      render(el, target);
    }

    async function finish(el, target, task) {
      const ui = uiOf(target);
      ui.error = '';
      render(el, target);
      const result = await task();
      if (!result || !result.ok) {
        ui.error = result && result.message ? result.message : '';
        refresh(el);
        return false;
      }
      ui.note = null;
      ui.error = '';
      const next = client.getCurrent(target.sessionId);
      if (next && next !== target.id) onNavigate(target.sessionId, next);
      else refresh(el);
      return true;
    }

    function saveNote(el, target) {
      const ui = uiOf(target);
      if (!ui.note) return;
      const field = el.querySelector('[data-suggestion-note]');
      const text = field ? field.value : ui.note.draft;
      if (ui.note.kind === 'reject') {
        finish(el, target, () => client.decide(target.sessionId, target.id, 'reject', text));
      } else if (String(text || '').trim()) {
        finish(el, target, () => client.comment(target.sessionId, target.id, text));
      }
    }

    function accept(el, target) {
      const bar = barModel(target);
      if (!bar || !bar.canAccept) return;
      if (!bar.confirmApply) {
        finish(el, target, () => client.accept(target.sessionId, target.id, target.revision));
        return;
      }
      Promise.resolve(confirm({ ...bar.confirmApply, cancelLabel: jt('common.cancel', 'Cancel'), variant: 'danger' })).then((confirmed) => {
        if (confirmed === true) finish(el, target, () => client.accept(target.sessionId, target.id, target.revision, { force: true }));
      });
    }

    function act(el, target, action) {
      if (action === 'accept') accept(el, target);
      else if (action === 'comment') openNote(el, target, 'comment');
      else if (action === 'reject') openNote(el, target, 'reject');
      else if (action === 'restore') finish(el, target, () => client.decide(target.sessionId, target.id, 'restore'));
    }

    function handleClick(event, el) {
      const target = targetOf(el);
      const node = event && event.target;
      if (!target || !node || typeof node.closest !== 'function' || !el.contains(node)) return false;
      const actionEl = node.closest('[data-suggestion-action]');
      if (actionEl) {
        if (actionEl.disabled) return true;
        event.preventDefault();
        act(el, target, actionEl.getAttribute('data-suggestion-action'));
        return true;
      }
      if (node.closest('[data-suggestion-note-cancel]')) { event.preventDefault(); closeNote(el, target); return true; }
      if (node.closest('[data-suggestion-note-save]')) { event.preventDefault(); saveNote(el, target); return true; }
      return false;
    }

    function handleInput(event, el) {
      const target = targetOf(el);
      const node = event && event.target;
      if (!target || !node || !node.matches || !node.matches('[data-suggestion-note]')) return;
      const ui = uiOf(target);
      if (ui.note) ui.note.draft = node.value;
    }

    function step(target, delta) {
      const batch = model.currentBatch(client.get(target.sessionId));
      const next = model.stepFrom(batch, target.id, delta);
      if (next) {
        client.setCurrent(target.sessionId, next);
        onNavigate(target.sessionId, next);
      }
    }

    /**
     * Key handling. `el` is the bar's host element; `scopeEvent` is true when
     * the event came from the bar's surface (editor or detail page).
     */
    function handleKeydown(event, el) {
      const target = targetOf(el);
      if (!target || !event) return false;
      const node = event.target;
      if (node && node.matches && node.matches('[data-suggestion-note]')) {
        if (event.key === 'Escape') { event.preventDefault(); closeNote(el, target); return true; }
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          saveNote(el, target);
          return true;
        }
        return false;
      }
      if (isTyping(node)) return false;
      if (event.altKey && !event.ctrlKey && !event.metaKey) {
        if (event.key === 'Enter') { event.preventDefault(); accept(el, target); return true; }
        if (event.key === ']') { event.preventDefault(); step(target, 1); return true; }
        if (event.key === '[') { event.preventDefault(); step(target, -1); return true; }
        return false;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return false;
      if (event.key === 'n' || event.key === 'N') {
        const bar = barModel(target);
        if (bar && bar.canComment) { event.preventDefault(); openNote(el, target, 'comment'); return true; }
      }
      if (event.key === '?') {
        event.preventDefault();
        hideExplanation = !hideExplanation;
        writeHideExplanations(storage, hideExplanation);
        refresh(el);
        return true;
      }
      return false;
    }

    return {
      dispose: () => { if (typeof confirm.dispose === 'function') confirm.dispose(); },
      handleClick,
      handleInput,
      handleKeydown,
      isExplanationHidden: () => hideExplanation,
      refresh,
      render,
      targetOf,
    };
  }

  return { createSuggestionBarController, HIDE_EXPLANATIONS_KEY, readHideExplanations, writeHideExplanations };
});
