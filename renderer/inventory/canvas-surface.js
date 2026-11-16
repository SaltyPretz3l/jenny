/* renderer/inventory/canvas-surface.js
 *
 * A pannable, zoomable viewport for the board canvas. Two children share one CSS
 * transform: `underlay` (connector SVG) and `layer` (cards). The dot grid is a leaf
 * child of its own, so a pan restyles one element and not every card. Geometry is in board
 * units (CSS px at zoom 1). The surface knows nothing of cards, ids or storage: it
 * reports gestures through callbacks.
 *
 * Panning: the wheel, the middle button, Space with the primary button, and the right button held
 * (over a card too, not in a text field, which keeps its own menu). A right drag that moved holds
 * back the context menu its release would open; a right click that did not move keeps it. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); return; }
  root.inventoryCanvasSurface = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d) { return d; };
  var DEFAULT_MIN_ZOOM = 0.1;
  var DEFAULT_MAX_ZOOM = 4;
  var DEFAULT_FIT_PADDING = 48;
  var DRAG_THRESHOLD = 3;
  var WHEEL_ZOOM_RATE = 0.0025; // Ctrl+wheel steps of 100 and pinch deltas of a few units both feel even
  var LINE_HEIGHT_PX = 16;
  var GRID_STEP = 24; // board units between dots at zoom 1; the stylesheet's --inv-board-grid-step
  var GRID_MIN_GAP = 16; // px on screen: dots closer than this are thinned out

  /** How many grid steps lie between drawn dots at this zoom: 1, then 2, 4, 8 as the view zooms out. */
  function gridScale(zoom) {
    var gap = GRID_STEP * zoom;
    return gap >= GRID_MIN_GAP || !(gap > 0) ? 1 : Math.pow(2, Math.ceil(Math.log2(GRID_MIN_GAP / gap)));
  }

  function finite(value, fallback) { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
  function normalizeRect(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
  }
  function isEditable(node) {
    if (!node || node.nodeType !== 1) return false;
    var tag = node.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true;
  }

  function canvasSurface(options) {
    var settings = options || {};
    var doc = settings.document || globalThis.document;
    var win = doc.defaultView || globalThis;
    var minZoom = finite(settings.minZoom, DEFAULT_MIN_ZOOM);
    var maxZoom = Math.max(minZoom, finite(settings.maxZoom, DEFAULT_MAX_ZOOM));
    var view = { x: 0, y: 0, zoom: 1 };
    var gesture = null;
    var spaceDown = false;
    var menuOwed = false; // a right drag just ended: the context menu of that release is not shown
    var frame = null;
    var frameKind = null;
    var disposed = false;
    var removers = [];

    var element = doc.createElement('div');
    element.className = 'inv-board-canvas';
    element.tabIndex = 0;
    element.setAttribute('role', 'application');
    element.setAttribute('aria-label', jt('inventory.board.canvas.label', 'Board canvas'));
    var grid = doc.createElement('div');
    grid.className = 'inv-board-grid';
    grid.setAttribute('aria-hidden', 'true');
    var underlay = doc.createElement('div');
    underlay.className = 'inv-board-underlay';
    var layer = doc.createElement('div');
    layer.className = 'inv-board-layer';
    var marquee = doc.createElement('div');
    marquee.className = 'inv-board-marquee';
    marquee.setAttribute('data-board-marquee', '');
    marquee.hidden = true;
    element.appendChild(grid);
    element.appendChild(underlay);
    element.appendChild(layer);
    element.appendChild(marquee);

    function clampZoom(zoom) { return Math.min(maxZoom, Math.max(minZoom, zoom)); }
    function viewportRect() { return element.getBoundingClientRect(); }

    function toBoard(clientX, clientY) {
      var rect = viewportRect();
      return { x: (clientX - rect.left - view.x) / view.zoom, y: (clientY - rect.top - view.y) / view.zoom };
    }
    function toClient(x, y) {
      var rect = viewportRect();
      return { x: x * view.zoom + view.x + rect.left, y: y * view.zoom + view.y + rect.top };
    }

    function apply() {
      var transform = 'translate(' + view.x + 'px, ' + view.y + 'px) scale(' + view.zoom + ')';
      underlay.style.transform = transform;
      layer.style.transform = transform;
      // On the leaf only: a custom property set on the canvas would restyle every card.
      grid.style.setProperty('--inv-board-x', view.x + 'px');
      grid.style.setProperty('--inv-board-y', view.y + 'px');
      grid.style.setProperty('--inv-board-zoom', String(view.zoom));
      grid.style.setProperty('--inv-board-grid-scale', String(gridScale(view.zoom)));
    }
    function requestFrame(callback) {
      if (typeof win.requestAnimationFrame === 'function') { frameKind = 'raf'; return win.requestAnimationFrame(callback); }
      frameKind = 'timeout';
      return setTimeout(callback, 16);
    }
    function cancelFrame(handle) {
      if (frameKind === 'raf' && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(handle);
      else clearTimeout(handle);
    }
    function notify() {
      if (frame !== null || disposed || typeof settings.onViewChange !== 'function') return;
      frame = requestFrame(function () {
        frame = null;
        if (!disposed) settings.onViewChange(getView());
      });
    }
    function getView() { return { x: view.x, y: view.y, zoom: view.zoom }; }
    function setView(next, flags) {
      var source = next || {};
      view = { x: finite(source.x, view.x), y: finite(source.y, view.y), zoom: clampZoom(finite(source.zoom, view.zoom)) };
      apply();
      if (!(flags && flags.silent)) notify();
      return getView();
    }
    function zoomAt(point, factor) {
      var clientX = finite(point && point.x, finite(point && point.clientX, 0));
      var clientY = finite(point && point.y, finite(point && point.clientY, 0));
      var rect = viewportRect();
      var anchor = toBoard(clientX, clientY);
      var zoom = clampZoom(view.zoom * finite(factor, 1));
      return setView({ x: clientX - rect.left - anchor.x * zoom, y: clientY - rect.top - anchor.y * zoom, zoom: zoom });
    }
    function fit(bounds, padding) {
      var empty = !bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)
        || !Number.isFinite(bounds.w) || !Number.isFinite(bounds.h) || (bounds.w <= 0 && bounds.h <= 0);
      if (empty) return setView({ x: 0, y: 0, zoom: 1 });
      var pad = Math.max(0, finite(padding, DEFAULT_FIT_PADDING));
      var rect = viewportRect();
      var width = Math.max(1, bounds.w);
      var height = Math.max(1, bounds.h);
      var zoom = clampZoom(Math.min(1, Math.max(1, rect.width - 2 * pad) / width, Math.max(1, rect.height - 2 * pad) / height));
      return setView({
        x: (rect.width - width * zoom) / 2 - bounds.x * zoom,
        y: (rect.height - height * zoom) / 2 - bounds.y * zoom,
        zoom: zoom,
      });
    }

    function listen(target, type, callback, capture) {
      target.addEventListener(type, callback, capture);
      removers.push(function () { target.removeEventListener(type, callback, capture); });
    }
    function onCard(target) { return target !== layer && layer.contains(target); }

    function setPanning(on) {
      if (on) element.setAttribute('data-panning', ''); else element.removeAttribute('data-panning');
    }
    function endGesture() {
      if (!gesture) return;
      var previous = gesture;
      gesture = null;
      marquee.hidden = true;
      setPanning(false);
      try {
        if (typeof element.hasPointerCapture === 'function' && element.hasPointerCapture(previous.id)) element.releasePointerCapture(previous.id);
      } catch (ignored) { /* pointer already released */ }
    }

    listen(element, 'wheel', function (event) {
      event.preventDefault();
      var scale = event.deltaMode === 1 ? LINE_HEIGHT_PX : 1;
      var dx = finite(event.deltaX, 0) * scale;
      var dy = finite(event.deltaY, 0) * scale;
      if (event.ctrlKey || event.metaKey) {
        zoomAt({ x: event.clientX, y: event.clientY }, Math.exp(-dy * WHEEL_ZOOM_RATE));
        return;
      }
      if (event.shiftKey && dx === 0) { dx = dy; dy = 0; }
      setView({ x: view.x - dx, y: view.y - dy, zoom: view.zoom });
    }, { passive: false });

    listen(element, 'pointerdown', function (event) {
      if (gesture || event.isPrimary === false) return;
      menuOwed = false;
      var wantsPan = event.button === 1 || (event.button === 2 && !isEditable(event.target)) || (event.button === 0 && spaceDown);
      if (!wantsPan && (event.button !== 0 || onCard(event.target))) return;
      if (!wantsPan && event.target !== element && !underlay.contains(event.target) && event.target !== layer) return;
      gesture = {
        kind: wantsPan ? 'pan' : 'press', id: event.pointerId, x: event.clientX, y: event.clientY,
        view: getView(), moved: false, shift: event.shiftKey === true, right: event.button === 2,
      };
      try { if (typeof element.setPointerCapture === 'function') element.setPointerCapture(event.pointerId); } catch (ignored) { /* synthetic pointer */ }
      if (wantsPan) { event.preventDefault(); setPanning(true); }
      if (typeof element.focus === 'function' && doc.activeElement !== element) element.focus({ preventScroll: true });
    });
    listen(element, 'pointermove', function (event) {
      if (!gesture || event.pointerId !== gesture.id) return;
      var dx = event.clientX - gesture.x;
      var dy = event.clientY - gesture.y;
      if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      gesture.moved = true;
      if (gesture.kind === 'pan') {
        setView({ x: gesture.view.x + dx, y: gesture.view.y + dy, zoom: gesture.view.zoom });
        return;
      }
      var rect = viewportRect();
      var box = normalizeRect({ x: gesture.x - rect.left, y: gesture.y - rect.top }, { x: event.clientX - rect.left, y: event.clientY - rect.top });
      marquee.hidden = false;
      marquee.style.left = box.x + 'px';
      marquee.style.top = box.y + 'px';
      marquee.style.width = box.w + 'px';
      marquee.style.height = box.h + 'px';
    });
    listen(element, 'pointerup', function (event) {
      if (!gesture || event.pointerId !== gesture.id) return;
      var previous = gesture;
      endGesture();
      if (previous.right && previous.moved) menuOwed = true;
      if (previous.kind !== 'press') return;
      if (previous.moved) {
        var start = toBoard(previous.x, previous.y);
        var end = toBoard(event.clientX, event.clientY);
        if (typeof settings.onMarquee === 'function') {
          settings.onMarquee(normalizeRect(start, end), { additive: previous.shift || event.shiftKey === true });
        }
      } else if (typeof settings.onBackgroundClick === 'function') {
        var at = toBoard(event.clientX, event.clientY);
        settings.onBackgroundClick({ x: at.x, y: at.y, event: event });
      }
    });
    listen(element, 'pointercancel', function (event) {
      if (gesture && event.pointerId === gesture.id) endGesture();
    });
    // On the document, first: with the pointer captured the release, and so the menu, can land outside the canvas.
    listen(doc, 'contextmenu', function (event) {
      if (!menuOwed) return;
      menuOwed = false;
      event.preventDefault();
      event.stopPropagation();
    }, true);
    listen(element, 'dblclick', function (event) {
      if (onCard(event.target) || typeof settings.onBackgroundDoubleClick !== 'function') return;
      var at = toBoard(event.clientX, event.clientY);
      settings.onBackgroundDoubleClick({ x: at.x, y: at.y, event: event });
    });
    listen(element, 'keydown', function (event) {
      if (event.key !== ' ' || isEditable(event.target)) return;
      spaceDown = true;
      element.setAttribute('data-space', '');
      if (event.target === element) event.preventDefault();
    });
    listen(element, 'keyup', function (event) {
      if (event.key !== ' ') return;
      spaceDown = false;
      element.removeAttribute('data-space');
    });
    listen(element, 'blur', function () {
      spaceDown = false;
      element.removeAttribute('data-space');
    }, true);
    listen(doc, 'keydown', function (event) {
      if (event.key === 'Escape' && gesture) { event.preventDefault(); endGesture(); }
    }, true);

    apply();
    return {
      element: element,
      layer: layer,
      underlay: underlay,
      getView: getView,
      setView: setView,
      zoomAt: zoomAt,
      fit: fit,
      toBoard: toBoard,
      toClient: toClient,
      dispose: function () {
        if (disposed) return;
        endGesture();
        disposed = true;
        if (frame !== null) { cancelFrame(frame); frame = null; }
        removers.forEach(function (remove) { remove(); });
        removers = [];
        element.remove();
      },
    };
  }

  return canvasSurface;
});
