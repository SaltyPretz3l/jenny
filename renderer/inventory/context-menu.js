/**
 * renderer/inventory/context-menu.js
 *
 * Reusable context menu primitive. Handles positioning, keyboard navigation,
 * and click-outside dismissal.
 *
 * API:
 *   show(opts)  — display a context menu
 *   hide()      — dismiss the active menu
 *
 * Composer menus (row 63, 2026-10-19) add: `heading` (a muted line naming
 * what picking does), `footer` (a muted note under the rows), `className`,
 * an item's trusted `iconHtml` (a leading glyph column), and
 * `placement: 'above'`, which opens the menu upward from the anchor's
 * leading edge (a composer control sits at the bottom of the window), and
 * `focusChecked`, which opens a radio menu on its current choice.
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
  var _descriptionSeq = 0;

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
    menu.className = 'inv-context-menu' + (opts.className ? ' ' + String(opts.className) : '');
    menu.setAttribute('role', 'menu');
    if (opts.ariaLabel) menu.setAttribute('aria-label', String(opts.ariaLabel));
    if (opts.heading) {
      var heading = doc.createElement('div');
      heading.className = 'inv-context-menu-heading';
      heading.setAttribute('role', 'presentation');
      heading.textContent = String(opts.heading);
      menu.appendChild(heading);
      if (!opts.ariaLabel) menu.setAttribute('aria-label', String(opts.heading));
    }

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
      var checked = typeof item.checked === 'boolean' ? item.checked : null;
      btn.className = 'inv-context-menu-item' + (item.danger ? ' inv-context-menu-item--danger' : '')
        + (checked === true ? ' inv-context-menu-item--checked' : '');
      // A boolean `checked` makes the item a radio row (one of a closed set); `toggle: true` an on/off checkbox row.
      btn.setAttribute('role', checked === null ? 'menuitem' : item.toggle === true ? 'menuitemcheckbox' : 'menuitemradio');
      if (checked !== null) btn.setAttribute('aria-checked', checked ? 'true' : 'false');
      btn.disabled = !!item.disabled;
      if (item.value !== undefined) btn.setAttribute('data-value', String(item.value));
      if (item.iconHtml) {
        var iconSpan = doc.createElement('span');
        iconSpan.className = 'inv-context-menu-icon';
        iconSpan.setAttribute('aria-hidden', 'true');
        iconSpan.innerHTML = String(item.iconHtml); // trusted caller markup (a static glyph)
        btn.appendChild(iconSpan);
        btn.classList.add('inv-context-menu-item--icon');
      }

      var labelSpan = doc.createElement('span');
      labelSpan.textContent = item.label || '';
      if (item.description) {
        var textWrap = doc.createElement('span');
        textWrap.className = 'inv-context-menu-text';
        var descriptionSpan = doc.createElement('span');
        descriptionSpan.className = 'inv-context-menu-description';
        descriptionSpan.textContent = item.description;
        // Described, not named: the label alone is the accessible name.
        descriptionSpan.id = 'inv-context-menu-description-' + (++_descriptionSeq);
        descriptionSpan.setAttribute('aria-hidden', 'true');
        btn.setAttribute('aria-describedby', descriptionSpan.id);
        textWrap.appendChild(labelSpan);
        textWrap.appendChild(descriptionSpan);
        btn.appendChild(textWrap);
      } else {
        btn.appendChild(labelSpan);
      }

      // A single-character accessKey picks the item while the menu is open;
      // it doubles as the shortcut hint unless the caller gives one.
      var accessKey = typeof item.accessKey === 'string' && item.accessKey.length === 1 ? item.accessKey : '';
      if (accessKey) {
        btn.setAttribute('data-access-key', accessKey);
        btn.setAttribute('aria-keyshortcuts', accessKey);
      }
      var shortcutHint = item.shortcutHint || accessKey;
      if (shortcutHint) {
        var hintSpan = doc.createElement('span');
        hintSpan.className = 'inv-context-menu-shortcut';
        hintSpan.textContent = shortcutHint;
        if (!item.shortcutHint) hintSpan.setAttribute('aria-hidden', 'true');
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
    if (opts.footer) {
      var footer = doc.createElement('div');
      footer.className = 'inv-context-menu-footer';
      footer.setAttribute('role', 'presentation');
      footer.textContent = String(opts.footer);
      menu.appendChild(footer);
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
    var above = opts.placement === 'above' && anchorRect;
    var anchorX = anchorRect ? (above ? anchorRect.left : anchorRect.right) : opts.anchorX || 0;
    var anchorY = anchorRect ? anchorRect.bottom : opts.anchorY || 0;
    var left = Math.max(0, Math.min(anchorX, win.innerWidth - menuRect.width - 4));
    var top = Math.max(0, Math.min(anchorY, win.innerHeight - menuRect.height - 4));
    // Upward from the anchor; downward only when there is no room above.
    if (above) top = anchorRect.top - menuRect.height - 6 >= 4 ? anchorRect.top - menuRect.height - 6 : top;
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';

    /* Focus the first enabled item, or with `focusChecked` the checked one. */
    var enabled = _getEnabledItems();
    var current = opts.focusChecked ? enabled.filter(function (el) { return el.getAttribute('aria-checked') === 'true'; })[0] : null;
    if (current || enabled.length) (current || enabled[0]).focus();

    /* Keyboard navigation. */
    function handleKeydown(e) {
      if (e.key === 'Escape') { e.preventDefault(); hide(); return; }
      // Keys typed outside the menu (focus moved to a composer or field)
      // belong to that field; a Tab leaving the menu dismisses it (APG menu button).
      // Body-targeted keys still drive the menu: a click on its padding or a
      // separator drops focus to body, and nothing else owns them.
      if (!_menuEl || (!_menuEl.contains(e.target) && e.target !== doc.body)) return;
      if (e.key === 'Tab') { hide(); return; }
      if (typeof e.key === 'string' && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        var keyed = _getEnabledItems().filter(function (item) { return item.getAttribute('data-access-key') === e.key; })[0];
        if (keyed) { e.preventDefault(); keyed.click(); return; }
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var items = _getEnabledItems();
        if (!items.length) return;
        var focused = doc.activeElement;
        var idx = items.indexOf(focused);
        var next = e.key === 'ArrowDown'
          ? (idx + 1) % items.length
          : (idx <= 0 ? items.length : idx) - 1;
        items[next].focus();
      }
    }

    /* Click-outside dismissal. The anchor is left to its own click handler,
       so a trigger can close its open menu instead of dismiss-then-reopen. */
    var anchorEl = opts.anchorEl && typeof opts.anchorEl.contains === 'function' ? opts.anchorEl : null;
    function handleOutside(e) {
      if (_menuEl && !_menuEl.contains(e.target) && !(anchorEl && anchorEl.contains(e.target))) hide();
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
