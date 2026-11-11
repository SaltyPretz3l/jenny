/**
 * renderer/inventory/compare-slider.js
 *
 * Before/after compare slider primitive (UMD). Two stacked pictures with a
 * draggable handle; the After picture is clipped from the handle to the far
 * edge, so --pos 100% shows only Before and --pos 0% shows only After. Two
 * text buttons under the picture snap the handle to either side. Every
 * visible and spoken string comes from the caller.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryCompareSlider = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  var CHANGE_EVENT = 'inventory-compare-slider-change';
  var DEFAULT_POSITION = 50;
  var KEY_STEP = 2;
  var KEY_STEP_SHIFT = 10;
  var KEY_STEP_PAGE = 10;
  // The snap buttons read as pressed when the handle is within one point of a side.
  var SNAP_EDGE = 1;
  // A picture source is a local file, a blob, an inline image or https; anything
  // else (javascript:, http:, relative paths) renders nothing.
  var ALLOWED_SRC = /^(?:file:|blob:|data:image\/|https:)/i;

  function sanitizeClassName(value) {
    return String(value || '')
      .trim()
      .split(/\s+/)
      .filter(function (token) {
        return /^[A-Za-z0-9_-]+$/.test(token);
      })
      .join(' ');
  }

  function clamp(value) {
    return Math.max(0, Math.min(100, value));
  }

  // Two decimals keep --pos short while a drag stays smooth.
  function round2(value) {
    return Math.round(value * 100) / 100;
  }

  function isAllowedSrc(value) {
    return typeof value === 'string' && ALLOWED_SRC.test(value);
  }

  function positiveSize(value) {
    var n = Math.round(Number(value));
    return isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * Render a compare slider.
   * @param {Object} opts - see the plan; beforeSrc and afterSrc are required
   * @returns {string} HTML string, or '' when either source is missing or not allowed
   */
  function compareSlider(opts) {
    var o = opts || {};
    if (!isAllowedSrc(o.beforeSrc) || !isAllowedSrc(o.afterSrc)) return '';

    var start = Number(o.position);
    var position = round2(clamp(o.position == null || !isFinite(start) ? DEFAULT_POSITION : start));
    var viewport = o.viewport === 'phone' ? 'phone' : 'desktop';
    var width = positiveSize(o.width);
    var height = positiveSize(o.height);
    var extraClassName = sanitizeClassName(o.className);
    var cls = 'inv-compare' + (extraClassName ? ' ' + extraClassName : '');
    // The ratio sits on the stage: aspect-ratio is not inherited from the root.
    var stageStyle = width && height ? ' style="aspect-ratio:' + width + ' / ' + height + '"' : '';

    return '<div class="' + cls + '"'
      + (o.id ? ' id="' + escapeHtml(o.id) + '"' : '')
      + ' data-compare-slider data-vp="' + viewport + '" style="--pos:' + position + '%">'
      + '<div class="inv-compare-stage"' + stageStyle + '>'
      + '<img class="inv-compare-img inv-compare-img--before" src="' + escapeHtml(o.beforeSrc)
      + '" alt="' + escapeHtml(o.alt) + '" draggable="false">'
      + '<img class="inv-compare-img inv-compare-img--after" src="' + escapeHtml(o.afterSrc)
      + '" alt="" draggable="false">'
      + '<div class="inv-compare-handle" role="slider" tabindex="0" aria-label="' + escapeHtml(o.handleLabel)
      + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(position)
      + '" aria-orientation="horizontal"><span class="inv-compare-grip" aria-hidden="true">&#8249;&#8250;</span></div>'
      + '</div>'
      + '<div class="inv-compare-caps">'
      + '<button type="button" class="inv-compare-snap" data-compare-snap="100" aria-pressed="'
      + (position >= 100 - SNAP_EDGE) + '">' + escapeHtml(o.beforeLabel) + '</button>'
      + '<span class="inv-compare-grow"></span>'
      + '<button type="button" class="inv-compare-snap" data-compare-snap="0" aria-pressed="'
      + (position <= SNAP_EDGE) + '">' + escapeHtml(o.afterLabel) + '</button>'
      + '</div>'
      + '</div>';
  }

  function getPosition(rootEl) {
    if (!rootEl || !rootEl.style) return 0;
    var parsed = parseFloat(rootEl.style.getPropertyValue('--pos'));
    return isFinite(parsed) ? parsed : DEFAULT_POSITION;
  }

  /**
   * Move the handle. Clamps to 0..100, syncs --pos, aria-valuenow and both
   * snap buttons, and dispatches `inventory-compare-slider-change` on the root
   * only when the number actually changed.
   * @returns {number} the clamped position (the current one for a non-numeric input)
   */
  function setPosition(rootEl, percent) {
    if (!rootEl || !rootEl.style) return 0;
    var requested = Number(percent);
    var previous = getPosition(rootEl);
    if (percent == null || percent === '' || !isFinite(requested)) return previous;
    var next = round2(clamp(requested));

    rootEl.style.setProperty('--pos', next + '%');
    var handle = rootEl.querySelector('.inv-compare-handle');
    if (handle) handle.setAttribute('aria-valuenow', String(Math.round(next)));
    var before = rootEl.querySelector('[data-compare-snap="100"]');
    var after = rootEl.querySelector('[data-compare-snap="0"]');
    if (before) before.setAttribute('aria-pressed', String(next >= 100 - SNAP_EDGE));
    if (after) after.setAttribute('aria-pressed', String(next <= SNAP_EDGE));

    if (next !== previous) {
      var view = rootEl.ownerDocument && rootEl.ownerDocument.defaultView || null;
      var EventCtor = view && typeof view.CustomEvent === 'function' ? view.CustomEvent : typeof CustomEvent === 'function' ? CustomEvent : null;
      if (EventCtor) {
        rootEl.dispatchEvent(new EventCtor(CHANGE_EVENT, { bubbles: true, detail: { position: next } }));
      }
    }
    return next;
  }

  // The picture mirrors under right-to-left: --pos is measured from the inline start.
  function isRtl(rootEl) {
    var view = rootEl.ownerDocument && rootEl.ownerDocument.defaultView;
    if (!view || typeof view.getComputedStyle !== 'function') return false;
    return view.getComputedStyle(rootEl).direction === 'rtl';
  }

  function setPositionFromPointer(rootEl, stage, clientX) {
    var box = stage.getBoundingClientRect();
    if (!box || !(box.width > 0)) return;
    var fromStart = isRtl(rootEl) ? box.left + box.width - clientX : clientX - box.left;
    setPosition(rootEl, (fromStart / box.width) * 100);
  }

  function keyTarget(event, key, rtl) {
    var step = event.shiftKey ? KEY_STEP_SHIFT : KEY_STEP;
    if (key === 'ArrowRight') return rtl ? -step : step;
    if (key === 'ArrowLeft') return rtl ? step : -step;
    if (key === 'PageUp') return KEY_STEP_PAGE;
    if (key === 'PageDown') return -KEY_STEP_PAGE;
    return null;
  }

  function guarded(fn) {
    try { fn(); } catch (_err) { /* jsdom and detached nodes throw on pointer capture */ }
  }

  /**
   * Install the delegated pointer, keyboard and click handlers on a container,
   * once per element. The drag state lives in this closure: pointer capture on
   * the stage keeps pointermove and pointerup flowing to the container.
   * @param {HTMLElement|Document} containerEl
   */
  function initCompareSliderHandlers(containerEl) {
    if (!containerEl || typeof containerEl.addEventListener !== 'function') return;
    if (containerEl.__invCompareSliderHandlersInstalled) return;
    containerEl.__invCompareSliderHandlersInstalled = true;

    var drag = null;

    function endDrag(event) {
      if (!drag) return;
      var finished = drag;
      drag = null;
      guarded(function () { finished.stage.releasePointerCapture(event.pointerId); });
    }

    containerEl.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || !event.target.closest) return;
      var stage = event.target.closest('.inv-compare-stage');
      var rootEl = stage && stage.closest('[data-compare-slider]');
      if (!rootEl || !containerEl.contains(rootEl)) return;
      if (!(stage.getBoundingClientRect().width > 0)) return;
      guarded(function () { stage.setPointerCapture(event.pointerId); });
      drag = { stage: stage, root: rootEl, pointerId: event.pointerId };
      setPositionFromPointer(rootEl, stage, event.clientX);
      // The arrow keys then fine-tune what the drag started.
      var handle = rootEl.querySelector('.inv-compare-handle');
      if (handle && typeof handle.focus === 'function') handle.focus({ preventScroll: true });
    });

    containerEl.addEventListener('pointermove', function (event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      setPositionFromPointer(drag.root, drag.stage, event.clientX);
    });

    containerEl.addEventListener('pointerup', function (event) {
      if (drag && event.pointerId === drag.pointerId) endDrag(event);
    });
    containerEl.addEventListener('pointercancel', function (event) {
      if (drag && event.pointerId === drag.pointerId) endDrag(event);
    });

    containerEl.addEventListener('keydown', function (event) {
      if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
      var handle = event.target.closest && event.target.closest('.inv-compare-handle');
      var rootEl = handle && handle.closest('[data-compare-slider]');
      if (!rootEl) return;
      var key = event.key;
      var next;
      if (key === 'Home') next = 0;
      else if (key === 'End') next = 100;
      else {
        var delta = keyTarget(event, key, isRtl(rootEl));
        if (delta == null) return;
        next = getPosition(rootEl) + delta;
      }
      event.preventDefault();
      setPosition(rootEl, next);
    });

    containerEl.addEventListener('click', function (event) {
      var snap = event.target.closest && event.target.closest('[data-compare-snap]');
      var rootEl = snap && snap.closest('[data-compare-slider]');
      if (!rootEl) return;
      setPosition(rootEl, Number(snap.getAttribute('data-compare-snap')));
      var handle = rootEl.querySelector('.inv-compare-handle');
      if (handle && typeof handle.focus === 'function') handle.focus();
    });
  }

  compareSlider.setPosition = setPosition;
  compareSlider.getPosition = getPosition;
  compareSlider.initCompareSliderHandlers = initCompareSliderHandlers;
  compareSlider.escapeHtml = escapeHtml;
  compareSlider.sanitizeClassName = sanitizeClassName;
  return compareSlider;
});
