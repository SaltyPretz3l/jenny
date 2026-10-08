/* renderer/features/renderer-ide-workbench-focus.js - workbench focus safety (UMD).
 * A structural rebuild, a collapse or a tab switch can hide or detach the element that
 * holds focus; without help the browser drops focus to <body> (an owner-tracked bug).
 * capture() snapshots where focus is before a render and restore() puts it back, or on
 * the nearest surviving control: the view's tab, else its strip button, else the editor. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeWorkbenchFocus = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  function attrSelector(name, value) {
    return '[' + name + '="' + String(value).replace(/["\\]/g, '\\$&') + '"]';
  }

  function isHiddenOrDetached(el) {
    return !el || !el.isConnected || !!el.closest('[hidden]');
  }

  function focusEl(el) {
    if (isHiddenOrDetached(el)) return false;
    try {
      el.focus({ preventScroll: true });
    } catch (_error) {
      el.focus();
    }
    return true;
  }

  function chromeKeyOf(el) {
    const tab = el.closest('[data-wb-tab]');
    if (tab) return { kind: 'tab', view: tab.getAttribute('data-wb-tab') };
    const strip = el.closest('[data-wb-strip]');
    if (strip) return { kind: 'strip', view: strip.getAttribute('data-wb-strip') };
    const action = el.closest('[data-wb-action]');
    const stackEl = action ? action.closest('[data-wb-stack]') : null;
    if (action && stackEl) {
      return { kind: 'action', stack: stackEl.getAttribute('data-wb-stack'), name: action.getAttribute('data-wb-action') };
    }
    const sash = el.closest('[data-wb-sash]');
    return sash ? { kind: 'sash', key: sash.getAttribute('data-wb-sash') } : null;
  }

  // deps = { getEditorElement(), focusEditor() -> boolean, activeViewOfStack(stackId) -> viewId|null }
  function createFocusKeeper(deps) {
    function capture(rootEl, doc) {
      const el = doc.activeElement;
      if (!el || el === doc.body || typeof el.closest !== 'function' || !rootEl.contains(el)) return null;
      const host = el.closest('[data-wb-view]');
      if (host) return { type: 'host', view: host.getAttribute('data-wb-view'), el: el };
      const main = typeof deps.getEditorElement === 'function' ? deps.getEditorElement() : null;
      if (main && main.contains(el)) return { type: 'editor', el: el };
      const key = chromeKeyOf(el);
      return key ? { type: 'chrome', key: key, el: el } : null;
    }

    // tab -> strip button -> editor; never <body>.
    function focusViewControl(rootEl, viewId) {
      if (viewId != null) {
        if (focusEl(rootEl.querySelector(attrSelector('data-wb-tab', viewId)))) return;
        if (focusEl(rootEl.querySelector(attrSelector('data-wb-strip', viewId)))) return;
      }
      if (typeof deps.focusEditor === 'function' && deps.focusEditor() === true) return;
      if (!rootEl.hasAttribute('tabindex')) rootEl.setAttribute('tabindex', '-1');
      rootEl.focus();
    }

    function focusHost(host) {
      if (isHiddenOrDetached(host)) return;
      focusEl(host.querySelector(FOCUSABLE) || host);
    }

    function restore(rootEl, doc, snap) {
      if (!snap) return;
      if (snap.type === 'editor' || !isHiddenOrDetached(snap.el)) {
        if (doc.activeElement !== snap.el) focusEl(snap.el);
        return;
      }
      if (snap.type === 'host') {
        focusViewControl(rootEl, snap.view);
        return;
      }
      const key = snap.key;
      if (key.kind === 'tab' || key.kind === 'strip') {
        focusViewControl(rootEl, key.view);
      } else if (key.kind === 'action') {
        const stackEl = rootEl.querySelector(attrSelector('data-wb-stack', key.stack));
        const again = stackEl ? stackEl.querySelector(attrSelector('data-wb-action', key.name)) : null;
        if (!focusEl(again)) focusViewControl(rootEl, stackEl ? deps.activeViewOfStack(key.stack) : null);
      } else if (!focusEl(rootEl.querySelector(attrSelector('data-wb-sash', key.key)))) {
        focusViewControl(rootEl, null);
      }
    }

    return { capture: capture, restore: restore, focusViewControl: focusViewControl, focusHost: focusHost };
  }

  return { attrSelector: attrSelector, createFocusKeeper: createFocusKeeper };
});
