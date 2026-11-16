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
 * A list in sections (row 151): an item `{ heading }` is a muted line between
 * rows, and `placement: 'below'` opens under the anchor from its leading edge
 * (a wide button that names what the menu changes).
 *
 * Nested menus (row 123 slice 2a-6c): an item with `items` (child items) opens
 * a submenu beside it after a short hover, on a click and on Right arrow;
 * Left arrow and Esc close it and return the focus to the parent row, which
 * carries `aria-haspopup="menu"` and `aria-expanded`. The submenu flips to the
 * other side when the window has no room for it. One level deep.
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
  var _sub = null; // the open submenu: { el, parent }
  var _subTimer = 0;
  var SUBMENU_DELAY_MS = 200;

  function _cleanup() {
    for (var i = 0; i < _cleanups.length; i++) _cleanups[i]();
    _cleanups = [];
  }

  function hide(options) {
    var restoreTarget = _restoreFocusEl;
    _closeSub(false);
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

  function _enabledIn(container) {
    if (!container) return [];
    return Array.prototype.slice.call(container.querySelectorAll(':scope > .inv-context-menu-item:not(:disabled)'));
  }

  function _getEnabledItems() {
    return _enabledIn(_menuEl);
  }

  // The menu or its open submenu holds the node.
  function _contains(node) {
    return Boolean((_menuEl && _menuEl.contains(node)) || (_sub && _sub.el.contains(node)));
  }

  function _clearSubTimer() {
    if (_subTimer) clearTimeout(_subTimer);
    _subTimer = 0;
  }

  function _closeSub(restoreFocus) {
    _clearSubTimer();
    if (!_sub) return;
    var sub = _sub;
    _sub = null;
    if (sub.el.parentNode) sub.el.parentNode.removeChild(sub.el);
    sub.parent.setAttribute('aria-expanded', 'false');
    if (restoreFocus) { try { sub.parent.focus({ preventScroll: true }); } catch (_error) { sub.parent.focus(); } }
  }

  function _reportActionError(opts, error, item) {
    if (!opts || typeof opts.onActionError !== 'function') return;
    try { opts.onActionError(error, item); } catch (_) { /* best-effort */ }
  }

  // One row: a plain item, a radio or checkbox row, or (with `items`) the parent of a submenu.
  function _buildItem(doc, item, opts) {
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
    if (Array.isArray(item.items)) btn.setAttribute('data-menu-label', item.label || '');
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

    var children = Array.isArray(item.items) ? item.items.filter(Boolean) : [];
    if (children.length && !item.disabled) {
      btn.setAttribute('aria-haspopup', 'menu');
      btn.setAttribute('aria-expanded', 'false');
      var chevron = doc.createElement('span');
      chevron.className = 'inv-context-menu-shortcut inv-context-menu-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = '\u203a';
      btn.appendChild(chevron);
      btn.addEventListener('click', function () { _openSub(doc, btn, children, opts, true); });
      btn.addEventListener('mouseenter', function () {
        _clearSubTimer();
        if (_sub && _sub.parent === btn) return;
        _subTimer = setTimeout(function () { _subTimer = 0; if (_menuEl && _menuEl.contains(btn)) _openSub(doc, btn, children, opts, false); }, SUBMENU_DELAY_MS);
      });
    } else if (opts._inSubmenu !== true) {
      // Pointing at another row of the menu closes an open submenu after the same short delay.
      btn.addEventListener('mouseenter', function () {
        _clearSubTimer();
        if (_sub) _subTimer = setTimeout(function () { _subTimer = 0; _closeSub(false); }, SUBMENU_DELAY_MS);
      });
    }
    return btn;
  }

  // The submenu beside its parent row: after it, or before it when the window has no room after. It lives on
  // the body (a fixed child of the animated menu would be placed against the menu), and counts as the menu.
  function _openSub(doc, parent, children, opts, focusFirst) {
    _clearSubTimer();
    if (_sub && _sub.parent === parent) {
      if (focusFirst) { var open = _enabledIn(_sub.el); if (open.length) open[0].focus(); }
      return;
    }
    _closeSub(false);
    var win = doc.defaultView || globalThis;
    var el = doc.createElement('div');
    el.className = 'inv-context-menu inv-context-menu--sub' + (opts.className ? ' ' + String(opts.className) : '');
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', parent.getAttribute('data-menu-label') || '');
    var childOpts = Object.assign({}, opts, { _inSubmenu: true });
    for (var i = 0; i < children.length; i++) {
      if (children[i].separator) {
        var sep = doc.createElement('div');
        sep.className = 'inv-context-menu-separator';
        sep.setAttribute('role', 'separator');
        el.appendChild(sep);
      } else {
        el.appendChild(_buildItem(doc, Object.assign({}, children[i], { items: null }), childOpts));
      }
    }
    el.addEventListener('mouseenter', _clearSubTimer);
    doc.body.appendChild(el);
    _sub = { el: el, parent: parent };
    parent.setAttribute('aria-expanded', 'true');
    var rowRect = parent.getBoundingClientRect();
    var subRect = el.getBoundingClientRect();
    var after = rowRect.right - 2 + subRect.width <= win.innerWidth - 4;
    var left = after ? rowRect.right - 2 : rowRect.left - subRect.width + 2;
    left = Math.max(0, Math.min(left, win.innerWidth - subRect.width - 4));
    var top = Math.max(0, Math.min(rowRect.top - 4, win.innerHeight - subRect.height - 4));
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
    el.setAttribute('data-side', after ? 'after' : 'before');
    if (focusFirst) { var first = _enabledIn(el); if (first.length) first[0].focus(); }
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
      if (item.heading) {
        var section = doc.createElement('div');
        section.className = 'inv-context-menu-heading';
        section.setAttribute('role', 'presentation');
        section.textContent = String(item.heading);
        menu.appendChild(section);
        continue;
      }

      menu.appendChild(_buildItem(doc, item, opts));
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
    var leading = above || (opts.placement === 'below' && anchorRect);
    var anchorX = anchorRect ? (leading ? anchorRect.left : anchorRect.right) : opts.anchorX || 0;
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
      if (e.key === 'Escape') {
        e.preventDefault();
        // Esc in a submenu closes only the submenu, back to its parent row.
        if (_sub && _sub.el.contains(e.target)) _closeSub(true); else hide();
        return;
      }
      // Keys typed outside the menu (focus moved to a composer or field)
      // belong to that field; a Tab leaving the menu dismisses it (APG menu button).
      // Body-targeted keys still drive the menu: a click on its padding or a
      // separator drops focus to body, and nothing else owns them.
      if (!_menuEl || (!_contains(e.target) && e.target !== doc.body)) return;
      if (e.key === 'Tab') { hide(); return; }
      var inSub = Boolean(_sub && _sub.el.contains(e.target));
      if (inSub && e.key === 'ArrowLeft') { e.preventDefault(); _closeSub(true); return; }
      if (!inSub && e.key === 'ArrowRight' && e.target && e.target.getAttribute && e.target.getAttribute('aria-haspopup') === 'menu') {
        e.preventDefault();
        e.target.click();
        return;
      }
      var scope = inSub ? _sub.el : _menuEl;
      if (typeof e.key === 'string' && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        var keyed = _enabledIn(scope).filter(function (item) { return item.getAttribute('data-access-key') === e.key; })[0];
        if (keyed) { e.preventDefault(); keyed.click(); return; }
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var items = _enabledIn(scope);
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
      if (_menuEl && !_contains(e.target) && !(anchorEl && anchorEl.contains(e.target))) hide();
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
