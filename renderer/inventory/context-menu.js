/**
 * renderer/inventory/context-menu.js
 *
 * Reusable context menu primitive. Handles positioning, keyboard navigation,
 * and click-outside dismissal.
 *
 * API:
 *   show(opts)  — display a context menu
 *   hide()      — dismiss the active menu
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryContextMenu = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var _menuEl = null;
  var _cleanups = [];
  var _restoreFocusEl = null;
  var _onHide = null;

  function _cleanup() {
    for (var i = 0; i < _cleanups.length; i++) _cleanups[i]();
    _cleanups = [];
  }

  function hide(options) {
    var restoreTarget = _restoreFocusEl;
    _cleanup();
    if (_menuEl && _menuEl.parentNode) {
      _menuEl.parentNode.removeChild(_menuEl);
    }
    _menuEl = null;
    _restoreFocusEl = null;
    var onHide = _onHide;
    _onHide = null;
    if ((!options || options.restoreFocus !== false) && restoreTarget && restoreTarget.isConnected !== false) {
      try { restoreTarget.focus({ preventScroll: true }); }
      catch (_error) { try { restoreTarget.focus(); } catch (_focusError) { /* noop */ } }
    }
    if (typeof onHide === 'function') {
      try { onHide(); } catch (_error) { /* best-effort */ }
    }
  }

  function _getEnabledItems() {
    if (!_menuEl) return [];
    return Array.prototype.slice.call(
      _menuEl.querySelectorAll('.inv-context-menu-item:not(:disabled)')
    );
  }

  function _reportActionError(opts, error, item) {
    if (!opts || typeof opts.onActionError !== 'function') return;
    try { opts.onActionError(error, item); } catch (_) { /* best-effort */ }
  }

  function show(opts) {
    hide({ restoreFocus: false });
    if (!opts || !opts.items || !opts.items.length) return;

    var doc = (opts.rootEl && opts.rootEl.ownerDocument) || document;
    var win = doc.defaultView || globalThis;
    var menu = doc.createElement('div');
    menu.className = 'inv-context-menu';
    menu.setAttribute('role', 'menu');

    for (var i = 0; i < opts.items.length; i++) {
      var item = opts.items[i];

      if (item.separator) {
        var sep = doc.createElement('div');
        sep.className = 'inv-context-menu-separator';
        sep.setAttribute('role', 'separator');
        menu.appendChild(sep);
        continue;
      }

      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'inv-context-menu-item' + (item.danger ? ' inv-context-menu-item--danger' : '');
      btn.setAttribute('role', 'menuitem');
      btn.disabled = !!item.disabled;

      var labelSpan = doc.createElement('span');
      labelSpan.textContent = item.label || '';
      btn.appendChild(labelSpan);

      if (item.shortcutHint) {
        var hintSpan = doc.createElement('span');
        hintSpan.className = 'inv-context-menu-shortcut';
        hintSpan.textContent = item.shortcutHint;
        btn.appendChild(hintSpan);
      }

      if (!item.disabled && typeof item.action === 'function') {
        (function (action, actionItem) {
          btn.addEventListener('click', function () {
            hide();
            try {
              var result = action();
              if (result && typeof result.then === 'function') {
                result.catch(function (error) {
                  _reportActionError(opts, error, actionItem);
                });
              }
            } catch (error) {
              _reportActionError(opts, error, actionItem);
            }
          });
        })(item.action, item);
      }

      menu.appendChild(btn);
    }

    doc.body.appendChild(menu);
    _menuEl = menu;
    _restoreFocusEl = opts.restoreFocusTo || doc.activeElement || null;
    _onHide = typeof opts.onHide === 'function' ? opts.onHide : null;

    /* Position with viewport clamping. */
    var menuRect = menu.getBoundingClientRect();
    var anchorRect = opts.anchorEl && typeof opts.anchorEl.getBoundingClientRect === 'function'
      ? opts.anchorEl.getBoundingClientRect()
      : null;
    var anchorX = anchorRect ? anchorRect.right : opts.anchorX || 0;
    var anchorY = anchorRect ? anchorRect.bottom : opts.anchorY || 0;
    var left = Math.max(0, Math.min(anchorX, win.innerWidth - menuRect.width - 4));
    var top = Math.max(0, Math.min(anchorY, win.innerHeight - menuRect.height - 4));
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';

    /* Focus first enabled item. */
    var enabled = _getEnabledItems();
    if (enabled.length) enabled[0].focus();

    /* Keyboard navigation. */
    function handleKeydown(e) {
      if (e.key === 'Escape') { e.preventDefault(); hide(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var items = _getEnabledItems();
        if (!items.length) return;
        var focused = doc.activeElement;
        var idx = items.indexOf(focused);
        var next = e.key === 'ArrowDown'
          ? (idx + 1) % items.length
          : (idx - 1 + items.length) % items.length;
        items[next].focus();
      }
    }

    /* Click-outside dismissal. */
    function handleOutside(e) {
      if (_menuEl && !_menuEl.contains(e.target)) hide();
    }

    doc.addEventListener('keydown', handleKeydown, true);
    doc.addEventListener('mousedown', handleOutside, true);
    win.addEventListener('blur', hide);
    win.addEventListener('resize', hide);

    _cleanups.push(
      function () { doc.removeEventListener('keydown', handleKeydown, true); },
      function () { doc.removeEventListener('mousedown', handleOutside, true); },
      function () { win.removeEventListener('blur', hide); },
      function () { win.removeEventListener('resize', hide); }
    );
  }

  return {
    show: show,
    hide: hide,
  };
});
