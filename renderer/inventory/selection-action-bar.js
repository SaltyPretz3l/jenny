/**
 * renderer/inventory/selection-action-bar.js
 *
 * Floating action bar shown when chat-timeline selection mode is
 * active. Owns the only raw HTML primitives the multi-select feature needs:
 *   - one <output> for the selection-count badge (aria-live="polite")
 *   - five <button>s: copy-md, copy-plain, export (drop), delete, cancel
 *   - one <ul role="menu"> for the export-format submenu (markdown / plain / json)
 *
 * The chat-side wrapper (renderer-chat-bulk-actions-utils.js, mounted from
 * wireChatAccessibility in renderer-chat-keyboard-utils.js) subscribes to:
 *   'copy-md'          — Copy as Markdown button pressed
 *   'copy-plain'       — Copy as Plain Text button pressed
 *   'export:markdown'  — Export submenu pick: Markdown
 *   'export:plain'     — Export submenu pick: Plain text
 *   'export:json'      — Export submenu pick: Raw turn-event JSON
 *   'export:session-json' — Export submenu pick: Session JSON portable
 *   'delete-from-here' — Delete-from-first-selected button pressed
 *   'cancel'           — Cancel selection button pressed
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, require('../shared/string-utils'));
    return;
  }
  root.inventorySelectionActionBar = factory(root, root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, stringUtils) {
  'use strict';

  var escapeHtml = stringUtils && stringUtils.escapeHtml;
  var sanitizeToken = stringUtils && stringUtils.sanitizeToken;
  if (typeof escapeHtml !== 'function' || typeof sanitizeToken !== 'function') {
    throw new Error('inventorySelectionActionBar: renderer/shared/string-utils.js must load before this module');
  }

  function buildBarHtml(ids) {
    return ''
      + '<div class="selection-action-bar" role="toolbar" aria-label="Selection actions">'
      +   '<output'
      +     ' class="selection-action-bar-count"'
      +     ' id="' + escapeHtml(ids.count) + '"'
      +     ' aria-live="polite"'
      +     ' aria-atomic="true"'
      +   '>0 selected</output>'
      +   '<button'
      +     ' type="button"'
      +     ' class="selection-action-bar-button selection-action-bar-copy-md"'
      +     ' data-selection-action="copy-md"'
      +     ' aria-label="Copy selected messages as Markdown"'
      +     ' title="Copy as Markdown"'
      +   '>Copy as Markdown</button>'
      +   '<button'
      +     ' type="button"'
      +     ' class="selection-action-bar-button selection-action-bar-copy-plain"'
      +     ' data-selection-action="copy-plain"'
      +     ' aria-label="Copy selected messages as plain text"'
      +     ' title="Copy as plain text"'
      +   '>Copy as text</button>'
      +   '<div class="selection-action-bar-export-wrap">'
      +     '<button'
      +       ' type="button"'
      +       ' class="selection-action-bar-button selection-action-bar-export"'
      +       ' data-selection-action="export-toggle"'
      +       ' aria-haspopup="menu"'
      +       ' aria-expanded="false"'
      +       ' aria-controls="' + escapeHtml(ids.menu) + '"'
      +       ' aria-label="Export selected messages"'
      +       ' title="Export…"'
      +     '>Export ▾</button>'
      +     '<ul'
      +       ' class="selection-action-bar-export-menu"'
      +       ' id="' + escapeHtml(ids.menu) + '"'
      +       ' role="menu"'
      +       ' hidden'
      +     '>'
      +       '<li role="none">'
      +         '<button'
      +           ' type="button"'
      +           ' role="menuitem"'
      +           ' class="selection-action-bar-export-item"'
      +           ' data-selection-action="export:markdown"'
      +         '>Markdown (.md)</button>'
      +       '</li>'
      +       '<li role="none">'
      +         '<button'
      +           ' type="button"'
      +           ' role="menuitem"'
      +           ' class="selection-action-bar-export-item"'
      +           ' data-selection-action="export:plain"'
      +         '>Plain text (.txt)</button>'
      +       '</li>'
      +       '<li role="none">'
      +         '<button'
      +           ' type="button"'
      +           ' role="menuitem"'
      +           ' class="selection-action-bar-export-item"'
      +           ' data-selection-action="export:json"'
      +         '>Turn-event JSON (.json)</button>'
      +       '</li>'
      +       '<li role="none">'
      +         '<button'
      +           ' type="button"'
      +           ' role="menuitem"'
      +           ' class="selection-action-bar-export-item"'
      +           ' data-selection-action="export:session-json"'
      +         '>Session JSON portable (.json)</button>'
      +       '</li>'
      +     '</ul>'
      +   '</div>'
      +   '<button'
      +     ' type="button"'
      +     ' class="selection-action-bar-button selection-action-bar-delete"'
      +     ' data-selection-action="delete-from-here"'
      +     ' aria-label="Delete selected messages and everything after"'
      +     ' title="Delete from first selected onward"'
      +   '>Delete from here…</button>'
      +   '<button'
      +     ' type="button"'
      +     ' class="selection-action-bar-button selection-action-bar-cancel"'
      +     ' data-selection-action="cancel"'
      +     ' aria-label="Cancel selection"'
      +     ' title="Cancel (Esc)"'
      +   '>Cancel</button>'
      + '</div>';
  }

  function createSelectionActionBar(deps) {
    var options = deps || {};
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var hostId = sanitizeToken(options.hostId, 'inv-selection-action-bar');
    var countId = hostId + '-count';
    var menuId = hostId + '-menu';

    var listeners = Object.create(null);
    var rootEl = null;
    var countEl = null;
    var exportToggleEl = null;
    var exportMenuEl = null;
    var menuOpen = false;
    var busy = false;
    var disposed = false;

    function emit(event, value) {
      var subs = listeners[event];
      if (!subs || !subs.length) return;
      for (var i = 0; i < subs.length; i += 1) {
        try { subs[i](value); } catch (_e) { /* swallow listener failure */ }
      }
    }

    function on(event, callback) {
      if (typeof callback !== 'function') return function () {};
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(callback);
      return function off() {
        var subs = listeners[event];
        if (!subs) return;
        var idx = subs.indexOf(callback);
        if (idx >= 0) subs.splice(idx, 1);
      };
    }

    function setMenuOpen(open) {
      menuOpen = !!open;
      if (exportToggleEl) {
        exportToggleEl.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
      }
      if (exportMenuEl) {
        if (menuOpen) {
          exportMenuEl.removeAttribute('hidden');
        } else {
          exportMenuEl.setAttribute('hidden', '');
        }
      }
    }

    function handleClick(event) {
      if (busy) {
        event.preventDefault();
        return;
      }
      var target = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-selection-action]')
        : null;
      if (!target || !rootEl || !rootEl.contains(target)) return;
      var action = target.getAttribute('data-selection-action');
      if (!action) return;
      if (action === 'copy-md') { emit('copy-md'); return; }
      if (action === 'copy-plain') { emit('copy-plain'); return; }
      if (action === 'delete-from-here') { emit('delete-from-here'); return; }
      if (action === 'cancel') { emit('cancel'); return; }
      if (action === 'export-toggle') {
        setMenuOpen(!menuOpen);
        return;
      }
      if (action.indexOf('export:') === 0) {
        var format = action.slice('export:'.length);
        setMenuOpen(false);
        emit('export:' + format);
      }
    }

    function handleKeydown(event) {
      var key = String(event.key || '');
      if (key === 'Escape' && menuOpen) {
        event.preventDefault();
        setMenuOpen(false);
        if (exportToggleEl) exportToggleEl.focus();
      }
    }

    function ensureBuilt() {
      if (disposed || rootEl || !doc) return rootEl;
      var wrapper = doc.createElement('div');
      wrapper.innerHTML = buildBarHtml({ count: countId, menu: menuId });
      rootEl = wrapper.firstElementChild;
      countEl = rootEl.querySelector('.selection-action-bar-count');
      exportToggleEl = rootEl.querySelector('.selection-action-bar-export');
      exportMenuEl = rootEl.querySelector('.selection-action-bar-export-menu');
      rootEl.addEventListener('click', handleClick);
      rootEl.addEventListener('keydown', handleKeydown);
      return rootEl;
    }

    function mount(hostEl) {
      if (!hostEl || typeof hostEl.appendChild !== 'function') return;
      ensureBuilt();
      if (!rootEl) return;
      hostEl.appendChild(rootEl);
      if (hostEl.hasAttribute && hostEl.hasAttribute('hidden')) {
        hostEl.removeAttribute('hidden');
      }
    }

    function unmount() {
      setMenuOpen(false);
      var parent = rootEl && rootEl.parentNode;
      if (parent) parent.removeChild(rootEl);
      if (parent && parent.children && parent.children.length === 0 && parent.setAttribute) {
        parent.setAttribute('hidden', '');
      }
    }

    function setSelectionCount(n) {
      ensureBuilt();
      if (!countEl) return;
      var count = Math.max(0, Number(n) || 0);
      var text = count === 1 ? '1 selected' : count + ' selected';
      if (countEl.textContent !== text) countEl.textContent = text;
    }

    function setBusy(value) {
      busy = !!value;
      ensureBuilt();
      if (!rootEl) return;
      if (busy) {
        rootEl.setAttribute('aria-busy', 'true');
      } else {
        rootEl.removeAttribute('aria-busy');
      }
      // Disable each button while busy.
      var buttons = rootEl.querySelectorAll('button[data-selection-action]');
      if (buttons && buttons.forEach) {
        buttons.forEach(function (btn) {
          if (busy) {
            btn.setAttribute('disabled', '');
          } else {
            btn.removeAttribute('disabled');
          }
        });
      }
    }

    function dispose() {
      if (rootEl) {
        rootEl.removeEventListener('click', handleClick);
        rootEl.removeEventListener('keydown', handleKeydown);
        if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
      }
      rootEl = null;
      countEl = null;
      exportToggleEl = null;
      exportMenuEl = null;
      listeners = Object.create(null);
      disposed = true;
    }

    return {
      mount: mount,
      unmount: unmount,
      setSelectionCount: setSelectionCount,
      setBusy: setBusy,
      on: on,
      dispose: dispose,
    };
  }

  return { createSelectionActionBar: createSelectionActionBar };
});
