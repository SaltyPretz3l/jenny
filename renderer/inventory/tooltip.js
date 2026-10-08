/**
 * renderer/inventory/tooltip.js
 *
 * Lightweight delegated tooltip system. Automatically converts native `title`
 * attributes to styled tooltips on first hover. Supports `data-tooltip` for
 * explicit control.
 *
 * API:
 *   initTooltipHandlers(rootEl)  — one-time delegated setup
 *   show(anchorEl, text)         — imperative show
 *   hide(opts)                   — imperative hide ({force} overrides a pin)
 *   pin(anchorEl) / unpin()      — click-to-pin: keeps the tooltip open across
 *                                  mouseleave/focusout until unpinned
 *   isPinned() / getPinnedAnchor()
 *
 * Elements with the `inv-tooltip-pin` class opt into delegated click-to-pin:
 * click toggles the pin; clicking elsewhere or pressing Escape unpins.
 *
 * An anchor inside `[data-tooltip-suppressed]` (an open popover whose own
 * rows already show what a tooltip would, e.g. the collapsed composer's
 * settings list) gets no delegated tooltip; a delayed show re-checks it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryTooltip = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SHOW_DELAY_MS = 400;
  var TOOLTIP_GAP = 6;
  var TOOLTIP_ID = 'inv-tooltip-singleton';

  var _tooltipEl = null;
  var _showTimer = 0;
  var _currentAnchor = null;
  var _pinnedAnchor = null;

  function _ensureTooltipEl(doc) {
    if (_tooltipEl && _tooltipEl.ownerDocument === doc) return _tooltipEl;
    _tooltipEl = doc.createElement('div');
    _tooltipEl.className = 'inv-tooltip';
    _tooltipEl.id = TOOLTIP_ID;
    _tooltipEl.setAttribute('role', 'tooltip');
    _tooltipEl.setAttribute('aria-hidden', 'true');
    doc.body.appendChild(_tooltipEl);
    return _tooltipEl;
  }

  function _position(anchorEl, el) {
    var rect = anchorEl.getBoundingClientRect();
    var win = anchorEl.ownerDocument.defaultView || globalThis;
    var vw = win.innerWidth;
    var vh = win.innerHeight;

    el.classList.remove('inv-tooltip--below');

    /* Measure off-screen so we get natural size. */
    el.style.left = '0';
    el.style.top = '0';
    var tipRect = el.getBoundingClientRect();
    var tw = tipRect.width;
    var th = tipRect.height;

    /* Default: above the anchor. An anchor with data-tooltip-placement="below"
     * gets below while it fits in the viewport. */
    var top = rect.top - th - TOOLTIP_GAP;
    var placeBelow = false;
    var wantsBelow = anchorEl.getAttribute('data-tooltip-placement') === 'below'
      && rect.bottom + TOOLTIP_GAP + th <= vh - 4;
    if (wantsBelow || top < 4) {
      top = rect.bottom + TOOLTIP_GAP;
      placeBelow = true;
    }
    if (top + th > vh - 4) {
      top = Math.max(4, vh - th - 4);
    }

    var left = rect.left + (rect.width - tw) / 2;
    if (left < 4) left = 4;
    if (left + tw > vw - 4) left = Math.max(4, vw - tw - 4);

    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
    if (placeBelow) el.classList.add('inv-tooltip--below');
  }

  function _updateDescribedBy(anchorEl, tooltipId, add) {
    var describedBy = String(anchorEl.getAttribute('aria-describedby') || '').trim();
    var ids = describedBy ? describedBy.split(/\s+/) : [];
    ids = ids.filter(function (id) { return id !== tooltipId; });
    if (add) ids.push(tooltipId);
    if (ids.length) anchorEl.setAttribute('aria-describedby', ids.join(' '));
    else anchorEl.removeAttribute('aria-describedby');
  }

  function show(anchorEl, text) {
    if (!anchorEl || !text) return;
    /* A detached anchor (a re-render removed it while a delayed show was
     * pending) measures as a zero rect and would park the tooltip at the
     * window's top-left corner. */
    if (anchorEl.isConnected === false) { hide(); return; }
    if (_currentAnchor && _currentAnchor !== anchorEl) {
      _updateDescribedBy(_currentAnchor, TOOLTIP_ID, false);
    }
    var doc = anchorEl.ownerDocument || document;
    var el = _ensureTooltipEl(doc);

    el.textContent = text;
    _position(anchorEl, el);

    /* Accessibility link. */
    _updateDescribedBy(anchorEl, TOOLTIP_ID, true);
    el.setAttribute('aria-hidden', 'false');

    /* Trigger enter animation on next frame. */
    el.classList.remove('inv-tooltip--visible');
    void el.offsetWidth;
    el.classList.add('inv-tooltip--visible');

    _currentAnchor = anchorEl;
  }

  function hide(opts) {
    if (_pinnedAnchor && !(opts && opts.force)) return;
    if (_showTimer) { clearTimeout(_showTimer); _showTimer = 0; }
    if (_tooltipEl) {
      _tooltipEl.classList.remove('inv-tooltip--visible');
      _tooltipEl.setAttribute('aria-hidden', 'true');
    }
    if (_currentAnchor) {
      _updateDescribedBy(_currentAnchor, TOOLTIP_ID, false);
      _currentAnchor = null;
    }
  }

  function isPinned() {
    return Boolean(_pinnedAnchor);
  }

  function getPinnedAnchor() {
    return _pinnedAnchor;
  }

  function _syncPressedState(anchorEl, pressed) {
    if (!anchorEl || !anchorEl.hasAttribute || !anchorEl.hasAttribute('aria-pressed')) return;
    anchorEl.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  }

  /**
   * Pin the tooltip to an anchor: show it immediately and keep it open
   * across mouseleave/focusout until unpin() (or Escape / click-away via
   * the delegated handlers).
   */
  function pin(anchorEl) {
    if (!anchorEl) return;
    _migrateTitle(anchorEl);
    var text = anchorEl.getAttribute('data-tooltip');
    if (!text) return;
    if (_showTimer) { clearTimeout(_showTimer); _showTimer = 0; }
    unpin({ hide: true });
    show(anchorEl, text);
    _pinnedAnchor = anchorEl;
    _syncPressedState(anchorEl, true);
    if (anchorEl.classList) anchorEl.classList.add('inv-tooltip-pinned');
  }

  function unpin(opts) {
    if (!_pinnedAnchor) return;
    var anchor = _pinnedAnchor;
    _pinnedAnchor = null;
    _syncPressedState(anchor, false);
    if (anchor.classList) anchor.classList.remove('inv-tooltip-pinned');
    if (!opts || opts.hide !== false) hide();
  }

  function _findTooltipTarget(el) {
    var eventTarget = el;
    /* Walk up to 3 levels to find the annotated element. */
    for (var i = 0; i < 4 && el; i++) {
      if (el.nodeType === 1 && (el.hasAttribute('data-tooltip') || el.hasAttribute('title'))) return el;
      el = el.parentElement;
    }
    if (_currentAnchor && (eventTarget === _currentAnchor
      || (_currentAnchor.contains && _currentAnchor.contains(eventTarget)))) return _currentAnchor;
    if (_pinnedAnchor && (eventTarget === _pinnedAnchor
      || (_pinnedAnchor.contains && _pinnedAnchor.contains(eventTarget)))) return _pinnedAnchor;
    return null;
  }

  /* An anchor removed from the DOM never gets mouseleave/focusout, so its
   * visible tooltip is dropped on the next delegated event. A pinned anchor
   * keeps its pin (Escape and click-away still unpin it). */
  function _dropDetachedAnchor() {
    if (_currentAnchor && _currentAnchor !== _pinnedAnchor && _currentAnchor.isConnected === false) hide();
  }

  function _suppressed(el) {
    return Boolean(el && typeof el.closest === 'function' && el.closest('[data-tooltip-suppressed]'));
  }

  function _isPointerFocus(el) {
    try { return el.ownerDocument.activeElement === el && !el.matches(':focus-visible'); } catch (_e) { return false; }
  }

  function _scheduleShow(target, text) {
    hide();
    _showTimer = setTimeout(function () {
      _showTimer = 0;
      if (!_suppressed(target)) show(target, text);
    }, SHOW_DELAY_MS);
  }

  function _migrateTitle(el) {
    if (el.hasAttribute('title')) {
      var val = el.getAttribute('title');
      if (val) {
        el.setAttribute('data-tooltip', val);
      } else {
        el.removeAttribute('data-tooltip');
      }
      el.removeAttribute('title');
    }
  }

  function initTooltipHandlers(rootEl) {
    if (!rootEl || rootEl.__invTooltipHandlersInstalled) return;
    rootEl.__invTooltipHandlersInstalled = true;

    rootEl.addEventListener('mouseenter', function (e) {
      _dropDetachedAnchor();
      var target = _findTooltipTarget(e.target);
      if (!target) return;
      _migrateTitle(target);
      var text = target.getAttribute('data-tooltip');
      if (!text) {
        if (_showTimer) { clearTimeout(_showTimer); _showTimer = 0; }
        if (_pinnedAnchor === target) unpin();
        else hide();
        return;
      }
      if (_pinnedAnchor) return;
      if (_suppressed(target)) { hide(); return; }
      _scheduleShow(target, text);
    }, true);

    rootEl.addEventListener('mouseleave', function (e) {
      var target = _findTooltipTarget(e.target);
      if (!target) return;
      hide();
    }, true);

    rootEl.addEventListener('mousemove', function () {
      if (_currentAnchor) _dropDetachedAnchor();
    }, true);

    rootEl.addEventListener('focusin', function (e) {
      _dropDetachedAnchor();
      var target = _findTooltipTarget(e.target);
      if (!target) return;
      /* Pointer-driven focus (a dropped view's tab, a click) is not keyboard focus:
       * the hover path owns those tooltips, so one does not linger after the drop. */
      if (_isPointerFocus(e.target)) return;
      _migrateTitle(target);
      var text = target.getAttribute('data-tooltip');
      if (!text) {
        if (_showTimer) { clearTimeout(_showTimer); _showTimer = 0; }
        if (_pinnedAnchor === target) unpin();
        else hide();
        return;
      }
      if (_pinnedAnchor) return;
      if (_suppressed(target)) { hide(); return; }
      _scheduleShow(target, text);
    }, true);

    rootEl.addEventListener('focusout', function (e) {
      var target = _findTooltipTarget(e.target);
      if (!target) return;
      hide();
    }, true);

    rootEl.addEventListener('click', function (e) {
      var target = _findTooltipTarget(e.target);
      var pinTarget = target && target.classList && target.classList.contains('inv-tooltip-pin')
        ? target
        : null;
      if (pinTarget) {
        if (_pinnedAnchor === pinTarget) unpin();
        else pin(pinTarget);
        return;
      }
      if (_pinnedAnchor) unpin();
    }, true);

    rootEl.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (_pinnedAnchor) unpin();
      else if (_currentAnchor) hide();
    }, true);
  }

  return {
    initTooltipHandlers: initTooltipHandlers,
    show: show,
    hide: hide,
    pin: pin,
    unpin: unpin,
    isPinned: isPinned,
    getPinnedAnchor: getPinnedAnchor,
  };
});
